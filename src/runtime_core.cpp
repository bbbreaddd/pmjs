#include "runtime_core.hpp"
#include "scene_packet.hpp"

#include <cstdlib>
#include <iostream>
#include <utility>
#include <vector>

namespace pmjs {

RuntimeCore::RuntimeCore(const std::filesystem::path& root, int width, int height,
                         const std::string& title)
    : width_(width), height_(height), platform_(width, height, title),
      canvases_(images_), renderer_(width, height, images_), vfs_(root),
      media_(root),
      dialog_(platform_, renderer_, canvases_, vfs_, width, height) {}

std::optional<ImageHandle> RuntimeCore::resolveImage(std::uint32_t handle) {
  return images_.lookup(handle) ? std::optional<ImageHandle>{handle}
                                : canvases_.prepareImage(handle);
}

bool RuntimeCore::submitScene(std::uint32_t version,
                              const std::uint32_t* metadata,
                              std::size_t metadataCount, const float* values,
                              std::size_t valueCount, std::size_t nodeCount) {
  if (version != scene_packet::version ||
      (nodeCount > 0 && (!metadata || !values)) ||
      nodeCount > scene_packet::maxNodes ||
      metadataCount < nodeCount * scene_packet::metadataStride ||
      valueCount < nodeCount * scene_packet::valueStride ||
      nodeCount * (scene_packet::metadataStride * sizeof(std::uint32_t) +
                   scene_packet::valueStride * sizeof(float)) >
        scene_packet::maxPacketBytes) return false;
  sceneMetadataScratch_.clear();
  if (nodeCount > 0) {
    sceneMetadataScratch_.assign(
      metadata, metadata + nodeCount * scene_packet::metadataStride);
  }
  for (std::size_t index = 0; index < nodeCount; ++index) {
    const std::size_t offset = index * scene_packet::metadataStride;
    const auto kind = static_cast<scene_packet::NodeKind>(
      sceneMetadataScratch_[offset]);
    if (sceneMetadataScratch_[offset] >
        static_cast<std::uint32_t>(scene_packet::NodeKind::mesh)) {
      return false;
    }
    if (sceneMetadataScratch_[offset + 5] &
        ~scene_packet::kAllowedNodeFlags) return false;
    if (sceneMetadataScratch_[offset + 5] & scene_packet::NodeFlags::hasAlphaMask) {
      const auto mask = resolveImage(sceneMetadataScratch_[offset + 6]);
      if (!mask) {
        std::cerr << "[pmjs-scene] invalid alpha-mask handle="
                  << sceneMetadataScratch_[offset + 6]
                  << " node=" << index << '\n';
        return false;
      }
      sceneMetadataScratch_[offset + 6] = *mask;
    }
    if (kind == scene_packet::NodeKind::filterBegin &&
        (sceneMetadataScratch_[offset + 4] ==
           static_cast<std::uint32_t>(scene_packet::FilterKind::displacement) ||
         sceneMetadataScratch_[offset + 4] ==
           static_cast<std::uint32_t>(scene_packet::FilterKind::alphaMask))) {
      const auto image = resolveImage(sceneMetadataScratch_[offset + 2]);
      if (!image) {
        std::cerr << "[pmjs-scene] invalid filter image handle="
                  << sceneMetadataScratch_[offset + 2]
                  << " node=" << index << '\n';
        return false;
      }
      sceneMetadataScratch_[offset + 2] = *image;
    }
    if (kind != scene_packet::NodeKind::sprite &&
        kind != scene_packet::NodeKind::tilingSprite) continue;
    const auto image = resolveImage(sceneMetadataScratch_[offset + 2]);
    if (!image) {
      std::cerr << "[pmjs-scene] invalid sprite image handle="
                << sceneMetadataScratch_[offset + 2]
                << " node=" << index
                << " kind=" << static_cast<std::uint32_t>(kind) << '\n';
      return false;
    }
    sceneMetadataScratch_[offset + 2] = *image;
  }
  const bool queued = renderer_.queueScene(
    version,
    nodeCount ? sceneMetadataScratch_.data() : nullptr,
    sceneMetadataScratch_.size(),
    nodeCount ? values : nullptr,
    valueCount,
    nodeCount);
  if (!queued) {
    std::cerr << "[pmjs-scene] renderer rejected packet nodes="
              << nodeCount << '\n';
  }
  return queued;
}

bool RuntimeCore::pollEvents() {
  running_ = running_ && platform_.pollEvents();
  return running_;
}

void RuntimeCore::syncDrawableSize() {
  const auto size = platform_.drawableSize();
  renderer_.setDrawableSize(size.first, size.second);
}




}  // namespace pmjs
