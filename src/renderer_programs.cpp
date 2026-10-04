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
  GLuint fragment = 0;
  try {
    fragment = compileShader(GL_FRAGMENT_SHADER, fragmentSource);
  } catch (...) {
    glDeleteShader(vertex);
    throw;
  }
  const GLuint program = glCreateProgram();
  glAttachShader(program, vertex);
  glAttachShader(program, fragment);
  glBindAttribLocation(program, 0, "position");
  glBindAttribLocation(program, 1, "uv");
  glBindAttribLocation(program, 0, "aVertexPosition");
  glBindAttribLocation(program, 1, "aTextureCoord");
  glLinkProgram(program);
  glDeleteShader(vertex);
  glDeleteShader(fragment);

  GLint linked = GL_FALSE;
  glGetProgramiv(program, GL_LINK_STATUS, &linked);
  if (linked == GL_TRUE) {
    const GLint projection = glGetUniformLocation(program, "targetProjection");
    if (projection >= 0) {
      GLint previous = 0;
      glGetIntegerv(GL_CURRENT_PROGRAM, &previous);
      glUseProgram(program);
      constexpr std::array<float, 9> identity{1, 0, 0, 0, 1, 0, 0, 0, 1};
      glUniformMatrix3fv(projection, 1, GL_FALSE, identity.data());
      glUseProgram(previous);
    }
    return program;
  }
  std::array<char, 2048> log{};
  glGetProgramInfoLog(program, static_cast<GLsizei>(log.size()), nullptr, log.data());
  glDeleteProgram(program);
  throw std::runtime_error(std::string("shader program link failed: ") + log.data());
}

constexpr std::uint32_t primitiveSurfaceTag = 0x40000000U;
constexpr std::uint32_t primitiveSurfaceIndexMask = 0x0000ffffU;
constexpr std::uint16_t primitiveSurfaceGenerationMask = 0x3fffU;

}  // namespace

