#include "file_identity.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <fcntl.h>
#include <optional>
#include <sys/stat.h>
#include <unistd.h>
extern "C" {
#include <libavutil/mem.h>
#include <libavutil/sha.h>
}

namespace pmjs {
std::string fileIdentity(const std::filesystem::path& path, const struct stat& info) {
  return path.generic_string() + ':' + std::to_string(info.st_dev) + ':' +
    std::to_string(info.st_ino) + ':' + std::to_string(info.st_size) + ':' +
    std::to_string(info.st_mtim.tv_sec) + ':' + std::to_string(info.st_mtim.tv_nsec) + ':' +
    std::to_string(info.st_ctim.tv_sec) + ':' + std::to_string(info.st_ctim.tv_nsec);
}
std::string fileIdentity(const std::filesystem::path& path) {
  std::error_code error;
  const auto resolved = std::filesystem::canonical(path, error);
  struct stat info{};
  if (error || ::stat(resolved.c_str(), &info) != 0 || !S_ISREG(info.st_mode)) return {};
  return fileIdentity(resolved, info);
}

bool validContentHash(const std::string& hash) {
  return hash.size() == 64 && std::all_of(hash.begin(), hash.end(), [](char c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
  });
}

bool contentHashMatches(std::span<const std::uint8_t> bytes, const std::string& expected) {
  if (!validContentHash(expected)) return false;
  auto* context = av_sha_alloc();
  if (!context) return false;
  if (av_sha_init(context, 256) != 0) { av_free(context); return false; }
  av_sha_update(context, bytes.data(), bytes.size());
  std::array<std::uint8_t, 32> digest{};
  av_sha_final(context, digest.data());
  av_free(context);
  constexpr char hex[] = "0123456789abcdef";
  for (std::size_t i = 0; i < digest.size(); ++i)
    if (expected[i * 2] != hex[digest[i] >> 4] || expected[i * 2 + 1] != hex[digest[i] & 15]) return false;
  return true;
}

std::optional<std::string> identityWithoutInode(const std::string& key) {
  // Paths may contain colons; the seven numeric identity fields are at the end.
  std::array<std::size_t, 7> separators{};
  std::size_t end = key.size();
  for (auto& separator : separators) {
    if (!end) return std::nullopt;
    separator = key.rfind(':', end - 1);
    if (separator == std::string::npos || separator + 1 == end ||
        !std::all_of(key.begin() + separator + 1, key.begin() + end,
          [](char c) { return c >= '0' && c <= '9'; })) return std::nullopt;
    end = separator;
  }
  return key.substr(0, separators[5]) + key.substr(separators[4]);
}

bool inodeOnlyChange(const std::string& expected, const std::string& actual) {
  const auto before = identityWithoutInode(expected), after = identityWithoutInode(actual);
  return before && after && *before == *after;
}

bool fileContentMatches(const std::filesystem::path& path, const std::string& identity,
                        const std::string& expectedHash) {
  if (!validContentHash(expectedHash)) return false;
  const int fd = ::open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NONBLOCK);
  if (fd < 0) return false;
  struct Close { int fd; ~Close() { ::close(fd); } } close{fd};
  struct stat before{}, after{};
  if (::fstat(fd, &before) != 0 || !S_ISREG(before.st_mode) || before.st_size < 0 ||
      fileIdentity(path) != identity) return false;
  auto* context = av_sha_alloc();
  if (!context) return false;
  struct Free { AVSHA* value; ~Free() { av_free(value); } } free{context};
  if (av_sha_init(context, 256) != 0) return false;
  std::array<std::uint8_t, 65536> bytes{};
  off_t offset = 0;
  while (offset < before.st_size) {
    const auto count = ::pread(fd, bytes.data(), std::min<std::uint64_t>(bytes.size(), before.st_size - offset), offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return false;
    av_sha_update(context, bytes.data(), count); offset += count;
  }
  if (::fstat(fd, &after) != 0 || before.st_dev != after.st_dev || before.st_ino != after.st_ino ||
      before.st_size != after.st_size || before.st_mtim.tv_sec != after.st_mtim.tv_sec ||
      before.st_mtim.tv_nsec != after.st_mtim.tv_nsec || before.st_ctim.tv_sec != after.st_ctim.tv_sec ||
      before.st_ctim.tv_nsec != after.st_ctim.tv_nsec || fileIdentity(path) != identity) return false;
  // Ensure the path still names the object that was hashed.
  struct stat named{};
  if (::stat(path.c_str(), &named) != 0 || named.st_dev != after.st_dev || named.st_ino != after.st_ino) return false;
  std::array<std::uint8_t, 32> digest{}; av_sha_final(context, digest.data());
  constexpr char hex[] = "0123456789abcdef";
  for (std::size_t i = 0; i < digest.size(); ++i)
    if (expectedHash[i*2] != hex[digest[i] >> 4] || expectedHash[i*2+1] != hex[digest[i] & 15]) return false;
  return true;
}
}
