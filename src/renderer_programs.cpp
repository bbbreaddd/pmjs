#include "renderer.hpp"
#include "renderer_shaders.hpp"
#include "scene_packet.hpp"

#include <GLES3/gl3.h>

#include <algorithm>
#include <array>
#include <cmath>
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

}  // namespace

Renderer::Renderer(int width, int height, ImageStore& images)
    : width_(width), height_(height), presentationWidth_(width),
      presentationHeight_(height), queueWidth_(width), queueHeight_(height),
      images_(images) {
  glGetIntegerv(GL_MAX_TEXTURE_SIZE, &maxTextureSize_);
  if (maxTextureSize_ <= 0) {
    throw std::runtime_error("cannot query GL_MAX_TEXTURE_SIZE");
  }
  using namespace renderer_shaders;
  program_ = linkProgram(vertexSource, fragmentSource);
  simpleProgram_ = linkProgram(vertexSource, simpleFragmentSource);
  generatedTextureProgram_ = linkProgram(vertexSource,
                                          generatedTextureFragmentSource);
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
  if (sceneFramebuffer_) glDeleteFramebuffers(1, &sceneFramebuffer_);
  if (sceneTexture_) glDeleteTextures(1, &sceneTexture_);
  if (offscreenFramebuffer_) glDeleteFramebuffers(1, &offscreenFramebuffer_);
  if (offscreenTexture_) glDeleteTextures(1, &offscreenTexture_);
  if (filterFramebuffer_) glDeleteFramebuffers(1, &filterFramebuffer_);
  if (filterTexture_) glDeleteTextures(1, &filterTexture_);
  if (bloomFramebuffer_) glDeleteFramebuffers(1, &bloomFramebuffer_);
  if (bloomTexture_) glDeleteTextures(1, &bloomTexture_);
  glDeleteFramebuffers(static_cast<GLsizei>(groupFramebuffers_.size()),
                       groupFramebuffers_.data());
  glDeleteTextures(static_cast<GLsizei>(groupTextures_.size()),
                   groupTextures_.data());
  if (whiteTexture_) glDeleteTextures(1, &whiteTexture_);
  if (vertexBuffer_) glDeleteBuffers(1, &vertexBuffer_);
  if (vertexArray_) glDeleteVertexArrays(1, &vertexArray_);
  if (program_) glDeleteProgram(program_);
  if (simpleProgram_) glDeleteProgram(simpleProgram_);
  if (generatedTextureProgram_) glDeleteProgram(generatedTextureProgram_);
  if (spriteEffectProgram_) glDeleteProgram(spriteEffectProgram_);
  if (tileProgram_) glDeleteProgram(tileProgram_);
}


}  // namespace pmjs