Renderer::Renderer(int width, int height, ImageStore& images)
    : width_(width), height_(height), presentationWidth_(width),
      presentationHeight_(height), queueWidth_(width), queueHeight_(height),
      images_(images) {
  const char* diagnostics = std::getenv("PMJS_GRAPHICS_DIAGNOSTICS");
  diagnostics_ = diagnostics && std::string(diagnostics) == "1";
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
  createPixiPrograms(pixiFragmentPrecision_);
  generatedTextureProgram_ = linkProgram(vertexSource,
                                          generatedTextureFragmentSource);
  generatedTexturePremultipliedUniform_ = glGetUniformLocation(
    generatedTextureProgram_, "preservePremultiplied");
  presentationProgram_ = linkProgram(presentationVertexSource,
                                     presentationFragmentSource);
  presentationSceneUniform_ =
    glGetUniformLocation(presentationProgram_, "sceneImage");
  presentationOverlayUniform_ =
    glGetUniformLocation(presentationProgram_, "overlayImage");
  presentationVideoUniform_ =
    glGetUniformLocation(presentationProgram_, "videoImage");
  presentationUpperCanvasUniform_ =
    glGetUniformLocation(presentationProgram_, "upperCanvasImage");
  presentationColorMatrixUniform_ =
    glGetUniformLocation(presentationProgram_, "colorMatrix");
  presentationColorMatrixAlphaUniform_ =
    glGetUniformLocation(presentationProgram_, "colorMatrixAlpha");
  presentationToneEnabledUniform_ =
    glGetUniformLocation(presentationProgram_, "toneEnabled");
  presentationOpaqueBackgroundUniform_ =
    glGetUniformLocation(presentationProgram_, "opaqueBackground");
  presentationCanvasOpacityUniform_ =
    glGetUniformLocation(presentationProgram_, "canvasOpacity");
  presentationVideoOpacityUniform_ =
    glGetUniformLocation(presentationProgram_, "videoOpacity");
  presentationUpperCanvasOpacityUniform_ =
    glGetUniformLocation(presentationProgram_, "upperCanvasOpacity");
  presentationVideoPremultipliedUniform_ =
    glGetUniformLocation(presentationProgram_, "videoPremultiplied");
  presentationUpperCanvasPremultipliedUniform_ =
    glGetUniformLocation(presentationProgram_, "upperCanvasPremultiplied");
  spriteEffect_.program = linkProgram(vertexSource, spriteEffectFragmentSource);
  bitmapRegion_.program = linkProgram(bitmapRegionVertexSource().c_str(), bitmapRegionFragmentSource().c_str());
  for (auto* entry : {&spriteEffect_, &bitmapRegion_}) {
    auto& effect = *entry;
    effect.targetYDown = glGetUniformLocation(effect.program, "targetYDown");
    effect.vertices = glGetUniformLocation(effect.program, "spriteWorldVertices");
    effect.projection = glGetUniformLocation(effect.program, "spriteProjection");
    effect.packing = glGetUniformLocation(effect.program, "pixiSpritePacking");
    effect.premultiplied = glGetUniformLocation(effect.program, "texturePremultiplied");
    effect.frame = glGetUniformLocation(effect.program, "spriteFrame");
    effect.standalone = glGetUniformLocation(effect.program, "standaloneBitmapRegion");
    effect.tilingClamp = glGetUniformLocation(effect.program, "clampedTilingSampling");
    effect.nearest = glGetUniformLocation(effect.program, "nearestSampling");
    effect.textureSize =
      glGetUniformLocation(effect.program, "imageDimensions");
    effect.blur =
      glGetUniformLocation(effect.program, "blurRadius");
    effect.maskEnabled =
      glGetUniformLocation(effect.program, "maskEnabled");
    effect.maskImage =
      glGetUniformLocation(effect.program, "maskImage");
    effect.maskTransform =
      glGetUniformLocation(effect.program, "maskTransform");
    effect.maskTextureSize =
      glGetUniformLocation(effect.program, "maskTextureSize");
    effect.screenHeight =
      glGetUniformLocation(effect.program, "screenHeight");
    effect.colorEnabled =
      glGetUniformLocation(effect.program, "spriteColorEnabled");
    effect.colorTone =
      glGetUniformLocation(effect.program, "spriteColorTone");
    effect.blendColor =
      glGetUniformLocation(effect.program, "spriteBlendColor");
    effect.matrixEnabled =
      glGetUniformLocation(effect.program, "colorMatrixEnabled");
    effect.matrix =
      glGetUniformLocation(effect.program, "colorMatrix");
    effect.matrixAlpha =
      glGetUniformLocation(effect.program, "colorMatrixAlpha");
  }
  clearTriangleProgram_ = linkProgram(vertexSource, withTriangleClipCoverage(clearTriangleFragmentSource).c_str());
  clearTrianglePointsUniform_ = glGetUniformLocation(clearTriangleProgram_, "points");
  clearTriangleNormalsUniform_ = glGetUniformLocation(clearTriangleProgram_, "inward");
  clearTriangleRectangleUniform_ = glGetUniformLocation(clearTriangleProgram_, "clearRectangle");
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

  ensureTarget(sceneTarget_, width_, height_);
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  glEnable(GL_BLEND);
  glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
}

void Renderer::queryFilterProgramUniforms() {
  textureSizeUniform_ = glGetUniformLocation(program_, "imageDimensions");
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
}

