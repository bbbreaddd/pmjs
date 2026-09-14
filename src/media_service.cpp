#include "media_service.hpp"
#include "media_mix.hpp"
#include <SDL.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <deque>
#include <iostream>
#include <mutex>
#include <optional>
#include <thread>
#include <unordered_map>

namespace pmjs {
struct MediaService::Impl {
  static constexpr std::size_t bufferFrames = 48000, decodeFrames = 8192;
  struct Voice {
    explicit Voice(std::unique_ptr<AudioDecoderSession> source)
        : decoder(std::move(source)) {
      mix.duration = decoder->duration();
      mix.loopStart = decoder->loopStartFrame();
      mix.loopEnd = decoder->loopEndFrame();
    }
    std::unique_ptr<AudioDecoderSession> decoder;
    mutable std::mutex mutex;
    VoiceMixState mix;
    std::uint64_t producerFrame = 0, generation = 0;
    std::optional<double> requestedSeek;
    bool decoding = false;
  };

  explicit Impl(std::filesystem::path mediaRoot) : root(std::move(mediaRoot)) {
    SDL_AudioSpec requested{};
    requested.freq = 48000; requested.format = AUDIO_F32SYS;
    requested.channels = 2; requested.samples = 1024;
    requested.callback = callback; requested.userdata = this;
    device = SDL_OpenAudioDevice(nullptr, 0, &requested, &obtained, 0);
    worker = std::thread([this] { decodeLoop(); });
    if (device) SDL_PauseAudioDevice(device, 0);
  }
  ~Impl() {
    shuttingDown = true;
    if (worker.joinable()) worker.join();
    if (device) SDL_CloseAudioDevice(device);
  }
  std::vector<std::shared_ptr<Voice>> snapshot() const {
    std::lock_guard lock(mutex);
    std::vector<std::shared_ptr<Voice>> result;
    result.reserve(voices.size());
    for (const auto& [handle, voice] : voices) { (void)handle; result.push_back(voice); }
    return result;
  }
  std::shared_ptr<Voice> voice(std::uint32_t handle) const {
    std::lock_guard lock(mutex);
    const auto found = voices.find(handle);
    return found == voices.end() ? nullptr : found->second;
  }
  static void callback(void* data, Uint8* bytes, int byteCount) {
    auto& self = *static_cast<Impl*>(data);
    auto* output = reinterpret_cast<float*>(bytes);
    const int frames = byteCount / static_cast<int>(sizeof(float) * 2);
    std::fill(output, output + frames * 2, 0.0F);
    const float master = self.masterVolume.load(std::memory_order_relaxed);
    for (const auto& voice : self.snapshot()) {
      std::lock_guard lock(voice->mutex);
      mixVoiceInto(voice->mix, output, frames, master);
    }
    clampStereoMix(output, frames);
  }
  void fill(const std::shared_ptr<Voice>& voice) {
    std::optional<double> seek;
    std::uint64_t generation;
    std::size_t wanted;
    {
      std::lock_guard lock(voice->mutex);
      if (!voice->mix.playing || voice->decoding ||
          voice->mix.samples.size() / 2 >= bufferFrames) return;
      voice->decoding = true; generation = voice->generation;
      seek = voice->requestedSeek; voice->requestedSeek.reset();
      wanted = std::min(decodeFrames, bufferFrames - voice->mix.samples.size() / 2);
    }
    std::string error;
    const bool seeked = !seek || voice->decoder->seek(*seek, &error);
    auto decoded = seeked ? voice->decoder->read(wanted, &error) : std::vector<float>{};
    {
      std::lock_guard lock(voice->mutex);
      voice->decoding = false;
      if (generation != voice->generation || !voice->mix.playing) return;
      if (!seeked) {
        std::cerr << "[pmjs-media] audio decoder error: " << error << '\n';
        voice->mix.eof = true; return;
      }
      std::size_t count = decoded.size() / 2;
      if (voice->mix.loop && voice->mix.loopEnd > voice->mix.loopStart &&
          voice->producerFrame < voice->mix.loopEnd) {
        count = std::min<std::size_t>(count, voice->mix.loopEnd - voice->producerFrame);
        decoded.resize(count * 2);
      }
      voice->mix.samples.insert(voice->mix.samples.end(), decoded.begin(), decoded.end());
      voice->producerFrame += count;
      const bool boundary = voice->mix.loop && voice->mix.loopEnd > voice->mix.loopStart &&
                            voice->producerFrame >= voice->mix.loopEnd;
      if (boundary || (decoded.empty() && voice->mix.loop)) {
        voice->requestedSeek = static_cast<double>(voice->mix.loopStart) / 48000;
        voice->producerFrame = voice->mix.loopStart;
      } else if (decoded.empty()) {
        if (!error.empty()) std::cerr << "[pmjs-media] audio decoder error: "
                                      << error << '\n';
        voice->mix.eof = true;
      }
    }
  }
  void decodeLoop() {
    while (!shuttingDown) {
      for (const auto& voice : snapshot()) fill(voice);
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
  }
  std::filesystem::path root;
  SDL_AudioDeviceID device = 0;
  SDL_AudioSpec obtained{};
  mutable std::mutex mutex;
  std::unordered_map<std::uint32_t, std::shared_ptr<Voice>> voices;
  std::uint32_t nextHandle = 1;
  std::atomic<bool> shuttingDown{false};
  std::atomic<float> masterVolume{1.0F};
  std::thread worker;
};

MediaService::MediaService(std::filesystem::path root)
  : impl_(std::make_unique<Impl>(std::move(root))) {}
MediaService::~MediaService() = default;
std::uint32_t MediaService::loadAudio(const std::string& path, std::string* error) {
  const std::filesystem::path requested(path);
  const auto resolved = requested.is_absolute() ? requested : impl_->root / requested;
  std::unique_ptr<AudioDecoderSession> decoder;
  try { decoder = std::make_unique<AudioDecoderSession>(resolved); }
  catch (const std::exception& exception) { if (error) *error = exception.what(); return 0; }
  auto voice = std::make_shared<Impl::Voice>(std::move(decoder));
  std::lock_guard lock(impl_->mutex);
  std::uint32_t handle = impl_->nextHandle++;
  if (!handle) handle = impl_->nextHandle++;
  impl_->voices.emplace(handle, std::move(voice));
  return handle;
}
std::uint32_t MediaService::loadAudioBytes(std::vector<std::uint8_t> bytes,
                                           std::string* error) {
  std::unique_ptr<AudioDecoderSession> decoder;
  try { decoder = std::make_unique<AudioDecoderSession>(std::move(bytes)); }
  catch (const std::exception& exception) { if (error) *error = exception.what(); return 0; }
  auto voice = std::make_shared<Impl::Voice>(std::move(decoder));
  std::lock_guard lock(impl_->mutex);
  std::uint32_t handle = impl_->nextHandle++;
  if (!handle) handle = impl_->nextHandle++;
  impl_->voices.emplace(handle, std::move(voice));
  return handle;
}
bool MediaService::play(std::uint32_t handle, bool loop, double offset) {
  auto voice = impl_->voice(handle);
  if (!voice || !std::isfinite(offset)) return false;
  std::lock_guard lock(voice->mutex);
  if (voice->mix.duration > 0) {
    if (loop && voice->mix.loopEnd > voice->mix.loopStart) {
      const double loopStartSec = static_cast<double>(voice->mix.loopStart) / 48000.0;
      const double loopEndSec = static_cast<double>(voice->mix.loopEnd) / 48000.0;
      const double loopLen = loopEndSec - loopStartSec;
      if (loopLen > 0 && offset >= loopEndSec) {
        offset = loopStartSec + std::fmod(offset - loopStartSec, loopLen);
      }
    } else if (loop) {
      offset = std::fmod(offset, voice->mix.duration);
    }
  }
  offset = std::clamp(offset, 0.0, voice->mix.duration);
  voice->mix.samples.clear(); voice->mix.phase = 0;
  voice->mix.positionFrame = voice->producerFrame = static_cast<std::uint64_t>(offset * 48000);
  voice->requestedSeek = offset; ++voice->generation;
  voice->mix.loop = loop; voice->mix.eof = false; voice->mix.playing = impl_->device != 0;
  voice->mix.gain = 1.0F; voice->mix.targetGain = 1.0F; voice->mix.gainStep = 0.0F;
  voice->mix.stopAfterFade = false;
  return impl_->device != 0;
}
bool MediaService::stop(std::uint32_t handle) {
  auto voice = impl_->voice(handle); if (!voice) return false;
  std::lock_guard lock(voice->mutex); voice->mix.playing = false;
  voice->mix.gain = 1.0F; voice->mix.targetGain = 1.0F; voice->mix.gainStep = 0.0F;
  voice->mix.stopAfterFade = false;
  ++voice->generation; voice->mix.samples.clear(); return true;
}
bool MediaService::setParameters(std::uint32_t handle, float volume,
                                 float pitch, float pan) {
  if (!std::isfinite(volume) || !std::isfinite(pitch) || !std::isfinite(pan)) return false;
  auto voice = impl_->voice(handle); if (!voice) return false;
  std::lock_guard lock(voice->mutex); voice->mix.volume = std::max(0.0F, volume);
  voice->mix.pitch = std::clamp(pitch, 0.05F, 8.0F);
  voice->mix.pan = std::clamp(pan, -1.0F, 1.0F); return true;
}
bool MediaService::fade(std::uint32_t handle, float from, float to,
                        double duration, bool stopWhenFinished) {
  if (!std::isfinite(from) || !std::isfinite(to) || !std::isfinite(duration) || duration < 0) return false;
  auto voice = impl_->voice(handle); if (!voice) return false;
  std::lock_guard lock(voice->mutex);
  if (from >= 0.0F) voice->mix.gain = std::clamp(from, 0.0F, 1.0F);
  voice->mix.targetGain = std::clamp(to, 0.0F, 1.0F);
  voice->mix.stopAfterFade = stopWhenFinished;
  const double frames = duration * 48000;
  voice->mix.gainStep = frames > 0 ? static_cast<float>((voice->mix.targetGain - voice->mix.gain) / frames) : 0;
  if (frames <= 0) { voice->mix.gain = voice->mix.targetGain;
    if (stopWhenFinished && voice->mix.gain <= 0) voice->mix.playing = false; }
  return true;
}
bool MediaService::isPlaying(std::uint32_t handle) const {
  auto voice = impl_->voice(handle); if (!voice) return false;
  std::lock_guard lock(voice->mutex); return voice->mix.playing;
}
double MediaService::position(std::uint32_t handle) const {
  auto voice = impl_->voice(handle); if (!voice) return 0;
  std::lock_guard lock(voice->mutex); return static_cast<double>(voice->mix.positionFrame) / 48000;
}
double MediaService::duration(std::uint32_t handle) const {
  auto voice = impl_->voice(handle); return voice ? voice->mix.duration : 0;
}
std::size_t MediaService::bufferedFrames(std::uint32_t handle) const {
  auto voice = impl_->voice(handle); if (!voice) return 0;
  std::lock_guard lock(voice->mutex); return voice->mix.samples.size() / 2;
}
bool MediaService::release(std::uint32_t handle) {
  std::lock_guard lock(impl_->mutex); return impl_->voices.erase(handle) != 0;
}
bool MediaService::audioAvailable() const { return impl_->device != 0; }
void MediaService::setMasterVolume(float volume) {
  if (std::isfinite(volume)) {
    impl_->masterVolume.store(std::clamp(volume, 0.0F, 1.0F), std::memory_order_relaxed);
  }
}
float MediaService::masterVolume() const {
  return impl_->masterVolume.load(std::memory_order_relaxed);
}
}  // namespace pmjs
