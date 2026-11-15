#include "image_storage.hpp"
#include <algorithm>
#include <cstring>
#include <unordered_set>
namespace pmjs {
ImageChannelStorage imageChannelStorage(const ImagePixels& pixels) {
  if (pixels.width == 1 && pixels.height == 1) return {};
  bool opaqueGray = true, gray = true;
  for (std::size_t i = 0; i < pixels.rgba.size(); i += 4) {
    if (pixels.rgba[i] != pixels.rgba[i+1] || pixels.rgba[i] != pixels.rgba[i+2]) {
      gray = false;
      break;
    }
    opaqueGray &= pixels.rgba[i+3] == 255;
  }
  const int grayscale = gray ? (opaqueGray ? 1 : 2) : 4;
  if (grayscale == 1) return {1, {0, 1, 2, 3}, {0, 0, 0, 5}};
  if (grayscale == 2) return {2, {0, 3, 1, 2}, {0, 0, 0, 1}};
  std::array<bool, 3> zero{true, true, true}, one{true, true, true};
  std::array<std::array<bool, 3>, 3> equal{{{true, true, true}, {true, true, true}, {true, true, true}}};
  bool opaque = true;
  for (std::size_t i = 0; i < pixels.rgba.size(); i += 4) {
    const auto* pixel = pixels.rgba.data() + i;
    for (int c = 0; c < 3; ++c) {
      zero[c] &= pixel[c] == 0;
      one[c] &= pixel[c] == 255;
      for (int previous = 0; previous < c; ++previous)
        equal[previous][c] &= pixel[previous] == pixel[c];
    }
    if (!zero[0] && !zero[1] && !zero[2] && !one[0] && !one[1] && !one[2] &&
        !equal[0][1] && !equal[0][2] && !equal[1][2]) return {};
    opaque &= pixel[3] == 255;
  }
  ImageChannelStorage result{0};
  for (int c = 0; c < 3; ++c) {
    if (zero[c]) result.swizzle[c] = 4;
    else if (opaque && one[c]) result.swizzle[c] = 5;
    else {
      int component = 0;
      for (; component < result.channels; ++component) {
        const int previous = result.source[component];
        if (equal[previous][c]) break;
      }
      if (component == result.channels) result.source[result.channels++] = static_cast<std::uint8_t>(c);
      result.swizzle[c] = static_cast<std::uint8_t>(component);
    }
  }
  if (opaque) result.swizzle[3] = 5;
  else {
    // Keep alpha separate: an RGB/alpha equality need not survive premultiplication.
    result.source[result.channels] = 3;
    result.swizzle[3] = static_cast<std::uint8_t>(result.channels++);
  }
  if (result.channels > 2) return {};
  result.channels = std::max(1, result.channels);
  return result;
}

ImageStorageDecision classifyImageStorage(const ImagePixels& pixels) {
  ImageStorageDecision result{pixels.width, pixels.height, 0, imageChannelStorage(pixels)};
  result.hasPixelFacts = true;
  result.opaque = true;
  result.allZero = true;
  for (std::size_t i = 0; i < pixels.rgba.size(); i += 4) {
    result.opaque &= pixels.rgba[i+3] == 255;
    result.allZero &= !(pixels.rgba[i] || pixels.rgba[i+1] || pixels.rgba[i+2] || pixels.rgba[i+3]);
  }
  if (result.channels.channels == 1) return result;
  const std::size_t limit = result.channels.channels == 2 ? 256 : 65536;
  std::unordered_set<std::uint32_t> colors;
  for (std::size_t i = 0; i < pixels.rgba.size(); i += 4) {
    std::uint32_t key;
    std::memcpy(&key, pixels.rgba.data() + i, 4);
    colors.insert(key);
    if (colors.size() > limit) return result;
  }
  const int bits = colors.size() <= 256 ? 8 : 16;
  if (pixels.rgba.size()/4*(result.channels.channels - bits/8) <=
      ((colors.size()+255)/256)*1024) return result;
  result.paletteBits = bits;
  result.channels = {};
  return result;
}

}
