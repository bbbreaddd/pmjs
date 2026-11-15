#pragma once
#include <array>
#include <cstdint>
#include <vector>

namespace pmjs {
struct ImagePixels {
  int width = 0;
  int height = 0;
  std::vector<std::uint8_t> rgba;
};

struct ImageChannelStorage {
  int channels = 4;
  std::array<std::uint8_t, 4> source{0, 1, 2, 3};
  // Stored component indices, followed by constant zero and one.
  std::array<std::uint8_t, 4> swizzle{0, 1, 2, 3};
};

struct ImageStorageDecision {
  int width = 0, height = 0, paletteBits = 0;
  ImageChannelStorage channels;
  bool hasPixelFacts = false, opaque = false, allZero = false;
};

ImageChannelStorage imageChannelStorage(const ImagePixels& pixels);
ImageStorageDecision classifyImageStorage(const ImagePixels& pixels);
}
