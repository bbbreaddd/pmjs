#include "log.hpp"
#include "canvas.hpp"
#include "checked_bounds.hpp"
#include "text_layout.hpp"
#ifdef PMJS_HAS_SKIA65
#include "skia65/pmjs_skia65.h"
#endif
#include <hb-ft.h>

#include <ft2build.h>
#include FT_FREETYPE_H
#include <png.h>
#include <webp/encode.h>
#include <jpeglib.h>
#include <csetjmp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <list>
#include <unordered_map>
#include <unordered_set>
#include <utility>

namespace pmjs {
std::vector<std::uint8_t> CanvasStore::circleCoverage(float x, float y, float radius,
    const std::array<float, 6>& transform, int left, int top, int width, int height,
    const std::vector<std::array<float, 4>>& clips) {
  auto extent = checkedImageExtent(width, height);
  if (!extent || !std::isfinite(x) || !std::isfinite(y) || !std::isfinite(radius) || radius < 0 ||
      !std::all_of(transform.begin(), transform.end(), [](float value) { return std::isfinite(value); }) ||
      clips.size() > 16 || !std::all_of(clips.begin(), clips.end(), [](const auto& clip) {
        return std::all_of(clip.begin(), clip.end(), [](float value) { return std::isfinite(value); }) && clip[2] >= 0 && clip[3] >= 0;
      }))
    throw std::invalid_argument("invalid circle coverage geometry");
  std::vector<std::uint8_t> coverage(extent->rgbaBytes / 4, 0);
#ifdef PMJS_HAS_SKIA65
  std::vector<float> clipValues;
  for (const auto& clip : clips) clipValues.insert(clipValues.end(), clip.begin(), clip.end());
  if (!pmjs_skia65_circle_coverage(x, y, radius, transform.data(), left, top, width, height, coverage.data(),
      clipValues.data(), clips.size()))
    throw std::runtime_error("circle rasterization failed");
#else
  const double determinant = transform[0] * transform[3] - transform[1] * transform[2];
  if (determinant == 0) return coverage;
  // Portable builds use bounded subpixel coverage instead of binary polygons.
  for (int row = 0; row < height; ++row) for (int column = 0; column < width; ++column) {
    int inside = 0;
    for (int sy = 0; sy < 16; ++sy) for (int sx = 0; sx < 16; ++sx) {
      const double px = static_cast<double>(left) + column + (sx + 0.5) / 16 - transform[4];
      const double py = static_cast<double>(top) + row + (sy + 0.5) / 16 - transform[5];
      const double dx = (px * transform[3] - py * transform[2]) / determinant - x;
      const double dy = (py * transform[0] - px * transform[1]) / determinant - y;
      bool clipped = false;
      for (const auto& clip : clips) clipped |= px + transform[4] < clip[0] || py + transform[5] < clip[1] ||
        px + transform[4] >= clip[0] + clip[2] || py + transform[5] >= clip[1] + clip[3];
      inside += !clipped && dx * dx + dy * dy < radius * radius;
    }
    coverage[static_cast<size_t>(row) * width + column] = (inside * 255 + 128) / 256;
  }
#endif
  return coverage;
}
namespace {
#ifdef PMJS_HAS_SKIA65
template<class Draw>
std::array<int, 4> rasterCanvasRegion(std::vector<uint8_t>& pixels, int width, int height,
    const std::array<float, 4>& bounds, Draw draw) {
  // Four-pixel crop alignment retains the rasterizer's gradient dither phase.
  const int left = std::clamp<double>(std::floor(bounds[0] / 4.0) * 4, 0, width);
  const int top = std::clamp<double>(std::floor(bounds[1] / 4.0) * 4, 0, height);
  const int right = std::clamp<double>(std::ceil(static_cast<double>(bounds[0]) + bounds[2]), 0, width);
  const int bottom = std::clamp<double>(std::ceil(static_cast<double>(bounds[1]) + bounds[3]), 0, height);
  if (right <= left || bottom <= top) return {left, top, 0, 0};
  const size_t stride = static_cast<size_t>(width) * 4;
  auto* origin = pixels.data() + top * stride + left * 4;
  if (!draw(origin, right - left, bottom - top, stride, left, top))
    throw std::runtime_error("canvas rasterization failed");
  return {left, top, right - left, bottom - top};
}
#endif
}

namespace {
constexpr std::uint32_t indexMask = 0xffffU;
constexpr std::uint16_t generationMask = 0x7fffU;
constexpr std::size_t maxCanvasDependencyDepth = 16;


}

static bool normalizeFreeTypeBitmap(const FT_Bitmap& bitmap,
                                    std::vector<std::uint8_t>& outCoverage,
                                    int& outWidth,
                                    int& outHeight) {
  outWidth = static_cast<int>(bitmap.width);
  outHeight = static_cast<int>(bitmap.rows);
  if (outWidth <= 0 || outHeight <= 0 || !bitmap.buffer) {
    outWidth = 0;
    outHeight = 0;
    outCoverage.clear();
    return true;
  }

  const std::size_t totalPixels = static_cast<std::size_t>(outWidth) * outHeight;
  outCoverage.resize(totalPixels);

  const int pitch = bitmap.pitch;
  const std::uint8_t* const buffer = bitmap.buffer;

  if (bitmap.pixel_mode == FT_PIXEL_MODE_GRAY) {
    for (int r = 0; r < outHeight; ++r) {
      const std::uint8_t* srcRow = buffer + r * pitch;
      std::uint8_t* dstRow = outCoverage.data() + static_cast<std::size_t>(r) * outWidth;
      std::memcpy(dstRow, srcRow, static_cast<std::size_t>(outWidth));
    }
    return true;
  } else if (bitmap.pixel_mode == FT_PIXEL_MODE_MONO) {
    for (int r = 0; r < outHeight; ++r) {
      const std::uint8_t* srcRow = buffer + r * pitch;
      std::uint8_t* dstRow = outCoverage.data() + static_cast<std::size_t>(r) * outWidth;
      for (int c = 0; c < outWidth; ++c) {
        const std::uint8_t byteVal = srcRow[c >> 3];
        const std::uint8_t bit = (byteVal & (0x80 >> (c & 7))) ? 255 : 0;
        dstRow[c] = bit;
      }
    }
    return true;
  } else if (bitmap.pixel_mode == FT_PIXEL_MODE_BGRA) {
    for (int r = 0; r < outHeight; ++r) {
      const std::uint8_t* srcRow = buffer + r * pitch;
      std::uint8_t* dstRow = outCoverage.data() + static_cast<std::size_t>(r) * outWidth;
      for (int c = 0; c < outWidth; ++c) {
        dstRow[c] = srcRow[c * 4 + 3];
      }
    }
    return true;
  }

  std::fill(outCoverage.begin(), outCoverage.end(), 0);
  return false;
}

struct GlyphMask {
  int width = 0;
  int height = 0;
  int bitmapLeft = 0;
  int bitmapTop = 0;
  std::vector<std::uint8_t> coverage;

  std::size_t byteSize() const noexcept {
    return sizeof(GlyphMask) + coverage.capacity() * sizeof(std::uint8_t);
  }
};

static std::optional<GlyphMask> createStrokeMask(const GlyphMask& base, int strokeWidth) {
  GlyphMask stroked;
  const int radius = strokeWidth / 2 + strokeWidth % 2;
  if (base.width <= 0 || base.height <= 0 || base.coverage.empty() || radius <= 0) {
    return base;
  }
  const auto width = int64_t(base.width) + 2LL * radius;
  const auto height = int64_t(base.height) + 2LL * radius;
  if (width > 8192 || height > 8192) return std::nullopt;
  const auto extent = checkedImageExtent(static_cast<int>(width), static_cast<int>(height));
  if (!extent) return std::nullopt;
  stroked.width = extent->width;
  stroked.height = extent->height;
  stroked.bitmapLeft = base.bitmapLeft - radius;
  stroked.bitmapTop = base.bitmapTop + radius;
  stroked.coverage.assign(static_cast<std::size_t>(stroked.width) * stroked.height, 0);

  const int r2 = radius * radius;
  for (int r = 0; r < base.height; ++r) {
    const std::size_t inRowOffset = static_cast<std::size_t>(r) * base.width;
    for (int c = 0; c < base.width; ++c) {
      const auto cov = base.coverage[inRowOffset + c];
      if (cov == 0) continue;
      for (int dy = -radius; dy <= radius; ++dy) {
        const int dy2 = dy * dy;
        for (int dx = -radius; dx <= radius; ++dx) {
          if (dx * dx + dy2 > r2) continue;
          const int outR = r + radius + dy;
          const int outC = c + radius + dx;
          const std::size_t outIdx = static_cast<std::size_t>(outR) * stroked.width + outC;
          const std::uint32_t cur = stroked.coverage[outIdx];
          const std::uint32_t add = static_cast<std::uint32_t>(cov);
          stroked.coverage[outIdx] = static_cast<std::uint8_t>(cur + add * (255U - cur) / 255U);
        }
      }
    }
  }
  return stroked;
}

using FontStrikeId = std::uint32_t;

struct GlyphMetrics {
  int bearingX = 0;
  int bearingY = 0;
  int metricWidth = 0;
  int metricHeight = 0;
};

struct StrokeMaskEntry {
  int strokeWidth = 0;
  GlyphMask mask;

  std::size_t byteSize() const noexcept {
    return sizeof(StrokeMaskEntry) + mask.byteSize();
  }
};

struct CachedGlyph {
  GlyphMetrics metrics;
  bool metricsLoaded = false;

  bool fillMaskLoaded = false;
  GlyphMask fillMask;

  std::vector<StrokeMaskEntry> strokeMasks;

  std::size_t byteSize() const noexcept {
    std::size_t bytes = sizeof(CachedGlyph);
    bytes += fillMask.coverage.capacity();
    bytes += strokeMasks.capacity() * sizeof(StrokeMaskEntry);
    for (const auto& stroke : strokeMasks) {
      bytes += stroke.mask.coverage.capacity();
    }
    return bytes;
  }
};

struct GlyphKey {
  FontStrikeId strikeId = 0;
  FT_UInt glyphIndex = 0;

  bool operator==(const GlyphKey& o) const noexcept {
    return strikeId == o.strikeId && glyphIndex == o.glyphIndex;
  }
};

struct GlyphKeyHash {
  std::size_t operator()(const GlyphKey& k) const noexcept {
    const std::uint64_t packed =
        (static_cast<std::uint64_t>(k.strikeId) << 32U) |
        static_cast<std::uint64_t>(k.glyphIndex);
    return std::hash<std::uint64_t>{}(packed);
  }
};

struct FontStrike {
  FontStrikeId id = 0;
  std::filesystem::path path;
  int pixelSize = 0;
  FT_Face face = nullptr;
  hb_font_t* shapingFont = nullptr;
};

struct GlyphRenderItem {
  const GlyphMask* mask = nullptr;
};

struct CanvasStore::FontState {
  FT_Library library = nullptr;
  std::unordered_set<std::string> failedFaces;
  std::unordered_set<std::string> failedStrikes;
  std::vector<std::unique_ptr<FontStrike>> strikes;
  std::unordered_map<std::string, FontStrikeId> strikeLookup;

  std::size_t maxGlyphEntries = 4096;
  std::size_t maxGlyphBytes = 8 * 1024 * 1024;
  std::size_t currentGlyphBytes = 0;

  std::list<GlyphKey> lruOrder;
  std::unordered_map<GlyphKey, std::pair<CachedGlyph, std::list<GlyphKey>::iterator>, GlyphKeyHash> glyphCache;

  CanvasTextStats stats;
  bool telemetryEnabled = false;
  std::chrono::steady_clock::time_point lastTelemetryReport = std::chrono::steady_clock::now();

