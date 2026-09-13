#pragma once

#include <cstddef>
#include <cstdint>

namespace pmjs::scene_packet {

constexpr std::uint32_t version = 27;
constexpr std::size_t metadataStride = 7;
constexpr std::size_t valueStride = 41;
constexpr std::size_t maxNodes = 65536;
constexpr std::size_t maxPacketBytes = 16U * 1024U * 1024U;
constexpr std::uint32_t noParent = 0xffffffffU;

enum class NodeKind : std::uint32_t {
  container = 0,
  sprite = 1,
  tilingSprite = 2,
  screenFill = 3,
  tileLayer = 4,
  toneAdjust = 5,
  filterBegin = 6,
  filterEnd = 7,
  mesh = 8,
};

enum class FilterKind : std::uint32_t {
  blur = 0,
  displacement = 1,
  noiseGlitch = 2,
  alphaMask = 3,
  zoomBlur = 4,
  shockwave = 5,
  advancedBloom = 6,
  crt = 7,
  adjustment = 8,
  pixelate = 9,
  rgbSplit = 10,
  bulgePinch = 11,
  twist = 12,
  ascii = 13,
  dot = 14,
  emboss = 15,
  crossHatch = 16,
  radialBlur = 17,
  reflection = 18,
  motionBlur = 19,
  alpha = 20,
  oldFilm = 21,
  glow = 22,
  godray = 23,
  kawaseBlur = 24,
  colorMatrix = 25,
  pictureBlend = 26,
  blurX = 27,
  blurY = 28,
  fxaa = 29,
};

constexpr std::size_t maxFilterDepth = 4;

enum NodeFlags : std::uint32_t {
  hasClipRectangle = 1U << 0U,
  hasBlurFilter = 1U << 1U,
  hasAlphaMask = 1U << 2U,
  nearestSampling = 1U << 3U,
  hasSpriteColor = 1U << 4U,
  textureRotationMask = 7U << 5U,
  textureRotationShift = 5U,
  roundPixels = 1U << 8U,
};

// All packet validators share this mask so accepted flags cannot diverge.
constexpr std::uint32_t kAllowedNodeFlags =
    NodeFlags::hasClipRectangle | NodeFlags::hasBlurFilter |
    NodeFlags::hasAlphaMask | NodeFlags::nearestSampling |
    NodeFlags::hasSpriteColor | NodeFlags::textureRotationMask |
    NodeFlags::roundPixels;

static_assert((kAllowedNodeFlags & NodeFlags::roundPixels) != 0U,
              "scene packet validators must accept roundPixels");
static_assert((kAllowedNodeFlags & NodeFlags::textureRotationMask) ==
                  NodeFlags::textureRotationMask,
              "scene packet validators must accept texture rotation bits");

}  // namespace pmjs::scene_packet
