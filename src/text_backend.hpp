#pragma once
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <vector>
#include <cstdint>

namespace pmjs {
struct CanvasTextStyle {
  bool bold = false;
  bool italic = false;
  int join = 0;
  int cap = 0;
  float miterLimit = 10;
};
struct CanvasTextMetrics;
struct TextBackendStats {
  std::string identity;
  size_t cacheBytes = 0, cacheLimit = 0, cacheEntries = 0, fontStacks = 0;
  uint64_t layoutRequests = 0, layoutHits = 0, drawCalls = 0, shapeNs = 0, drawNs = 0;
  std::string libraryPath;
  size_t scratchPeakBytes = 0;
};
class TextBackend {
 public:
  TextBackend();
  ~TextBackend();
  bool skia() const { return skia_; }
  const char* name() const { return skia_ ? "skia65" : "freetype"; }
  bool draw(const std::vector<std::filesystem::path>& paths, const std::string& text,
    float x, float y, float size, uint32_t rgba, float stroke, const CanvasTextStyle& style,
    std::vector<uint8_t>& straight, int width, int height, int dirty[4]);
  std::optional<CanvasTextMetrics> measure(const std::vector<std::filesystem::path>& paths,
    const std::string& text, float size, const CanvasTextStyle& style);
  bool canLoad(const std::filesystem::path& path);
  TextBackendStats stats() const;
  void limits(size_t bytes, size_t entries);
 private:
  struct State;
  std::unique_ptr<State> state_;
  bool skia_ = false;
};
}