  FontState() {
    FT_Init_FreeType(&library);
    if (const char* env = std::getenv("PMJS_FONT_TELEMETRY")) {
      telemetryEnabled = (std::string(env) == "1");
    } else if (const char* env2 = std::getenv("PMJS_GLYPH_TELEMETRY")) {
      telemetryEnabled = (std::string(env2) == "1");
    }

    if (const char* maxBytesEnv = std::getenv("PMJS_GLYPH_CACHE_MAX_BYTES")) {
      try {
        maxGlyphBytes = std::max<std::size_t>(1024, std::stoull(maxBytesEnv));
      } catch (...) {}
    }
    if (const char* maxEntriesEnv = std::getenv("PMJS_GLYPH_CACHE_MAX_ENTRIES")) {
      try {
        maxGlyphEntries = std::max<std::size_t>(1, std::stoull(maxEntriesEnv));
      } catch (...) {}
    }
  }

  ~FontState() {
    if (telemetryEnabled) {
      reportTelemetry(true);
    }
    glyphCache.clear();
    lruOrder.clear();
    for (auto& s : strikes) {
      if (s && s->shapingFont) {
        hb_font_destroy(s->shapingFont);
        s->shapingFont = nullptr;
      }
      if (s && s->face) {
        FT_Done_Face(s->face);
        s->face = nullptr;
      }
    }
    strikes.clear();
    if (library) {
      FT_Done_FreeType(library);
      library = nullptr;
    }
  }

  void evictOldest(const GlyphKey* pinnedKey = nullptr) {
    if (lruOrder.empty()) return;
    auto it = lruOrder.rbegin();
    while (it != lruOrder.rend()) {
      if (!pinnedKey || !(*it == *pinnedKey)) {
        break;
      }
      ++it;
    }
    if (it == lruOrder.rend()) return;

    const GlyphKey keyToEvict = *it;
    auto mapIt = glyphCache.find(keyToEvict);
    if (mapIt != glyphCache.end()) {
      const std::size_t bytes = mapIt->second.first.byteSize();
      if (currentGlyphBytes >= bytes) {
        currentGlyphBytes -= bytes;
      } else {
        currentGlyphBytes = 0;
      }
      lruOrder.erase(mapIt->second.second);
      glyphCache.erase(mapIt);
      stats.glyphEvictions++;
    }
  }

  void enforceLimits(const GlyphKey* pinnedKey = nullptr) {
    while ((currentGlyphBytes > maxGlyphBytes || glyphCache.size() > maxGlyphEntries) &&
           !lruOrder.empty()) {
      const std::size_t beforeSize = glyphCache.size();
      evictOldest(pinnedKey);
      if (glyphCache.size() == beforeSize) {
        break;
      }
    }
  }

  FontStrike* getStrike(const std::filesystem::path& path, int pixelSize) {
    if (!library || pixelSize <= 0) return nullptr;
    const std::string pathStr = path.string();
    if (failedFaces.count(pathStr)) return nullptr;

    const std::string key = pathStr + '\n' + std::to_string(pixelSize);
    if (failedStrikes.count(key)) return nullptr;

    auto it = strikeLookup.find(key);
    if (it != strikeLookup.end()) {
      return strikes[it->second].get();
    }

    FT_Face created = nullptr;
    if (FT_New_Face(library, path.c_str(), 0, &created) != 0) {
      failedFaces.insert(pathStr);
      return nullptr;
    }
    if (FT_Set_Pixel_Sizes(created, 0, static_cast<FT_UInt>(pixelSize)) != 0) {
      FT_Done_Face(created);
      failedStrikes.insert(key);
      return nullptr;
    }

    auto strike = std::make_unique<FontStrike>();
    strike->id = static_cast<FontStrikeId>(strikes.size());
    strike->path = path;
    strike->pixelSize = pixelSize;
    strike->face = created;
    strike->shapingFont = hb_ft_font_create_referenced(created);
    hb_ft_font_set_load_flags(strike->shapingFont, FT_LOAD_NO_HINTING);

    FontStrike* ptr = strike.get();
    strikeLookup.emplace(key, strike->id);
    strikes.push_back(std::move(strike));
    return ptr;
  }

  FT_Face face(const std::filesystem::path& path, int pixelSize) {
    auto* strike = getStrike(path, pixelSize);
    return strike ? strike->face : nullptr;
  }

  const GlyphMetrics* getOrLoadMetrics(FontStrike* strike, FT_UInt glyphIndex) {
    if (!strike || !strike->face) return nullptr;
    const GlyphKey key{strike->id, glyphIndex};

    auto it = glyphCache.find(key);
    if (it != glyphCache.end() && it->second.first.metricsLoaded) {
      lruOrder.splice(lruOrder.begin(), lruOrder, it->second.second);
      stats.glyphMetricHits++;
      return &it->second.first.metrics;
    }
    stats.glyphMetricMisses++;

    std::chrono::steady_clock::time_point t0;
    if (telemetryEnabled) {
      t0 = std::chrono::steady_clock::now();
    }
    if (FT_Load_Glyph(strike->face, glyphIndex, FT_LOAD_DEFAULT) != 0) {
      return nullptr;
    }
    if (telemetryEnabled) {
      const auto t1 = std::chrono::steady_clock::now();
      stats.freetypeLoadUs += std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count();
    }

    const FT_GlyphSlot slot = strike->face->glyph;
    GlyphMetrics metrics;
    metrics.bearingX = static_cast<int>(slot->metrics.horiBearingX >> 6);
    metrics.bearingY = static_cast<int>(slot->metrics.horiBearingY >> 6);
    metrics.metricWidth = static_cast<int>(slot->metrics.width >> 6);
    metrics.metricHeight = static_cast<int>(slot->metrics.height >> 6);

    if (it != glyphCache.end()) {
      it->second.first.metrics = metrics;
      it->second.first.metricsLoaded = true;
      return &it->second.first.metrics;
    }

    CachedGlyph cached;
    cached.metrics = metrics;
    cached.metricsLoaded = true;

    lruOrder.push_front(key);
    auto [insIt, _] = glyphCache.emplace(key, std::make_pair(std::move(cached), lruOrder.begin()));
    currentGlyphBytes += insIt->second.first.byteSize();
    enforceLimits(&key);

    return &insIt->second.first.metrics;
  }

  std::optional<GlyphRenderItem> getOrLoadMask(FontStrike* strike,
                                               FT_UInt glyphIndex,
                                               int strokeWidth) {
    if (strokeWidth < 0 || !strike || !strike->face) {
      return std::nullopt;
    }
    const GlyphKey key{strike->id, glyphIndex};

    auto it = glyphCache.find(key);
    if (it != glyphCache.end()) {
      lruOrder.splice(lruOrder.begin(), lruOrder, it->second.second);
    }

    if (it == glyphCache.end() || !it->second.first.metricsLoaded) {
      if (!getOrLoadMetrics(strike, glyphIndex)) {
        return std::nullopt;
      }
      it = glyphCache.find(key);
      if (it == glyphCache.end()) return std::nullopt;
    }

    CachedGlyph& cached = it->second.first;
    const std::size_t bytesBefore = cached.byteSize();

    if (!cached.fillMaskLoaded) {
      stats.glyphMaskMisses++;
      std::chrono::steady_clock::time_point t0;
      if (telemetryEnabled) {
        t0 = std::chrono::steady_clock::now();
      }

      if (FT_Load_Glyph(strike->face, glyphIndex, FT_LOAD_RENDER) != 0) {
        return std::nullopt;
      }
      const FT_GlyphSlot slot = strike->face->glyph;
      GlyphMask mask;
      if (!normalizeFreeTypeBitmap(slot->bitmap, mask.coverage,
                                   mask.width, mask.height)) {
        return std::nullopt;
      }
      mask.bitmapLeft = slot->bitmap_left;
      mask.bitmapTop = slot->bitmap_top;
      cached.fillMask = std::move(mask);
      cached.fillMaskLoaded = true;

      if (telemetryEnabled) {
        const auto t1 = std::chrono::steady_clock::now();
        stats.freetypeRenderUs += std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count();
      }
    } else {
      stats.glyphMaskHits++;
    }

    const GlyphMask* resultMask = nullptr;

    if (strokeWidth == 0) {
      resultMask = &cached.fillMask;
    } else {
      auto strokeIt = std::find_if(cached.strokeMasks.begin(), cached.strokeMasks.end(),
        [strokeWidth](const StrokeMaskEntry& e) { return e.strokeWidth == strokeWidth; });

      if (strokeIt != cached.strokeMasks.end()) {
        stats.strokeMaskHits++;
        resultMask = &strokeIt->mask;
      } else {
        stats.strokeMaskMisses++;
        std::chrono::steady_clock::time_point t0;
        if (telemetryEnabled) {
          t0 = std::chrono::steady_clock::now();
        }

        auto stroked = createStrokeMask(cached.fillMask, strokeWidth);
        if (!stroked) return std::nullopt;

        if (telemetryEnabled) {
          const auto t1 = std::chrono::steady_clock::now();
          stats.strokeBuildUs += std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count();
        }

        cached.strokeMasks.push_back(StrokeMaskEntry{strokeWidth, std::move(*stroked)});
        resultMask = &cached.strokeMasks.back().mask;
      }
    }

    const std::size_t bytesAfter = cached.byteSize();
    if (bytesAfter > bytesBefore) {
      currentGlyphBytes += (bytesAfter - bytesBefore);
      enforceLimits(&key);
    }

    GlyphRenderItem item;
    item.mask = resultMask;
    return item;
  }

  struct TextLayout {
    ShapedText shaped;
    CanvasTextMetrics metrics;
  };

  struct LayoutKey {
    std::vector<FontStrikeId> strikes;
    int pixelSize;
    std::vector<std::uint32_t> text;
    bool operator==(const LayoutKey&) const = default;
  };
  std::optional<LayoutKey> recentLayoutKey;
  std::shared_ptr<const TextLayout> recentLayout;

  std::shared_ptr<const TextLayout> layoutText(
      const std::vector<std::filesystem::path>& paths,
      const std::string& text, int pixelSize) {
    ++stats.layoutRequests;
    std::vector<TextFont> available;
    LayoutKey key{{}, pixelSize, prepareCanvasText(text)};
    for (const auto& path : paths) {
      if (auto* strike = getStrike(path, pixelSize)) {
        available.push_back({strike->id, strike->shapingFont});
        key.strikes.push_back(strike->id);
      }
    }
    if (available.empty()) return nullptr;
    if (recentLayoutKey && *recentLayoutKey == key) {
      ++stats.layoutCacheHits;
      return recentLayout;
    }
    // A miss replaces the recent request even when the new string is too long to retain.
    recentLayout.reset();
    recentLayoutKey.reset();
    stats.layoutCacheBytes = 0;
    auto result = std::make_shared<TextLayout>();
    auto& layout = *result;
    ++stats.shapeTextCalls;
    std::chrono::steady_clock::time_point shapeStart;
    if (telemetryEnabled) shapeStart = std::chrono::steady_clock::now();
    layout.shaped = shapeText(key.text, available, stats.fallbackShapeCalls);
    if (telemetryEnabled) {
      stats.shapeTextUs += std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::steady_clock::now() - shapeStart).count();
    }
    layout.metrics.width = layout.shaped.advanceX;
    if (layout.shaped.glyphs.empty()) {
      const auto face = strikes[available.front().strikeId]->face;
      layout.metrics.fontAscent = static_cast<int>(face->size->metrics.ascender >> 6);
      layout.metrics.fontDescent = -static_cast<int>(face->size->metrics.descender >> 6);
    }
    double penX = 0;
    double penY = 0;
    int minimumX = 0;
    int maximumX = 0;
    bool hasInk = false;
    for (const auto& glyph : layout.shaped.glyphs) {
      auto* strike = strikes[glyph.strikeId].get();
      layout.metrics.fontAscent = std::max<double>(layout.metrics.fontAscent,
        static_cast<int>(strike->face->size->metrics.ascender >> 6));
      layout.metrics.fontDescent = std::max<double>(layout.metrics.fontDescent,
        -static_cast<int>(strike->face->size->metrics.descender >> 6));
      const auto* metrics = getOrLoadMetrics(strike, glyph.glyphIndex);
      if (!metrics) return nullptr;
      if (metrics->metricWidth > 0 && metrics->metricHeight > 0) {
        const int left = static_cast<int>(std::lround(penX + glyph.xOffset)) + metrics->bearingX;
        const int top = static_cast<int>(std::lround(penY + glyph.yOffset)) + metrics->bearingY;
        minimumX = hasInk ? std::min(minimumX, left) : left;
        maximumX = hasInk ? std::max(maximumX, left + metrics->metricWidth) :
                           left + metrics->metricWidth;
        layout.metrics.actualAscent = hasInk ? std::max<double>(layout.metrics.actualAscent, top) : top;
        layout.metrics.actualDescent = hasInk ?
          std::max<double>(layout.metrics.actualDescent, metrics->metricHeight - top) :
          metrics->metricHeight - top;
        hasInk = true;
      }
      penX += glyph.xAdvance;
      penY += glyph.yAdvance;
    }
    layout.metrics.actualLeft = -minimumX;
    layout.metrics.actualRight = maximumX;
    constexpr std::size_t maxRecentLayoutBytes = 32 * 1024;
    const auto retainedBytes = sizeof(LayoutKey) + sizeof(TextLayout) +
        key.strikes.capacity() * sizeof(FontStrikeId) +
        key.text.capacity() * sizeof(std::uint32_t) +
        layout.shaped.glyphs.capacity() * sizeof(ShapedGlyph);
    if (retainedBytes <= maxRecentLayoutBytes) {
      stats.layoutCacheBytes = retainedBytes;
      recentLayoutKey = std::move(key);
      recentLayout = result;
    }
    return result;
  }

