#include "renderer.hpp"
#include <GLES3/gl3.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <stdexcept>
#include <string>
#include <unordered_set>

namespace pmjs {

PresentScaleMode Renderer::presentScaleModeFromEnvironment() {
  const char* value = std::getenv("PMJS_PRESENT_SCALE");
  if (!value || !*value) return PresentScaleMode::fit;
  const std::string text(value);
  if (text == "fit") return PresentScaleMode::fit;
  if (text == "integer") return PresentScaleMode::integer;
  throw std::runtime_error("PMJS_PRESENT_SCALE must be fit or integer");
}

bool Renderer::presentFilterOverrideFromEnvironment(PresentFilter* filter) {
  const char* value = std::getenv("PMJS_PRESENT_FILTER");
  if (!value || !*value || std::string(value) == "auto") return false;
  const std::string text(value);
  if (text == "nearest") {
    *filter = PresentFilter::nearest;
    return true;
  }
  if (text == "linear") {
    *filter = PresentFilter::linear;
    return true;
  }
  throw std::runtime_error(
    "PMJS_PRESENT_FILTER must be auto, nearest, or linear "
    "(area/hermite need the phase-2 presentation shader)");
}

void Renderer::recomputePresentation() {
  const int sourceWidth = width_;
  const int sourceHeight = height_;
  const int drawableWidth = presentation_.drawableWidth;
  const int drawableHeight = presentation_.drawableHeight;
  int viewportWidth = drawableWidth;
  int viewportHeight = drawableHeight;
  if (presentation_.scaleMode == PresentScaleMode::integer) {
    const int scaleX = drawableWidth / sourceWidth;
    const int scaleY = drawableHeight / sourceHeight;
    const int scale = std::min(scaleX, scaleY);
    if (scale >= 1) {
      viewportWidth = sourceWidth * scale;
      viewportHeight = sourceHeight * scale;
    }
  }
  if (viewportWidth == drawableWidth && viewportHeight == drawableHeight) {
    const bool widthConstrained = static_cast<std::int64_t>(drawableWidth) *
            sourceHeight <=
        static_cast<std::int64_t>(drawableHeight) * sourceWidth;
    if (widthConstrained) {
      viewportWidth = drawableWidth;
      viewportHeight = static_cast<int>(
        (static_cast<std::int64_t>(sourceHeight) * drawableWidth +
         sourceWidth / 2) / sourceWidth);
    } else {
      viewportHeight = drawableHeight;
      viewportWidth = static_cast<int>(
        (static_cast<std::int64_t>(sourceWidth) * drawableHeight +
         sourceHeight / 2) / sourceHeight);
    }
  }
  presentation_.sourceWidth = sourceWidth;
  presentation_.sourceHeight = sourceHeight;
  presentation_.viewportX = (drawableWidth - viewportWidth) / 2;
  presentation_.viewportY = (drawableHeight - viewportHeight) / 2;
  presentation_.viewportWidth = viewportWidth;
  presentation_.viewportHeight = viewportHeight;
  const bool integerMapping = viewportWidth % sourceWidth == 0 &&
      viewportHeight % sourceHeight == 0 &&
      viewportWidth / sourceWidth == viewportHeight / sourceHeight;
  presentation_.filter = hasFilterOverride_ ? filterOverride_
      : (integerMapping ? PresentFilter::nearest : PresentFilter::linear);
}

void Renderer::setDrawableSize(int width, int height) {
  if (width <= 0 || height <= 0) return;
  if (width == presentation_.drawableWidth &&
      height == presentation_.drawableHeight) {
    return;
  }
  presentation_.drawableWidth = width;
  presentation_.drawableHeight = height;
  recomputePresentation();
}

void Renderer::resizeTargets(int width, int height) {
  if (width == width_ && height == height_) return;
  if (width <= 0 || height <= 0) {
    throw std::runtime_error("renderer target dimensions must be positive");
  }
  if (width > maxTextureSize_ || height > maxTextureSize_) {
    throw std::runtime_error("renderer target exceeds GL_MAX_TEXTURE_SIZE");
  }

  const auto destroyTarget = [](std::uint32_t& texture,
                                std::uint32_t& framebuffer) {
    if (framebuffer) glDeleteFramebuffers(1, &framebuffer);
    if (texture) glDeleteTextures(1, &texture);
    framebuffer = 0;
    texture = 0;
  };
  const std::size_t targetCount = 5U + groupFramebuffers_.size();
  stats_.rendererTargetDestroys += targetCount;
  destroyTarget(sceneTexture_, sceneFramebuffer_);
  destroyTarget(offscreenTexture_, offscreenFramebuffer_);
  destroyTarget(filterTexture_, filterFramebuffer_);
  destroyTarget(toneOverlayTexture_, toneOverlayFramebuffer_);
  destroyTarget(bloomTexture_, bloomFramebuffer_);
  for (std::size_t index = 0; index < groupFramebuffers_.size(); ++index) {
    destroyTarget(groupTextures_[index], groupFramebuffers_[index]);
  }
  textureNearestState_.clear();
  textureRepeatState_.clear();
  width_ = width;
  height_ = height;
  hasValidSceneFrame_ = false;
  toneCompositionActive_ = false;

  const auto createTarget = [&](std::uint32_t& texture,
                                std::uint32_t& framebuffer) {
    glGenTextures(1, &texture);
    glBindTexture(GL_TEXTURE_2D, texture);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, width_, height_, 0, GL_RGBA,
                 GL_UNSIGNED_BYTE, nullptr);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glGenFramebuffers(1, &framebuffer);
    glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                           GL_TEXTURE_2D, texture, 0);
    ++stats_.framebufferChecks;
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
      throw std::runtime_error("resized renderer framebuffer is incomplete");
    }
    ++stats_.rendererTargetCreates;
  };
  createTarget(sceneTexture_, sceneFramebuffer_);
  createTarget(offscreenTexture_, offscreenFramebuffer_);
  createTarget(filterTexture_, filterFramebuffer_);
  createTarget(toneOverlayTexture_, toneOverlayFramebuffer_);
  createTarget(bloomTexture_, bloomFramebuffer_);
  for (std::size_t index = 0; index < groupFramebuffers_.size(); ++index) {
    createTarget(groupTextures_[index], groupFramebuffers_[index]);
  }
  recomputePresentation();
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
}

