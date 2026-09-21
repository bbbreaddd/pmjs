#pragma once

#include "resources.hpp"

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <memory>
#include <string>
#include <vector>

#include <variant>

namespace pmjs {

using CanvasHandle = std::uint32_t;

struct CanvasInfo {
  CanvasHandle handle;
  int width;
  int height;
};

struct CanvasTextMetrics {
  int width = 0;
  int actualLeft = 0;
  int actualRight = 0;
  int actualAscent = 0;
  int actualDescent = 0;
  int fontAscent = 0;
  int fontDescent = 0;
};

struct GlyphCacheStats {
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
};

class CanvasStore {
 public:
  explicit CanvasStore(ImageStore& images);
  ~CanvasStore();

  CanvasStore(const CanvasStore&) = delete;
  CanvasStore& operator=(const CanvasStore&) = delete;

  std::optional<CanvasInfo> create(int width, int height);
  std::optional<CanvasInfo> createRgba(int width, int height,
                                       std::vector<std::uint8_t> pixels);
  bool fillRect(CanvasHandle handle, int x, int y, int width, int height,
                std::uint32_t rgba);
  bool fillRadialGradient(CanvasHandle handle, int x, int y, int width, int height,
                          float centerX, float centerY, float innerRadius,
                          float outerRadius, const std::vector<float>& offsets,
                          const std::vector<std::uint32_t>& colors,
                          bool additive);
  bool clear(CanvasHandle handle);
  bool clearRect(CanvasHandle handle, int x, int y, int width, int height);
  bool drawImage(CanvasHandle destination, std::uint32_t source,
                 int sourceX, int sourceY, int sourceWidth, int sourceHeight,
                 int destinationX, int destinationY,
                 int destinationWidth, int destinationHeight, float alpha);
  bool drawText(CanvasHandle handle, const std::filesystem::path& fontPath,
                const std::string& text, int x, int y, int pixelSize,
                std::uint32_t rgba, int strokeWidth = 0);
  std::optional<int> measureText(const std::filesystem::path& fontPath,
                                 const std::string& text, int pixelSize) const;
  std::optional<CanvasTextMetrics> measureTextMetrics(
    const std::filesystem::path& fontPath, const std::string& text,
    int pixelSize) const;
  bool canLoadFont(const std::filesystem::path& fontPath);
  std::optional<std::uint32_t> pixel(CanvasHandle handle, int x, int y);
  std::optional<ImagePixels> readPixels(CanvasHandle handle, int x, int y,
                                        int width, int height);
  std::optional<std::vector<std::uint8_t>> encodePng(CanvasHandle handle);
  bool writePixels(CanvasHandle handle, int x, int y, int width, int height,
                   const std::vector<std::uint8_t>& pixels);
  bool blur(CanvasHandle handle);
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
  GlyphCacheStats glyphCacheStats() const;
  void setGlyphCacheLimits(std::size_t maxBytes, std::size_t maxEntries);

 private:
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

  struct DrawImageCmd {
    ImageHandle source;
    int sourceX;
    int sourceY;
    int sourceWidth;
    int sourceHeight;
    int destinationX;
    int destinationY;
    int destinationWidth;
    int destinationHeight;
    float alpha;
  };

  struct DrawTextCmd {
    std::filesystem::path fontPath;
    std::string text;
    int x;
    int y;
    int pixelSize;
    std::uint32_t rgba;
    int strokeWidth;
  };

  struct BlurCmd {};

  using CanvasCommand = std::variant<FillRectCmd, ClearRectCmd,
                                     DrawImageCmd, DrawTextCmd, BlurCmd>;

  enum class SurfaceState {
    Deferred,
    Realizing,
    Realized
  };

  struct Surface {
    std::uint16_t generation = 1;
    ImageHandle image = 0;
    int width = 0;
    int height = 0;
    SurfaceState state = SurfaceState::Deferred;
    std::vector<std::uint8_t> pixels;
    std::vector<CanvasCommand> commands;
    std::size_t queuedCommandBytes = 0;
    int dirtyX0 = 0;
    int dirtyY0 = 0;
    int dirtyX1 = 0;
    int dirtyY1 = 0;
    bool live = false;
  };

  static CanvasHandle makeHandle(std::size_t index, std::uint16_t generation);
  Surface* lookup(CanvasHandle handle);
  const Surface* lookup(CanvasHandle handle) const;

  bool realizeSurface(Surface& surface);
  void discardCommands(Surface& surface);
  void releaseCommandDependencies(CanvasCommand& cmd);

  void fillRectNow(Surface& surface, int x, int y, int width, int height,
                   std::uint32_t rgba);
  void clearNow(Surface& surface);
  void clearRectNow(Surface& surface, int x, int y, int width, int height);
  bool drawImageNow(Surface& destinationSurface, std::uint32_t source,
                    int sourceX, int sourceY, int sourceWidth, int sourceHeight,
                    int destinationX, int destinationY,
                    int destinationWidth, int destinationHeight, float alpha);
  bool drawTextNow(Surface& surface, const std::filesystem::path& fontPath,
                   const std::string& text, int x, int y, int pixelSize,
                   std::uint32_t rgba, int strokeWidth);
  bool blurNow(Surface& surface);

  static void blendPixel(Surface& surface, int x, int y, std::uint32_t rgba,
                         std::uint8_t coverage);
  static void blendPixelAdditive(Surface& surface, int x, int y,
                                 std::uint32_t rgba);
  static void markDirty(Surface& surface, int x, int y, int width, int height);

  ImageStore& images_;
  std::unique_ptr<FontState> fonts_;
  std::vector<Surface> surfaces_;
  std::size_t liveCount_ = 0;
  std::size_t peakCpuBytes_ = 0;
  std::size_t peakLiveCount_ = 0;
};

}  // namespace pmjs
