#include "renderer.hpp"
#include "renderer_shaders.hpp"
#include "scene_packet.hpp"

#include <GLES3/gl3.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <utility>

namespace pmjs {
namespace {

GLuint compileShader(GLenum type, const char* source) {
  const GLuint shader = glCreateShader(type);
  glShaderSource(shader, 1, &source, nullptr);
  glCompileShader(shader);
  GLint compiled = GL_FALSE;
  glGetShaderiv(shader, GL_COMPILE_STATUS, &compiled);
  if (compiled == GL_TRUE) return shader;

  std::array<char, 2048> log{};
  glGetShaderInfoLog(shader, static_cast<GLsizei>(log.size()), nullptr, log.data());
  glDeleteShader(shader);
  throw std::runtime_error(std::string("shader compilation failed: ") + log.data());
}

GLuint linkProgram(const char* vertexSource, const char* fragmentSource) {
  const GLuint vertex = compileShader(GL_VERTEX_SHADER, vertexSource);
  const GLuint fragment = compileShader(GL_FRAGMENT_SHADER, fragmentSource);
  const GLuint program = glCreateProgram();
  glAttachShader(program, vertex);
  glAttachShader(program, fragment);
  glLinkProgram(program);
  glDeleteShader(vertex);
  glDeleteShader(fragment);

  GLint linked = GL_FALSE;
  glGetProgramiv(program, GL_LINK_STATUS, &linked);
  if (linked == GL_TRUE) return program;
  glDeleteProgram(program);
  throw std::runtime_error("shader program link failed");
}

constexpr std::uint32_t primitiveSurfaceTag = 0x40000000U;
constexpr std::uint32_t primitiveSurfaceIndexMask = 0x0000ffffU;
constexpr std::uint16_t primitiveSurfaceGenerationMask = 0x3fffU;

}  // namespace

Renderer::Renderer(int width, int height, ImageStore& images)
    : width_(width), height_(height), presentationWidth_(width),
      presentationHeight_(height), queueWidth_(width), queueHeight_(height),
      images_(images) {
  const char* filterBounds = std::getenv("PMJS_FILTER_BOUNDS");
  filterBoundsEnabled_ = !(filterBounds && std::string(filterBounds) == "0");
  presentation_.scaleMode = presentScaleModeFromEnvironment();
  hasFilterOverride_ =
      presentFilterOverrideFromEnvironment(&filterOverride_);
  presentation_.drawableWidth = width;
  presentation_.drawableHeight = height;
  recomputePresentation();
  glGetIntegerv(GL_MAX_TEXTURE_SIZE, &maxTextureSize_);
  if (maxTextureSize_ <= 0) {
    throw std::runtime_error("cannot query GL_MAX_TEXTURE_SIZE");
  }
  using namespace renderer_shaders;
  program_ = linkProgram(vertexSource, fragmentSource);
  simpleProgram_ = linkProgram(vertexSource, simpleFragmentSource);
  generatedTextureProgram_ = linkProgram(vertexSource,
                                          generatedTextureFragmentSource);
  presentationProgram_ = linkProgram(presentationVertexSource,
                                     presentationFragmentSource);
  presentationSceneUniform_ =
    glGetUniformLocation(presentationProgram_, "sceneImage");
  presentationOverlayUniform_ =
    glGetUniformLocation(presentationProgram_, "overlayImage");
  presentationColorMatrixUniform_ =
    glGetUniformLocation(presentationProgram_, "colorMatrix");
  presentationColorMatrixAlphaUniform_ =
    glGetUniformLocation(presentationProgram_, "colorMatrixAlpha");
  spriteEffectProgram_ = linkProgram(vertexSource, spriteEffectFragmentSource);
  spriteEffectTextureSizeUniform_ =
    glGetUniformLocation(spriteEffectProgram_, "textureSize");
  spriteEffectBlurUniform_ =
    glGetUniformLocation(spriteEffectProgram_, "blurRadius");
  spriteEffectMaskEnabledUniform_ =
    glGetUniformLocation(spriteEffectProgram_, "maskEnabled");
  spriteEffectMaskImageUniform_ =
    glGetUniformLocation(spriteEffectProgram_, "maskImage");
  spriteEffectMaskTransformUniform_ =
    glGetUniformLocation(spriteEffectProgram_, "maskTransform");
  spriteEffectMaskTextureSizeUniform_ =
    glGetUniformLocation(spriteEffectProgram_, "maskTextureSize");
  spriteEffectScreenHeightUniform_ =
    glGetUniformLocation(spriteEffectProgram_, "screenHeight");
  spriteEffectColorEnabledUniform_ =
    glGetUniformLocation(spriteEffectProgram_, "spriteColorEnabled");
  spriteEffectColorToneUniform_ =
    glGetUniformLocation(spriteEffectProgram_, "spriteColorTone");
  spriteEffectBlendColorUniform_ =
    glGetUniformLocation(spriteEffectProgram_, "spriteBlendColor");
  textureSizeUniform_ = glGetUniformLocation(program_, "textureSize");
  blurUniform_ = glGetUniformLocation(program_, "blurRadius");
  blurDirectionUniform_ = glGetUniformLocation(program_, "blurDirection");
  displacementEnabledUniform_ =
    glGetUniformLocation(program_, "displacementEnabled");
  displacementImageUniform_ =
    glGetUniformLocation(program_, "displacementImage");
  displacementBoundsUniform_ =
    glGetUniformLocation(program_, "displacementBounds");
  displacementScaleUniform_ =
    glGetUniformLocation(program_, "displacementScale");
  noiseGlitchEnabledUniform_ =
    glGetUniformLocation(program_, "noiseGlitchEnabled");
  noiseGlitchParametersUniform_ =
    glGetUniformLocation(program_, "noiseGlitchParameters");
  pixiFilterKindUniform_ = glGetUniformLocation(program_, "pixiFilterKind");
  pixiFilterParametersUniform_ = glGetUniformLocation(program_, "pixiFilterParameters");
  bloomImageUniform_ = glGetUniformLocation(program_, "bloomImage");
  premultipliedInputUniform_ =
    glGetUniformLocation(program_, "premultipliedInput");
  maskEnabledUniform_ = glGetUniformLocation(program_, "maskEnabled");
  maskImageUniform_ = glGetUniformLocation(program_, "maskImage");
  maskTransformUniform_ = glGetUniformLocation(program_, "maskTransform");
  maskFrameUniform_ = glGetUniformLocation(program_, "maskFrame");
  maskTextureSizeUniform_ = glGetUniformLocation(program_, "maskTextureSize");
  maskScreenHeightUniform_ = glGetUniformLocation(program_, "screenHeight");
  maskAlphaUniform_ = glGetUniformLocation(program_, "maskAlpha");
  maskUsesRedUniform_ = glGetUniformLocation(program_, "maskUsesRed");
  maskRotationUniform_ = glGetUniformLocation(program_, "maskRotation");
  maskLocalSizeUniform_ = glGetUniformLocation(program_, "maskLocalSize");
  colorMatrixEnabledUniform_ = glGetUniformLocation(program_, "colorMatrixEnabled");
  colorMatrixUniform_ = glGetUniformLocation(program_, "colorMatrix");
  colorMatrixAlphaUniform_ = glGetUniformLocation(program_, "colorMatrixAlpha");
  spriteColorEnabledUniform_ = glGetUniformLocation(program_, "spriteColorEnabled");
  spriteColorToneUniform_ = glGetUniformLocation(program_, "spriteColorTone");
  spriteBlendColorUniform_ = glGetUniformLocation(program_, "spriteBlendColor");
  tileProgram_ = linkProgram(tileVertexSource, tileFragmentSource);
  tileWorldUniform_ = glGetUniformLocation(tileProgram_, "world");
  tileScreenUniform_ = glGetUniformLocation(tileProgram_, "screenSize");
  tileAnimationUniform_ = glGetUniformLocation(tileProgram_, "animationOffset");
  tileTextureSizeUniform_ = glGetUniformLocation(tileProgram_, "textureSize");
  tileColorUniform_ = glGetUniformLocation(tileProgram_, "color");
  tileMaskEnabledUniform_ = glGetUniformLocation(tileProgram_, "maskEnabled");
  tileMaskImageUniform_ = glGetUniformLocation(tileProgram_, "maskImage");
  tileMaskTransformUniform_ = glGetUniformLocation(tileProgram_, "maskTransform");
  tileMaskFrameUniform_ = glGetUniformLocation(tileProgram_, "maskFrame");
  tileMaskTextureSizeUniform_ = glGetUniformLocation(tileProgram_, "maskTextureSize");
  tileMaskScreenHeightUniform_ = glGetUniformLocation(tileProgram_, "screenHeight");
  primitiveSurfaceProgram_ = linkProgram(vertexSource,
                                          primitiveSurfaceFragmentSource);
  primitiveSurfaceSizeUniform_ =
    glGetUniformLocation(primitiveSurfaceProgram_, "surfaceSize");
  primitiveSurfaceKindUniform_ =
    glGetUniformLocation(primitiveSurfaceProgram_, "primitiveKind");
  primitiveSurfaceCenterUniform_ =
    glGetUniformLocation(primitiveSurfaceProgram_, "center");
  primitiveSurfaceRadiiUniform_ =
    glGetUniformLocation(primitiveSurfaceProgram_, "radii");
  primitiveSurfaceStopCountUniform_ =
    glGetUniformLocation(primitiveSurfaceProgram_, "stopCount");
  primitiveSurfaceOffsetsUniform_ =
    glGetUniformLocation(primitiveSurfaceProgram_, "stopOffsets");
  primitiveSurfaceColorsUniform_ =
    glGetUniformLocation(primitiveSurfaceProgram_, "stopColors");

  glGenVertexArrays(1, &vertexArray_);
  glGenBuffers(1, &vertexBuffer_);
  glBindVertexArray(vertexArray_);
  glBindBuffer(GL_ARRAY_BUFFER, vertexBuffer_);
  glEnableVertexAttribArray(0);
  glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 12 * sizeof(float), nullptr);
  glEnableVertexAttribArray(1);
  glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 12 * sizeof(float),
                        reinterpret_cast<void*>(2 * sizeof(float)));
  glEnableVertexAttribArray(2);
  glVertexAttribPointer(2, 4, GL_FLOAT, GL_FALSE, 12 * sizeof(float),
                        reinterpret_cast<void*>(4 * sizeof(float)));
  glEnableVertexAttribArray(3);
  glVertexAttribPointer(3, 4, GL_FLOAT, GL_FALSE, 12 * sizeof(float),
                        reinterpret_cast<void*>(8 * sizeof(float)));
  glGenTextures(1, &whiteTexture_);
  glBindTexture(GL_TEXTURE_2D, whiteTexture_);
  constexpr std::uint32_t white = 0xffffffffU;
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 1, 1, 0, GL_RGBA,
               GL_UNSIGNED_BYTE, &white);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
  glGenTextures(1, &blackTexture_);
  glBindTexture(GL_TEXTURE_2D, blackTexture_);
  constexpr std::uint8_t black[4] = {0, 0, 0, 255};
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 1, 1, 0, GL_RGBA,
               GL_UNSIGNED_BYTE, black);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
  glGenFramebuffers(1, &blackFramebuffer_);
  glBindFramebuffer(GL_FRAMEBUFFER, blackFramebuffer_);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                         GL_TEXTURE_2D, blackTexture_, 0);
  if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
    throw std::runtime_error("letterbox framebuffer is incomplete");
  }

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
        throw std::runtime_error("renderer framebuffer is incomplete");
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
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  glEnable(GL_BLEND);
  glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
}