void Renderer::setClearColor(float red, float green, float blue, float alpha) {
  clearColor_ = {red, green, blue, alpha};
}

bool Renderer::setPresentationLayers(float canvasOpacity, ImageHandle video,
                                     float videoOpacity, ImageHandle upperCanvas,
                                     float upperCanvasOpacity) {
  const auto opacity = [](float value) {
    return std::isfinite(value) ? std::clamp(value, 0.0F, 1.0F) : 1.0F;
  };
  const bool retainVideo = video && video != presentationVideo_;
  const bool retainUpperCanvas = upperCanvas &&
    upperCanvas != presentationUpperCanvas_;
  if (retainVideo && !images_.retain(video)) return false;
  if (retainUpperCanvas && !images_.retain(upperCanvas)) {
    if (retainVideo) images_.release(video);
    return false;
  }
  if (presentationVideo_ && presentationVideo_ != video) {
    images_.release(presentationVideo_);
  }
  if (presentationUpperCanvas_ && presentationUpperCanvas_ != upperCanvas) {
    images_.release(presentationUpperCanvas_);
  }
  presentationCanvasOpacity_ = opacity(canvasOpacity);
  presentationVideo_ = video;
  presentationVideoOpacity_ = video ? opacity(videoOpacity) : 0.0F;
  presentationUpperCanvas_ = upperCanvas;
  presentationUpperCanvasOpacity_ = upperCanvas
    ? opacity(upperCanvasOpacity) : 0.0F;
  return true;
}

