#include "pmjs_skia65.h"
#include "text_layout.hpp"

#include "SkCanvas.h"
#include "SkFontMgr.h"
#include "SkFontMgr_empty.h"
#include "SkGraphics.h"
#include "SkImageInfo.h"
#include "SkPaint.h"
#include "SkSurface.h"
#include "SkTextBlob.h"
#include "SkTypeface.h"
#include "hb.h"
#include "hb-ot.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

namespace {
struct Face {
  sk_sp<SkTypeface> typeface;
  hb_face_t* face = nullptr;
  ~Face() { if (face) hb_face_destroy(face); }
};
struct Run {
  sk_sp<SkTextBlob> blob;
  pmjs_skia65_metrics metrics{};
};
pmjs_skia65_stats counters{};
bool telemetryEnabled = false;
using Clock = std::chrono::steady_clock;
uint64_t elapsed(Clock::time_point start) {
  return std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now() - start).count();
}
}

struct pmjs_skia65_font {
  std::vector<std::unique_ptr<Face>> faces;
  std::string recentText;
  pmjs_skia65_style recentStyle{};
  Run recentRun;
  bool cached = false;
};

namespace {
hb_blob_t* table(hb_face_t*, hb_tag_t tag, void* data) {
  auto* typeface = static_cast<SkTypeface*>(data);
  const size_t size = typeface->getTableSize(tag);
  if (!size) return hb_blob_get_empty();
  auto* bytes = new char[size];
  typeface->getTableData(tag, 0, size, bytes);
  return hb_blob_create(bytes, size, HB_MEMORY_MODE_WRITABLE, bytes,
    [](void* value) { delete[] static_cast<char*>(value); });
}

SkPaint fontPaint(Face& font, const pmjs_skia65_style& style) {
  SkPaint paint;
  paint.setTypeface(font.typeface);
  paint.setTextEncoding(SkPaint::kGlyphID_TextEncoding);
  paint.setTextSize(style.size);
  paint.setAntiAlias(true);
  paint.setHinting(static_cast<SkPaint::Hinting>(style.hinting));
  paint.setAutohinted(style.auto_hint != 0);
  paint.setEmbeddedBitmapText(true);
  paint.setSubpixelText(true);
  paint.setLCDRenderText(false);
  paint.setFakeBoldText(style.bold != 0);
  paint.setTextSkewX(style.italic ? -0.25f : 0.0f);
  return paint;
}

hb_position_t advance(hb_font_t*, void* data, hb_codepoint_t glyph, void*) {
  uint16_t id = glyph;
  SkScalar width;
  static_cast<SkPaint*>(data)->getTextWidths(&id, sizeof(id), &width);
  // Blink's SkiaTextMetrics treats HarfBuzz positions as 16.16.
  return static_cast<hb_position_t>(width * 65536.0f);
}

hb_position_t kerning(hb_font_t*, void* data, hb_codepoint_t left, hb_codepoint_t right, void*) {
  auto* paint = static_cast<SkPaint*>(data);
  uint16_t glyphs[] = {static_cast<uint16_t>(left), static_cast<uint16_t>(right)};
  int32_t adjustment = 0;
  if (!paint->getTypeface()->getKerningPairAdjustments(glyphs, 2, &adjustment)) return 0;
  return static_cast<hb_position_t>(adjustment * paint->getTextSize() /
    paint->getTypeface()->getUnitsPerEm() * 65536.0f);
}

hb_bool_t extents(hb_font_t*, void* data, hb_codepoint_t glyph, hb_glyph_extents_t* output, void*) {
  uint16_t id = glyph;
  SkRect bounds;
  static_cast<SkPaint*>(data)->getTextWidths(&id, sizeof(id), nullptr, &bounds);
  output->x_bearing = static_cast<int>(bounds.fLeft * 65536);
  output->y_bearing = static_cast<int>(-bounds.fTop * 65536);
  output->width = static_cast<int>(bounds.width() * 65536);
  output->height = static_cast<int>(-bounds.height() * 65536);
  return true;
}

bool valid(pmjs_skia65_font* font, const char* text, size_t bytes, const pmjs_skia65_style* style) {
  return font && !font->faces.empty() && text && style && bytes <= 65536 &&
    std::isfinite(style->size) && style->size > 0 && style->size <= 4096 &&
    std::isfinite(style->stroke_width) && style->stroke_width >= 0 &&
    std::isfinite(style->miter_limit) && style->miter_limit > 0 &&
    style->join >= 0 && style->join <= 2 && style->cap >= 0 && style->cap <= 2 &&
    style->hinting >= 0 && style->hinting <= 3;
}

Run layout(pmjs_skia65_font* font, const std::string& text, const pmjs_skia65_style& requested) {
  // Blink FontDescription::EffectiveFontSize uses the font cache's 0.01px precision.
  auto style = requested;
  style.size = std::floor(style.size * 100.0f) / 100.0f;
  ++counters.layout_requests;
  const auto& previous = font->recentStyle;
  if (font->cached && font->recentText == text && previous.size == style.size &&
      previous.bold == style.bold && previous.italic == style.italic &&
      previous.hinting == style.hinting && previous.auto_hint == style.auto_hint) {
    ++counters.layout_hits;
    return font->recentRun;
  }
  Clock::time_point start;
  if (telemetryEnabled) start = Clock::now();
  std::vector<SkPaint> paints;
  std::vector<pmjs::TextFont> fonts;
  paints.reserve(font->faces.size());
  fonts.reserve(font->faces.size());
  auto* funcs = hb_font_funcs_create();
  hb_font_funcs_set_glyph_h_advance_func(funcs, advance, nullptr, nullptr);
  hb_font_funcs_set_glyph_h_kerning_func(funcs, kerning, nullptr, nullptr);
  hb_font_funcs_set_glyph_extents_func(funcs, extents, nullptr, nullptr);
  for (size_t i = 0; i < font->faces.size(); ++i) {
    paints.push_back(fontPaint(*font->faces[i], style));
    auto* parent = hb_font_create(font->faces[i]->face);
    hb_ot_font_set_funcs(parent);
    auto* shapedFont = hb_font_create_sub_font(parent);
    hb_font_destroy(parent);
    hb_font_set_funcs(shapedFont, funcs, &paints.back(), nullptr);
    const int scale = static_cast<int>(style.size * 65536.0f);
    hb_font_set_scale(shapedFont, scale, scale);
    hb_font_set_ptem(shapedFont, style.size / (96.0f / 72.0f));
    fonts.push_back({static_cast<uint32_t>(i), shapedFont});
  }
  hb_font_funcs_destroy(funcs);
  uint64_t fallbackCalls = 0;
  pmjs::ShapedText shaped;
  try {
    shaped = pmjs::shapeText(pmjs::prepareCanvasText(text), fonts, fallbackCalls, 65536.0);
  } catch (...) {
    for (const auto& entry : fonts) hb_font_destroy(entry.font);
    throw;
  }
  for (const auto& entry : fonts) hb_font_destroy(entry.font);
  SkTextBlobBuilder builder;
  Run run;
  float penX = 0, penY = 0;
  SkRect ink = SkRect::MakeEmpty();
  bool hasInk = false;
  std::vector<bool> used(paints.size(), false);
  for (size_t begin = 0; begin < shaped.glyphs.size();) {
    const auto strike = shaped.glyphs[begin].strikeId;
    used[strike] = true;
    size_t end = begin + 1;
    while (end < shaped.glyphs.size() && shaped.glyphs[end].strikeId == strike) ++end;
    auto& paint = paints[strike];
    const auto& output = builder.allocRunPos(paint, end - begin);
    for (size_t i = begin; i < end; ++i) {
      const auto& glyph = shaped.glyphs[i];
      const float x = penX + static_cast<float>(glyph.xOffset);
      const float y = -(penY + static_cast<float>(glyph.yOffset));
      uint16_t id = glyph.glyphIndex;
      output.glyphs[i - begin] = id;
      output.pos[(i - begin) * 2] = x;
      output.pos[(i - begin) * 2 + 1] = y;
      SkRect bounds;
      paint.getTextWidths(&id, sizeof(id), nullptr, &bounds);
      if (!bounds.isEmpty()) {
        bounds.offset(x, y);
        if (hasInk) ink.join(bounds); else ink = bounds;
        hasInk = true;
      }
      penX += static_cast<float>(glyph.xAdvance);
      penY += static_cast<float>(glyph.yAdvance);
    }
    begin = end;
  }
  for (size_t i = 0; i < paints.size(); ++i) {
    if (!used[i] && !(shaped.glyphs.empty() && i == 0)) continue;
    auto& paint = paints[i];
    SkPaint::FontMetrics metrics;
    paint.getFontMetrics(&metrics);
    run.metrics.font_ascent = std::max(run.metrics.font_ascent, -metrics.fAscent);
    run.metrics.font_descent = std::max(run.metrics.font_descent, metrics.fDescent);
  }
  run.metrics.width = penX;
  run.metrics.left = hasInk ? -ink.fLeft : 0;
  run.metrics.right = hasInk ? ink.fRight : 0;
  run.metrics.ascent = hasInk ? -ink.fTop : 0;
  run.metrics.descent = hasInk ? ink.fBottom : 0;
  run.blob = builder.make();
  font->cached = shaped.glyphs.size() * 32 + text.size() <= 64 * 1024;
  font->recentRun = font->cached ? run : Run{};
  font->recentText = font->cached ? text : "";
  font->recentStyle = style;
  if (telemetryEnabled) counters.shape_ns += elapsed(start);
  return run;
}
void boundsOf(const Run& run, const pmjs_skia65_style* style, float x, float baseline,
  int width, int height, int originX, int originY, int bounds[4]) {
  std::fill_n(bounds, 4, 0);
  if (!run.blob || !(style->rgba & 255) ||
      (run.metrics.left == 0 && run.metrics.right == 0 && run.metrics.ascent == 0 && run.metrics.descent == 0)) return;
  SkPaint paint;
  paint.setStyle(style->stroke ? SkPaint::kStroke_Style : SkPaint::kFill_Style);
  paint.setStrokeWidth(style->stroke_width);
  paint.setStrokeMiter(style->miter_limit);
  paint.setStrokeJoin(static_cast<SkPaint::Join>(style->join));
  paint.setStrokeCap(static_cast<SkPaint::Cap>(style->cap));
  SkRect storage;
  auto ink = paint.computeFastBounds(run.blob->bounds(), &storage);
  ink.offset(x, baseline);
  ink.offset(-originX, -originY);
  // Include antialias coverage and hinted bitmap bounds at fractional origins.
  ink.outset(2, 2);
  bounds[0] = static_cast<int>(std::clamp(std::floor(ink.fLeft), 0.0f, static_cast<float>(width)));
  bounds[1] = static_cast<int>(std::clamp(std::floor(ink.fTop), 0.0f, static_cast<float>(height)));
  bounds[2] = static_cast<int>(std::clamp(std::ceil(ink.fRight), 0.0f, static_cast<float>(width)));
  bounds[3] = static_cast<int>(std::clamp(std::ceil(ink.fBottom), 0.0f, static_cast<float>(height)));

}
}

