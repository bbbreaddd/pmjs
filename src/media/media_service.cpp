#include "core/log.hpp"
#include "media_service.hpp"
#include "media_mix.hpp"
#include <SDL.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <exception>
#include <stdexcept>
#include <mutex>
#include <optional>
#include <thread>
#include <unordered_map>
#include <list>
#include <cstdlib>
#include <ctime>
#include <sys/stat.h>

namespace pmjs {
namespace {
std::string audioFileKey(const std::filesystem::path& path) {
  std::error_code error;
  const auto resolved = std::filesystem::canonical(path, error);
  struct stat info{};
  if (error || stat(resolved.c_str(), &info) != 0) return {};
  return resolved.string() + ':' + std::to_string(info.st_dev) + ':' +
    std::to_string(info.st_ino) + ':' + std::to_string(info.st_size) + ':' +
    std::to_string(info.st_mtim.tv_sec) + ':' + std::to_string(info.st_mtim.tv_nsec) + ':' +
    std::to_string(info.st_ctim.tv_sec) + ':' + std::to_string(info.st_ctim.tv_nsec);
}
std::uint64_t audioThreadMicros() {
  timespec value{};
  clock_gettime(CLOCK_THREAD_CPUTIME_ID, &value);
  return static_cast<std::uint64_t>(value.tv_sec) * 1000000 + value.tv_nsec / 1000;
}
}
struct MediaService::Impl {
  struct Automation {
    explicit Automation(double initial) : timeline(initial) {}
    mutable std::mutex mutex;
    GainAutomation timeline;
  };
  std::unordered_map<std::uint32_t, std::shared_ptr<Automation>> automations;
  std::uint32_t nextAutomation = 1;
  std::atomic<std::uint64_t> contextFrames{0};
  std::atomic<bool> contextSuspended{false};
  static constexpr std::size_t bufferFrames = 48000, decodeFrames = 8192;
  struct Voice {
    explicit Voice(std::unique_ptr<AudioDecoderSession> source)
        : decoder(std::move(source)), sourceChannels(decoder->sourceChannels()) {
      mix.duration = decoder->duration();
      mix.loopStart = decoder->loopStartFrame();
      mix.loopEnd = decoder->loopEndFrame();
    }
    explicit Voice(std::shared_ptr<const PreparedAudioAsset> asset) : sourceChannels(asset->sourceChannels) {
      mix.duration = asset->sourceDuration;
      mix.loopStart = std::min<std::uint64_t>(asset->loopStartFrame, asset->samples.size() / 2);
      mix.loopEnd = std::min<std::uint64_t>(asset->loopEndFrame, asset->samples.size() / 2);
      mix.asset = std::move(asset);
    }
    std::unique_ptr<AudioDecoderSession> decoder;
    const int sourceChannels;
    mutable std::mutex mutex;
    VoiceMixState mix;
    std::shared_ptr<Automation> automation;
    bool contextOwned = false;
    std::uint64_t producerFrame = 0, generation = 0;
    std::optional<double> requestedSeek;
    bool decoding = false, emptyLoopRestart = false;
    std::exception_ptr failure;
  };