  void recordBlendUs(std::uint64_t us) {
    stats.glyphBlendUs += us;
  }

  CanvasTextStats getStats() const {
    CanvasTextStats s = stats;
    std::unordered_set<std::string> uniquePaths;
    for (const auto& strike : strikes) {
      if (strike) uniquePaths.insert(strike->path.string());
    }
    s.fontFaces = uniquePaths.size();
    s.fontStrikes = strikes.size();
    s.glyphEntries = glyphCache.size();
    s.glyphBytes = currentGlyphBytes;
    s.maxGlyphBytes = maxGlyphBytes;
    s.maxGlyphEntries = maxGlyphEntries;
    return s;
  }

  void setLimits(std::size_t maxBytes, std::size_t maxEntries) {
    maxGlyphBytes = std::max<std::size_t>(1024, maxBytes);
    maxGlyphEntries = std::max<std::size_t>(1, maxEntries);
    enforceLimits();
  }

  void reportTelemetry(bool force = false) {
    const auto now = std::chrono::steady_clock::now();
    const double elapsed = std::chrono::duration<double>(now - lastTelemetryReport).count();
    if (!force && elapsed < 1.0) return;

    const auto s = getStats();
    const uint64_t totalMetricReqs = s.glyphMetricHits + s.glyphMetricMisses;
    const double metricHitRate = totalMetricReqs > 0
      ? (100.0 * static_cast<double>(s.glyphMetricHits) / static_cast<double>(totalMetricReqs))
      : 100.0;

    const uint64_t totalMaskReqs = s.glyphMaskHits + s.glyphMaskMisses;
    const double maskHitRate = totalMaskReqs > 0
      ? (100.0 * static_cast<double>(s.glyphMaskHits) / static_cast<double>(totalMaskReqs))
      : 100.0;

    Log(LogLevel::Info) << "[pmjs-font] {"
      << "\"faces\":" << s.fontFaces
      << ",\"strikes\":" << s.fontStrikes
      << ",\"glyphs\":" << s.glyphEntries
      << ",\"bytes\":" << s.glyphBytes
      << ",\"metricHitRate\":" << metricHitRate
      << ",\"maskHitRate\":" << maskHitRate
      << ",\"metricHits\":" << s.glyphMetricHits
      << ",\"metricMisses\":" << s.glyphMetricMisses
      << ",\"maskHits\":" << s.glyphMaskHits
      << ",\"maskMisses\":" << s.glyphMaskMisses
      << ",\"strokeHits\":" << s.strokeMaskHits
      << ",\"strokeMisses\":" << s.strokeMaskMisses
      << ",\"evictions\":" << s.glyphEvictions
      << ",\"loadUs\":" << s.freetypeLoadUs
      << ",\"renderUs\":" << s.freetypeRenderUs
      << ",\"strokeUs\":" << s.strokeBuildUs
      << ",\"blendUs\":" << s.glyphBlendUs
      << ",\"layoutRequests\":" << s.layoutRequests
      << ",\"layoutCacheHits\":" << s.layoutCacheHits
      << ",\"shapeTextCalls\":" << s.shapeTextCalls
      << ",\"shapeTextUs\":" << s.shapeTextUs
      << ",\"fallbackShapeCalls\":" << s.fallbackShapeCalls
      << ",\"layoutCacheBytes\":" << s.layoutCacheBytes
      << "}\n";

    lastTelemetryReport = now;
  }

  void maybeReportTelemetry() {
    if (telemetryEnabled) {
      reportTelemetry(false);
    }
  }
};

CanvasStore::CanvasStore(ImageStore& images)
    : images_(images), fonts_(std::make_unique<FontState>()) {
  if (textBackend_.skia()) fonts_->telemetryEnabled = false;
}

CanvasStore::~CanvasStore() {
  for (auto& surface : surfaces_) {
    if (surface.image) images_.release(surface.image);
  }
}

CanvasStore::Content::Content(CanvasStore& store) : owner(store) {
  owner.contents_.insert(this);
}

CanvasStore::Content::~Content() {
  owner.discardCommands(*this);
  owner.contents_.erase(this);
  owner.pixelBytes_ -= pixels.size();
}

void CanvasStore::Content::setPixels(std::vector<std::uint8_t> value) {
  owner.pixelBytes_ -= pixels.size();
  pixels = std::move(value);
  owner.pixelBytes_ += pixels.size();
}

std::vector<std::uint8_t> CanvasStore::Content::takePixels() {
  owner.pixelBytes_ -= pixels.size();
  return std::exchange(pixels, {});
}

void CanvasStore::retainSnapshot(const CanvasCommand& command) {
  if (const auto* draw = std::get_if<DrawImageCmd>(&command); draw && draw->snapshot)
    ++snapshots_[draw->snapshot.get()];
}

void CanvasStore::releaseCommandDependencies(CanvasCommand& cmd) {
  std::visit([this](auto& c) {
    using T = std::decay_t<decltype(c)>;
    if constexpr (std::is_same_v<T, DrawImageCmd>) {
      if (c.snapshot) {
        auto found = snapshots_.find(c.snapshot.get());
        if (--found->second == 0) snapshots_.erase(found);
      }
      if (c.source != 0) {
        images_.release(c.source);
        c.source = 0;
      }
    }
  }, cmd);
}

void CanvasStore::discardCommands(Content& surface) {
  for (auto& cmd : surface.commands) {
    releaseCommandDependencies(cmd);
  }
  surface.commands.clear();
  surface.queuedCommandBytes = 0;
  surface.dependencyDepth = 0;
}

void CanvasStore::fillRectNow(Content& surface, int x, int y, int width, int height,
                              std::uint32_t rgba) {
  const int x0 = std::clamp(x, 0, surface.width);
  const int y0 = std::clamp(y, 0, surface.height);
  const int x1 = static_cast<int>(std::clamp<std::int64_t>(
    static_cast<std::int64_t>(x) + width, 0, surface.width));
  const int y1 = static_cast<int>(std::clamp<std::int64_t>(
    static_cast<std::int64_t>(y) + height, 0, surface.height));
  if (!(rgba & 255)) return;
  if ((rgba & 255) == 255) {
    const std::array<std::uint8_t, 4> pixel = {
      static_cast<std::uint8_t>(rgba >> 8), static_cast<std::uint8_t>(rgba >> 16),
      static_cast<std::uint8_t>(rgba >> 24), 255};
    for (int py = y0; py < y1; ++py) {
      auto* row = surface.pixels.data() +
        (static_cast<std::size_t>(py) * surface.width + x0) * 4;
      for (int px = x0; px < x1; ++px, row += 4) {
        std::memcpy(row, pixel.data(), pixel.size());
      }
    }
  } else {
    for (int py = y0; py < y1; ++py) {
      for (int px = x0; px < x1; ++px) {
        blendPixel(surface, px, py, rgba, 255);
      }
    }
  }
  markDirty(surface, x0, y0, x1 - x0, y1 - y0);
}

void CanvasStore::clearNow(Content& surface, ImageHandle image,
                            std::optional<std::uint64_t> imageRevision) {
  clearRectNow(surface, 0, 0, surface.width, surface.height, image, imageRevision);
  surface.mayHaveOverAlpha = false;
}

void CanvasStore::clearRectNow(Content& surface, int x, int y, int width, int height,
                               ImageHandle image,
                               std::optional<std::uint64_t> imageRevision) {
  const int x0 = std::clamp(x, 0, surface.width);
  const int y0 = std::clamp(y, 0, surface.height);
  const int x1 = static_cast<int>(std::clamp<std::int64_t>(
    static_cast<std::int64_t>(x) + width, 0, surface.width));
  const int y1 = static_cast<int>(std::clamp<std::int64_t>(
    static_cast<std::int64_t>(y) + height, 0, surface.height));
  if (x1 <= x0 || y1 <= y0) return;
  const bool allZero = surface.knownAllZero ||
    (x0 == 0 && y0 == 0 && x1 == surface.width && y1 == surface.height);
  int left = x1, top = y1, right = x0, bottom = y0;
  for (int py = y0; !surface.knownAllZero && py < y1; ++py) {
    auto* first = surface.pixels.data() +
      (static_cast<std::size_t>(py) * surface.width + x0) * 4U;
    auto* last = first + static_cast<std::size_t>(x1 - x0) * 4U;
    auto* changedFirst = std::find_if(first, last,
      [](std::uint8_t value) { return value != 0; });
    if (changedFirst == last) continue;
    auto* changedLast = last;
    while (changedLast[-1] == 0) --changedLast;
    left = std::min(left, x0 + static_cast<int>((changedFirst - first) / 4));
    right = std::max(right, x0 + static_cast<int>((changedLast - first + 3) / 4));
    top = std::min(top, py);
    bottom = py + 1;
    std::fill(changedFirst, changedLast, 0);
  }
  // Only bound damage when the texture still matches the last Canvas upload.
  if (image) {
    const auto revision = images_.contentRevision(image);
    if (!revision || revision != imageRevision) {
      left = x0; top = y0; right = x1; bottom = y1;
    }
  }
  if (right > left && bottom > top) markDirty(surface, left, top, right - left, bottom - top);
  surface.knownAllZero = allZero;
}

