#pragma once

#include "resources.hpp"
#include "scene_packet.hpp"
#include "effects.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <memory>
#include <unordered_map>
#include <vector>
#include <variant>
#include <ctime>

namespace pmjs {

enum class BlendMode : std::uint8_t {
  normal = 0,
  additive = 1,
  multiply = 2,
  screen = 3,
};

constexpr bool isValidBlendMode(std::uint8_t value) {
  return value <= static_cast<std::uint8_t>(BlendMode::screen);
}

enum class AlphaMode { straight, premultiplied };
struct TexturedMeshMaterial {};
struct TriangleBitmapMaterial {
  enum class RasterRule { area, canvasFourSample };
  std::array<float, 30> coefficients{};
  RasterRule rasterRule = RasterRule::area;
};
struct MvBitmapMaterial {
  std::array<float, 4> texelBounds{};
  AlphaMode alphaMode = AlphaMode::straight;
};
using MeshMaterial = std::variant<TexturedMeshMaterial, TriangleBitmapMaterial, MvBitmapMaterial>;

struct CustomFilterPass {
  struct Sampler { ImageHandle image = 0; std::uint32_t target = 0; bool nearest = false; bool mipmap = false; std::uint32_t wrap = 33071; };
  std::uint32_t program = 0, input = 0, output = 1;
  bool clear = false;
  BlendMode blend = BlendMode::normal;
  std::vector<double> uniforms;
  std::array<float, 6> transform{1, 0, 0, 1, 0, 0};
  std::vector<Sampler> samplers;
};
struct CustomFilterPlan {
  std::array<float, 4> frame{};
  std::vector<float> resolutions;
  std::vector<CustomFilterPass> passes;
  ImageStore* images = nullptr;
  std::weak_ptr<int> lifetime;
  std::vector<ImageHandle> retainedImages;
  ~CustomFilterPlan() { if (!lifetime.expired()) for (auto image : retainedImages) images->endUse(image); }
};

struct RenderCommand {
  enum class Action : std::uint8_t { draw, filterBegin, filterEnd };
  enum class Primitive : std::uint8_t {
    sprite, tilingSprite, screenFill, tileLayer, mesh, effect
  };

  ImageHandle image = 0;
  std::array<float, 6> transform;
  std::array<float, 4> source;
  std::array<float, 2> destination;
  std::array<float, 4> color;
  BlendMode blendMode = BlendMode::normal;
  bool repeat = false;
  std::uint32_t tileLayer = 0;
  std::array<float, 2> tileAnimation{};
  std::array<int, 4> clip{};
  bool clipped = false;
  float blur = 0;
  ImageHandle maskImage = 0;
  std::array<float, 6> maskTransform{};
  std::array<float, 20> colorMatrix{};
  bool appliesColorMatrix = false;
  std::array<float, 4> colorTone{};
  std::array<float, 4> blendColor{};
  bool appliesSpriteColor = false;
  bool pixiSpritePacking = false;
  bool premultipliedSpriteTexture = false;
  bool packedSpriteColor = false;
  bool floatSpriteUv = false;
  bool spriteWorldVertices = false;
  bool standaloneBitmapRegion = false;
  std::array<std::array<float, 2>, 4> spriteVertices{};
  bool appliesMeshPostTintOverlay = false;
  std::uint8_t textureRotation = 0;
  bool nearest = false;
  bool mipmap = false;
  bool roundPixels = false;
  Action action = Action::draw;
  scene_packet::FilterKind filterKind = scene_packet::FilterKind::blur;
  std::uint32_t filterProgram = 0;
  std::shared_ptr<const CustomFilterPlan> customFilterPlan{};
  std::array<float, 21> filterParameters{};
  float filterResolution = 1.0F;
  Primitive primitive = Primitive::sprite;
  EffectDraw effect{};
  bool clampedTilingSampling = false;
};

struct FramePacket {
  std::vector<RenderCommand> commands;

