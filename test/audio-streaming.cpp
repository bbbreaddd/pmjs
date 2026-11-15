#include <SDL.h>

#include "media/media_service.hpp"
extern "C" {
#include <libavformat/avformat.h>
}
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <thread>
using namespace std::chrono_literals;
namespace {
const auto mainThread = std::this_thread::get_id();
SDL_AudioSpec spec{};
std::atomic<bool> blockRead{false}, enteredRead{false};
std::atomic<uint64_t> workerAllocs{0}, workerBytes{0}, alloc64k{0};
thread_local bool inCallback = false;
std::atomic<std::uint64_t> callbackFrees{0};
std::atomic<std::size_t> trackedQueueBytes{0};
std::atomic<void*> trackedQueue{nullptr};
std::mutex trackingMutex;
std::array<void*, 128> pointers{};
size_t live64k = 0, peak64k = 0;
void require(bool ok, const char* text) {
  if (!ok) throw std::runtime_error(text);
}
template <class Fn>
void await(Fn fn, const char* message) {
  auto end = std::chrono::steady_clock::now() + 3s;
  while (!fn()) {
    require(std::chrono::steady_clock::now() < end, message);
    std::this_thread::sleep_for(1ms);
  }
}
int16_t value(size_t frame, int channel, int seed) {
  return static_cast<int16_t>((frame * 83 + channel * 29 + seed * 113) % 1001 - 500);
}
std::vector<uint8_t> wav(size_t frames, int seed) {
  std::vector<uint8_t> b(44 + frames * 4);
  auto w = [&](size_t at, uint32_t v, int n) {
    for (int k = 0; k < n; k++) b[at + k] = v >> (8 * k);
  };
  auto t = [&](size_t at, const char* s) { std::memcpy(b.data() + at, s, 4); };
  t(0, "RIFF");
  w(4, b.size() - 8, 4);
  t(8, "WAVE");
  t(12, "fmt ");
  w(16, 16, 4);
  w(20, 1, 2);
  w(22, 2, 2);
  w(24, 48000, 4);
  w(28, 192000, 4);
  w(32, 4, 2);
  w(34, 16, 2);
  t(36, "data");
  w(40, frames * 4, 4);
  for (size_t i = 0; i < frames; i++)
    for (int c = 0; c < 2; c++) w(44 + i * 4 + c * 2, value(i, c, seed), 2);
  return b;
}
std::array<float, 2048> render() {
  std::array<float, 2048> out;
  inCallback = true;
  spec.callback(spec.userdata, reinterpret_cast<Uint8*>(out.data()), out.size() * sizeof(float));
  inCallback = false;
  require(callbackFrees == 0, "callback freed stream storage while voices remained live");
  return out;
}
void verify(const std::array<float, 2048>& out, size_t offset, size_t length, int voices) {
  for (size_t f = 0; f < 1024; f++)
    for (int c = 0; c < 2; c++) {
      float expected = 0;
      for (int s = 1; s <= voices; s++) expected += value((offset + f) % length, c, s) / 32768.F;
      require(out[f * 2 + c] == expected, "mixed PCM differs");
    }
}
void untrack(void* p) {
  std::lock_guard lock(trackingMutex);
  for (auto& v : pointers)
    if (v == p && p) {
      v = nullptr;
      --live64k;
      break;
    }
}
size_t live() {
  std::lock_guard lock(trackingMutex);
  return live64k;
}
void playback(int voiceCount, bool loop) {
  auto beforeAllocs = workerAllocs.load(), beforeBytes = workerBytes.load(),
       before64 = alloc64k.load();
  size_t retained = 0;
  uint64_t calls = 0;
  double cpu = 0, decode = 0;
  {
    pmjs::MediaService media(".");
    require(live() == 0, "idle service retained scratch before playback");
    std::vector<uint32_t> handles;
    const size_t length = 16384, total = loop ? length * 6 : length;
    for (int s = 1; s <= voiceCount; s++) {
      std::string error;
      auto h = media.loadAudioBytes(wav(length, s), &error);
      require(h && error.empty() && media.play(h, loop, 0), "failed to start stream");
      handles.push_back(h);
    }
    for (size_t offset = 0; offset < total; offset += 1024) {
      for (auto h : handles)
        await(
            [&] {
              return media.bufferedFrames(h) >=
                     std::min<size_t>(1025, loop ? 1025 : total - offset);
            },
            "stream did not refill");
      if (!loop && offset + 1024 == total) std::this_thread::sleep_for(10ms);
      auto out = render();
      verify(out, offset, length, voiceCount);
    }
    if (!loop) {
      render();
      for (auto h : handles) require(!media.isPlaying(h), "EOF did not stop voice");
    } else
      for (auto h : handles)
        require(media.isPlaying(h) && media.audioError(h).empty(), "loop stopped unexpectedly");
    auto stats = media.audioCacheStats();
    calls = stats.workerDecodeCalls;
    cpu = stats.workerCpuUs / 1000.;
    decode = stats.workerDecodeUs / 1000.;
    for (auto h : handles) {
      media.release(h);
    }
    std::this_thread::sleep_for(20ms);
    require(media.audioCacheStats().streamVoices == 0, "release retained voices");
    retained = live();
  }
  require(live() == 0, "service destruction retained 64KiB allocations");
  std::cout << "{\"test\":\"worker_callback_pcm\",\"voices\":" << voiceCount
            << ",\"loop\":" << (loop ? "true" : "false")
            << ",\"workerCppAllocations\":" << workerAllocs - beforeAllocs
            << ",\"workerCppBytes\":" << workerBytes - beforeBytes
            << ",\"allocations64KiB\":" << alloc64k - before64
            << ",\"retained64KiBAfterRelease\":" << retained
            << ",\"retainedAfterServiceDestroy\":0,\"workerDecodeCalls\":" << calls
            << ",\"workerCpuMs\":" << cpu << ",\"workerDecodeMs\":" << decode
            << ",\"pcmExact\":true}\n";
}
void storageLifetime() {
  pmjs::MediaService media(".");
  const auto handle = media.loadAudioBytes(wav(16384, 1));
  require(handle, "cannot load storage lifetime fixture");
  trackedQueueBytes = 96000 * sizeof(float);
  require(media.play(handle, true, 0), "cannot start full stream");
  await([&] { return media.bufferedFrames(handle) == 48000 && trackedQueue.load(); },
        "full stream never reached its bounded capacity");
  const auto retained = trackedQueue.load();
  require(media.setSuspended(handle, true), "cannot suspend stream");
  render();
  require(trackedQueue == retained && media.bufferedFrames(handle) == 48000,
          "suspension discarded queued PCM");
  require(media.setSuspended(handle, false), "cannot resume stream");
  require(media.fade(handle, 1, 0, 0.001, true), "cannot fade stream to stop");
  render();
  await([&] { return !media.isPlaying(handle) && !trackedQueue.load(); },
        "fade stop retained full stream capacity");
  require(media.play(handle, true, 0), "cannot restart faded stream");
  await([&] { return media.bufferedFrames(handle) == 48000 && trackedQueue.load(); },
        "restart did not refill stream capacity");
  require(media.stop(handle) && !trackedQueue.load(), "explicit stop retained stream capacity");
  trackedQueueBytes = 32768 * sizeof(float);
  require(media.play(handle, false, 0), "cannot restart one-shot stream");
  await([&] { return media.bufferedFrames(handle) == 16384 && trackedQueue.load(); },
        "one-shot stream did not fill");
  std::this_thread::sleep_for(10ms);
  for (int block = 0; block < 17; ++block) render();
  await([&] { return !media.isPlaying(handle) && !trackedQueue.load(); },
        "natural EOF retained stream capacity");
  require(media.play(handle, false, 0), "cannot restart ended stream");
  await([&] { return media.bufferedFrames(handle) == 16384 && trackedQueue.load(); },
        "ended stream did not refill");
  require(media.release(handle), "cannot release buffered stream");
  await([] { return !trackedQueue.load(); }, "release retained stream capacity");
  trackedQueueBytes = 0;
  std::cout << "stream suspension, fade, EOF, stop and release capacity passed\n";
}

void locking() {
  pmjs::MediaService media(".");
  struct GateGuard {
    ~GateGuard() { blockRead = false; }
  } gateGuard;
  auto h = media.loadAudioBytes(wav(48000, 1));
  require(h, "cannot load lock test");
  enteredRead = false;
  blockRead = true;
  require(media.play(h, false, 0), "cannot start lock test");
  await([] { return enteredRead.load(); }, "worker never entered IO");
  const auto start = std::chrono::steady_clock::now();
  auto silent = render();
  require(media.stop(h) && media.play(h, false, 0.25), "restart while decoding failed");
  double callbackAndControl =
      std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
  blockRead = false;
  for (float x : silent) require(x == 0, "unbuffered callback used stale PCM");
  await([&] { return media.bufferedFrames(h) >= 1025; }, "restart did not fill");
  verify(render(), 12000, 48000, 1);
  media.release(h);
  std::this_thread::sleep_for(10ms);
  auto released = media.loadAudioBytes(wav(48000, 2));
  enteredRead = false;
  blockRead = true;
  require(media.play(released, false, 0), "release test play failed");
  await([] { return enteredRead.load(); }, "release test did not enter IO");
  require(media.release(released), "release during decode failed");
  blockRead = false;
  std::this_thread::sleep_for(20ms);
  auto healthy = media.loadAudioBytes(wav(48000, 1));
  require(healthy && media.play(healthy, false, 0), "reload after release failed");
  await([&] { return media.bufferedFrames(healthy) >= 1025; }, "reload did not fill");
  verify(render(), 0, 48000, 1);
  media.release(healthy);
  std::cout << "{\"test\":\"blocked_io_callback_generation_release_reload\",\"passed\":true,"
               "\"callbackAndControlMs\":"
            << callbackAndControl << "}\n";
}
}  // namespace
extern "C" SDL_AudioDeviceID __wrap_SDL_OpenAudioDevice(const char*, int,
                                                        const SDL_AudioSpec* requested,
                                                        SDL_AudioSpec* obtained, int) {
  spec = *requested;
  *obtained = *requested;
  return 12345;
}
extern "C" void __wrap_SDL_PauseAudioDevice(SDL_AudioDeviceID, int) {}
extern "C" void __wrap_SDL_CloseAudioDevice(SDL_AudioDeviceID) {}
extern "C" int __real_av_read_frame(AVFormatContext*, AVPacket*);
extern "C" int __wrap_av_read_frame(AVFormatContext* c, AVPacket* p) {
  if (std::this_thread::get_id() != mainThread && blockRead) {
    enteredRead = true;
    while (blockRead) std::this_thread::sleep_for(1ms);
  }
  return __real_av_read_frame(c, p);
}
extern "C" void* __real__Znwm(size_t);
extern "C" void* __wrap__Znwm(size_t size) {
  auto p = __real__Znwm(size);
  if (size == trackedQueueBytes.load()) trackedQueue = p;
  if (std::this_thread::get_id() != mainThread) {
    ++workerAllocs;
    workerBytes += size;
  }
  if (size == 65536) {
    ++alloc64k;
    std::lock_guard lock(trackingMutex);
    for (auto& slot : pointers)
      if (!slot) {
        slot = p;
        live64k++;
        peak64k = std::max(peak64k, live64k);
        return p;
      }
    std::abort();
  }
  return p;
}
extern "C" void __real__ZdlPv(void*);
extern "C" void __real__ZdlPvm(void*, size_t);
extern "C" void __wrap__ZdlPv(void* p) {
  if (inCallback && p) ++callbackFrees;
  void* expected = p;
  trackedQueue.compare_exchange_strong(expected, nullptr);
  untrack(p);
  __real__ZdlPv(p);
}
extern "C" void __wrap__ZdlPvm(void* p, size_t s) {
  if (inCallback && p) ++callbackFrees;
  void* expected = p;
  trackedQueue.compare_exchange_strong(expected, nullptr);
  untrack(p);
  __real__ZdlPvm(p, s);
}
int main() try {
  SDL_setenv("PMJS_AUDIO_DIAGNOSTICS", "1", 1);
  for (int voices : {1, 8})
    for (bool loop : {false, true}) playback(voices, loop);
  storageLifetime();
  locking();
  require(live() == 0, "final tracked allocation leak");
  std::cout << "{\"test\":\"final_retained64KiB\",\"live\":0,\"peak\":" << peak64k << "}\n";
  return 0;
} catch (const std::exception& e) {
  blockRead = false;
  std::cerr << e.what() << '\n';
  return 1;
}