bool CanvasStore::drawImageNow(Content& destinationSurface, const DrawImageCmd& command) {
  auto [source, canvas, snapshot, sourceX, sourceY, sourceWidth, sourceHeight,
               destinationX, destinationY, destinationWidth, destinationHeight, alpha, smoothing] = command;
  if (alpha == 0) return true;
  const bool destinationKnownAllZero = destinationSurface.knownAllZero;
  destinationSurface.knownAllZero = false;
  struct SourcePixels {
    int width;
    int height;
    const std::uint8_t* rgba;
    PixelEncoding encoding;
    bool mayHaveOverAlpha;
  } sourcePixels{};
  std::optional<ImagePixels> regionPixels;
  std::optional<Content> croppedSource;
  if (snapshot && snapshot->pixels) {
    const auto& pixels = *snapshot->pixels;
    sourceX -= snapshot->x; sourceY -= snapshot->y;
    sourcePixels = {pixels.width, pixels.height, pixels.rgba.data(),
      snapshot->premultiplied ? PixelEncoding::PremultipliedRGBA8 : PixelEncoding::StraightRGBA8, false};
  } else if (canvas) {
    // Realize only the sampled region of an untouched image-backed Canvas.
    // Keep the intermediate BGRA conversion before the destination blend.
    if (canvas->state == ContentState::Deferred && !canvas->opaque && canvas->commands.size() == 1 &&
        alpha == 1 && sourceWidth == destinationWidth && sourceHeight == destinationHeight &&
        static_cast<double>(sourceWidth + 2) * (sourceHeight + 2) <= static_cast<double>(canvas->width) * canvas->height / 4 &&
        sourceX >= 0 && sourceY >= 0 && sourceX + sourceWidth <= canvas->width && sourceY + sourceHeight <= canvas->height &&
        sourceX == std::floor(sourceX) && sourceY == std::floor(sourceY) &&
        sourceWidth == std::floor(sourceWidth) && sourceHeight == std::floor(sourceHeight) &&
        destinationX == std::floor(destinationX) && destinationY == std::floor(destinationY)) {
      const auto* view = std::get_if<DrawImageCmd>(&canvas->commands.front());
      const auto info = view && view->source ? images_.inspect(view->source) : std::nullopt;
      if (info && !view->canvas && view->alpha == 1 && view->sourceX == 0 && view->sourceY == 0 &&
          view->destinationX == 0 && view->destinationY == 0 &&
          view->sourceWidth == canvas->width && view->sourceHeight == canvas->height &&
          view->destinationWidth == canvas->width && view->destinationHeight == canvas->height &&
          info->width == canvas->width && info->height == canvas->height) {
        const int left = std::max(0, static_cast<int>(sourceX) - 1);
        const int top = std::max(0, static_cast<int>(sourceY) - 1);
        const int width = std::min(canvas->width, static_cast<int>(sourceX + sourceWidth) + 1) - left;
        const int height = std::min(canvas->height, static_cast<int>(sourceY + sourceHeight) + 1) - top;
        auto& crop = croppedSource.emplace(*this);
        crop.width = width; crop.height = height; crop.state = ContentState::Realizing;
        crop.setPixels(std::vector<std::uint8_t>(static_cast<size_t>(width) * height * 4, 0));
        auto read = *view;
        read.sourceX = left; read.sourceY = top; read.sourceWidth = width; read.sourceHeight = height;
        read.destinationX = read.destinationY = 0; read.destinationWidth = width; read.destinationHeight = height;
        if (!drawImageNow(crop, read)) return false;
        sourceX -= left; sourceY -= top;
        sourcePixels = {width, height, crop.pixels.data(), PixelEncoding::PremultipliedBGRA8, crop.mayHaveOverAlpha};
        ++imageViewRegionReads_;
      }
    }
    if (!sourcePixels.rgba) {
      if (!realizeContent(*canvas)) return false;
      sourcePixels = {canvas->width, canvas->height, canvas->pixels.data(), PixelEncoding::PremultipliedBGRA8, canvas->mayHaveOverAlpha};
    }
  } else {
    const auto* decoded = images_.hasPreparedBacking(source) ? nullptr : images_.readPixels(source);
    if (!decoded) {
      const auto logical = images_.inspect(source);
      if (!logical) return false;
      const int rx = static_cast<int>(std::floor(std::clamp(static_cast<double>(sourceX)-1, 0.0, static_cast<double>(logical->width))));
      const int ry = static_cast<int>(std::floor(std::clamp(static_cast<double>(sourceY)-1, 0.0, static_cast<double>(logical->height))));
      const int right = static_cast<int>(std::ceil(std::clamp(static_cast<double>(sourceX)+sourceWidth+1, 0.0, static_cast<double>(logical->width))));
      const int bottom = static_cast<int>(std::ceil(std::clamp(static_cast<double>(sourceY)+sourceHeight+1, 0.0, static_cast<double>(logical->height))));
      if (right <= rx || bottom <= ry) return true;
      regionPixels = images_.readPixelsRegion(source, rx, ry, right-rx, bottom-ry);
      if (!regionPixels) return false;
      sourceX -= rx; sourceY -= ry; decoded = &*regionPixels;
    }
    const auto logical = images_.inspect(source);
    sourcePixels = {decoded->width, decoded->height, decoded->rgba.data(),
      logical && logical->premultiplied ? PixelEncoding::PremultipliedRGBA8 : PixelEncoding::StraightRGBA8, false};
  }
  if (sourceX >= sourcePixels.width || sourceY >= sourcePixels.height) return true;
  const std::array<float, 8> geometry = {sourceX, sourceY, sourceWidth, sourceHeight,
    destinationX, destinationY, destinationWidth, destinationHeight};
  if (alpha == 1 && sourceWidth == destinationWidth && sourceHeight == destinationHeight &&
      sourceX >= 0 && sourceY >= 0 && destinationX >= 0 && destinationY >= 0 &&
      sourceX + sourceWidth <= sourcePixels.width && sourceY + sourceHeight <= sourcePixels.height &&
      destinationX + destinationWidth <= destinationSurface.width &&
      destinationY + destinationHeight <= destinationSurface.height &&
      std::all_of(geometry.begin(), geometry.end(), [](float value) { return value == std::floor(value); })) {
    bool transparent = true;
    for (int y = 0; !destinationKnownAllZero && y < destinationHeight && transparent; ++y) for (int x = 0; x < destinationWidth; ++x) {
      const size_t index = ((static_cast<size_t>(destinationY) + static_cast<size_t>(y)) * destinationSurface.width +
                            static_cast<size_t>(destinationX) + static_cast<size_t>(x)) * 4;
      uint32_t pixel;
      std::memcpy(&pixel, destinationSurface.pixels.data() + index, sizeof(pixel));
      if (pixel) { transparent = false; break; }
    }
    // The rasterizer treats alpha-zero RGB differently in scalar and vector
    // source-over batches. Keep such raw pixels on its drawing path.
    if (transparent && sourcePixels.mayHaveOverAlpha) {
      for (int y = 0; y < destinationHeight && transparent; ++y) {
        const auto* row = sourcePixels.rgba + (static_cast<size_t>(sourceY + y) * sourcePixels.width + static_cast<size_t>(sourceX)) * 4;
        for (int x = 0; x < destinationWidth; ++x) {
          uint32_t pixel;
          std::memcpy(&pixel, row + x * 4, sizeof(pixel));
          if (pixel && !(pixel & 0xff000000U)) { transparent = false; break; }
        }
      }
    }
    if (transparent) {
      for (int y = 0; y < destinationHeight; ++y) {
        const auto* row = sourcePixels.rgba + (static_cast<size_t>(sourceY + y) * sourcePixels.width + static_cast<size_t>(sourceX)) * 4;
        auto* target = destinationSurface.pixels.data() +
          (static_cast<size_t>(destinationY + y) * destinationSurface.width + static_cast<size_t>(destinationX)) * 4;
        if (sourcePixels.encoding == PixelEncoding::PremultipliedBGRA8) {
          std::memcpy(target, row, static_cast<size_t>(destinationWidth) * 4);
        } else for (int x = 0; x < destinationWidth; ++x)
          convertPixel(row + x * 4, sourcePixels.encoding, target + x * 4, PixelEncoding::PremultipliedBGRA8);
      }
      destinationSurface.mayHaveOverAlpha |= sourcePixels.mayHaveOverAlpha;
      markDirty(destinationSurface, destinationX, destinationY, destinationWidth, destinationHeight);
      return true;
    }
  }

#ifdef PMJS_HAS_SKIA65
  const std::array<float, 4> src = {sourceX, sourceY, sourceWidth, sourceHeight};
  const std::array<float, 4> dst = {destinationX, destinationY, destinationWidth, destinationHeight};
  const auto region = rasterCanvasRegion(destinationSurface.pixels, destinationSurface.width,
    destinationSurface.height, dst, [&](uint8_t* pixels, int width, int height, size_t stride, int left, int top) {
      const auto draw = sourcePixels.encoding == PixelEncoding::PremultipliedBGRA8 ?
        pmjs_skia65_image_bgra_strided : sourcePixels.encoding == PixelEncoding::PremultipliedRGBA8 ?
        pmjs_skia65_image_premul_rgba_strided : pmjs_skia65_image_rgba_strided;
      return draw(pixels, width, height, stride, left, top, sourcePixels.rgba,
        sourcePixels.width, sourcePixels.height, static_cast<size_t>(sourcePixels.width) * 4,
        src.data(), dst.data(), alpha, smoothing);
    });
  destinationSurface.mayHaveOverAlpha |= sourcePixels.mayHaveOverAlpha;
  markDirty(destinationSurface, region[0], region[1], region[2], region[3]);
  return true;
#else
  (void)smoothing;
  const auto coverage = static_cast<std::uint8_t>(std::clamp(
      static_cast<int>(alpha * 255.0F + 0.5F), 0, 255));
  for (int y = 0; y < destinationHeight; ++y) {
    const int targetY = destinationY + y;
    if (targetY < 0 || targetY >= destinationSurface.height) continue;
    const int sampleY = sourceY + y * sourceHeight / destinationHeight;
    if (sampleY < 0 || sampleY >= sourcePixels.height) continue;
    for (int x = 0; x < destinationWidth; ++x) {
      const int targetX = destinationX + x;
      if (targetX < 0 || targetX >= destinationSurface.width) continue;
      const int sampleX = sourceX + x * sourceWidth / destinationWidth;
      if (sampleX < 0 || sampleX >= sourcePixels.width) continue;
      const std::size_t offset =
        (static_cast<std::size_t>(sampleY) * sourcePixels.width + sampleX) * 4U;
      uint8_t premul[4];
      convertPixel(sourcePixels.rgba + offset, sourcePixels.encoding, premul, PixelEncoding::PremultipliedBGRA8);
      if (!premul[3]) continue;
      auto* target = destinationSurface.pixels.data() +
        (static_cast<size_t>(targetY) * destinationSurface.width + targetX) * 4;
      compositeCanvasPixel(target, {double(importCanvasChannel(premul[2], coverage)),
        double(importCanvasChannel(premul[1], coverage)), double(importCanvasChannel(premul[0], coverage)),
        double(importCanvasChannel(premul[3], coverage))}, CanvasComposite::sourceOver, true);
    }
  }
  destinationSurface.mayHaveOverAlpha |= sourcePixels.mayHaveOverAlpha;
  markDirty(destinationSurface, destinationX, destinationY,
            destinationWidth, destinationHeight);
  return true;
#endif
}