Renderer::TileProgramUniforms Renderer::queryTileProgramUniforms(std::uint32_t program) {
  TileProgramUniforms uniforms;
  uniforms.targetYDown = glGetUniformLocation(program, "targetYDown");
  uniforms.world = glGetUniformLocation(program, "world");
  uniforms.screen = glGetUniformLocation(program, "screenSize");
  uniforms.animation = glGetUniformLocation(program, "animationOffset");
  uniforms.textureSize = glGetUniformLocation(program, "imageDimensions");
  uniforms.color = glGetUniformLocation(program, "color");
  uniforms.overlayColor = glGetUniformLocation(program, "meshPostTintOverlayColor");
  uniforms.trianglePaintEnabled = glGetUniformLocation(program, "trianglePaintEnabled");
  uniforms.trianglePaint = glGetUniformLocation(program, "trianglePaint");
  uniforms.triangleCoverageEnabled = glGetUniformLocation(program, "triangleCoverageEnabled");
  uniforms.triangleCoverage = glGetUniformLocation(program, "triangleCoverage");
  uniforms.mvBlendEnabled = glGetUniformLocation(program, "mvBlendEnabled");
  uniforms.mvBounds = glGetUniformLocation(program, "mvBounds");
  uniforms.nearestSampling = glGetUniformLocation(program, "nearestSampling");
  uniforms.mvPremultipliedInput = glGetUniformLocation(program, "mvPremultipliedInput");
  uniforms.texturePremultiplied = glGetUniformLocation(program, "texturePremultiplied");
  uniforms.maskEnabled = glGetUniformLocation(program, "maskEnabled");
  uniforms.maskImage = glGetUniformLocation(program, "maskImage");
  uniforms.maskTransform = glGetUniformLocation(program, "maskTransform");
  uniforms.maskFrame = glGetUniformLocation(program, "maskFrame");
  uniforms.maskTextureSize = glGetUniformLocation(program, "maskTextureSize");
  uniforms.maskScreenHeight = glGetUniformLocation(program, "screenHeight");
  return uniforms;
}

void Renderer::createPixiPrograms(const std::string& precision) {
  targetProjectionLocations_.clear();
  using namespace renderer_shaders;
  const auto linkPixiProgram = [&precision](const char* vertex, const char* fragment) {
    const auto source = pixiFragmentSourceWithPrecision(fragment, precision);
    return linkProgram(vertex, source.c_str());
  };
  GLuint filter = 0;
  GLuint simple = 0;
  GLuint tile = 0;
  GLuint meshOverlay = 0;
  GLuint canvasTriangleBitmap = 0;
  try {
    filter = linkPixiProgram(vertexSource, fragmentSource);
    simple = linkPixiProgram(vertexSource, simpleFragmentSource);
    tile = linkPixiProgram(tileVertexSource, tileFragmentSource);
    const auto overlaySource = meshPostTintOverlayFragmentSourceWithPrecision("mediump");
    meshOverlay = linkPixiProgram(tileVertexSource, overlaySource.c_str());
    const auto bitmapSource = meshPostTintOverlayFragmentSourceWithPrecision("mediump", true);
    canvasTriangleBitmap = linkPixiProgram(tileVertexSource, bitmapSource.c_str());
  } catch (...) {
    if (filter) glDeleteProgram(filter);
    if (simple) glDeleteProgram(simple);
    if (tile) glDeleteProgram(tile);
    if (meshOverlay) glDeleteProgram(meshOverlay);
    if (canvasTriangleBitmap) glDeleteProgram(canvasTriangleBitmap);
    throw;
  }
  if (program_) glDeleteProgram(program_);
  if (simpleProgram_) glDeleteProgram(simpleProgram_);
  if (tileProgram_) glDeleteProgram(tileProgram_);
  if (meshPostTintOverlayProgram_) glDeleteProgram(meshPostTintOverlayProgram_);
  if (canvasTriangleBitmapProgram_) glDeleteProgram(canvasTriangleBitmapProgram_);
  program_ = filter;
  simpleProgram_ = simple;
  filterTargetYDownUniform_ = glGetUniformLocation(program_, "targetYDown");
  filterImageYDownUniform_ = glGetUniformLocation(program_, "imageYDown");
  simpleTargetYDownUniform_ = glGetUniformLocation(simpleProgram_, "targetYDown");
  simpleSpriteVerticesUniform_ = glGetUniformLocation(simpleProgram_, "spriteWorldVertices");
  simpleSpriteProjectionUniform_ = glGetUniformLocation(simpleProgram_, "spriteProjection");
  simpleSpritePackingUniform_ = glGetUniformLocation(simpleProgram_, "pixiSpritePacking");
  simpleSpritePremultipliedUniform_ = glGetUniformLocation(simpleProgram_, "texturePremultiplied");
  simpleTilingClampUniform_ = glGetUniformLocation(simpleProgram_, "clampedTilingSampling");
  simpleTextureSizeUniform_ = glGetUniformLocation(simpleProgram_, "imageDimensions");
  tileProgram_ = tile;
  meshPostTintOverlayProgram_ = meshOverlay;
  canvasTriangleBitmapProgram_ = canvasTriangleBitmap;
  queryFilterProgramUniforms();
  tileUniforms_ = queryTileProgramUniforms(tileProgram_);
  meshPostTintOverlayUniforms_ = queryTileProgramUniforms(meshPostTintOverlayProgram_);
  canvasTriangleBitmapUniforms_ = queryTileProgramUniforms(canvasTriangleBitmapProgram_);
}

