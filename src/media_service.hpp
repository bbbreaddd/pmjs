#pragma once

#include "media_decoder.hpp"

#include <cstdint>
#include <filesystem>
#include <memory>
#include <vector>

namespace pmjs {

enum class AudioIntent { unknown, effect, music, ambient, jingle };

struct PreparedAudioPolicy {
  std::size_t cacheBytes = 16U * 1024U * 1024U;
  std::size_t maxAssetBytes = 2U * 1024U * 1024U;
  std::size_t maxSynchronousBytes = 256U * 1024U;
};

struct AudioLoadOptions {
  AudioIntent intent = AudioIntent::unknown;
  std::string resourceIdentity;
  std::filesystem::path sourcePath;
};

struct AudioCacheStats {
  bool diagnostics = false;
  std::uint64_t hits = 0, misses = 0;
  std::size_t cacheBytes = 0, livePcmBytes = 0, entries = 0;
  std::size_t sampleVoices = 0, streamVoices = 0;
  std::uint64_t loads = 0, decoderOpens = 0;
  std::uint64_t preparations = 0, admissions = 0, evictions = 0, rejections = 0;
  std::uint64_t sampleLoads = 0, streamLoads = 0, prepareUs = 0, decoderOpenUs = 0;
  std::uint64_t workerDecodeCalls = 0, workerDecodeUs = 0, workerCpuUs = 0;
  std::size_t peakCacheBytes = 0, peakLivePcmBytes = 0;
};

class MediaService {
 public:
  explicit MediaService(std::filesystem::path root);
  ~MediaService();
  MediaService(const MediaService&) = delete;
  MediaService& operator=(const MediaService&) = delete;

  std::uint32_t loadAudio(const std::string& path, std::string* error = nullptr,
                          const AudioLoadOptions& options = {});
  std::uint32_t installAudioDecoder(
      std::unique_ptr<AudioDecoderSession> decoder);
  std::uint32_t loadAudioBytes(std::vector<std::uint8_t> bytes,
                               std::string* error = nullptr,
                               const AudioLoadOptions& options = {});
  AudioCacheStats audioCacheStats() const;
  void setPreparedAudioPolicyForTesting(PreparedAudioPolicy policy);
  std::size_t sampleMemoryBytes() const;
  bool play(std::uint32_t handle, bool loop, double offset);
  bool stop(std::uint32_t handle);
  bool setSuspended(std::uint32_t handle, bool suspended);
  bool setParameters(std::uint32_t handle, float volume, float pitch, float pan);
  bool setStereoGains(std::uint32_t handle, float left, float right);
  bool setEqualPowerPan(std::uint32_t handle, float pan);
  bool fade(std::uint32_t handle, float from, float to, double duration,
            bool stopWhenFinished, bool absolute = false);
  void setMasterVolume(float volume);
  float masterVolume() const;
  bool isPlaying(std::uint32_t handle) const;
  double position(std::uint32_t handle) const;
  double duration(std::uint32_t handle) const;
  int sourceChannels(std::uint32_t handle) const;
  std::size_t bufferedFrames(std::uint32_t handle) const;
  bool release(std::uint32_t handle);
  bool audioAvailable() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace pmjs