bool CanvasStore::drawTextNow(Content& surface, const std::vector<std::filesystem::path>& fontPaths,
                              const std::string& text, float x, float y, float pixelSize,
                              std::uint32_t rgba, float strokeWidth, const CanvasTextStyle& style) {
  surface.knownAllZero = false;
  if (textBackend_.skia()) {
    int bounds[4];
    if (!textBackend_.draw(fontPaths, text, x, y, pixelSize, rgba, strokeWidth, style,
        surface.pixels, surface.width, surface.height, bounds)) return false;
    if (bounds[2] > bounds[0] && bounds[3] > bounds[1])
      markDirty(surface, bounds[0], bounds[1], bounds[2] - bounds[0], bounds[3] - bounds[1]);
    return true;
  }
  // The legacy web facade rounded font sizes/positions/widths before this
  // integer backend. MV's shortcut also rounded its outline before the helper
  // floored it. Preserve those effective contracts explicitly at this boundary.
  if (double(pixelSize) + 0.5 >= std::numeric_limits<int>::max() ||
      double(strokeWidth) + 0.5 >= std::numeric_limits<int>::max()) return false;
  const int legacySize = static_cast<int>(std::floor(double(pixelSize) + 0.5));
  const int legacyStroke = static_cast<int>(std::floor(double(strokeWidth) + 0.5));
  const int legacyX = static_cast<int>(std::clamp(std::floor(x + 0.5f), -1000000000.0f, 1000000000.0f));
  const int legacyY = static_cast<int>(std::clamp(std::floor(y + 0.5f), -1000000000.0f, 1000000000.0f));
  auto layout = fonts_->layoutText(fontPaths, text, legacySize);
  if (!layout) return false;
  double penX = 0;
  double penY = 0;
  std::uint64_t blendUs = 0;
  int dirtyLeft = surface.width;
  int dirtyTop = surface.height;
  int dirtyRight = 0;
  int dirtyBottom = 0;
  bool complete = true;

  for (const auto& glyph : layout->shaped.glyphs) {
    const auto item = fonts_->getOrLoadMask(fonts_->strikes[glyph.strikeId].get(),
                                           glyph.glyphIndex, legacyStroke);
    if (!item) {
      complete = false;
      break;
    }

    const auto* mask = item->mask;
    if (mask && mask->width > 0 && mask->height > 0 && !mask->coverage.empty()) {
      const int originX = legacyX + static_cast<int>(std::lround(penX + glyph.xOffset)) + mask->bitmapLeft;
      const int originY = legacyY - static_cast<int>(std::lround(penY + glyph.yOffset)) - mask->bitmapTop;
      dirtyLeft = std::min(dirtyLeft, originX);
      dirtyTop = std::min(dirtyTop, originY);
      dirtyRight = std::max(dirtyRight, originX + mask->width);
      dirtyBottom = std::max(dirtyBottom, originY + mask->height);

      std::chrono::steady_clock::time_point b0;
      if (fonts_->telemetryEnabled) {
        b0 = std::chrono::steady_clock::now();
      }

      for (int row = 0; row < mask->height; ++row) {
        const int destY = originY + row;
        if (destY < 0 || destY >= surface.height) continue;
        const std::size_t rowOffset = static_cast<std::size_t>(row) * mask->width;
        for (int col = 0; col < mask->width; ++col) {
          const auto cov = mask->coverage[rowOffset + col];
          if (cov == 0) continue;
          blendPixel(surface, originX + col, destY, rgba, cov);
        }
      }

      if (fonts_->telemetryEnabled) {
        const auto b1 = std::chrono::steady_clock::now();
        blendUs += std::chrono::duration_cast<std::chrono::microseconds>(b1 - b0).count();
      }
    }
    penX += glyph.xAdvance;
    penY += glyph.yAdvance;
  }

  if (fonts_->telemetryEnabled && blendUs > 0) {
    fonts_->recordBlendUs(blendUs);
  }

  if (dirtyRight > dirtyLeft && dirtyBottom > dirtyTop) {
    markDirty(surface, dirtyLeft, dirtyTop, dirtyRight - dirtyLeft, dirtyBottom - dirtyTop);
  }

  fonts_->maybeReportTelemetry();
  return complete;
}

bool CanvasStore::blurNow(Content& surface) {
  const int width = surface.width;
  const int height = surface.height;
  std::vector<std::uint8_t> straight(surface.pixels.size());
  for (size_t i = 0; i < straight.size(); i += 4)
    convertPixel(surface.pixels.data() + i, PixelEncoding::PremultipliedBGRA8,
                 straight.data() + i, PixelEncoding::StraightRGBA8);
  std::vector<std::uint8_t> scratch(surface.pixels.size());
  constexpr int weights[5] = {1, 4, 6, 4, 1};
  for (int pass = 0; pass < 2; ++pass) {
    const auto& source = pass == 0 ? straight : scratch;
    auto& destination = pass == 0 ? scratch : straight;
    for (int y = 0; y < height; ++y) {
      for (int x = 0; x < width; ++x) {
        for (int channel = 0; channel < 4; ++channel) {
          int sum = 0;
          for (int offset = -2; offset <= 2; ++offset) {
            const int sampleX = pass == 0 ? std::clamp(x + offset, 0, width - 1) : x;
            const int sampleY = pass == 0 ? y : std::clamp(y + offset, 0, height - 1);
            const std::size_t index =
              (static_cast<std::size_t>(sampleY) * width + sampleX) * 4U + channel;
            sum += source[index] * weights[offset + 2];
          }
          destination[(static_cast<std::size_t>(y) * width + x) * 4U + channel] =
            static_cast<std::uint8_t>((sum + 8) / 16);
        }
      }
    }
  }
  for (size_t i = 0; i < straight.size(); i += 4)
    convertPixel(straight.data() + i, PixelEncoding::StraightRGBA8,
                 surface.pixels.data() + i, PixelEncoding::PremultipliedBGRA8);
  surface.mayHaveOverAlpha = false;
  markDirty(surface, 0, 0, width, height);
  return true;
}

bool CanvasStore::realizeContent(Content& surface) {
  if (surface.state == ContentState::Realized) return true;
  if (surface.state == ContentState::Realizing) return false;

  // Publish CPU content only after every command succeeds. Pending commands
  // keep their image references on failure, so replay can be retried safely.
  Content prepared(*this);
  prepared.width = surface.width;
  prepared.height = surface.height;
  prepared.opaque = surface.opaque;
  prepared.state = ContentState::Realizing;
  surface.state = ContentState::Realizing;
  try {
    prepared.setPixels(std::vector<std::uint8_t>(static_cast<std::size_t>(surface.width) *
                             static_cast<std::size_t>(surface.height) * 4U, 0));
    if (prepared.opaque) for (size_t i = 3; i < prepared.pixels.size(); i += 4) prepared.pixels[i] = 255;
    prepared.knownAllZero = !prepared.opaque;
    for (const auto& cmd : surface.commands) {
      const bool ok = std::visit([this, &prepared](const auto& c) -> bool {
        using T = std::decay_t<decltype(c)>;
        if constexpr (std::is_same_v<T, FillRectCmd>) {
          fillRectNow(prepared, c.x, c.y, c.width, c.height, c.rgba);
          return true;
        } else if constexpr (std::is_same_v<T, ClearRectCmd>) {
          clearRectNow(prepared, c.x, c.y, c.width, c.height);
          return true;
        } else if constexpr (std::is_same_v<T, DrawImageCmd>) {
          return drawImageNow(prepared, c);
        } else if constexpr (std::is_same_v<T, DrawTextCmd>) {
          return drawTextNow(prepared, c.fontPaths, c.text, c.x, c.y,
                             c.pixelSize, c.rgba, c.strokeWidth, c.style);
        } else if constexpr (std::is_same_v<T, BlurCmd>) {
          return blurNow(prepared);
        }
      }, cmd);
      if (!ok) {
        surface.state = ContentState::Deferred;
        return false;
      }
    }
  } catch (...) {
    surface.state = ContentState::Deferred;
    throw;
  }

  surface.setPixels(prepared.takePixels());
  surface.mayHaveOverAlpha = prepared.mayHaveOverAlpha;
  surface.knownAllZero = prepared.knownAllZero;
  surface.state = ContentState::Realized;
  discardCommands(surface);
  surface.dirtyX0 = surface.dirtyY0 = 0;
  surface.dirtyX1 = surface.dirtyY1 = 0;
  peakCpuBytes_ = std::max(peakCpuBytes_, cpuBytes());
  return true;
}

bool CanvasStore::realize(CanvasHandle handle) {
  auto* surface = lookupContent(handle);
  return surface && realizeContent(*surface);
}

std::optional<ImageHandle> CanvasStore::prepareImage(CanvasHandle handle) {
  auto* surface = lookup(handle);
  if (!surface || !realizeContent(*surface->content) || !uploadSurface(*surface)) {
    return std::nullopt;
  }
  return surface->image;
}

std::optional<std::vector<std::uint8_t>> CanvasStore::encodePng(
    CanvasHandle handle) {
  auto* surface = lookupContent(handle);
  if (!surface) return std::nullopt;
  if (surface->state == ContentState::Deferred && !realizeContent(*surface)) {
    return std::nullopt;
  }
  const auto straight = readPixels(handle, 0, 0, surface->width, surface->height);
  if (!straight) return std::nullopt;
  png_image image{};
  image.version = PNG_IMAGE_VERSION;
  image.width = static_cast<png_uint_32>(surface->width);
  image.height = static_cast<png_uint_32>(surface->height);
  image.format = PNG_FORMAT_RGBA;
  png_alloc_size_t size = 0;
  if (!png_image_write_to_memory(&image, nullptr, &size, 0,
                                 straight->rgba.data(), 0, nullptr)) {
    png_image_free(&image);
    return std::nullopt;
  }
  std::vector<std::uint8_t> encoded(static_cast<std::size_t>(size));
  if (!png_image_write_to_memory(&image, encoded.data(), &size, 0,
                                 straight->rgba.data(), 0, nullptr)) {
    png_image_free(&image);
    return std::nullopt;
  }
  png_image_free(&image);
  encoded.resize(static_cast<std::size_t>(size));
  return encoded;
}

std::optional<std::vector<std::uint8_t>> CanvasStore::encodeWebP(
    CanvasHandle handle, std::optional<double> quality) {
  if (quality && (!std::isfinite(*quality) || *quality < 0 || *quality > 1)) return std::nullopt;
  auto* surface = lookupContent(handle);
  if (!surface) return std::nullopt;
  if (surface->state == ContentState::Deferred && !realizeContent(*surface)) {
    return std::nullopt;
  }
  const auto straight = readPixels(handle, 0, 0, surface->width, surface->height);
  if (!straight) return std::nullopt;
  std::uint8_t* output = nullptr;
  const std::size_t size = quality && *quality != 1 ? WebPEncodeRGBA(straight->rgba.data(), surface->width,
      surface->height, surface->width * 4, *quality * 100, &output) :
    WebPEncodeLosslessRGBA(straight->rgba.data(), surface->width, surface->height, surface->width * 4, &output);
  if (size == 0 || !output) return std::nullopt;
  std::vector<std::uint8_t> encoded(output, output + size);
  WebPFree(output);
  return encoded;
}

std::optional<std::vector<std::uint8_t>> CanvasStore::encodeJpeg(CanvasHandle handle, double quality) {
  auto* surface = lookupContent(handle);
  if (!surface || !std::isfinite(quality) || quality < 0 || quality > 1) return std::nullopt;
  const auto pixels = readPixels(handle, 0, 0, surface->width, surface->height, PixelEncoding::PremultipliedRGBA8);
  if (!pixels) return std::nullopt;
  std::vector<uint8_t> rgb(size_t(surface->width) * surface->height * 3);
  for (size_t i = 0; i < rgb.size() / 3; ++i) std::copy_n(pixels->rgba.data() + i * 4, 3, rgb.data() + i * 3);
  struct Error {
    jpeg_error_mgr base;
    std::jmp_buf jump;
  } error{};
  jpeg_compress_struct encoder{};
  encoder.err = jpeg_std_error(&error.base);
  error.base.error_exit = [](j_common_ptr state) {
    auto* failure = reinterpret_cast<Error*>(state->err);
    std::longjmp(failure->jump, 1);
  };
  unsigned char* output = nullptr;
  unsigned long size = 0;
  if (setjmp(error.jump)) {
    jpeg_destroy_compress(&encoder); std::free(output); return std::nullopt;
  }
  jpeg_create_compress(&encoder);
  jpeg_mem_dest(&encoder, &output, &size);
  encoder.image_width = surface->width; encoder.image_height = surface->height;
  encoder.input_components = 3; encoder.in_color_space = JCS_RGB;
  const int compressionQuality = std::round(quality * 100);
  jpeg_set_defaults(&encoder); jpeg_set_quality(&encoder, compressionQuality, TRUE);
  if (compressionQuality == 100) for (int component = 0; component < encoder.num_components; ++component) {
    encoder.comp_info[component].h_samp_factor = 1;
    encoder.comp_info[component].v_samp_factor = 1;
  }
  jpeg_start_compress(&encoder, TRUE);
  while (encoder.next_scanline < encoder.image_height) {
    JSAMPROW row = rgb.data() + size_t(encoder.next_scanline) * surface->width * 3;
    jpeg_write_scanlines(&encoder, &row, 1);
  }
  jpeg_finish_compress(&encoder);
  std::vector<uint8_t> encoded(output, output + size);
  jpeg_destroy_compress(&encoder); std::free(output);
  return encoded;
}

