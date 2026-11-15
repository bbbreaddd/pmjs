#include "node/node_addon_video.hpp"

extern "C" {
#include <libavformat/avformat.h>
#include <libavutil/error.h>
#include <libswscale/swscale.h>
}

#include <atomic>
#include <chrono>
#include <iostream>
#include <new>
#include <stdexcept>
#include <thread>

namespace {
std::atomic<int> conversionFailure{0};
std::atomic<bool> readFailure{false};
std::atomic<bool> readAnyFailure{false};
const auto mainThread = std::this_thread::get_id();

void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}

template<class Operation> void awaitFailure(Operation operation) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (std::chrono::steady_clock::now() < deadline) {
    if (operation()) return;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  throw std::runtime_error("video worker did not report completion");
}
}

extern "C" {
int __real_sws_scale(SwsContext*, const std::uint8_t* const[], const int[], int,
                     int, std::uint8_t* const[], const int[]);
int __wrap_sws_scale(SwsContext* context, const std::uint8_t* const input[],
    const int inputStride[], int y, int height, std::uint8_t* const output[],
    const int outputStride[]) {
  switch (conversionFailure.exchange(0)) {
    case 1: return AVERROR(EINVAL);
    case 2: return height - 1;
    case 3: throw std::bad_alloc();
    case 4: throw 41;
    default: return __real_sws_scale(context, input, inputStride, y, height, output, outputStride);
  }
}
int __real_av_read_frame(AVFormatContext*, AVPacket*);
int __wrap_av_read_frame(AVFormatContext* context, AVPacket* packet) {
  if (readAnyFailure.exchange(false) ||
      (std::this_thread::get_id() != mainThread && readFailure.exchange(false)))
    return AVERROR(EIO);
  return __real_av_read_frame(context, packet);
}
}

int main(int argc, char** argv) try {
  if (argc != 2) return 2;
  {
    pmjs::VideoDecoderSession decoder(argv[1]);
    std::string error;
    require(decoder.prefetchOne(&error), "cannot prepare queued frame");
    readAnyFailure = true;
    require(!decoder.frame(1.0, &error), "selected pixels concealed a later decoding error");
    require(error.find("cannot read video") == 0, "selected-frame failure lost its read error");
  }
  for (int fault : {1, 2}) {
    std::string error;
    pmjs::VideoDecoderSession decoder(argv[1]);
    conversionFailure = fault;
    require(!decoder.frame(0.0, &error), "failed streaming conversion published pixels");
    require(!error.empty(), "failed streaming conversion lost its error");
    error.clear();
    conversionFailure = fault;
    require(!pmjs::MediaDecoder::decodeVideoFrame(argv[1], 0.0, &error),
      "failed standalone conversion published pixels");
    require(!error.empty(), "failed standalone conversion lost its error");
  }
  for (int fault : {1, 2, 3, 4, 5}) {
    auto decoder = std::make_unique<pmjs::VideoDecoderSession>(argv[1]);
    conversionFailure = fault == 5 ? 0 : fault;
    readFailure = fault == 5;
    pmjs::addon::Video video(std::move(decoder), false);
    try { video.request(0.0); } catch (...) { /* Failure may precede the first request. */ }
    awaitFailure([&]() {
      try {
        require(!video.take(), "failed worker published a frame");
        return false;
      } catch (const std::bad_alloc&) {
        require(fault == 3, "worker changed its exception type");
      } catch (const std::runtime_error& error) {
        const std::string message = error.what();
        require(fault == 5 ? message.find("cannot read video") == 0
                           : message.find("video conversion") == 0,
          "worker changed its decode error");
      } catch (int value) {
        require(fault == 4 && value == 41, "worker lost a nonstandard exception");
      }
      return true;
    });
    bool refused = false;
    try { video.request(0.25); } catch (...) { refused = true; }
    require(refused, "failed worker accepted unreachable work");
  }
  pmjs::addon::Video healthy(std::make_unique<pmjs::VideoDecoderSession>(argv[1]), false);
  healthy.request(0.0);
  awaitFailure([&]() { return healthy.take().has_value(); });
  std::cout << "video conversion and worker failures preserve errors and independent playback\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