void Renderer::configurePixiFragmentPrecision(const std::string& precision) {
  if (precision != "highp" && precision != "mediump" && precision != "lowp") {
    throw std::invalid_argument("Pixi fragment precision requires highp, mediump, or lowp");
  }
  if (pixiPrecisionConfigured_) {
    if (precision != pixiFragmentPrecision_) {
      throw std::runtime_error("Pixi fragment precision is already configured");
    }
    return;
  }
  if (precision != pixiFragmentPrecision_) {
    createPixiPrograms(precision);
    pixiFragmentPrecision_ = precision;
  }
  pixiPrecisionConfigured_ = true;
}

const Renderer::FilterProgram& Renderer::filterProgram(std::uint32_t handle) const {
  if (handle == 0 || handle > filterPrograms_.size()) {
    throw std::invalid_argument("invalid filter program handle");
  }
  return filterPrograms_[handle - 1];
}

std::uint32_t Renderer::createFilterProgram(const std::string& fragmentSource, const std::string& vertexSource) {
  if (fragmentSource.empty() || fragmentSource.size() > 65536 ||
      fragmentSource.find('\0') != std::string::npos) {
    throw std::invalid_argument("invalid filter fragment source");
  }
  std::string source = fragmentSource;
  const auto first = source.find_first_not_of(" \t\r\n\f\v");
  if (first == std::string::npos || source.compare(first, 9, "precision") != 0) {
    // Implicit desktop-GL mediump arithmetic retains full float precision.
    // Use full precision here as well; explicit shader declarations stay intact.
    const auto precision = pixiFragmentPrecision_ == "mediump" ? "highp" : pixiFragmentPrecision_;
    source = "precision " + precision + " float;\n" + source;
  }
  source = "precision highp sampler2D;\n" + source;
  for (std::size_t index = 0; index < filterPrograms_.size(); ++index) {
    if (filterPrograms_[index].source == vertexSource + "\n" + source) return index + 1;
  }
  if (filterPrograms_.size() >= 128) {
    throw std::runtime_error("custom filter program budget exhausted");
  }
  constexpr const char* vertex = R"(
    attribute vec2 position;
    attribute vec2 uv;
    uniform bool pmjsTargetYDown;
    uniform vec2 pmjsScreenSize;
    uniform vec4 pmjsFilterFrame;
    uniform vec2 pmjsFilterTextureSize;
    varying vec2 vTextureCoord;
    void main() {
      gl_Position = vec4(position.x, pmjsTargetYDown ? -position.y : position.y, 0.0, 1.0);
      vec2 screen = vec2(uv.x, 1.0 - uv.y) * pmjsScreenSize;
      vTextureCoord = (screen - pmjsFilterFrame.xy) / pmjsFilterTextureSize;
    }
  )";
  if (vertexSource.size() > 65536 || vertexSource.find('\0') != std::string::npos)
    throw std::invalid_argument("invalid filter vertex source");
  const GLuint program = linkProgram(vertexSource.empty() ? vertex : vertexSource.c_str(), source.c_str());
  try {
    FilterProgram result{program, vertexSource + "\n" + source, !vertexSource.empty(), {}};
    GLint uniformCount = 0;
    GLint uniformNameSize = 0;
    glGetProgramiv(program, GL_ACTIVE_UNIFORMS, &uniformCount);
    glGetProgramiv(program, GL_ACTIVE_UNIFORM_MAX_LENGTH, &uniformNameSize);
    int total = 0;
    for (GLint index = 0; index < uniformCount; ++index) {
      std::vector<char> name(std::max(1, uniformNameSize));
      GLint count = 0;
      GLenum type = 0;
      GLsizei length = 0;
      glGetActiveUniform(program, index, name.size(), &length, &count, &type, name.data());
      const std::string key(name.data(), length);
      if (key == "pmjsScreenSize" || key == "pmjsFilterFrame" ||
          key == "pmjsFilterTextureSize" || key == "pmjsTargetYDown") continue;
      if (key == "projectionMatrix") {
        if (type != GL_FLOAT_MAT3 || count != 1) throw std::invalid_argument("filter projection must be mat3");
        continue;
      }
      if (key == "filterArea" || key == "filterClamp") {
        if (type != GL_FLOAT_VEC4 || count != 1) {
          throw std::invalid_argument("custom filter built-in must be vec4: " + key);
        }
        continue;
      }
      if (key == "uSampler") {
        if (type != GL_SAMPLER_2D || count != 1) {
          throw std::invalid_argument("custom filter uSampler must be sampler2D");
        }
        continue;
      }
      int components = 0;
      switch (type) {
        case GL_FLOAT: case GL_INT: case GL_BOOL: case GL_SAMPLER_2D: components = 1; break;
        case GL_FLOAT_VEC2: case GL_INT_VEC2: case GL_BOOL_VEC2: components = 2; break;
        case GL_FLOAT_VEC3: case GL_INT_VEC3: case GL_BOOL_VEC3: components = 3; break;
        case GL_FLOAT_VEC4: case GL_INT_VEC4: case GL_BOOL_VEC4: components = 4; break;
        case GL_FLOAT_MAT2: components = 4; break;
        case GL_FLOAT_MAT3: components = 9; break;
        case GL_FLOAT_MAT4: components = 16; break;
        default: throw std::invalid_argument("unsupported custom filter uniform: " + key);
      }
      if (count < 1 || count > (4096 - total) / components) {
        throw std::invalid_argument("custom filter uniform capacity exceeded");
      }
      total += components * count;
      result.uniforms.push_back({key, type, glGetUniformLocation(program, key.c_str()),
        components, count});
    }
    filterPrograms_.push_back(std::move(result));
    return filterPrograms_.size();
  } catch (...) {
    glDeleteProgram(program);
    throw;
  }
}

