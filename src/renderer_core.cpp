#include "canvas_pixels.hpp"
#include "renderer.hpp"
#include "checked_bounds.hpp"
#ifdef PMJS_HAS_SKIA65
#include "skia65/pmjs_skia65.h"
#endif
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
  if (authoredPresentationSize_[0] > 0) {
    viewportWidth = authoredPresentationSize_[0];
    viewportHeight = authoredPresentationSize_[1];
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
  if (authoredPresentationFilter_) presentation_.filter = authoredPresentationFilter_ == 1 ?
    PresentFilter::nearest : PresentFilter::linear;
}

void Renderer::setPresentationViewport(int width, int height, int filter) {
  if (width < 0 || height < 0 || width > 32768 || height > 32768 ||
      ((width == 0) != (height == 0)) || filter < 0 || filter > 2) {
    throw std::invalid_argument("invalid presentation viewport");
  }
  authoredPresentationSize_ = {width, height};
  authoredPresentationFilter_ = filter;
  recomputePresentation();
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

void Renderer::destroyTarget(RenderTarget& target) {
  stats_.rendererTargetBytes -= targetStorageBytes(target);
  if (target.depth) glDeleteRenderbuffers(1, &target.depth);
  if (target.framebuffer) glDeleteFramebuffers(1, &target.framebuffer);
  if (target.texture) {
    textureNearestState_.erase(target.texture);
    textureRepeatState_.erase(target.texture);
    glDeleteTextures(1, &target.texture);
    if (diagnostics_) ++stats_.rendererTargetDestroys;
  }
  target = {};
}

void Renderer::swapTargetColors(RenderTarget& left, RenderTarget& right) {
  // Depth belongs to the main scene, even when a color pass exchanges FBOs.
  std::swap(left, right);
  if (!left.depth && !right.depth) return;
  std::swap(left.depth, right.depth);
  GLint savedRead = 0, savedDraw = 0;
  glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &savedRead);
  glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &savedDraw);
  for (const auto* target : {&left, &right}) {
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, target->framebuffer);
    glFramebufferRenderbuffer(GL_DRAW_FRAMEBUFFER, GL_DEPTH_ATTACHMENT,
                              GL_RENDERBUFFER, target->depth);
  }
  glBindFramebuffer(GL_READ_FRAMEBUFFER, savedRead);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, savedDraw);
}

void Renderer::ensureDepthBuffer(RenderTarget& target) {
  if (target.depth) return;
  GLint savedBuffer = 0, savedFramebuffer = 0;
  glGetIntegerv(GL_RENDERBUFFER_BINDING, &savedBuffer);
  glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &savedFramebuffer);
  glGenRenderbuffers(1, &target.depth);
  if (!target.depth) throw std::runtime_error("cannot allocate renderer depth buffer");
  glBindRenderbuffer(GL_RENDERBUFFER, target.depth);
  glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT24, target.width, target.height);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, target.framebuffer);
  glFramebufferRenderbuffer(GL_DRAW_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, target.depth);
  if (diagnostics_) ++stats_.framebufferChecks;
  const bool complete = glCheckFramebufferStatus(GL_DRAW_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE;
  if (!complete) {
    glFramebufferRenderbuffer(GL_DRAW_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, 0);
    glDeleteRenderbuffers(1, &target.depth);
    target.depth = 0;
  }
  glBindRenderbuffer(GL_RENDERBUFFER, savedBuffer);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, savedFramebuffer);
  if (!complete) throw std::runtime_error("renderer depth framebuffer is incomplete");
  stats_.rendererTargetBytes += static_cast<std::size_t>(target.width) * target.height * 4U;
  stats_.rendererTargetPeakBytes = std::max(stats_.rendererTargetPeakBytes, stats_.rendererTargetBytes);
}

