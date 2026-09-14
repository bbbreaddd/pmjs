#pragma once

#include "media_decoder.hpp"

#include <cstdint>
#include <filesystem>
#include <memory>
#include <vector>

namespace pmjs {

class MediaService {
 public:
  explicit MediaService(std::filesystem::path root);
  ~MediaService();
  MediaService(const MediaService&) = delete;
  MediaService& operator=(const MediaService&) = delete;

  std::uint32_t loadAudio(const std::string& path, std::string* error = nullptr);
  std::uint32_t loadAudioBytes(std::vector<std::uint8_t> bytes,
                               std::string* error = nullptr);
  bool play(std::uint32_t handle, bool loop, double offset);
  bool stop(std::uint32_t handle);
  bool setParameters(std::uint32_t handle, float volume, float pitch, float pan);
  bool fade(std::uint32_t handle, float from, float to, double duration,
            bool stopWhenFinished);
  void setMasterVolume(float volume);
  float masterVolume() const;
  bool isPlaying(std::uint32_t handle) const;
  double position(std::uint32_t handle) const;
  double duration(std::uint32_t handle) const;
  std::size_t bufferedFrames(std::uint32_t handle) const;
  bool release(std::uint32_t handle);
  bool audioAvailable() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace pmjs