  void clear() { commands.clear(); }
};

// `integer` falls back to `fit` when shrinking (floor of sub-1 is zero).
enum class PresentScaleMode : std::uint8_t { fit, integer };

enum class PresentFilter : std::uint8_t { nearest, linear };

struct PresentationGeometry {
  int sourceWidth = 0;
  int sourceHeight = 0;
  int drawableWidth = 0;
  int drawableHeight = 0;
  int viewportX = 0;
  int viewportY = 0;
  int viewportWidth = 0;
  int viewportHeight = 0;
  PresentScaleMode scaleMode = PresentScaleMode::fit;
  PresentFilter filter = PresentFilter::nearest;
};

// Wall and calling-thread CPU envelopes, not GPU execution timestamps.
struct PresentationPhaseTiming {
  std::uint64_t calls = 0;
  double wallMs = 0, cpuMs = 0;
};
struct PresentationTimings {
  bool enabled = false, finishBeforeSwap = false;
  std::array<PresentationPhaseTiming, 6> phases{};
};
class PresentationPhaseTimer {
 public:
  PresentationPhaseTimer(bool enabled, PresentationPhaseTiming& phase)
      : phase_(enabled ? &phase : nullptr) {
    if (phase_) { wall_ = milliseconds(CLOCK_MONOTONIC); cpu_ = milliseconds(CLOCK_THREAD_CPUTIME_ID); }
  }
  ~PresentationPhaseTimer() {
    if (!phase_) return;
    phase_->cpuMs += milliseconds(CLOCK_THREAD_CPUTIME_ID) - cpu_;
    phase_->wallMs += milliseconds(CLOCK_MONOTONIC) - wall_;
    ++phase_->calls;
  }
 private:
  static double milliseconds(clockid_t clock) {
    timespec value{};
    clock_gettime(clock, &value);
    return value.tv_sec * 1000.0 + value.tv_nsec / 1000000.0;
  }
  PresentationPhaseTiming* phase_;
  double wall_ = 0, cpu_ = 0;
};

struct RendererStats {
  static constexpr std::size_t filterKindCount =
    static_cast<std::size_t>(scene_packet::FilterKind::custom) + 1;
  std::uint64_t frames = 0;
  std::uint64_t retainedFrames = 0;
  std::uint64_t commands = 0;
  std::uint64_t drawCalls = 0;
  std::uint64_t bufferUploads = 0;
  std::uint64_t baseSpriteDrawCalls = 0;
  std::uint64_t effectSpriteDrawCalls = 0;
  std::uint64_t tileDrawCalls = 0;
  std::uint64_t filterDrawCalls = 0;
  std::array<std::uint64_t, filterKindCount> filterApplications{};
  std::uint64_t filterTargetAcquires = 0;
  std::uint64_t filterTargetReuses = 0;
  std::uint64_t rendererTargetCreates = 0;
  std::uint64_t rendererTargetDestroys = 0;
  std::uint64_t rendererTargetBytes = 0;
  std::uint64_t rendererTargetPeakBytes = 0;
  std::uint64_t rendererTargetCacheBytes = 0;
  std::uint64_t rendererTargetCacheHits = 0;
  std::uint64_t rendererTargetCacheEvictions = 0;
  std::uint64_t filterTargetClears = 0;

  std::uint64_t filterBoundedApplications = 0;
  std::uint64_t framebufferChecks = 0;
  std::uint64_t framebufferCopies = 0;
  std::uint64_t toneAdjustDrawCalls = 0;
  std::uint64_t toneComposedPresentationFrames = 0;
  std::uint64_t scaledPresentationFrames = 0;
  std::uint64_t presentationLetterboxedFrames = 0;
  std::uint64_t spriteDrawCalls = 0;
  std::uint64_t tilingSpriteDrawCalls = 0;
  std::uint64_t screenFillDrawCalls = 0;
  std::uint64_t meshDrawCalls = 0;
};

struct TileLayerTile {
  ImageHandle image = 0;
  std::array<float, 4> source{};
  std::array<float, 2> position{};
  std::array<float, 2> animation{};
};

using PrimitiveSurfaceHandle = std::uint32_t;

enum class PrimitiveComposition : std::uint8_t {
  sourceOver = 0,
  additive = 1,
};

struct PrimitiveSurfacePrimitive {
  enum class Kind : std::uint8_t {
    solidRect = 0,
    concentricRadialGradient = 1,
  };
  Kind kind = Kind::solidRect;
  std::array<float, 4> bounds{};
  std::array<float, 2> center{};
  std::array<float, 2> radii{};
  std::array<float, 3> offsets{};
  std::array<std::array<float, 4>, 3> colors{};
  std::uint8_t stopCount = 0;
  PrimitiveComposition composition = PrimitiveComposition::sourceOver;
};

class Renderer {
 public:
  Renderer(int width, int height, ImageStore& images);
  ~Renderer();
  void setEffects(Effects* effects) { effects_ = effects; }

