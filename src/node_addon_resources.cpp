#include "log.hpp"
#include "node_addon_internal.hpp"
#include "asset_processor.hpp"
#include <cmath>
#include <span>

namespace pmjs::addon {
namespace {
constexpr std::size_t maxEncodedImageBytes = 64U * 1024U * 1024U;

std::vector<std::uint8_t> encodedImageBytes(napi_env env, napi_value value) {
  bool isArrayBuffer = false;
  check(env, napi_is_arraybuffer(env, value, &isArrayBuffer),
        "cannot inspect encoded image bytes");
  void* data = nullptr;
  std::size_t size = 0;
  if (isArrayBuffer) {
    check(env, napi_get_arraybuffer_info(env, value, &data, &size),
          "cannot read encoded image ArrayBuffer");
  } else {
    bool isTypedArray = false;
    check(env, napi_is_typedarray(env, value, &isTypedArray),
          "cannot inspect encoded image bytes");
    if (!isTypedArray) throw std::runtime_error("encoded image must be an ArrayBuffer or Uint8Array");
    napi_typedarray_type type;
    napi_value arrayBuffer;
    std::size_t offset = 0;
    check(env, napi_get_typedarray_info(env, value, &type, &size, &data,
                                       &arrayBuffer, &offset),
          "cannot read encoded image Uint8Array");
    if (type != napi_uint8_array && type != napi_uint8_clamped_array) {
      throw std::runtime_error("encoded image must be an ArrayBuffer or Uint8Array");
    }
  }
  if (size == 0 || size > maxEncodedImageBytes) {
    throw std::runtime_error("encoded image exceeds the 64 MiB limit or is empty");
  }
  const auto* begin = static_cast<const std::uint8_t*>(data);
  return std::vector<std::uint8_t>(begin, begin + size);
}
}

napi_value loadImage(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 3);
  State& value = host(env);
  auto path = value.vfs.resolve(asString(env, args.at(0)));
  const bool retainCpuPixels = args.size() > 1 && asBoolean(env, args.at(1));
  auto image = path ? value.images.loadPng(*path, retainCpuPixels, args.size() > 2 ? asString(env, args[2]) : "") : std::nullopt;
  if (!image) throw std::runtime_error("cannot load image");
  return imageInfo(env, image->handle, image->width, image->height);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value acquireCachedImage(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 2);
  State& value = host(env);
  const auto path = value.vfs.resolve(asString(env, args.at(0)));
  const auto source = path ? ImageStore::openFile(*path) : nullptr;
  const auto requested = args.size() > 1 ? asString(env, args[1]) : "";
  const auto image = source ? value.images.acquireCached(*source,
    value.images.effectiveTileSet(*source, requested)) : std::nullopt;
  if (image) return imageInfo(env, image->handle, image->width, image->height);
  napi_value result;
  check(env, napi_get_null(env, &result), "cannot create cache miss");
  return result;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value loadImageBytes(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 2);
  State& value = host(env);
  auto bytes = encodedImageBytes(env, args.at(0));
  auto pixels = pmjs::ImageStore::decodeMemory(bytes.data(), bytes.size());
  auto image = pixels ? value.images.installDecodedMemory(
    std::move(*pixels), args.size() > 1 && asBoolean(env, args.at(1))) : std::nullopt;
  if (!image) throw std::runtime_error("cannot decode image bytes");
  return imageInfo(env, image->handle, image->width, image->height);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value loadAssetImage(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 2);
  State& value = host(env);
  auto path = value.assets ? value.assets->resolve(asString(env, args.at(0)))
                           : std::nullopt;
  const bool retainCpuPixels = args.size() > 1 && asBoolean(env, args.at(1));
  auto image = path ? value.images.loadPng(*path, retainCpuPixels) : std::nullopt;
  if (!image) throw std::runtime_error("cannot load generated asset image");
  return imageInfo(env, image->handle, image->width, image->height);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value fallbackImage(napi_env env, napi_callback_info) try {
  State& value = host(env);
  auto info = value.images.acquireFallback();
  if (!info) throw std::runtime_error("cannot acquire fallback image");
  return imageInfo(env, info->handle, info->width, info->height);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
} catch (...) {
  napi_throw_error(env, nullptr, "fallbackImage failed"); return nullptr;
}


struct AsyncImageLoad {
  napi_env env = nullptr;
  napi_async_work work = nullptr;
  std::vector<napi_deferred> deferreds;
  std::unique_ptr<pmjs::ImageFileSource> source;
  std::shared_ptr<pmjs::ImageFileSource> fallbackSource;
  std::string key, tileSet;
  bool retainCpuPixels = false;
  bool prepareCpuPixels = false, tileValidationFailed = false;
  std::shared_ptr<pmjs::ImageStore::PreparedLoad> prepared;
  // Failed tile loads may still own GPU pages; release them on completion.
  std::shared_ptr<pmjs::ImageStore::PreparedLoad> failedPrepared;
  std::optional<pmjs::ImagePixels> pixels;
};

napi_status queueImageWork(napi_env env, AsyncImageLoad& load);

struct AsyncImageMemoryLoad {
  napi_env env = nullptr;
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::vector<std::uint8_t> bytes;
  bool retainCpuPixels = false;
  std::optional<pmjs::ImagePixels> pixels;
};

void executeImageMemoryLoad(napi_env, void* opaque) noexcept {
  auto* load = static_cast<AsyncImageMemoryLoad*>(opaque);
  try {
    load->pixels = pmjs::ImageStore::decodeMemory(load->bytes.data(), load->bytes.size());
    std::vector<std::uint8_t>().swap(load->bytes);
  } catch (...) {
    load->pixels = std::nullopt;
  }
}

void rejectImageLoads(napi_env env, std::span<const napi_deferred> deferreds,
                      const char* message) noexcept {
  napi_value error = nullptr;
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (pending) napi_get_and_clear_last_exception(env, &error);
  if (!error) {
    napi_value text;
    if (napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &text) == napi_ok)
      napi_create_error(env, nullptr, text, &error);
  }
  if (!error) napi_get_undefined(env, &error);
  for (const auto deferred : deferreds) napi_reject_deferred(env, deferred, error);
}

