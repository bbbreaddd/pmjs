#pragma once

#include "media_decoder.hpp"
#include "resources.hpp"

#include <chrono>
#include <condition_variable>
#include <mutex>
#include <thread>

namespace pmjs::addon {

struct Video {
  explicit Video(std::unique_ptr<pmjs::VideoDecoderSession> source, bool telemetry);
  ~Video();
  void request(double targetTime);
  void resetForSeek();
  std::optional<pmjs::VideoFrame> take();
  pmjs::VideoDecodeStats workerStats();
  double workerQueueMs();
  std::uint64_t coalescedRequests();
  std::uint64_t jobsStarted();
  std::size_t queuedRawFrames();
  void recycle(std::vector<std::uint8_t> rgba);
  const pmjs::MediaInfo& info() const;

 private:
  void run();
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

 public:
  pmjs::ImageHandle image = 0, canvasImage = 0;
  std::shared_ptr<const pmjs::VideoYuv420> browser420;
  std::vector<std::uint8_t> canvasRgba;
  const bool telemetryEnabled;
  double duration = 0.0;
  double timestamp = -1.0;
  double lastRequestedTimestamp = -1.0;
  double sourceFps = 0.0;
  std::uint64_t requests = 0, uploadedFrames = 0, repeatedFrames = 0;
  std::uint64_t lateFrames = 0, staleReadyDrops = 0, uploadBytes = 0;
  double textureUploadMs = 0.0;
  double workerWaitMs = 0.0, readyWaitMs = 0.0;
  std::chrono::steady_clock::time_point reportStarted;
  pmjs::VideoDecodeStats reportedDecodeStats;
  std::uint64_t reportedRequests = 0, reportedUploadedFrames = 0;
  std::uint64_t reportedRepeatedFrames = 0, reportedLateFrames = 0;
  std::uint64_t reportedStaleReadyDrops = 0;
  std::uint64_t reportedUploadBytes = 0;
  std::uint64_t reportedWorkerJobs = 0, reportedCoalescedRequests = 0;
  double reportedUploadMs = 0.0;
  double reportedWorkerWaitMs = 0.0, reportedReadyWaitMs = 0.0;
};

}  // namespace pmjs::addon