  explicit Impl(std::filesystem::path mediaRoot) : root(std::move(mediaRoot)) {
    const char* diagnosticFlag = std::getenv("PMJS_AUDIO_DIAGNOSTICS");
    diagnostics = diagnosticFlag && std::string(diagnosticFlag) == "1";
    SDL_AudioSpec requested{};
    requested.freq = 48000; requested.format = AUDIO_F32SYS;
    requested.channels = 2; requested.samples = 1024;
    requested.callback = callback; requested.userdata = this;
    device = SDL_OpenAudioDevice(nullptr, 0, &requested, &obtained, 0);
    if (diagnostics) {
      const char* driver = SDL_GetCurrentAudioDriver();
      Log message(device ? LogLevel::Info : LogLevel::Warning);
      message << "[pmjs-audio] driver=" << (driver ? driver : "none")
                << " device_open=" << (device ? "yes" : "no")
                << " frequency=" << obtained.freq << " channels=" << int(obtained.channels)
                << " format=" << obtained.format << " samples=" << obtained.samples;
      if (!device) message << " error=\"" << SDL_GetError() << '\"';
    }
    try {
      worker = std::thread([this] {
        try { decodeLoop(); }
        catch (...) {
          std::lock_guard lock(mutex);
          serviceFailure = std::current_exception();
          serviceFailed = true;
        }
      });
    } catch (...) {
      if (device) SDL_CloseAudioDevice(device);
      throw;
    }
    if (device) SDL_PauseAudioDevice(device, 0);
  }
  ~Impl() {
    shuttingDown = true;
    if (worker.joinable()) worker.join();
    if (device) SDL_CloseAudioDevice(device);
  }
  void snapshot(std::vector<std::shared_ptr<Voice>>& result,
                bool streamsOnly = false) const {
    result.clear();
    std::lock_guard lock(mutex);
    if (!streamsOnly) result.reserve(voices.size());
    for (const auto& [handle, voice] : voices) {
      (void)handle;
      if (!streamsOnly || voice->decoder) result.push_back(voice);
    }
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
    if (self.serviceFailed) return;
    try {
      const bool suspended = self.contextSuspended.load(std::memory_order_acquire);
      const auto contextFrame = self.contextFrames.load(std::memory_order_relaxed);
      const float master = self.masterVolume.load(std::memory_order_relaxed);
      self.snapshot(self.callbackVoices);
      for (const auto& voice : self.callbackVoices) {
        std::lock_guard lock(voice->mutex);
        if (suspended && voice->contextOwned) continue;
        if (voice->automation) {
          std::lock_guard automationLock(voice->automation->mutex);
          voice->mix.automation = &voice->automation->timeline;
          mixVoiceInto(voice->mix, output, frames, master, contextFrame);
          voice->mix.automation = nullptr;
        } else mixVoiceInto(voice->mix, output, frames, master, contextFrame);
      }
      self.callbackVoices.clear();
      clampStereoMix(output, frames);
      if (!suspended) self.contextFrames.fetch_add(frames, std::memory_order_release);
    } catch (...) {
      self.callbackVoices.clear();
      std::fill(output, output + frames * 2, 0.0F);
      std::lock_guard lock(self.mutex);
      self.serviceFailure = std::current_exception();
      self.serviceFailed = true;
    }
  }