void completeImageMemoryLoad(napi_env env, napi_status status, void* opaque) noexcept {
  std::unique_ptr<AsyncImageMemoryLoad> load(static_cast<AsyncImageMemoryLoad*>(opaque));
  const auto owner = state;
  pmjs::ImageHandle installedHandle = 0;
  try {
    if (status != napi_ok || !load->pixels || !owner)
      throw std::runtime_error("cannot decode image bytes");
    auto installed = owner->images.installDecodedMemory(
      std::move(*load->pixels), load->retainCpuPixels);
    if (!installed) throw std::runtime_error("cannot install image bytes");
    installedHandle = installed->handle;
    const auto result = imageInfo(env, installed->handle, installed->width, installed->height);
    check(env, napi_resolve_deferred(env, load->deferred, result), "cannot resolve image bytes");
    installedHandle = 0;
  } catch (const std::exception& error) {
    rejectImageLoads(env, {&load->deferred, 1}, error.what());
  } catch (...) {
    rejectImageLoads(env, {&load->deferred, 1}, "image byte installation failed");
  }
  if (installedHandle) owner->images.release(installedHandle);
  napi_delete_async_work(env, load->work);
}

napi_value loadImageBytesAsync(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 2);
  auto load = std::make_unique<AsyncImageMemoryLoad>();
  load->env = env;
  load->bytes = encodedImageBytes(env, args.at(0));
  load->retainCpuPixels = args.size() > 1 && asBoolean(env, args.at(1));
  napi_value promise;
  check(env, napi_create_promise(env, &load->deferred, &promise),
        "cannot create image byte promise");
  napi_value name;
  check(env, napi_create_string_utf8(env, "pmjs-image-byte-load", NAPI_AUTO_LENGTH,
                                     &name), "cannot create image byte work name");
  check(env, napi_create_async_work(env, nullptr, name, executeImageMemoryLoad,
                                    completeImageMemoryLoad, load.get(), &load->work),
        "cannot create image byte work");
  const auto queued = napi_queue_async_work(env, load->work);
  if (queued != napi_ok) {
    napi_delete_async_work(env, load->work);
    check(env, queued, "cannot queue image byte work");
  }
  load.release();
  return promise;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

void executeImageLoad(napi_env, void* opaque) noexcept {
  auto* load = static_cast<AsyncImageLoad*>(opaque);
  if (load->prepared) {
    try {
      if (state && state->images.validatePrepared(*load->prepared, load->prepareCpuPixels)) return;
    } catch (...) {
      // Invalid prepared backing still permits decoding the captured source.
    }
    load->tileValidationFailed = !load->tileSet.empty();
    try {
      if (state) load->pixels = state->images.decodePreparedFallback(*load->prepared);
    } catch (...) {
      load->pixels = std::nullopt;
    }
    if (!load->pixels && load->source) {
      try { load->pixels = pmjs::ImageStore::decodeFile(*load->source); }
      catch (...) { load->pixels = std::nullopt; }
    }
    load->failedPrepared = std::move(load->prepared);
    return;
  }
  try {
    load->pixels = pmjs::ImageStore::decodeFile(load->fallbackSource ? *load->fallbackSource : *load->source);
  } catch (...) {
    load->pixels = std::nullopt;
  }
}

void completeImageLoad(napi_env env, napi_status status, void* opaque) noexcept {
  std::unique_ptr<AsyncImageLoad> load(static_cast<AsyncImageLoad*>(opaque));
  const auto owner = state;
  pmjs::ImageHandle installedHandle = 0;
  std::size_t ownerships = 0;
  try {
    napi_delete_async_work(env, load->work);
    load->work = nullptr;
    load->failedPrepared.reset();
    if (!owner) throw std::runtime_error("image runtime is unavailable");
    // A caller may request CPU pixels after validation has already finished.
    if (status == napi_ok && load->prepared && load->retainCpuPixels && !load->prepareCpuPixels) {
      load->prepareCpuPixels = true;
      if (queueImageWork(env, *load) == napi_ok) { load.release(); return; }
      status = napi_generic_failure;
    }
    if (load->tileValidationFailed) owner->images.noteTileLoadFallback();
    if (status != napi_ok || (!load->prepared && !load->pixels))
      throw std::runtime_error("cannot load image");
    const bool preparedAttempt = static_cast<bool>(load->prepared);
    auto installed = load->prepared ? owner->images.installPreparedLoad(
      *load->source, std::move(load->prepared), load->retainCpuPixels) :
      owner->images.installDecoded(*load->source, std::move(*load->pixels), load->retainCpuPixels);
    if (!installed && preparedAttempt) {
      // No view was published; retry the captured ordinary source for all callers.
      load->prepared.reset();
      if (queueImageWork(env, *load) == napi_ok) { load.release(); return; }
    }
    if (!installed) throw std::runtime_error("cannot install image");
    installedHandle = installed->handle;
    ownerships = 1;
    std::vector<napi_value> results;
    results.reserve(load->deferreds.size());
    // Finish every allocation before publishing any coalesced ownership.
    for (std::size_t i = 0; i < load->deferreds.size(); ++i) {
      results.push_back(imageInfo(env, installed->handle, installed->width, installed->height));
      if (i) {
        if (!owner->images.retain(installed->handle)) throw std::runtime_error("cannot retain image");
        ++ownerships;
      }
    }
    for (std::size_t i = 0; i < load->deferreds.size(); ++i) {
      check(env, napi_resolve_deferred(env, load->deferreds[i], results[i]), "cannot resolve image");
      --ownerships;
    }
  } catch (const std::exception& error) {
    rejectImageLoads(env, load->deferreds, error.what());
  } catch (...) {
    rejectImageLoads(env, load->deferreds, "image installation failed");
  }
  while (ownerships) { --ownerships; owner->images.release(installedHandle); }
  if (owner) owner->pendingImageLoads.erase(load->key);
  if (load->work) napi_delete_async_work(env, load->work);
}

