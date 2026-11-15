#pragma once

#include <array>
#include <cstdint>
#include <filesystem>
#include <span>

namespace pmjs {

using AudioEncryptionKey = std::array<std::uint8_t, 16>;

class EncryptedAudioFile {
 public:
  EncryptedAudioFile(const std::filesystem::path& path, AudioEncryptionKey key);
  ~EncryptedAudioFile();
  EncryptedAudioFile(const EncryptedAudioFile&) = delete;
  EncryptedAudioFile& operator=(const EncryptedAudioFile&) = delete;
  std::int64_t size() const { return size_; }
  std::size_t read(std::int64_t offset, std::span<std::uint8_t> output) const;

 private:
  int descriptor_ = -1;
  std::int64_t size_ = 0;
  AudioEncryptionKey key_;
};

}  // namespace pmjs