bool Renderer::setRenderTargetSize(int width, int height) {
  if (width <= 0 || height <= 0) return false;
  if (width > maxTextureSize_ || height > maxTextureSize_) return false;
  queueWidth_ = width;
  queueHeight_ = height;
  return true;
}

bool Renderer::setScreenRenderSize(int width, int height) {
  if (width <= 0 || height <= 0) return false;
  if (width > maxTextureSize_ || height > maxTextureSize_) return false;
  resizeTargets(width, height);
  queueWidth_ = width;
  queueHeight_ = height;
  return true;
}

void Renderer::beginFrame() {
  sceneSubmittedThisFrame_ = false;
  discardCommandsFrom(0);
  images_.update();
  queueWidth_ = width_;
  queueHeight_ = height_;
}

std::size_t Renderer::commandCount() const { return frame_.commands.size(); }

void Renderer::discardCommandsFrom(std::size_t first) {  while (frame_.commands.size() > first) {
    const RenderCommand command = frame_.commands.back();
    frame_.commands.pop_back();
    if (command.image) images_.endUse(command.image);
    if (command.maskImage) images_.endUse(command.maskImage);
    if (!command.tileLayer) continue;
    const auto found = tileLayers_.find(command.tileLayer);
    if (found == tileLayers_.end() || found->second.queuedReferences == 0) continue;
    --found->second.queuedReferences;
    if (found->second.owners == 0 && found->second.queuedReferences == 0) {
      destroyTileLayer(command.tileLayer);
    }
  }
}

void Renderer::queueQuad(float x, float y, float width, float height,
                         const std::array<float, 4>& color) {
  auto boundedColor = color;
  boundedColor[3] = std::clamp(boundedColor[3], 0.0F, 1.0F);
  frame_.commands.push_back(
      {0, {width, 0, 0, height, x, y}, {0, 0, 1, 1}, {1, 1}, boundedColor,
       BlendMode::normal, false});
  frame_.commands.back().primitive = RenderCommand::Primitive::screenFill;
  sceneSubmittedThisFrame_ = true;
}

bool Renderer::queueImage(ImageHandle image,
                          const std::array<float, 6>& transform,
                          const std::array<float, 4>& source, float alpha,
                          std::uint32_t tint, BlendMode blendMode) {
  if (!images_.lookup(image) ||
      !isValidBlendMode(static_cast<std::uint8_t>(blendMode))) return false;
  const std::array<float, 4> color = {
    static_cast<float>((tint >> 16U) & 0xffU) / 255.0F,
    static_cast<float>((tint >> 8U) & 0xffU) / 255.0F,
    static_cast<float>(tint & 0xffU) / 255.0F,
    std::clamp(alpha, 0.0F, 1.0F),
  };
  if (!images_.beginUse(image)) return false;
  try {
    frame_.commands.push_back(
        {image, transform, source, {source[2], source[3]}, color, blendMode, false});
    sceneSubmittedThisFrame_ = true;
  } catch (...) {
    images_.endUse(image);
    throw;
  }
  return true;
}

bool Renderer::queueTiled(ImageHandle image,
                          const std::array<float, 6>& transform,
                          const std::array<float, 4>& source,
                          const std::array<float, 2>& destination, float alpha,
                          std::uint32_t tint, BlendMode blendMode) {
  const auto info = images_.lookup(image);
  if (!info || destination[0] <= 0 || destination[1] <= 0 ||
      !isValidBlendMode(static_cast<std::uint8_t>(blendMode))) return false;
  auto boundedSource = source;
  if (std::isfinite(boundedSource[0]) && info->width > 0) {
    boundedSource[0] = std::fmod(boundedSource[0], static_cast<float>(info->width));
  }
  if (std::isfinite(boundedSource[1]) && info->height > 0) {
    boundedSource[1] = std::fmod(boundedSource[1], static_cast<float>(info->height));
  }
  const std::array<float, 4> color = {
    static_cast<float>((tint >> 16U) & 0xffU) / 255.0F,
    static_cast<float>((tint >> 8U) & 0xffU) / 255.0F,
    static_cast<float>(tint & 0xffU) / 255.0F,
    std::clamp(alpha, 0.0F, 1.0F),
  };
  if (!images_.beginUse(image)) return false;
  try {
    frame_.commands.push_back(
        {image, transform, boundedSource, destination, color, blendMode, true});
    frame_.commands.back().primitive = RenderCommand::Primitive::tilingSprite;
    sceneSubmittedThisFrame_ = true;
  } catch (...) {
    images_.endUse(image);
    throw;
  }
  return true;
}