napi_status queueImageWork(napi_env env, AsyncImageLoad& load) {
  napi_value name;
  auto status = napi_create_string_utf8(env, "pmjs-image-load", NAPI_AUTO_LENGTH, &name);
  if (status != napi_ok) return status;
  status = napi_create_async_work(env, nullptr, name, executeImageLoad,
    completeImageLoad, &load, &load.work);
  if (status != napi_ok) return status;
  status = napi_queue_async_work(env, load.work);
  if (status != napi_ok) {
    napi_delete_async_work(env, load.work);
    load.work = nullptr;
  }
  return status;
}

napi_value queueImageLoad(napi_env env, const std::filesystem::path& path,
                          bool retainCpuPixels, const std::string& requestedTileSet = {},
                          std::optional<ImageEncryptionKey> encryptionKey = std::nullopt) {
  auto source = pmjs::ImageStore::openFile(path, encryptionKey);
  if (!source) throw std::runtime_error("cannot open image");
  const auto tileSet = state->images.effectiveTileSet(*source, requestedTileSet);
  const std::string key = source->key() + (tileSet.empty() ? "" : "\n"+tileSet);
  napi_deferred deferred = nullptr;
  napi_value promise;
  check(env, napi_create_promise(env, &deferred, &promise),
        "cannot create image promise");
  if (auto cached = state->images.acquireCached(*source, tileSet)) {
    if (!retainCpuPixels || !state->images.hasPreparedBacking(cached->handle) ||
        state->images.hasCpuPixels(cached->handle)) {
      if (retainCpuPixels) state->images.retainCpuPixels(cached->handle);
      napi_resolve_deferred(env, deferred,
        imageInfo(env, cached->handle, cached->width, cached->height));
      return promise;
    }
    state->images.release(cached->handle);
  }
  const auto pending = state->pendingImageLoads.find(key);
  if (pending != state->pendingImageLoads.end()) {
    pending->second->retainCpuPixels |= retainCpuPixels;
    pending->second->deferreds.push_back(deferred);
    ++state->imageDecodeRequestsCoalesced;
    return promise;
  }
  auto load = std::make_unique<AsyncImageLoad>();
  load->env = env;
  load->source = std::move(source);
  load->key = key;
  load->tileSet = tileSet;
  load->retainCpuPixels = retainCpuPixels;
  load->prepareCpuPixels = retainCpuPixels;
  load->prepared = state->images.capturePrepared(*load->source, tileSet);
  if (load->prepared) load->fallbackSource = state->images.capturePreparedFallback(*load->prepared);
  load->deferreds.push_back(deferred);
  state->pendingImageLoads.emplace(key, load.get());
  const auto queued = queueImageWork(env, *load);
  if (queued != napi_ok) {
    state->pendingImageLoads.erase(key);
    check(env, queued, "cannot queue image work");
  }
  ++state->imageDecodeJobs;
  load.release();
  return promise;
}

napi_value loadImageAsync(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 3);
  State& value = host(env);
  auto path = value.vfs.resolve(asString(env, args.at(0)));
  if (!path) throw std::runtime_error("cannot resolve image");
  return queueImageLoad(env, *path,
    args.size() > 1 && asBoolean(env, args.at(1)), args.size() > 2 ? asString(env, args[2]) : "");
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value loadEncryptedImageAsync(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 3);
  auto& value = host(env);
  const auto path = value.vfs.resolve(asString(env, args.at(0)));
  if (!path) throw std::runtime_error("cannot resolve encrypted image");
  return queueImageLoad(env, *path, args.size() > 2 && asBoolean(env, args[2]), "",
    imageEncryptionKey(asString(env, args.at(1))));
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value loadAssetImageAsync(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 2);
  State& value = host(env);
  auto path = value.assets ? value.assets->resolve(asString(env, args.at(0)))
                           : std::nullopt;
  if (!path) throw std::runtime_error("cannot resolve generated asset image");
  return queueImageLoad(env, *path,
    args.size() > 1 && asBoolean(env, args.at(1)));
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value readAssetText(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  State& value = host(env);
  if (!value.assets) return null(env);
  const auto contents = value.assets->readText(asString(env, args.at(0)));
  return contents ? string(env, *contents) : null(env);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value assetExists(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  State& value = host(env);
  return boolean(env, value.assets &&
    value.assets->exists(asString(env, args.at(0))));
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value releaseImage(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  if (!host(env).images.release(asUint32(env, args.at(0)))) throw std::runtime_error("invalid image");
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what()); return nullptr;
}

napi_value pinImage(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  if (!host(env).images.pin(asUint32(env, args.at(0)))) {
    throw std::runtime_error("invalid image");
  }
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what()); return nullptr;
}

napi_value unpinImage(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  if (!host(env).images.unpin(asUint32(env, args.at(0)))) {
    throw std::runtime_error("invalid or unpinned image");
  }
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what()); return nullptr;
}

napi_value touchImage(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  if (!host(env).images.touch(asUint32(env, args.at(0)))) {
    throw std::runtime_error("invalid image");
  }
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_range_error(env, nullptr, error.what()); return nullptr;
}