void Renderer::ensureTarget(RenderTarget& target, int width, int height) {
  if (target.texture && target.width == width && target.height == height) return;
  if (width <= 0 || height <= 0 || width > maxTextureSize_ || height > maxTextureSize_) {
    throw std::runtime_error("invalid renderer target dimensions");
  }
  GLint savedTexture = 0, savedRead = 0, savedDraw = 0;
  glGetIntegerv(GL_TEXTURE_BINDING_2D, &savedTexture);
  glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &savedRead);
  glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &savedDraw);
  RenderTarget replacement;
  replacement.width = width;
  replacement.height = height;
  glGenTextures(1, &replacement.texture);
  if (!replacement.texture) throw std::runtime_error("cannot allocate renderer target texture");
  glBindTexture(GL_TEXTURE_2D, replacement.texture);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, width, height, 0, GL_RGBA,
               GL_UNSIGNED_BYTE, nullptr);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glGenFramebuffers(1, &replacement.framebuffer);
  if (!replacement.framebuffer) {
    glDeleteTextures(1, &replacement.texture);
    glBindTexture(GL_TEXTURE_2D, static_cast<GLuint>(savedTexture));
    throw std::runtime_error("cannot allocate renderer target framebuffer");
  }
  glBindFramebuffer(GL_FRAMEBUFFER, replacement.framebuffer);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                         GL_TEXTURE_2D, replacement.texture, 0);
  if (diagnostics_) ++stats_.framebufferChecks;
  const bool complete = glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE;
  if (complete) {
    stats_.rendererTargetBytes += targetStorageBytes(replacement);
    stats_.rendererTargetPeakBytes = std::max(stats_.rendererTargetPeakBytes, stats_.rendererTargetBytes);
    // Keep the previous allocation valid until its replacement is complete.
    if (target.texture && static_cast<GLuint>(savedTexture) == target.texture)
      savedTexture = static_cast<GLint>(replacement.texture);
    if (target.framebuffer && static_cast<GLuint>(savedRead) == target.framebuffer)
      savedRead = static_cast<GLint>(replacement.framebuffer);
    if (target.framebuffer && static_cast<GLuint>(savedDraw) == target.framebuffer)
      savedDraw = static_cast<GLint>(replacement.framebuffer);
    destroyTarget(target);
    target = replacement;
    if (diagnostics_) ++stats_.rendererTargetCreates;
  } else {
    glDeleteFramebuffers(1, &replacement.framebuffer);
    glDeleteTextures(1, &replacement.texture);
  }
  glBindTexture(GL_TEXTURE_2D, static_cast<GLuint>(savedTexture));
  glBindFramebuffer(GL_READ_FRAMEBUFFER, static_cast<GLuint>(savedRead));
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, static_cast<GLuint>(savedDraw));
  if (!complete) throw std::runtime_error("renderer framebuffer is incomplete");
}

