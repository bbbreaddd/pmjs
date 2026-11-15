#include "encrypted_audio_file.hpp"

#include <algorithm>
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <stdexcept>
#include <sys/stat.h>
#include <unistd.h>

namespace pmjs {

EncryptedAudioFile::EncryptedAudioFile(const std::filesystem::path& path, AudioEncryptionKey key)
    : key_(key) {
  const int descriptor = ::open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NONBLOCK);
  if (descriptor < 0) throw std::runtime_error("cannot open encrypted audio");
  try {
    struct stat info{};
    if (::fstat(descriptor, &info) || !S_ISREG(info.st_mode) || info.st_size < 32)
      throw std::runtime_error("encrypted audio is not a complete regular file");
    std::array<std::uint8_t, 32> header{};
    std::size_t position = 0;
    while (position < header.size()) {
      const auto count = ::pread(descriptor, header.data() + position, header.size() - position, position);
      if (count < 0 && errno == EINTR) continue;
      if (count <= 0) throw std::runtime_error("cannot read encrypted audio header");
      position += static_cast<std::size_t>(count);
    }
    constexpr std::array<std::uint8_t, 16> signature{
      0x52, 0x50, 0x47, 0x4d, 0x56, 0, 0, 0, 0, 3, 1, 0, 0, 0, 0, 0};
    if (!std::equal(signature.begin(), signature.end(), header.begin()))
      throw std::runtime_error("invalid encrypted audio signature");
    for (std::size_t i = 0; i < key_.size(); ++i) header[16 + i] ^= key_[i];
    const auto* bytes = header.data() + 16;
    if (std::memcmp(bytes, "OggS", 4) && std::memcmp(bytes + 4, "ftyp", 4) &&
        (std::memcmp(bytes, "RIFF", 4) || std::memcmp(bytes + 8, "WAVE", 4)))
      throw std::runtime_error("encrypted audio key or media header is invalid");
    descriptor_ = descriptor;
    size_ = info.st_size - 16;
  } catch (...) { ::close(descriptor); throw; }
}

EncryptedAudioFile::~EncryptedAudioFile() { if (descriptor_ >= 0) ::close(descriptor_); }

std::size_t EncryptedAudioFile::read(std::int64_t offset, std::span<std::uint8_t> output) const {
  if (offset < 0 || offset > size_) throw std::runtime_error("encrypted audio offset is out of bounds");
  const auto wanted = std::min<std::uint64_t>(output.size(), size_ - offset);
  if (!wanted) return 0;
  ssize_t count;
  do { count = ::pread(descriptor_, output.data(), wanted, offset + 16); }
  while (count < 0 && errno == EINTR);
  if (count < 0) throw std::runtime_error("cannot read encrypted audio");
  for (std::int64_t i = offset; i < std::min<std::int64_t>(16, offset + count); ++i)
    output[static_cast<std::size_t>(i - offset)] ^= key_[static_cast<std::size_t>(i)];
  return static_cast<std::size_t>(count);
}

}  // namespace pmjs