napi_value imageMemory(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 1);
  auto& value = host(env);
  auto& images = value.images;
  std::size_t limit = 0;
  if (!args.empty()) limit = std::min<std::size_t>(100, asUint32(env, args[0]));
  const auto setProperty = [env](napi_value object, const char* key, napi_value propertyValue) {
    check(env, napi_set_named_property(env, object, key, propertyValue), "cannot set image memory property");
  };
  napi_value result;
  check(env, napi_create_object(env, &result), "cannot create image memory state");
  setProperty(result, "liveCount",
    number(env, images.liveCount()));
  setProperty(result, "gpuBytes",
    number(env, images.gpuBytes()));
  setProperty(result, "peakGpuBytes",
    number(env, images.peakGpuBytes()));
  setProperty(result, "cpuBytes",
    number(env, images.cpuBytes()));
  setProperty(result, "tileMetadataBytes",
    number(env, images.tileMetadataBytes()));
  setProperty(result, "tileVerificationCacheEntries",
    number(env, images.tileVerificationCacheEntries()));
  setProperty(result, "tileVerificationCacheEstimatedBytes",
    number(env, images.tileVerificationCacheEstimatedBytes()));
  setProperty(result, "tileVerificationCacheEntryLimit",
    number(env, pmjs::ImageStore::tileVerificationCacheEntryLimit));
  setProperty(result, "tileVerificationCacheByteLimit",
    number(env, pmjs::ImageStore::tileVerificationCacheByteLimit));
  setProperty(result, "warmBudgetBytes",
    number(env, images.warmBudgetBytes()));
  setProperty(result, "warmBytes",
    number(env, images.warmBytes()));
  setProperty(result, "warmCount",
    number(env, images.warmCount()));
  setProperty(result, "warmFileCount",
    number(env, images.warmFileCount()));
  setProperty(result, "warmEntryLimit",
    number(env, pmjs::ImageStore::warmEntryLimit));
  setProperty(result, "warmFileLimit",
    number(env, pmjs::ImageStore::warmFileLimit));
  setProperty(result, "pinnedBytes",
    number(env, images.pinnedBytes()));
  setProperty(result, "pinnedCount",
    number(env, images.pinnedCount()));
  setProperty(result, "cacheHits",
    number(env, images.cacheHits()));
  setProperty(result, "warmHits",
    number(env, images.warmHits()));
  setProperty(result, "budgetEvictions",
    number(env, images.budgetEvictions()));
  setProperty(result, "textureCreates",
    number(env, images.textureCreates()));
  setProperty(result, "textureFullUpdates",
    number(env, images.textureFullUpdates()));
  setProperty(result, "textureRegionUpdates",
    number(env, images.textureRegionUpdates()));
  setProperty(result, "textureUploadBytes",
    number(env, images.textureUploadBytes()));
  setProperty(result, "pendingDecodeJobs",
    number(env, value.pendingImageLoads.size()));
  setProperty(result, "decodeJobs",
    number(env, value.imageDecodeJobs));
  setProperty(result, "coalescedRequests",
    number(env, value.imageDecodeRequestsCoalesced));
  setProperty(result, "fallbackHandle",
    uint32(env, images.fallbackHandle()));
  setProperty(result, "fallbackReferences",
    number(env, images.fallbackReferences()));
  setProperty(result, "fallbackUses",
    number(env, images.fallbackUses()));
  setProperty(result, "tileHits", number(env, images.tileHits()));
  setProperty(result, "tileRegions", number(env, images.tileRegions()));
  setProperty(result, "tileMaterializations", number(env, images.tileMaterializations()));
  setProperty(result, "tilePageDecodes", number(env, images.tilePageDecodes()));
  setProperty(result, "tilePageUploads", number(env, images.tilePageUploads()));
  auto tileRegionSets = moduleObject(env);
  for (const auto& [identity, count] : images.tileRegionSets()) setProperty(tileRegionSets, identity.c_str(), number(env, count));
  setProperty(result, "tileRegionSets", tileRegionSets);
  auto tileFallbacks = moduleObject(env);
  for (const auto& [reason, count] : images.tileFallbacks()) setProperty(tileFallbacks, reason.c_str(), number(env, count));
  setProperty(result, "tileFallbacks", tileFallbacks);
  setProperty(result, "preparedHits", number(env, images.preparedHits()));
  setProperty(result, "preparedRegions", number(env, images.preparedRegions()));
  setProperty(result, "preparedMaterializations", number(env, images.preparedMaterializations()));
  setProperty(result, "sceneryWindowHits", number(env, images.sceneryWindowHits()));
  setProperty(result, "sceneryWindowUploads", number(env, images.sceneryWindowUploads()));
  setProperty(result, "sceneryScrollWindows", number(env, images.sceneryScrollWindows()));
  setProperty(result, "sceneryScrollCopyBytes", number(env, images.sceneryScrollCopyBytes()));
  setProperty(result, "sceneryScrollUploadBytes", number(env, images.sceneryScrollUploadBytes()));
  setProperty(result, "sceneryScrollFallbacks", number(env, images.sceneryScrollFallbacks()));
  setProperty(result, "sceneryFullFallbacks", number(env, images.sceneryFullFallbacks()));
  setProperty(result, "sceneryWindowReadMicros", number(env, images.sceneryWindowReadMicros()));
  setProperty(result, "sceneryWindowPremultiplyMicros", number(env, images.sceneryWindowPremultiplyMicros()));
  setProperty(result, "sceneryWindowCreateMicros", number(env, images.sceneryWindowCreateMicros()));
  napi_value sceneryWindowRejections;
  check(env, napi_create_object(env, &sceneryWindowRejections),
    "cannot create scenery window rejection counts");
  for (const auto& [reason, count] : images.sceneryWindowRejections())
    setProperty(sceneryWindowRejections, reason.c_str(), number(env, count));
  setProperty(result, "sceneryWindowRejections", sceneryWindowRejections);
  napi_value sceneryBackingRejections;
  check(env, napi_create_object(env, &sceneryBackingRejections),
    "cannot create scenery backing rejection counts");
  for (const auto& [reason, count] : images.sceneryBackingRejections())
    setProperty(sceneryBackingRejections, reason.c_str(), number(env, count));
  setProperty(result, "sceneryBackingRejections", sceneryBackingRejections);
  setProperty(result, "preparedPageDecodes", number(env, images.preparedPageDecodes()));
  setProperty(result, "preparedSharedPageHits", number(env, images.preparedSharedPageHits()));
  setProperty(result, "preparedSharedTextureHits", number(env, images.preparedSharedTextureHits()));
  setProperty(result, "preparedRegionReads", number(env, images.preparedRegionReads()));
  setProperty(result, "preparedFrameCacheBudget", number(env, images.preparedFrameCacheBudget()));
  setProperty(result, "preparedFrameCacheBytes", number(env, images.preparedFrameCacheBytes()));
  setProperty(result, "preparedFrameCacheHits", number(env, images.preparedFrameCacheHits()));
  setProperty(result, "preparedPageTextureBytes", number(env, images.preparedPageTextureBytes()));
  setProperty(result, "preparedFrameConversions", number(env, images.preparedFrameConversions()));
  setProperty(result, "preparedFrameConversionMs", number(env, images.preparedFrameConversionMs()));
  setProperty(result, "preparedFrameCacheBypasses", number(env, images.preparedFrameCacheBypasses()));
  setProperty(result, "renderReadbacks", number(env, images.renderReadbacks()));
  setProperty(result, "preparedFrameUploadBytes", number(env, images.preparedFrameUploadBytes()));
  setProperty(result, "paletteReadbacks", number(env, images.paletteReadbacks()));
  setProperty(result, "preparedFrameCacheMisses", number(env, images.preparedFrameCacheMisses()));
  setProperty(result, "preparedFrameCacheEvictions", number(env, images.preparedFrameCacheEvictions()));
  setProperty(result, "preparedFrameResidentBytes", number(env, images.preparedFrameResidentBytes()));
  setProperty(result, "preparedFrameEvictedBytes", number(env, images.preparedFrameEvictedBytes()));
  setProperty(result, "preparedFramePeakResidentBytes", number(env, images.preparedFramePeakResidentBytes()));
  setProperty(result, "compactUploadFailures", number(env, images.compactUploadFailures()));
  setProperty(result, "compactTextureUploads", number(env, images.compactTextureUploads()));
  setProperty(result, "preparedCropUploads", number(env, images.preparedCropUploads()));
  setProperty(result, "preparedCropUploadBytes", number(env, images.preparedCropUploadBytes()));
  setProperty(result, "blockTextureUploads", number(env, images.blockTextureUploads()));
  setProperty(result, "blockUploadFailures", number(env, images.blockUploadFailures()));
  setProperty(result, "blockRegions", number(env, images.blockRegions()));
  setProperty(result, "textureArtifactLoads", number(env, images.textureArtifactLoads()));
  setProperty(result, "textureArtifactFailures", number(env, images.textureArtifactFailures()));
  setProperty(result, "textureArtifactStagingBytes", number(env, images.textureArtifactStagingBytes()));
  setProperty(result, "sourceTextureBuilds", number(env, images.sourceTextureBuilds()));
  setProperty(result, "textureArtifactFailureReason", string(env, images.textureArtifactFailureReason()));
  napi_value preparedFallbacks;
  check(env, napi_create_object(env, &preparedFallbacks), "cannot create prepared fallback counts");
  for (const auto& [reason, count] : images.preparedFallbacks())
    setProperty(preparedFallbacks, reason.c_str(), number(env, count));
  setProperty(result, "preparedFallbacks", preparedFallbacks);
  setProperty(result, "storageDecisionHits", number(env, images.storageDecisionHits()));
  auto entries = limit ? images.memoryEntries() : std::vector<pmjs::ImageMemoryEntry>();
  std::sort(entries.begin(), entries.end(), [](const auto& left, const auto& right) {
    return left.gpuBytes + left.cpuBytes > right.gpuBytes + right.cpuBytes;
  });
  if (entries.size() > limit) entries.resize(limit);
  napi_value largest;
  check(env, napi_create_array_with_length(env, entries.size(), &largest),
        "cannot create image memory list");
  for (std::size_t index = 0; index < entries.size(); ++index) {
    const auto& entry = entries[index];
    std::string path = entry.path.empty() ? "canvas:" : entry.path;
    auto shorten = [&](const pmjs::Vfs& vfs, const std::string& prefix) {
      const auto relative = std::filesystem::path(entry.path).lexically_relative(vfs.root());
      if (!relative.empty() && *relative.begin() != "..") {
        path = prefix + relative.generic_string();
        return true;
      }
      return false;
    };
    if (!path.empty() && !shorten(value.vfs, "game:/") && value.assets) {
      shorten(*value.assets, "generated-assets:/");
    }
    napi_value item;
    check(env, napi_create_object(env, &item), "cannot create image memory entry");
    setProperty(item, "handle", uint32(env, entry.handle));
    setProperty(item, "path", string(env, path));
    setProperty(item, "width", number(env, entry.width));
    setProperty(item, "height", number(env, entry.height));
    setProperty(item, "references", number(env, entry.references));
    setProperty(item, "inFlight", number(env, entry.inFlight));
    setProperty(item, "pins", number(env, entry.pins));
    setProperty(item, "gpuBytes", number(env, entry.gpuBytes));
    setProperty(item, "cpuBytes", number(env, entry.cpuBytes));
    setProperty(item, "lastUsedSerial",
      number(env, entry.lastUsedSerial));
    setProperty(item, "warm", boolean(env, entry.warm));
    setProperty(item, "sceneryBacking", boolean(env, entry.sceneryBacking));
    setProperty(item, "sceneryFullMaterialized",
      boolean(env, entry.sceneryFullMaterialized));
    setProperty(item, "palette", boolean(env, entry.palette));
    setProperty(item, "paletteSparse", boolean(env, entry.paletteSparse));
    setProperty(item, "paletteIndexBits", number(env, entry.paletteIndexBits));
    setProperty(item, "fullTextureResident", boolean(env, entry.fullTextureResident));
    setProperty(item, "astc", boolean(env, entry.astc));
    if (entry.sceneryParent) {
      setProperty(item, "sceneryParent", uint32(env, entry.sceneryParent));
      napi_value rect;
      check(env, napi_create_array_with_length(env, 4, &rect), "cannot create scenery rectangle");
      for (std::size_t coordinate = 0; coordinate < 4; ++coordinate)
        check(env, napi_set_element(env, rect, coordinate, number(env, entry.sceneryRect[coordinate])),
          "cannot set scenery coordinate");
      setProperty(item, "sceneryRect", rect);
    }
    if (!entry.sceneryFirstMaterializationCaller.empty())
      setProperty(item, "sceneryFirstMaterializationCaller",
        string(env, entry.sceneryFirstMaterializationCaller));
    check(env, napi_set_element(env, largest, index, item),
          "cannot append image memory entry");
  }
  setProperty(result, "largest", largest);
  syncExternalMemory(env);
  return result;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
}


