#include "canvas.hpp"
#include "checked_bounds.hpp"
#include "text_layout.hpp"
#include <hb-ft.h>

#include <ft2build.h>
#include FT_FREETYPE_H
#include <png.h>

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

static GlyphMask createStrokeMask(const GlyphMask& base, int strokeWidth) {
  GlyphMask stroked;
  const int radius = (strokeWidth + 1) / 2;
  if (base.width <= 0 || base.height <= 0 || base.coverage.empty() || radius <= 0) {
    return base;
  }
  stroked.width = base.width + 2 * radius;
  stroked.height = base.height + 2 * radius;
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
    if (!library || pixelSize <= 0 || pixelSize > 256) return nullptr;
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
    if (strokeWidth < 0 || strokeWidth > 32 || !strike || !strike->face) {
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

        GlyphMask stroked = createStrokeMask(cached.fillMask, strokeWidth);

        if (telemetryEnabled) {
          const auto t1 = std::chrono::steady_clock::now();
          stats.strokeBuildUs += std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count();
        }

        cached.strokeMasks.push_back(StrokeMaskEntry{strokeWidth, std::move(stroked)});
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

    std::cerr << "[pmjs-font] {"
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
}

void CanvasStore::releaseCommandDependencies(CanvasCommand& cmd) {
  std::visit([this](auto& c) {
    using T = std::decay_t<decltype(c)>;
    if constexpr (std::is_same_v<T, DrawImageCmd>) {
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
  for (int py = y0; py < y1; ++py) {
    for (int px = x0; px < x1; ++px) {
      blendPixel(surface, px, py, rgba, 255);
    }
  }
  markDirty(surface, x0, y0, x1 - x0, y1 - y0);
}

void CanvasStore::clearNow(Content& surface) {
  std::fill(surface.pixels.begin(), surface.pixels.end(), 0);
  markDirty(surface, 0, 0, surface.width, surface.height);
}

void CanvasStore::clearRectNow(Content& surface, int x, int y, int width, int height) {
  const int x0 = std::clamp(x, 0, surface.width);
  const int y0 = std::clamp(y, 0, surface.height);
  const int x1 = static_cast<int>(std::clamp<std::int64_t>(
    static_cast<std::int64_t>(x) + width, 0, surface.width));
  const int y1 = static_cast<int>(std::clamp<std::int64_t>(
    static_cast<std::int64_t>(y) + height, 0, surface.height));
  for (int py = y0; py < y1; ++py) {
    for (int px = x0; px < x1; ++px) {
      const std::size_t offset =
        (static_cast<std::size_t>(py) * surface.width + px) * 4U;
      std::fill_n(surface.pixels.data() + offset, 4, 0);
    }
  }
  markDirty(surface, x0, y0, x1 - x0, y1 - y0);
}

bool CanvasStore::drawImageNow(Content& destinationSurface, const DrawImageCmd& command) {
  const auto& [source, canvas, sourceX, sourceY, sourceWidth, sourceHeight,
               destinationX, destinationY, destinationWidth, destinationHeight, alpha] = command;
  struct PixelView {
    int width;
    int height;
    const std::uint8_t* rgba;
  } sourcePixels{};
  if (canvas) {
    if (!realizeContent(*canvas)) return false;
    sourcePixels = {canvas->width, canvas->height, canvas->pixels.data()};
  } else {
    const auto* decoded = images_.readPixels(source);
    if (!decoded) return false;
    sourcePixels = {decoded->width, decoded->height, decoded->rgba.data()};
  }
  if (sourceX >= sourcePixels.width || sourceY >= sourcePixels.height) return true;

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
      const std::uint32_t rgba =
        (static_cast<std::uint32_t>(sourcePixels.rgba[offset]) << 24U) |
        (static_cast<std::uint32_t>(sourcePixels.rgba[offset + 1]) << 16U) |
        (static_cast<std::uint32_t>(sourcePixels.rgba[offset + 2]) << 8U) |
        sourcePixels.rgba[offset + 3];
      blendPixel(destinationSurface, targetX, targetY, rgba, coverage);
    }
  }
  markDirty(destinationSurface, destinationX, destinationY,
            destinationWidth, destinationHeight);
  return true;
}

bool CanvasStore::drawTextNow(Content& surface, const std::vector<std::filesystem::path>& fontPaths,
                              const std::string& text, float x, float y, float pixelSize,
                              std::uint32_t rgba, float strokeWidth, const CanvasTextStyle& style) {
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
  const int legacySize = static_cast<int>(std::floor(pixelSize + 0.5f));
  const int legacyStroke = static_cast<int>(std::floor(strokeWidth + 0.5f));
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
  std::vector<std::uint8_t> scratch(surface.pixels.size());
  constexpr int weights[5] = {1, 4, 6, 4, 1};
  for (int pass = 0; pass < 2; ++pass) {
    const auto& source = pass == 0 ? surface.pixels : scratch;
    auto& destination = pass == 0 ? scratch : surface.pixels;
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
  prepared.state = ContentState::Realizing;
  surface.state = ContentState::Realizing;
  try {
    prepared.pixels.assign(static_cast<std::size_t>(surface.width) *
                             static_cast<std::size_t>(surface.height) * 4U, 0);
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

  surface.pixels = std::move(prepared.pixels);
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
  png_image image{};
  image.version = PNG_IMAGE_VERSION;
  image.width = static_cast<png_uint_32>(surface->width);
  image.height = static_cast<png_uint_32>(surface->height);
  image.format = PNG_FORMAT_RGBA;
  png_alloc_size_t size = 0;
  if (!png_image_write_to_memory(&image, nullptr, &size, 0,
                                 surface->pixels.data(), 0, nullptr)) {
    png_image_free(&image);
    return std::nullopt;
  }
  std::vector<std::uint8_t> encoded(static_cast<std::size_t>(size));
  if (!png_image_write_to_memory(&image, encoded.data(), &size, 0,
                                 surface->pixels.data(), 0, nullptr)) {
    png_image_free(&image);
    return std::nullopt;
  }
  png_image_free(&image);
  encoded.resize(static_cast<std::size_t>(size));
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
    copy->state = old.state;
    copy->pixels = old.pixels;
    auto commands = old.commands;
    for (const auto& command : commands) {
      if (const auto* draw = std::get_if<DrawImageCmd>(&command); draw && draw->source) {
        images_.retain(draw->source);
      }
    }
    copy->commands = std::move(commands);
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

std::optional<CanvasInfo> CanvasStore::create(int width, int height) {
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
  surface.content = std::move(content);
  surface.image = 0;
  surface.live = true;
  ++liveCount_;
  peakLiveCount_ = std::max(peakLiveCount_, liveCount_);
  return CanvasInfo{makeHandle(index, surface.generation), width, height};
}

std::optional<CanvasInfo> CanvasStore::createRgba(
    int width, int height, std::vector<std::uint8_t> pixels) {
  const auto extent = checkedImageExtent(width, height);
  if (!extent || pixels.size() != extent->rgbaBytes) return std::nullopt;
  const auto canvas = create(width, height);
  if (!canvas) return std::nullopt;
  auto& surface = *lookupContent(canvas->handle);
  surface.state = ContentState::Realized;
  surface.pixels = std::move(pixels);
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
    return true;
  }
  clearNow(*surface);
  return true;
}

bool CanvasStore::clearRect(CanvasHandle handle, int x, int y, int width, int height) {
  auto* surface = writableContent(handle);
  if (!surface) return false;
  if (surface->state == ContentState::Deferred) {
    if (x <= 0 && y <= 0 && width >= surface->width && height >= surface->height) {
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
  clearRectNow(*surface, x, y, width, height);
  return true;
}

bool CanvasStore::drawImage(CanvasHandle destination, std::uint32_t source,
                            int sourceX, int sourceY,
                            int sourceWidth, int sourceHeight,
                            int destinationX, int destinationY,
                            int destinationWidth, int destinationHeight,
                            float alpha) {
  if (sourceWidth <= 0 || sourceHeight <= 0 || destinationWidth <= 0 ||
      destinationHeight <= 0 || !std::isfinite(alpha) || alpha < 0 || alpha > 1) return false;
  DrawImageCmd command{source, {}, sourceX, sourceY, sourceWidth, sourceHeight,
                       destinationX, destinationY, destinationWidth, destinationHeight, alpha};
  if ((source & canvasHandleTag) != 0) {
    const auto* sourceSurface = lookup(source);
    if (!sourceSurface) return false;
    // Capture before detaching the destination, including a self draw.
    command.canvas = sourceSurface->content;
    command.source = 0;
  } else if (!images_.lookup(source)) {
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
      destinationSurface->commands.emplace_back(command);
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
  const std::uint32_t colorAlpha = rgba & 0xffU;
  const std::uint32_t sourceAlpha = colorAlpha * coverage / 255U;
  const std::size_t offset =
    (static_cast<std::size_t>(y) * surface.width + x) * 4U;
  const std::uint32_t destinationAlpha = surface.pixels[offset + 3];
  const std::uint32_t inverse = 255U - sourceAlpha;
  const std::uint32_t outputAlpha = sourceAlpha + destinationAlpha * inverse / 255U;
  const std::uint8_t colors[3] = {
    static_cast<std::uint8_t>((rgba >> 24U) & 0xffU),
    static_cast<std::uint8_t>((rgba >> 16U) & 0xffU),
    static_cast<std::uint8_t>((rgba >> 8U) & 0xffU),
  };
  for (int channel = 0; channel < 3; ++channel) {
    const std::uint32_t premultiplied = colors[channel] * sourceAlpha +
      surface.pixels[offset + channel] * destinationAlpha * inverse / 255U;
    surface.pixels[offset + channel] = outputAlpha == 0 ? 0 :
      static_cast<std::uint8_t>(premultiplied / outputAlpha);
  }
  surface.pixels[offset + 3] = static_cast<std::uint8_t>(outputAlpha);
}

void CanvasStore::blendPixelAdditive(Content& surface, int x, int y,
                                     std::uint32_t rgba) {
  if (x < 0 || y < 0 || x >= surface.width || y >= surface.height) return;
  const std::uint32_t sourceAlpha = rgba & 0xffU;
  const std::size_t offset =
    (static_cast<std::size_t>(y) * surface.width + x) * 4U;
  const std::uint32_t destinationAlpha = surface.pixels[offset + 3];
  const std::uint32_t outputAlpha = std::min(255U, sourceAlpha + destinationAlpha);
  const std::uint8_t colors[3] = {
    static_cast<std::uint8_t>((rgba >> 24U) & 0xffU),
    static_cast<std::uint8_t>((rgba >> 16U) & 0xffU),
    static_cast<std::uint8_t>((rgba >> 8U) & 0xffU),
  };
  for (int channel = 0; channel < 3; ++channel) {
    const std::uint32_t premultiplied = colors[channel] * sourceAlpha +
      surface.pixels[offset + channel] * destinationAlpha;
    surface.pixels[offset + channel] = outputAlpha == 0 ? 0 :
      static_cast<std::uint8_t>(std::min(255U, premultiplied / outputAlpha));
  }
  surface.pixels[offset + 3] = static_cast<std::uint8_t>(outputAlpha);
}

bool CanvasStore::drawText(CanvasHandle handle,
                           const std::vector<std::filesystem::path>& fontPaths,
                           const std::string& text, float x, float y, float pixelSize,
                           std::uint32_t rgba, float strokeWidth, const CanvasTextStyle& style) {
  auto* surface = writableContent(handle);
  if (!surface || !std::isfinite(x) || !std::isfinite(y) || !std::isfinite(pixelSize) ||
      !std::isfinite(strokeWidth) || pixelSize <= 0 || pixelSize > 256 || fontPaths.empty() ||
      strokeWidth < 0 || strokeWidth > 32) return false;
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
  if (!std::isfinite(pixelSize) || pixelSize <= 0 || pixelSize > 256) return std::nullopt;
  auto layout = fonts_->layoutText(fontPaths, text, static_cast<int>(std::floor(pixelSize + 0.5f)));
  if (!layout) return std::nullopt;
  return layout->metrics.width;
}

std::optional<CanvasTextMetrics> CanvasStore::measureTextMetrics(
    const std::vector<std::filesystem::path>& fontPaths, const std::string& text,
    float pixelSize, const CanvasTextStyle& style) const {
  if (textBackend_.skia())
    return const_cast<TextBackend&>(textBackend_).measure(fontPaths, text, pixelSize, style);
  if (!std::isfinite(pixelSize) || pixelSize <= 0 || pixelSize > 256) return std::nullopt;
  auto layout = fonts_->layoutText(fontPaths, text, static_cast<int>(std::floor(pixelSize + 0.5f)));
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
  return (static_cast<std::uint32_t>(surface->pixels[offset]) << 24U) |
    (static_cast<std::uint32_t>(surface->pixels[offset + 1]) << 16U) |
    (static_cast<std::uint32_t>(surface->pixels[offset + 2]) << 8U) |
    surface->pixels[offset + 3];
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

std::optional<ImagePixels> CanvasStore::readPixels(CanvasHandle handle, int x,
                                                   int y, int width,
                                                   int height) {
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
    const int sourceY = y + row;
    if (sourceY < 0 || sourceY >= surface->height) continue;
    for (int column = 0; column < width; ++column) {
      const int sourceX = x + column;
      if (sourceX < 0 || sourceX >= surface->width) continue;
      const std::size_t sourceOffset =
        (static_cast<std::size_t>(sourceY) * surface->width + sourceX) * 4U;
      const std::size_t destinationOffset =
        (static_cast<std::size_t>(row) * width + column) * 4U;
      std::copy_n(surface->pixels.data() + sourceOffset, 4,
                  result.rgba.data() + destinationOffset);
    }
  }
  return result;
}

bool CanvasStore::writePixels(CanvasHandle handle, int x, int y, int width,
                              int height,
                              const std::vector<std::uint8_t>& pixels) {
  auto* surface = writableContent(handle);
  const std::size_t expected = width > 0 && height > 0
    ? static_cast<std::size_t>(width) * height * 4U : 0;
  if (!surface || expected == 0 || pixels.size() != expected) return false;
  // writePixels forces realization immediately to avoid queuing megabytes of pixels
  if (surface->state == ContentState::Deferred && !realizeContent(*surface)) {
    return false;
  }
  for (int row = 0; row < height; ++row) {
    const int destinationY = y + row;
    if (destinationY < 0 || destinationY >= surface->height) continue;
    const int sourceX = std::max(0, -x);
    const int destinationX = std::max(0, x);
    const int count = std::min(width - sourceX, surface->width - destinationX);
    if (count <= 0) continue;
    const std::size_t sourceOffset =
      (static_cast<std::size_t>(row) * width + sourceX) * 4U;
    const std::size_t destinationOffset =
      (static_cast<std::size_t>(destinationY) * surface->width +
       destinationX) * 4U;
    std::copy_n(pixels.data() + sourceOffset, static_cast<std::size_t>(count) * 4U,
                surface->pixels.data() + destinationOffset);
  }
  markDirty(*surface, x, y, width, height);
  return true;
}

bool CanvasStore::replacePixels(CanvasHandle handle,
                                std::vector<std::uint8_t> pixels) {
  auto* target = lookup(handle);
  if (!target) return false;
  const auto extent = checkedImageExtent(target->content->width,
                                         target->content->height);
  if (!extent || pixels.size() != extent->rgbaBytes) return false;

  auto replacement = std::make_shared<Content>(*this);
  replacement->width = target->content->width;
  replacement->height = target->content->height;
  replacement->state = ContentState::Realized;
  replacement->pixels = std::move(pixels);
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
  return surface && surface->image ? std::optional<ImageHandle>{surface->image}
                                   : std::nullopt;
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
    const unsigned alpha = surface.pixels[source + 3];
    for (int channel = 0; channel < 3; ++channel)
      pixels[destination + channel] = (surface.pixels[source + channel] * alpha + 127) / 255;
    pixels[destination + 3] = alpha;
  }
  if (target.image == 0) {
    const auto image = images_.createRgba(surface.width, surface.height, pixels.data(), true);
    if (!image) return false;
    target.image = image->handle;
  } else if (!images_.updateRgbaRegion(target.image, x, y, width, height, pixels.data(), width)) {
    return false;
  }
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
  std::size_t result = 0;
  for (const auto* content : contents_) result += content->pixels.size();
  return result;
}

std::size_t CanvasStore::capacityBytes() const {
  std::size_t result = 0;
  for (const auto* content : contents_) result += content->pixels.capacity();
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
