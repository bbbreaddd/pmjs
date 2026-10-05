#include "node_addon_internal.hpp"
#include "asset_processor.hpp"

#include <cmath>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <png.h>

namespace pmjs::addon {
namespace {
int integer(napi_env env, napi_value value) {
  const auto input = asNumber(env, value);
  if (!std::isfinite(input) || input != std::floor(input) || input < 0 || input > 0x7fffffff)
    throw std::runtime_error("asset recipe values must be nonnegative integers");
  return static_cast<int>(input);
}
template <std::size_t Size>
std::array<int, Size> integers(napi_env env, napi_value value) {
  bool isArray = false;
  check(env, napi_is_array(env, value, &isArray), "cannot inspect asset recipe array");
  std::uint32_t length = 0;
  if (!isArray) throw std::runtime_error("asset recipe requires an array");
  check(env, napi_get_array_length(env, value, &length), "cannot read asset recipe array");
  if (length != Size) throw std::runtime_error("asset recipe array has an invalid length");
  std::array<int, Size> result{};
  for (std::size_t index = 0; index < Size; ++index) {
    napi_value element;
    check(env, napi_get_element(env, value, static_cast<std::uint32_t>(index), &element), "cannot read asset recipe element");
    result[index] = integer(env, element);
  }
  return result;
}
AssetColor color(napi_env env, napi_value value) {
  const auto values = integers<4>(env, value);
  AssetColor result{};
  for (std::size_t index = 0; index < 4; ++index) {
    if (values[index] > 255) throw std::runtime_error("asset recipe RGBA values exceed 255");
    result[index] = static_cast<std::uint8_t>(values[index]);
  }
  return result;
}
AssetRecipe recipeValue(napi_env env, napi_value value) {
  AssetRecipe recipe;
  if (hasProperty(env, value, "grid")) {
    const auto grid = integers<2>(env, property(env, value, "grid"));
    recipe.columns = grid[0]; recipe.rows = grid[1];
  }
  if (hasProperty(env, value, "backdrop")) recipe.backdrop = color(env, property(env, value, "backdrop"));
  if (hasProperty(env, value, "crop")) {
    const auto crop = property(env, value, "crop");
    bool isArray = false;
    check(env, napi_is_array(env, crop, &isArray), "cannot inspect asset recipe crop");
    if (isArray) recipe.crop = integers<4>(env, crop);
    else {
      recipe.crop = AssetRect{integer(env, property(env, crop, "x")), integer(env, property(env, crop, "y")),
        integer(env, property(env, crop, "w")), integer(env, property(env, crop, "h"))};
      if (hasProperty(env, crop, "backdrop")) recipe.backdrop = color(env, property(env, crop, "backdrop"));
    }
  }
  return recipe;
}
void set(napi_env env, napi_value object, const char* name, napi_value value) {
  check(env, napi_set_named_property(env, object, name, value), "cannot write prepared asset result");
}
template <typename T, std::size_t Size>
napi_value arrayValue(napi_env env, const std::array<T, Size>& values) {
  napi_value result;
  check(env, napi_create_array_with_length(env, Size, &result), "cannot create prepared asset array");
  for (std::size_t index = 0; index < Size; ++index)
    check(env, napi_set_element(env, result, static_cast<std::uint32_t>(index), number(env, values[index])),
      "cannot write prepared asset array");
  return result;
}
napi_value descriptor(napi_env env, const PreparedAsset& asset) {
  auto result = moduleObject(env);
  set(env, result, "version", number(env, 1));
  set(env, result, "width", number(env, asset.width)); set(env, result, "height", number(env, asset.height));
  set(env, result, "halo", number(env, asset.halo));
  if (asset.uniform) set(env, result, "uniform", arrayValue(env, *asset.uniform));
  napi_value cells, pages;
  check(env, napi_create_array_with_length(env, asset.cells.size(), &cells), "cannot create prepared cells");
  for (std::size_t index = 0; index < asset.cells.size(); ++index) {
    const auto& cell = asset.cells[index];
    const auto value = moduleObject(env);
    set(env, value, "rect", arrayValue(env, cell.rect)); set(env, value, "crop", arrayValue(env, cell.crop));
    set(env, value, "fill", arrayValue(env, cell.fill)); set(env, value, "page", number(env, cell.page));
    set(env, value, "atlas", arrayValue(env, cell.atlas));
    check(env, napi_set_element(env, cells, static_cast<std::uint32_t>(index), value), "cannot write prepared cell");
  }
  check(env, napi_create_array_with_length(env, asset.pages.size(), &pages), "cannot create prepared pages");
  for (std::size_t index = 0; index < asset.pages.size(); ++index) {
    const auto& page = asset.pages[index];
    const auto value = moduleObject(env);
    set(env, value, "path", string(env, page.path.string()));
    set(env, value, "width", number(env, page.width)); set(env, value, "height", number(env, page.height));
    check(env, napi_set_element(env, pages, static_cast<std::uint32_t>(index), value), "cannot write prepared page");
  }
  set(env, result, "cells", cells); set(env, result, "pages", pages);
  return result;
}
struct AssetWork {
  ~AssetWork() { if (sourceFd >= 0) ::close(sourceFd); }
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  int sourceFd = -1;
  struct stat snapshot{};
  std::filesystem::path staging;
  AssetRecipe recipe;
  std::optional<PreparedAsset> result;
  std::string error;
  bool unsupported = false;
};
void executeAsset(napi_env, void* opaque) noexcept {
  auto& work = *static_cast<AssetWork*>(opaque);
  try {
    work.result = prepareAssetImage("/proc/self/fd/" + std::to_string(work.sourceFd), work.staging, work.recipe);
    struct stat current{};
    if (::fstat(work.sourceFd, &current) != 0 || current.st_size != work.snapshot.st_size ||
        current.st_mtim.tv_sec != work.snapshot.st_mtim.tv_sec || current.st_mtim.tv_nsec != work.snapshot.st_mtim.tv_nsec ||
        current.st_ctim.tv_sec != work.snapshot.st_ctim.tv_sec || current.st_ctim.tv_nsec != work.snapshot.st_ctim.tv_nsec)
      throw std::runtime_error("asset source changed during preparation");
  } catch (const AssetPreparationUnsupported&) { work.unsupported = true; }
  catch (const std::exception& error) { work.error = error.what(); }
  catch (...) { work.error = "asset preparation failed"; }
}
void completeAsset(napi_env env, napi_status status, void* opaque) {
  std::unique_ptr<AssetWork> work(static_cast<AssetWork*>(opaque));
  try {
    if (status != napi_ok) throw std::runtime_error("asset preparation cancelled");
    if (!work->error.empty()) throw std::runtime_error(work->error);
    check(env, napi_resolve_deferred(env, work->deferred,
      work->unsupported ? null(env) : descriptor(env, *work->result)), "cannot resolve asset preparation");
  } catch (const std::exception& error) {
    napi_value result;
    napi_value message = string(env, error.what());
    napi_create_error(env, nullptr, message, &result);
    napi_reject_deferred(env, work->deferred, result);
  }
  napi_delete_async_work(env, work->work);
}
napi_value processImage(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 4);
  auto work = std::make_unique<AssetWork>();
  const auto source = args.size() > 3
    ? std::optional<std::filesystem::path>(asString(env, args[3]))
    : host(env).vfs.resolve(asString(env, args.at(0)));
  if (!source) throw std::runtime_error("cannot resolve preparation source");
  if (!source->is_absolute()) throw std::runtime_error("preparation source must be absolute");
  work->sourceFd = ::open(source->c_str(), O_RDONLY | O_CLOEXEC);
  if (work->sourceFd < 0 || ::fstat(work->sourceFd, &work->snapshot) != 0 || !S_ISREG(work->snapshot.st_mode))
    throw std::runtime_error("cannot open preparation source");
  work->staging = asString(env, args.at(1));
  if (!work->staging.is_absolute()) throw std::runtime_error("asset staging directory must be absolute");
  if (args.size() > 2) {
    napi_valuetype type;
    check(env, napi_typeof(env, args[2], &type), "cannot inspect preparation recipe");
    if (type != napi_undefined && type != napi_null) work->recipe = recipeValue(env, args[2]);
  }
  napi_value promise;
  check(env, napi_create_promise(env, &work->deferred, &promise), "cannot create asset preparation promise");
  const auto name = string(env, "pmjs-asset-preparation");
  check(env, napi_create_async_work(env, nullptr, name, executeAsset, completeAsset, work.get(), &work->work),
    "cannot create asset preparation work");
  const auto queued = napi_queue_async_work(env, work->work);
  if (queued != napi_ok) { napi_delete_async_work(env, work->work); check(env, queued, "cannot queue asset preparation"); }
  work.release();
  return promise;
} catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
void registerAssetMethods(napi_env env, napi_value exports) {
  const auto assets = property(env, exports, "assets");
  method(env, assets, "processImage", processImage);
  const auto version = moduleObject(env);
  set(env, version, "processor", string(env, "lossless-images-v2"));
  set(env, version, "decoder", string(env, std::string("libpng-") + png_get_libpng_ver(nullptr) + "-rgba8-v1"));
  set(env, version, "pageSize", number(env, 2048));
  set(env, assets, "preparationVersion", version);
}
}