Renderer::~Renderer() {
  discardCommandsFrom(0);
  while (!tileLayers_.empty()) destroyTileLayer(tileLayers_.begin()->first);
  for (std::size_t index = 0; index < primitiveSurfaces_.size(); ++index) {
    auto& surface = primitiveSurfaces_[index];
    if (surface.live) releasePrimitiveSurface(
      makePrimitiveSurfaceHandle(index, surface.generation));
  }
  if (sceneFramebuffer_) glDeleteFramebuffers(1, &sceneFramebuffer_);
  if (sceneTexture_) glDeleteTextures(1, &sceneTexture_);
  if (offscreenFramebuffer_) glDeleteFramebuffers(1, &offscreenFramebuffer_);
  if (offscreenTexture_) glDeleteTextures(1, &offscreenTexture_);
  if (filterFramebuffer_) glDeleteFramebuffers(1, &filterFramebuffer_);
  if (filterTexture_) glDeleteTextures(1, &filterTexture_);
  if (toneOverlayFramebuffer_) glDeleteFramebuffers(1, &toneOverlayFramebuffer_);
  if (toneOverlayTexture_) glDeleteTextures(1, &toneOverlayTexture_);
  if (bloomFramebuffer_) glDeleteFramebuffers(1, &bloomFramebuffer_);
  if (bloomTexture_) glDeleteTextures(1, &bloomTexture_);
  glDeleteFramebuffers(static_cast<GLsizei>(groupFramebuffers_.size()),
                       groupFramebuffers_.data());
  glDeleteTextures(static_cast<GLsizei>(groupTextures_.size()),
                   groupTextures_.data());
  if (whiteTexture_) glDeleteTextures(1, &whiteTexture_);
  if (blackFramebuffer_) glDeleteFramebuffers(1, &blackFramebuffer_);
  if (blackTexture_) glDeleteTextures(1, &blackTexture_);
  if (vertexBuffer_) glDeleteBuffers(1, &vertexBuffer_);
  if (vertexArray_) glDeleteVertexArrays(1, &vertexArray_);
  if (program_) glDeleteProgram(program_);
  if (simpleProgram_) glDeleteProgram(simpleProgram_);
  if (generatedTextureProgram_) glDeleteProgram(generatedTextureProgram_);
  if (presentationProgram_) glDeleteProgram(presentationProgram_);
  if (spriteEffectProgram_) glDeleteProgram(spriteEffectProgram_);
  if (tileProgram_) glDeleteProgram(tileProgram_);
  if (primitiveSurfaceProgram_) glDeleteProgram(primitiveSurfaceProgram_);
}