std::uint32_t Renderer::registerFilterPlan(const std::shared_ptr<CustomFilterPlan>& plan) {
  std::erase_if(filterPlans_, [](const auto& entry) { return entry.second.expired(); });
  if (filterPlans_.size() >= 4096 || nextFilterPlan_ == 0xffffffffU)
    throw std::runtime_error("custom filter plan budget exhausted");
  for (float resolution : plan->resolutions) {
    if (plan->frame[2] * resolution > maxTextureSize_ || plan->frame[3] * resolution > maxTextureSize_)
      throw std::invalid_argument("custom filter target exceeds texture size");
  }
  std::size_t retainedCount = 0;
  for (const auto& pass : plan->passes) for (const auto& sampler : pass.samplers)
    retainedCount += sampler.image != 0;
  plan->retainedImages.reserve(retainedCount);
  plan->images = &images_;
  plan->lifetime = filterPlanLifetime_;
  for (const auto& pass : plan->passes) for (const auto& sampler : pass.samplers) {
    if (!sampler.image) continue;
    if (!images_.beginUse(sampler.image)) throw std::invalid_argument("cannot retain filter sampler");
    plan->retainedImages.push_back(sampler.image);
  }
  const auto handle = nextFilterPlan_++;
  filterPlans_[handle] = plan;
  return handle;
}