  Renderer(const Renderer&) = delete;
  Renderer& operator=(const Renderer&) = delete;

  void setClearColor(float red, float green, float blue, float alpha);
  void clearScene(float red, float green, float blue, float alpha,
                  const std::optional<std::array<int, 4>>& clip = std::nullopt);
  void setClearBeforeRender(bool clear) { clearBeforeRender_ = clear; }
  void setSceneProjection(const std::array<float, 6>& transform);
  void setPresentationViewport(int width, int height, int filter);
  void configurePixiFragmentPrecision(const std::string& precision);
  struct FilterUniform {
    std::string name;
    std::uint32_t type;
    int location;
    int components;
    int count;
  };
  struct FilterProgram {
    std::uint32_t program;
    std::string source;
    bool pixiVertex = false;
    std::vector<FilterUniform> uniforms;
  };
  std::uint32_t createFilterProgram(const std::string& fragmentSource,
                                    const std::string& vertexSource = "");
  std::uint32_t registerFilterPlan(const std::shared_ptr<CustomFilterPlan>& plan);
  const FilterProgram& filterProgram(std::uint32_t handle) const;
  const std::string& pixiFragmentPrecision() const {
    return pixiFragmentPrecision_;
  }
  bool setPresentationLayers(float canvasOpacity, ImageHandle video,
                             float videoOpacity, ImageHandle upperCanvas,
                             float upperCanvasOpacity);
  bool setRenderTargetSize(int width, int height);
  bool setScreenRenderSize(int width, int height);
  void setDrawableSize(int width, int height);
  PresentationGeometry presentationGeometry() const { return presentation_; }
  void beginFrame();
  void queueQuad(float x, float y, float width, float height,
                 const std::array<float, 4>& color);
  bool queueImage(ImageHandle image, const std::array<float, 6>& transform,
                  const std::array<float, 4>& source, float alpha,
                  std::uint32_t tint, BlendMode blendMode);
  bool queueTiled(ImageHandle image, const std::array<float, 6>& transform,
                  const std::array<float, 4>& source,
                  const std::array<float, 2>& destination, float alpha,
                  std::uint32_t tint, BlendMode blendMode);
  std::uint32_t createTileLayer(std::vector<TileLayerTile> tiles);
  std::uint32_t createMesh(ImageHandle image,
                           const std::vector<float>& positions,
                           const std::vector<double>& uvs,
                           const std::vector<std::uint32_t>& indices,
                           bool triangleStrip,
                           const MeshMaterial& material = TexturedMeshMaterial{});
  bool queueTileLayer(std::uint32_t layer,
                      const std::array<float, 6>& transform,
                      const std::array<float, 2>& animation, float alpha,
                      std::uint32_t tint, BlendMode blendMode);
  bool releaseTileLayer(std::uint32_t layer);
  bool clearImageTriangles(ImageHandle image, const std::vector<float>& triangles,
    const std::vector<float>& rectangles = {}, const std::vector<float>& normals = {});
  struct PrimitiveSurfaceInfo {
    PrimitiveSurfaceHandle handle = 0;
    ImageInfo image;
  };
  std::optional<PrimitiveSurfaceInfo> createPrimitiveSurface(int width, int height);
  bool renderPrimitiveSurface(
      PrimitiveSurfaceHandle handle, const std::array<float, 4>& clearColor,
      const std::vector<PrimitiveSurfacePrimitive>& primitives);
  bool releasePrimitiveSurface(PrimitiveSurfaceHandle handle);
  bool queueScene(std::uint32_t version, const std::uint32_t* metadata,
                  std::size_t metadataCount,
                  const float* values, std::size_t valueCount,
                  std::size_t nodeCount);
  void render();
  void renderScene();
  void presentToDrawable();
  void finish();
  std::vector<std::uint8_t> captureSceneRgba(AlphaMode alphaMode = AlphaMode::straight);
  std::vector<std::uint8_t> captureSceneRawPremultiplied();
  // Window backbuffer readback, valid only before swap.
  std::vector<std::uint8_t> captureDrawableRgba(AlphaMode alphaMode = AlphaMode::straight);
  std::vector<std::uint8_t> renderToRgba(AlphaMode alphaMode = AlphaMode::straight);
  std::vector<std::uint8_t> renderToRgba(int width, int height, ImageHandle initialImage = 0, AlphaMode alphaMode = AlphaMode::straight);
  std::optional<ImageInfo> captureOffscreenImage();
  std::optional<ImageInfo> renderToImage(int width, int height, AlphaMode alphaMode = AlphaMode::straight);
  const RendererStats& stats() const { return stats_; }
  bool diagnosticsEnabled() const { return diagnostics_; }
  PresentationTimings& presentationTimings() { return presentationTimings_; }
  std::size_t renderTargetBytes() const;
  std::size_t tileGeometryGpuBytes() const;
  std::size_t tileGeometryCpuBytes() const;
  // Public for the modal overlay: snapshot, draw, discard back.
  std::size_t commandCount() const;
  void discardCommandsFrom(std::size_t first);

