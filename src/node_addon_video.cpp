#include "node_addon_video.hpp"

#include <iostream>

namespace pmjs::addon {

Video::Video(std::unique_ptr<pmjs::VideoDecoderSession> source, bool telemetry)
    : decoder(std::move(source)), telemetryEnabled(telemetry) {
  if (telemetryEnabled) reportStarted = std::chrono::steady_clock::now();
  worker = std::thread([this]() { run(); });
}

Video::~Video() {
  { std::lock_guard lock(mutex); shuttingDown = true; }
  condition.notify_one();
  if (worker.joinable()) worker.join();
}

void Video::request(double targetTime) {
  { std::lock_guard lock(mutex);
    if (telemetryEnabled && requested.has_value()) ++requestsCoalesced;
    requested = targetTime;
    if (telemetryEnabled) requestedAt = std::chrono::steady_clock::now(); }
  condition.notify_one();
}

void Video::resetForSeek() {
  std::lock_guard lock(mutex);
  ++playbackGeneration;
  requested.reset();
  if (ready) {
    if (ready->rgba.capacity() > recycledRgba.capacity())
      recycledRgba = std::move(ready->rgba);
    ready.reset();
  }
}

std::optional<pmjs::VideoFrame> Video::take() {
  std::lock_guard lock(mutex);
  if (!ready) return std::nullopt;
  if (telemetryEnabled) readyWaitMs += std::chrono::duration<double, std::milli>(
    std::chrono::steady_clock::now() - readyAt).count();
  auto result = std::move(ready); ready.reset(); return result;
}

pmjs::VideoDecodeStats Video::workerStats() {
  std::lock_guard lock(mutex); return decodeStats;
}

double Video::workerQueueMs() {
  std::lock_guard lock(mutex); return workerWaitMs;
}

std::uint64_t Video::coalescedRequests() {
  std::lock_guard lock(mutex); return requestsCoalesced;
}

std::uint64_t Video::jobsStarted() {
  std::lock_guard lock(mutex); return workerJobs;
}

std::size_t Video::queuedRawFrames() {
  std::lock_guard lock(mutex); return rawQueueDepth;
}

void Video::recycle(std::vector<std::uint8_t> rgba) {
  std::lock_guard lock(mutex);
  if (rgba.capacity() > recycledRgba.capacity())
    recycledRgba = std::move(rgba);
}

void Video::run() {
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
      if (telemetryEnabled) {
        ++workerJobs;
        workerWaitMs += std::chrono::duration<double, std::milli>(
          std::chrono::steady_clock::now() - requestedAt).count();
      }
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
    if (telemetryEnabled) readyAt = std::chrono::steady_clock::now();
    if (ready && ready->rgba.capacity() > recycledRgba.capacity())
      recycledRgba = std::move(ready->rgba);
    ready = std::move(frame);
  }
}

const pmjs::MediaInfo& Video::info() const { return decoder->info(); }

}  // namespace pmjs::addon