PrimitiveSurfaceHandle Renderer::makePrimitiveSurfaceHandle(
    std::size_t index, std::uint16_t generation) {
  return primitiveSurfaceTag |
    (static_cast<std::uint32_t>(generation & primitiveSurfaceGenerationMask) << 16U) |
    static_cast<std::uint32_t>(index + 1U);
}

Renderer::PrimitiveSurfaceResource* Renderer::lookupPrimitiveSurface(
    PrimitiveSurfaceHandle handle) {
  if ((handle & 0xc0000000U) != primitiveSurfaceTag) return nullptr;
  const std::uint32_t encodedIndex = handle & primitiveSurfaceIndexMask;
  if (encodedIndex == 0) return nullptr;
  const std::size_t index = encodedIndex - 1U;
  const auto generation = static_cast<std::uint16_t>(
    (handle >> 16U) & primitiveSurfaceGenerationMask);
  if (index >= primitiveSurfaces_.size()) return nullptr;
  auto& surface = primitiveSurfaces_[index];
  return surface.live && surface.generation == generation ? &surface : nullptr;
}

std::optional<Renderer::PrimitiveSurfaceInfo> Renderer::createPrimitiveSurface(
    int width, int height) {
  if (width <= 0 || height <= 0 || width > maxTextureSize_ ||
      height > maxTextureSize_) return std::nullopt;
  const std::uint64_t byteCount = static_cast<std::uint64_t>(width) * height * 4U;
  if (byteCount > 64U * 1024U * 1024U) return std::nullopt;
  GLint previousTexture = 0;
  GLint previousUnpackAlignment = 0;
  glGetIntegerv(GL_TEXTURE_BINDING_2D, &previousTexture);
  glGetIntegerv(GL_UNPACK_ALIGNMENT, &previousUnpackAlignment);
  auto image = images_.createRenderTarget(width, height);
  if (!image) {
    glBindTexture(GL_TEXTURE_2D, static_cast<GLuint>(previousTexture));
    glPixelStorei(GL_UNPACK_ALIGNMENT, previousUnpackAlignment);
    return std::nullopt;
  }
  GLint previousFramebuffer = 0;
  glGetIntegerv(GL_FRAMEBUFFER_BINDING, &previousFramebuffer);
  std::uint32_t framebuffer = 0;
  glGenFramebuffers(1, &framebuffer);
  glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D,
                         image->texture, 0);
  ++stats_.framebufferChecks;
  if (!framebuffer ||
      glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
    if (framebuffer) glDeleteFramebuffers(1, &framebuffer);
    images_.release(image->handle);
    glBindFramebuffer(GL_FRAMEBUFFER, previousFramebuffer);
    glBindTexture(GL_TEXTURE_2D, static_cast<GLuint>(previousTexture));
    glPixelStorei(GL_UNPACK_ALIGNMENT, previousUnpackAlignment);
    return std::nullopt;
  }
  std::size_t index = 0;
  while (index < primitiveSurfaces_.size() && primitiveSurfaces_[index].live) ++index;
  if (index >= primitiveSurfaceIndexMask) {
    glDeleteFramebuffers(1, &framebuffer);
    images_.release(image->handle);
    glBindFramebuffer(GL_FRAMEBUFFER, previousFramebuffer);
    glBindTexture(GL_TEXTURE_2D, static_cast<GLuint>(previousTexture));
    glPixelStorei(GL_UNPACK_ALIGNMENT, previousUnpackAlignment);
    return std::nullopt;
  }
  if (index == primitiveSurfaces_.size()) primitiveSurfaces_.emplace_back();
  auto& surface = primitiveSurfaces_[index];
  surface.image = image->handle;
  surface.framebuffer = framebuffer;
  surface.width = width;
  surface.height = height;
  surface.live = true;
  const auto handle = makePrimitiveSurfaceHandle(index, surface.generation);
  glBindFramebuffer(GL_FRAMEBUFFER, previousFramebuffer);
  glBindTexture(GL_TEXTURE_2D, static_cast<GLuint>(previousTexture));
  glPixelStorei(GL_UNPACK_ALIGNMENT, previousUnpackAlignment);
  return PrimitiveSurfaceInfo{handle, *image};
}