napi_value isOpaqueImage(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1);
  const auto opaque = host(env).images.isOpaque(asUint32(env, args.at(0)));
  if (!opaque) throw std::runtime_error("cannot inspect image opacity");
  return boolean(env, *opaque);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value exportResidentImage(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 2);
  if (args.size() != 2) throw std::invalid_argument("exportResident requires an image handle and output directory");
  const auto directory = std::filesystem::path(asString(env, args[1]));
  std::filesystem::create_directories(directory);
  napi_value result;
  check(env, napi_create_array(env, &result), "cannot create resident image list");
  std::size_t index = 0;
  const auto valid = host(env).images.visitResidentImages(asUint32(env, args[0]),
    [&](const std::string& kind, const ImagePixels* pixels, const std::string& reason) {
      const auto entry = moduleObject(env);
      check(env, napi_set_named_property(env, entry, "kind", string(env, kind)), "cannot set resident kind");
      if (pixels) {
        const auto file = directory / (std::to_string(index) + "-" + kind + ".png");
        writePreparedPng(file, pixels->width, pixels->height, pixels->rgba);
        check(env, napi_set_named_property(env, entry, "file", string(env, file.string())), "cannot set resident file");
        check(env, napi_set_named_property(env, entry, "width", number(env, pixels->width)), "cannot set resident width");
        check(env, napi_set_named_property(env, entry, "height", number(env, pixels->height)), "cannot set resident height");
      } else check(env, napi_set_named_property(env, entry, "unavailable", string(env, reason)), "cannot set resident error");
      check(env, napi_set_element(env, result, index++, entry), "cannot set resident entry");
    });
  if (!valid) throw std::runtime_error("invalid image handle");
  return result;
} catch (const std::exception& error) { return throwException(env, error); }

