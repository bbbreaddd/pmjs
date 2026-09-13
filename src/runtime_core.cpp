#include "runtime_core.hpp"
#include "scene_packet.hpp"

#include <cstdlib>
#include <utility>
#include <vector>

namespace pmjs {

RuntimeCore::RuntimeCore(const std::filesystem::path& root, int width, int height,
                         const std::string& title)
    : width_(width), height_(height), platform_(width, height, title),
      canvases_(images_), renderer_(width, height, images_), vfs_(root),
      media_(root) {}

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
      if (!mask) return false;
      sceneMetadataScratch_[offset + 6] = *mask;
    }
    if (kind == scene_packet::NodeKind::filterBegin &&
        (sceneMetadataScratch_[offset + 4] ==
           static_cast<std::uint32_t>(scene_packet::FilterKind::displacement) ||
         sceneMetadataScratch_[offset + 4] ==
           static_cast<std::uint32_t>(scene_packet::FilterKind::alphaMask))) {
      const auto image = resolveImage(sceneMetadataScratch_[offset + 2]);
      if (!image) return false;
      sceneMetadataScratch_[offset + 2] = *image;
    }
    if (kind != scene_packet::NodeKind::sprite &&
        kind != scene_packet::NodeKind::tilingSprite) continue;
    const auto image = resolveImage(sceneMetadataScratch_[offset + 2]);
    if (!image) return false;
    sceneMetadataScratch_[offset + 2] = *image;
  }
  return renderer_.queueScene(
    version,
    nodeCount ? sceneMetadataScratch_.data() : nullptr,
    sceneMetadataScratch_.size(),
    values,
    valueCount,
    nodeCount);
}

bool RuntimeCore::pollEvents() {
  running_ = running_ && platform_.pollEvents();
  return running_;
}

std::uint32_t RuntimeCore::inputState() const {
  return platform_.inputState() | static_cast<std::uint32_t>(injectedInput_);
}