std::uint32_t Renderer::createTileLayer(std::vector<TileLayerTile> tiles) {
  constexpr std::size_t kMaxTileCount = 65536U;
  if (tiles.empty() || tiles.size() > kMaxTileCount) return 0;
  TileLayerResource layer;
  std::unordered_map<ImageHandle, ImageInfo> imageInfo;
  for (const auto& tile : tiles) {
    if (imageInfo.find(tile.image) != imageInfo.end()) continue;
    const auto image = images_.lookup(tile.image);
    if (!image) return 0;
    imageInfo.emplace(tile.image, *image);
  }
  layer.images.reserve(imageInfo.size());
  for (const auto& [image, _] : imageInfo) {
    if (!images_.retain(image)) {
      for (const auto retained : layer.images) images_.release(retained);
      return 0;
    }
    layer.images.push_back(image);
  }
  std::vector<float> vertices;
  vertices.reserve(tiles.size() * 36U);
  for (const auto& tile : tiles) {
    const auto& image = imageInfo.at(tile.image);
    const float left = tile.position[0];
    const float top = tile.position[1];
    const float right = left + tile.source[2];
    const float bottom = top + tile.source[3];
    const float sourceLeft = tile.source[0];
    const float sourceTop = tile.source[1];
    const float sourceRight = sourceLeft + tile.source[2];
    const float sourceBottom = sourceTop + tile.source[3];
    const auto append = [&](float x, float y, float u, float v) {
      vertices.insert(vertices.end(), {x, y, u, v,
        tile.animation[0], tile.animation[1]});
    };
    append(left, top, sourceLeft, sourceTop);
    append(right, top, sourceRight, sourceTop);
    append(right, bottom, sourceRight, sourceBottom);
    append(left, top, sourceLeft, sourceTop);
    append(right, bottom, sourceRight, sourceBottom);
    append(left, bottom, sourceLeft, sourceBottom);
    if (layer.batches.empty() || layer.batches.back().texture != image.texture) {
      layer.batches.push_back({image.texture, image.width, image.height,
        static_cast<std::int32_t>(vertices.size() / 6U - 6U), 6});
    } else {
      layer.batches.back().count += 6;
    }
  }

  glGenVertexArrays(1, &layer.vertexArray);
  glGenBuffers(1, &layer.vertexBuffer);
  glBindVertexArray(layer.vertexArray);
  glBindBuffer(GL_ARRAY_BUFFER, layer.vertexBuffer);
  glBufferData(GL_ARRAY_BUFFER,
               static_cast<GLsizeiptr>(vertices.size() * sizeof(float)),
               vertices.data(), GL_STATIC_DRAW);
  glEnableVertexAttribArray(0);
  glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 6 * sizeof(float), nullptr);
  glEnableVertexAttribArray(1);
  glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 6 * sizeof(float),
                        reinterpret_cast<void*>(2 * sizeof(float)));
  glEnableVertexAttribArray(2);
  glVertexAttribPointer(2, 2, GL_FLOAT, GL_FALSE, 6 * sizeof(float),
                        reinterpret_cast<void*>(4 * sizeof(float)));
  glBindVertexArray(vertexArray_);
  ++stats_.bufferUploads;
  const std::uint32_t handle = nextTileLayer_++;
  tileLayers_.emplace(handle, std::move(layer));
  return handle;
}

