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
namespace {
bool nearestTileGeometry(const std::vector<TileLayerTile>& tiles) {
  const auto integral = [](float value, float limit) {
    return std::isfinite(value) && std::abs(value) <= limit && value == std::floor(value);
  };
  return std::all_of(tiles.begin(), tiles.end(), [&](const auto& tile) {
    return tile.source[2] >= 1 && tile.source[3] >= 1 &&
      std::all_of(tile.source.begin(), tile.source.end(), [&](float value) { return integral(value, 8192); }) &&
      std::all_of(tile.position.begin(), tile.position.end(), [&](float value) { return integral(value, 8192); }) &&
      integral(tile.source[0] + tile.source[2], 8192) && integral(tile.source[1] + tile.source[3], 8192) &&
      integral(tile.position[0] + tile.source[2], 8192) && integral(tile.position[1] + tile.source[3], 8192) &&
      std::all_of(tile.animation.begin(), tile.animation.end(), [&](float value) { return integral(value, 4); });
  });
}
}  // namespace

void Renderer::finish() { glFinish(); }

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
  if (!replacement.texture) throw std::bad_alloc();
  glBindTexture(GL_TEXTURE_2D, replacement.texture);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, width, height, 0, GL_RGBA,
               GL_UNSIGNED_BYTE, nullptr);
  const auto allocationError = glGetError();
  if (allocationError != GL_NO_ERROR) {
    glDeleteTextures(1, &replacement.texture);
    glBindTexture(GL_TEXTURE_2D, static_cast<GLuint>(savedTexture));
    if (allocationError == GL_OUT_OF_MEMORY) throw std::bad_alloc();
    throw std::runtime_error("cannot allocate renderer target storage");
  }
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glGenFramebuffers(1, &replacement.framebuffer);
  if (!replacement.framebuffer) {
    glDeleteTextures(1, &replacement.texture);
    glBindTexture(GL_TEXTURE_2D, static_cast<GLuint>(savedTexture));
    throw std::bad_alloc();
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
  if (!images_.inspect(image) ||
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

bool Renderer::prepareFourTileBatches(TileLayerResource& layer) {
  if (layer.batchReady) return true;
  layer.fourBatches.clear();
  std::vector<float> attributes;
  for (const auto& run : layer.batches) {
    if (layer.fourBatches.empty()) layer.fourBatches.emplace_back();
    auto* batch = &layer.fourBatches.back();
    int slot = 0;
    while (slot < batch->textureCount && batch->textures[slot].texture != run.texture) ++slot;
    if (slot == 4) {
      layer.fourBatches.emplace_back(); batch = &layer.fourBatches.back(); slot = 0;
    }
    if (slot == batch->textureCount) batch->textures[batch->textureCount++] = run;
    if (!batch->count) batch->first = run.first;
    batch->count += run.count;
    for (int vertex = 0; vertex < run.count; ++vertex)
      attributes.insert(attributes.end(), {static_cast<float>(slot), static_cast<float>(run.textureWidth),
        static_cast<float>(run.textureHeight), run.premultiplied ? 1.0F : 0.0F});
  }
  if (!layer.batchBuffer) glGenBuffers(1, &layer.batchBuffer);
  glBindVertexArray(layer.vertexArray);
  glBindBuffer(GL_ARRAY_BUFFER, layer.batchBuffer);
  while (glGetError() != GL_NO_ERROR) {}
  glBufferData(GL_ARRAY_BUFFER, static_cast<GLsizeiptr>(attributes.size()*sizeof(float)), attributes.data(), GL_DYNAMIC_DRAW);
  if (glGetError() != GL_NO_ERROR) return false;
  glEnableVertexAttribArray(5);
  glVertexAttribPointer(5, 4, GL_FLOAT, GL_FALSE, 4*sizeof(float), nullptr);
  layer.batchBytes = attributes.size()*sizeof(float);
  layer.batchReady = true;
  if (diagnostics_) ++stats_.bufferUploads;
  return true;
}

bool Renderer::prepareTileLayer(TileLayerResource& layer,
    const std::array<float, 2>& animation, bool nearest) {
  if (layer.tiles.empty()) {
    if (layer.mappedEpoch == images_.textureEpoch()) return true;
    layer.nearestTileMapping = layer.nearestTileGeometry;
    for (auto& batch : layer.batches) {
      // Derived textures can be replaced while the logical image and geometry survive.
      const auto image = batch.premultiplied ? images_.lookupPremultiplied(batch.image) : images_.lookup(batch.image);
      if (!image || !image->texture) return false;
      const auto logical = images_.inspect(batch.image);
      layer.nearestTileMapping = layer.nearestTileMapping && logical &&
        logical->width == image->width && logical->height == image->height;
      if (batch.texture != image->texture || batch.textureWidth != image->width ||
          batch.textureHeight != image->height || batch.premultiplied != image->premultiplied) layer.batchReady = false;
      batch.texture = image->texture; batch.textureWidth = image->width; batch.textureHeight = image->height;
      batch.premultiplied = image->premultiplied;
    }
    layer.mappedEpoch = images_.textureEpoch();
    return true;
  }
  if (layer.mappedReady && layer.mappedNearest == nearest &&
      layer.mappedAnimation == animation && layer.mappedEpoch == images_.textureEpoch()) return true;
  auto vertices = layer.tileVertices;
  std::vector<TileBatch> batches;
  bool nearestMapping = layer.nearestTileGeometry;
  for (std::size_t index = 0; index < layer.tiles.size(); ++index) {
    const auto& tile = layer.tiles[index];
    std::optional<SpriteImageRegion> region;
    if (nearest && images_.hasTileBacking(tile.image)) region = images_.resolveSpriteRegion(tile.image,
      tile.source[0]+tile.animation[0]*animation[0], tile.source[1]+tile.animation[1]*animation[1],
      tile.source[2], tile.source[3], true);
    else images_.notePreparedFallback(tile.image, "tile-linear-sampling");
    const auto image = region ? std::optional<ImageInfo>(region->image) : images_.lookupPremultiplied(tile.image);
    if (!image || !image->texture) return false;
    const float x = tile.source[0] + tile.animation[0] * animation[0];
    const float y = tile.source[1] + tile.animation[1] * animation[1];
    if (region) {
      const auto& source = region->source;
      const auto& atlas = region->atlas;
      const float physicalX = x + atlas[0] - source[0];
      const float physicalY = y + atlas[1] - source[1];
      nearestMapping = nearestMapping && source[2] == atlas[2] && source[3] == atlas[3] &&
        x >= source[0] && y >= source[1] &&
        x + tile.source[2] <= source[0] + source[2] && y + tile.source[3] <= source[1] + source[3] &&
        x >= 0 && y >= 0 && x + tile.source[2] <= region->logicalWidth && y + tile.source[3] <= region->logicalHeight &&
        physicalX == std::floor(physicalX) && physicalY == std::floor(physicalY) &&
        physicalX >= 0 && physicalY >= 0 &&
        physicalX + tile.source[2] <= image->width && physicalY + tile.source[3] <= image->height;
    } else {
      // Full-sheet backing shares the logical bounds used for transparent padding.
      const auto logical = images_.inspect(tile.image);
      nearestMapping = nearestMapping && logical && logical->width == image->width && logical->height == image->height;
    }
    const std::array<float, 4> mapping = region ? std::array<float, 4>{
      region->atlas[0]-region->source[0], region->atlas[1]-region->source[1],
      static_cast<float>(region->logicalWidth), static_cast<float>(region->logicalHeight)} : std::array<float, 4>{};
    for (std::size_t corner = 0; corner < 6; ++corner)
      std::copy(mapping.begin(), mapping.end(), vertices.begin()+index*84+corner*14+6);
    if (batches.empty() || batches.back().texture != image->texture) {
      batches.push_back({image->texture, image->width, image->height,
        static_cast<std::int32_t>(index*6), 6, image->premultiplied});
    } else batches.back().count += 6;
  }
  if (!layer.mappedReady || vertices != layer.tileVertices) {
    while (glGetError() != GL_NO_ERROR) {}
    glBindBuffer(GL_ARRAY_BUFFER, layer.vertexBuffer);
    if (!layer.mappedReady) glBufferData(GL_ARRAY_BUFFER,
      static_cast<GLsizeiptr>(vertices.size()*sizeof(float)), vertices.data(), GL_DYNAMIC_DRAW);
    else {
      // Existing geometry remains fixed. Only changed per-quad mapping attributes
      // are uploaded when the authored animation offset or sampling mode changes.
      for (std::size_t index = 0; index < layer.tiles.size(); ++index)
        if (!std::equal(vertices.begin()+index*84, vertices.begin()+(index+1)*84,
                        layer.tileVertices.begin()+index*84))
          glBufferSubData(GL_ARRAY_BUFFER, static_cast<GLintptr>(index*84*sizeof(float)),
            84*sizeof(float), vertices.data()+index*84);
    }
    if (glGetError() != GL_NO_ERROR) {
      const auto owners = layer.owners, queued = layer.queuedReferences;
      for (const auto image : layer.images) images_.notePreparedFallback(image, "tile-geometry-allocation");
      const auto fallback = createOrdinaryTileLayer(layer.tiles);
      if (!fallback) return false;
      std::swap(layer, tileLayers_.at(fallback));
      layer.owners = owners; layer.queuedReferences = queued;
      destroyTileLayer(fallback);
      return true;
    }
    layer.vertexBytes = vertices.size()*sizeof(float);
    if (diagnostics_) ++stats_.bufferUploads;
  }
  layer.batchReady = false;
  layer.tileVertices = std::move(vertices); layer.batches = std::move(batches);
  layer.mappedAnimation = animation; layer.mappedNearest = nearest;
  layer.mappedEpoch = images_.textureEpoch(); layer.mappedReady = true;
  layer.nearestTileMapping = nearestMapping;
  return true;
}

std::uint32_t Renderer::createOrdinaryTileLayer(std::vector<TileLayerTile> tiles) {
  constexpr std::size_t kMaxTileCount = 65536U;
  if (tiles.empty() || tiles.size() > kMaxTileCount) return 0;
  TileLayerResource layer;
  layer.nearestTileGeometry = nearestTileShader_ && nearestTileGeometry(tiles);
  layer.nearestTileMapping = layer.nearestTileGeometry;
  std::unordered_map<ImageHandle, ImageInfo> imageInfo;
  for (const auto& tile : tiles) {
    if (imageInfo.find(tile.image) != imageInfo.end()) continue;
    // Tile slots are uploaded premultiplied before filtering.
    const auto image = images_.lookupPremultiplied(tile.image);
    if (!image) return 0;
    const auto logical = images_.inspect(tile.image);
    layer.nearestTileMapping = layer.nearestTileMapping && logical &&
      logical->width == image->width && logical->height == image->height;
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
  vertices.reserve(tiles.size() * 60U);
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
        tile.animation[0], tile.animation[1],
        sourceLeft+0.5F, sourceTop+0.5F, sourceRight-0.5F, sourceBottom-0.5F});
    };
    append(left, top, sourceLeft, sourceTop);
    append(right, top, sourceRight, sourceTop);
    append(right, bottom, sourceRight, sourceBottom);
    append(left, top, sourceLeft, sourceTop);
    append(right, bottom, sourceRight, sourceBottom);
    append(left, bottom, sourceLeft, sourceBottom);
    if (layer.batches.empty() || layer.batches.back().texture != image.texture) {
      layer.batches.push_back({image.texture, image.width, image.height,
        static_cast<std::int32_t>(vertices.size() / 10U - 6U), 6, image.premultiplied, tile.image});
    } else {
      layer.batches.back().count += 6;
    }
  }

  glGenVertexArrays(1, &layer.vertexArray);
  glGenBuffers(1, &layer.vertexBuffer);
  glBindVertexArray(layer.vertexArray);
  glBindBuffer(GL_ARRAY_BUFFER, layer.vertexBuffer);
  while (glGetError() != GL_NO_ERROR) {}
  glBufferData(GL_ARRAY_BUFFER,
               static_cast<GLsizeiptr>(vertices.size() * sizeof(float)),
               vertices.data(), GL_STATIC_DRAW);
  if (glGetError() != GL_NO_ERROR) {
    glDeleteBuffers(1, &layer.vertexBuffer); glDeleteVertexArrays(1, &layer.vertexArray);
    glBindVertexArray(vertexArray_);
    for (const auto image : layer.images) images_.release(image);
    return 0;
  }
  layer.vertexBytes = vertices.size()*sizeof(float);
  glEnableVertexAttribArray(0);
  glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 10 * sizeof(float), nullptr);
  glEnableVertexAttribArray(1);
  glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 10 * sizeof(float),
                        reinterpret_cast<void*>(2 * sizeof(float)));
  glEnableVertexAttribArray(2);
  glVertexAttribPointer(2, 2, GL_FLOAT, GL_FALSE, 10 * sizeof(float),
                        reinterpret_cast<void*>(4 * sizeof(float)));
  glEnableVertexAttribArray(4);
  glVertexAttribPointer(4, 4, GL_FLOAT, GL_FALSE, 10 * sizeof(float),
                        reinterpret_cast<void*>(6 * sizeof(float)));
  glBindVertexArray(vertexArray_);
  if (diagnostics_) ++stats_.bufferUploads;
  const std::uint32_t handle = nextTileLayer_++;
  tileLayers_.emplace(handle, std::move(layer));
  return handle;
}

