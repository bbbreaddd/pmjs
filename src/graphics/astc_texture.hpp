#pragma once
#include <cstddef>
#include <cstdint>
#include <span>
namespace pmjs {
inline std::size_t astc4x4Bytes(int width, int height) {
  return std::size_t((width + 3) / 4) * ((height + 3) / 4) * 16;
}
inline bool validAstc4x4(std::span<const std::uint8_t> bytes, int width, int height) {
  if (width <= 0 || height <= 0 || width > 8192 || height > 8192 ||
      bytes.size() != 16 + astc4x4Bytes(width, height)) return false;
  const auto dimension = [&](int i) { return int(bytes[i]) | (int(bytes[i+1]) << 8) | (int(bytes[i+2]) << 16); };
  return bytes[0] == 0x13 && bytes[1] == 0xab && bytes[2] == 0xa1 && bytes[3] == 0x5c &&
    bytes[4] == 4 && bytes[5] == 4 && bytes[6] == 1 && dimension(7) == width &&
    dimension(10) == height && dimension(13) == 1;
}
}
