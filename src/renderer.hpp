#pragma once

#include "resources.hpp"
#include "scene_packet.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <unordered_map>
#include <vector>

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

struct RendererStats {
  static constexpr std::size_t filterKindCount =
    static_cast<std::size_t>(scene_packet::FilterKind::fxaa) + 1;
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
  std::uint64_t framebufferChecks = 0;
  std::uint64_t framebufferCopies = 0;
  std::uint64_t toneAdjustDrawCalls = 0;
  std::uint64_t toneComposedPresentationFrames = 0;
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

class Renderer {
 public:
  Renderer(int width, int height, ImageStore& images);
  ~Renderer();

  Renderer(const Renderer&) = delete;
  Renderer& operator=(const Renderer&) = delete;

  void setClearColor(float red, float green, float blue, float alpha);
  bool setRenderTargetSize(int width, int height);
  bool setScreenRenderSize(int width, int height);
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
                           bool triangleStrip);
  bool queueTileLayer(std::uint32_t layer,
                      const std::array<float, 6>& transform,
                      const std::array<float, 2>& animation, float alpha,
                      std::uint32_t tint, BlendMode blendMode);
  bool releaseTileLayer(std::uint32_t layer);
  bool queueScene(std::uint32_t version, const std::uint32_t* metadata,
                  std::size_t metadataCount,
                  const float* values, std::size_t valueCount,
                  std::size_t nodeCount);
  void render();
  std::vector<std::uint8_t> captureSceneRgba();
  std::vector<std::uint8_t> renderToRgba();
  std::vector<std::uint8_t> renderToRgba(int width, int height);
  std::optional<ImageInfo> renderToImage(int width, int height);
  const RendererStats& stats() const { return stats_; }
  std::size_t renderTargetBytes() const;

 private:
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
  };

  void discardCommandsFrom(std::size_t first);
  void destroyTileLayer(std::uint32_t handle);
  void resizeTargets(int width, int height);
  void drawToneComposition(std::uint32_t framebuffer, int width, int height);
  void materializeToneComposition();

  int width_;
  int height_;
  int presentationWidth_;
  int presentationHeight_;
  int queueWidth_;
  int queueHeight_;
  int maxTextureSize_ = 0;
  ImageStore& images_;
  std::array<float, 4> clearColor_{0.0F, 0.0F, 0.0F, 1.0F};
  bool sceneSubmittedThisFrame_ = false;
  bool hasValidSceneFrame_ = false;
  FramePacket frame_;
  std::vector<float> vertices_;
  RendererStats stats_;
  std::uint32_t program_ = 0;
  std::uint32_t simpleProgram_ = 0;
  std::uint32_t spriteEffectProgram_ = 0;
  std::uint32_t generatedTextureProgram_ = 0;
  std::uint32_t presentationProgram_ = 0;
  int presentationSceneUniform_ = -1;
  int presentationOverlayUniform_ = -1;
  int presentationColorMatrixUniform_ = -1;
  int presentationColorMatrixAlphaUniform_ = -1;
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
  int tileWorldUniform_ = -1;
  int tileScreenUniform_ = -1;
  int tileAnimationUniform_ = -1;
  int tileTextureSizeUniform_ = -1;
  int tileColorUniform_ = -1;
  int tileMaskEnabledUniform_ = -1;
  int tileMaskImageUniform_ = -1;
  int tileMaskTransformUniform_ = -1;
  int tileMaskFrameUniform_ = -1;
  int tileMaskTextureSizeUniform_ = -1;
  int tileMaskScreenHeightUniform_ = -1;
  std::uint32_t vertexArray_ = 0;
  std::uint32_t vertexBuffer_ = 0;
  std::uint32_t whiteTexture_ = 0;
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
  std::array<float, 20> presentationColorMatrix_{};
  float presentationColorMatrixAlpha_ = 1.0F;
  std::uint32_t nextTileLayer_ = 1;
  std::unordered_map<std::uint32_t, TileLayerResource> tileLayers_;
  std::unordered_map<std::uint32_t, bool> textureRepeatState_;
  std::unordered_map<std::uint32_t, bool> textureNearestState_;
};

}  // namespace pmjs
