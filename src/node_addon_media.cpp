#include "node_addon_internal.hpp"

namespace pmjs::addon {
namespace {
std::vector<std::uint8_t> audioBytes(napi_env env, napi_value value) {
  bool isArrayBuffer = false;
  check(env, napi_is_arraybuffer(env, value, &isArrayBuffer),
        "cannot inspect encoded audio bytes");
  void* data = nullptr;
  std::size_t size = 0;
  if (isArrayBuffer) {
    check(env, napi_get_arraybuffer_info(env, value, &data, &size),
          "cannot read encoded audio ArrayBuffer");
  } else {
    bool isTypedArray = false;
    check(env, napi_is_typedarray(env, value, &isTypedArray),
          "cannot inspect encoded audio bytes");
    if (!isTypedArray) throw std::runtime_error("encoded audio must be an ArrayBuffer or Uint8Array");
    napi_typedarray_type type;
    napi_value arrayBuffer;
    std::size_t offset = 0;
    check(env, napi_get_typedarray_info(env, value, &type, &size, &data,
                                       &arrayBuffer, &offset),
          "cannot read encoded audio Uint8Array");
    if (type != napi_uint8_array && type != napi_uint8_clamped_array) {
      throw std::runtime_error("encoded audio must be an ArrayBuffer or Uint8Array");
    }
  }
  constexpr std::size_t maxEncodedAudioBytes = 64U * 1024U * 1024U;
  if (size == 0 || size > maxEncodedAudioBytes) {
    throw std::runtime_error("encoded audio exceeds the 64 MiB limit or is empty");
  }
  const auto* begin = static_cast<const std::uint8_t*>(data);
  return std::vector<std::uint8_t>(begin, begin + size);
}
}

napi_value loadAudio(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 1); State& value = host(env);
  const auto path = value.vfs.resolve(asString(env, a.at(0)));
  if (!path) throw std::runtime_error("audio path is outside the game root");
  std::string error;
  const auto handle = value.core.media().loadAudio(path->string(), &error);
  if (!handle) throw std::runtime_error(error.empty() ? "audio decode failed" : error);
  napi_value result; napi_create_object(env, &result);
  napi_set_named_property(env, result, "handle", uint32(env, handle));
  napi_set_named_property(env, result, "duration",
    number(env, value.core.media().duration(handle)));
  return result;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value loadAudioBytes(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 1); State& value = host(env);
  std::string error;
  const auto handle = value.core.media().loadAudioBytes(audioBytes(env, a.at(0)), &error);
  if (!handle) throw std::runtime_error(error.empty() ? "audio byte decode failed" : error);
  napi_value result; napi_create_object(env, &result);
  napi_set_named_property(env, result, "handle", uint32(env, handle));
  napi_set_named_property(env, result, "duration",
    number(env, value.core.media().duration(handle)));
  return result;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value playAudio(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 3);
  return boolean(env, host(env).core.media().play(asUint32(env, a.at(0)),
    asBoolean(env, a.at(1)), asNumber(env, a.at(2))));
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value stopAudio(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 1);
  return boolean(env, host(env).core.media().stop(asUint32(env, a.at(0))));
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value setAudioParameters(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 4);
  return boolean(env, host(env).core.media().setParameters(asUint32(env, a.at(0)),
    asNumber(env, a.at(1)), asNumber(env, a.at(2)), asNumber(env, a.at(3))));
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value fadeAudio(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 5);
  return boolean(env, host(env).core.media().fade(asUint32(env, a.at(0)),
    asNumber(env, a.at(1)), asNumber(env, a.at(2)), asNumber(env, a.at(3)),
    asBoolean(env, a.at(4))));
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value audioIsPlaying(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 1);
  return boolean(env, host(env).core.media().isPlaying(asUint32(env, a.at(0))));
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value audioPosition(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 1);
  return number(env, host(env).core.media().position(asUint32(env, a.at(0))));
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value releaseAudio(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 1);
  return boolean(env, host(env).core.media().release(asUint32(env, a.at(0))));
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value setMasterVolume(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 1);
  host(env).core.media().setMasterVolume(static_cast<float>(asNumber(env, a.at(0))));
  return undefined(env);
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value getMasterVolume(napi_env env, napi_callback_info info) try {
  (void)info;
  return number(env, host(env).core.media().masterVolume());
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value loadVideo(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 1); State& value = host(env);
  const auto path = value.vfs.resolve(asString(env, a.at(0)));
  if (!path) throw std::runtime_error("video path is outside the game root");
  std::string error;
  auto decoder = std::make_unique<pmjs::VideoDecoderSession>(*path);
  auto frame = decoder->frame(0.0, &error);
  if (!frame) throw std::runtime_error(error.empty() ? "video decode failed" : error);
  const auto canvas = value.canvases.createRgba(frame->width, frame->height, frame->rgba);
  if (!canvas) throw std::runtime_error("cannot allocate video surface");
  std::uint32_t handle = value.nextVideo++;
  if (!handle) handle = value.nextVideo++;
  const double duration = decoder->info().duration;
  auto video = std::make_unique<State::Video>(std::move(decoder));
  video->canvas = canvas->handle; video->duration = duration;
  video->timestamp = frame->timestamp;
  video->recycle(std::move(frame->rgba));
  value.videos.emplace(handle, std::move(video));
  napi_value result; napi_create_object(env, &result);
  napi_set_named_property(env, result, "handle", uint32(env, handle));
  napi_set_named_property(env, result, "canvas", uint32(env, canvas->handle));
  napi_set_named_property(env, result, "width", number(env, frame->width));
  napi_set_named_property(env, result, "height", number(env, frame->height));
  napi_set_named_property(env, result, "duration", number(env, duration));
  return result;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value updateVideo(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 2); State& value = host(env);
  const auto found = value.videos.find(asUint32(env, a.at(0)));
  if (found == value.videos.end()) throw std::runtime_error("invalid video handle");
  const double timestamp = asNumber(env, a.at(1));
  auto& video = *found->second;
  if (auto frame = video.take()) {
    if (frame->timestamp + 0.1 >= timestamp) {
      if (!value.canvases.writePixels(video.canvas, 0, 0, frame->width,
                                      frame->height, frame->rgba))
        throw std::runtime_error("video surface update failed");
      video.timestamp = frame->timestamp;
    }
    video.recycle(std::move(frame->rgba));
  }
  video.request(timestamp);
  return number(env, video.timestamp);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value releaseVideo(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 1); State& value = host(env);
  const auto found = value.videos.find(asUint32(env, a.at(0)));
  if (found == value.videos.end()) return boolean(env, false);
  value.canvases.release(found->second->canvas);
  value.videos.erase(found);
  return boolean(env, true);
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}


void registerMediaBindings(napi_env env, napi_value exports) {
  napi_value media = moduleObject(env);
  method(env, media, "loadAudio", loadAudio);
  method(env, media, "loadAudioBytes", loadAudioBytes);
  method(env, media, "playAudio", playAudio);
  method(env, media, "stopAudio", stopAudio);
  method(env, media, "setAudioParameters", setAudioParameters);
  method(env, media, "fadeAudio", fadeAudio);
  method(env, media, "audioIsPlaying", audioIsPlaying);
  method(env, media, "audioPosition", audioPosition);
  method(env, media, "releaseAudio", releaseAudio);
  method(env, media, "setMasterVolume", setMasterVolume);
  method(env, media, "getMasterVolume", getMasterVolume);
  method(env, media, "loadVideo", loadVideo);
  method(env, media, "updateVideo", updateVideo);
  method(env, media, "releaseVideo", releaseVideo);
  check(env, napi_set_named_property(env, exports, "media", media), "cannot export media module");
}

}  // namespace pmjs::addon