CanvasHandle CanvasStore::makeHandle(std::size_t index, std::uint16_t generation) {
  return canvasHandleTag |
         (static_cast<std::uint32_t>(generation & generationMask) << 16U) |
         static_cast<std::uint32_t>(index + 1U);
}

CanvasStore::Surface* CanvasStore::lookup(CanvasHandle handle) {
  return const_cast<Surface*>(std::as_const(*this).lookup(handle));
}

const CanvasStore::Surface* CanvasStore::lookup(CanvasHandle handle) const {
  if ((handle & canvasHandleTag) == 0) return nullptr;
  const std::uint32_t encodedIndex = handle & indexMask;
  if (encodedIndex == 0) return nullptr;
  const std::size_t index = encodedIndex - 1U;
  const auto generation = static_cast<std::uint16_t>((handle >> 16U) & generationMask);
  if (index >= surfaces_.size()) return nullptr;
  const auto& surface = surfaces_[index];
  return surface.live && surface.generation == generation ? &surface : nullptr;
}

CanvasStore::Content* CanvasStore::lookupContent(CanvasHandle handle) const {
  const auto* surface = lookup(handle);
  return surface ? surface->content.get() : nullptr;
}

CanvasStore::Content* CanvasStore::writableContent(CanvasHandle handle) {
  auto* surface = lookup(handle);
  if (!surface) return nullptr;
  if (surface->content.use_count() != 1) {
    const auto& old = *surface->content;
    auto copy = std::make_shared<Content>(*this);
    copy->width = old.width;
    copy->height = old.height;
    copy->opaque = old.opaque;
    copy->state = old.state;
    copy->setPixels(old.pixels);
    copy->mayHaveOverAlpha = old.mayHaveOverAlpha;
    copy->knownAllZero = old.knownAllZero;
    auto commands = old.commands;
    for (const auto& command : commands) {
      if (const auto* draw = std::get_if<DrawImageCmd>(&command); draw && draw->source) {
        images_.retain(draw->source);
      }
    }
    copy->commands = std::move(commands);
    for (const auto& command : copy->commands) retainSnapshot(command);
    copy->queuedCommandBytes = old.queuedCommandBytes;
    copy->dependencyDepth = old.dependencyDepth;
    copy->dirtyX0 = old.dirtyX0;
    copy->dirtyY0 = old.dirtyY0;
    copy->dirtyX1 = old.dirtyX1;
    copy->dirtyY1 = old.dirtyY1;
    surface->content = std::move(copy);
    peakCpuBytes_ = std::max(peakCpuBytes_, cpuBytes());
  }
  return surface->content.get();
}

std::optional<CanvasInfo> CanvasStore::create(int width, int height, bool opaque) {
  const auto extent = checkedImageExtent(width, height);
  if (!extent) return std::nullopt;
  std::size_t index = 0;
  while (index < surfaces_.size() && surfaces_[index].live) ++index;
  if (index >= indexMask) return std::nullopt;
  if (index == surfaces_.size()) surfaces_.emplace_back();
  auto& surface = surfaces_[index];
  auto content = std::make_shared<Content>(*this);
  content->width = width;
  content->height = height;
  content->opaque = opaque;
  surface.content = std::move(content);
  surface.image = 0;
  surface.live = true;
  ++liveCount_;
  peakLiveCount_ = std::max(peakLiveCount_, liveCount_);
  return CanvasInfo{makeHandle(index, surface.generation), width, height};
}

std::optional<CanvasInfo> CanvasStore::createPixels(
    int width, int height, std::vector<std::uint8_t> pixels, PixelEncoding encoding) {
  const auto extent = checkedImageExtent(width, height);
  if (!extent || pixels.size() != extent->rgbaBytes) return std::nullopt;
  const auto canvas = create(width, height);
  if (!canvas) return std::nullopt;
  auto& surface = *lookupContent(canvas->handle);
  surface.state = ContentState::Realized;
  convertPixels(ConstPixelView(pixels.data(), pixels.size(), extent->width, extent->height,
                               static_cast<size_t>(extent->width) * 4, encoding),
                PixelView(pixels.data(), pixels.size(), extent->width, extent->height,
                          static_cast<size_t>(extent->width) * 4, PixelEncoding::PremultipliedBGRA8));
  surface.setPixels(std::move(pixels));
  for (size_t i = 0; i < surface.pixels.size(); i += 4)
    if (surface.pixels[i] > surface.pixels[i+3] || surface.pixels[i+1] > surface.pixels[i+3] ||
        surface.pixels[i+2] > surface.pixels[i+3]) { surface.mayHaveOverAlpha = true; break; }
  peakCpuBytes_ = std::max(peakCpuBytes_, cpuBytes());
  return canvas;
}

bool CanvasStore::fillRect(CanvasHandle handle, int x, int y, int width, int height,
                           std::uint32_t rgba) {
  auto* surfacePointer = writableContent(handle);
  if (!surfacePointer) return false;
  auto& surface = *surfacePointer;
  if (surface.state == ContentState::Deferred) {
    if (surface.commands.size() >= 256 || surface.queuedCommandBytes >= 64 * 1024) {
      if (!realizeContent(surface)) return false;
    } else {
      surface.commands.emplace_back(FillRectCmd{x, y, width, height, rgba});
      surface.queuedCommandBytes += sizeof(FillRectCmd);
      return true;
    }
  }
  fillRectNow(surface, x, y, width, height, rgba);
  return true;
}

bool CanvasStore::fillRadialGradient(
    CanvasHandle handle, int x, int y, int width, int height,
    float centerX, float centerY, float innerRadius, float outerRadius,
    const std::vector<float>& offsets,
    const std::vector<std::uint32_t>& colors, bool additive) {
  auto* surface = writableContent(handle);
  if (!surface || offsets.empty() || offsets.size() != colors.size() ||
      !std::isfinite(centerX) || !std::isfinite(centerY) ||
      !std::isfinite(innerRadius) || !std::isfinite(outerRadius) ||
      innerRadius < 0 || outerRadius <= innerRadius) return false;
  float previousOffset = -1.0F;
  for (const float offset : offsets) {
    if (!std::isfinite(offset) || offset < 0.0F || offset > 1.0F ||
        offset < previousOffset) return false;
    previousOffset = offset;
  }
  if (surface->state == ContentState::Deferred && !realizeContent(*surface)) return false;
  const int left = std::clamp(x, 0, surface->width);
  const int top = std::clamp(y, 0, surface->height);
  const int right = static_cast<int>(std::clamp<std::int64_t>(
    static_cast<std::int64_t>(x) + width, 0, surface->width));
  const int bottom = static_cast<int>(std::clamp<std::int64_t>(
    static_cast<std::int64_t>(y) + height, 0, surface->height));
  const float radiusSpan = outerRadius - innerRadius;
  for (int py = top; py < bottom; ++py) {
    for (int px = left; px < right; ++px) {
      const float dx = px + 0.5F - centerX;
      const float dy = py + 0.5F - centerY;
      const float amount = std::clamp((std::sqrt(dx * dx + dy * dy) - innerRadius) /
                                      radiusSpan, 0.0F, 1.0F);
      std::size_t upper = 0;
      while (upper + 1 < offsets.size() && offsets[upper] < amount) ++upper;
      const std::size_t lower = upper == 0 ? 0 : upper - 1;
      const float span = offsets[upper] - offsets[lower];
      const float mix = span > 0 ? std::clamp((amount - offsets[lower]) / span,
                                             0.0F, 1.0F) : 0.0F;
      const auto first = colors[lower];
      const auto second = colors[upper];
      const auto channel = [&](int shift) {
        return static_cast<std::uint32_t>(std::lround(
          ((first >> shift) & 255U) * (1.0F - mix) +
          ((second >> shift) & 255U) * mix));
      };
      const std::uint32_t rgba = (channel(24) << 24) | (channel(16) << 16) |
                                 (channel(8) << 8) | channel(0);
      if (additive) blendPixelAdditive(*surface, px, py, rgba);
      else blendPixel(*surface, px, py, rgba, 255);
    }
  }
  markDirty(*surface, left, top, right - left, bottom - top);
  return true;
}

bool CanvasStore::clear(CanvasHandle handle) {
  auto* surface = writableContent(handle);
  if (!surface) return false;
  if (surface->state == ContentState::Deferred) {
    discardCommands(*surface);
    if (surface->opaque) {
      surface->commands.emplace_back(ClearRectCmd{0, 0, surface->width, surface->height});
      surface->queuedCommandBytes = sizeof(ClearRectCmd);
    }
    return true;
  }
  clearNow(*surface, lookup(handle)->image, lookup(handle)->imageRevision);
  return true;
}

bool CanvasStore::clearRect(CanvasHandle handle, int x, int y, int width, int height) {
  auto* surface = writableContent(handle);
  if (!surface) return false;
  if (surface->state == ContentState::Deferred) {
    if (!surface->opaque && x <= 0 && y <= 0 && static_cast<int64_t>(x) + width >= surface->width &&
        static_cast<int64_t>(y) + height >= surface->height) {
      discardCommands(*surface);
      return true;
    }
    if (surface->commands.size() >= 256 || surface->queuedCommandBytes >= 64 * 1024) {
      if (!realizeContent(*surface)) return false;
    } else {
      surface->commands.emplace_back(ClearRectCmd{x, y, width, height});
      surface->queuedCommandBytes += sizeof(ClearRectCmd);
      return true;
    }
  }
  clearRectNow(*surface, x, y, width, height, lookup(handle)->image, lookup(handle)->imageRevision);
  return true;
}

bool CanvasStore::paintRect(CanvasHandle handle, const std::array<float, 4>& rect,
    uint32_t color, float stroke, const std::array<float, 4>& gradient,
    const std::vector<float>& offsets, const std::vector<uint32_t>& colors) {
  if (!std::all_of(rect.begin(), rect.end(), [](float value) { return std::isfinite(value); }) ||
      !std::all_of(gradient.begin(), gradient.end(), [](float value) { return std::isfinite(value); }) ||
      !std::isfinite(stroke) || stroke < 0 || rect[2] < 0 || rect[3] < 0 ||
      offsets.size() != colors.size() || offsets.size() > 64) return false;
  for (size_t i = 0; i < offsets.size(); ++i) if (!std::isfinite(offsets[i]) || offsets[i] < 0 || offsets[i] > 1 ||
    (i && offsets[i] < offsets[i - 1])) return false;
  if (rect[2] == 0 || rect[3] == 0 || (color & 255) == 0 ||
      (!colors.empty() && std::all_of(colors.begin(), colors.end(), [](uint32_t c) { return !(c & 255); }))) return lookup(handle) != nullptr;
  auto* surface = writableContent(handle);
  if (!surface || !realizeContent(*surface)) return false;
#ifdef PMJS_HAS_SKIA65
  const float padding = stroke / 2 + 1;
  const std::array<float, 4> bounds = {rect[0] - padding, rect[1] - padding,
    rect[2] + 2 * padding, rect[3] + 2 * padding};
  surface->knownAllZero = false;
  const auto region = rasterCanvasRegion(surface->pixels, surface->width, surface->height, bounds,
    [&](uint8_t* pixels, int width, int height, size_t stride, int left, int top) {
      return pmjs_skia65_rect_bgra_strided(pixels, width, height, stride, left, top, rect.data(), color, stroke,
        gradient.data(), offsets.data(), colors.data(), offsets.size());
    });
  markDirty(*surface, region[0], region[1], region[2], region[3]);
  return true;
#else
  (void)color;
  return false;
#endif
}