std::uint32_t Renderer::createMesh(
    ImageHandle image, const std::vector<float>& positions,
    const std::vector<float>& uvs, const std::vector<std::uint32_t>& indices,
    bool triangleStrip) {
  const auto info = images_.lookup(image);
  if (!info || positions.size() < 6 || positions.size() % 2 != 0 ||
      uvs.size() != positions.size() || indices.size() < 3 ||
      indices.size() > 65536U || positions.size() > 131072U) return 0;
  TileLayerResource mesh;
  if (!images_.retain(image)) return 0;
  mesh.images.push_back(image);
  std::vector<std::uint32_t> triangles;
  if (triangleStrip) {
    triangles.reserve((indices.size() - 2) * 3);
    for (std::size_t index = 2; index < indices.size(); ++index) {
      if (index & 1U) {
        triangles.insert(triangles.end(),
          {indices[index - 1], indices[index - 2], indices[index]});
      } else {
        triangles.insert(triangles.end(),
          {indices[index - 2], indices[index - 1], indices[index]});
      }
    }
  } else {
    if (indices.size() % 3 != 0) {
      images_.release(image);
      return 0;
    }
    triangles = indices;
  }
  std::vector<float> vertices;
  vertices.reserve(triangles.size() * 6);
  for (const auto vertex : triangles) {
    const std::size_t offset = static_cast<std::size_t>(vertex) * 2U;
    if (offset + 1 >= positions.size()) {
      images_.release(image);
      return 0;
    }
    vertices.insert(vertices.end(), {
      positions[offset], positions[offset + 1],
      uvs[offset] * static_cast<float>(info->width),
      uvs[offset + 1] * static_cast<float>(info->height), 0, 0});
  }
  glGenVertexArrays(1, &mesh.vertexArray);
  glGenBuffers(1, &mesh.vertexBuffer);
  glBindVertexArray(mesh.vertexArray);
  glBindBuffer(GL_ARRAY_BUFFER, mesh.vertexBuffer);
  glBufferData(GL_ARRAY_BUFFER,
               static_cast<GLsizeiptr>(vertices.size() * sizeof(float)),
               vertices.data(), GL_STATIC_DRAW);
  glEnableVertexAttribArray(0);
  glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 6 * sizeof(float), nullptr);
  glEnableVertexAttribArray(1);
  glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 6 * sizeof(float),
                        reinterpret_cast<void*>(2 * sizeof(float)));
  glEnableVertexAttribArray(2);
  glVertexAttribPointer(2, 2, GL_FLOAT, GL_FALSE, 6 * sizeof(float),
                        reinterpret_cast<void*>(4 * sizeof(float)));
  glBindVertexArray(vertexArray_);
  mesh.batches.push_back({info->texture, info->width, info->height, 0,
                          static_cast<std::int32_t>(triangles.size())});
  ++stats_.bufferUploads;
  const std::uint32_t handle = nextTileLayer_++;
  tileLayers_.emplace(handle, std::move(mesh));
  return handle;
}

bool Renderer::queueTileLayer(std::uint32_t layer,
                              const std::array<float, 6>& transform,
                              const std::array<float, 2>& animation,
                              float alpha, std::uint32_t tint,
                              BlendMode blendMode) {
  if (!isValidBlendMode(static_cast<std::uint8_t>(blendMode))) return false;
  const auto found = tileLayers_.find(layer);
  if (found == tileLayers_.end() || found->second.owners == 0) return false;
  RenderCommand command;
  command.transform = transform;
  command.color = {
    static_cast<float>((tint >> 16U) & 0xffU) / 255.0F,
    static_cast<float>((tint >> 8U) & 0xffU) / 255.0F,
    static_cast<float>(tint & 0xffU) / 255.0F,
    std::clamp(alpha, 0.0F, 1.0F),
  };
  command.blendMode = blendMode;
  command.tileLayer = layer;
  command.primitive = RenderCommand::Primitive::tileLayer;
  command.tileAnimation = animation;
  ++found->second.queuedReferences;
  try {
    frame_.commands.push_back(command);
    sceneSubmittedThisFrame_ = true;
  } catch (...) {
    --found->second.queuedReferences;
    throw;
  }
  return true;
}

