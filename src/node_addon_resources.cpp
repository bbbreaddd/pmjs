#include "node_addon_internal.hpp"
#include <cmath>

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

void completeImageMemoryLoad(napi_env env, napi_status status, void* opaque) {
  std::unique_ptr<AsyncImageMemoryLoad> load(static_cast<AsyncImageMemoryLoad*>(opaque));
  napi_value result;
  if (status == napi_ok && load->pixels) {
    auto installed = state->images.installDecodedMemory(
      std::move(*load->pixels), load->retainCpuPixels);
    if (installed) {
      napi_resolve_deferred(env, load->deferred,
        imageInfo(env, installed->handle, installed->width, installed->height));
      napi_delete_async_work(env, load->work);
      return;
    }
  }
  napi_value message;
  napi_create_string_utf8(env, "cannot decode image bytes", NAPI_AUTO_LENGTH, &message);
  napi_create_error(env, nullptr, message, &result);
  napi_reject_deferred(env, load->deferred, result);
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
      if (pmjs::ImageStore::validatePrepared(*load->prepared, load->prepareCpuPixels)) return;
    } catch (...) {
      // Invalid prepared backing still permits decoding the captured source.
    }
    load->tileValidationFailed = !load->tileSet.empty();
    load->prepared.reset();
  }
  try {
    load->pixels = pmjs::ImageStore::decodeFile(load->fallbackSource ? *load->fallbackSource : *load->source);
  } catch (...) {
    load->pixels = std::nullopt;
  }
}

