#include "node_addon_internal.hpp"

namespace pmjs::addon {
napi_value loadImage(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 2);
  State& value = host(env);
  auto path = value.vfs.resolve(asString(env, args.at(0)));
  const bool retainCpuPixels = args.size() > 1 && asBoolean(env, args.at(1));
  auto image = path ? value.images.loadPng(*path, retainCpuPixels) : std::nullopt;
  if (!image) throw std::runtime_error("cannot load image");
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
  std::filesystem::path path;
  std::string key;
  bool retainCpuPixels = false;
  std::optional<pmjs::ImagePixels> pixels;
};

void executeImageLoad(napi_env, void* opaque) noexcept {
  auto* load = static_cast<AsyncImageLoad*>(opaque);
  try {
    load->pixels = pmjs::ImageStore::decodeFile(load->path);
  } catch (...) {
    load->pixels = std::nullopt;
  }
}

void completeImageLoad(napi_env env, napi_status status, void* opaque) {
  std::unique_ptr<AsyncImageLoad> load(static_cast<AsyncImageLoad*>(opaque));
  if (state) state->pendingImageLoads.erase(load->key);
  napi_value result;
  if (status == napi_ok && load->pixels) {
    auto installed = state->images.installDecoded(
      load->path, std::move(*load->pixels), load->retainCpuPixels);
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
        napi_delete_async_work(env, load->work);
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
  napi_delete_async_work(env, load->work);
}

napi_value queueImageLoad(napi_env env, const std::filesystem::path& path,
                          bool retainCpuPixels) {
  const std::string key = std::filesystem::weakly_canonical(path).generic_string();
  napi_deferred deferred = nullptr;
  napi_value promise;
  check(env, napi_create_promise(env, &deferred, &promise),
        "cannot create image promise");
  if (auto cached = state->images.acquireCached(path)) {
    if (retainCpuPixels) state->images.retainCpuPixels(cached->handle);
    napi_resolve_deferred(env, deferred,
      imageInfo(env, cached->handle, cached->width, cached->height));
    return promise;
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
  load->path = path;
  load->key = key;
  load->retainCpuPixels = retainCpuPixels;
  load->deferreds.push_back(deferred);
  napi_value name;
  check(env, napi_create_string_utf8(env, "pmjs-image-load", NAPI_AUTO_LENGTH,
                                     &name), "cannot create image work name");
  check(env, napi_create_async_work(env, nullptr, name, executeImageLoad,
                                    completeImageLoad, load.get(), &load->work),
        "cannot create image work");
  state->pendingImageLoads.emplace(key, load.get());
  const auto queued = napi_queue_async_work(env, load->work);
  if (queued != napi_ok) {
    state->pendingImageLoads.erase(key);
    napi_delete_async_work(env, load->work);
    check(env, queued, "cannot queue image work");
  }
  ++state->imageDecodeJobs;
  load.release();
  return promise;
}

napi_value loadImageAsync(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 2);
  State& value = host(env);
  auto path = value.vfs.resolve(asString(env, args.at(0)));
  if (!path) throw std::runtime_error("cannot resolve image");
  return queueImageLoad(env, *path,
    args.size() > 1 && asBoolean(env, args.at(1)));
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
  check(env, napi_set_named_property(env, result, "warmBudgetBytes",
    number(env, images.warmBudgetBytes())), "cannot set image warm budget");
  check(env, napi_set_named_property(env, result, "warmBytes",
    number(env, images.warmBytes())), "cannot set warm image bytes");
  check(env, napi_set_named_property(env, result, "warmCount",
    number(env, images.warmCount())), "cannot set warm image count");
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

}  // namespace pmjs::addon
