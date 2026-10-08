#include "node_addon_internal.hpp"
#include "asset_processor.hpp"
#include "tile_assets.hpp"

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

struct TileWork {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::vector<TileAssetInput> inputs;
  std::filesystem::path staging;
  std::optional<PreparedTileAssets> result, expected;
  std::size_t verifiedRegions = 0;
  std::string error;
  bool unsupported = false;
};
napi_value tileDescriptor(napi_env env, const PreparedTileAssets& asset) {
  auto result = moduleObject(env);
  set(env, result, "version", number(env, asset.version));
  set(env, result, "halo", number(env, asset.halo));
  set(env, result, "ordinaryBytes", number(env, asset.ordinaryBytes));
  set(env, result, "pageBytes", number(env, asset.pageBytes));
  napi_value sources, pages;
  check(env, napi_create_array_with_length(env, asset.sources.size(), &sources), "cannot create tile sources");
  for (std::size_t i = 0; i < asset.sources.size(); ++i) {
    const auto& source = asset.sources[i]; auto value = moduleObject(env);
    set(env, value, "width", number(env, source.width)); set(env, value, "height", number(env, source.height));
    napi_value regions;
    check(env, napi_create_array_with_length(env, source.regions.size(), &regions), "cannot create tile regions");
    for (std::size_t j = 0; j < source.regions.size(); ++j) {
      const auto& r = source.regions[j]; auto region = moduleObject(env);
      set(env, region, "rect", arrayValue(env, r.rect)); set(env, region, "atlas", arrayValue(env, r.atlas));
      set(env, region, "page", number(env, r.page));
      check(env, napi_set_element(env, regions, j, region), "cannot write tile region");
    }
    set(env, value, "regions", regions);
    check(env, napi_set_element(env, sources, i, value), "cannot write tile source");
  }
  check(env, napi_create_array_with_length(env, asset.pages.size(), &pages), "cannot create tile pages");
  for (std::size_t i = 0; i < asset.pages.size(); ++i) {
    const auto& page = asset.pages[i]; auto value = moduleObject(env);
    set(env, value, "path", string(env, page.path.string()));
    set(env, value, "width", number(env, page.width)); set(env, value, "height", number(env, page.height));
    check(env, napi_set_element(env, pages, i, value), "cannot write tile page");
  }
  set(env, result, "sources", sources); set(env, result, "pages", pages);
  return result;
}
void executeTiles(napi_env, void* opaque) noexcept {
  auto& work = *static_cast<TileWork*>(opaque);
  try {
    if (work.expected) work.verifiedRegions = verifyTileAssets(work.inputs, *work.expected, work.staging);
    else work.result = prepareTileAssets(work.inputs, work.staging);
  }
  catch (const AssetPreparationUnsupported& error) { work.error = error.what(); work.unsupported = true; }
  catch (const std::exception& error) { work.error = error.what(); }
  catch (...) { work.error = "tile preparation failed"; }
}
void completeTiles(napi_env env, napi_status status, void* opaque) {
  std::unique_ptr<TileWork> work(static_cast<TileWork*>(opaque));
  try {
    if (status != napi_ok) throw std::runtime_error("tile preparation cancelled");
    if (!work->error.empty()) throw std::runtime_error(work->error);
    check(env, napi_resolve_deferred(env, work->deferred, work->expected ? number(env, work->verifiedRegions) : tileDescriptor(env, *work->result)), "cannot resolve tile preparation");
  } catch (const std::exception& error) {
    napi_value rejection;
    napi_create_error(env, nullptr, string(env, error.what()), &rejection);
    if (work->unsupported) set(env, rejection, "code", string(env, "PMJS_TILE_UNSUPPORTED"));
    napi_reject_deferred(env, work->deferred, rejection);
  }
  napi_delete_async_work(env, work->work);
}
std::uint32_t arrayLength(napi_env env, napi_value value, std::uint32_t limit) {
  bool array = false; std::uint32_t size = 0;
  check(env, napi_is_array(env, value, &array), "cannot inspect tile array");
  if (!array) throw std::runtime_error("expected tile array");
  check(env, napi_get_array_length(env, value, &size), "cannot read tile array");
  if (size > limit) throw std::runtime_error("tile array exceeds limit");
  return size;
}
napi_value element(napi_env env, napi_value value, std::uint32_t index) {
  napi_value item;
  check(env, napi_get_element(env, value, index, &item), "cannot read tile array element");
  return item;
}
napi_value processTiles(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 3); auto work = std::make_unique<TileWork>();
  const auto count = arrayLength(env, args.at(0), 512);
  for (std::uint32_t i = 0; i < count; ++i) {
    const auto input = element(env, args[0], i); TileAssetInput source;
    const std::filesystem::path file = asString(env, property(env, input, "file"));
    if (!file.is_absolute()) throw std::runtime_error("tile source must be absolute");
    source.source = ImageStore::openFile(file);
    if (!source.source) throw std::runtime_error("cannot open tile source");
    const auto rectangles = property(env, input, "rectangles");
    const auto length = arrayLength(env, rectangles, 65536);
    for (std::uint32_t j = 0; j < length; ++j) source.rectangles.push_back(integers<4>(env, element(env, rectangles, j)));
    work->inputs.push_back(std::move(source));
  }
  work->staging = asString(env, args.at(1));
  if (!work->staging.is_absolute()) throw std::runtime_error("tile staging directory must be absolute");
  if (args.size() > 2) {
    PreparedTileAssets expected;
    auto d = args[2]; expected.halo = integer(env, property(env, d, "halo"));
    if (integer(env, property(env, d, "version")) != 1) throw std::runtime_error("unsupported tile verification version");
    auto pages = property(env, d, "pages");
    for (std::uint32_t i=0, n=arrayLength(env,pages,4096);i<n;++i) {
      auto page=element(env,pages,i);
      expected.pages.push_back({asString(env,property(env,page,"path")), integer(env,property(env,page,"width")), integer(env,property(env,page,"height"))});
    }
    auto sources=property(env,d,"sources");
    for (std::uint32_t i=0,n=arrayLength(env,sources,512);i<n;++i) {
      auto source=element(env,sources,i); TileAssetSource out;
      out.width=integer(env,property(env,source,"width"));out.height=integer(env,property(env,source,"height"));
      auto regions=property(env,source,"regions");
      for(std::uint32_t j=0,length=arrayLength(env,regions,65536);j<length;++j) {
        auto region=element(env,regions,j);PreparedAssetCell r;
        r.rect=integers<4>(env,property(env,region,"rect"));r.atlas=integers<4>(env,property(env,region,"atlas"));r.page=integer(env,property(env,region,"page"));out.regions.push_back(r);
      }
      expected.sources.push_back(std::move(out));
    }
    work->expected=std::move(expected);
  }
  napi_value promise;
  check(env, napi_create_promise(env, &work->deferred, &promise), "cannot create tile preparation promise");
  check(env, napi_create_async_work(env, nullptr, string(env, "pmjs-tile-preparation"), executeTiles, completeTiles, work.get(), &work->work), "cannot create tile work");
  const auto status = napi_queue_async_work(env, work->work);
  if (status != napi_ok) { napi_delete_async_work(env, work->work); check(env, status, "cannot queue tile work"); }
  work.release(); return promise;
} catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }

napi_value installTileSetsImpl(napi_env env, napi_callback_info info, bool catalog) try {
  const auto args = arguments(env, info, 2);
  const bool capture = !catalog && args.size() > 1 && asBoolean(env, args[1]);
  auto& value = host(env);
  const auto count = arrayLength(env, args.at(0), 65536);
  std::vector<PreparedTileSet> descriptors;
  descriptors.reserve(count);
  for (std::uint32_t i = 0; i < count; ++i) {
    auto entry = element(env, args[0], i); PreparedTileSet setValue;
    auto d = property(env, entry, "descriptor");
    setValue.identity = asString(env, property(env, entry, "identity"));
    setValue.directory = asString(env, property(env, entry, "directory"));
    setValue.version = integer(env, property(env, d, "version"));
    setValue.halo = integer(env, property(env, d, "halo"));
    auto pages = property(env, d, "pages");
    const auto pageCount = arrayLength(env, pages, 4096);
    setValue.pages.reserve(pageCount);
    for (std::uint32_t j = 0; j < pageCount; ++j) {
      auto page = element(env, pages, j);
      setValue.pages.push_back({asString(env, property(env, page, "path")),
        integer(env, property(env, page, "width")), integer(env, property(env, page, "height"))});
    }
    auto sources = property(env, d, "sources");
    const auto sourceCount = arrayLength(env, sources, 512);
    setValue.sources.reserve(sourceCount);
    for (std::uint32_t j = 0; j < sourceCount; ++j) {
      auto source = element(env, sources, j); PreparedTileSource output;
      const auto logical = asString(env, property(env, source, "source"));
      auto path = value.vfs.resolve(logical);
      if (!path) throw std::runtime_error("cannot resolve tile source");
      output.path = *path; output.snapshot = asString(env, property(env, source, "snapshot"));
      output.identity = asString(env, property(env, source, "sourceIdentity"));
      output.width = integer(env, property(env, source, "width")); output.height = integer(env, property(env, source, "height"));
      auto regions = property(env, source, "regions");
      const auto regionCount = arrayLength(env, regions, 65536);
      output.regions.reserve(regionCount);
      for (std::uint32_t k = 0; k < regionCount; ++k) {
        auto region = element(env, regions, k);
        output.regions.push_back({integers<4>(env, property(env, region, "rect")),
          integers<4>(env, property(env, region, "atlas")), integer(env, property(env, region, "page"))});
      }
      setValue.sources.push_back(std::move(output));
    }
    descriptors.push_back(std::move(setValue));
  }
  value.images.clearTileSetIndex();
  std::uint32_t installed = 0;
  for (std::uint32_t i = 0; i < count; ++i) {
    std::vector<std::string> pages, snapshots;
    if (catalog) {
      auto entry = element(env, args[0], i);
      for (const auto name : {"pageIdentities", "snapshotIdentities"}) {
        auto list = property(env, entry, name);
        auto& output = std::string(name) == "pageIdentities" ? pages : snapshots;
        const auto size = arrayLength(env, list, 4096);
        for (std::uint32_t j = 0; j < size; ++j) output.push_back(asString(env, element(env, list, j)));
      }
    }
    std::vector<std::string> capturedPages, capturedSnapshots;
    if (value.images.installTileSet(std::move(descriptors[i]), catalog ? &pages : nullptr, catalog ? &snapshots : nullptr, capture ? &capturedPages : nullptr, capture ? &capturedSnapshots : nullptr)) {
      ++installed;
      if (capture) {
        auto entry = element(env, args[0], i);
        for (const auto name : {"pageIdentities", "snapshotIdentities"}) {
          const auto& captured = std::string(name) == "pageIdentities" ? capturedPages : capturedSnapshots;
          napi_value list; check(env, napi_create_array_with_length(env, captured.size(), &list), "cannot create identities");
          for (std::size_t j = 0; j < captured.size(); ++j) check(env, napi_set_element(env, list, j, string(env, captured[j])), "cannot set identity");
          set(env, entry, name, list);
        }
      }
    }
  }
  return number(env, installed);
} catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
napi_value installTileSets(napi_env env, napi_callback_info info) { return installTileSetsImpl(env, info, false); }
napi_value installTileSetCatalog(napi_env env, napi_callback_info info) { return installTileSetsImpl(env, info, true); }
napi_value consumePreparationInvalidations(napi_env env, napi_callback_info) try {
  auto& value = host(env);
  auto flags = value.images.consumePreparationInvalidations();
  if (value.vfs.consumeDerivedInvalidation()) flags |= 3;
  return number(env, flags);
} catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
napi_value tileSlot(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 3);
  auto image = host(env).images.createTileSlot(asUint32(env, args.at(0)), integer(env, args.at(1)), integer(env, args.at(2)));
  return image ? imageInfo(env, image->handle, image->width, image->height) : null(env);
} catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
void registerAssetMethods(napi_env env, napi_value exports) {
  const auto assets = property(env, exports, "assets");
  method(env, assets, "consumePreparationInvalidations", consumePreparationInvalidations);
  method(env, assets, "processImage", processImage);
  method(env, assets, "processTiles", processTiles);
  method(env, assets, "installTileSets", installTileSets);
  method(env, assets, "installTileSetCatalog", installTileSetCatalog);
  method(env, property(env, exports, "images"), "tileSlot", tileSlot);
  set(env, assets, "tilePreparationVersion", string(env, "lossless-tile-sets-v3"));
  const auto version = moduleObject(env);
  set(env, version, "processor", string(env, "lossless-images-v2"));
  set(env, version, "decoder", string(env, std::string("libpng-") + png_get_libpng_ver(nullptr) + "-rgba8-v1"));
  set(env, version, "pageSize", number(env, 2048));
  set(env, assets, "preparationVersion", version);
}
}