bool CanvasStore::drawImage(CanvasHandle destination, std::uint32_t source,
                            float sourceX, float sourceY,
                            float sourceWidth, float sourceHeight,
                            float destinationX, float destinationY,
                            float destinationWidth, float destinationHeight,
                            float alpha, bool smoothing) {
  if (sourceWidth <= 0 || sourceHeight <= 0 || destinationWidth <= 0 ||
      destinationHeight <= 0 || !std::isfinite(alpha) || alpha < 0 || alpha > 1) return false;
  const std::array<float, 8> geometry = {sourceX, sourceY, sourceWidth, sourceHeight,
    destinationX, destinationY, destinationWidth, destinationHeight};
  if (!std::all_of(geometry.begin(), geometry.end(), [](float value) { return std::isfinite(value); })) return false;
  DrawImageCmd command{source, {}, {}, sourceX, sourceY, sourceWidth, sourceHeight,
                       destinationX, destinationY, destinationWidth, destinationHeight, alpha, smoothing};
  if ((source & canvasHandleTag) != 0) {
    const auto* sourceSurface = lookup(source);
    if (!sourceSurface) return false;
    // Capture before detaching the destination, including a self draw.
    command.canvas = sourceSurface->content;
    command.source = 0;
  } else if (!images_.inspect(source)) {
    return false;
  }
  auto* destinationSurface = writableContent(destination);
  if (!destinationSurface) return false;
  if (destinationSurface->state == ContentState::Deferred) {
    const auto depth = command.canvas ? command.canvas->dependencyDepth + 1 : 0;
    if (destinationSurface->commands.size() >= 256 ||
        destinationSurface->queuedCommandBytes + sizeof(DrawImageCmd) > 64 * 1024 ||
        depth > maxCanvasDependencyDepth) {
      if (!realizeContent(*destinationSurface)) return false;
    } else {
      if (command.source) {
        const auto sourceInfo = images_.inspect(command.source);
        const int left = std::clamp(std::floor(double(sourceX) - 1), 0.0, double(sourceInfo->width));
        const int top = std::clamp(std::floor(double(sourceY) - 1), 0.0, double(sourceInfo->height));
        const int right = std::clamp(std::ceil(double(sourceX) + sourceWidth + 1), 0.0, double(sourceInfo->width));
        const int bottom = std::clamp(std::ceil(double(sourceY) + sourceHeight + 1), 0.0, double(sourceInfo->height));
        if (right <= left || bottom <= top) return true;
        command.snapshot = images_.deferPixelRead(command.source, left, top, right - left, bottom - top);
        if (!command.snapshot) return false;
      }
      destinationSurface->commands.emplace_back(command);
      try {
        retainSnapshot(destinationSurface->commands.back());
      } catch (...) {
        destinationSurface->commands.pop_back();
        throw;
      }
      if (command.source) images_.retain(command.source);
      destinationSurface->queuedCommandBytes += sizeof(DrawImageCmd);
      destinationSurface->dependencyDepth = std::max(destinationSurface->dependencyDepth, depth);
      return true;
    }
  }
  return drawImageNow(*destinationSurface, command);
}

void CanvasStore::markDirty(Content& surface, int x, int y, int width,
                            int height) {
  const int x0 = std::clamp(x, 0, surface.width);
  const int y0 = std::clamp(y, 0, surface.height);
  const int x1 = static_cast<int>(std::clamp<std::int64_t>(
    static_cast<std::int64_t>(x) + width, 0, surface.width));
  const int y1 = static_cast<int>(std::clamp<std::int64_t>(
    static_cast<std::int64_t>(y) + height, 0, surface.height));
  if (x1 <= x0 || y1 <= y0) return;
  surface.knownAllZero = false;
  if (surface.dirtyX1 <= surface.dirtyX0 || surface.dirtyY1 <= surface.dirtyY0) {
    surface.dirtyX0 = x0;
    surface.dirtyY0 = y0;
    surface.dirtyX1 = x1;
    surface.dirtyY1 = y1;
    return;
  }
  surface.dirtyX0 = std::min(surface.dirtyX0, x0);
  surface.dirtyY0 = std::min(surface.dirtyY0, y0);
  surface.dirtyX1 = std::max(surface.dirtyX1, x1);
  surface.dirtyY1 = std::max(surface.dirtyY1, y1);
}

void CanvasStore::blendPixel(Content& surface, int x, int y, std::uint32_t rgba,
                             std::uint8_t coverage) {
  if (x < 0 || y < 0 || x >= surface.width || y >= surface.height) return;
  const unsigned alpha = importCanvasChannel(rgba & 255, coverage);
  if (!alpha) return;
  auto* pixel = surface.pixels.data() + (static_cast<size_t>(y) * surface.width + x) * 4;
  compositeCanvasPixel(pixel, {double(importCanvasChannel(rgba >> 24, alpha)),
    double(importCanvasChannel((rgba >> 16) & 255, alpha)),
    double(importCanvasChannel((rgba >> 8) & 255, alpha)), double(alpha)}, CanvasComposite::sourceOver, true);
}

void CanvasStore::blendPixelAdditive(Content& surface, int x, int y, std::uint32_t rgba) {
  if (x < 0 || y < 0 || x >= surface.width || y >= surface.height) return;
  auto* pixel = surface.pixels.data() + (static_cast<size_t>(y) * surface.width + x) * 4;
  const unsigned alpha = rgba & 255;
  compositeCanvasPixel(pixel, {double(importCanvasChannel(rgba >> 24, alpha)),
    double(importCanvasChannel((rgba >> 16) & 255, alpha)),
    double(importCanvasChannel((rgba >> 8) & 255, alpha)), double(alpha)}, CanvasComposite::lighter);
}

bool CanvasStore::drawText(CanvasHandle handle,
                           const std::vector<std::filesystem::path>& fontPaths,
                           const std::string& text, float x, float y, float pixelSize,
                           std::uint32_t rgba, float strokeWidth, const CanvasTextStyle& style) {
  auto* surface = writableContent(handle);
  if (!surface || !std::isfinite(x) || !std::isfinite(y) || !std::isfinite(pixelSize) ||
      !std::isfinite(strokeWidth) || pixelSize <= 0 || fontPaths.empty() || strokeWidth < 0) return false;
  if (surface->state == ContentState::Deferred) {
    const std::size_t estimatedBytes = sizeof(DrawTextCmd) + text.capacity() +
      fontPaths.capacity() * sizeof(std::filesystem::path);
    if (surface->commands.size() >= 256 ||
        surface->queuedCommandBytes + estimatedBytes >= 64 * 1024) {
      if (!realizeContent(*surface)) return false;
    } else {
      surface->commands.emplace_back(DrawTextCmd{
        fontPaths, text, x, y, pixelSize, rgba, strokeWidth, style
      });
      surface->queuedCommandBytes += estimatedBytes;
      return true;
    }
  }
  return drawTextNow(*surface, fontPaths, text, x, y, pixelSize, rgba, strokeWidth, style);
}

std::optional<double> CanvasStore::measureText(
    const std::vector<std::filesystem::path>& fontPaths, const std::string& text,
    float pixelSize, const CanvasTextStyle& style) const {
  if (textBackend_.skia()) {
    auto metrics = const_cast<TextBackend&>(textBackend_).measure(fontPaths, text, pixelSize, style);
    return metrics ? std::optional<double>(metrics->width) : std::nullopt;
  }
  if (!std::isfinite(pixelSize) || pixelSize <= 0 ||
      double(pixelSize) + 0.5 >= std::numeric_limits<int>::max()) return std::nullopt;
  auto layout = fonts_->layoutText(fontPaths, text, static_cast<int>(std::floor(double(pixelSize) + 0.5)));
  if (!layout) return std::nullopt;
  return layout->metrics.width;
}

std::optional<CanvasTextMetrics> CanvasStore::measureTextMetrics(
    const std::vector<std::filesystem::path>& fontPaths, const std::string& text,
    float pixelSize, const CanvasTextStyle& style) const {
  if (textBackend_.skia())
    return const_cast<TextBackend&>(textBackend_).measure(fontPaths, text, pixelSize, style);
  if (!std::isfinite(pixelSize) || pixelSize <= 0 ||
      double(pixelSize) + 0.5 >= std::numeric_limits<int>::max()) return std::nullopt;
  auto layout = fonts_->layoutText(fontPaths, text, static_cast<int>(std::floor(double(pixelSize) + 0.5)));
  if (!layout) return std::nullopt;
  return layout->metrics;
}

bool CanvasStore::canLoadFont(const std::filesystem::path& fontPath) {
  if (textBackend_.skia()) return textBackend_.canLoad(fontPath);
  return fonts_->face(fontPath, 16) != nullptr;
}

std::optional<std::uint32_t> CanvasStore::pixel(CanvasHandle handle,
                                                int x, int y) {
  auto* surface = lookupContent(handle);
  if (!surface) return std::nullopt;
  if (surface->state == ContentState::Deferred && !realizeContent(*surface)) {
    return std::nullopt;
  }
  if (x < 0 || y < 0 || x >= surface->width || y >= surface->height) {
    return std::nullopt;
  }
  const std::size_t offset =
    (static_cast<std::size_t>(y) * surface->width + x) * 4U;
  uint8_t rgba[4];
  convertPixel(surface->pixels.data() + offset, PixelEncoding::PremultipliedBGRA8,
               rgba, PixelEncoding::StraightRGBA8);
  return (uint32_t(rgba[0]) << 24U) | (uint32_t(rgba[1]) << 16U) |
    (uint32_t(rgba[2]) << 8U) | rgba[3];
}

bool CanvasStore::blur(CanvasHandle handle) {
  auto* surface = writableContent(handle);
  if (!surface) return false;
  if (surface->state == ContentState::Deferred) {
    if (surface->commands.size() >= 256 || surface->queuedCommandBytes >= 64 * 1024) {
      if (!realizeContent(*surface)) return false;
    } else {
      surface->commands.emplace_back(BlurCmd{});
      surface->queuedCommandBytes += sizeof(BlurCmd);
      return true;
    }
  }
  return blurNow(*surface);
}

bool CanvasStore::blurMv(CanvasHandle handle) {
  auto* sourceContent = lookupContent(handle);
  if (!sourceContent || !realizeContent(*sourceContent)) return false;
  // Raw alpha-zero RGB has rasterizer-dependent source-over behavior. Preserve
  // the ordinary drawing path for noncanonical premultiplied inputs.
  if (sourceContent->mayHaveOverAlpha) return false;
  auto* surface = writableContent(handle);
  if (!surface) return false;
  const int width = surface->width, height = surface->height;
  const size_t count = static_cast<size_t>(width) * height;
  std::vector<uint8_t> intermediate(count * 4), horizontal(count * 3);
  // Skia65 encodes opacity 1/9 as paint alpha 28, then scales by (alpha + 1)/256.
  const auto scale = [](uint8_t channel) { return (unsigned(channel) * 29) >> 8; };
  const uint8_t* source = surface->pixels.data();
  for (int pass = 0; pass < 2; ++pass) {
    uint8_t* destination = pass ? surface->pixels.data() : intermediate.data();
    for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
      const size_t row = static_cast<size_t>(y) * width;
      for (int channel = 0; channel < 3; ++channel) {
        unsigned sum = 0;
        for (int dx = -1; dx <= 1; ++dx)
          sum += scale(source[(row + std::clamp(x + dx, 0, width - 1)) * 4 + channel]);
        horizontal[(row + x) * 3 + channel] = sum;
      }
    }
    for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
      const size_t index = static_cast<size_t>(y) * width + x;
      // The padded edge strips leave all four corners transparent. Thin
      // canvases can omit two samples on either axis, so count both edges.
      const unsigned omitted = unsigned((x == 0) + (x == width - 1)) *
        unsigned((y == 0) + (y == height - 1));
      for (int channel = 0; channel < 3; ++channel) {
        unsigned sum = 0;
        for (int dy = -1; dy <= 1; ++dy)
          sum += horizontal[(static_cast<size_t>(std::clamp(y + dy, 0, height - 1)) * width + x) * 3 + channel];
        destination[index * 4 + channel] = std::min(255U,
          sum - omitted * scale(source[index * 4 + channel]));
      }
      destination[index * 4 + 3] = 255;
    }
    source = destination;
  }
  surface->mayHaveOverAlpha = false;
  markDirty(*surface, 0, 0, width, height);
  return true;
}

