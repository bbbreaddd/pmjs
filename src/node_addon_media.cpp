#include "node_addon_internal.hpp"
#include "node_addon_video.hpp"

namespace pmjs::addon {
namespace {
using Clock = std::chrono::steady_clock;

bool browserVideoColor(napi_env env, const std::vector<napi_value>& args) {
  if (args.size() < 2) return false;
  const auto profile = asString(env, args[1]);
  if (profile == "ffmpeg") return false;
  if (profile == "chromium65") return true;
  throw std::runtime_error("unknown video color profile: " + profile);
}

bool videoTelemetryEnabled() {
  const char* enabled = std::getenv("PMJS_VIDEO_TELEMETRY");
  return enabled && std::string(enabled) == "1";
}

void reportVideo(Video& video, double requestedPts) {
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

struct AsyncVideoLoad {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::filesystem::path path;
  bool browserColor = false;
  const bool telemetryEnabled = videoTelemetryEnabled();
  Clock::time_point queuedAt = telemetryEnabled ? Clock::now() : Clock::time_point{};
  std::unique_ptr<pmjs::VideoDecoderSession> video;
  std::unique_ptr<pmjs::AudioDecoderSession> audio;
  std::optional<pmjs::VideoFrame> firstFrame;
  std::string error;
  double videoOpenMs = 0;
  double firstFrameMs = 0;
  double audioOpenMs = 0;
  double workerMs = 0;
};

void executeVideoLoad(napi_env, void* opaque) noexcept {
  auto* load = static_cast<AsyncVideoLoad*>(opaque);
  const auto workerStartedAt = load->telemetryEnabled ? Clock::now() : Clock::time_point{};
  try {
    auto phaseStartedAt = load->telemetryEnabled ? Clock::now() : Clock::time_point{};
    load->video = std::make_unique<pmjs::VideoDecoderSession>(load->path, load->telemetryEnabled, load->browserColor);
    if (load->telemetryEnabled) {
      load->videoOpenMs = std::chrono::duration<double, std::milli>(
        Clock::now() - phaseStartedAt).count();
      phaseStartedAt = Clock::now();
    }
    load->firstFrame = load->video->frame(0.0, &load->error);
    if (load->telemetryEnabled) load->firstFrameMs = std::chrono::duration<double, std::milli>(
      Clock::now() - phaseStartedAt).count();
    if (!load->firstFrame) {
      if (load->error.empty()) load->error = "video has no decodable first frame";
      load->video.reset();
      if (load->telemetryEnabled) load->workerMs = std::chrono::duration<double, std::milli>(
        Clock::now() - workerStartedAt).count();
      return;
    }
    if (load->telemetryEnabled) phaseStartedAt = Clock::now();
    try {
      load->audio = std::make_unique<pmjs::AudioDecoderSession>(load->path);
    } catch (...) {
    }
    if (load->telemetryEnabled) load->audioOpenMs = std::chrono::duration<double, std::milli>(
      Clock::now() - phaseStartedAt).count();
  } catch (const std::exception& error) {
    load->error = error.what();
  } catch (...) {
    load->error = "video load failed";
  }
  if (load->telemetryEnabled) load->workerMs = std::chrono::duration<double, std::milli>(
    Clock::now() - workerStartedAt).count();
}

void reportVideoLoad(const AsyncVideoLoad& load, double installMs,
                     bool success) {
  if (!load.telemetryEnabled) return;
  const double totalMs = std::chrono::duration<double, std::milli>(
    std::chrono::steady_clock::now() - load.queuedAt).count();
  std::cerr << "[pmjs-video-load] {\"success\":"
    << (success ? "true" : "false")
    << ",\"totalMs\":" << totalMs
    << ",\"videoOpenMs\":" << load.videoOpenMs
    << ",\"firstFrameMs\":" << load.firstFrameMs
    << ",\"audioOpenMs\":" << load.audioOpenMs
    << ",\"workerMs\":" << load.workerMs
    << ",\"mainThreadInstallMs\":" << installMs << "}\n";
}

void completeVideoLoad(napi_env env, napi_status status, void* opaque) {
  std::unique_ptr<AsyncVideoLoad> load(static_cast<AsyncVideoLoad*>(opaque));
  const auto completionStartedAt = load->telemetryEnabled ? Clock::now() : Clock::time_point{};
  const auto reportInstallTime = [&load, completionStartedAt](bool success) {
    if (!load->telemetryEnabled) return;
    reportVideoLoad(*load, std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now() - completionStartedAt).count(), success);
  };
  auto reject = [&](const char* fallback) {
    napi_value message;
    napi_value error;
    const std::string& text = load->error.empty() ? std::string(fallback) : load->error;
    napi_create_string_utf8(env, text.c_str(), text.size(), &message);
    napi_create_error(env, nullptr, message, &error);
    napi_reject_deferred(env, load->deferred, error);
  };
  if (status != napi_ok || !load->video || !load->firstFrame) {
    reportInstallTime(false);
    reject("video load was cancelled");
    napi_delete_async_work(env, load->work);
    return;
  }

  State* value = state.get();
  pmjs::ImageHandle imageHandle = 0;
  std::uint32_t videoHandle = 0;
  std::uint32_t audioHandle = 0;
  bool videoStored = false;
  try {
    if (!value) throw std::runtime_error("native host is not initialized");
    const auto image = value->images.createRgba(load->firstFrame->width,
        load->firstFrame->height, load->firstFrame->rgba.data());
    if (!image) throw std::runtime_error("cannot allocate video texture");
    imageHandle = image->handle;
    auto video = std::make_unique<Video>(std::move(load->video), load->telemetryEnabled);
    video->image = image->handle;
    video->duration = video->info().duration;
    video->sourceFps = video->info().videoFrameRate;
    video->timestamp = load->firstFrame->timestamp;
    video->browser420 = std::move(load->firstFrame->browser420);
    video->recycle(std::move(load->firstFrame->rgba));
    videoHandle = value->nextVideo++;
    if (!videoHandle) videoHandle = value->nextVideo++;
    value->videos.emplace(videoHandle, std::move(video));
    videoStored = true;
    audioHandle = load->audio
      ? value->core.media().installAudioDecoder(std::move(load->audio)) : 0;

    napi_value result;
    napi_create_object(env, &result);
    napi_set_named_property(env, result, "handle", uint32(env, videoHandle));
    napi_set_named_property(env, result, "image", uint32(env, image->handle));
    napi_set_named_property(env, result, "width", number(env, image->width));
    napi_set_named_property(env, result, "height", number(env, image->height));
    napi_set_named_property(env, result, "duration",
      number(env, value->videos.at(videoHandle)->duration));
    napi_set_named_property(env, result, "audio",
      audioHandle ? uint32(env, audioHandle) : null(env));
    napi_resolve_deferred(env, load->deferred, result);
    syncExternalMemory(env);
    reportInstallTime(true);
  } catch (const std::exception& error) {
    load->error = error.what();
    if (value) {
      if (audioHandle) value->core.media().release(audioHandle);
      if (videoStored) value->videos.erase(videoHandle);
      if (imageHandle) value->images.release(imageHandle);
    }
    reportInstallTime(false);
    reject("video load failed");
  }
  napi_delete_async_work(env, load->work);
}
}

AudioLoadOptions audioLoadOptions(napi_env env, State& value, napi_value object) {
  AudioLoadOptions options;
  napi_valuetype type;
  check(env, napi_typeof(env, object, &type), "cannot inspect audio options");
  if (type == napi_undefined) return options;
  if (type != napi_object) throw std::runtime_error("audio options must be an object");
  auto field = [&](const char* name) -> std::optional<std::string> {
    bool exists = false;
    check(env, napi_has_named_property(env, object, name, &exists), "cannot inspect audio option");
    if (!exists) return std::nullopt;
    napi_value member;
    check(env, napi_get_named_property(env, object, name, &member), "cannot read audio option");
    return asString(env, member);
  };
  if (auto intent = field("intent")) {
    if (*intent == "effect") options.intent = AudioIntent::effect;
    else if (*intent == "music") options.intent = AudioIntent::music;
    else if (*intent == "ambient") options.intent = AudioIntent::ambient;
    else if (*intent == "jingle") options.intent = AudioIntent::jingle;
    else if (*intent != "unknown") throw std::runtime_error("invalid audio intent");
  }
  if (auto identity = field("resourceIdentity")) options.resourceIdentity = *identity;
  if (auto path = field("resourcePath")) {
    auto resolved = value.vfs.resolve(*path);
    if (!resolved) throw std::runtime_error("audio resource path is unavailable");
    options.sourcePath = *resolved;
  }
  return options;
}

napi_value loadAudio(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 2); State& value = host(env);
  const auto path = value.vfs.resolve(asString(env, a.at(0)));
  if (!path) throw std::runtime_error("audio path is outside the game root");
  const auto options = a.size() > 1 ? audioLoadOptions(env, value, a[1]) : AudioLoadOptions{};
  std::string error;
  const auto handle = value.core.media().loadAudio(path->string(), &error, options);
  if (!handle) throw std::runtime_error(error.empty() ? "audio decode failed" : error);
  syncExternalMemory(env);
  napi_value result; napi_create_object(env, &result);
  napi_set_named_property(env, result, "handle", uint32(env, handle));
  napi_set_named_property(env, result, "duration",
    number(env, value.core.media().duration(handle)));
  return result;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value loadVideoAsync(napi_env env, napi_callback_info info) try {
  auto args = arguments(env, info, 2);
  State& value = host(env);
  const auto path = value.vfs.resolve(asString(env, args.at(0)));
  if (!path) throw std::runtime_error("video path is outside the game root");
  auto load = std::make_unique<AsyncVideoLoad>();
  load->path = *path;
  load->browserColor = browserVideoColor(env, args);
  napi_value promise;
  check(env, napi_create_promise(env, &load->deferred, &promise),
        "cannot create video load promise");
  napi_value name;
  check(env, napi_create_string_utf8(env, "pmjs-video-load", NAPI_AUTO_LENGTH,
                                     &name), "cannot create video work name");
  check(env, napi_create_async_work(env, nullptr, name, executeVideoLoad,
      completeVideoLoad, load.get(), &load->work), "cannot create video work");
  const auto queued = napi_queue_async_work(env, load->work);
  if (queued != napi_ok) {
    napi_delete_async_work(env, load->work);
    check(env, queued, "cannot queue video work");
  }
  load.release();
  return promise;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value loadAudioBytes(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 2); State& value = host(env);
  const auto options = a.size() > 1 ? audioLoadOptions(env, value, a[1]) : AudioLoadOptions{};
  std::string error;
  const auto handle = value.core.media().loadAudioBytes(audioBytes(env, a.at(0)), &error, options);
  if (!handle) throw std::runtime_error(error.empty() ? "audio byte decode failed" : error);
  syncExternalMemory(env);
  napi_value result; napi_create_object(env, &result);
  napi_set_named_property(env, result, "handle", uint32(env, handle));
  napi_set_named_property(env, result, "duration",
    number(env, value.core.media().duration(handle)));
  return result;
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value audioStats(napi_env env, napi_callback_info) try {
  const auto stats = host(env).core.media().audioCacheStats();
  napi_value result;
  check(env, napi_create_object(env, &result), "cannot create audio stats");
#define AUDIO_STAT(name) check(env, napi_set_named_property(env, result, #name, \
  number(env, static_cast<double>(stats.name))), "cannot set audio " #name)
  AUDIO_STAT(hits); AUDIO_STAT(misses); AUDIO_STAT(cacheBytes); AUDIO_STAT(livePcmBytes);
  AUDIO_STAT(entries); AUDIO_STAT(sampleVoices); AUDIO_STAT(streamVoices);
  check(env, napi_set_named_property(env, result, "diagnostics", boolean(env, stats.diagnostics)),
        "cannot set audio diagnostics state");
  if (stats.diagnostics) {
    AUDIO_STAT(loads); AUDIO_STAT(decoderOpens); AUDIO_STAT(preparations);
    AUDIO_STAT(admissions); AUDIO_STAT(evictions); AUDIO_STAT(rejections);
    AUDIO_STAT(sampleLoads); AUDIO_STAT(streamLoads); AUDIO_STAT(prepareUs); AUDIO_STAT(decoderOpenUs);
    AUDIO_STAT(workerDecodeCalls); AUDIO_STAT(workerDecodeUs); AUDIO_STAT(workerCpuUs);
    AUDIO_STAT(peakCacheBytes); AUDIO_STAT(peakLivePcmBytes);
  }
#undef AUDIO_STAT
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

napi_value setAudioSuspended(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 2);
  return boolean(env, host(env).core.media().setSuspended(
      asUint32(env, a.at(0)), asBoolean(env, a.at(1))));
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

napi_value setAudioEqualPowerPan(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 2);
  return boolean(env, host(env).core.media().setEqualPowerPan(asUint32(env, a.at(0)),
    asNumber(env, a.at(1))));
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}

napi_value fadeAudio(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 6);
  return boolean(env, host(env).core.media().fade(asUint32(env, a.at(0)),
    asNumber(env, a.at(1)), asNumber(env, a.at(2)), asNumber(env, a.at(3)),
    asBoolean(env, a.at(4)), a.size() > 5 && asBoolean(env, a.at(5))));
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
  const auto released = host(env).core.media().release(asUint32(env, a.at(0)));
  syncExternalMemory(env);
  return boolean(env, released);
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
  auto a = arguments(env, info, 2); State& value = host(env);
  const auto path = value.vfs.resolve(asString(env, a.at(0)));
  if (!path) throw std::runtime_error("video path is outside the game root");
  std::string error;
  const bool telemetry = videoTelemetryEnabled();
  auto decoder = std::make_unique<pmjs::VideoDecoderSession>(*path, telemetry, browserVideoColor(env, a));
  auto frame = decoder->frame(0.0, &error);
  if (!frame) throw std::runtime_error(error.empty() ? "video decode failed" : error);
  const auto image = value.images.createRgba(frame->width, frame->height,
                                              frame->rgba.data());
  if (!image) throw std::runtime_error("cannot allocate video texture");
  std::uint32_t handle = value.nextVideo++;
  if (!handle) handle = value.nextVideo++;
  const double duration = decoder->info().duration;
  const double sourceFps = decoder->info().videoFrameRate;
  auto video = std::make_unique<Video>(std::move(decoder), telemetry);
  video->image = image->handle;
  video->duration = duration; video->sourceFps = sourceFps;
  video->timestamp = frame->timestamp;
  video->browser420 = std::move(frame->browser420);
  video->recycle(std::move(frame->rgba));
  value.videos.emplace(handle, std::move(video));
  syncExternalMemory(env);
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
  if (video.telemetryEnabled) ++video.requests;
  if (auto frame = video.take()) {
    if (frame->timestamp > video.timestamp + 0.000001) {
      const auto started = video.telemetryEnabled ? Clock::now() : Clock::time_point{};
      if (!value.images.updateRgba(video.image, frame->rgba.data()))
        throw std::runtime_error("video texture update failed");
      video.browser420 = std::move(frame->browser420);
      if (video.canvasImage) {
        const std::uint8_t* pixels = frame->rgba.data();
        if (video.browser420) {
          video.browser420->convert(video.canvasRgba, true);
          pixels = video.canvasRgba.data();
        }
        if (!value.images.updateRgba(video.canvasImage, pixels))
          throw std::runtime_error("video canvas texture update failed");
      }
      if (video.telemetryEnabled) {
        if (frame->timestamp + 0.1 < timestamp) ++video.lateFrames;
        video.textureUploadMs += std::chrono::duration<double, std::milli>(
          Clock::now() - started).count();
        ++video.uploadedFrames;
        video.uploadBytes += static_cast<std::uint64_t>(frame->width) * frame->height * 4U *
          (video.canvasImage ? 2U : 1U);
      }
      video.timestamp = frame->timestamp;
    } else if (video.telemetryEnabled) ++video.staleReadyDrops;
    video.recycle(std::move(frame->rgba));
  } else if (video.telemetryEnabled) ++video.repeatedFrames;
  video.request(timestamp);
  reportVideo(video, timestamp);
  return number(env, video.timestamp);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

// The canvas/texture consumer requests its own conversion lazily. The image
// remains video-owned; renderers can retain it under the ordinary image contract.
napi_value videoCanvasImage(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 1); State& value = host(env);
  const auto found = value.videos.find(asUint32(env, a.at(0)));
  if (found == value.videos.end()) throw std::runtime_error("invalid video handle");
  auto& video = *found->second;
  if (!video.browser420) return uint32(env, video.canvasImage ? video.canvasImage : video.image);
  if (!video.canvasImage) {
    video.browser420->convert(video.canvasRgba, true);
    const auto image = value.images.createRgba(video.browser420->width,
      video.browser420->height, video.canvasRgba.data());
    if (!image) throw std::runtime_error("cannot allocate video canvas texture");
    video.canvasImage = image->handle;
    syncExternalMemory(env);
  }
  return uint32(env, video.canvasImage);
} catch (const std::exception& error) {
  napi_throw_error(env, nullptr, error.what()); return nullptr;
}