  void fill(const std::shared_ptr<Voice>& voice) {
    if (!voice->decoder) return;
    std::optional<double> seek;
    std::uint64_t generation;
    std::size_t wanted;
    {
      std::lock_guard lock(voice->mutex);
      // Reclaim inactive stream storage on the worker, including fade-completed voices.
      if (!voice->mix.playing) voice->mix.samples.clear();
      if (!voice->mix.playing || voice->mix.eof || voice->decoding ||
          voice->mix.samples.size() / 2 >= bufferFrames) return;
      voice->decoding = true; generation = voice->generation;
      seek = voice->requestedSeek; voice->requestedSeek.reset();
      wanted = std::min(decodeFrames, bufferFrames - voice->mix.samples.size() / 2);
    }
    std::string error;
    try {
      const bool seeked = !seek || voice->decoder->seek(*seek, &error);
      const auto decodeStarted = diagnostics ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
      const auto cpuStarted = diagnostics ? audioThreadMicros() : 0;
      auto decoded = seeked ? voice->decoder->read(wanted, &error) : std::vector<float>{};
      if (diagnostics) {
        workerCpuUs.fetch_add(audioThreadMicros() - cpuStarted, std::memory_order_relaxed);
        workerDecodeCalls.fetch_add(1, std::memory_order_relaxed);
        workerDecodeUs.fetch_add(std::chrono::duration_cast<std::chrono::microseconds>(
          std::chrono::steady_clock::now() - decodeStarted).count(), std::memory_order_relaxed);
      }
      {
        std::lock_guard lock(voice->mutex);
        voice->decoding = false;
        if (generation != voice->generation || !voice->mix.playing) return;
        if (!seeked || !error.empty()) throw std::runtime_error(
          error.empty() ? "audio seek failed" : error);
        std::size_t count = decoded.size() / 2;
        if (voice->mix.loop && voice->mix.loopEnd > voice->mix.loopStart &&
            voice->producerFrame < voice->mix.loopEnd) {
          count = std::min<std::size_t>(count, voice->mix.loopEnd - voice->producerFrame);
          decoded.resize(count * 2);
        }
        voice->mix.samples.append(decoded.begin(), decoded.end());
        voice->producerFrame += count;
        const bool boundary = voice->mix.loop && voice->mix.loopEnd > voice->mix.loopStart &&
                              voice->producerFrame >= voice->mix.loopEnd;
        if (count) voice->emptyLoopRestart = false;
        if (decoded.empty() && voice->mix.loop && voice->emptyLoopRestart)
          throw std::runtime_error("audio loop produced no samples after restart");
        if (boundary || (decoded.empty() && voice->mix.loop)) {
          voice->emptyLoopRestart = !count;
          voice->requestedSeek = static_cast<double>(voice->mix.loopStart) / 48000;
          voice->producerFrame = voice->mix.loopStart;
        } else if (decoded.empty()) {
          voice->mix.eof = true;
        }
      }
    } catch (...) {
      const auto failure = std::current_exception();
      std::lock_guard lock(voice->mutex);
      voice->decoding = false;
      if (generation != voice->generation) return;
      voice->failure = failure;
      voice->mix.playing = false;
      voice->mix.eof = true;
      voice->mix.samples.clear();
      voice->requestedSeek.reset();
    }
  }
  void decodeLoop() {
    std::vector<std::shared_ptr<Voice>> workerVoices;
    while (!shuttingDown && !serviceFailed) {
      snapshot(workerVoices, true);
      for (const auto& voice : workerVoices) fill(voice);
      workerVoices.clear();
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
  }
  struct CachedAsset {
    std::shared_ptr<const PreparedAudioAsset> asset;
    std::list<std::string>::iterator lru;
    std::size_t bytes() const {
      return asset->samples.capacity() * sizeof(float);
    }
  };
  void eraseCached(std::unordered_map<std::string, CachedAsset>::iterator entry) {
    cacheBytes -= entry->second.bytes();
    lru.erase(entry->second.lru);
    cache.erase(entry);
    if (diagnostics) ++cacheStats.evictions;
  }
  void trimCache() {
    while (cacheBytes > policy.cacheBytes && !lru.empty()) eraseCached(cache.find(lru.back()));
  }
  std::uint32_t installVoice(std::shared_ptr<Voice> voice) {
    std::lock_guard lock(mutex);
    const auto handle = nextHandle++;
    if (!handle) throw std::runtime_error("audio handle space exhausted");
    if (diagnostics) {
      if (voice->mix.asset) ++cacheStats.sampleLoads;
      else ++cacheStats.streamLoads;
    }
    voices.emplace(handle, std::move(voice));
    return handle;
  }
  std::shared_ptr<const PreparedAudioAsset> cached(const std::string& key, AudioIntent intent) {
    std::lock_guard lock(mutex);
    if (diagnostics) ++cacheStats.loads;
    if (intent != AudioIntent::effect || key.empty()) return {};
    const auto found = cache.find(key);
    if (found != cache.end()) {
      lru.splice(lru.begin(), lru, found->second.lru);
      if (diagnostics) ++cacheStats.hits;
      return found->second.asset;
    }
    if (diagnostics) ++cacheStats.misses;
    return {};
  }
  std::uint32_t loadDecoder(std::unique_ptr<AudioDecoderSession> decoder,
      const std::string& key, AudioIntent intent,
      std::string* error, std::uint64_t openUs) {
    std::size_t limit;
    {
      std::lock_guard lock(mutex);
      if (diagnostics) {
        ++cacheStats.decoderOpens;
        cacheStats.decoderOpenUs += openUs;
      }
      limit = std::min({policy.maxAssetBytes, policy.cacheBytes, policy.maxSynchronousBytes});
    }
    const double duration = decoder->duration();
    if (intent == AudioIntent::effect && !key.empty() && limit >= 8 &&
        std::isfinite(duration) && duration > 0 &&
        duration * 48000.0 * 2 * sizeof(float) <= limit) {
      const auto started = diagnostics ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
      std::string decodeError;
      auto samples = decoder->read(limit / (sizeof(float) * 2) + 1, &decodeError);
      const auto micros = diagnostics ? std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::steady_clock::now() - started).count() : 0;
      if (!decodeError.empty()) {
        if (error) *error = decodeError;
        return 0;
      }
      if (!samples.empty() && samples.capacity() * sizeof(float) <= limit) {
        auto* prepared = new PreparedAudioAsset;
        prepared->samples = std::move(samples);
        prepared->sourceDuration = duration;
        prepared->sourceChannels = decoder->sourceChannels();
        prepared->loopStartFrame = decoder->loopStartFrame();
        prepared->loopEndFrame = decoder->loopEndFrame();
        const auto pcmBytes = prepared->samples.capacity() * sizeof(float);
        livePcmBytes->fetch_add(pcmBytes, std::memory_order_relaxed);
        std::shared_ptr<const PreparedAudioAsset> asset(prepared,
          [counter = livePcmBytes, pcmBytes](const PreparedAudioAsset* value) {
            delete value;
            counter->fetch_sub(pcmBytes, std::memory_order_relaxed);
          });
        {
          std::lock_guard lock(mutex);
          if (diagnostics) {
            ++cacheStats.preparations;
            cacheStats.prepareUs += micros;
          }
          if (diagnostics) cacheStats.peakLivePcmBytes = std::max(cacheStats.peakLivePcmBytes,
            livePcmBytes->load(std::memory_order_relaxed));
          if (pcmBytes <= policy.cacheBytes) {
            const auto old = cache.find(key);
            if (old != cache.end()) eraseCached(old);
            lru.push_front(key);
            auto [entry, inserted] = cache.emplace(key,
              CachedAsset{asset, lru.begin()});
            (void)inserted;
            cacheBytes += entry->second.bytes();
            if (diagnostics) ++cacheStats.admissions;
            trimCache();
            if (diagnostics) cacheStats.peakCacheBytes = std::max(cacheStats.peakCacheBytes, cacheBytes);
          } else if (diagnostics) ++cacheStats.rejections;
        }
        return installVoice(std::make_shared<Voice>(std::move(asset)));
      }
      if (!decoder->seek(0, error)) return 0;
    }
    {
      std::lock_guard lock(mutex);
      if (diagnostics && intent == AudioIntent::effect) ++cacheStats.rejections;
    }
    return installVoice(std::make_shared<Voice>(std::move(decoder)));
  }
  std::list<std::string> lru;
  std::unordered_map<std::string, CachedAsset> cache;
  std::size_t cacheBytes = 0;
  PreparedAudioPolicy policy;
  bool diagnostics = false;
  AudioCacheStats cacheStats;
  std::shared_ptr<std::atomic<std::size_t>> livePcmBytes =
    std::make_shared<std::atomic<std::size_t>>(0);
  std::atomic<std::uint64_t> workerDecodeCalls{0}, workerDecodeUs{0}, workerCpuUs{0};
  std::filesystem::path root;
  SDL_AudioDeviceID device = 0;
  SDL_AudioSpec obtained{};
  mutable std::mutex mutex;
  std::unordered_map<std::uint32_t, std::shared_ptr<Voice>> voices;
  // SDL invokes this device's callbacks serially; the decoder has its own buffer.
  std::vector<std::shared_ptr<Voice>> callbackVoices;
  std::uint32_t nextHandle = 1;
  std::atomic<bool> shuttingDown{false}, serviceFailed{false};
  std::exception_ptr serviceFailure;
  std::atomic<float> masterVolume{1.0F};
  std::thread worker;
};

MediaService::MediaService(std::filesystem::path root)
  : impl_(std::make_unique<Impl>(std::move(root))) {}
MediaService::~MediaService() = default;
int MediaService::sourceChannels(std::uint32_t handle) const {
  const auto voice = impl_->voice(handle);
  return voice ? voice->sourceChannels : 0;
}
std::uint32_t MediaService::loadAudio(const std::string& path, std::string* error,
                                      const AudioLoadOptions& options) {
  const std::filesystem::path requested(path);
  const auto resolved = requested.is_absolute() ? requested : impl_->root / requested;
  const auto identity = options.intent != AudioIntent::effect ? std::string{} : audioFileKey(resolved);
  const auto key = identity.empty() ? std::string{} : "path:" + identity;
  if (auto asset = impl_->cached(key, options.intent))
    return impl_->installVoice(std::make_shared<Impl::Voice>(std::move(asset)));
  std::unique_ptr<AudioDecoderSession> decoder;
  const auto opened = impl_->diagnostics ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
  try { decoder = std::make_unique<AudioDecoderSession>(resolved); }
  catch (const std::exception& exception) { if (error) *error = exception.what(); return 0; }
  return impl_->loadDecoder(std::move(decoder), key, options.intent, error,
    impl_->diagnostics ? std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - opened).count() : 0);
}
std::uint32_t MediaService::installAudioDecoder(std::unique_ptr<AudioDecoderSession> decoder) {
  if (!decoder) return 0;
  return impl_->installVoice(std::make_shared<Impl::Voice>(std::move(decoder)));
}
std::uint32_t MediaService::loadAudioBytes(std::vector<std::uint8_t> bytes,
    std::string* error, const AudioLoadOptions& options) {
  std::string key;
  if (options.intent == AudioIntent::effect) {
    if (options.sourcePath.empty()) {
      if (!options.resourceIdentity.empty()) key = "bytes:resource:" + options.resourceIdentity;
    } else {
      const auto identity = audioFileKey(options.sourcePath);
      if (!identity.empty()) key = "bytes:file:" + identity;
    }
  }
  if (auto asset = impl_->cached(key, options.intent))
    return impl_->installVoice(std::make_shared<Impl::Voice>(std::move(asset)));
  std::unique_ptr<AudioDecoderSession> decoder;
  const auto opened = impl_->diagnostics ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
  try { decoder = std::make_unique<AudioDecoderSession>(std::move(bytes)); }
  catch (const std::exception& exception) { if (error) *error = exception.what(); return 0; }
  return impl_->loadDecoder(std::move(decoder), key, options.intent, error,
    impl_->diagnostics ? std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - opened).count() : 0);
}
std::uint32_t MediaService::loadEncryptedAudio(const std::filesystem::path& path, AudioEncryptionKey encryptionKey,
    std::string* error, const AudioLoadOptions& options) {
  const auto identity = options.intent == AudioIntent::effect ? audioFileKey(path) : std::string{};
  const auto key = identity.empty() ? std::string{} : "encrypted:" + identity + ':' +
    std::string(reinterpret_cast<const char*>(encryptionKey.data()), encryptionKey.size());
  const auto counted = [&](std::uint32_t handle) {
    if (handle && impl_->diagnostics) { std::lock_guard lock(impl_->mutex); ++impl_->cacheStats.encryptedLoads; }
    return handle;
  };
  if (auto asset = impl_->cached(key, options.intent))
    return counted(impl_->installVoice(std::make_shared<Impl::Voice>(std::move(asset))));
  const auto opened = impl_->diagnostics ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
  std::unique_ptr<AudioDecoderSession> decoder;
  try { decoder = std::make_unique<AudioDecoderSession>(path, encryptionKey); }
  catch (const std::exception& exception) { if (error) *error = exception.what(); return 0; }
  return counted(impl_->loadDecoder(std::move(decoder), key, options.intent, error,
    impl_->diagnostics ? std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - opened).count() : 0));
}