extern "C" {
const char* pmjs_skia65_identity() {
  return "skia65/bd0dafbc8112f6cfa92a8096d8cb5696d8535ef9;freetype/707cd028b2b419a5491d444b128d8092afd9f201;harfbuzz/1.7.3;icu/60.2;abi/2";
}

pmjs_skia65_font* pmjs_skia65_font_open_many(const char* const* filenames, size_t count) try {
  if (!filenames || !count || count > 64) return nullptr;
  auto manager = SkFontMgr_New_Custom_Empty();
  auto font = std::make_unique<pmjs_skia65_font>();
  for (size_t i = 0; i < count; ++i) {
    if (!filenames[i]) continue;
    auto typeface = manager->makeFromFile(filenames[i]);
    if (!typeface) continue;
    auto face = std::make_unique<Face>();
    face->typeface = std::move(typeface);
    face->face = hb_face_create_for_tables(table, face->typeface.get(), nullptr);
    font->faces.push_back(std::move(face));
  }
  return font->faces.empty() ? nullptr : font.release();
} catch (...) { return nullptr; }

pmjs_skia65_font* pmjs_skia65_font_open(const char* filename) {
  return pmjs_skia65_font_open_many(&filename, 1);
}

void pmjs_skia65_font_close(pmjs_skia65_font* font) { delete font; }

int pmjs_skia65_measure_metrics(pmjs_skia65_font* font, const char* utf8, size_t utf8Bytes,
  const pmjs_skia65_style* style, pmjs_skia65_metrics* metrics) try {
  if (!metrics || !valid(font, utf8, utf8Bytes, style)) return 0;
  *metrics = layout(font, std::string(utf8, utf8Bytes), *style).metrics;
  return 1;
} catch (...) { return 0; }

int pmjs_skia65_measure(pmjs_skia65_font* font, const char* utf8, size_t utf8Bytes,
  const pmjs_skia65_style* style, double* width) {
  pmjs_skia65_metrics metrics;
  if (!width || !pmjs_skia65_measure_metrics(font, utf8, utf8Bytes, style, &metrics)) return 0;
  *width = metrics.width;
  return 1;
}

int pmjs_skia65_bounds(pmjs_skia65_font* font, const char* utf8, size_t utf8Bytes,
  const pmjs_skia65_style* style, float x, float baseline, int width, int height, int bounds[4]) try {
  if (!valid(font, utf8, utf8Bytes, style) || !bounds || width <= 0 || height <= 0 ||
      width > 8192 || height > 8192 || !std::isfinite(x) || !std::isfinite(baseline)) return 0;
  auto run = layout(font, std::string(utf8, utf8Bytes), *style);
  boundsOf(run, style, x, baseline, width, height, 0, 0, bounds);
  return 1;
} catch (...) { return 0; }

int pmjs_skia65_draw(pmjs_skia65_font* font, const char* utf8, size_t utf8Bytes,
  const pmjs_skia65_style* style, float x, float baseline, uint8_t* rgba,
  int width, int height, size_t rowBytes, int originX, int originY) try {
  if (!rgba || rowBytes < static_cast<size_t>(width) * 4 || height <= 0 ||
      rowBytes > SIZE_MAX / static_cast<size_t>(height)) return 0;
  Clock::time_point start;
  if (telemetryEnabled) start = Clock::now();
  int bounds[4];
  if (!valid(font, utf8, utf8Bytes, style) || width <= 0 || width > 8192 || height > 8192 ||
      originX < 0 || originY < 0 || originX > 8192 || originY > 8192 ||
      !std::isfinite(x) || !std::isfinite(baseline)) return 0;
  auto run = layout(font, std::string(utf8, utf8Bytes), *style);
  boundsOf(run, style, x, baseline, width, height, originX, originY, bounds);
  ++counters.draw_calls;
  const int left = bounds[0], top = bounds[1];
  const int croppedWidth = bounds[2] - left, croppedHeight = bounds[3] - top;
  if (croppedWidth <= 0 || croppedHeight <= 0) return 1;
  // This release accepts native N32 (BGRA on Linux). Swizzle only the bounded
  // ink region; no alpha rounding or changes outside the region occur here.
  std::vector<uint8_t> scratch(static_cast<size_t>(croppedWidth) * croppedHeight * 4);
  for (int row = 0; row < croppedHeight; ++row) for (int column = 0; column < croppedWidth; ++column) {
    const auto* input = rgba + (top + row) * rowBytes + (left + column) * 4;
    auto* output = scratch.data() + (static_cast<size_t>(row) * croppedWidth + column) * 4;
    output[0] = input[2]; output[1] = input[1]; output[2] = input[0]; output[3] = input[3];
  }
  auto surface = SkSurface::MakeRasterDirect(
    SkImageInfo::MakeN32(croppedWidth, croppedHeight, kPremul_SkAlphaType), scratch.data(), croppedWidth * 4);
  if (!surface) return 0;
  SkPaint paint;
  paint.setAntiAlias(true);
  const auto c = style->rgba;
  paint.setColor(SkColorSetARGB(c & 255, c >> 24, (c >> 16) & 255, (c >> 8) & 255));
  paint.setStyle(style->stroke ? SkPaint::kStroke_Style : SkPaint::kFill_Style);
  paint.setStrokeWidth(style->stroke_width);
  paint.setStrokeMiter(style->miter_limit);
  paint.setStrokeJoin(static_cast<SkPaint::Join>(style->join));
  paint.setStrokeCap(static_cast<SkPaint::Cap>(style->cap));
  // Translate the canvas by an integer instead of rounding the caller's glyph
  // coordinates. This retains the original float addition/subpixel phase.
  surface->getCanvas()->translate(-originX - left, -originY - top);
  if (run.blob) surface->getCanvas()->drawTextBlob(run.blob, x, baseline, paint);
  for (int row = 0; row < croppedHeight; ++row) for (int column = 0; column < croppedWidth; ++column) {
    const auto* input = scratch.data() + (static_cast<size_t>(row) * croppedWidth + column) * 4;
    auto* output = rgba + (top + row) * rowBytes + (left + column) * 4;
    output[0] = input[2]; output[1] = input[1]; output[2] = input[0]; output[3] = input[3];
  }
  if (telemetryEnabled) counters.draw_ns += elapsed(start);
  return 1;
} catch (...) { return 0; }

void pmjs_skia65_set_telemetry(int enabled) { telemetryEnabled = enabled != 0; }

void pmjs_skia65_get_stats(pmjs_skia65_stats* stats) {
  if (!stats) return;
  *stats = counters;
  stats->cache_bytes = SkGraphics::GetFontCacheUsed();
  stats->cache_entries = SkGraphics::GetFontCacheCountUsed();
  stats->cache_limit = SkGraphics::GetFontCacheLimit();
}
void pmjs_skia65_cache_limits(size_t bytes, int entries) {
  SkGraphics::SetFontCacheLimit(bytes);
  SkGraphics::SetFontCacheCountLimit(entries);
}
}