bool Renderer::ensureFilterTarget(RenderTarget& target, int width, int height, std::size_t slot) {
  if (target.texture && target.width == width && target.height == height) return true;
  auto& cached = filterTargetCache_[slot];
  const bool reused = cached.target.texture && !cached.target.depth &&
      cached.target.width == width && cached.target.height == height;
  GLint savedTexture = 0, savedRead = 0, savedDraw = 0;
  glGetIntegerv(GL_TEXTURE_BINDING_2D, &savedTexture);
  glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &savedRead);
  glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &savedDraw);
  RenderTarget replacement;
  if (reused) {
    replacement = cached.target;
    stats_.rendererTargetCacheBytes -= targetStorageBytes(replacement);
    cached = {};
    if (diagnostics_) ++stats_.rendererTargetCacheHits;
  } else {
    ensureTarget(replacement, width, height);
  }
  std::swap(target, replacement);
  if (replacement.texture && static_cast<GLuint>(savedTexture) == replacement.texture)
    savedTexture = static_cast<GLint>(target.texture);
  if (replacement.framebuffer && static_cast<GLuint>(savedRead) == replacement.framebuffer)
    savedRead = static_cast<GLint>(target.framebuffer);
  if (replacement.framebuffer && static_cast<GLuint>(savedDraw) == replacement.framebuffer)
    savedDraw = static_cast<GLint>(target.framebuffer);

  const auto evict = [&](CachedFilterTarget& entry) {
    if (static_cast<GLuint>(savedTexture) == entry.target.texture) savedTexture = 0;
    if (static_cast<GLuint>(savedRead) == entry.target.framebuffer) savedRead = 0;
    if (static_cast<GLuint>(savedDraw) == entry.target.framebuffer) savedDraw = 0;
    stats_.rendererTargetCacheBytes -= targetStorageBytes(entry.target);
    destroyTarget(entry.target);
    entry.lastUse = 0;
    if (diagnostics_) ++stats_.rendererTargetCacheEvictions;
  };
  if (cached.target.texture) evict(cached);
  const auto bytes = targetStorageBytes(replacement);
  if (replacement.texture && !replacement.depth && bytes <= filterTargetCacheBudget) {
    while (stats_.rendererTargetCacheBytes + bytes > filterTargetCacheBudget) {
      auto oldest = std::min_element(filterTargetCache_.begin(), filterTargetCache_.end(),
        [](const auto& left, const auto& right) {
          if (bool(left.target.texture) != bool(right.target.texture)) return bool(left.target.texture);
          return left.lastUse < right.lastUse;
        });
      evict(*oldest);
    }
    cached.target = replacement;
    cached.lastUse = ++filterTargetCacheClock_;
    stats_.rendererTargetCacheBytes += bytes;
  } else {
    destroyTarget(replacement);
  }
  glBindTexture(GL_TEXTURE_2D, static_cast<GLuint>(savedTexture));
  glBindFramebuffer(GL_READ_FRAMEBUFFER, static_cast<GLuint>(savedRead));
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, static_cast<GLuint>(savedDraw));
  return reused;
}

void Renderer::resizeTargets(int width, int height) {
  if (width == width_ && height == height_) return;
  ensureTarget(sceneTarget_, width, height);
  width_ = width;
  height_ = height;
  hasValidSceneFrame_ = false;
  toneCompositionActive_ = false;
  recomputePresentation();
}

void Renderer::setClearColor(float red, float green, float blue, float alpha) {
  clearColor_ = {red, green, blue, alpha};
}

void Renderer::clearScene(float red, float green, float blue, float alpha,
                          const std::optional<std::array<int, 4>>& clip) {
  if (sceneSubmittedThisFrame_) {
    renderScene();
    discardCommandsFrom(0);
    sceneSubmittedThisFrame_ = false;
  }
  ensureTarget(sceneTarget_, width_, height_);
  if (clip) materializeToneComposition();
  GLint savedFramebuffer = 0;
  GLint savedScissorBox[4]{};
  GLfloat savedClearColor[4]{};
  GLboolean savedColorMask[4]{};
  const GLboolean savedScissor = glIsEnabled(GL_SCISSOR_TEST);
  glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &savedFramebuffer);
  glGetIntegerv(GL_SCISSOR_BOX, savedScissorBox);
  glGetFloatv(GL_COLOR_CLEAR_VALUE, savedClearColor);
  glGetBooleanv(GL_COLOR_WRITEMASK, savedColorMask);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, sceneTarget_.framebuffer);
  if (clip) {
    glEnable(GL_SCISSOR_TEST);
    glScissor((*clip)[0], (*clip)[1], std::max(0, (*clip)[2]),
              std::max(0, (*clip)[3]));
  } else {
    glDisable(GL_SCISSOR_TEST);
  }
  glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
  glClearColor(red, green, blue, alpha);
  glClear(GL_COLOR_BUFFER_BIT);
  glClearColor(savedClearColor[0], savedClearColor[1],
               savedClearColor[2], savedClearColor[3]);
  glColorMask(savedColorMask[0], savedColorMask[1],
              savedColorMask[2], savedColorMask[3]);
  glScissor(savedScissorBox[0], savedScissorBox[1],
            savedScissorBox[2], savedScissorBox[3]);
  if (savedScissor) glEnable(GL_SCISSOR_TEST);
  else glDisable(GL_SCISSOR_TEST);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, static_cast<GLuint>(savedFramebuffer));
  hasValidSceneFrame_ = true;
  toneCompositionActive_ = false;
}