AudioCacheStats MediaService::audioCacheStats() const {
  AudioCacheStats stats;
  std::vector<std::shared_ptr<Impl::Voice>> voices;
  {
    std::lock_guard lock(impl_->mutex);
    stats = impl_->cacheStats;
    stats.cacheBytes = impl_->cacheBytes;
    stats.livePcmBytes = impl_->livePcmBytes->load(std::memory_order_relaxed);
    stats.entries = impl_->cache.size();
    stats.diagnostics = impl_->diagnostics;
    voices.reserve(impl_->voices.size());
    for (const auto& [handle, voice] : impl_->voices) {
      (void)handle;
      voices.push_back(voice);
    }
  }
  // Do not nest the service lock with voice locks: playback and decoder work
  // can update each voice independently while this diagnostic snapshot runs.
  for (const auto& voice : voices) {
    std::lock_guard voiceLock(voice->mutex);
    if (voice->mix.asset) ++stats.sampleVoices;
    else {
      ++stats.streamVoices;
      stats.streamBufferedBytes += voice->mix.samples.size() * sizeof(float);
    }
  }
  stats.workerDecodeCalls = impl_->workerDecodeCalls.load(std::memory_order_relaxed);
  stats.workerDecodeUs = impl_->workerDecodeUs.load(std::memory_order_relaxed);
  stats.workerCpuUs = impl_->workerCpuUs.load(std::memory_order_relaxed);
  return stats;
}
void MediaService::setPreparedAudioPolicyForTesting(PreparedAudioPolicy policy) {
  std::lock_guard lock(impl_->mutex);
  impl_->policy = policy;
  for (auto entry = impl_->cache.begin(); entry != impl_->cache.end();) {
    if (entry->second.asset->samples.capacity() * sizeof(float) > policy.maxAssetBytes) {
      const auto removed = entry++;
      impl_->eraseCached(removed);
    } else ++entry;
  }
  impl_->trimCache();
}
std::size_t MediaService::sampleMemoryBytes() const {
  return impl_->livePcmBytes->load(std::memory_order_relaxed);
}
bool MediaService::play(std::uint32_t handle, bool loop, double offset) {
  auto voice = impl_->voice(handle);
  if (!voice || !std::isfinite(offset)) return false;
  std::lock_guard lock(voice->mutex);
  if (voice->failure || impl_->serviceFailed) return false;
  voice->emptyLoopRestart = false;
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
  if (!voice->mix.asset) voice->requestedSeek = offset;
  ++voice->generation;
  voice->mix.loop = loop; voice->mix.eof = !!voice->mix.asset; voice->mix.playing = impl_->device != 0;
  voice->mix.gain = 1.0F; voice->mix.targetGain = 1.0F; voice->mix.gainStep = 0.0F;
  voice->mix.stopAfterFade = false;
  return impl_->device != 0;
}
bool MediaService::setSuspended(std::uint32_t handle, bool suspended) {
  auto voice = impl_->voice(handle); if (!voice) return false;
  std::lock_guard lock(voice->mutex);
  voice->mix.suspended = suspended;
  return true;
}
bool MediaService::bindContext(std::uint32_t handle) {
  auto voice = impl_->voice(handle); if (!voice) return false;
  std::lock_guard lock(voice->mutex);
  voice->contextOwned = true;
  return true;
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
bool MediaService::setEqualPowerPan(std::uint32_t handle, float pan) {
  if (!std::isfinite(pan)) return false;
  auto voice = impl_->voice(handle); if (!voice) return false;
  std::lock_guard lock(voice->mutex);
  voice->mix.panMatrix = equalPowerPanMatrix(voice->sourceChannels, pan);
  voice->mix.pan = 0;
  return true;
}
bool MediaService::setStereoGains(std::uint32_t handle, float left, float right) {
  if (!std::isfinite(left) || !std::isfinite(right) || left < 0 || right < 0) return false;
  auto voice = impl_->voice(handle); if (!voice) return false;
  std::lock_guard lock(voice->mutex);
  voice->mix.leftGain = left;
  voice->mix.rightGain = right;
  return true;
}
bool MediaService::setStereoBalance(std::uint32_t handle, float pan) {
  if (!std::isfinite(pan)) return false;
  auto voice = impl_->voice(handle); if (!voice) return false;
  std::lock_guard lock(voice->mutex);
  voice->mix.pan = 0;
  voice->mix.leftGain = voice->mix.rightGain = 1;
  voice->mix.panMatrix = stereoBalanceMatrix(voice->sourceChannels, pan);
  return true;
}
bool MediaService::fade(std::uint32_t handle, float from, float to,
                        double duration, bool stopWhenFinished, bool absolute) {
  if (!std::isfinite(from) || !std::isfinite(to) || !std::isfinite(duration) || duration < 0) return false;
  auto voice = impl_->voice(handle); if (!voice) return false;
  std::lock_guard lock(voice->mutex);
  if (from >= 0.0F) voice->mix.gain = absolute ? from : std::clamp(from, 0.0F, 1.0F);
  voice->mix.targetGain = absolute ? std::max(0.0F, to) : std::clamp(to, 0.0F, 1.0F);
  voice->mix.stopAfterFade = stopWhenFinished;
  voice->mix.absoluteGainEnvelope = absolute;
  const double frames = duration * 48000;
  voice->mix.gainStep = frames > 0 ? (voice->mix.targetGain - voice->mix.gain) / frames : 0;
  if (frames <= 0) { voice->mix.gain = voice->mix.targetGain;
    if (stopWhenFinished && voice->mix.gain <= 0) voice->mix.playing = false; }
  return true;
}
bool MediaService::isPlaying(std::uint32_t handle) const {
  auto voice = impl_->voice(handle); if (!voice) return false;
  std::lock_guard lock(voice->mutex);
  return voice->mix.playing && !impl_->serviceFailed;
}
std::string MediaService::audioError(std::uint32_t handle) const {
  std::exception_ptr failure;
  {
    std::lock_guard lock(impl_->mutex);
    failure = impl_->serviceFailure;
  }
  if (auto voice = impl_->voice(handle)) {
    std::lock_guard lock(voice->mutex);
    if (voice->failure) failure = voice->failure;
  }
  if (!failure) return {};
  try { std::rethrow_exception(failure); }
  catch (const std::exception& error) { return error.what(); }
  catch (...) { return "audio decoder failed"; }
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
  std::lock_guard lock(voice->mutex); return voice->mix.asset ? voice->mix.asset->samples.size() / 2
    : voice->mix.samples.size() / 2;
}
bool MediaService::release(std::uint32_t handle) {
  std::lock_guard lock(impl_->mutex); return impl_->voices.erase(handle) != 0;
}
bool MediaService::audioAvailable() const { return impl_->device != 0; }

double MediaService::contextTime() const {
  return static_cast<double>(impl_->contextFrames.load(std::memory_order_acquire)) / 48000;
}
void MediaService::suspendContext(bool suspended) {
  if (impl_->device) SDL_LockAudioDevice(impl_->device);
  impl_->contextSuspended.store(suspended, std::memory_order_release);
  if (impl_->device) SDL_UnlockAudioDevice(impl_->device);
}
std::uint32_t MediaService::createGainAutomation(double initial) {
  if (!std::isfinite(initial)) throw std::invalid_argument("gain must be finite");
  std::lock_guard lock(impl_->mutex);
  const auto handle = impl_->nextAutomation++;
  impl_->automations.emplace(handle, std::make_shared<Impl::Automation>(initial));
  return handle;
}
bool MediaService::scheduleGain(std::uint32_t handle, bool linear, double value, double time, bool intrinsic) {
  std::shared_ptr<Impl::Automation> automation;
  { std::lock_guard lock(impl_->mutex);
    const auto found = impl_->automations.find(handle);
    if (found == impl_->automations.end()) return false;
    automation = found->second;
  }
  std::lock_guard lock(automation->mutex);
  if (intrinsic) return automation->timeline.setValue(value, contextTime());
  return automation->timeline.schedule(linear ? GainAutomation::Kind::linear : GainAutomation::Kind::set,
    value, time, contextTime());
}
bool MediaService::cancelGain(std::uint32_t handle, double time) {
  std::shared_ptr<Impl::Automation> automation;
  { std::lock_guard lock(impl_->mutex);
    const auto found = impl_->automations.find(handle);
    if (found == impl_->automations.end()) return false;
    automation = found->second;
  }
  std::lock_guard lock(automation->mutex);
  return automation->timeline.cancel(time);
}
double MediaService::gainValue(std::uint32_t handle) const {
  std::shared_ptr<Impl::Automation> automation;
  { std::lock_guard lock(impl_->mutex);
    const auto found = impl_->automations.find(handle);
    if (found == impl_->automations.end()) throw std::invalid_argument("gain handle is unavailable");
    automation = found->second;
  }
  std::lock_guard lock(automation->mutex);
  return automation->timeline.value();
}
bool MediaService::bindGain(std::uint32_t handle, std::uint32_t automationHandle) {
  const auto voice = impl_->voice(handle);
  if (!voice) return false;
  std::shared_ptr<Impl::Automation> automation;
  { std::lock_guard lock(impl_->mutex);
    const auto found = impl_->automations.find(automationHandle);
    if (found == impl_->automations.end()) return false;
    automation = found->second;
  }
  std::lock_guard lock(voice->mutex);
  voice->automation = std::move(automation);
  voice->contextOwned = true;
  return true;
}
bool MediaService::releaseGain(std::uint32_t handle) {
  std::lock_guard lock(impl_->mutex);
  return impl_->automations.erase(handle) != 0;
}
void MediaService::setMasterVolume(float volume) {
  if (std::isfinite(volume)) {
    impl_->masterVolume.store(std::clamp(volume, 0.0F, 1.0F), std::memory_order_relaxed);
  }
}
float MediaService::masterVolume() const {
  return impl_->masterVolume.load(std::memory_order_relaxed);
}
}  // namespace pmjs