Renderer::~Renderer() {
  discardCommandsFrom(0);
  filterPlanLifetime_.reset();
  glDeleteVertexArrays(1, &customFilterVertexArray_);
  glDeleteBuffers(1, &customFilterVertexBuffer_);
  for (auto& target : customPassTargets_) destroyTarget(target);
  for (const auto& filter : filterPrograms_) glDeleteProgram(filter.program);
  if (presentationVideo_) images_.release(presentationVideo_);
  if (presentationUpperCanvas_) images_.release(presentationUpperCanvas_);
  while (!tileLayers_.empty()) destroyTileLayer(tileLayers_.begin()->first);
  for (std::size_t index = 0; index < primitiveSurfaces_.size(); ++index) {
    auto& surface = primitiveSurfaces_[index];
    if (surface.live) releasePrimitiveSurface(
      makePrimitiveSurfaceHandle(index, surface.generation));
  }
  destroyTarget(sceneTarget_);
  destroyTarget(offscreenTarget_);
  destroyTarget(effectTarget_);
  destroyTarget(filterTarget_);
  destroyTarget(toneOverlayTarget_);
  destroyTarget(bloomTarget_);
  for (auto& target : groupTargets_) destroyTarget(target);
  for (auto& target : customFilterTargets_) destroyTarget(target);
  if (whiteTexture_) glDeleteTextures(1, &whiteTexture_);
  if (blackFramebuffer_) glDeleteFramebuffers(1, &blackFramebuffer_);
  if (blackTexture_) glDeleteTextures(1, &blackTexture_);
  if (vertexBuffer_) glDeleteBuffers(1, &vertexBuffer_);
  if (vertexArray_) glDeleteVertexArrays(1, &vertexArray_);
  if (program_) glDeleteProgram(program_);
  if (simpleProgram_) glDeleteProgram(simpleProgram_);
  if (generatedTextureProgram_) glDeleteProgram(generatedTextureProgram_);
  if (presentationProgram_) glDeleteProgram(presentationProgram_);
  if (spriteEffect_.program) glDeleteProgram(spriteEffect_.program);
  if (bitmapRegion_.program) glDeleteProgram(bitmapRegion_.program);
  if (tileProgram_) glDeleteProgram(tileProgram_);
  if (meshPostTintOverlayProgram_) glDeleteProgram(meshPostTintOverlayProgram_);
  if (canvasTriangleBitmapProgram_) glDeleteProgram(canvasTriangleBitmapProgram_);
  if (clearTriangleProgram_) glDeleteProgram(clearTriangleProgram_);
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
  if (diagnostics_) ++stats_.framebufferChecks;
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
    if (diagnostics_) ++stats_.bufferUploads;
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
    if (diagnostics_) ++stats_.drawCalls;
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

bool Renderer::clearImageTriangles(ImageHandle handle, const std::vector<float>& triangles,
    const std::vector<float>& rectangles, const std::vector<float>& suppliedNormals) {
  const auto image = images_.lookup(handle);
  if (!image || !images_.isRenderTarget(handle) || triangles.size() % 6 != 0 ||
      triangles.size() > 4096U * 6U) return false;
  for (const float value : triangles) if (!std::isfinite(value)) return false;
  if (!rectangles.empty() && rectangles.size() != triangles.size() / 6 * 4) return false;
  for (std::size_t index = 0; index < rectangles.size(); ++index) {
    if (!std::isfinite(rectangles[index]) || (index % 4 >= 2 && rectangles[index] < 0)) return false;
  }
  for (std::size_t index = 0; index < rectangles.size(); index += 4) {
    if (!std::isfinite(rectangles[index] + rectangles[index + 2]) ||
        !std::isfinite(rectangles[index + 1] + rectangles[index + 3])) return false;
  }
  if (!suppliedNormals.empty() && suppliedNormals.size() != triangles.size()) return false;
  for (float normal : suppliedNormals) if (!std::isfinite(normal)) return false;
  // Validate the whole batch before modifying any target pixels.
  for (std::size_t offset = 0; offset < triangles.size(); offset += 6) {
    const auto* p = triangles.data() + offset;
    const float area = (p[2] - p[0]) * (p[5] - p[1]) - (p[4] - p[0]) * (p[3] - p[1]);
    if (!std::isfinite(area)) return false;
    for (std::size_t edge = 0; edge < 3; ++edge) {
      const auto next = (edge + 1) % 3;
      const float dx = p[next * 2] - p[edge * 2];
      const float dy = p[next * 2 + 1] - p[edge * 2 + 1];
      if (!std::isfinite(dx * dx + dy * dy)) return false;
    }
  }
  if (triangles.empty()) return true;

  struct SavedState {
    GLint framebuffer, viewport[4], program, vao, buffer;
    GLint blendRgbSource, blendRgbDestination, blendAlphaSource, blendAlphaDestination;
    GLint equationRgb, equationAlpha;
    GLboolean blend, scissor, depth, stencil, cull, colorMask[4];
    GLuint target = 0;
    SavedState() {
      glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &framebuffer);
      glGetIntegerv(GL_VIEWPORT, viewport);
      glGetIntegerv(GL_CURRENT_PROGRAM, &program);
      glGetIntegerv(GL_VERTEX_ARRAY_BINDING, &vao);
      glGetIntegerv(GL_ARRAY_BUFFER_BINDING, &buffer);
      glGetIntegerv(GL_BLEND_SRC_RGB, &blendRgbSource);
      glGetIntegerv(GL_BLEND_DST_RGB, &blendRgbDestination);
      glGetIntegerv(GL_BLEND_SRC_ALPHA, &blendAlphaSource);
      glGetIntegerv(GL_BLEND_DST_ALPHA, &blendAlphaDestination);
      glGetIntegerv(GL_BLEND_EQUATION_RGB, &equationRgb);
      glGetIntegerv(GL_BLEND_EQUATION_ALPHA, &equationAlpha);
      glGetBooleanv(GL_COLOR_WRITEMASK, colorMask);
      blend = glIsEnabled(GL_BLEND); scissor = glIsEnabled(GL_SCISSOR_TEST);
      depth = glIsEnabled(GL_DEPTH_TEST); stencil = glIsEnabled(GL_STENCIL_TEST);
      cull = glIsEnabled(GL_CULL_FACE);
    }
    ~SavedState() {
      glBindFramebuffer(GL_DRAW_FRAMEBUFFER, framebuffer);
      if (target) glDeleteFramebuffers(1, &target);
      glViewport(viewport[0], viewport[1], viewport[2], viewport[3]);
      glUseProgram(program); glBindVertexArray(vao); glBindBuffer(GL_ARRAY_BUFFER, buffer);
      glBlendFuncSeparate(blendRgbSource, blendRgbDestination, blendAlphaSource, blendAlphaDestination);
      glBlendEquationSeparate(equationRgb, equationAlpha);
      glColorMask(colorMask[0], colorMask[1], colorMask[2], colorMask[3]);
      for (const auto& [capability, enabled] : std::array<std::pair<GLenum, GLboolean>, 5>{{
          {GL_BLEND, blend}, {GL_SCISSOR_TEST, scissor}, {GL_DEPTH_TEST, depth},
          {GL_STENCIL_TEST, stencil}, {GL_CULL_FACE, cull}}}) {
        if (enabled) glEnable(capability); else glDisable(capability);
      }
    }
  } saved;
  glGenFramebuffers(1, &saved.target);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, saved.target);
  glFramebufferTexture2D(GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, image->texture, 0);
  if (diagnostics_) ++stats_.framebufferChecks;
  if (!saved.target || glCheckFramebufferStatus(GL_DRAW_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) return false;
  glViewport(0, 0, image->width, image->height);
  glDisable(GL_SCISSOR_TEST); glDisable(GL_DEPTH_TEST); glDisable(GL_STENCIL_TEST); glDisable(GL_CULL_FACE);
  glEnable(GL_BLEND); glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
  glBlendEquationSeparate(GL_FUNC_ADD, GL_FUNC_ADD);
  glBlendFuncSeparate(GL_ZERO, GL_ONE_MINUS_SRC_ALPHA, GL_ZERO, GL_ONE_MINUS_SRC_ALPHA);
  glUseProgram(clearTriangleProgram_); glBindVertexArray(vertexArray_);
  glBindBuffer(GL_ARRAY_BUFFER, vertexBuffer_);
  for (std::size_t offset = 0; offset < triangles.size(); offset += 6) {
    const auto* points = triangles.data() + offset;
    const float area = (points[2] - points[0]) * (points[5] - points[1]) -
        (points[4] - points[0]) * (points[3] - points[1]);
    if (area == 0) continue;
    const float x0 = std::max(0.0F, std::floor(std::min({points[0], points[2], points[4]})));
    const float y0 = std::max(0.0F, std::floor(std::min({points[1], points[3], points[5]})));
    const float x1 = std::min(static_cast<float>(image->width), std::ceil(std::max({points[0], points[2], points[4]})));
    const float y1 = std::min(static_cast<float>(image->height), std::ceil(std::max({points[1], points[3], points[5]})));
    if (x1 <= x0 || y1 <= y0) continue;
    const float left = x0 / image->width * 2 - 1, right = x1 / image->width * 2 - 1;
    // Generated images store logical top-left row zero at texture row zero.
    const float top = y0 / image->height * 2 - 1, bottom = y1 / image->height * 2 - 1;
    const std::array<float, 72> vertices = {
      left, top, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1,
      right, top, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1,
      right, bottom, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1,
      left, top, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1,
      right, bottom, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1,
      left, bottom, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1};
    glBufferData(GL_ARRAY_BUFFER, sizeof(vertices), vertices.data(), GL_STREAM_DRAW);
    std::array<float, 6> normals;
    for (std::size_t edge = 0; suppliedNormals.empty() && edge < 3; ++edge) {
      const auto next = (edge + 1) % 3;
      const double dx = double(points[next * 2]) - points[edge * 2];
      const double dy = double(points[next * 2 + 1]) - points[edge * 2 + 1];
      const double length = std::hypot(dx, dy);
      const double winding = area >= 0 ? 1 : -1;
      normals[edge * 2] = static_cast<float>(-dy * winding / length);
      normals[edge * 2 + 1] = static_cast<float>(dx * winding / length);
    }
    glUniform2fv(clearTrianglePointsUniform_, 3, points);
    glUniform2fv(clearTriangleNormalsUniform_, 3, suppliedNormals.empty() ? normals.data() : suppliedNormals.data() + offset);
    if (rectangles.empty()) glUniform4f(clearTriangleRectangleUniform_, 0, 0, image->width, image->height);
    else {
      const auto* rect = rectangles.data() + offset / 6 * 4;
      glUniform4f(clearTriangleRectangleUniform_, rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3]);
    }
    glDrawArrays(GL_TRIANGLES, 0, 6);
    if (diagnostics_) {
      ++stats_.bufferUploads;
      ++stats_.drawCalls;
    }
  }
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