void Renderer::setSceneProjection(const std::array<float, 6>& transform) {
  if (!std::all_of(transform.begin(), transform.end(), [](float value) { return std::isfinite(value); })) {
    throw std::invalid_argument("scene projection must be finite");
  }
  sceneProjection_ = transform;
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
  clearBeforeRender_ = true;
  sceneProjection_ = {1, 0, 0, 1, 0, 0};
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
        static_cast<std::int32_t>(vertices.size() / 6U - 6U), 6, image.premultiplied});
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
  if (diagnostics_) ++stats_.bufferUploads;
  const std::uint32_t handle = nextTileLayer_++;
  tileLayers_.emplace(handle, std::move(layer));
  return handle;
}

std::uint32_t Renderer::createMesh(
    ImageHandle image, const std::vector<float>& positions,
    const std::vector<float>& uvs, const std::vector<std::uint32_t>& indices,
    bool triangleStrip, const MeshMaterial& material) {
  const auto info = images_.lookup(image);
  if (!info || positions.size() < 6 || positions.size() % 2 != 0 ||
      uvs.size() != positions.size() || indices.size() < 3 ||
      indices.size() > 65536U || positions.size() > 131072U) return 0;
  if (const auto* triangle = std::get_if<TriangleBitmapMaterial>(&material)) {
    const auto& values = triangle->coefficients;
    for (float value : values) if (!std::isfinite(value)) return 0;
    if (values[8] <= values[6] || values[9] <= values[7] || values[14] < 0 ||
        values[15] < 1 || values[28] < 0 || values[29] < 0 || values[29] > 31 ||
        values[29] != std::floor(values[29])) return 0;
    for (std::size_t channel = 10; channel < 14; ++channel)
      if (values[channel] < 0 || values[channel] > 1) return 0;
  }
  if (const auto* bitmap = std::get_if<MvBitmapMaterial>(&material)) {
    const auto& bounds = bitmap->texelBounds;
    for (float value : bounds) if (!std::isfinite(value)) return 0;
    if (bounds[0] < 0 || bounds[1] < 0 || bounds[2] < bounds[0] ||
        bounds[3] < bounds[1] || bounds[2] >= info->width || bounds[3] >= info->height) return 0;
  }
  TileLayerResource mesh;
  mesh.material = material;
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
#ifdef PMJS_HAS_SKIA65
  if (const auto* triangle = std::get_if<TriangleBitmapMaterial>(&material);
      triangle && triangle->rasterRule == TriangleBitmapMaterial::RasterRule::canvasFourSample) {
    const auto& p = triangle->coefficients;
    const float width = std::ceil(p[8] - p[6]), height = std::ceil(p[9] - p[7]);
    if (width <= 0 || height <= 0 || width > 8192 || height > 8192) {
      images_.release(image);
      return 0;
    }
    const auto extent = checkedImageExtent(static_cast<int>(width), static_cast<int>(height));
    if (!extent) {
      images_.release(image);
      return 0;
    }
    try {
      mesh.images.reserve(2);
      std::vector<std::uint8_t> coverage(extent->rgbaBytes);
      if (!pmjs_skia65_triangle_coverage(p.data(), p[14], p[15], p[13], p[6], p[7],
          static_cast<int>(width), static_cast<int>(height), coverage.data())) {
        throw std::runtime_error("triangle bitmap rasterization failed");
      }
      const auto mask = images_.createRgba(static_cast<int>(width), static_cast<int>(height), coverage.data());
      if (!mask) {
        images_.release(image);
        return 0;
      }
      mesh.triangleCoverage = mask->handle;
      mesh.images.push_back(mask->handle);
    } catch (...) {
      images_.release(image);
      throw;
    }
  }
#endif
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
                          static_cast<std::int32_t>(triangles.size()), info->premultiplied});
  if (diagnostics_) ++stats_.bufferUploads;
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