void registerResourceBindings(napi_env env, napi_value exports) {
  napi_value images = moduleObject(env);
  method(env, images, "load", loadImage);
  method(env, images, "isOpaque", isOpaqueImage);
  method(env, images, "loadAsync", loadImageAsync);
  method(env, images, "loadEncryptedAsync", loadEncryptedImageAsync);
  method(env, images, "acquireCached", acquireCachedImage);
  method(env, images, "loadBytes", loadImageBytes);
  method(env, images, "loadBytesAsync", loadImageBytesAsync);
  method(env, images, "fallbackImage", fallbackImage);
  method(env, images, "release", releaseImage);
  method(env, images, "pin", pinImage);
  method(env, images, "unpin", unpinImage);
  method(env, images, "touch", touchImage);
  method(env, images, "memory", imageMemory);
  method(env, images, "exportResident", exportResidentImage);
  napi_value assets = moduleObject(env);
  method(env, assets, "loadImage", loadAssetImage);
  method(env, assets, "loadImageAsync", loadAssetImageAsync);
  method(env, assets, "readText", readAssetText);
  method(env, assets, "exists", assetExists);
  check(env, napi_set_named_property(env, exports, "images", images), "cannot export images module");
  check(env, napi_set_named_property(env, exports, "assets", assets), "cannot export assets module");
}

