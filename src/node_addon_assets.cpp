#include "node_addon_internal.hpp"
#include "asset_processor.hpp"
#include "prepared_page.hpp"
#include "tile_assets.hpp"
#include "log.hpp"

#include <cmath>
#include <cerrno>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#include <png.h>

namespace pmjs::addon {
namespace {
struct PreparationMemoryRelease {
  ~PreparationMemoryRelease() { trimPreparationMemory(); }
};
struct PreparationLock {
  int fd = -1;
  void release() noexcept { if (fd >= 0) { ::close(fd); fd = -1; } }
  ~PreparationLock() { release(); }
};
constexpr napi_type_tag preparationLockTag{0x83fd418168e74ea4ULL, 0xa105b95063b2803eULL};
std::span<const std::uint8_t> artifactBytes(napi_env env, napi_value value) {
  bool typed = false;
  check(env, napi_is_typedarray(env, value, &typed), "invalid prepared artifact bytes");
  if (!typed) throw std::invalid_argument("prepared artifact must be a Uint8Array");
  napi_typedarray_type type;
  std::size_t length = 0, offset = 0;
  void* data = nullptr;
  napi_value buffer;
  check(env, napi_get_typedarray_info(env, value, &type, &length, &data, &buffer, &offset),
    "invalid prepared artifact bytes");
  if ((type != napi_uint8_array && type != napi_uint8_clamped_array) || !data)
    throw std::invalid_argument("prepared artifact must be a Uint8Array");
  return {static_cast<const std::uint8_t*>(data), length};
}
napi_value byteBuffer(napi_env env, std::span<const std::uint8_t> bytes) {
  napi_value result;
  check(env, napi_create_buffer_copy(env, bytes.size(), bytes.data(), nullptr, &result),
    "cannot create prepared artifact buffer");
  return result;
}
napi_value compressPortArtifact(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1);
  return byteBuffer(env, compressLz4Artifact(artifactBytes(env, args.at(0))));
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what()); return nullptr;
}
napi_value decompressPortArtifact(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 2);
  const auto requestedLimit = args.size() > 1 ? asNumber(env, args[1]) : 64.0 * 1024.0 * 1024.0;
  if (!std::isfinite(requestedLimit) || requestedLimit < 0 ||
      requestedLimit > 64.0 * 1024.0 * 1024.0 || std::floor(requestedLimit) != requestedLimit)
    throw std::invalid_argument("invalid prepared artifact size limit");
  const auto limit = static_cast<std::size_t>(requestedLimit);
  const auto decoded = decompressLz4Artifact(artifactBytes(env, args.at(0)), limit);
  return decoded ? byteBuffer(env, *decoded) : null(env);
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what()); return nullptr;
}
napi_value tryAcquirePreparationLock(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1);
  const auto file = std::filesystem::path(asString(env, args.at(0))) / ".prepare.lock";
  auto lock = std::make_unique<PreparationLock>();
  // Keep the inode in place: unlinking a lock file allows two independent owners.
  lock->fd = ::open(file.c_str(), O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
  struct stat status{};
  if (lock->fd < 0 || ::fstat(lock->fd, &status) != 0 || !S_ISREG(status.st_mode))
    throw std::runtime_error("cannot open preparation lock");
  if (::flock(lock->fd, LOCK_EX | LOCK_NB) != 0) {
    if (errno == EWOULDBLOCK || errno == EAGAIN) return null(env);
    throw std::runtime_error("cannot acquire preparation lock");
  }
  napi_value token;
  check(env, napi_create_external(env, lock.get(), [](napi_env, void* data, void*) {
    delete static_cast<PreparationLock*>(data);
  }, nullptr, &token), "cannot create preparation lock token");
  auto* owned = lock.release();
  const auto tagged = napi_type_tag_object(env, token, &preparationLockTag);
  if (tagged != napi_ok) owned->release();
  check(env, tagged, "cannot tag preparation lock token");
  return token;
} catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
napi_value releasePreparationLock(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1);
  bool valid = false;
  check(env, napi_check_object_type_tag(env, args.at(0), &preparationLockTag, &valid),
    "invalid preparation lock token");
  if (!valid) throw std::runtime_error("invalid preparation lock token");
  void* data = nullptr;
  check(env, napi_get_value_external(env, args[0], &data), "invalid preparation lock token");
  static_cast<PreparationLock*>(data)->release();
  return undefined(env);
} catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
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
  if (hasProperty(env, value, "framePages"))
    check(env, napi_get_value_bool(env, property(env, value, "framePages"), &recipe.framePages), "invalid frame pages recipe");
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
napi_value descriptor(napi_env env, const PreparedAsset& asset, bool workspaceConstrained = false) {
  auto result = moduleObject(env);
  set(env, result, "version", number(env, 1));
  set(env, result, "width", number(env, asset.width)); set(env, result, "height", number(env, asset.height));
  set(env, result, "halo", number(env, asset.halo));
  set(env, result, "workspaceConstrained", boolean(env, workspaceConstrained));
  if (asset.ordinaryRetainedBytes) set(env, result, "ordinaryRetainedBytes", number(env, asset.ordinaryRetainedBytes));
  if (asset.textureRetainedBytes) set(env, result, "textureRetainedBytes", number(env, asset.textureRetainedBytes));
  if (!asset.compression.empty()) set(env, result, "compression", string(env, asset.compression));
  if (asset.framePages) set(env, result, "framePages", boolean(env, true));
  if (!asset.textureArtifact.empty()) set(env, result, "textureArtifact", string(env, asset.textureArtifact.string()));
  if (asset.uniform) set(env, result, "uniform", arrayValue(env, *asset.uniform));
  if (asset.blockGrid) set(env, result, "blockGrid", arrayValue(env, *asset.blockGrid));
  if (asset.blockChannels) set(env, result, "blockChannels", number(env, *asset.blockChannels));
  if (asset.compactEligible) set(env, result, "compactEligible", boolean(env, *asset.compactEligible));
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
napi_value storageDescriptor(napi_env env, const ImageStorageDecision& decision) {
  auto value = moduleObject(env);
  set(env, value, "version", number(env, 1));
  set(env, value, "width", number(env, decision.width));
  set(env, value, "height", number(env, decision.height));
  set(env, value, "paletteBits", number(env, decision.paletteBits));
  set(env, value, "channels", number(env, decision.channels.channels));
  set(env, value, "source", arrayValue(env, decision.channels.source));
  set(env, value, "swizzle", arrayValue(env, decision.channels.swizzle));
  if (decision.hasPixelFacts) {
    set(env, value, "pixelFactsVersion", number(env, 1));
    set(env, value, "opaque", boolean(env, decision.opaque));
    set(env, value, "allZero", boolean(env, decision.allZero));
  }
  return value;
}
struct AssetWork {
  ~AssetWork() { if (sourceFd >= 0) ::close(sourceFd); }
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  int sourceFd = -1;
  struct stat snapshot{};
  std::filesystem::path staging;
  AssetRecipe recipe;
  AssetPreparationOptions options;
  AssetPreparationStats statistics;
  std::optional<PreparedAsset> layout;
  std::optional<PreparedAsset> result;
  std::shared_ptr<ImageFileSource> storageSource;
  std::optional<ImageStorageDecision> storage;
  std::string error;
  bool unsupported = false;
};
std::uint32_t arrayLength(napi_env env, napi_value value, std::uint32_t limit);
napi_value element(napi_env env, napi_value value, std::uint32_t index);
void executeAsset(napi_env, void* opaque) noexcept {
  PreparationMemoryRelease release;
  auto& work = *static_cast<AssetWork*>(opaque);
  try {
    if (work.storageSource) {
      const auto bytes = ImageStore::readCapturedBytes(*work.storageSource);
      if (!bytes) throw std::runtime_error("cannot read storage classification source");
      auto pixels = ImageStore::decodeMemory(bytes->data(), bytes->size());
      if (!pixels && work.storageSource->path().extension() == ".pml4") {
        if (auto page = readLz4Page(*bytes, 128*1024*1024))
          pixels = ImagePixels{page->width, page->height, std::move(page->rgba)};
      }
      if (!pixels) throw std::runtime_error("cannot decode image for storage classification");
      work.storage = ImageStore::classifyStorage(*pixels);
      return;
    }
    work.options.statistics = &work.statistics;
    const auto sourcePath = "/proc/self/fd/" + std::to_string(work.sourceFd);
    try {
      work.result = prepareAssetImage(sourcePath, work.staging,
        work.recipe, work.layout ? &*work.layout : nullptr, work.options);
    } catch (const AssetPreparationDecodeError&) {
      // The ordinary loader also accepts signature-detected formats and recoverable PNGs.
      const auto source = ImageStore::openFile(sourcePath);
      if (!source || !ImageStore::decodeFile(*source)) throw;
      work.unsupported = true;
    }
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
      work->storage ? storageDescriptor(env, *work->storage) :
      work->unsupported && work->statistics.workspaceConstrained ? [&] {
        napi_value result;
        napi_create_object(env, &result);
        set(env, result, "resultVersion", number(env, 1));
        set(env, result, "descriptor", null(env));
        set(env, result, "workspaceConstrained", boolean(env, true));
        return result;
      }() : work->unsupported ? null(env) : descriptor(env, *work->result, work->statistics.workspaceConstrained)), "cannot resolve asset preparation");
  } catch (const std::exception& error) {
    napi_value result;
    napi_value message = string(env, error.what());
    napi_create_error(env, nullptr, message, &result);
    napi_reject_deferred(env, work->deferred, result);
  }
  napi_delete_async_work(env, work->work);
}
napi_value processImage(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 6);
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
  napi_valuetype layoutType = napi_undefined;
  if (args.size() > 4) check(env, napi_typeof(env, args[4], &layoutType), "cannot inspect image layout");
  if (args.size() > 4 && layoutType != napi_undefined && layoutType != napi_null) {
    const auto value = args[4];
    PreparedAsset layout;
    if (hasProperty(env, value, "framePages"))
      check(env, napi_get_value_bool(env, property(env, value, "framePages"), &layout.framePages), "invalid frame pages layout");
    if (integer(env, property(env, value, "version")) != 1)
      throw std::runtime_error("unsupported indexed image layout");
    layout.width = integer(env, property(env, value, "width"));
    layout.height = integer(env, property(env, value, "height"));
    layout.halo = integer(env, property(env, value, "halo"));
    if (hasProperty(env, value, "uniform"))
      layout.uniform = color(env, property(env, value, "uniform"));
    if (hasProperty(env, value, "blockGrid"))
      layout.blockGrid = integers<3>(env, property(env, value, "blockGrid"));
    if (hasProperty(env, value, "blockChannels")) {
      const int channels = integer(env, property(env, value, "blockChannels"));
      if (!layout.blockGrid || channels < 0 || channels > 2) throw std::runtime_error("invalid block channels");
      layout.blockChannels = channels;
    }
    if (hasProperty(env, value, "compactEligible")) {
      bool eligible = false;
      check(env, napi_get_value_bool(env, property(env, value, "compactEligible"), &eligible), "invalid compact eligibility");
      layout.compactEligible = eligible;
    }
    const auto cells = property(env, value, "cells");
    for (std::uint32_t i = 0, n = arrayLength(env, cells, 4096); i < n; ++i) {
      const auto item = element(env, cells, i);
      PreparedAssetCell cell;
      cell.rect = integers<4>(env, property(env, item, "rect"));
      cell.crop = integers<4>(env, property(env, item, "crop"));
      cell.fill = color(env, property(env, item, "fill"));
      const auto page = asNumber(env, property(env, item, "page"));
      if (!std::isfinite(page) || page != std::floor(page) || page < -1 || page > 4095)
        throw std::runtime_error("invalid indexed page number");
      cell.page = static_cast<int>(page);
      cell.atlas = integers<4>(env, property(env, item, "atlas"));
      layout.cells.push_back(cell);
    }
    const auto pages = property(env, value, "pages");
    for (std::uint32_t i = 0, n = arrayLength(env, pages, 4096); i < n; ++i) {
      const auto item = element(env, pages, i);
      PreparedAssetPage page{asString(env, property(env, item, "path")),
        integer(env, property(env, item, "width")), integer(env, property(env, item, "height"))};
      layout.pages.push_back(std::move(page));
    }
    work->layout = std::move(layout);
  }
  if (args.size() > 5 && hasProperty(env, args[5], "workspaceBytes")) {
    const auto bytes = asNumber(env, property(env, args[5], "workspaceBytes"));
    if (!std::isfinite(bytes) || bytes < 0 || bytes > 256U * 1024U * 1024U || bytes != std::floor(bytes))
      throw std::runtime_error("workspaceBytes must be an integer from 0 to 268435456");
    work->options.workspaceBytes = static_cast<std::size_t>(bytes);
  }
  if (args.size() > 5 && hasProperty(env, args[5], "pageCodec")) {
    const auto codec = asString(env, property(env, args[5], "pageCodec"));
    if (codec != "png" && codec != "lz4") throw std::runtime_error("pageCodec must be png or lz4");
    work->options.lz4Pages = codec == "lz4";
  }
  if (args.size() > 5 && hasProperty(env, args[5], "allowAstc"))
    work->options.allowAstc = asBoolean(env, property(env, args[5], "allowAstc"));
  if (args.size() > 5 && hasProperty(env, args[5], "astcQuality")) {
    work->options.astcQuality = asString(env, property(env, args[5], "astcQuality"));
    if (work->options.astcQuality != "fast" && work->options.astcQuality != "medium" && work->options.astcQuality != "thorough")
      throw std::invalid_argument("ASTC quality must be fast, medium or thorough");
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

napi_value classifyImageStorage(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1);
  auto work = std::make_unique<AssetWork>();
  work->storageSource = ImageStore::openFile(asString(env, args.at(0)));
  if (!work->storageSource) throw std::runtime_error("cannot capture image storage source");
  napi_value promise;
  check(env, napi_create_promise(env, &work->deferred, &promise), "cannot create storage classification promise");
  check(env, napi_create_async_work(env, nullptr, string(env, "pmjs-image-storage"), executeAsset,
    completeAsset, work.get(), &work->work), "cannot create storage classification work");
  const auto queued = napi_queue_async_work(env, work->work);
  if (queued != napi_ok) { napi_delete_async_work(env, work->work); check(env, queued, "cannot queue storage classification"); }
  work.release();
  return promise;
} catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }

napi_value installImageStorage(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 2);
  const bool detailed = args.size() > 1 && asBoolean(env, args[1]);
  PreparationInstallReport report;
  auto& value = host(env);
  struct InstallGuard {
    ImageStore& images;
    bool complete = false;
    ~InstallGuard() { if (!complete) images.clearStorageDecisions(); }
  } guard{value.images};
  value.images.clearStorageDecisions();
  std::uint32_t installed = 0;
  for (std::uint32_t i = 0, n = arrayLength(env, args.at(0), 100000); i < n; ++i) {
    std::string identifier = std::to_string(i);
    try {
      const auto before = installed;
      const auto record = element(env, args[0], i);
      identifier = asString(env, property(env, record, "source"));
      const auto path = value.vfs.resolve(identifier);
      if (!path) { report.rejected.emplace_back(identifier, "missing source"); continue; }
      const auto storage = property(env, record, "storage");
      if (integer(env, property(env, storage, "version")) != 1) { report.rejected.emplace_back(identifier, "unsupported storage version"); continue; }
      ImageStorageDecision decision;
      decision.width = integer(env, property(env, storage, "width"));
      decision.height = integer(env, property(env, storage, "height"));
      decision.paletteBits = integer(env, property(env, storage, "paletteBits"));
      decision.channels.channels = integer(env, property(env, storage, "channels"));
      const auto source = integers<4>(env, property(env, storage, "source"));
      const auto swizzle = integers<4>(env, property(env, storage, "swizzle"));
      if (hasProperty(env, storage, "pixelFactsVersion") && integer(env, property(env, storage, "pixelFactsVersion")) == 1) {
        decision.hasPixelFacts = true;
        check(env, napi_get_value_bool(env, property(env, storage, "opaque"), &decision.opaque), "invalid opacity fact");
        check(env, napi_get_value_bool(env, property(env, storage, "allZero"), &decision.allZero), "invalid zero fact");
      }
      bool valid = true;
      for (int c = 0; c < 4; ++c) {
        valid &= source[c] >= 0 && source[c] < 4 && swizzle[c] >= 0 && swizzle[c] < 6;
        decision.channels.source[c] = static_cast<std::uint8_t>(source[c]);
        decision.channels.swizzle[c] = static_cast<std::uint8_t>(swizzle[c]);
      }
      const auto identity = asString(env, property(env, record, "sourceIdentity"));
      const auto hash = hasProperty(env, record, "backingHash")
        ? asString(env, property(env, record, "backingHash")) : std::string{};
      if (valid && value.images.installStorageDecision(*path, identity, decision, hash)) ++installed;
      else if (i - installed < 3)
        Log(LogLevel::Warning) << "[pmjs] image storage installation rejected source=" << path->string()
          << " expected=" << identity << " actual=" << Vfs::fileIdentity(*path);
      if (installed != before) report.accepted.push_back(identifier);
      else report.rejected.emplace_back(identifier, "storage decision or source checksum rejected");
    } catch (const std::exception& error) { report.reject(env, identifier, error.what()); }
  }
  guard.complete = true;
  return detailed ? report.result(env) : number(env, installed);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}
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
  PreparationMemoryRelease release;
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
  const auto args = arguments(env, info, 3);
  const bool capture = !catalog && args.size() > 1 && asBoolean(env, args[1]);
  const bool detailed = args.size() > 2 && asBoolean(env, args[2]);
  PreparationInstallReport report;
  auto& value = host(env);
  const auto count = arrayLength(env, args.at(0), 65536);
  value.images.clearTileSetIndex();
  std::uint32_t installed = 0;
  for (std::uint32_t i = 0; i < count; ++i) {
    std::string identifier = std::to_string(i);
    try {
      auto entry = element(env, args[0], i); PreparedTileSet setValue;
      auto d = property(env, entry, "descriptor");
      setValue.identity = asString(env, property(env, entry, "identity"));
      identifier = setValue.identity;
      setValue.directory = asString(env, property(env, entry, "directory"));
      setValue.version = integer(env, property(env, d, "version"));
      setValue.halo = integer(env, property(env, d, "halo"));
      auto pageValues = property(env, d, "pages");
      const auto pageCount = arrayLength(env, pageValues, 4096);
      setValue.pages.reserve(pageCount);
      for (std::uint32_t j = 0; j < pageCount; ++j) {
        auto page = element(env, pageValues, j);
        setValue.pages.push_back({asString(env, property(env, page, "path")),
          integer(env, property(env, page, "width")), integer(env, property(env, page, "height"))});
        // Optional: descriptors published before page hashes were recorded keep exact identity checks.
        setValue.pageHashes.push_back(hasProperty(env, page, "hash") ? asString(env, property(env, page, "hash")) : "");
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
        if (hasProperty(env, source, "sourceHash")) output.sourceHash = asString(env, property(env, source, "sourceHash"));
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
      std::vector<std::string> pages, snapshots;
      if (catalog) {
        for (const auto name : {"pageIdentities", "snapshotIdentities"}) {
          auto list = property(env, entry, name);
          auto& output = std::string(name) == "pageIdentities" ? pages : snapshots;
          const auto size = arrayLength(env, list, 4096);
          for (std::uint32_t j = 0; j < size; ++j) output.push_back(asString(env, element(env, list, j)));
        }
      }
      std::vector<std::string> capturedPages, capturedSnapshots;
      if (value.images.installTileSet(std::move(setValue), catalog ? &pages : nullptr, catalog ? &snapshots : nullptr, capture ? &capturedPages : nullptr, capture ? &capturedSnapshots : nullptr)) {
        ++installed;
        report.accepted.push_back(identifier);
        if (capture) {
            for (const auto name : {"pageIdentities", "snapshotIdentities"}) {
            const auto& captured = std::string(name) == "pageIdentities" ? capturedPages : capturedSnapshots;
            napi_value list; check(env, napi_create_array_with_length(env, captured.size(), &list), "cannot create identities");
            for (std::size_t j = 0; j < captured.size(); ++j) check(env, napi_set_element(env, list, j, string(env, captured[j])), "cannot set identity");
            set(env, entry, name, list);
          }
        }
      } else report.rejected.emplace_back(identifier, "tile sources, pages or descriptor rejected");
    } catch (const std::exception& error) { report.reject(env, identifier, error.what()); }
  }
  return detailed ? report.result(env) : number(env, installed);
} catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
napi_value installTileSets(napi_env env, napi_callback_info info) { return installTileSetsImpl(env, info, false); }
napi_value installTileSetCatalog(napi_env env, napi_callback_info info) { return installTileSetsImpl(env, info, true); }
napi_value consumePreparationFailures(napi_env env, napi_callback_info) try {
  const auto failures = host(env).images.consumePreparationFailures();
  napi_value result;
  check(env, napi_create_array_with_length(env, failures.size(), &result), "cannot create preparation failures");
  for (std::size_t i = 0; i < failures.size(); ++i)
    check(env, napi_set_element(env, result, i, string(env, failures[i])), "cannot set preparation failure");
  return result;
} catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
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
  method(env, assets, "compressPortArtifact", compressPortArtifact);
  method(env, assets, "decompressPortArtifact", decompressPortArtifact);
  method(env, assets, "tryAcquirePreparationLock", tryAcquirePreparationLock);
  method(env, assets, "releasePreparationLock", releasePreparationLock);
  method(env, assets, "consumePreparationInvalidations", consumePreparationInvalidations);
  method(env, assets, "consumePreparationFailures", consumePreparationFailures);
  method(env, assets, "processImage", processImage);
  method(env, assets, "classifyImageStorage", classifyImageStorage);
  method(env, assets, "installImageStorage", installImageStorage);
  set(env, assets, "imageStorageVersion", number(env, 1));
  method(env, assets, "processTiles", processTiles);
  method(env, assets, "installTileSets", installTileSets);
  method(env, assets, "installTileSetCatalog", installTileSetCatalog);
  method(env, property(env, exports, "images"), "tileSlot", tileSlot);
#ifdef PMJS_HAS_SKIA65
  set(env, assets, "tilePreparationVersion", string(env, "lossless-tile-sets-v4-skia65"));
#else
  set(env, assets, "tilePreparationVersion", string(env, "lossless-tile-sets-v4-unmanaged"));
#endif
  const auto version = moduleObject(env);
#ifdef PMJS_HAS_SKIA65
  set(env, version, "colorManagement", string(env, "skia65"));
#else
  set(env, version, "colorManagement", string(env, "none"));
#endif
  set(env, version, "processor", string(env, "images-v24-auto-texture-chunks-astcenc4.7"));
  set(env, version, "decoder", string(env, std::string("libpng-") + png_get_libpng_ver(nullptr) + "-rgba8-color-v2"));
  set(env, version, "pageSize", number(env, 2048));
  set(env, assets, "preparationVersion", version);
  set(env, assets, "preparationWorkspaceVersion", number(env, 1));
  set(env, assets, "preparationLz4Version", string(env, "lz4-1.10.0-indexed-palette-v3"));
}
}