napi_value releaseVideo(napi_env env, napi_callback_info info) try {
  auto a = arguments(env, info, 1); State& value = host(env);
  const auto found = value.videos.find(asUint32(env, a.at(0)));
  if (found == value.videos.end()) return boolean(env, false);
  value.images.release(found->second->image);
  if (found->second->canvasImage) value.images.release(found->second->canvasImage);
  value.videos.erase(found);
  syncExternalMemory(env);
  return boolean(env, true);
} catch (const std::exception& error) {
  napi_throw_type_error(env, nullptr, error.what()); return nullptr;
}


void registerMediaBindings(napi_env env, napi_value exports) {
  napi_value media = moduleObject(env);
  method(env, media, "loadAudio", loadAudio);
  method(env, media, "audioStats", audioStats);
  method(env, media, "loadAudioBytes", loadAudioBytes);
  method(env, media, "playAudio", playAudio);
  method(env, media, "stopAudio", stopAudio);
  method(env, media, "setAudioSuspended", setAudioSuspended);
  method(env, media, "setAudioParameters", setAudioParameters);
  method(env, media, "setAudioEqualPowerPan", setAudioEqualPowerPan);
  method(env, media, "fadeAudio", fadeAudio);
  method(env, media, "audioIsPlaying", audioIsPlaying);
  method(env, media, "audioPosition", audioPosition);
  method(env, media, "releaseAudio", releaseAudio);
  method(env, media, "setMasterVolume", setMasterVolume);
  method(env, media, "loadVideo", loadVideo);
  method(env, media, "loadVideoAsync", loadVideoAsync);
  method(env, media, "updateVideo", updateVideo);
  method(env, media, "videoCanvasImage", videoCanvasImage);
  method(env, media, "releaseVideo", releaseVideo);
  check(env, napi_set_named_property(env, exports, "media", media), "cannot export media module");
}

}  // namespace pmjs::addon