bool Renderer::releaseTileLayer(std::uint32_t layer) {
  const auto found = tileLayers_.find(layer);
  if (found == tileLayers_.end() || found->second.owners == 0) return false;
  --found->second.owners;
  if (found->second.queuedReferences == 0) destroyTileLayer(layer);
  return true;
}

void Renderer::destroyTileLayer(std::uint32_t layer) {
  const auto found = tileLayers_.find(layer);
  if (found == tileLayers_.end()) return;
  if (found->second.vertexBuffer) glDeleteBuffers(1, &found->second.vertexBuffer);
  if (found->second.vertexArray) glDeleteVertexArrays(1, &found->second.vertexArray);
  for (const auto image : found->second.images) images_.release(image);
  tileLayers_.erase(found);
}

std::vector<std::uint8_t> Renderer::captureSceneRgba() {
  if (!offscreenRender_) materializeToneComposition();
  std::vector<std::uint8_t> pixels(static_cast<std::size_t>(width_) *
                                   static_cast<std::size_t>(height_) * 4U);
  glBindFramebuffer(GL_READ_FRAMEBUFFER,
                    offscreenRender_ ? offscreenFramebuffer_ : sceneFramebuffer_);
  glReadBuffer(GL_COLOR_ATTACHMENT0);
  glPixelStorei(GL_PACK_ALIGNMENT, 1);
  glReadPixels(0, 0, width_, height_, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());
  glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);

  const std::size_t rowBytes = static_cast<std::size_t>(width_) * 4U;
  std::vector<std::uint8_t> row(rowBytes);
  for (int y = 0; y < height_ / 2; ++y) {
    auto top = pixels.begin() + static_cast<std::ptrdiff_t>(y) * rowBytes;
    auto bottom = pixels.begin() +
      static_cast<std::ptrdiff_t>(height_ - y - 1) * rowBytes;
    std::copy(top, top + static_cast<std::ptrdiff_t>(rowBytes), row.begin());
    std::copy(bottom, bottom + static_cast<std::ptrdiff_t>(rowBytes), top);
    std::copy(row.begin(), row.end(), bottom);
  }
  for (std::size_t offset = 0; offset < pixels.size(); offset += 4) {
    const std::uint32_t alpha = pixels[offset + 3];
    if (alpha == 0 || alpha == 255) continue;
    for (std::size_t channel = 0; channel < 3; ++channel) {
      pixels[offset + channel] = static_cast<std::uint8_t>(std::min(
        255U, (static_cast<std::uint32_t>(pixels[offset + channel]) * 255U +
               alpha / 2U) / alpha));
    }
  }
  return pixels;
}

std::vector<std::uint8_t> Renderer::captureDrawableRgba() {
  const int width = presentation_.drawableWidth;
  const int height = presentation_.drawableHeight;
  std::vector<std::uint8_t> pixels(static_cast<std::size_t>(width) *
                                   static_cast<std::size_t>(height) * 4U);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
  glReadBuffer(GL_BACK);
  glPixelStorei(GL_PACK_ALIGNMENT, 1);
  glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());
  glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);

  const std::size_t rowBytes = static_cast<std::size_t>(width) * 4U;
  std::vector<std::uint8_t> row(rowBytes);
  for (int y = 0; y < height / 2; ++y) {
    auto top = pixels.begin() + static_cast<std::ptrdiff_t>(y) * rowBytes;
    auto bottom = pixels.begin() +
      static_cast<std::ptrdiff_t>(height - y - 1) * rowBytes;
    std::copy(top, top + static_cast<std::ptrdiff_t>(rowBytes), row.begin());
    std::copy(bottom, bottom + static_cast<std::ptrdiff_t>(rowBytes), top);
    std::copy(row.begin(), row.end(), bottom);
  }
  return pixels;
}

