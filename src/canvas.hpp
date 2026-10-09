#pragma once

#include "resources.hpp"
#include "canvas_pixels.hpp"
#include "canvas_composite.hpp"
#include "text_backend.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <memory>
#include <string>
#include <vector>
#include <span>

#include <variant>
#include <unordered_set>

namespace pmjs {

using CanvasHandle = std::uint32_t;

struct CanvasInfo {
  CanvasHandle handle;
  int width;
  int height;
};

struct CanvasTextMetrics {
  double width = 0;
  double actualLeft = 0;
  double actualRight = 0;
  double actualAscent = 0;
  double actualDescent = 0;
  double fontAscent = 0;
  double fontDescent = 0;
};

struct CanvasTextStats {
  std::size_t fontFaces = 0;
  std::size_t fontStrikes = 0;
  std::size_t glyphEntries = 0;
  std::size_t glyphBytes = 0;
  std::size_t maxGlyphBytes = 0;
  std::size_t maxGlyphEntries = 0;

  std::uint64_t glyphMetricHits = 0;
  std::uint64_t glyphMetricMisses = 0;

  std::uint64_t glyphMaskHits = 0;
  std::uint64_t glyphMaskMisses = 0;

  std::uint64_t strokeMaskHits = 0;
  std::uint64_t strokeMaskMisses = 0;

  std::uint64_t glyphEvictions = 0;

  std::uint64_t freetypeLoadUs = 0;
  std::uint64_t freetypeRenderUs = 0;
  std::uint64_t strokeBuildUs = 0;
  std::uint64_t glyphBlendUs = 0;
  std::uint64_t layoutRequests = 0;
  std::uint64_t layoutCacheHits = 0;
  std::uint64_t shapeTextCalls = 0;
  std::uint64_t shapeTextUs = 0;
  std::uint64_t fallbackShapeCalls = 0;
  std::size_t layoutCacheBytes = 0;
};

using CanvasPath = std::vector<std::array<double, 2>>;
struct CanvasClip {
  std::vector<CanvasPath> paths;
  bool evenOdd = false;
};
struct CanvasPaint {
  enum class Kind { solid, linear, radial, pattern };
  Kind kind = Kind::solid;
  std::uint32_t color = 0;
  std::array<double, 6> geometry{};
  std::vector<double> offsets;
  std::vector<std::uint32_t> colors;
  std::span<const std::uint8_t> pixels;
  int width = 0, height = 0;
  std::string repeat;
  std::array<double, 6> transform = {1, 0, 0, 1, 0, 0};
};
struct CanvasCirclePaint {
  double x = 0, y = 0, radius = 0, alpha = 1;
  std::array<float, 6> transform = {1, 0, 0, 1, 0, 0};
  CanvasPaint paint;
  CanvasComposite composite = CanvasComposite::sourceOver;
  std::vector<CanvasClip> clips;
};

class CanvasStore {
 public:
  explicit CanvasStore(ImageStore& images);
  ~CanvasStore();

  CanvasStore(const CanvasStore&) = delete;
  CanvasStore& operator=(const CanvasStore&) = delete;