 private:
  Effects* effects_ = nullptr;
  struct TileProgramUniforms {
    int tileFrameEnabled = -1;
    int targetYDown = -1;
    int world = -1;
    int screen = -1;
    int animation = -1;
    int textureSize = -1;
    int color = -1;
    int overlayColor = -1;
    int trianglePaintEnabled = -1;
    int trianglePaint = -1;
    int triangleCoverageEnabled = -1;
    int triangleCoverage = -1;
    int triangleSourceMappingEnabled = -1;
    int triangleSourceMapping = -1;
    int mvBlendEnabled = -1;
    int mvBounds = -1;
    int nearestSampling = -1;
    int mvPremultipliedInput = -1;
    int texturePremultiplied = -1;
    int maskEnabled = -1;
    int maskImage = -1;
    int maskTransform = -1;
    int maskFrame = -1;
    int maskTextureSize = -1;
    int maskScreenHeight = -1;
  };
  struct TileBatch {
    std::uint32_t texture = 0;
    int textureWidth = 0;
    int textureHeight = 0;
    std::int32_t first = 0;
    std::int32_t count = 0;
    bool premultiplied = false;
    ImageHandle image = 0;
  };

  struct FourTileBatch {
    std::array<TileBatch, 4> textures{};
    int textureCount = 0;
    std::int32_t first = 0, count = 0;
  };

  struct TileLayerResource {
    std::uint32_t batchBuffer = 0;
    std::size_t batchBytes = 0;
    bool batchReady = false;
    std::vector<FourTileBatch> fourBatches;
    std::uint32_t vertexArray = 0;
    std::uint32_t vertexBuffer = 0;
    std::size_t vertexBytes = 0;
    std::vector<ImageHandle> images;
    ImageHandle triangleCoverage = 0;
    bool triangleSourceMappingEnabled = false;
    std::array<float, 4> triangleSourceMapping{};
    std::vector<TileBatch> batches;
    std::uint32_t owners = 1;
    std::uint32_t queuedReferences = 0;
    std::vector<TileLayerTile> tiles;
    std::vector<float> tileVertices;
    std::array<float, 2> mappedAnimation{};
    bool mappedNearest = true, mappedReady = false;
    std::uint64_t mappedEpoch = 0;
    // Typed material state is retained with the mesh; the scene packet carries dynamic color.
    MeshMaterial material;
  };