namespace {
template <std::size_t N>
std::array<int, N> preparedArray(napi_env env, napi_value object, const char* key) {
  const auto array = property(env, object, key);
  std::uint32_t length = 0;
  check(env, napi_get_array_length(env, array, &length), "invalid prepared image tuple");
  if (length != N) throw std::runtime_error("invalid prepared image tuple length");
  std::array<int, N> result{};
  for (std::size_t i = 0; i < N; ++i) {
    napi_value item;
    check(env, napi_get_element(env, array, i, &item), "invalid prepared image tuple value");
    const auto number = asNumber(env, item);
    if (!std::isfinite(number) || number != std::floor(number) || number < -1 || number > 16384)
      throw std::runtime_error("invalid prepared image integer");
    result[i] = static_cast<int>(number);
  }
  return result;
}
std::array<std::uint8_t, 4> preparedColor(napi_env env, napi_value object, const char* key) {
  const auto values = preparedArray<4>(env, object, key);
  std::array<std::uint8_t, 4> color{};
  for (std::size_t i = 0; i < 4; ++i) {
    if (values[i] < 0 || values[i] > 255) throw std::runtime_error("invalid prepared image color");
    color[i] = values[i];
  }
  return color;
}

napi_value installPreparedAssetsImpl(napi_env env, napi_callback_info info, bool catalog) try {
  const auto args = arguments(env, info, 3);
  const bool capture = !catalog && args.size() > 1 && asBoolean(env, args[1]);
  const bool detailed = args.size() > 2 && asBoolean(env, args[2]);
  PreparationInstallReport report;
  auto& value = host(env);
  std::uint32_t count = 0;
  check(env, napi_get_array_length(env, args.at(0), &count), "prepared entries must be an array");
  if (count > 100000) throw std::runtime_error("too many prepared image entries");
  value.images.clearPreparedIndex();
  std::uint32_t installed = 0;
  std::uint32_t missingSource = 0, changedSource = 0, missingPage = 0, invalidEntry = 0;
  for (std::uint32_t i = 0; i < count; ++i) {
    std::string identifier = std::to_string(i);
    try {
      const auto before = installed;
      napi_value entry; check(env, napi_get_element(env, args[0], i, &entry), "invalid prepared entry");
      const auto sourceName = asString(env, property(env, entry, "source"));
      identifier = sourceName;
      const auto path = value.vfs.resolve(sourceName);
      if (!path) { ++missingSource; report.rejected.emplace_back(identifier, "missing source"); continue; }
      const auto directory = std::filesystem::path(asString(env, property(env, entry, "directory")));
      if (!directory.is_absolute()) throw std::runtime_error("prepared directory must be absolute");
      const auto object = property(env, entry, "descriptor");
      PreparedImageDescriptor descriptor;
      if (hasProperty(env, object, "textureArtifact")) descriptor.textureArtifact = asString(env, property(env, object, "textureArtifact"));
      if (hasProperty(env, object, "framePages"))
        check(env, napi_get_value_bool(env, property(env, object, "framePages"), &descriptor.framePages), "invalid frame pages descriptor");
      descriptor.version = asInt32(env, property(env, object, "version"));
      if (hasProperty(env, object, "compression")) descriptor.compression = asString(env, property(env, object, "compression"));
      descriptor.width = asInt32(env, property(env, object, "width"));
      descriptor.height = asInt32(env, property(env, object, "height"));
      if (hasProperty(env, object, "halo")) descriptor.halo = asInt32(env, property(env, object, "halo"));
      if (hasProperty(env, object, "uniform")) descriptor.uniform = preparedColor(env, object, "uniform");
      if (hasProperty(env, object, "blockGrid")) descriptor.blockGrid = preparedArray<3>(env, object, "blockGrid");
      if (hasProperty(env, object, "blockChannels")) descriptor.blockChannels = asInt32(env, property(env, object, "blockChannels"));
      if (hasProperty(env, object, "compactEligible")) {
        bool eligible = false;
        check(env, napi_get_value_bool(env, property(env, object, "compactEligible"), &eligible), "invalid compact eligibility");
        descriptor.compactEligible = eligible;
      }
      if (hasProperty(env, object, "pages")) {
        const auto pages = property(env, object, "pages"); std::uint32_t size = 0;
        check(env, napi_get_array_length(env, pages, &size), "invalid prepared pages");
        if (size > 10000) throw std::runtime_error("too many prepared pages");
        for (std::uint32_t j = 0; j < size; ++j) {
          napi_value page; check(env, napi_get_element(env, pages, j, &page), "invalid prepared page");
          descriptor.pages.push_back({asString(env, property(env, page, "path")),
            asInt32(env, property(env, page, "width")), asInt32(env, property(env, page, "height"))});
          if (hasProperty(env, page, "storage")) {
            auto storage = property(env, page, "storage");
            ImageStorageDecision known;
            known.width = asInt32(env, property(env, storage, "width"));
            known.height = asInt32(env, property(env, storage, "height"));
            known.channels.channels = asInt32(env, property(env, storage, "channels"));
            if (hasProperty(env, storage, "paletteBits")) {
              const auto bits = asNumber(env, property(env, storage, "paletteBits"));
              if (bits != 0 && bits != 8 && bits != 16)
                throw std::runtime_error("invalid prepared palette width");
              known.paletteBits = static_cast<int>(bits);
            }
            const auto source = preparedArray<4>(env, storage, "source");
            const auto swizzle = preparedArray<4>(env, storage, "swizzle");
            bool valid = known.width == descriptor.pages.back().width && known.height == descriptor.pages.back().height &&
              (known.channels.channels == 1 || known.channels.channels == 2 || known.channels.channels == 4);
            for (int c = 0; c < 4; ++c) {
              valid &= source[c] >= 0 && source[c] < 4 && swizzle[c] >= 0 &&
                (swizzle[c] < known.channels.channels || swizzle[c] == 4 || swizzle[c] == 5);
              known.channels.source[c] = source[c]; known.channels.swizzle[c] = swizzle[c];
            }
            if (valid) descriptor.pages.back().storage = known;
          }
        }
      }
      if (hasProperty(env, object, "cells")) {
        const auto cells = property(env, object, "cells"); std::uint32_t size = 0;
        check(env, napi_get_array_length(env, cells, &size), "invalid prepared cells");
        if (size > 10000) throw std::runtime_error("too many prepared cells");
        for (std::uint32_t j = 0; j < size; ++j) {
          napi_value cell; check(env, napi_get_element(env, cells, j, &cell), "invalid prepared cell");
          PreparedImageCell item;
          item.rect = preparedArray<4>(env, cell, "rect"); item.crop = preparedArray<4>(env, cell, "crop");
          item.fill = preparedColor(env, cell, "fill");
          if (hasProperty(env, cell, "page")) item.page = asInt32(env, property(env, cell, "page"));
          if (hasProperty(env, cell, "atlas")) item.atlas = preparedArray<4>(env, cell, "atlas");
          descriptor.cells.push_back(item);
        }
      }
      const auto identity = asString(env, property(env, entry, "sourceIdentity"));
      std::vector<std::string> identities;
      if (catalog) {
        const auto pages = property(env, entry, "pageIdentities"); std::uint32_t size = 0;
        check(env, napi_get_array_length(env, pages, &size), "invalid page identities");
        if (size != descriptor.pages.size()) throw std::runtime_error("page identity count mismatch");
        for (std::uint32_t j = 0; j < size; ++j) {
          napi_value item; check(env, napi_get_element(env, pages, j, &item), "invalid page identity");
          identities.push_back(asString(env, item));
        }
      }
      const auto backingHash = hasProperty(env, entry, "backingHash") ?
        asString(env, property(env, entry, "backingHash")) : std::string{};
      const auto textureHash = hasProperty(env, entry, "textureHash") ?
        asString(env, property(env, entry, "textureHash")) : std::string{};
      std::vector<std::string> pageHashes;
      const bool hashedPages = hasProperty(env, entry, "pageHashes");
      if (hashedPages) {
        const auto hashes = property(env, entry, "pageHashes"); std::uint32_t size = 0;
        check(env, napi_get_array_length(env, hashes, &size), "invalid page hashes");
        if (size != descriptor.pages.size()) throw std::runtime_error("page hash count mismatch");
        for (std::uint32_t j = 0; j < size; ++j) {
          napi_value item; check(env, napi_get_element(env, hashes, j, &item), "invalid page hash");
          pageHashes.push_back(asString(env, item));
        }
      }
      std::vector<std::string> captured;
      std::vector<std::filesystem::path> pagePaths;
      pagePaths.reserve(descriptor.pages.size());
      for (const auto& page : descriptor.pages) pagePaths.push_back(directory / page.path);
      if (value.images.installPrepared(*path, directory, std::move(descriptor), identity, catalog ? &identities : nullptr, capture ? &captured : nullptr, backingHash, hashedPages ? &pageHashes : nullptr, textureHash)) {
        ++installed;
        if (capture) {
          napi_value list; check(env, napi_create_array_with_length(env, captured.size(), &list), "cannot create identities");
          for (std::size_t j = 0; j < captured.size(); ++j) check(env, napi_set_element(env, list, j, string(env, captured[j])), "cannot set identity");
          check(env, napi_set_named_property(env, entry, "pageIdentities", list), "cannot set page identities");
        }
      } else if (const auto current = Vfs::fileIdentity(*path); current != identity) {
        if (changedSource < 3)
          Log(LogLevel::Warning) << "[pmjs] prepared source identity differs " << sourceName
            << " expected=" << identity << " actual=" << current << '\n';
        ++changedSource;
      } else if (std::any_of(pagePaths.begin(), pagePaths.end(), [](const auto& file) {
        std::error_code error;
        return !std::filesystem::is_regular_file(file, error);
      })) ++missingPage;
      else ++invalidEntry;
      if (installed != before) report.accepted.push_back(identifier);
      else report.rejected.emplace_back(identifier, "source, pages or descriptor rejected");
    } catch (const std::exception& error) {
      report.reject(env, identifier, error.what()); ++invalidEntry;
    }
  }
  if (installed != count)
    Log(LogLevel::Warning) << "[pmjs] prepared install failures missing_source=" << missingSource
      << " changed_source=" << changedSource << " missing_page=" << missingPage
      << " invalid_entry=" << invalidEntry << '\n';
  return detailed ? report.result(env) : number(env, installed);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}
}