  std::optional<CanvasInfo> create(int width, int height);
  std::optional<CanvasInfo> createPixels(int width, int height,
                                       std::vector<std::uint8_t> pixels, PixelEncoding encoding);
  bool fillRect(CanvasHandle handle, int x, int y, int width, int height,
                std::uint32_t rgba);
  bool compositePixels(CanvasHandle handle, int x, int y, int width, int height,
    std::span<const std::uint8_t> pixels, std::span<const std::uint8_t> clip,
    CanvasComposite operation, double alpha);
  bool paintCircle(CanvasHandle handle, const CanvasCirclePaint& request);
  bool paintRect(CanvasHandle handle, const std::array<float, 4>& rect, uint32_t color, float stroke,
    const std::array<float, 4>& gradient, const std::vector<float>& offsets, const std::vector<uint32_t>& colors);
  bool fillRadialGradient(CanvasHandle handle, int x, int y, int width, int height,
                          float centerX, float centerY, float innerRadius,
                          float outerRadius, const std::vector<float>& offsets,
                          const std::vector<std::uint32_t>& colors,
                          bool additive);
  bool clear(CanvasHandle handle);
  bool clearRect(CanvasHandle handle, int x, int y, int width, int height);
  bool drawImage(CanvasHandle destination, std::uint32_t source,
                 float sourceX, float sourceY, float sourceWidth, float sourceHeight,
                 float destinationX, float destinationY,
                 float destinationWidth, float destinationHeight, float alpha, bool smoothing = true);
  bool drawText(CanvasHandle handle, const std::vector<std::filesystem::path>& fontPaths,
                const std::string& text, float x, float y, float pixelSize,
                std::uint32_t rgba, float strokeWidth = 0, const CanvasTextStyle& style = {});
  std::optional<double> measureText(const std::vector<std::filesystem::path>& fontPaths,
                                 const std::string& text, float pixelSize, const CanvasTextStyle& style = {}) const;
  std::optional<CanvasTextMetrics> measureTextMetrics(
    const std::vector<std::filesystem::path>& fontPaths, const std::string& text,
    float pixelSize, const CanvasTextStyle& style = {}) const;
  bool drawText(CanvasHandle handle, const std::filesystem::path& fontPath,
                const std::string& text, float x, float y, float pixelSize,
                std::uint32_t rgba, float strokeWidth = 0, const CanvasTextStyle& style = {}) {
    return drawText(handle, std::vector<std::filesystem::path>{fontPath}, text,
                    x, y, pixelSize, rgba, strokeWidth, style);
  }
  std::optional<double> measureText(const std::filesystem::path& fontPath,
                                    const std::string& text, float pixelSize, const CanvasTextStyle& style = {}) const {
    return measureText(std::vector<std::filesystem::path>{fontPath}, text, pixelSize, style);
  }
  bool canLoadFont(const std::filesystem::path& fontPath);
  std::optional<std::uint32_t> pixel(CanvasHandle handle, int x, int y);
  std::optional<ImagePixels> readPixels(CanvasHandle handle, int x, int y,
                                        int width, int height, PixelEncoding encoding = PixelEncoding::StraightRGBA8);
  std::optional<std::vector<std::uint8_t>> encodePng(CanvasHandle handle);
  std::optional<std::vector<std::uint8_t>> encodeWebP(CanvasHandle handle);
  bool writePixels(CanvasHandle handle, int x, int y, int width, int height,
                   const std::vector<std::uint8_t>& pixels, PixelEncoding encoding = PixelEncoding::StraightRGBA8);
  bool replacePixels(CanvasHandle handle, std::vector<std::uint8_t> pixels, PixelEncoding encoding);
  bool blur(CanvasHandle handle);
  // Two additive 3x3 passes over opaque black, using Skia65 byte scaling.
  // Returns false without painting when raw RGB exceeds alpha.
  bool blurMv(CanvasHandle handle);
  bool release(CanvasHandle handle);
  bool realize(CanvasHandle handle);
  std::optional<CanvasInfo> info(CanvasHandle handle) const;
  std::optional<ImageHandle> imageHandle(CanvasHandle handle) const;
  std::optional<ImageHandle> prepareImage(CanvasHandle handle);
  void uploadDirty();
  std::size_t cpuBytes() const;
  std::size_t capacityBytes() const;
  std::size_t liveCount() const { return liveCount_; }
  std::size_t peakCpuBytes() const { return peakCpuBytes_; }
  std::size_t peakLiveCount() const { return peakLiveCount_; }
  std::size_t deferredCanvasCount() const;
  std::size_t realizedCanvasCount() const;
  std::size_t deferredCommandCount() const;
  std::size_t deferredCommandBytes() const;
  CanvasTextStats glyphCacheStats() const;
  const char* textBackendName() const { return textBackend_.name(); }
  TextBackendStats textBackendStats() const { return textBackend_.stats(); }
  void setGlyphCacheLimits(std::size_t maxBytes, std::size_t maxEntries);

