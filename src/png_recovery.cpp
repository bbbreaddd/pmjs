#include "png_recovery.hpp"
#include "checked_bounds.hpp"

#include <algorithm>
#include <array>
#include <cstring>
#include <zlib.h>

namespace pmjs {
namespace {
constexpr std::array<std::uint8_t, 16> prefix = {
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 'I', 'H', 'D', 'R'
};
std::uint32_t read32(const std::uint8_t* data) {
  return (std::uint32_t(data[0]) << 24) | (std::uint32_t(data[1]) << 16) |
    (std::uint32_t(data[2]) << 8) | data[3];
}
void write32(std::uint8_t* data, std::uint32_t value) {
  for (int i = 3; i >= 0; --i) { data[i] = value & 255; value >>= 8; }
}
struct Chunk { std::size_t offset, length; };
}

std::optional<std::vector<std::uint8_t>> recoverPngBytes(
    std::span<const std::uint8_t> bytes, std::size_t maxDecodedBytes) {
  if (bytes.size() < 45 || bytes.size() > 64U * 1024U * 1024U) return std::nullopt;
  const auto headerCrc = crc32(crc32(0, prefix.data() + 12, 4), bytes.data() + 16, 13);
  if (headerCrc != read32(bytes.data() + 29)) return std::nullopt;
  const auto extent = checkedImageExtent(read32(bytes.data() + 16), read32(bytes.data() + 20), 8192, maxDecodedBytes);
  if (!extent || bytes[26] || bytes[27] || bytes[28]) return std::nullopt;
  auto repaired = std::vector<std::uint8_t>(bytes.begin(), bytes.end());
  const bool changedPrefix = !std::equal(prefix.begin(), prefix.end(), bytes.begin());
  std::copy(prefix.begin(), prefix.end(), repaired.begin());
  const auto* data = repaired.data();
  const auto depth = data[24], color = data[25];
  const int channels = color == 0 ? 1 : color == 2 ? 3 : color == 3 ? 1 :
    color == 4 ? 2 : color == 6 ? 4 : 0;
  if (!channels || !((depth == 8 || depth == 16) ||
      ((color == 0 || color == 3) && (depth == 1 || depth == 2 || depth == 4)))) return std::nullopt;
  if (color == 3 && depth == 16) return std::nullopt;
  std::vector<Chunk> chunks;
  std::vector<std::uint8_t> compressed;
  bool end = false, first = true, endedIdat = false;
  for (std::size_t offset = 8; offset + 12 <= bytes.size();) {
    const auto length = read32(data + offset);
    if (length > bytes.size() - offset - 12) return std::nullopt;
    if (crc32(0, data + offset + 4, length + 4) != read32(data + offset + 8 + length)) return std::nullopt;
    const auto* type = data + offset + 4;
    if (first && (length != 13 || std::memcmp(type, "IHDR", 4))) return std::nullopt;
    if (!first && !std::memcmp(type, "IHDR", 4)) return std::nullopt;
    first = false;
    if (!std::memcmp(type, "IDAT", 4)) {
      if (endedIdat) return std::nullopt;
      chunks.push_back({offset, length});
      compressed.insert(compressed.end(), data + offset + 8, data + offset + 8 + length);
    } else if (!compressed.empty()) endedIdat = true;
    offset += length + 12;
    if (!std::memcmp(type, "IEND", 4)) {
      if (length || offset != bytes.size()) return std::nullopt;
      end = true; break;
    }
  }
  if (!end || compressed.size() < 6 || (compressed[0] & 15) != 8 || (compressed[0] >> 4) > 7 ||
      ((unsigned(compressed[0]) << 8) | compressed[1]) % 31 || (compressed[1] & 32)) return std::nullopt;
  const auto rowBytes = (std::size_t(extent->width) * channels * depth + 7) / 8 + 1;
  const auto expectedBytes = rowBytes * extent->height;
  z_stream stream{};
  if (inflateInit2(&stream, -15) != Z_OK) return std::nullopt;
  stream.next_in = compressed.data() + 2;
  stream.avail_in = compressed.size() - 6;
  std::array<std::uint8_t, 32768> output{};
  uLong checksum = adler32(0, nullptr, 0);
  std::size_t count = 0;
  int status;
  bool valid = true;
  do {
    stream.next_out = output.data(); stream.avail_out = output.size();
    status = inflate(&stream, Z_NO_FLUSH);
    const auto produced = output.size() - stream.avail_out;
    if (produced > expectedBytes - std::min(count, expectedBytes)) { valid = false; break; }
    for (std::size_t i = 0; i < produced; ++i)
      if ((count + i) % rowBytes == 0 && output[i] > 4) valid = false;
    checksum = adler32(checksum, output.data(), produced);
    count += produced;
  } while (valid && status == Z_OK);
  valid &= status == Z_STREAM_END && stream.avail_in == 0 && count == expectedBytes;
  inflateEnd(&stream);
  if (!valid) return std::nullopt;
  const bool changedChecksum = checksum != read32(compressed.data() + compressed.size() - 4);
  if (!changedPrefix && !changedChecksum) return std::nullopt;
  write32(compressed.data() + compressed.size() - 4, checksum);
  std::size_t consumed = 0;
  for (const auto& chunk : chunks) {
    std::copy_n(compressed.data() + consumed, chunk.length, repaired.data() + chunk.offset + 8);
    write32(repaired.data() + chunk.offset + chunk.length + 8,
      crc32(0, repaired.data() + chunk.offset + 4, chunk.length + 4));
    consumed += chunk.length;
  }
  return repaired;
}

}  // namespace pmjs
