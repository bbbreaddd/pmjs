#include "renderer.hpp"
#include "scene_packet.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <stdexcept>

namespace pmjs {

bool Renderer::queueScene(std::uint32_t version, const std::uint32_t* metadata,
                          std::size_t metadataCount, const float* values,
                          std::size_t valueCount, std::size_t nodeCount) {
  using namespace scene_packet;
  if (version != scene_packet::version || !metadata || !values ||
      nodeCount > maxNodes ||
      metadataCount < nodeCount * metadataStride ||
      valueCount < nodeCount * valueStride ||
      nodeCount * (metadataStride * sizeof(std::uint32_t) +
                   valueStride * sizeof(float)) > maxPacketBytes) return false;

  for (std::size_t index = 0; index < nodeCount * valueStride; ++index) {
    if (!std::isfinite(values[index])) return false;
  }

  const std::size_t originalCommandCount = frame_.commands.size();
  const auto build = [&]() -> bool {

  struct SceneState {
    std::array<float, 6> world{1, 0, 0, 1, 0, 0};
    float alpha = 1;
    std::array<int, 4> clip{};
    bool clipped = false;
    ImageHandle maskImage = 0;
    std::array<float, 6> maskTransform{};
  };
  std::vector<SceneState> states(nodeCount);
  std::size_t filterDepth = 0;
  for (std::size_t index = 0; index < nodeCount; ++index) {
    const std::size_t metadataOffset = index * metadataStride;
    const std::size_t valueOffset = index * valueStride;
    const std::uint32_t kind = metadata[metadataOffset];
    const std::uint32_t parentIndex = metadata[metadataOffset + 1];
    const std::uint32_t resource = metadata[metadataOffset + 2];
    const std::uint32_t tint = metadata[metadataOffset + 3];
    const auto blendValue = metadata[metadataOffset + 4];
    const auto flags = metadata[metadataOffset + 5];
    const auto maskImage = metadata[metadataOffset + 6];
    const bool filterMarker =
      kind == static_cast<std::uint32_t>(NodeKind::filterBegin) ||
      kind == static_cast<std::uint32_t>(NodeKind::filterEnd);
    if (kind != static_cast<std::uint32_t>(NodeKind::toneAdjust) &&
        !filterMarker &&
        blendValue > static_cast<std::uint32_t>(BlendMode::screen)) return false;
    const auto blendMode = static_cast<BlendMode>(blendValue);
    if (parentIndex != noParent && parentIndex >= index) return false;
    if (flags & ~scene_packet::kAllowedNodeFlags) {
      return false;
    }
    const auto textureRotation = static_cast<std::uint8_t>(
      (flags & NodeFlags::textureRotationMask) >> NodeFlags::textureRotationShift);
    if (textureRotation != 0 &&
        kind != static_cast<std::uint32_t>(NodeKind::sprite)) return false;
    if ((flags & NodeFlags::roundPixels) &&
        kind != static_cast<std::uint32_t>(NodeKind::sprite)) return false;

    const std::array<float, 6> local = {
      values[valueOffset], values[valueOffset + 1],
      values[valueOffset + 2], values[valueOffset + 3],
      values[valueOffset + 4], values[valueOffset + 5]
    };
    const SceneState parent = parentIndex == noParent
      ? SceneState{} : states[parentIndex];
    SceneState& state = states[index];
    state.world = {
      parent.world[0] * local[0] + parent.world[2] * local[1],
      parent.world[1] * local[0] + parent.world[3] * local[1],
      parent.world[0] * local[2] + parent.world[2] * local[3],
      parent.world[1] * local[2] + parent.world[3] * local[3],
      parent.world[0] * local[4] + parent.world[2] * local[5] + parent.world[4],
      parent.world[1] * local[4] + parent.world[3] * local[5] + parent.world[5],
    };
    state.alpha = parent.alpha * values[valueOffset + 6];
    state.clip = parent.clip;
    state.clipped = parent.clipped;
    state.maskImage = parent.maskImage;
    state.maskTransform = parent.maskTransform;
    if (flags & NodeFlags::hasAlphaMask) {
      if (state.maskImage || !images_.lookup(maskImage)) return false;
      state.maskImage = maskImage;
      std::copy_n(values + valueOffset + 22, 6, state.maskTransform.begin());
    }
    if (flags & NodeFlags::hasClipRectangle) {
      const float left = values[valueOffset + 17];
      const float top = values[valueOffset + 18];
      const float right = values[valueOffset + 19];
      const float bottom = values[valueOffset + 20];
      if (!std::isfinite(left) || !std::isfinite(top) ||
          !std::isfinite(right) || !std::isfinite(bottom) ||
          right < left || bottom < top) return false;
      std::array<int, 4> own = {
        static_cast<int>(std::floor(std::max(left, 0.0F))),
        static_cast<int>(std::floor(std::max(top, 0.0F))),
        static_cast<int>(std::ceil(std::max(right, 0.0F))),
        static_cast<int>(std::ceil(std::max(bottom, 0.0F))),
      };
      if (state.clipped) {
        own = {std::max(own[0], state.clip[0]),
               std::max(own[1], state.clip[1]),
               std::min(own[2], state.clip[2]),
               std::min(own[3], state.clip[3])};
      }
      state.clip = own;
      state.clipped = true;
    }
    if (filterMarker) {
      if (maskImage != 0 || flags & ~NodeFlags::hasClipRectangle) return false;
      RenderCommand command;
      command.clip = state.clip;
      command.clipped = state.clipped;
      if (kind == static_cast<std::uint32_t>(NodeKind::filterBegin)) {
        if (filterDepth >= maxFilterDepth ||
            blendValue > static_cast<std::uint32_t>(FilterKind::fxaa)) {
          return false;
        }
        command.action = RenderCommand::Action::filterBegin;
        command.filterKind = static_cast<FilterKind>(blendValue);
        std::copy_n(values + valueOffset + 7, 10,
                    command.filterParameters.begin());
        std::copy_n(values + valueOffset + 22, 11,
                    command.filterParameters.begin() + 10);
        command.filterResolution = values[valueOffset + 33];
        if (command.filterResolution == 0.0F) command.filterResolution = 1.0F;
        if (!std::isfinite(command.filterResolution) ||
            command.filterResolution <= 0.0F ||
            command.filterResolution > 16.0F) return false;
        if (command.filterKind == FilterKind::blur) {
          if (resource != 0 || command.filterParameters[0] < 0 ||
              command.filterParameters[1] < 1 ||
              command.filterParameters[1] > 15) return false;
        } else if (command.filterKind == FilterKind::blurX ||
                   command.filterKind == FilterKind::blurY) {
          if (resource != 0 || command.filterParameters[0] < 0 ||
              command.filterParameters[1] < 1 ||
              command.filterParameters[1] > 15) return false;
        } else if (command.filterKind == FilterKind::fxaa) {
          if (resource != 0) return false;
        } else if (command.filterKind == FilterKind::displacement) {
          if (!images_.lookup(resource) || command.filterParameters[2] <= 0 ||
              command.filterParameters[3] <= 0) return false;
          if (!images_.beginUse(resource)) return false;
          command.image = resource;
        } else if (command.filterKind == FilterKind::alphaMask) {
          if (!images_.lookup(resource) || command.filterParameters[8] <= 0 ||
              command.filterParameters[9] <= 0 ||
              command.filterParameters[10] < 0 ||
              command.filterParameters[10] > 1 ||
              (command.filterParameters[11] != 0 &&
               command.filterParameters[11] != 1) ||
              command.filterParameters[12] < 0 ||
              command.filterParameters[12] > 14 ||
              std::fmod(command.filterParameters[12], 2.0F) != 0 ||
              command.filterParameters[13] <= 0 ||
              command.filterParameters[14] <= 0) return false;
          if (!images_.beginUse(resource)) return false;
          command.image = resource;
        } else if (command.filterKind == FilterKind::noiseGlitch) {
          if (resource != 0 || command.filterParameters[0] < 0 ||
              command.filterParameters[2] < 0) return false;
        } else if (command.filterKind == FilterKind::zoomBlur) {
          if (resource != 0 || command.filterParameters[3] < 0) return false;
        } else if (command.filterKind == FilterKind::shockwave) {
          if (resource != 0 || command.filterParameters[3] < 0) return false;
        } else if (command.filterKind == FilterKind::advancedBloom) {
          if (resource != 0 || command.filterParameters[3] < 1 ||
              command.filterParameters[3] > 12 ||
              command.filterParameters[4] <= 0 ||
              command.filterParameters[5] <= 0) return false;
        } else if (command.filterKind == FilterKind::crt) {
          if (resource != 0 || command.filterParameters[1] < 0 ||
              command.filterParameters[4] < 0 ||
              command.filterParameters[5] < 0 ||
              command.filterParameters[6] < 0 ||
              command.filterParameters[8] < 0) return false;
        } else if (command.filterKind == FilterKind::adjustment) {
          if (resource != 0 || command.filterParameters[0] <= 0) return false;
        } else if (command.filterKind == FilterKind::pixelate) {
          if (resource != 0 || command.filterParameters[0] < 1 ||
              command.filterParameters[1] < 1) return false;
        } else if (command.filterKind == FilterKind::rgbSplit) {
          if (resource != 0) return false;
        } else if (command.filterKind == FilterKind::bulgePinch) {
          if (resource != 0 || command.filterParameters[2] < 0) return false;
        } else if (command.filterKind == FilterKind::twist) {
          if (resource != 0 || command.filterParameters[2] < 0) return false;
        } else if (command.filterKind == FilterKind::ascii) {
          if (resource != 0 || command.filterParameters[0] < 1) return false;
        } else if (command.filterKind == FilterKind::dot ||
                   command.filterKind == FilterKind::emboss ||
                   command.filterKind == FilterKind::crossHatch) {
          if (resource != 0) return false;
        } else if (command.filterKind == FilterKind::radialBlur) {
          if (resource != 0 || command.filterParameters[3] < 1 ||
              command.filterParameters[3] > 64) return false;
        } else if (command.filterKind == FilterKind::reflection) {
          if (resource != 0) return false;
        } else if (command.filterKind == FilterKind::motionBlur) {
          if (resource != 0 || command.filterParameters[2] < 1 ||
              command.filterParameters[2] > 64) return false;
        } else if (command.filterKind == FilterKind::alpha) {
          if (resource != 0 || command.filterParameters[0] < 0) return false;
        } else if (command.filterKind == FilterKind::oldFilm) {
          if (resource != 0 || command.filterParameters[0] < 0 ||
              command.filterParameters[1] < 0 ||
              command.filterParameters[2] < 0 ||
              command.filterParameters[4] < 0 ||
              command.filterParameters[5] < 0 ||
              command.filterParameters[6] < 0 ||
              command.filterParameters[8] < 0) return false;
        } else if (command.filterKind == FilterKind::glow) {
          if (resource != 0 || command.filterParameters[0] < 0 ||
              command.filterParameters[0] > 32 ||
              command.filterParameters[6] <= 0) return false;
        } else if (command.filterKind == FilterKind::godray) {
          if (resource != 0) return false;
        } else if (command.filterKind == FilterKind::kawaseBlur) {
          if (resource != 0 || command.filterParameters[0] < 1 ||
              command.filterParameters[0] > 15 ||
              command.filterParameters[1] <= 0 ||
              command.filterParameters[2] <= 0) return false;
        } else if (command.filterKind == FilterKind::colorMatrix) {
          if (resource != 0 || command.filterParameters[20] < 0 ||
              command.filterParameters[20] > 1) return false;
        } else if (command.filterKind == FilterKind::pictureBlend) {
          if (resource != 0 || (command.filterParameters[0] != 0 &&
              command.filterParameters[0] != 1)) return false;
        }
        ++filterDepth;
      } else {
        if (filterDepth == 0 || blendValue != 0 || resource != 0) return false;
        command.action = RenderCommand::Action::filterEnd;
        --filterDepth;
      }
      try {
        frame_.commands.push_back(command);
      } catch (...) {
        if (command.image) images_.endUse(command.image);
        throw;
      }
      continue;
    }
    if (kind == static_cast<std::uint32_t>(NodeKind::container) ||
        state.alpha <= 0) continue;
    if ((flags & NodeFlags::hasBlurFilter) &&
      kind != static_cast<std::uint32_t>(NodeKind::sprite)) return false;
    if (state.maskImage && kind != static_cast<std::uint32_t>(NodeKind::sprite) &&
        kind != static_cast<std::uint32_t>(NodeKind::tileLayer) &&
        kind != static_cast<std::uint32_t>(NodeKind::mesh) &&
        kind != static_cast<std::uint32_t>(NodeKind::container)) return false;

    if (kind == static_cast<std::uint32_t>(NodeKind::screenFill)) {
      const float red = static_cast<float>((tint >> 16U) & 0xffU) / 255.0F;
      const float green = static_cast<float>((tint >> 8U) & 0xffU) / 255.0F;
      const float blue = static_cast<float>(tint & 0xffU) / 255.0F;
      queueQuad(0, 0, static_cast<float>(queueWidth_),
                static_cast<float>(queueHeight_),
                {red, green, blue, state.alpha});
      frame_.commands.back().primitive = RenderCommand::Primitive::screenFill;
      frame_.commands.back().clip = state.clip;
      frame_.commands.back().clipped = state.clipped;
      continue;
    }
    if (kind == static_cast<std::uint32_t>(NodeKind::toneAdjust)) {
      RenderCommand command;
      std::copy_n(values + valueOffset + 7, 20, command.colorMatrix.begin());
      command.color[3] = state.alpha;
      command.appliesColorMatrix = true;
      frame_.commands.push_back(command);
      continue;
    }
    if (kind == static_cast<std::uint32_t>(NodeKind::tileLayer) ||
        kind == static_cast<std::uint32_t>(NodeKind::mesh)) {
      const std::array<float, 2> animation =
        kind == static_cast<std::uint32_t>(NodeKind::tileLayer)
          ? std::array<float, 2>{values[valueOffset + 15],
                                 values[valueOffset + 16]}
          : std::array<float, 2>{0, 0};
      if (!queueTileLayer(resource, state.world,
            animation,
            state.alpha, tint, blendMode)) return false;
      frame_.commands.back().clip = state.clip;
      frame_.commands.back().clipped = state.clipped;
      if (state.maskImage && !images_.beginUse(state.maskImage)) return false;
      frame_.commands.back().maskImage = state.maskImage;
      frame_.commands.back().maskTransform = state.maskTransform;
      frame_.commands.back().nearest =
        kind == static_cast<std::uint32_t>(NodeKind::tileLayer) ||
        (flags & NodeFlags::nearestSampling);
      frame_.commands.back().primitive =
        kind == static_cast<std::uint32_t>(NodeKind::tileLayer)
          ? RenderCommand::Primitive::tileLayer
          : RenderCommand::Primitive::mesh;
      continue;
    }

    auto placed = state.world;
    const float localX = values[valueOffset + 7];
    const float localY = values[valueOffset + 8];
    placed[4] += state.world[0] * localX + state.world[2] * localY;
    placed[5] += state.world[1] * localX + state.world[3] * localY;
    const std::array<float, 2> destination = {
      values[valueOffset + 13], values[valueOffset + 14]
    };
    const auto corner = [&](float x, float y) {
      return std::array<float, 2>{placed[0] * x + placed[2] * y + placed[4],
                                  placed[1] * x + placed[3] * y + placed[5]};
    };
    const auto p0 = corner(0, 0);
    const auto p1 = corner(destination[0], 0);
    const auto p2 = corner(destination[0], destination[1]);
    const auto p3 = corner(0, destination[1]);
    const float minimumX = std::min({p0[0], p1[0], p2[0], p3[0]});
    const float maximumX = std::max({p0[0], p1[0], p2[0], p3[0]});
    const float minimumY = std::min({p0[1], p1[1], p2[1], p3[1]});
    const float maximumY = std::max({p0[1], p1[1], p2[1], p3[1]});
    if (filterDepth == 0 &&
        (maximumX <= 0 || maximumY <= 0 || minimumX >= queueWidth_ ||
         minimumY >= queueHeight_)) continue;

    if (kind == static_cast<std::uint32_t>(NodeKind::sprite)) {
      if (!queueImage(resource, placed,
            {values[valueOffset + 9], values[valueOffset + 10],
             values[valueOffset + 11], values[valueOffset + 12]},
            state.alpha, tint, blendMode)) return false;
    } else if (kind == static_cast<std::uint32_t>(NodeKind::tilingSprite)) {
      if (!queueTiled(resource, placed,
            {values[valueOffset + 9], values[valueOffset + 10],
             values[valueOffset + 11], values[valueOffset + 12]},
            destination, state.alpha, tint, blendMode)) return false;
    } else {
      return false;
    }
    frame_.commands.back().clip = state.clip;
    frame_.commands.back().clipped = state.clipped;
    frame_.commands.back().blur =
      flags & NodeFlags::hasBlurFilter ? values[valueOffset + 21] : 0.0F;
    frame_.commands.back().nearest = flags & NodeFlags::nearestSampling;
    frame_.commands.back().roundPixels = flags & NodeFlags::roundPixels;
    frame_.commands.back().textureRotation = textureRotation;
    frame_.commands.back().primitive =
      kind == static_cast<std::uint32_t>(NodeKind::tilingSprite)
        ? RenderCommand::Primitive::tilingSprite
        : RenderCommand::Primitive::sprite;
    frame_.commands.back().appliesSpriteColor = flags & NodeFlags::hasSpriteColor;
    if (frame_.commands.back().appliesSpriteColor) {
      if (kind != static_cast<std::uint32_t>(NodeKind::sprite)) return false;
      std::copy_n(values + valueOffset + 33, 4,
                  frame_.commands.back().colorTone.begin());
      std::copy_n(values + valueOffset + 37, 4,
                  frame_.commands.back().blendColor.begin());
      if (frame_.commands.back().colorTone[3] < 0 ||
          frame_.commands.back().colorTone[3] > 1 ||
          frame_.commands.back().blendColor[3] < 0 ||
          frame_.commands.back().blendColor[3] > 1) return false;
    }
    if (!std::isfinite(frame_.commands.back().blur) ||
        frame_.commands.back().blur < 0) return false;
    if (state.maskImage && !images_.beginUse(state.maskImage)) return false;
    frame_.commands.back().maskImage = state.maskImage;
    frame_.commands.back().maskTransform = state.maskTransform;
  }
  return filterDepth == 0;
  };

  try {
    if (build()) return true;
  } catch (...) {
    discardCommandsFrom(originalCommandCount);
    throw;
  }
  discardCommandsFrom(originalCommandCount);
  return false;
}


}  // namespace pmjs