void completeImageLoad(napi_env env, napi_status status, void* opaque) {
  std::unique_ptr<AsyncImageLoad> load(static_cast<AsyncImageLoad*>(opaque));
  napi_delete_async_work(env, load->work);
  load->work = nullptr;
  // A caller may request CPU pixels after validation has already finished.
  if (status == napi_ok && load->prepared && load->retainCpuPixels && !load->prepareCpuPixels) {
    load->prepareCpuPixels = true;
    if (queueImageWork(env, *load) == napi_ok) {
      load.release();
      return;
    }
    status = napi_generic_failure;
  }
  if (state) {
    state->pendingImageLoads.erase(load->key);
    if (load->tileValidationFailed) state->images.noteTileLoadFallback();
  }
  napi_value result;
  if (status == napi_ok && (load->prepared || load->pixels)) {
    const bool preparedAttempt = static_cast<bool>(load->prepared);
    auto installed = load->prepared ? state->images.installPreparedLoad(
      *load->source, std::move(load->prepared), load->retainCpuPixels) :
      state->images.installDecoded(*load->source, std::move(*load->pixels), load->retainCpuPixels);
    if (!installed && preparedAttempt) {
      // No logical view was published. Decode the captured ordinary source on
      // the worker, retaining every pending caller and leaving existing owners valid.
      load->prepared.reset();
      state->pendingImageLoads[load->key] = load.get();
      if (queueImageWork(env, *load) == napi_ok) { load.release(); return; }
      state->pendingImageLoads.erase(load->key);
    }
    if (installed) {
      bool retained = true;
      std::size_t ownerships = 1;
      for (std::size_t index = 1; index < load->deferreds.size(); ++index) {
        if (!state->images.retain(installed->handle)) {
          retained = false;
          break;
        }
        ++ownerships;
      }
      if (retained) {
        for (const auto deferred : load->deferreds) {
          // Each retained native ownership needs its own JS wrapper. Sharing a
          // wrapper also shares its FinalizationRegistry unregister token, so
          // one explicit release can otherwise orphan the other ownerships.
          napi_resolve_deferred(env, deferred,
            imageInfo(env, installed->handle, installed->width,
                      installed->height));
        }
        return;
      }
      while (ownerships > 0) {
        --ownerships;
        state->images.release(installed->handle);
      }
    }
  }
  napi_value message;
  napi_create_string_utf8(env, "cannot load image", NAPI_AUTO_LENGTH, &message);
  napi_create_error(env, nullptr, message, &result);
  for (const auto deferred : load->deferreds) {
    napi_reject_deferred(env, deferred, result);
  }
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
                          bool retainCpuPixels, const std::string& requestedTileSet = {}) {
  auto source = pmjs::ImageStore::openFile(path);
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
  if (load->prepared) load->fallbackSource = pmjs::ImageStore::capturePreparedFallback(*load->prepared);
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
  napi_value result;
  check(env, napi_create_object(env, &result), "cannot create image memory state");
  check(env, napi_set_named_property(env, result, "liveCount",
    number(env, images.liveCount())), "cannot set live image count");
  check(env, napi_set_named_property(env, result, "gpuBytes",
    number(env, images.gpuBytes())), "cannot set image GPU bytes");
  check(env, napi_set_named_property(env, result, "peakGpuBytes",
    number(env, images.peakGpuBytes())), "cannot set peak image GPU bytes");
  check(env, napi_set_named_property(env, result, "cpuBytes",
    number(env, images.cpuBytes())), "cannot set image CPU bytes");
  check(env, napi_set_named_property(env, result, "tileMetadataBytes",
    number(env, images.tileMetadataBytes())), "cannot set tile metadata bytes");
  check(env, napi_set_named_property(env, result, "warmBudgetBytes",
    number(env, images.warmBudgetBytes())), "cannot set image warm budget");
  check(env, napi_set_named_property(env, result, "warmBytes",
    number(env, images.warmBytes())), "cannot set warm image bytes");
  check(env, napi_set_named_property(env, result, "warmCount",
    number(env, images.warmCount())), "cannot set warm image count");
  check(env, napi_set_named_property(env, result, "warmFileCount",
    number(env, images.warmFileCount())), "cannot set warm file count");
  check(env, napi_set_named_property(env, result, "warmEntryLimit",
    number(env, pmjs::ImageStore::warmEntryLimit)), "cannot set warm entry limit");
  check(env, napi_set_named_property(env, result, "warmFileLimit",
    number(env, pmjs::ImageStore::warmFileLimit)), "cannot set warm file limit");
  check(env, napi_set_named_property(env, result, "pinnedBytes",
    number(env, images.pinnedBytes())), "cannot set pinned image bytes");
  check(env, napi_set_named_property(env, result, "pinnedCount",
    number(env, images.pinnedCount())), "cannot set pinned image count");
  check(env, napi_set_named_property(env, result, "cacheHits",
    number(env, images.cacheHits())), "cannot set image cache hits");
  check(env, napi_set_named_property(env, result, "warmHits",
    number(env, images.warmHits())), "cannot set warm image hits");
  check(env, napi_set_named_property(env, result, "budgetEvictions",
    number(env, images.budgetEvictions())), "cannot set image budget evictions");
  check(env, napi_set_named_property(env, result, "textureCreates",
    number(env, images.textureCreates())), "cannot set texture creates");
  check(env, napi_set_named_property(env, result, "textureFullUpdates",
    number(env, images.textureFullUpdates())), "cannot set texture full updates");
  check(env, napi_set_named_property(env, result, "textureRegionUpdates",
    number(env, images.textureRegionUpdates())), "cannot set texture region updates");
  check(env, napi_set_named_property(env, result, "textureUploadBytes",
    number(env, images.textureUploadBytes())), "cannot set texture upload bytes");
  check(env, napi_set_named_property(env, result, "pendingDecodeJobs",
    number(env, value.pendingImageLoads.size())), "cannot set pending image jobs");
  check(env, napi_set_named_property(env, result, "decodeJobs",
    number(env, value.imageDecodeJobs)), "cannot set image decode jobs");
  check(env, napi_set_named_property(env, result, "coalescedRequests",
    number(env, value.imageDecodeRequestsCoalesced)),
    "cannot set coalesced image requests");
  check(env, napi_set_named_property(env, result, "fallbackHandle",
    uint32(env, images.fallbackHandle())), "cannot set fallback handle");
  check(env, napi_set_named_property(env, result, "fallbackReferences",
    number(env, images.fallbackReferences())), "cannot set fallback references");
  check(env, napi_set_named_property(env, result, "fallbackUses",
    number(env, images.fallbackUses())), "cannot set fallback uses");
  napi_set_named_property(env, result, "tileHits", number(env, images.tileHits()));
  napi_set_named_property(env, result, "tileRegions", number(env, images.tileRegions()));
  napi_set_named_property(env, result, "tileMaterializations", number(env, images.tileMaterializations()));
  napi_set_named_property(env, result, "tilePageDecodes", number(env, images.tilePageDecodes()));
  napi_set_named_property(env, result, "tilePageUploads", number(env, images.tilePageUploads()));
  auto tileRegionSets = moduleObject(env);
  for (const auto& [identity, count] : images.tileRegionSets()) napi_set_named_property(env, tileRegionSets, identity.c_str(), number(env, count));
  napi_set_named_property(env, result, "tileRegionSets", tileRegionSets);
  auto tileFallbacks = moduleObject(env);
  for (const auto& [reason, count] : images.tileFallbacks()) napi_set_named_property(env, tileFallbacks, reason.c_str(), number(env, count));
  napi_set_named_property(env, result, "tileFallbacks", tileFallbacks);
  napi_set_named_property(env, result, "preparedHits", number(env, images.preparedHits()));
  napi_set_named_property(env, result, "preparedRegions", number(env, images.preparedRegions()));
  napi_set_named_property(env, result, "preparedMaterializations", number(env, images.preparedMaterializations()));
  napi_set_named_property(env, result, "preparedRegionReads", number(env, images.preparedRegionReads()));
  napi_value preparedFallbacks;
  check(env, napi_create_object(env, &preparedFallbacks), "cannot create prepared fallback counts");
  for (const auto& [reason, count] : images.preparedFallbacks())
    napi_set_named_property(env, preparedFallbacks, reason.c_str(), number(env, count));
  napi_set_named_property(env, result, "preparedFallbacks", preparedFallbacks);
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
    napi_set_named_property(env, item, "handle", uint32(env, entry.handle));
    napi_set_named_property(env, item, "path", string(env, path));
    napi_set_named_property(env, item, "width", number(env, entry.width));
    napi_set_named_property(env, item, "height", number(env, entry.height));
    napi_set_named_property(env, item, "references", number(env, entry.references));
    napi_set_named_property(env, item, "inFlight", number(env, entry.inFlight));
    napi_set_named_property(env, item, "pins", number(env, entry.pins));
    napi_set_named_property(env, item, "gpuBytes", number(env, entry.gpuBytes));
    napi_set_named_property(env, item, "cpuBytes", number(env, entry.cpuBytes));
    napi_set_named_property(env, item, "lastUsedSerial",
      number(env, entry.lastUsedSerial));
    napi_set_named_property(env, item, "warm", boolean(env, entry.warm));
    check(env, napi_set_element(env, largest, index, item),
          "cannot append image memory entry");
  }
  check(env, napi_set_named_property(env, result, "largest", largest),
        "cannot set image memory list");
  syncExternalMemory(env);
  return result;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what());
  return nullptr;
}


