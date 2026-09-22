#include "node_addon_internal.hpp"

namespace pmjs::addon {
namespace {
using Clock = std::chrono::steady_clock;

void reportVideo(State::Video& video, double requestedPts) {
  if (!video.telemetryEnabled) return;
  const auto now = Clock::now();
  const double interval = std::chrono::duration<double>(now - video.reportStarted).count();
  if (interval < 1.0) return;
  const auto decode = video.workerStats();
  const auto requests = video.requests - video.reportedRequests;
  const auto uploaded = video.uploadedFrames - video.reportedUploadedFrames;
  const auto repeated = video.repeatedFrames - video.reportedRepeatedFrames;
  const auto late = video.lateFrames - video.reportedLateFrames;
  const auto staleReadyDrops = video.staleReadyDrops - video.reportedStaleReadyDrops;
  const auto bytes = video.uploadBytes - video.reportedUploadBytes;
  const auto workerJobsTotal = video.jobsStarted();
  const auto coalescedTotal = video.coalescedRequests();
  const double uploadMs = video.textureUploadMs - video.reportedUploadMs;
  const double workerWaitTotal = video.workerQueueMs();
  const double workerWaitMs = workerWaitTotal - video.reportedWorkerWaitMs;
  const double readyWaitMs = video.readyWaitMs - video.reportedReadyWaitMs;
  std::cerr << "[pmjs-video] {\"path\":\"image\",\"sourceFps\":" << video.sourceFps
    << ",\"requested\":" << requests
    << ",\"decoded\":" << (decode.decodedFrames - video.reportedDecodeStats.decodedFrames)
    << ",\"skipped\":" << (decode.skippedFrames - video.reportedDecodeStats.skippedFrames)
    << ",\"converted\":" << (decode.convertedFrames - video.reportedDecodeStats.convertedFrames)
    << ",\"seeks\":" << (decode.seeks - video.reportedDecodeStats.seeks)
    << ",\"backwardSeeks\":" << (decode.backwardSeeks - video.reportedDecodeStats.backwardSeeks)
    << ",\"decodedAfterSeek\":" << (decode.decodedAfterSeek - video.reportedDecodeStats.decodedAfterSeek)
    << ",\"noNewFrameDue\":" << (decode.noNewFrameDue - video.reportedDecodeStats.noNewFrameDue)
    << ",\"prefetched\":" << (decode.prefetchedFrames - video.reportedDecodeStats.prefetchedFrames)
    << ",\"rawQueued\":" << video.queuedRawFrames()
    << ",\"rawQueueMax\":" << decode.maxQueuedFrames
    << ",\"workerJobs\":" << (workerJobsTotal - video.reportedWorkerJobs)
    << ",\"requestsCoalesced\":" << (coalescedTotal - video.reportedCoalescedRequests)
    << ",\"uploaded\":" << uploaded << ",\"repeated\":" << repeated
    << ",\"lateUploaded\":" << late
    << ",\"staleReadyDrops\":" << staleReadyDrops
    << ",\"requestedPts\":" << requestedPts
    << ",\"readyPts\":" << video.timestamp
    << ",\"lagMs\":" << std::max(0.0, (requestedPts - video.timestamp) * 1000.0)
    << ",\"decodeMs\":" << (decode.decodeMs - video.reportedDecodeStats.decodeMs)
    << ",\"convertMs\":" << (decode.convertMs - video.reportedDecodeStats.convertMs)
    << ",\"workerWaitMs\":" << workerWaitMs
    << ",\"readyWaitMs\":" << readyWaitMs
    << ",\"uploadMs\":" << uploadMs
    << ",\"uploadMiB\":" << (static_cast<double>(bytes) / (1024.0 * 1024.0))
    << "}\n";
  video.reportStarted = now; video.reportedDecodeStats = decode;
  video.reportedRequests = video.requests;
  video.reportedUploadedFrames = video.uploadedFrames;
  video.reportedRepeatedFrames = video.repeatedFrames;
  video.reportedLateFrames = video.lateFrames;
  video.reportedStaleReadyDrops = video.staleReadyDrops;
  video.reportedUploadBytes = video.uploadBytes;
  video.reportedWorkerJobs = workerJobsTotal;
  video.reportedCoalescedRequests = coalescedTotal;
  video.reportedUploadMs = video.textureUploadMs;
  video.reportedWorkerWaitMs = workerWaitTotal;
  video.reportedReadyWaitMs = video.readyWaitMs;
}

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

napi_value loadVideo(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 1); State& value = host(env);
  const auto path = value.vfs.resolve(asString(env, a.at(0)));
  if (!path) throw std::runtime_error("video path is outside the game root");
  std::string error;
  auto decoder = std::make_unique<pmjs::VideoDecoderSession>(*path);
  auto frame = decoder->frame(0.0, &error);
  if (!frame) throw std::runtime_error(error.empty() ? "video decode failed" : error);
  const auto image = value.images.createRgba(frame->width, frame->height,
                                              frame->rgba.data());
  if (!image) throw std::runtime_error("cannot allocate video texture");
  std::uint32_t handle = value.nextVideo++;
  if (!handle) handle = value.nextVideo++;
  const double duration = decoder->info().duration;
  const double sourceFps = decoder->info().videoFrameRate;
  auto video = std::make_unique<State::Video>(std::move(decoder));
  video->image = image->handle;
  video->telemetryEnabled = std::getenv("PMJS_VIDEO_TELEMETRY") &&
    std::string(std::getenv("PMJS_VIDEO_TELEMETRY")) == "1";
  video->duration = duration; video->sourceFps = sourceFps;
  video->timestamp = frame->timestamp;
  video->recycle(std::move(frame->rgba));
  value.videos.emplace(handle, std::move(video));
  napi_value result; napi_create_object(env, &result);
  napi_set_named_property(env, result, "handle", uint32(env, handle));
  napi_set_named_property(env, result, "image", uint32(env, image->handle));
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
  if (video.lastRequestedTimestamp >= 0.0 &&
      (timestamp + 0.000001 < video.lastRequestedTimestamp ||
       timestamp > video.lastRequestedTimestamp + 2.0)) {
    video.resetForSeek();
    video.timestamp = -1.0;
  }
  video.lastRequestedTimestamp = timestamp;
  ++video.requests;
  if (auto frame = video.take()) {
    if (frame->timestamp > video.timestamp + 0.000001) {
      if (frame->timestamp + 0.1 < timestamp) ++video.lateFrames;
      const auto started = Clock::now();
      if (!value.images.updateRgba(video.image, frame->rgba.data()))
        throw std::runtime_error("video texture update failed");
      video.textureUploadMs += std::chrono::duration<double, std::milli>(
        Clock::now() - started).count();
      ++video.uploadedFrames;
      video.uploadBytes += static_cast<std::uint64_t>(frame->width) * frame->height * 4U;
      video.timestamp = frame->timestamp;
    } else ++video.staleReadyDrops;
    video.recycle(std::move(frame->rgba));
  } else ++video.repeatedFrames;
  video.request(timestamp);
  reportVideo(video, timestamp);
  return number(env, video.timestamp);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value releaseVideo(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 1); State& value = host(env);
  const auto found = value.videos.find(asUint32(env, a.at(0)));
  if (found == value.videos.end()) return boolean(env, false);
  value.images.release(found->second->image);
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
  method(env, media, "loadVideo", loadVideo);
  method(env, media, "updateVideo", updateVideo);
  method(env, media, "releaseVideo", releaseVideo);
  check(env, napi_set_named_property(env, exports, "media", media), "cannot export media module");
}

}  // namespace pmjs::addon