HostServices RuntimeCore::hostServices() {
  HostServices services;
  services.runtime.requestQuit = [this]() { requestQuit(); };
  services.runtime.environment = [](const std::string& name)
      -> std::optional<std::string> {
    const char* value = std::getenv(name.c_str());
    return value ? std::optional<std::string>{value} : std::nullopt;
  };
  services.render.setClearColor = [this](float red, float green, float blue,
                                          float alpha) {
    renderer_.setClearColor(red, green, blue, alpha);
  };
  services.render.drawQuad = [this](float x, float y, float width, float height,
                                     float red, float green, float blue,
                                     float alpha) {
    renderer_.queueQuad(x, y, width, height, {red, green, blue, alpha});
  };
  services.render.drawImage = [this](std::uint32_t handle,
      const std::array<float, 6>& transform, const std::array<float, 4>& source,
      float alpha, std::uint32_t tint, std::uint8_t blendMode) {
    const auto image = resolveImage(handle);
    return image && renderer_.queueImage(*image, transform, source, alpha, tint,
                                         static_cast<BlendMode>(blendMode));
  };
  services.render.drawTiled = [this](std::uint32_t handle,
      const std::array<float, 6>& transform, const std::array<float, 4>& source,
      const std::array<float, 2>& destination, float alpha, std::uint32_t tint,
      std::uint8_t blendMode) {
    const auto image = resolveImage(handle);
    return image && renderer_.queueTiled(*image, transform, source, destination,
                                         alpha, tint,
                                         static_cast<BlendMode>(blendMode));
  };
  services.render.createTileLayer = [this](const std::vector<float>& points,
      const std::vector<std::uint32_t>& handles) {
    if (points.size() % 9U != 0U) return std::uint32_t{0};
    std::vector<TileLayerTile> tiles;
    tiles.reserve(points.size() / 9U);
    for (std::size_t index = 0; index < points.size(); index += 9U) {
      const auto textureIndex = static_cast<std::size_t>(points[index + 8U]);
      if (textureIndex >= handles.size()) return std::uint32_t{0};
      const auto image = resolveImage(handles[textureIndex]);
      if (!image) return std::uint32_t{0};
      tiles.push_back({*image,
        {points[index], points[index + 1U], points[index + 4U],
         points[index + 5U]},
        {points[index + 2U], points[index + 3U]},
        {points[index + 6U], points[index + 7U]}});
    }
    return renderer_.createTileLayer(std::move(tiles));
  };
  services.render.createMesh = [this](std::uint32_t source,
      const std::vector<float>& positions, const std::vector<float>& uvs,
      const std::vector<std::uint32_t>& indices, bool triangleStrip) {
    const auto image = resolveImage(source);
    return image ? renderer_.createMesh(*image, positions, uvs, indices,
                                         triangleStrip) : 0;
  };
  services.render.drawTileLayer = [this](std::uint32_t layer,
      const std::array<float, 6>& transform,
      const std::array<float, 2>& animation, float alpha, std::uint32_t tint,
      std::uint8_t blendMode) {
    return renderer_.queueTileLayer(layer, transform, animation, alpha, tint,
                                    static_cast<BlendMode>(blendMode));
  };
  services.render.releaseTileLayer = [this](std::uint32_t layer) {
    return renderer_.releaseTileLayer(layer);
  };
  services.render.releaseMesh = [this](std::uint32_t mesh) {
    return renderer_.releaseTileLayer(mesh);
  };
  services.render.setRenderTargetSize = [this](int width, int height) {
    return renderer_.setRenderTargetSize(width, height);
  };
  services.render.setScreenRenderSize = [this](int width, int height) {
    return renderer_.setScreenRenderSize(width, height);
  };
  services.render.renderToCanvas = [this](std::uint32_t canvas) {
    const auto target = canvases_.info(canvas);
    if (!target) return false;
    canvases_.uploadDirty();
    const bool written = canvases_.writePixels(
      canvas, 0, 0, target->width, target->height,
      renderer_.renderToRgba(target->width, target->height));
    renderer_.beginFrame();
    return written;
  };
  services.scene.submit = [this](std::uint32_t version,
      const std::uint32_t* metadata, std::size_t metadataCount,
      const float* values, std::size_t valueCount, std::size_t nodeCount) {
    return submitScene(version, metadata, metadataCount, values, valueCount,
                       nodeCount);
  };
  services.images.load = [this](const std::string& path)
      -> std::optional<HostServices::ImageInfo> {
    const auto resolved = vfs_.resolve(path);
    if (!resolved) return std::nullopt;
    const auto image = images_.loadPng(*resolved);
    if (!image) return std::nullopt;
    return HostServices::ImageInfo{image->handle, image->width, image->height};
  };
  services.images.release = [this](std::uint32_t handle) {
    return images_.release(handle);
  };
  services.filesystem.readText = [this](const std::string& path) {
    return vfs_.readText(path);
  };
  services.filesystem.readBytes = [this](const std::string& path) {
    return vfs_.readBytes(path);
  };
  services.filesystem.readDirectory = [this](const std::string& path) {
    return vfs_.readDirectory(path);
  };
  services.filesystem.exists = [this](const std::string& path) {
    return vfs_.exists(path);
  };
  services.filesystem.isDirectory = [this](const std::string& path) {
    return vfs_.isDirectory(path);
  };
  services.input.down = [this](const std::string& action) {
    return platform_.inputDown(action);
  };
  services.input.pressed = [this](const std::string& action) {
    return platform_.inputPressed(action);
  };
  services.canvas.create = [this](int width, int height)
      -> std::optional<HostServices::ImageInfo> {
    const auto image = canvases_.create(width, height);
    if (!image) return std::nullopt;
    return HostServices::ImageInfo{image->handle, image->width, image->height};
  };
  services.canvas.captureScene = [this]()
      -> std::optional<HostServices::ImageInfo> {
    auto canvas = canvases_.createRgba(width_, height_,
                                       renderer_.captureSceneRgba());
    if (!canvas) return std::nullopt;
    return HostServices::ImageInfo{canvas->handle, canvas->width, canvas->height};
  };
  services.canvas.fillRect = [this](std::uint32_t handle, int x, int y,
      int width, int height, std::uint32_t rgba) {
    return canvases_.fillRect(handle, x, y, width, height, rgba);
  };
  services.canvas.clear = [this](std::uint32_t handle) {
    return canvases_.clear(handle);
  };
  services.canvas.clearRect = [this](std::uint32_t handle, int x, int y,
      int width, int height) {
    return canvases_.clearRect(handle, x, y, width, height);
  };
  services.canvas.drawImage = [this](std::uint32_t destination,
      std::uint32_t source, int sourceX, int sourceY, int sourceWidth,
      int sourceHeight, int destinationX, int destinationY,
      int destinationWidth, int destinationHeight, float alpha) {
    return canvases_.drawImage(destination, source, sourceX, sourceY,
      sourceWidth, sourceHeight, destinationX, destinationY,
      destinationWidth, destinationHeight, alpha);
  };
  services.canvas.drawText = [this](std::uint32_t handle,
      const std::string& font, const std::string& text, int x, int y, int size,
      std::uint32_t rgba, int strokeWidth) {
    const auto path = vfs_.resolve(font);
    return path && canvases_.drawText(handle, *path, text, x, y, size, rgba,
                                      strokeWidth);
  };
  services.canvas.measureText = [this](const std::string& font,
      const std::string& text, int size) -> std::optional<int> {
    const auto path = vfs_.resolve(font);
    return path ? canvases_.measureText(*path, text, size) : std::nullopt;
  };
  services.canvas.measureTextMetrics = [this](const std::string& font,
      const std::string& text, int size) -> std::optional<CanvasTextMetrics> {
    const auto path = vfs_.resolve(font);
    return path ? canvases_.measureTextMetrics(*path, text, size) : std::nullopt;
  };
  services.canvas.pixel = [this](std::uint32_t handle, int x, int y) {
    return canvases_.pixel(handle, x, y);
  };
  services.canvas.readPixels = [this](std::uint32_t handle, int x, int y,
      int width, int height) -> std::optional<HostServices::PixelData> {
    auto pixels = canvases_.readPixels(handle, x, y, width, height);
    if (!pixels) return std::nullopt;
    return HostServices::PixelData{pixels->width, pixels->height,
                                   std::move(pixels->rgba)};
  };
  services.canvas.encodePng = [this](std::uint32_t handle) {
    return canvases_.encodePng(handle);
  };
  services.canvas.writePixels = [this](std::uint32_t handle, int x, int y,
      int width, int height, const std::vector<std::uint8_t>& pixels) {
    return canvases_.writePixels(handle, x, y, width, height, pixels);
  };
  services.canvas.blur = [this](std::uint32_t handle) {
    return canvases_.blur(handle);
  };
  services.canvas.release = [this](std::uint32_t handle) {
    return canvases_.release(handle);
  };
  return services;
}

}  // namespace pmjs