  bool prepareFourTileBatches(TileLayerResource& layer);
  bool fourTileTextures_ = false;
  bool softwareSceneDepth_ = false;
  std::uint32_t fourTileProgram_ = 0;
  TileProgramUniforms fourTileUniforms_;

  std::uint32_t createOrdinaryTileLayer(std::vector<TileLayerTile> tiles);
  bool prepareTileLayer(TileLayerResource& layer, const std::array<float, 2>& animation, bool nearest);

  struct PrimitiveSurfaceResource {
    std::uint16_t generation = 1;
    ImageHandle image = 0;
    std::uint32_t framebuffer = 0;
    int width = 0;
    int height = 0;
    bool live = false;
  };

  struct RenderTarget {
    std::uint32_t texture = 0;
    std::uint32_t framebuffer = 0;
    std::uint32_t depth = 0;
    int width = 0;
    int height = 0;
  };

  static constexpr std::size_t customFilterTargetCapacity = 64;
  static constexpr std::size_t filterTargetCacheBudget = 32U * 1024U * 1024U;
  struct CachedFilterTarget {
    RenderTarget target;
    std::uint64_t lastUse = 0;
  };

  struct FilterContentBounds {
    bool bounded = false;
    bool regionsValid = false;
    std::array<int, 4> rect{};
    std::vector<std::array<int, 4>> regions;
  };

  static int filterBoundsPadding(scene_packet::FilterKind kind,
                                 const std::array<float, 21>& parameters);
  void computeFilterContentBounds();
  bool filterBoundsRect(const RenderCommand* filterBegin,
                        std::array<int, 4>* rect) const;
  bool filterBoundsRegions(
      const RenderCommand* filterBegin,
      std::vector<std::array<int, 4>>* regions) const;
  void destroyTileLayer(std::uint32_t handle);
  void queryFilterProgramUniforms();
  TileProgramUniforms queryTileProgramUniforms(std::uint32_t program);
  void createPixiPrograms(const std::string& precision);
  static PrimitiveSurfaceHandle makePrimitiveSurfaceHandle(
      std::size_t index, std::uint16_t generation);
  PrimitiveSurfaceResource* lookupPrimitiveSurface(PrimitiveSurfaceHandle handle);
  void resizeTargets(int width, int height);
  void ensureTarget(RenderTarget& target, int width, int height);
  bool ensureFilterTarget(RenderTarget& target, int width, int height, std::size_t slot);
  static std::size_t targetStorageBytes(const RenderTarget& target);
  void ensureDepthBuffer(RenderTarget& target);
  void destroyTarget(RenderTarget& target);
  void swapTargetColors(RenderTarget& left, RenderTarget& right);
  void drawToneComposition(std::uint32_t framebuffer, int viewportX,
                           int viewportY, int viewportWidth,
                           int viewportHeight, bool screenPresentation = false);
  void materializeToneComposition();
  void recomputePresentation();
  static PresentScaleMode presentScaleModeFromEnvironment();
  static bool presentFilterOverrideFromEnvironment(PresentFilter* filter);

