#pragma once

#include "runtime_core.hpp"
#include "scene_packet.hpp"

#include <node_api.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace pmjs::addon {

struct AsyncImageLoad;
struct State {
  State(const std::string& root, int initWidth, int initHeight,
        const std::string& assetRoot, const std::string& windowTitle,
        std::size_t imageWarmCacheBytes)
      : core(root, initWidth, initHeight, windowTitle),
        width(core.width()), height(core.height()), platform(core.platform()),
        images(core.images()), canvases(core.canvases()),
        renderer(core.renderer()), vfs(core.vfs()) {
    images.setWarmBudgetBytes(imageWarmCacheBytes);
    if (!assetRoot.empty()) assets = std::make_unique<pmjs::Vfs>(assetRoot);
  }

  struct Video {
    explicit Video(std::unique_ptr<pmjs::VideoDecoderSession> source)
        : decoder(std::move(source)) {
      worker = std::thread([this]() { run(); });
    }
    ~Video() {
      { std::lock_guard lock(mutex); shuttingDown = true; }
      condition.notify_one();
      if (worker.joinable()) worker.join();
    }
    void request(double targetTime) {
      { std::lock_guard lock(mutex);
        if (requested.has_value()) ++requestsCoalesced;
        requested = targetTime;
        requestedAt = std::chrono::steady_clock::now(); }
      condition.notify_one();
    }
    void resetForSeek() {
      std::lock_guard lock(mutex);
      ++playbackGeneration;
      requested.reset();
      if (ready) {
        if (ready->rgba.capacity() > recycledRgba.capacity())
          recycledRgba = std::move(ready->rgba);
        ready.reset();
      }
    }
    std::optional<pmjs::VideoFrame> take() {
      std::lock_guard lock(mutex);
      if (!ready) return std::nullopt;
      readyWaitMs += std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - readyAt).count();
      auto result = std::move(ready); ready.reset(); return result;
    }
    pmjs::VideoDecodeStats workerStats() {
      std::lock_guard lock(mutex); return decodeStats;
    }
    double workerQueueMs() {
      std::lock_guard lock(mutex); return workerWaitMs;
    }
    std::uint64_t coalescedRequests() {
      std::lock_guard lock(mutex); return requestsCoalesced;
    }
    std::uint64_t jobsStarted() {
      std::lock_guard lock(mutex); return workerJobs;
    }
    std::size_t queuedRawFrames() {
      std::lock_guard lock(mutex); return rawQueueDepth;
    }
    void recycle(std::vector<std::uint8_t> rgba) {
      std::lock_guard lock(mutex);
      if (rgba.capacity() > recycledRgba.capacity())
        recycledRgba = std::move(rgba);
    }
    void run() {
      while (true) {
        double frameTimestamp = 0;
        std::uint64_t generation = 0;
        std::vector<std::uint8_t> rgba;
        {
          std::unique_lock lock(mutex);
          if (!requested && !shuttingDown &&
              decoder->queuedFrames() < 3 && !decoder->exhausted()) {
            lock.unlock();
            std::string error;
            decoder->prefetchOne(&error);
            const auto stats = decoder->stats();
            const auto depth = decoder->queuedFrames();
            if (!error.empty()) std::cerr << "[pmjs-media] video prefetch error: "
                                          << error << '\n';
            lock.lock();
            decodeStats = stats;
            rawQueueDepth = depth;
            continue;
          }
          condition.wait(lock, [this] { return shuttingDown || requested.has_value(); });
          if (shuttingDown) return;
          frameTimestamp = *requested; requested.reset();
          generation = playbackGeneration;
          ++workerJobs;
          workerWaitMs += std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - requestedAt).count();
          rgba = std::move(recycledRgba);
        }
        std::string error;
        auto frame = decoder->frame(frameTimestamp, rgba, &error);
        const auto stats = decoder->stats();
        if (!frame) {
          if (!error.empty()) std::cerr << "[pmjs-media] video decoder error: "
                                        << error << '\n';
          recycle(std::move(rgba));
          std::lock_guard lock(mutex);
          decodeStats = stats;
          rawQueueDepth = decoder->queuedFrames();
          continue;
        }
        std::lock_guard lock(mutex);
        decodeStats = stats;
        rawQueueDepth = decoder->queuedFrames();
        if (generation != playbackGeneration) {
          if (frame->rgba.capacity() > recycledRgba.capacity())
            recycledRgba = std::move(frame->rgba);
          continue;
        }
        readyAt = std::chrono::steady_clock::now();
        if (ready && ready->rgba.capacity() > recycledRgba.capacity())
          recycledRgba = std::move(ready->rgba);
        ready = std::move(frame);
      }
    }
    std::unique_ptr<pmjs::VideoDecoderSession> decoder;
    std::mutex mutex;
    std::condition_variable condition;
    std::optional<double> requested;
    std::chrono::steady_clock::time_point requestedAt;
    std::optional<pmjs::VideoFrame> ready;
    std::chrono::steady_clock::time_point readyAt;
    std::vector<std::uint8_t> recycledRgba;
    pmjs::VideoDecodeStats decodeStats;
    std::uint64_t requestsCoalesced = 0;
    std::uint64_t workerJobs = 0;
    std::uint64_t playbackGeneration = 0;
    std::size_t rawQueueDepth = 0;
    std::thread worker;
    bool shuttingDown = false;
    pmjs::ImageHandle image = 0;
    bool telemetryEnabled = false;
    double duration = 0.0;
    double timestamp = -1.0;
    double lastRequestedTimestamp = -1.0;
    double sourceFps = 0.0;
    std::uint64_t requests = 0, uploadedFrames = 0, repeatedFrames = 0;
    std::uint64_t lateFrames = 0, staleReadyDrops = 0, uploadBytes = 0;
    double textureUploadMs = 0.0;
    double workerWaitMs = 0.0, readyWaitMs = 0.0;
    std::chrono::steady_clock::time_point reportStarted = std::chrono::steady_clock::now();
    pmjs::VideoDecodeStats reportedDecodeStats;
    std::uint64_t reportedRequests = 0, reportedUploadedFrames = 0;
    std::uint64_t reportedRepeatedFrames = 0, reportedLateFrames = 0;
    std::uint64_t reportedStaleReadyDrops = 0;
    std::uint64_t reportedUploadBytes = 0;
    std::uint64_t reportedWorkerJobs = 0, reportedCoalescedRequests = 0;
    double reportedUploadMs = 0.0;
    double reportedWorkerWaitMs = 0.0, reportedReadyWaitMs = 0.0;
  };

  pmjs::RuntimeCore core;
  int width;
  int height;
  pmjs::Platform& platform;
  pmjs::ImageStore& images;
  pmjs::CanvasStore& canvases;
  pmjs::Renderer& renderer;
  pmjs::Vfs& vfs;
  std::unique_ptr<pmjs::Vfs> assets;
  std::int64_t reportedExternalBytes = 0;
  std::unordered_map<std::uint32_t, std::unique_ptr<Video>> videos;
  std::unordered_map<std::string, AsyncImageLoad*> pendingImageLoads;
  std::uint64_t imageDecodeJobs = 0;
  std::uint64_t imageDecodeRequestsCoalesced = 0;
  std::uint32_t nextVideo = 1;
};