std::vector<std::uint8_t> Renderer::captureSceneRawPremultiplied() {
  if (!offscreenRender_) materializeToneComposition();
  std::vector<std::uint8_t> pixels(static_cast<std::size_t>(width_) *
                                   static_cast<std::size_t>(height_) * 4U);
  glBindFramebuffer(GL_READ_FRAMEBUFFER,
                    offscreenRender_ ? offscreenTarget_.framebuffer : sceneTarget_.framebuffer);
  glReadBuffer(GL_COLOR_ATTACHMENT0);
  glPixelStorei(GL_PACK_ALIGNMENT, 1);
  glReadPixels(0, 0, width_, height_, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());
  glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);

  // RenderTexture projection puts logical row zero at GL row zero.
  if (offscreenRender_) return pixels;
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
  return pixels;
}

std::vector<std::uint8_t> Renderer::captureSceneRgba(AlphaMode alphaMode) {
  auto pixels = captureSceneRawPremultiplied();
  if (alphaMode == AlphaMode::straight)
    for (std::size_t offset = 0; offset < pixels.size(); offset += 4)
      convertPixel(pixels.data() + offset, PixelEncoding::PremultipliedRGBA8,
                   pixels.data() + offset, PixelEncoding::StraightRGBA8);
  return pixels;
}

std::vector<std::uint8_t> Renderer::captureDrawableRgba(AlphaMode alphaMode) {
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
  if (alphaMode == AlphaMode::straight)
    for (size_t offset = 0; offset < pixels.size(); offset += 4)
      convertPixel(pixels.data() + offset, PixelEncoding::PremultipliedRGBA8,
                   pixels.data() + offset, PixelEncoding::StraightRGBA8);
  return pixels;
}

std::vector<std::uint8_t> Renderer::renderToRgba(AlphaMode alphaMode) {
  const auto savedClearColor = clearColor_;
  clearColor_ = {0, 0, 0, 0};
  render();
  auto pixels = captureSceneRgba(alphaMode);
  clearColor_ = savedClearColor;
  return pixels;
}

std::vector<std::uint8_t> Renderer::renderToRgba(int width, int height, ImageHandle initialImage, AlphaMode alphaMode) {
  const int savedWidth = width_;
  const int savedHeight = height_;
  const auto savedClearColor = clearColor_;
  const bool savedOffscreenRender = offscreenRender_;
  const bool savedClearBeforeRender = clearBeforeRender_;
  const auto savedProjection = sceneProjection_;
  std::optional<FramePacket> queuedFrame;
  try {
    width_ = width;
    height_ = height;
    offscreenRender_ = true;
    clearColor_ = {0, 0, 0, 0};
    clearBeforeRender_ = true;
    if (initialImage) {
      // Offscreen scratch is shared. Seed from this canvas, not the last target.
      queuedFrame = std::move(frame_);
      frame_ = {};
      sceneProjection_ = {1, 0, 0, 1, 0, 0};
      if (!queueImage(initialImage, {1, 0, 0, 1, 0, 0},
          {0, 0, static_cast<float>(width), static_cast<float>(height)}, 1,
          0xffffff, BlendMode::normal)) throw std::runtime_error("cannot restore render target contents");
      renderScene();
      frame_ = std::move(*queuedFrame);
      queuedFrame.reset();
      sceneProjection_ = savedProjection;
      clearBeforeRender_ = false;
    }
    render();
    auto pixels = captureSceneRgba(alphaMode);
    offscreenRender_ = savedOffscreenRender;
    clearColor_ = savedClearColor;
    clearBeforeRender_ = savedClearBeforeRender;
    sceneProjection_ = savedProjection;
    width_ = savedWidth;
    height_ = savedHeight;
    return pixels;
  } catch (...) {
    if (queuedFrame) {
      discardCommandsFrom(0);
      frame_ = std::move(*queuedFrame);
    }
    offscreenRender_ = savedOffscreenRender;
    clearColor_ = savedClearColor;
    clearBeforeRender_ = savedClearBeforeRender;
    sceneProjection_ = savedProjection;
    width_ = savedWidth;
    height_ = savedHeight;
    throw;
  }
}