std::uint32_t Renderer::createTileLayer(std::vector<TileLayerTile> tiles) {
  if (std::none_of(tiles.begin(), tiles.end(), [&](const auto& tile) { return images_.hasTileBacking(tile.image); }))
    return createOrdinaryTileLayer(std::move(tiles));
  constexpr std::size_t kMaxTileCount = 65536U;
  if (tiles.empty() || tiles.size() > kMaxTileCount) return 0;
  TileLayerResource layer;
  layer.nearestTileGeometry = nearestTileShader_ && nearestTileGeometry(tiles);
  for (const auto& tile : tiles) {
    if (std::find(layer.images.begin(), layer.images.end(), tile.image) != layer.images.end()) continue;
    if (!images_.inspect(tile.image) || !images_.retain(tile.image)) {
      for (const auto image : layer.images) images_.release(image);
      return 0;
    }
    layer.images.push_back(tile.image);
  }
  layer.tileVertices.reserve(tiles.size()*84);
  for (const auto& tile : tiles) {
    const float left = tile.position[0], top = tile.position[1];
    const float right = left+tile.source[2], bottom = top+tile.source[3];
    const float sx = tile.source[0], sy = tile.source[1];
    const auto append = [&](float x, float y, float u, float v) {
      layer.tileVertices.insert(layer.tileVertices.end(), {x,y,u,v,tile.animation[0],tile.animation[1],0,0,0,0,
        sx+0.5F,sy+0.5F,sx+tile.source[2]-0.5F,sy+tile.source[3]-0.5F});
    };
    append(left,top,sx,sy); append(right,top,sx+tile.source[2],sy);
    append(right,bottom,sx+tile.source[2],sy+tile.source[3]); append(left,top,sx,sy);
    append(right,bottom,sx+tile.source[2],sy+tile.source[3]); append(left,bottom,sx,sy+tile.source[3]);
  }
  layer.tiles = std::move(tiles);
  glGenVertexArrays(1, &layer.vertexArray); glGenBuffers(1, &layer.vertexBuffer);
  glBindVertexArray(layer.vertexArray); glBindBuffer(GL_ARRAY_BUFFER, layer.vertexBuffer);
  glEnableVertexAttribArray(0); glVertexAttribPointer(0,2,GL_FLOAT,GL_FALSE,14*sizeof(float),nullptr);
  glEnableVertexAttribArray(1); glVertexAttribPointer(1,2,GL_FLOAT,GL_FALSE,14*sizeof(float),reinterpret_cast<void*>(2*sizeof(float)));
  glEnableVertexAttribArray(2); glVertexAttribPointer(2,2,GL_FLOAT,GL_FALSE,14*sizeof(float),reinterpret_cast<void*>(4*sizeof(float)));
  glEnableVertexAttribArray(3); glVertexAttribPointer(3,4,GL_FLOAT,GL_FALSE,14*sizeof(float),reinterpret_cast<void*>(6*sizeof(float)));
  glEnableVertexAttribArray(4); glVertexAttribPointer(4,4,GL_FLOAT,GL_FALSE,14*sizeof(float),reinterpret_cast<void*>(10*sizeof(float)));
  glBindVertexArray(vertexArray_);
  // Sampling is chosen at submission, before ordinary lookup can materialize a full sheet.
  const auto handle = nextTileLayer_++;
  tileLayers_.emplace(handle, std::move(layer));
  return handle;
}