void registerResourceBindings(napi_env env, napi_value exports) {
  napi_value images = moduleObject(env);
  method(env, images, "load", loadImage);
  method(env, images, "loadAsync", loadImageAsync);
  method(env, images, "loadBytes", loadImageBytes);
  method(env, images, "loadBytesAsync", loadImageBytesAsync);
  method(env, images, "fallbackImage", fallbackImage);
  method(env, images, "release", releaseImage);
  method(env, images, "pin", pinImage);
  method(env, images, "unpin", unpinImage);
  method(env, images, "touch", touchImage);
  method(env, images, "memory", imageMemory);
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
    if (!std::isfinite(number) || number != std::floor(number) || number < -1 || number > 8192)
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
  const auto args = arguments(env, info, 2);
  const bool capture = !catalog && args.size() > 1 && asBoolean(env, args[1]);
  auto& value = host(env);
  std::uint32_t count = 0;
  check(env, napi_get_array_length(env, args.at(0), &count), "prepared entries must be an array");
  if (count > 100000) throw std::runtime_error("too many prepared image entries");
  value.images.clearPreparedIndex();
  std::uint32_t installed = 0;
  for (std::uint32_t i = 0; i < count; ++i) {
    napi_value entry; check(env, napi_get_element(env, args[0], i, &entry), "invalid prepared entry");
    const auto path = value.vfs.resolve(asString(env, property(env, entry, "source")));
    if (!path) continue;
    const auto directory = std::filesystem::path(asString(env, property(env, entry, "directory")));
    if (!directory.is_absolute()) throw std::runtime_error("prepared directory must be absolute");
    const auto object = property(env, entry, "descriptor");
    PreparedImageDescriptor descriptor;
    descriptor.version = asInt32(env, property(env, object, "version"));
    descriptor.width = asInt32(env, property(env, object, "width"));
    descriptor.height = asInt32(env, property(env, object, "height"));
    if (hasProperty(env, object, "halo")) descriptor.halo = asInt32(env, property(env, object, "halo"));
    if (hasProperty(env, object, "uniform")) descriptor.uniform = preparedColor(env, object, "uniform");
    if (hasProperty(env, object, "pages")) {
      const auto pages = property(env, object, "pages"); std::uint32_t size = 0;
      check(env, napi_get_array_length(env, pages, &size), "invalid prepared pages");
      if (size > 10000) throw std::runtime_error("too many prepared pages");
      for (std::uint32_t j = 0; j < size; ++j) {
        napi_value page; check(env, napi_get_element(env, pages, j, &page), "invalid prepared page");
        descriptor.pages.push_back({asString(env, property(env, page, "path")),
          asInt32(env, property(env, page, "width")), asInt32(env, property(env, page, "height"))});
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
    std::vector<std::string> captured;
    if (value.images.installPrepared(*path, directory, std::move(descriptor), identity, catalog ? &identities : nullptr, capture ? &captured : nullptr)) {
      ++installed;
      if (capture) {
        napi_value list; check(env, napi_create_array_with_length(env, captured.size(), &list), "cannot create identities");
        for (std::size_t j = 0; j < captured.size(); ++j) check(env, napi_set_element(env, list, j, string(env, captured[j])), "cannot set identity");
        check(env, napi_set_named_property(env, entry, "pageIdentities", list), "cannot set page identities");
      }
    }
  }
  return number(env, installed);
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
  const auto args = arguments(env, info, 2);
  const bool capture = !catalog && args.size() > 1 && asBoolean(env, args[1]);
  std::uint32_t count = 0;
  check(env, napi_get_array_length(env, args.at(0), &count), "decrypted entries must be an array");
  if (count > 100000) throw std::runtime_error("too many decrypted entries");
  std::vector<Vfs::DerivedFile> entries;
  for (std::uint32_t i = 0; i < count; ++i) {
    napi_value entry; check(env, napi_get_element(env, args[0], i, &entry), "invalid decrypted entry");
    entries.push_back({asString(env, property(env, entry, "logicalSource")),
      asString(env, property(env, entry, "source")), "data/System.json",
      asString(env, property(env, entry, "file")),
      asString(env, property(env, entry, "sourceIdentity")),
      asString(env, property(env, entry, "settingsIdentity")),
      catalog ? asString(env, property(env, entry, "fileIdentity")) : std::string{}});
  }
  host(env).vfs.installDerivedFiles(entries, catalog);
  if (capture) for (std::uint32_t i = 0; i < count; ++i) {
    napi_value entry; check(env, napi_get_element(env, args[0], i, &entry), "invalid decrypted entry");
    check(env, napi_set_named_property(env, entry, "fileIdentity", string(env, host(env).vfs.derivedIdentity(entries[i].logical))), "cannot set file identity");
  }
  return undefined(env);
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
