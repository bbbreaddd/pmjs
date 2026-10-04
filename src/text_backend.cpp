#include "text_backend.hpp"
#include "canvas.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <list>
#include <stdexcept>
#ifdef PMJS_HAS_SKIA65
#include "skia65/pmjs_skia65.h"
#include <dlfcn.h>
#endif

namespace pmjs {
struct TextBackend::State {
#ifdef PMJS_HAS_SKIA65
  struct Font {
    std::vector<std::filesystem::path> paths;
    pmjs_skia65_font* value;
    ~Font() { pmjs_skia65_font_close(value); }
  };
  std::list<Font> fonts;
  pmjs_skia65_font* font(const std::vector<std::filesystem::path>& paths) {
    auto found = std::find_if(fonts.begin(), fonts.end(), [&](const Font& item) { return item.paths == paths; });
    if (found != fonts.end()) {
      fonts.splice(fonts.begin(), fonts, found);
      return fonts.front().value;
    }
    std::vector<std::string> names;
    std::vector<const char*> filenames;
    for (const auto& path : paths) names.push_back(path.string());
    for (const auto& name : names) filenames.push_back(name.c_str());
    auto* value = pmjs_skia65_font_open_many(filenames.data(), filenames.size());
    if (!value) return nullptr;
    if (fonts.size() == 16) fonts.pop_back();
    fonts.emplace_front(paths, value);
    return value;
  }
#endif
};

TextBackend::TextBackend() : state_(std::make_unique<State>()) {
  const char* selected = std::getenv("PMJS_TEXT_BACKEND");
#ifdef PMJS_HAS_SKIA65
  if (!selected) selected = "skia65";
#endif
  if (!selected) selected = "freetype";
  if (std::string(selected) != "freetype" && std::string(selected) != "skia65")
    throw std::runtime_error("PMJS_TEXT_BACKEND must be skia65 or freetype");
  skia_ = std::string(selected) == "skia65";
#ifndef PMJS_HAS_SKIA65
  if (skia_) throw std::runtime_error("PMJS_TEXT_BACKEND=skia65 is unavailable in this build");
#else
  if (skia_) {
    pmjs_skia65_cache_limits(8 * 1024 * 1024, 256);
    const char* timing = std::getenv("PMJS_FONT_TELEMETRY");
    if (!timing) timing = std::getenv("PMJS_GLYPH_TELEMETRY");
    pmjs_skia65_set_telemetry(timing && std::string(timing) == "1");
  }
#endif
}
TextBackend::~TextBackend() = default;

#ifdef PMJS_HAS_SKIA65
namespace {
pmjs_skia65_style settings(float size, uint32_t color, float stroke, const CanvasTextStyle& options) {
  return {size, stroke, options.miterLimit, color, stroke > 0, options.join, options.cap,
    options.bold, options.italic, 1, 0};
}
}
#endif

bool TextBackend::draw(const std::vector<std::filesystem::path>& paths, const std::string& text,
  float x, float y, float size, uint32_t color, float stroke, const CanvasTextStyle& options,
  std::vector<uint8_t>& pixels, int width, int height, int dirty[4]) {
  if (!skia_) return false;
#ifdef PMJS_HAS_SKIA65
  auto* font = state_->font(paths);
  if (!font) return false;
  auto style = settings(size, color, stroke, options);
  int region[4];
  if (!pmjs_skia65_bounds(font, text.data(), text.size(), &style, x, y, width, height, region)) return false;
  dirty[0] = width; dirty[1] = height; dirty[2] = dirty[3] = 0;
  const int left = region[0], top = region[1], croppedWidth = region[2] - left, croppedHeight = region[3] - top;
  if (croppedWidth <= 0 || croppedHeight <= 0) return true;
  const size_t stride = static_cast<size_t>(width) * 4;
  if (!pmjs_skia65_draw_bgra(font, text.data(), text.size(), &style, x, y,
      pixels.data() + top * stride + left * 4, croppedWidth, croppedHeight, stride, left, top)) return false;
  std::copy_n(region, 4, dirty);
  return true;
#else
  (void)paths; (void)text; (void)x; (void)y; (void)size; (void)color; (void)stroke;
  (void)options; (void)pixels; (void)width; (void)height; (void)dirty;
  return false;
#endif
}

std::optional<CanvasTextMetrics> TextBackend::measure(const std::vector<std::filesystem::path>& paths,
  const std::string& text, float size, const CanvasTextStyle& options) {
  if (!skia_) return std::nullopt;
#ifdef PMJS_HAS_SKIA65
  auto* font = state_->font(paths);
  if (!font) return std::nullopt;
  auto style = settings(size, 0, 0, options);
  pmjs_skia65_metrics metrics;
  if (!pmjs_skia65_measure_metrics(font, text.data(), text.size(), &style, &metrics)) return std::nullopt;
  return CanvasTextMetrics{metrics.width, metrics.left, metrics.right, metrics.ascent,
    metrics.descent, metrics.font_ascent, metrics.font_descent};
#else
  (void)paths; (void)text; (void)size; (void)options;
  return std::nullopt;
#endif
}

bool TextBackend::canLoad(const std::filesystem::path& path) {
  if (!skia_) return false;
#ifdef PMJS_HAS_SKIA65
  return state_->font({path}) != nullptr;
#else
  (void)path;
  return false;
#endif
}
TextBackendStats TextBackend::stats() const {
  TextBackendStats result;
#ifdef PMJS_HAS_SKIA65
  if (skia_) {
    pmjs_skia65_stats stats;
    pmjs_skia65_get_stats(&stats);
    result = {pmjs_skia65_identity(), stats.cache_bytes, stats.cache_limit, stats.cache_entries,
      state_->fonts.size(), stats.layout_requests, stats.layout_hits, stats.draw_calls, stats.shape_ns, stats.draw_ns, {}, 0, 0};
    for (const auto& font : state_->fonts) {
      size_t bytes, entries, metrics;
      pmjs_skia65_font_cache_stats(font.value, &bytes, &entries, &metrics);
      result.layoutCacheBytes += bytes;
      result.layoutCacheEntries += entries;
      result.metricCacheBytes += metrics;
    }
    Dl_info loaded{};
    if (dladdr(reinterpret_cast<const void*>(&pmjs_skia65_identity), &loaded) && loaded.dli_fname)
      result.libraryPath = std::filesystem::canonical(loaded.dli_fname).string();
  }
#endif
  return result;
}
void TextBackend::limits(size_t bytes, size_t entries) {
  if (!skia_) return;
#ifdef PMJS_HAS_SKIA65
  pmjs_skia65_cache_limits(bytes, std::min<size_t>(entries, 256));
#else
  (void)bytes; (void)entries;
#endif
}
}