std::vector<std::uint8_t> Renderer::renderToRgba() {
  const auto savedClearColor = clearColor_;
  clearColor_ = {0, 0, 0, 0};
  render();
  auto pixels = captureSceneRgba();
  clearColor_ = savedClearColor;
  return pixels;
}

std::vector<std::uint8_t> Renderer::renderToRgba(int width, int height) {
  const int savedWidth = width_;
  const int savedHeight = height_;
  const auto savedClearColor = clearColor_;
  const bool savedOffscreenRender = offscreenRender_;
  try {
    if (width != width_ || height != height_) resizeTargets(width, height);
    offscreenRender_ = true;
    clearColor_ = {0, 0, 0, 0};
    render();
    auto pixels = captureSceneRgba();
    offscreenRender_ = savedOffscreenRender;
    clearColor_ = savedClearColor;
    if (width_ != savedWidth || height_ != savedHeight) {
      resizeTargets(savedWidth, savedHeight);
    }
    return pixels;
  } catch (...) {
    offscreenRender_ = savedOffscreenRender;
    clearColor_ = savedClearColor;
    if (width_ != savedWidth || height_ != savedHeight) {
      resizeTargets(savedWidth, savedHeight);
    }
    throw;
  }
}

std::optional<ImageInfo> Renderer::renderToImage(int width, int height) {
  if (width <= 0 || height <= 0 || width > maxTextureSize_ ||
      height > maxTextureSize_) return std::nullopt;
  if (width != width_ || height != height_) {
    throw std::runtime_error(
      "GPU render images currently require the active renderer dimensions");
  }
  const auto savedClearColor = clearColor_;
  try {
    offscreenRender_ = true;
    clearColor_ = {0, 0, 0, 0};
    render();
    auto image = images_.createRgba(width_, height_, nullptr);
    if (!image) throw std::runtime_error("cannot allocate GPU render image");
    while (glGetError() != GL_NO_ERROR) {}
    std::uint32_t destinationFramebuffer = 0;
    glGenFramebuffers(1, &destinationFramebuffer);
    glBindFramebuffer(GL_FRAMEBUFFER, destinationFramebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                           GL_TEXTURE_2D, image->texture, 0);
    ++stats_.framebufferChecks;
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
      glDeleteFramebuffers(1, &destinationFramebuffer);
      images_.release(image->handle);
      throw std::runtime_error("generated image framebuffer is incomplete");
    }
    constexpr std::array<float, 72> vertices = {
      -1,  1, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1,
       1,  1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1,
       1, -1, 1, 0, 1, 1, 1, 1, 0, 0, 1, 1,
      -1,  1, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1,
       1, -1, 1, 0, 1, 1, 1, 1, 0, 0, 1, 1,
      -1, -1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1,
    };
    glViewport(0, 0, width_, height_);
    glDisable(GL_BLEND);
    glUseProgram(generatedTextureProgram_);
    glBindVertexArray(vertexArray_);
    glBindBuffer(GL_ARRAY_BUFFER, vertexBuffer_);
    glBufferData(GL_ARRAY_BUFFER, sizeof(vertices), vertices.data(),
                 GL_STREAM_DRAW);
    ++stats_.bufferUploads;
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, offscreenTexture_);
    glDrawArrays(GL_TRIANGLES, 0, 6);
    ++stats_.drawCalls;
    glDeleteFramebuffers(1, &destinationFramebuffer);
    if (glGetError() != GL_NO_ERROR) {
      images_.release(image->handle);
      throw std::runtime_error("cannot normalize GPU render image");
    }
    offscreenRender_ = false;
    clearColor_ = savedClearColor;
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glEnable(GL_BLEND);
    return image;
  } catch (...) {
    offscreenRender_ = false;
    clearColor_ = savedClearColor;
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glEnable(GL_BLEND);
    throw;
  }
}

std::size_t Renderer::renderTargetBytes() const {
  return static_cast<std::size_t>(width_) * static_cast<std::size_t>(height_) * 36U;
}

}