 private:
  static std::vector<std::uint8_t> circleCoverage(float x, float y, float radius,
    const std::array<float, 6>& transform, int left, int top, int width, int height,
    const std::vector<std::array<float, 4>>& clips = {});
  struct FontState;

  struct FillRectCmd {
    int x;
    int y;
    int width;
    int height;
    std::uint32_t rgba;
  };

  struct ClearRectCmd {
    int x;
    int y;
    int width;
    int height;
  };

  struct Content;

  struct DrawImageCmd {
    ImageHandle source;
    std::shared_ptr<Content> canvas;
    float sourceX;
    float sourceY;
    float sourceWidth;
    float sourceHeight;
    float destinationX;
    float destinationY;
    float destinationWidth;
    float destinationHeight;
    float alpha;
    bool smoothing;
  };

  struct DrawTextCmd {
    std::vector<std::filesystem::path> fontPaths;
    std::string text;
    float x;
    float y;
    float pixelSize;
    std::uint32_t rgba;
    float strokeWidth;
    CanvasTextStyle style;
  };

  struct BlurCmd {};

  using CanvasCommand = std::variant<FillRectCmd, ClearRectCmd,
                                     DrawImageCmd, DrawTextCmd, BlurCmd>;

  enum class ContentState {
    Deferred,
    Realizing,
    Realized  // CPU pixels are current.
  };

  struct Content {
    explicit Content(CanvasStore& owner);
    ~Content();
    Content(const Content&) = delete;
    Content& operator=(const Content&) = delete;

    CanvasStore& owner;
    int width = 0;
    int height = 0;
    ContentState state = ContentState::Deferred;
    // Authoritative top-down premultiplied BGRA8; shared versions detach before writes.
    std::vector<std::uint8_t> pixels;
    // Conservative hint: raw premultiplied input can violate RGB <= alpha.
    bool mayHaveOverAlpha = false;
    std::vector<CanvasCommand> commands;
    std::size_t queuedCommandBytes = 0;
    int dirtyX0 = 0;
    int dirtyY0 = 0;
    int dirtyX1 = 0;
    int dirtyY1 = 0;
    std::size_t dependencyDepth = 0;
  };

  struct Surface {
    std::uint16_t generation = 1;
    ImageHandle image = 0;
    std::shared_ptr<Content> content;
    bool live = false;
  };

  static CanvasHandle makeHandle(std::size_t index, std::uint16_t generation);
  Surface* lookup(CanvasHandle handle);
  const Surface* lookup(CanvasHandle handle) const;

  Content* lookupContent(CanvasHandle handle) const;
  Content* writableContent(CanvasHandle handle);
  bool realizeContent(Content& surface);
  bool uploadSurface(Surface& surface);
  void discardCommands(Content& surface);
  void releaseCommandDependencies(CanvasCommand& cmd);

  void fillRectNow(Content& surface, int x, int y, int width, int height,
                   std::uint32_t rgba);
  void clearNow(Content& surface);
  void clearRectNow(Content& surface, int x, int y, int width, int height);
  bool drawImageNow(Content& destination, const DrawImageCmd& command);
  bool drawTextNow(Content& surface, const std::vector<std::filesystem::path>& fontPaths,
                   const std::string& text, float x, float y, float pixelSize,
                   std::uint32_t rgba, float strokeWidth, const CanvasTextStyle& style);
  bool blurNow(Content& surface);

  static void blendPixel(Content& surface, int x, int y, std::uint32_t rgba,
                         std::uint8_t coverage);
  static void blendPixelAdditive(Content& surface, int x, int y,
                                 std::uint32_t rgba);
  static void markDirty(Content& surface, int x, int y, int width, int height);

  ImageStore& images_;
  TextBackend textBackend_;
  std::unique_ptr<FontState> fonts_;
  // Non-owning registry includes versions kept alive only by queued draws.
  std::unordered_set<Content*> contents_;
  std::vector<Surface> surfaces_;
  std::size_t liveCount_ = 0;
  std::size_t peakCpuBytes_ = 0;
  std::size_t peakLiveCount_ = 0;
};

}  // namespace pmjs
