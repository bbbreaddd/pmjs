#pragma once

#include "resources.hpp"
#include "scene_packet.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>
#include <variant>

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

struct RenderCommand {
  enum class Action : std::uint8_t { draw, filterBegin, filterEnd };
  enum class Primitive : std::uint8_t {
    sprite, tilingSprite, screenFill, tileLayer, mesh
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
  bool spriteWorldVertices = false;
  bool standaloneBitmapRegion = false;
  std::array<std::array<float, 2>, 4> spriteVertices{};
  bool appliesMeshPostTintOverlay = false;
  std::uint8_t textureRotation = 0;
  bool nearest = false;
  bool roundPixels = false;
  Action action = Action::draw;
  scene_packet::FilterKind filterKind = scene_packet::FilterKind::blur;
  std::array<float, 21> filterParameters{};
  float filterResolution = 1.0F;
  Primitive primitive = Primitive::sprite;
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

struct RendererStats {
  static constexpr std::size_t filterKindCount =
    static_cast<std::size_t>(scene_packet::FilterKind::mzColor) + 1;
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

  Renderer(const Renderer&) = delete;
  Renderer& operator=(const Renderer&) = delete;

  void setClearColor(float red, float green, float blue, float alpha);
  void configurePixiFragmentPrecision(const std::string& precision);
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
                           const std::vector<float>& uvs,
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
  std::vector<std::uint8_t> captureSceneRgba();
  std::vector<std::uint8_t> captureSceneRawPremultiplied();
  // Window backbuffer readback, valid only before swap.
  std::vector<std::uint8_t> captureDrawableRgba();
  std::vector<std::uint8_t> renderToRgba();
  std::vector<std::uint8_t> renderToRgba(int width, int height);
  std::optional<ImageInfo> renderToImage(int width, int height, AlphaMode alphaMode = AlphaMode::straight);
  const RendererStats& stats() const { return stats_; }
  std::size_t renderTargetBytes() const;
  // Public for the modal overlay: snapshot, draw, discard back.
  std::size_t commandCount() const;
  void discardCommandsFrom(std::size_t first);

 private:
  struct TileProgramUniforms {
    int world = -1;
    int screen = -1;
    int animation = -1;
    int textureSize = -1;
    int color = -1;
    int overlayColor = -1;
    int trianglePaintEnabled = -1;
    int trianglePaint = -1;
    int mvBlendEnabled = -1;
    int mvBounds = -1;
    int nearestSampling = -1;
    int mvPremultipliedInput = -1;
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
  };

  struct TileLayerResource {
    std::uint32_t vertexArray = 0;
    std::uint32_t vertexBuffer = 0;
    std::vector<ImageHandle> images;
    std::vector<TileBatch> batches;
    std::uint32_t owners = 1;
    std::uint32_t queuedReferences = 0;
    // Typed material state is retained with the mesh; the scene packet carries dynamic color.
    MeshMaterial material;
  };

  struct PrimitiveSurfaceResource {
    std::uint16_t generation = 1;
    ImageHandle image = 0;
    std::uint32_t framebuffer = 0;
    int width = 0;
    int height = 0;
    bool live = false;
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
  bool hasFilterOverride_ = false;
  PresentFilter filterOverride_ = PresentFilter::nearest;
  int queueWidth_;
  int queueHeight_;
  int maxTextureSize_ = 0;
  std::string pixiFragmentPrecision_ = "mediump";
  // Native rendering is shared across facades; the first Pixi renderer fixes precision.
  bool pixiPrecisionConfigured_ = false;
  ImageStore& images_;
  std::array<float, 4> clearColor_{0.0F, 0.0F, 0.0F, 1.0F};
  bool sceneSubmittedThisFrame_ = false;
  bool hasValidSceneFrame_ = false;
  FramePacket frame_;
  std::vector<float> vertices_;
  RendererStats stats_;
  std::vector<FilterContentBounds> filterBounds_;
  bool filterBoundsEnabled_ = true;
  std::uint32_t program_ = 0;
  std::uint32_t simpleProgram_ = 0;
  std::uint32_t spriteEffectProgram_ = 0;
  std::uint32_t clearTriangleProgram_ = 0;
  int clearTrianglePointsUniform_ = -1;
  int clearTriangleNormalsUniform_ = -1;
  int clearTriangleRectangleUniform_ = -1;
  std::uint32_t generatedTextureProgram_ = 0;
  int generatedTexturePremultipliedUniform_ = -1;
  std::uint32_t presentationProgram_ = 0;
  int presentationSceneUniform_ = -1;
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
  int simpleSpriteVerticesUniform_ = -1;
  int simpleSpriteProjectionUniform_ = -1;
  int simpleSpritePackingUniform_ = -1;
  int simpleSpritePremultipliedUniform_ = -1;
  int spriteEffectVerticesUniform_ = -1;
  int spriteEffectProjectionUniform_ = -1;
  int spriteEffectPackingUniform_ = -1;
  int spriteEffectPremultipliedUniform_ = -1;
  int spriteEffectFrameUniform_ = -1;
  int spriteEffectNearestUniform_ = -1;
  int spriteEffectTextureSizeUniform_ = -1;
  int spriteEffectBlurUniform_ = -1;
  int spriteEffectMaskEnabledUniform_ = -1;
  int spriteEffectMaskImageUniform_ = -1;
  int spriteEffectMaskTransformUniform_ = -1;
  int spriteEffectMaskTextureSizeUniform_ = -1;
  int spriteEffectScreenHeightUniform_ = -1;
  int spriteEffectColorEnabledUniform_ = -1;
  int spriteEffectColorToneUniform_ = -1;
  int spriteEffectBlendColorUniform_ = -1;
  int spriteEffectMatrixEnabledUniform_ = -1;
  int spriteEffectMatrixUniform_ = -1;
  int spriteEffectMatrixAlphaUniform_ = -1;
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
  std::uint32_t sceneFramebuffer_ = 0;
  std::uint32_t sceneTexture_ = 0;
  std::uint32_t offscreenFramebuffer_ = 0;
  std::uint32_t offscreenTexture_ = 0;
  std::uint32_t filterFramebuffer_ = 0;
  std::uint32_t filterTexture_ = 0;
  std::uint32_t toneOverlayFramebuffer_ = 0;
  std::uint32_t toneOverlayTexture_ = 0;
  std::uint32_t bloomFramebuffer_ = 0;
  std::uint32_t bloomTexture_ = 0;
  std::array<std::uint32_t, scene_packet::maxFilterDepth> groupFramebuffers_{};
  std::array<std::uint32_t, scene_packet::maxFilterDepth> groupTextures_{};
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
};

}  // namespace pmjs