std::optional<ImagePixels> CanvasStore::readPixels(CanvasHandle handle, int x,
                                                   int y, int width,
                                                   int height, PixelEncoding encoding) {
  auto* surface = lookupContent(handle);
  const auto extent = checkedImageExtent(width, height);
  if (!surface || !extent) {
    return std::nullopt;
  }
  if (surface->state == ContentState::Deferred && !realizeContent(*surface)) {
    return std::nullopt;
  }
  ImagePixels result;
  result.width = extent->width;
  result.height = extent->height;
  result.rgba.resize(extent->rgbaBytes);
  for (int row = 0; row < height; ++row) {
    const int64_t sourceY = static_cast<int64_t>(y) + row;
    if (sourceY < 0 || sourceY >= surface->height) continue;
    for (int column = 0; column < width; ++column) {
      const int64_t sourceX = static_cast<int64_t>(x) + column;
      if (sourceX < 0 || sourceX >= surface->width) continue;
      const std::size_t sourceOffset =
        (static_cast<std::size_t>(sourceY) * surface->width + sourceX) * 4U;
      const std::size_t destinationOffset =
        (static_cast<std::size_t>(row) * width + column) * 4U;
      convertPixel(surface->pixels.data() + sourceOffset, PixelEncoding::PremultipliedBGRA8,
                   result.rgba.data() + destinationOffset, encoding);
    }
  }
  return result;
}

bool CanvasStore::writePixels(CanvasHandle handle, int x, int y, int width,
                              int height,
                              const std::vector<std::uint8_t>& pixels, PixelEncoding encoding) {
  auto* surface = writableContent(handle);
  const std::size_t expected = width > 0 && height > 0
    ? static_cast<std::size_t>(width) * height * 4U : 0;
  if (!surface || expected == 0 || pixels.size() != expected) return false;
  // writePixels forces realization immediately to avoid queuing megabytes of pixels
  if (surface->state == ContentState::Deferred && !realizeContent(*surface)) {
    return false;
  }
  for (int row = 0; row < height; ++row) {
    const int64_t destinationY = static_cast<int64_t>(y) + row;
    if (destinationY < 0 || destinationY >= surface->height) continue;
    const int64_t sourceX = std::max<int64_t>(0, -static_cast<int64_t>(x));
    const int destinationX = std::max(0, x);
    const int64_t count = std::min<int64_t>(width - sourceX, static_cast<int64_t>(surface->width) - destinationX);
    if (count <= 0) continue;
    const std::size_t sourceOffset =
      (static_cast<std::size_t>(row) * width + sourceX) * 4U;
    const std::size_t destinationOffset =
      (static_cast<std::size_t>(destinationY) * surface->width +
       destinationX) * 4U;
    for (int64_t column = 0; column < count; ++column) {
      convertPixel(pixels.data() + sourceOffset + column * 4, encoding,
        surface->pixels.data() + destinationOffset + column * 4, PixelEncoding::PremultipliedBGRA8);
      const auto* pixel = surface->pixels.data() + destinationOffset + column * 4;
      if (pixel[0] > pixel[3] || pixel[1] > pixel[3] || pixel[2] > pixel[3]) surface->mayHaveOverAlpha = true;
    }
  }
  markDirty(*surface, x, y, width, height);
  return true;
}

bool CanvasStore::copyTransformedPixels(CanvasHandle destination, CanvasHandle source,
    int x, int y, int width, int height, int orientation) {
  const auto from = info(source), to = info(destination);
  if (!from || !to || width < 0 || height < 0 || orientation < 0 || orientation > 7) return false;
  const auto extent = checkedImageExtent(to->width, to->height);
  if (!extent) return false;
  // Match an image-data copy's straight-alpha byte rounding, including self copies.
  const auto pixels = readPixels(source, 0, 0, from->width, from->height);
  if (!pixels) return false;
  std::vector<uint8_t> output(extent->rgbaBytes, 0);
  const int64_t left = std::max<int64_t>(0, -int64_t(x));
  const int64_t top = std::max<int64_t>(0, -int64_t(y));
  const int64_t right = std::min<int64_t>(width, int64_t(to->width) - x);
  const int64_t bottom = std::min<int64_t>(height, int64_t(to->height) - y);
  for (int64_t row = top; row < bottom; ++row) for (int64_t column = left; column < right; ++column) {
    const double u = (column + 0.5) / width, v = (row + 0.5) / height;
    double sx = u, sy = v;
    switch (orientation) {
      case 1: sx = 1 - v; sy = u; break;
      case 2: sx = 1 - u; sy = 1 - v; break;
      case 3: sx = v; sy = 1 - u; break;
      case 4: sy = 1 - v; break;
      case 5: sx = v; sy = u; break;
      case 6: sx = 1 - u; break;
      case 7: sx = 1 - v; sy = 1 - u; break;
    }
    const int sourceX = std::clamp(int(std::floor(sx * from->width)), 0, from->width - 1);
    const int sourceY = std::clamp(int(std::floor(sy * from->height)), 0, from->height - 1);
    std::copy_n(pixels->rgba.data() + (size_t(sourceY) * from->width + sourceX) * 4, 4,
      output.data() + (size_t(y + row) * to->width + size_t(x + column)) * 4);
  }
  return writePixels(destination, 0, 0, to->width, to->height, output);
}

bool CanvasStore::replacePixels(CanvasHandle handle,
                                std::vector<std::uint8_t> pixels, PixelEncoding encoding) {
  auto* target = lookup(handle);
  if (!target) return false;
  const auto extent = checkedImageExtent(target->content->width,
                                         target->content->height);
  if (!extent || pixels.size() != extent->rgbaBytes) return false;

  auto replacement = std::make_shared<Content>(*this);
  replacement->width = target->content->width;
  replacement->height = target->content->height;
  replacement->state = ContentState::Realized;
  convertPixels(ConstPixelView(pixels.data(), pixels.size(), extent->width, extent->height,
                               static_cast<size_t>(extent->width) * 4, encoding),
                PixelView(pixels.data(), pixels.size(), extent->width, extent->height,
                          static_cast<size_t>(extent->width) * 4, PixelEncoding::PremultipliedBGRA8));
  replacement->setPixels(std::move(pixels));
  for (size_t i = 0; i < replacement->pixels.size(); i += 4)
    if (replacement->pixels[i] > replacement->pixels[i+3] || replacement->pixels[i+1] > replacement->pixels[i+3] ||
        replacement->pixels[i+2] > replacement->pixels[i+3]) { replacement->mayHaveOverAlpha = true; break; }
  markDirty(*replacement, 0, 0, replacement->width, replacement->height);
  target->content = std::move(replacement);
  peakCpuBytes_ = std::max(peakCpuBytes_, cpuBytes());
  return true;
}

bool CanvasStore::release(CanvasHandle handle) {
  auto* surface = lookup(handle);
  if (!surface) return false;
  if (surface->image) images_.release(surface->image);
  surface->image = 0;
  surface->content.reset();
  surface->live = false;
  surface->generation = static_cast<std::uint16_t>(
    (surface->generation + 1U) & generationMask);
  if (surface->generation == 0) surface->generation = 1;
  --liveCount_;
  return true;
}

std::optional<CanvasInfo> CanvasStore::info(CanvasHandle handle) const {
  const auto* surface = lookupContent(handle);
  if (!surface) return std::nullopt;
  return CanvasInfo{handle, surface->width, surface->height};
}

std::optional<ImageHandle> CanvasStore::imageHandle(CanvasHandle handle) const {
  const auto* surface = lookup(handle);
  if (!surface) return std::nullopt;
  return surface->image ? std::optional<ImageHandle>{surface->image} : std::nullopt;
}

bool CanvasStore::uploadSurface(Surface& target) {
  auto& surface = *target.content;
  if (target.image && (surface.dirtyX1 <= surface.dirtyX0 || surface.dirtyY1 <= surface.dirtyY0)) return true;
  const int x = target.image ? surface.dirtyX0 : 0;
  const int y = target.image ? surface.dirtyY0 : 0;
  const int width = target.image ? surface.dirtyX1 - x : surface.width;
  const int height = target.image ? surface.dirtyY1 - y : surface.height;
  std::vector<std::uint8_t> pixels(static_cast<std::size_t>(width) * height * 4);
  for (int row = 0; row < height; ++row) for (int column = 0; column < width; ++column) {
    const auto source = (static_cast<std::size_t>(y + row) * surface.width + x + column) * 4;
    const auto destination = (static_cast<std::size_t>(row) * width + column) * 4;
    convertPixel(surface.pixels.data() + source, PixelEncoding::PremultipliedBGRA8,
                 pixels.data() + destination, PixelEncoding::PremultipliedRGBA8);
  }
  if (target.image == 0) {
    const auto image = images_.createRgba(surface.width, surface.height, pixels.data(), true);
    if (!image) return false;
    target.image = image->handle;
  } else if (!images_.updateRgbaRegion(target.image, x, y, width, height, pixels.data(), width)) {
    return false;
  }
  target.imageRevision = images_.contentRevision(target.image);
  surface.dirtyX0 = surface.dirtyY0 = 0;
  surface.dirtyX1 = surface.dirtyY1 = 0;
  return true;
}

void CanvasStore::uploadDirty() {
  for (auto& surface : surfaces_) {
    if (surface.live && surface.content->state == ContentState::Realized && surface.image) {
      uploadSurface(surface);
    }
  }
}

std::size_t CanvasStore::cpuBytes() const {
  std::size_t result = pixelBytes_;
  for (const auto& [snapshot, references] : snapshots_) {
    (void)references;
    if (snapshot->pixels) result += snapshot->pixels->rgba.size();
  }
  return result;
}

std::size_t CanvasStore::capacityBytes() const {
  std::size_t result = 0;
  std::unordered_set<const ImagePixelSnapshot*> snapshots;
  for (const auto* content : contents_) {
    result += content->pixels.capacity();
    for (const auto& command : content->commands) if (const auto* draw = std::get_if<DrawImageCmd>(&command))
      if (draw->snapshot && draw->snapshot->pixels && snapshots.insert(draw->snapshot.get()).second)
        result += draw->snapshot->pixels->rgba.capacity();
  }
  return result;
}

std::size_t CanvasStore::deferredCanvasCount() const {
  std::size_t count = 0;
  for (const auto& surface : surfaces_) {
    if (surface.live && surface.content->state == ContentState::Deferred) ++count;
  }
  return count;
}

std::size_t CanvasStore::realizedCanvasCount() const {
  std::size_t count = 0;
  for (const auto& surface : surfaces_) {
    if (surface.live && surface.content->state == ContentState::Realized) ++count;
  }
  return count;
}

std::size_t CanvasStore::deferredCommandCount() const {
  std::size_t count = 0;
  for (const auto* content : contents_) count += content->commands.size();
  return count;
}

std::size_t CanvasStore::deferredCommandBytes() const {
  std::size_t bytes = 0;
  for (const auto* content : contents_) bytes += content->queuedCommandBytes;
  return bytes;
}

CanvasTextStats CanvasStore::glyphCacheStats() const {
  return fonts_->getStats();
}

void CanvasStore::setGlyphCacheLimits(std::size_t maxBytes, std::size_t maxEntries) {
  if (textBackend_.skia()) { textBackend_.limits(maxBytes, maxEntries); return; }
  fonts_->setLimits(maxBytes, maxEntries);
}

}  // namespace pmjs