bool Renderer::renderPrimitiveSurface(
    PrimitiveSurfaceHandle handle, const std::array<float, 4>& clearColor,
    const std::vector<PrimitiveSurfacePrimitive>& primitives) {
  auto* surface = lookupPrimitiveSurface(handle);
  if (!surface || primitives.size() > 4096) return false;
  for (const float channel : clearColor) {
    if (!std::isfinite(channel) || channel < 0 || channel > 1) return false;
  }
  for (const auto& primitive : primitives) {
    if (primitive.stopCount == 0 || primitive.stopCount > 3 ||
        static_cast<std::uint8_t>(primitive.kind) > 1 ||
        static_cast<std::uint8_t>(primitive.composition) > 1) return false;
    for (const float value : primitive.bounds) if (!std::isfinite(value)) return false;
    for (const float value : primitive.center) if (!std::isfinite(value)) return false;
    for (const float value : primitive.radii) if (!std::isfinite(value)) return false;
    float previousOffset = -1.0F;
    for (std::size_t stop = 0; stop < primitive.stopCount; ++stop) {
      const float offset = primitive.offsets[stop];
      if (!std::isfinite(offset) || offset < 0 || offset > 1 ||
          offset < previousOffset) return false;
      previousOffset = offset;
      for (const float channel : primitive.colors[stop]) {
        if (!std::isfinite(channel) || channel < 0 || channel > 1) return false;
      }
    }
    if (primitive.kind == PrimitiveSurfacePrimitive::Kind::concentricRadialGradient &&
        (primitive.radii[0] < 0 || primitive.radii[1] <= primitive.radii[0])) {
      return false;
    }
  }
  GLint previousFramebuffer = 0;
  GLint previousViewport[4]{};
  GLint previousProgram = 0;
  GLint previousVertexArray = 0;
  GLint previousArrayBuffer = 0;
  GLint previousBlendSourceRgb = 0, previousBlendDestinationRgb = 0;
  GLint previousBlendSourceAlpha = 0, previousBlendDestinationAlpha = 0;
  GLfloat previousClearColor[4]{};
  const GLboolean scissorWasEnabled = glIsEnabled(GL_SCISSOR_TEST);
  const GLboolean blendWasEnabled = glIsEnabled(GL_BLEND);
  glGetIntegerv(GL_FRAMEBUFFER_BINDING, &previousFramebuffer);
  glGetIntegerv(GL_VIEWPORT, previousViewport);
  glGetIntegerv(GL_CURRENT_PROGRAM, &previousProgram);
  glGetIntegerv(GL_VERTEX_ARRAY_BINDING, &previousVertexArray);
  glGetIntegerv(GL_ARRAY_BUFFER_BINDING, &previousArrayBuffer);
  glGetIntegerv(GL_BLEND_SRC_RGB, &previousBlendSourceRgb);
  glGetIntegerv(GL_BLEND_DST_RGB, &previousBlendDestinationRgb);
  glGetIntegerv(GL_BLEND_SRC_ALPHA, &previousBlendSourceAlpha);
  glGetIntegerv(GL_BLEND_DST_ALPHA, &previousBlendDestinationAlpha);
  glGetFloatv(GL_COLOR_CLEAR_VALUE, previousClearColor);
  glBindFramebuffer(GL_FRAMEBUFFER, surface->framebuffer);
  glViewport(0, 0, surface->width, surface->height);
  glDisable(GL_SCISSOR_TEST);
  glClearColor(clearColor[0], clearColor[1], clearColor[2], clearColor[3]);
  glClear(GL_COLOR_BUFFER_BIT);
  glUseProgram(primitiveSurfaceProgram_);
  glBindVertexArray(vertexArray_);
  glUniform2f(primitiveSurfaceSizeUniform_, static_cast<float>(surface->width),
              static_cast<float>(surface->height));

  for (const auto& primitive : primitives) {
    const float x0 = primitive.bounds[0];
    const float y0 = primitive.bounds[1];
    const float x1 = x0 + primitive.bounds[2];
    const float y1 = y0 + primitive.bounds[3];
    if (!std::isfinite(x0) || !std::isfinite(y0) || !std::isfinite(x1) ||
        !std::isfinite(y1) || x1 <= x0 || y1 <= y0) continue;
    const auto clipX = [&](float x) { return x / surface->width * 2.0F - 1.0F; };
    const auto clipY = [&](float y) { return 1.0F - y / surface->height * 2.0F; };
    const float left = clipX(x0), right = clipX(x1);
    const float top = clipY(y0), bottom = clipY(y1);
    const std::array<float, 72> vertices = {
      left, top, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1,
      right, top, 1, 0, 1, 1, 1, 1, 0, 0, 1, 1,
      right, bottom, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1,
      left, top, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1,
      right, bottom, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1,
      left, bottom, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1,
    };
    glBindBuffer(GL_ARRAY_BUFFER, vertexBuffer_);
    glBufferData(GL_ARRAY_BUFFER, sizeof(vertices), vertices.data(), GL_STREAM_DRAW);
    ++stats_.bufferUploads;
    glUniform1i(primitiveSurfaceKindUniform_,
      primitive.kind ==
        PrimitiveSurfacePrimitive::Kind::concentricRadialGradient ? 1 : 0);
    glUniform2fv(primitiveSurfaceCenterUniform_, 1, primitive.center.data());
    glUniform2fv(primitiveSurfaceRadiiUniform_, 1, primitive.radii.data());
    glUniform1i(primitiveSurfaceStopCountUniform_, primitive.stopCount);
    glUniform1fv(primitiveSurfaceOffsetsUniform_, 3, primitive.offsets.data());
    glUniform4fv(primitiveSurfaceColorsUniform_, 3, primitive.colors[0].data());
    switch (primitive.composition) {
      case PrimitiveComposition::sourceOver:
        glBlendFuncSeparate(GL_ONE, GL_ONE_MINUS_SRC_ALPHA,
                            GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
        break;
      case PrimitiveComposition::additive:
        glBlendFuncSeparate(GL_ONE, GL_ONE, GL_ONE, GL_ONE);
        break;
    }
    glEnable(GL_BLEND);
    glDrawArrays(GL_TRIANGLES, 0, 6);
    ++stats_.drawCalls;
  }
  glBindFramebuffer(GL_FRAMEBUFFER, previousFramebuffer);
  glViewport(previousViewport[0], previousViewport[1], previousViewport[2],
             previousViewport[3]);
  glUseProgram(static_cast<GLuint>(previousProgram));
  glBindVertexArray(static_cast<GLuint>(previousVertexArray));
  glBindBuffer(GL_ARRAY_BUFFER, static_cast<GLuint>(previousArrayBuffer));
  glBlendFuncSeparate(previousBlendSourceRgb, previousBlendDestinationRgb,
                      previousBlendSourceAlpha, previousBlendDestinationAlpha);
  if (blendWasEnabled) glEnable(GL_BLEND); else glDisable(GL_BLEND);
  if (scissorWasEnabled) glEnable(GL_SCISSOR_TEST); else glDisable(GL_SCISSOR_TEST);
  glClearColor(previousClearColor[0], previousClearColor[1],
               previousClearColor[2], previousClearColor[3]);
  return true;
}

bool Renderer::releasePrimitiveSurface(PrimitiveSurfaceHandle handle) {
  auto* surface = lookupPrimitiveSurface(handle);
  if (!surface) return false;
  if (surface->framebuffer) glDeleteFramebuffers(1, &surface->framebuffer);
  images_.release(surface->image);
  surface->image = 0;
  surface->framebuffer = 0;
  surface->width = 0;
  surface->height = 0;
  surface->live = false;
  surface->generation = static_cast<std::uint16_t>(
    (surface->generation + 1U) & primitiveSurfaceGenerationMask);
  if (surface->generation == 0) surface->generation = 1;
  return true;
}


}  // namespace pmjs