std::uint32_t Renderer::createMesh(
    ImageHandle image, const std::vector<float>& positions,
    const std::vector<double>& uvs, const std::vector<std::uint32_t>& indices,
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
  if (std::holds_alternative<TriangleBitmapMaterial>(material) && positions.size() == 8 &&
      positions[1] == positions[3] && positions[2] == positions[4] &&
      positions[5] == positions[7] && positions[0] == positions[6] &&
      uvs[1] == uvs[3] && uvs[2] == uvs[4] && uvs[5] == uvs[7] && uvs[0] == uvs[6] &&
      positions[2] != positions[0] && positions[7] != positions[1]) {
    // Retain the pixel-space crop before normalized UVs lose subtexel precision.
    const double sx = (uvs[2] - uvs[0]) * info->width / (double(positions[2]) - positions[0]);
    const double sy = (uvs[7] - uvs[1]) * info->height / (double(positions[7]) - positions[1]);
    mesh.triangleSourceMapping = {static_cast<float>(sx), static_cast<float>(sy),
      static_cast<float>(uvs[0] * info->width - positions[0] * sx),
      static_cast<float>(uvs[1] * info->height - positions[1] * sy)};
    mesh.triangleSourceMappingEnabled = std::all_of(mesh.triangleSourceMapping.begin(),
      mesh.triangleSourceMapping.end(), [](float value) { return std::isfinite(value); });
  }
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
      static_cast<float>(uvs[offset]) * static_cast<float>(info->width),
      static_cast<float>(uvs[offset + 1]) * static_cast<float>(info->height), 0, 0});
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
  mesh.vertexBytes = vertices.size()*sizeof(float);
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
                          static_cast<std::int32_t>(triangles.size()), info->premultiplied, image});
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
  if (found->second.batchBuffer) glDeleteBuffers(1, &found->second.batchBuffer);
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
    if (!image) throw std::bad_alloc();
    while (glGetError() != GL_NO_ERROR) {}
    std::uint32_t destinationFramebuffer = 0;
    glGenFramebuffers(1, &destinationFramebuffer);
    if (!destinationFramebuffer) {
      images_.release(image->handle);
      throw std::bad_alloc();
    }
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

std::size_t Renderer::tileGeometryGpuBytes() const {
  std::size_t bytes = 0;
  for (const auto& [_, layer] : tileLayers_) bytes += layer.vertexBytes + layer.batchBytes;
  return bytes;
}
std::size_t Renderer::tileGeometryCpuBytes() const {
  std::size_t bytes = 0;
  for (const auto& [_, layer] : tileLayers_) bytes += layer.tiles.capacity()*sizeof(TileLayerTile)+
    layer.tileVertices.capacity()*sizeof(float)+layer.images.capacity()*sizeof(ImageHandle)+layer.batches.capacity()*sizeof(TileBatch)+layer.fourBatches.capacity()*sizeof(FourTileBatch);
  return bytes;
}
std::size_t Renderer::renderTargetBytes() const {
  return stats_.rendererTargetBytes;
}

}