std::optional<ImageInfo> Renderer::renderToImage(int width, int height, AlphaMode alphaMode) {
  if (width <= 0 || height <= 0 || width > maxTextureSize_ ||
      height > maxTextureSize_) return std::nullopt;
  if (width != queueWidth_ || height != queueHeight_) {
    throw std::runtime_error("GPU render image dimensions must match the queued target");
  }
  const int savedWidth = width_, savedHeight = height_;
  const auto savedClearColor = clearColor_;
  const bool savedOffscreenRender = offscreenRender_;
  try {
    width_ = width;
    height_ = height;
    offscreenRender_ = true;
    clearColor_ = {0, 0, 0, 0};
    render();
    auto image = images_.createRenderTarget(width_, height_, alphaMode == AlphaMode::premultiplied);
    if (!image) throw std::runtime_error("cannot allocate GPU render image");
    while (glGetError() != GL_NO_ERROR) {}
    std::uint32_t destinationFramebuffer = 0;
    glGenFramebuffers(1, &destinationFramebuffer);
    glBindFramebuffer(GL_FRAMEBUFFER, destinationFramebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                           GL_TEXTURE_2D, image->texture, 0);
    if (diagnostics_) ++stats_.framebufferChecks;
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
    glUniform1i(generatedTexturePremultipliedUniform_, alphaMode == AlphaMode::premultiplied);
    glBindVertexArray(vertexArray_);
    glBindBuffer(GL_ARRAY_BUFFER, vertexBuffer_);
    glBufferData(GL_ARRAY_BUFFER, sizeof(vertices), vertices.data(),
                 GL_STREAM_DRAW);
    if (diagnostics_) ++stats_.bufferUploads;
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, offscreenTarget_.texture);
    glDrawArrays(GL_TRIANGLES, 0, 6);
    if (diagnostics_) ++stats_.drawCalls;
    glDeleteFramebuffers(1, &destinationFramebuffer);
    if (glGetError() != GL_NO_ERROR) {
      images_.release(image->handle);
      throw std::runtime_error("cannot normalize GPU render image");
    }
    offscreenRender_ = savedOffscreenRender;
    clearColor_ = savedClearColor;
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glEnable(GL_BLEND);
    width_ = savedWidth;
    height_ = savedHeight;
    return image;
  } catch (...) {
    width_ = savedWidth;
    height_ = savedHeight;
    offscreenRender_ = savedOffscreenRender;
    clearColor_ = savedClearColor;
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glEnable(GL_BLEND);
    throw;
  }
}

std::optional<ImageInfo> Renderer::captureOffscreenImage() {
  if (!offscreenTarget_.framebuffer) return std::nullopt;
  GLint savedRead = 0, savedTexture = 0;
  glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &savedRead);
  glGetIntegerv(GL_TEXTURE_BINDING_2D, &savedTexture);
  const auto image = images_.createRenderTarget(offscreenTarget_.width, offscreenTarget_.height, true);
  if (!image) {
    glBindTexture(GL_TEXTURE_2D, savedTexture);
    return std::nullopt;
  }
  glBindFramebuffer(GL_READ_FRAMEBUFFER, offscreenTarget_.framebuffer);
  glReadBuffer(GL_COLOR_ATTACHMENT0);
  glBindTexture(GL_TEXTURE_2D, image->texture);
  glCopyTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, 0, 0, image->width, image->height);
  const auto error = glGetError();
  glBindTexture(GL_TEXTURE_2D, savedTexture);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, savedRead);
  if (error != GL_NO_ERROR) {
    images_.release(image->handle);
    throw std::runtime_error("cannot capture render target image");
  }
  return image;
}

std::size_t Renderer::targetStorageBytes(const RenderTarget& target) {
  return target.texture ? static_cast<std::size_t>(target.width) * target.height * (target.depth ? 8U : 4U) : 0;
}

std::size_t Renderer::renderTargetBytes() const {
  return stats_.rendererTargetBytes;
}

}