napi_value installPreparedAssets(napi_env env, napi_callback_info info) { return installPreparedAssetsImpl(env, info, false); }
napi_value installPreparedCatalog(napi_env env, napi_callback_info info) { return installPreparedAssetsImpl(env, info, true); }

napi_value preparedSourceIdentity(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1);
  const auto path = host(env).vfs.resolve(asString(env, args.at(0)));
  const auto identity = path ? Vfs::fileIdentity(*path) : std::string{};
  return identity.empty() ? null(env) : string(env, identity);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value preparationSourcePath(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1);
  const auto path = host(env).vfs.resolve(asString(env, args.at(0)));
  return path ? string(env, path->string()) : null(env);
} catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }

napi_value installDecryptedAssetsImpl(napi_env env, napi_callback_info info, bool catalog) try {
  const auto args = arguments(env, info, 3);
  const bool capture = !catalog && args.size() > 1 && asBoolean(env, args[1]);
  const bool detailed = args.size() > 2 && asBoolean(env, args[2]);
  PreparationInstallReport report;
  std::uint32_t count = 0;
  check(env, napi_get_array_length(env, args.at(0), &count), "decrypted entries must be an array");
  if (count > 100000) throw std::runtime_error("too many decrypted entries");
  std::vector<Vfs::DerivedFile> entries;
  std::vector<napi_value> records;
  for (std::uint32_t i = 0; i < count; ++i) {
    std::string id = std::to_string(i);
    try {
      napi_value entry; check(env, napi_get_element(env, args[0], i, &entry), "invalid decrypted entry");
      id = asString(env, property(env, entry, "source"));
      entries.push_back({asString(env, property(env, entry, "logicalSource")), id, "data/System.json",
        asString(env, property(env, entry, "file")),
        asString(env, property(env, entry, "sourceIdentity")),
        asString(env, property(env, entry, "settingsIdentity")),
        catalog ? asString(env, property(env, entry, "fileIdentity")) : std::string{},
        hasProperty(env, entry, "sourceHash") ? asString(env, property(env, entry, "sourceHash")) : std::string{},
        hasProperty(env, entry, "settingsHash") ? asString(env, property(env, entry, "settingsHash")) : std::string{},
        hasProperty(env, entry, "fileHash") ? asString(env, property(env, entry, "fileHash")) : std::string{}});
      records.push_back(entry);
    } catch (const std::exception& error) { report.reject(env, id, error.what()); }
  }
  host(env).vfs.installDerivedFiles(entries, catalog, &report.rejected);
  for (std::size_t i = 0; i < entries.size(); ++i) {
    const auto identity = host(env).vfs.derivedIdentity(entries[i].logical);
    bool rejected = false;
    for (const auto& failure : report.rejected) if (failure.first == entries[i].source) rejected = true;
    if (identity.empty() || rejected) continue;
    report.accepted.push_back(entries[i].source);
    if (capture) check(env, napi_set_named_property(env, records[i], "fileIdentity", string(env, identity)), "cannot set file identity");
  }
  return detailed ? report.result(env) : undefined(env);
} catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }

napi_value installDecryptedAssets(napi_env env, napi_callback_info info) { return installDecryptedAssetsImpl(env, info, false); }
napi_value installDerivedCatalog(napi_env env, napi_callback_info info) { return installDecryptedAssetsImpl(env, info, true); }

napi_value hasDecryptedAsset(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info, 1);
  return boolean(env, host(env).vfs.resolveDerived(asString(env, args.at(0))).has_value());
} catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }

void registerPreparedAssetBindings(napi_env env, napi_value exports) {
  method(env, property(env, exports, "assets"), "installPrepared", installPreparedAssets);
  method(env, property(env, exports, "assets"), "installPreparedCatalog", installPreparedCatalog);
  method(env, property(env, exports, "assets"), "installDerivedCatalog", installDerivedCatalog);
  method(env, property(env, exports, "assets"), "sourceIdentity", preparedSourceIdentity);
  method(env, property(env, exports, "assets"), "sourcePath", preparationSourcePath);
  method(env, property(env, exports, "assets"), "installDecrypted", installDecryptedAssets);
  method(env, property(env, exports, "assets"), "hasDecrypted", hasDecryptedAsset);
}

}  // namespace pmjs::addon