  int width_;
  int height_;
  int presentationWidth_;
  int presentationHeight_;
  PresentationGeometry presentation_;
  std::array<int, 2> authoredPresentationSize_{0, 0};
  int authoredPresentationFilter_ = 0;
  bool hasFilterOverride_ = false;
  PresentFilter filterOverride_ = PresentFilter::nearest;
  int queueWidth_;
  int queueHeight_;
  int maxTextureSize_ = 0;
  std::string pixiFragmentPrecision_ = "mediump";
  std::vector<FilterProgram> filterPrograms_;
  std::unordered_map<std::uint32_t, std::weak_ptr<const CustomFilterPlan>> filterPlans_;
  std::unordered_map<std::uint32_t, int> targetProjectionLocations_;
  std::shared_ptr<int> filterPlanLifetime_ = std::make_shared<int>(0);
  std::uint32_t nextFilterPlan_ = 0x80000000U;
  static void applyBlendMode(BlendMode mode);
  void drawCustomFilterPlan(const CustomFilterPlan& plan, const RenderTarget& source,
                            const RenderTarget& output, const RenderCommand& command,
                            float sourceResolution, float outputResolution, bool outputYDown,
                            const std::array<float, 4>& outputFrame, bool sourcePaddingKnownZero);
  std::uint32_t customFilterVertexArray_ = 0, customFilterVertexBuffer_ = 0;
  std::vector<RenderTarget> customPassTargets_;
  std::array<CachedFilterTarget, customFilterTargetCapacity + scene_packet::maxFilterDepth> filterTargetCache_{};
  std::uint64_t filterTargetCacheClock_ = 0;
  // Native rendering is shared across facades; the first Pixi renderer fixes precision.
  bool pixiPrecisionConfigured_ = false;
  ImageStore& images_;
  std::array<float, 4> clearColor_{0.0F, 0.0F, 0.0F, 1.0F};
  bool clearBeforeRender_ = true;
  std::array<float, 6> sceneProjection_{1, 0, 0, 1, 0, 0};
  bool sceneSubmittedThisFrame_ = false;
  bool hasValidSceneFrame_ = false;
  FramePacket frame_;
  std::vector<float> vertices_;
  RendererStats stats_;
  PresentationTimings presentationTimings_;
  bool diagnostics_ = false;
  std::vector<FilterContentBounds> filterBounds_;
  bool filterBoundsEnabled_ = true;
  std::uint32_t program_ = 0;
  std::uint32_t simpleProgram_ = 0;
  int simpleDerivedImageUniform_ = -1;
  int simpleDerivedNearestUniform_ = -1;
  int simpleDerivedAtlasOffsetUniform_ = -1;
  int simpleDerivedUvTransformUniform_ = -1;
  int simpleDerivedSampleBoundsUniform_ = -1;
  struct SpriteEffectProgram {
    std::uint32_t program = 0;
    int targetYDown = -1;
    int vertices = -1;
    int projection = -1;
    int packing = -1;
    int premultiplied = -1;
    int frame = -1;
    int standalone = -1;
    int tilingClamp = -1;
    int nearest = -1;
    int textureSize = -1;
    int blur = -1;
    int maskEnabled = -1;
    int maskImage = -1;
    int maskTransform = -1;
    int maskTextureSize = -1;
    int screenHeight = -1;
    int colorEnabled = -1;
    int colorTone = -1;
    int blendColor = -1;
    int matrixEnabled = -1;
    int matrix = -1;
    int matrixAlpha = -1;
  };
  SpriteEffectProgram spriteEffect_, bitmapRegion_;
  std::uint32_t clearTriangleProgram_ = 0;
  int clearTrianglePointsUniform_ = -1;
  int clearTriangleNormalsUniform_ = -1;
  int clearTriangleRectangleUniform_ = -1;
  std::uint32_t generatedTextureProgram_ = 0;
  int generatedTexturePremultipliedUniform_ = -1;
  std::uint32_t presentationProgram_ = 0;
  int presentationSceneUniform_ = -1;
  int presentationLayerUniform_ = -1;
  int presentationOverlayUniform_ = -1;
  int presentationVideoUniform_ = -1;
  int presentationUpperCanvasUniform_ = -1;
  int presentationColorMatrixUniform_ = -1;
  int presentationColorMatrixAlphaUniform_ = -1;
  int presentationToneEnabledUniform_ = -1;
  int presentationOpaqueBackgroundUniform_ = -1;
  int presentationCanvasOpacityUniform_ = -1;
  int presentationVideoOpacityUniform_ = -1;
  int presentationUpperCanvasOpacityUniform_ = -1;
  int presentationVideoPremultipliedUniform_ = -1;
  int presentationUpperCanvasPremultipliedUniform_ = -1;
  int filterTargetYDownUniform_ = -1;
  int filterImageYDownUniform_ = -1;
  int simpleTargetYDownUniform_ = -1;
  int simpleSpriteVerticesUniform_ = -1;
  int simpleSpriteProjectionUniform_ = -1;
  int simpleSpritePackingUniform_ = -1;
  int simpleSpritePremultipliedUniform_ = -1;
  int simpleTilingClampUniform_ = -1;
  int simpleTextureSizeUniform_ = -1;
  int textureSizeUniform_ = -1;
  int blurUniform_ = -1;
  int blurDirectionUniform_ = -1;
  int displacementEnabledUniform_ = -1;
  int displacementImageUniform_ = -1;
  int displacementBoundsUniform_ = -1;
  int displacementScaleUniform_ = -1;
  int noiseGlitchEnabledUniform_ = -1;
  int noiseGlitchParametersUniform_ = -1;
  int pixiFilterKindUniform_ = -1;
  int pixiFilterParametersUniform_ = -1;
  int bloomImageUniform_ = -1;
  int premultipliedInputUniform_ = -1;
  int maskEnabledUniform_ = -1;
  int maskImageUniform_ = -1;
  int maskTransformUniform_ = -1;
  int maskFrameUniform_ = -1;
  int maskTextureSizeUniform_ = -1;
  int maskScreenHeightUniform_ = -1;
  int maskAlphaUniform_ = -1;
  int maskUsesRedUniform_ = -1;
  int maskRotationUniform_ = -1;
  int maskLocalSizeUniform_ = -1;
  int colorMatrixEnabledUniform_ = -1;
  int colorMatrixUniform_ = -1;
  int colorMatrixAlphaUniform_ = -1;
  int spriteColorEnabledUniform_ = -1;
  int spriteColorToneUniform_ = -1;
  int spriteBlendColorUniform_ = -1;
  std::uint32_t tileProgram_ = 0;
  std::uint32_t meshPostTintOverlayProgram_ = 0;
  std::uint32_t canvasTriangleBitmapProgram_ = 0;
  TileProgramUniforms tileUniforms_;
  TileProgramUniforms meshPostTintOverlayUniforms_;
  TileProgramUniforms canvasTriangleBitmapUniforms_;
  std::uint32_t primitiveSurfaceProgram_ = 0;
  int primitiveSurfaceSizeUniform_ = -1;
  int primitiveSurfaceKindUniform_ = -1;
  int primitiveSurfaceCenterUniform_ = -1;
  int primitiveSurfaceRadiiUniform_ = -1;
  int primitiveSurfaceStopCountUniform_ = -1;
  int primitiveSurfaceOffsetsUniform_ = -1;
  int primitiveSurfaceColorsUniform_ = -1;
  std::uint32_t vertexArray_ = 0;
  std::uint32_t vertexBuffer_ = 0;
  std::uint32_t whiteTexture_ = 0;
  std::uint32_t blackTexture_ = 0;
  std::uint32_t blackFramebuffer_ = 0;
  RenderTarget sceneTarget_;
  RenderTarget offscreenTarget_;
  RenderTarget effectTarget_;
  RenderTarget filterTarget_;
  RenderTarget toneOverlayTarget_;
  RenderTarget bloomTarget_;
  std::array<RenderTarget, scene_packet::maxFilterDepth> groupTargets_{};
  std::array<RenderTarget, scene_packet::maxFilterDepth> customFilterTargets_{};
  bool offscreenRender_ = false;
  bool toneCompositionActive_ = false;
  ImageHandle presentationVideo_ = 0;
  ImageHandle presentationUpperCanvas_ = 0;
  float presentationCanvasOpacity_ = 1.0F;
  float presentationVideoOpacity_ = 0.0F;
  float presentationUpperCanvasOpacity_ = 0.0F;
  std::array<float, 20> presentationColorMatrix_{};
  float presentationColorMatrixAlpha_ = 1.0F;
  std::uint32_t nextTileLayer_ = 1;
  std::unordered_map<std::uint32_t, TileLayerResource> tileLayers_;
  std::vector<PrimitiveSurfaceResource> primitiveSurfaces_;
  std::unordered_map<std::uint32_t, bool> textureRepeatState_;
  std::unordered_map<std::uint32_t, bool> textureNearestState_;
  std::uint64_t imageTextureEpoch_ = 0;
};

}  // namespace pmjs