extern std::unique_ptr<State> state;

void check(napi_env env, napi_status status, const char* message);
napi_value undefined(napi_env env);
napi_value null(napi_env env);
napi_value boolean(napi_env env, bool input);
napi_value number(napi_env env, double input);
napi_value uint32(napi_env env, std::uint32_t input);
napi_value string(napi_env env, const std::string& input);
std::vector<napi_value> arguments(napi_env env, napi_callback_info info,
                                  std::size_t limit = 20);
double asNumber(napi_env env, napi_value value);
std::int32_t asInt32(napi_env env, napi_value value);
std::uint32_t asUint32(napi_env env, napi_value value);
bool asBoolean(napi_env env, napi_value value);
pmjs::BlendMode asBlendMode(napi_env env, napi_value value);
std::string asString(napi_env env, napi_value value);
napi_value property(napi_env env, napi_value object, const char* name);
bool hasProperty(napi_env env, napi_value object, const char* name);
State& host(napi_env env);
void syncExternalMemory(napi_env env);
napi_value imageInfo(napi_env env, std::uint32_t handle, int width, int height);
std::optional<pmjs::ImageHandle> resolveImage(State& value, std::uint32_t handle);
napi_value rendererStats(napi_env env, napi_callback_info info);

template <std::size_t Size>
std::array<float, Size> floatArray(napi_env env,
                                   const std::vector<napi_value>& args,
                                   std::size_t offset) {
  if (args.size() < offset + Size) throw std::runtime_error("missing arguments");
  std::array<float, Size> result{};
  for (std::size_t index = 0; index < Size; ++index) {
    result[index] = static_cast<float>(asNumber(env, args[offset + index]));
  }
  return result;
}

void method(napi_env env, napi_value object, const char* name, napi_callback callback);
napi_value moduleObject(napi_env env);
void registerRuntimeBindings(napi_env env, napi_value exports);
void registerPlatformBindings(napi_env env, napi_value exports);
void registerGraphicsBindings(napi_env env, napi_value exports);
void registerResourceBindings(napi_env env, napi_value exports);
void registerCanvasBindings(napi_env env, napi_value exports);
void registerDialogBindings(napi_env env, napi_value exports);
void registerMediaBindings(napi_env env, napi_value exports);

}  // namespace pmjs::addon
