#include "media/media_service.hpp"
#include <SDL.h>
extern "C" {
#include <libavformat/avformat.h>
}
#include <atomic>
#include <chrono>
#include <iostream>
#include <new>
#include <stdexcept>
#include <thread>

namespace {
std::atomic<int> fault{0}, calls{0};
const auto mainThread = std::this_thread::get_id();
void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
}
extern "C" void* __real__Znwm(std::size_t);
extern "C" void* __wrap__Znwm(std::size_t size) {
  if (std::this_thread::get_id() != mainThread && size == 2 * sizeof(void*) && fault == 5) {
    fault = 0;
    throw std::bad_alloc();
  }
  return __real__Znwm(size);
}
extern "C" int __real_av_read_frame(AVFormatContext*, AVPacket*);
extern "C" int __wrap_av_read_frame(AVFormatContext* context, AVPacket* packet) {
  if (std::this_thread::get_id() != mainThread && fault) {
    ++calls;
    switch (fault.load()) {
      case 1: return AVERROR(EIO);
      case 2: throw std::bad_alloc();
      case 3: throw 42;
      case 4: return AVERROR_EOF;
    }
  }
  return __real_av_read_frame(context, packet);
}
int main(int argc, char** argv) try {
  if (argc != 2) return 2;
  SDL_setenv("SDL_AUDIODRIVER", "dummy", 1);
  require(SDL_Init(SDL_INIT_AUDIO) == 0, "audio initialization failed");
  {
    pmjs::MediaService media(std::filesystem::path(argv[1]).parent_path());
    for (int mode : {1, 2, 3, 4}) {
      std::string error;
      const auto voice = media.loadAudio(argv[1], &error);
      require(voice && error.empty(), "audio fixture failed to load");
      calls = 0; fault = mode;
      require(media.play(voice, true, 0), "audio fixture failed to play");
      const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
      while (media.isPlaying(voice) && std::chrono::steady_clock::now() < deadline)
        SDL_Delay(5);
      require(!media.isPlaying(voice), "failed looping audio never stopped");
      require(!media.audioError(voice).empty(), "audio failure was not observable");
      const auto stoppedCalls = calls.load();
      require(stoppedCalls > 0 && stoppedCalls <= 2, "audio failure retried without progress");
      SDL_Delay(30);
      require(calls == stoppedCalls, "failed audio kept decoding");
      require(!media.play(voice, true, 0), "terminally failed voice accepted playback");
      fault = 0;
      media.release(voice);
      const auto healthy = media.loadAudio(argv[1], &error);
      require(healthy && media.play(healthy, true, 0), "independent audio could not play");
      SDL_Delay(60);
      require(media.isPlaying(healthy) && media.position(healthy) > 0,
        "independent audio did not advance after worker failure");
      media.release(healthy);
    }
  }
  {
    // A fresh service must grow its snapshot buffers on the first voice.
    pmjs::MediaService media(std::filesystem::path(argv[1]).parent_path());
    std::string error;
    fault = 5;
    const auto voice = media.loadAudio(argv[1], &error);
    require(voice && error.empty(), "cannot load snapshot failure fixture");
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    while (media.audioError(voice).empty() && std::chrono::steady_clock::now() < deadline) SDL_Delay(5);
    require(!media.isPlaying(voice) && !media.audioError(voice).empty(),
      "audio snapshot allocation failure escaped its callback or worker boundary");
    require(!media.play(voice, true, 0), "failed audio service accepted unreachable work");
    fault = 0;
    media.release(voice);
  }
  SDL_Quit();
  std::cout << "audio exceptions and empty loops stop without terminating playback service\n";
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  SDL_Quit();
  return 1;
}
