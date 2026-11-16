#include "pmjs_skia65.h"
#include "canvas/text_layout.hpp"
#include "canvas/canvas_pixels.hpp"

#include "SkCanvas.h"
#include "SkBlitter.h"
#include "SkRasterClip.h"
#include "SkScan.h"
#include "SkFontMgr.h"
#include "SkFontMgr_empty.h"
#include "SkGraphics.h"
#include "SkImageInfo.h"
#include "SkPaint.h"
#include "SkMatrix.h"
#include "SkBitmap.h"
#include "SkGradientShader.h"
#include "SkPath.h"
#include "SkDashPathEffect.h"
#include "SkDropShadowImageFilter.h"
#include "SkBlurMask.h"
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
#include <list>
#include <stdexcept>
#include <string>
#include <vector>
#include <unordered_map>

namespace {
struct GlyphMetrics {
  SkScalar width;
  SkRect bounds;
};
struct Face {
  sk_sp<SkTypeface> typeface;
  hb_face_t* face = nullptr;
  hb_font_t* shapingParent = nullptr;
  pmjs_skia65_style metricStyle{};
  std::unordered_map<uint16_t, GlyphMetrics> metrics;
  ~Face() {
    if (shapingParent) hb_font_destroy(shapingParent);
    if (face) hb_face_destroy(face);
  }
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
  struct Layout {
    std::string text;
    pmjs_skia65_style style;
    Run run;
    size_t bytes;
  };
  std::vector<std::unique_ptr<Face>> faces;
  std::list<Layout> layouts;
  size_t layoutBytes = 0;
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

bool sameFontStyle(const pmjs_skia65_style& a, const pmjs_skia65_style& b) {
  return a.size == b.size && a.bold == b.bold && a.italic == b.italic &&
    a.hinting == b.hinting && a.auto_hint == b.auto_hint;
}

struct MetricContext {
  SkPaint* paint;
  Face* face;
  size_t limit;
};
GlyphMetrics glyphMetrics(MetricContext& context, uint16_t id) {
  auto& metrics = context.face->metrics;
  auto found = metrics.find(id);
  if (found != metrics.end()) return found->second;
  GlyphMetrics result;
  context.paint->getTextWidths(&id, sizeof(id), &result.width, &result.bounds);
  if (metrics.size() == context.limit) metrics.clear();
  metrics.emplace(id, result);
  return result;
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
  const auto width = glyphMetrics(*static_cast<MetricContext*>(data), id).width;
  // Blink's SkiaTextMetrics treats HarfBuzz positions as 16.16.
  return static_cast<hb_position_t>(width * 65536.0f);
}

hb_position_t kerning(hb_font_t*, void* data, hb_codepoint_t left, hb_codepoint_t right, void*) {
  auto* paint = static_cast<MetricContext*>(data)->paint;
  uint16_t glyphs[] = {static_cast<uint16_t>(left), static_cast<uint16_t>(right)};
  int32_t adjustment = 0;
  if (!paint->getTypeface()->getKerningPairAdjustments(glyphs, 2, &adjustment)) return 0;
  return static_cast<hb_position_t>(adjustment * paint->getTextSize() /
    paint->getTypeface()->getUnitsPerEm() * 65536.0f);
}

hb_bool_t extents(hb_font_t*, void* data, hb_codepoint_t glyph, hb_glyph_extents_t* output, void*) {
  uint16_t id = glyph;
  const auto bounds = glyphMetrics(*static_cast<MetricContext*>(data), id).bounds;
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
    style->hinting >= 0 && style->hinting <= 3 &&
    (!style->transformed || std::all_of(style->transform, style->transform + 6, [](float v) { return std::isfinite(v); }));
}

Run layout(pmjs_skia65_font* font, const std::string& text, const pmjs_skia65_style& requested) {
  // Blink FontDescription::EffectiveFontSize uses the font cache's 0.01px precision.
  auto style = requested;
  style.size = std::floor(style.size * 100.0f) / 100.0f;
  ++counters.layout_requests;
  auto found = std::find_if(font->layouts.begin(), font->layouts.end(), [&](const auto& entry) {
    return entry.text == text && sameFontStyle(entry.style, style);
  });
  if (found != font->layouts.end()) {
    ++counters.layout_hits;
    font->layouts.splice(font->layouts.begin(), font->layouts, found);
    return font->layouts.front().run;
  }
  Clock::time_point start;
  if (telemetryEnabled) start = Clock::now();
  std::vector<SkPaint> paints;
  std::vector<pmjs::TextFont> fonts;
  std::vector<MetricContext> contexts;
  paints.reserve(font->faces.size());
  fonts.reserve(font->faces.size());
  contexts.reserve(font->faces.size());
  static const std::unique_ptr<hb_font_funcs_t, decltype(&hb_font_funcs_destroy)> funcs([] {
    auto* value = hb_font_funcs_create();
    hb_font_funcs_set_glyph_h_advance_func(value, advance, nullptr, nullptr);
    hb_font_funcs_set_glyph_h_kerning_func(value, kerning, nullptr, nullptr);
    hb_font_funcs_set_glyph_extents_func(value, extents, nullptr, nullptr);
    hb_font_funcs_make_immutable(value);
    return value;
  }(), hb_font_funcs_destroy);
  for (size_t i = 0; i < font->faces.size(); ++i) {
    auto& face = *font->faces[i];
    if (!sameFontStyle(face.metricStyle, style)) {
      face.metrics.clear();
      face.metricStyle = style;
    }
    paints.push_back(fontPaint(face, style));
    contexts.push_back({&paints.back(), &face, 128 / font->faces.size()});
    auto* shapedFont = hb_font_create_sub_font(face.shapingParent);
    hb_font_set_funcs(shapedFont, funcs.get(), &contexts.back(), nullptr);
    const int scale = static_cast<int>(style.size * 65536.0f);
    hb_font_set_scale(shapedFont, scale, scale);
    hb_font_set_ptem(shapedFont, style.size / (96.0f / 72.0f));
    fonts.push_back({static_cast<uint32_t>(i), shapedFont});
  }
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
      auto bounds = glyphMetrics(contexts[strike], id).bounds;
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
  const size_t bytes = shaped.glyphs.size() * 128 + text.size() + sizeof(pmjs_skia65_font::Layout) +
    sizeof(SkTextBlob) + 2 * sizeof(void*);
  if (bytes <= 64 * 1024) {
    while (!font->layouts.empty() && (font->layouts.size() >= 64 || font->layoutBytes + bytes > 64 * 1024)) {
      font->layoutBytes -= font->layouts.back().bytes;
      font->layouts.pop_back();
    }
    font->layouts.push_front({text, style, run, bytes});
    font->layoutBytes += bytes;
  }
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
  if (style->transformed) {
    const auto* t = style->transform;
    SkMatrix matrix; matrix.setAll(t[0], t[2], t[4], t[1], t[3], t[5], 0, 0, 1);
    matrix.mapRect(&ink);
  }
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
int pmjs_skia65_rect_bgra_strided(uint8_t* pixels, int width, int height,
    size_t row_bytes, int left, int top, const float rect[4], uint32_t color, float stroke,
    const float gradient[4], const float* offsets, const uint32_t* colors, size_t count) try {
  if (!pixels || width <= 0 || height <= 0 || row_bytes < static_cast<size_t>(width) * 4 ||
      row_bytes > SIZE_MAX / static_cast<size_t>(height)) return 0;
  auto surface = SkSurface::MakeRasterDirect(SkImageInfo::MakeN32Premul(width, height), pixels, row_bytes);
  if (!surface) return 0;
  SkPaint paint;
  paint.setAntiAlias(true);
  paint.setColor((color >> 8) | (color << 24));
  if (stroke > 0) {
    paint.setStyle(SkPaint::kStroke_Style);
    paint.setStrokeWidth(stroke);
  }
  if (count) {
    std::vector<SkColor> converted;
    for (size_t i = 0; i < count; ++i) converted.push_back((colors[i] >> 8) | (colors[i] << 24));
    SkPoint points[] = {{gradient[0], gradient[1]}, {gradient[2], gradient[3]}};
    auto shader = SkGradientShader::MakeLinear(points, converted.data(), offsets, count, SkShader::kClamp_TileMode);
    if (!shader) return 0;
    paint.setDither(true);
    paint.setShader(shader);
  }
  surface->getCanvas()->translate(-left, -top);
  surface->getCanvas()->drawRect(SkRect::MakeXYWH(rect[0], rect[1], rect[2], rect[3]), paint);
  return 1;
} catch (...) { return 0; }

static int imageStrided(uint8_t* pixels, int width, int height, size_t row_bytes,
    int left, int top, const uint8_t* source, int source_width, int source_height,
    size_t source_row_bytes, const float src[4], const float dst[4], float alpha, int smoothing,
    pmjs::PixelEncoding source_encoding) try {
  if (!pixels || !source || width <= 0 || height <= 0 || source_width <= 0 || source_height <= 0 ||
      row_bytes < static_cast<size_t>(width) * 4 || source_row_bytes < static_cast<size_t>(source_width) * 4 ||
      row_bytes > SIZE_MAX / static_cast<size_t>(height) ||
      source_row_bytes > SIZE_MAX / static_cast<size_t>(source_height)) return 0;
  auto surface = SkSurface::MakeRasterDirect(SkImageInfo::MakeN32Premul(width, height), pixels, row_bytes);
  if (!surface) return 0;
  const int source_left = std::clamp<double>(std::floor(src[0]) - 1, 0, source_width);
  const int source_top = std::clamp<double>(std::floor(src[1]) - 1, 0, source_height);
  const int source_right = std::clamp<double>(std::ceil(static_cast<double>(src[0]) + src[2]) + 1, 0, source_width);
  const int source_bottom = std::clamp<double>(std::ceil(static_cast<double>(src[1]) + src[3]) + 1, 0, source_height);
  const int cropped_width = source_right - source_left, cropped_height = source_bottom - source_top;
  if (cropped_width <= 0 || cropped_height <= 0) return 1;
  const bool source_bgra = source_encoding == pmjs::PixelEncoding::PremultipliedBGRA8;
  std::vector<uint8_t> premul;
  if (!source_bgra) premul.resize(static_cast<size_t>(cropped_width) * cropped_height * 4);
  if (!source_bgra) for (int row = 0; row < cropped_height; ++row) for (int column = 0; column < cropped_width; ++column) {
    const auto* original = source + static_cast<size_t>(source_top + row) * source_row_bytes + (source_left + column) * 4;
    auto* pixel = premul.data() + (static_cast<size_t>(row) * cropped_width + column) * 4;
    pmjs::convertPixel(original, source_encoding,
                       pixel, pmjs::PixelEncoding::PremultipliedBGRA8);
  }
  SkBitmap bitmap;
  const auto* borrowed = source + static_cast<size_t>(source_top) * source_row_bytes + source_left * 4;
  if (!bitmap.installPixels(SkImageInfo::MakeN32Premul(cropped_width, cropped_height),
      source_bgra ? const_cast<uint8_t*>(borrowed) : premul.data(),
      source_bgra ? source_row_bytes : cropped_width * 4)) return 0;
  SkPaint paint;
  paint.setAntiAlias(dst[2] < 1 || dst[3] < 1);
  paint.setAlpha(std::min(255L, std::lround(alpha * 256)));
  paint.setFilterQuality(smoothing ? kLow_SkFilterQuality : kNone_SkFilterQuality);
  surface->getCanvas()->translate(-left, -top);
  surface->getCanvas()->drawBitmapRect(bitmap, SkRect::MakeXYWH(src[0] - source_left, src[1] - source_top, src[2], src[3]),
    SkRect::MakeXYWH(dst[0], dst[1], dst[2], dst[3]), &paint, SkCanvas::kFast_SrcRectConstraint);
  return 1;
} catch (...) { return 0; }

int pmjs_skia65_rect_bgra(uint8_t* pixels, int width, int height, int left, int top,
    const float rect[4], uint32_t color, float stroke, const float gradient[4],
    const float* offsets, const uint32_t* colors, size_t count) {
  return pmjs_skia65_rect_bgra_strided(pixels, width, height, static_cast<size_t>(width) * 4,
    left, top, rect, color, stroke, gradient, offsets, colors, count);
}
int pmjs_skia65_image_bgra_strided(uint8_t* pixels, int width, int height, size_t row_bytes,
    int left, int top, const uint8_t* source, int source_width, int source_height,
    size_t source_row_bytes, const float src[4], const float dst[4], float alpha, int smoothing) {
  return imageStrided(pixels, width, height, row_bytes, left, top, source, source_width,
    source_height, source_row_bytes, src, dst, alpha, smoothing, pmjs::PixelEncoding::PremultipliedBGRA8);
}
int pmjs_skia65_image_rgba_strided(uint8_t* pixels, int width, int height, size_t row_bytes,
    int left, int top, const uint8_t* source, int source_width, int source_height,
    size_t source_row_bytes, const float src[4], const float dst[4], float alpha, int smoothing) {
  return imageStrided(pixels, width, height, row_bytes, left, top, source, source_width,
    source_height, source_row_bytes, src, dst, alpha, smoothing, pmjs::PixelEncoding::StraightRGBA8);
}
int pmjs_skia65_image_premul_rgba_strided(uint8_t* pixels, int width, int height, size_t row_bytes,
    int left, int top, const uint8_t* source, int source_width, int source_height,
    size_t source_row_bytes, const float src[4], const float dst[4], float alpha, int smoothing) {
  return imageStrided(pixels, width, height, row_bytes, left, top, source, source_width,
    source_height, source_row_bytes, src, dst, alpha, smoothing, pmjs::PixelEncoding::PremultipliedRGBA8);
}
int pmjs_skia65_image_bgra(uint8_t* pixels, int width, int height, int left, int top,
    const uint8_t* source, int source_width, int source_height,
    const float src[4], const float dst[4], float alpha, int smoothing) {
  return pmjs_skia65_image_bgra_strided(pixels, width, height, static_cast<size_t>(width) * 4,
    left, top, source, source_width, source_height, static_cast<size_t>(source_width) * 4,
    src, dst, alpha, smoothing);
}

int pmjs_skia65_circle_coverage(float x, float y, float radius,
    const float transform[6], int left, int top, int width, int height,
    uint8_t* coverage, const float* clips, size_t clip_count) try {
  std::vector<uint8_t> pixels(static_cast<size_t>(width) * height * 4, 0);
  auto surface = SkSurface::MakeRasterDirect(
    SkImageInfo::MakeN32(width, height, kPremul_SkAlphaType), pixels.data(), width * 4);
  if (!surface) return 0;
  SkMatrix matrix;
  matrix.setAll(transform[0], transform[2], transform[4] - left,
    transform[1], transform[3], transform[5] - top, 0, 0, 1);
  SkPath path;
  const auto oval = SkRect::MakeLTRB(x - radius, y - radius, x + radius, y + radius);
  path.addOval(oval);
  SkPaint paint;
  paint.setColor(SK_ColorWHITE);
  paint.setAntiAlias(true);
  for (size_t i = 0; i < clip_count; ++i) {
    const auto* clip = clips + i * 4;
    surface->getCanvas()->clipRect(SkRect::MakeXYWH(clip[0] - left, clip[1] - top, clip[2], clip[3]), SkClipOp::kIntersect, true);
  }
  surface->getCanvas()->concat(matrix);
  surface->getCanvas()->drawPath(path, paint);
  for (size_t i = 0; i < static_cast<size_t>(width) * height; ++i) coverage[i] = pixels[i * 4 + 3];
  return 1;
} catch (...) { return 0; }

static int pathRaster(const float* points,
    const uint32_t* sizes, const uint8_t* closed, size_t count,
    const float* commands, size_t command_count, const float* dash, size_t dash_count, float dash_offset,
    const float transform[6],
    float stroke, int cap, int join, float miter_limit, int antialias, int even_odd,
    int left, int top, int width, int height, uint8_t* coverage, size_t row_bytes, const pmjs_skia65_path_style* style) try {
  if (!points || !sizes || !closed || !transform || !coverage || width <= 0 || height <= 0) return 0;
  SkPath path;
  if (even_odd) path.setFillType(SkPath::kEvenOdd_FillType);
  size_t offset = 0;
  if (command_count) {
    while (offset < command_count) {
      const float verb = commands[offset++];
      const size_t size = verb == 0 || verb == 1 ? 2 : verb == 2 ? 4 : verb == 3 ? 6 : verb == 4 ? 0 : verb == 5 ? 11 : SIZE_MAX;
      if (size > command_count - offset) return 0;
      const float* p = commands + offset;
      if (verb == 0) path.moveTo(p[0], p[1]);
      else if (verb == 1) path.lineTo(p[0], p[1]);
      else if (verb == 2) path.quadTo(p[0], p[1], p[2], p[3]);
      else if (verb == 3) path.cubicTo(p[0], p[1], p[2], p[3], p[4], p[5]);
      else if (verb == 5) {
        SkPath arc;
        const auto oval = SkRect::MakeLTRB(p[0] - p[2], p[1] - p[2], p[0] + p[2], p[1] + p[2]);
        const float start = p[3] * 180 / SK_ScalarPI, sweep = p[4] * 180 / SK_ScalarPI;
        if (std::abs(sweep) >= 360) {
          arc.arcTo(oval, start, sweep / 2, true); arc.arcTo(oval, start + sweep / 2, sweep / 2, false);
        } else arc.arcTo(oval, start, sweep, true);
        SkMatrix arcTransform;
        arcTransform.setAll(p[5], p[7], p[9], p[6], p[8], p[10], 0, 0, 1);
        path.addPath(arc, arcTransform, SkPath::kExtend_AddPathMode);
      }
      else path.close();
      offset += size;
    }
  } else for (size_t i = 0; i < count; ++i) {
    if (!sizes[i]) continue;
    path.moveTo(points[offset], points[offset + 1]); offset += 2;
    for (uint32_t j = 1; j < sizes[i]; ++j) {
      path.lineTo(points[offset], points[offset + 1]); offset += 2;
    }
    if (closed[i]) path.close();
  }
  SkMatrix matrix;
  matrix.setAll(transform[0], transform[2], transform[4],
    transform[1], transform[3], transform[5], 0, 0, 1);
  SkPaint paint;
  paint.setColor(SK_ColorWHITE);
  paint.setAntiAlias(antialias != 0);
  if (stroke > 0) {
    SkMatrix inverse;
    if (!matrix.invert(&inverse)) return 0;
    path.transform(inverse);
    paint.setStyle(SkPaint::kStroke_Style);
    paint.setStrokeWidth(stroke);
    paint.setStrokeCap(static_cast<SkPaint::Cap>(cap));
    paint.setStrokeJoin(static_cast<SkPaint::Join>(join));
    paint.setStrokeMiter(miter_limit);
    if (dash_count) paint.setPathEffect(SkDashPathEffect::Make(dash, static_cast<int>(dash_count), dash_offset));
  }
  if (style) {
    if (row_bytes < size_t(width) * 4 || row_bytes > SIZE_MAX / size_t(height)) return 0;
    auto surface = SkSurface::MakeRasterDirect(SkImageInfo::MakeN32Premul(width, height), coverage, row_bytes);
    if (!surface) return 0;
    auto* canvas = surface->getCanvas();
    canvas->translate(-left, -top);
    size_t point = 0, subpath = 0;
    for (size_t i = 0; i < style->clip_count; ++i) {
      SkPath clip;
      if (style->clip_even_odd[i]) clip.setFillType(SkPath::kEvenOdd_FillType);
      for (uint32_t j = 0; j < style->clip_counts[i]; ++j) {
        const auto n = style->clip_sizes[subpath++];
        if (!n) continue;
        clip.moveTo(style->clip_points[point], style->clip_points[point + 1]); point += 2;
        for (uint32_t k = 1; k < n; ++k) {
          clip.lineTo(style->clip_points[point], style->clip_points[point + 1]); point += 2;
        }
        clip.close();
      }
      canvas->clipPath(clip, SkClipOp::kIntersect, true);
    }
    const SkBlendMode modes[] = {SkBlendMode::kSrcOver, SkBlendMode::kSrcIn, SkBlendMode::kSrcOut,
      SkBlendMode::kSrcATop, SkBlendMode::kDstOver, SkBlendMode::kDstIn, SkBlendMode::kDstOut,
      SkBlendMode::kDstATop, SkBlendMode::kPlus, SkBlendMode::kSrc, SkBlendMode::kXor,
      SkBlendMode::kMultiply, SkBlendMode::kScreen, SkBlendMode::kOverlay, SkBlendMode::kDarken,
      SkBlendMode::kLighten, SkBlendMode::kColorDodge, SkBlendMode::kColorBurn,
      SkBlendMode::kHardLight, SkBlendMode::kSoftLight, SkBlendMode::kDifference,
      SkBlendMode::kExclusion, SkBlendMode::kHue, SkBlendMode::kSaturation,
      SkBlendMode::kColor, SkBlendMode::kLuminosity};
    if (style->composite < 0 || style->composite >= int(sizeof(modes) / sizeof(*modes))) return 0;
    const auto mode = modes[style->composite];
    const bool unbounded = !style->clear && (mode == SkBlendMode::kSrc || mode == SkBlendMode::kSrcIn ||
      mode == SkBlendMode::kSrcOut || mode == SkBlendMode::kDstIn || mode == SkBlendMode::kDstATop);
    if (unbounded) {
      SkPaint layer; layer.setBlendMode(mode);
      canvas->saveLayer(nullptr, &layer);
    }
    paint.setBlendMode(style->clear ? SkBlendMode::kClear : unbounded ? SkBlendMode::kSrcOver : mode);
    paint.setColor((style->color >> 8) | (style->color << 24));
    if (style->kind) {
      const auto* g = style->geometry;
      const bool emptyRadial = style->kind == 2 && g[0] == g[3] && g[1] == g[4] && g[2] == g[5];
      if (!style->count || emptyRadial) {
        paint.setColor(SK_ColorTRANSPARENT);
      } else {
        std::vector<SkColor> colors;
        for (size_t i = 0; i < style->count; ++i) colors.push_back((style->colors[i] >> 8) | (style->colors[i] << 24));
        SkMatrix local;
        const auto* t = style->transform;
        local.setAll(t[0], t[2], t[4], t[1], t[3], t[5], 0, 0, 1);
        if (stroke > 0) {
          SkMatrix inverse;
          if (!matrix.invert(&inverse)) return 0;
          local.postConcat(inverse);
        }
        sk_sp<SkShader> shader;
        if (style->kind == 1) {
          const SkPoint points[] = {{g[0], g[1]}, {g[3], g[4]}};
          shader = SkGradientShader::MakeLinear(points, colors.data(), style->offsets,
            style->count, SkShader::kClamp_TileMode, 0, &local);
        } else {
          shader = SkGradientShader::MakeTwoPointConical({g[0], g[1]}, g[2], {g[3], g[4]}, g[5],
            colors.data(), style->offsets, style->count, SkShader::kClamp_TileMode, 0, &local);
        }
        if (!shader) return 0;
        paint.setColor(SK_ColorBLACK);
        paint.setShader(shader);
        paint.setDither(true);
      }
    }
    paint.setAlpha(std::round(paint.getAlpha() * style->alpha));
    if (stroke > 0) canvas->concat(matrix);
    SkRect rect;
    if (!stroke && mode != SkBlendMode::kSrc && path.isRect(&rect)) canvas->drawRect(rect, paint);
    else canvas->drawPath(path, paint);
    if (unbounded) canvas->restore();
    return 1;
  }
  // Stroke coverage depends on the raster format; retain the color raster for strokes.
  std::vector<uint8_t> pixels;
  sk_sp<SkSurface> surface;
  if (stroke > 0) {
    pixels.resize(static_cast<size_t>(width) * height * 4, 0);
    surface = SkSurface::MakeRasterDirect(SkImageInfo::MakeN32Premul(width, height), pixels.data(), width * 4);
  } else {
    std::fill_n(coverage, static_cast<size_t>(width) * height, 0);
    surface = SkSurface::MakeRasterDirect(SkImageInfo::MakeA8(width, height), coverage, width);
  }
  if (!surface) return 0;
  surface->getCanvas()->translate(-left, -top);
  if (stroke > 0) surface->getCanvas()->concat(matrix);
  surface->getCanvas()->drawPath(path, paint);
  if (stroke > 0) for (size_t i = 0; i < static_cast<size_t>(width) * height; ++i) coverage[i] = pixels[i * 4 + 3];
  return 1;
} catch (...) { return 0; }

int pmjs_skia65_path_coverage(const float* points,
    const uint32_t* sizes, const uint8_t* closed, size_t count,
    const float* commands, size_t command_count, const float* dash, size_t dash_count, float dash_offset,
    const float transform[6],
    float stroke, int cap, int join, float miter_limit, int antialias, int even_odd,
    int left, int top, int width, int height, uint8_t* coverage) {
  return pathRaster(points, sizes, closed, count, commands, command_count, dash, dash_count, dash_offset,
    transform, stroke, cap, join, miter_limit, antialias, even_odd,
    left, top, width, height, coverage, 0, nullptr);
}

int pmjs_skia65_path_bgra(const float* points,
    const uint32_t* sizes, const uint8_t* closed, size_t count,
    const float* commands, size_t command_count, const float* dash, size_t dash_count, float dash_offset,
    const float transform[6],
    float stroke, int cap, int join, float miter_limit, int antialias, int even_odd,
    int left, int top, int width, int height, uint8_t* pixels, size_t row_bytes, const pmjs_skia65_path_style* style) {
  return pathRaster(points, sizes, closed, count, commands, command_count, dash, dash_count, dash_offset,
    transform, stroke, cap, join, miter_limit, antialias, even_odd,
    left, top, width, height, pixels, row_bytes, style);
}

int pmjs_skia65_shadow_bgra(const uint8_t* source, int source_width, int source_height,
    float x, float y, float blur, uint32_t color, int geometry_mask, uint8_t* pixels, int width, int height) try {
  if (!source || !pixels || source_width <= 0 || source_height <= 0 || width <= 0 || height <= 0) return 0;
  const float sigma = std::min(blur ? 0.288675f * blur + 0.5f : 0, geometry_mask ? 136.0f : 532.0f);
  if (geometry_mask) {
    std::vector<uint8_t> alpha(static_cast<size_t>(source_width) * source_height);
    for (size_t i = 0; i < alpha.size(); ++i) alpha[i] = source[i * 4 + 3];
    SkMask mask, blurred;
    mask.fImage = alpha.data(); mask.fBounds = SkIRect::MakeWH(source_width, source_height);
    mask.fRowBytes = source_width; mask.fFormat = SkMask::kA8_Format;
    if (blur && !SkBlurMask::BoxBlur(&blurred, mask, sigma, kNormal_SkBlurStyle, kHigh_SkBlurQuality)) return 0;
    const SkMask& coverage = blur ? blurred : mask;
    for (int row = 0; row < height; ++row) for (int column = 0; column < width; ++column) {
      const float px = column - x, py = row - y;
      const int sx = std::floor(px), sy = std::floor(py);
      const float fx = px - sx, fy = py - sy;
      const auto sample = [&](int cx, int cy) { return coverage.fBounds.contains(cx, cy) ? *coverage.getAddr8(cx, cy) : 0; };
      const unsigned amount = std::round((sample(sx, sy) * (1 - fx) + sample(sx + 1, sy) * fx) * (1 - fy) +
        (sample(sx, sy + 1) * (1 - fx) + sample(sx + 1, sy + 1) * fx) * fy);
      const unsigned a = color & 255;
      auto* p = pixels + (static_cast<size_t>(row) * width + column) * 4;
      p[0] = (((color >> 8) & 255) * (a + 1) >> 8) * (amount + 1) >> 8;
      p[1] = (((color >> 16) & 255) * (a + 1) >> 8) * (amount + 1) >> 8;
      p[2] = ((color >> 24) * (a + 1) >> 8) * (amount + 1) >> 8;
      p[3] = a * (amount + 1) >> 8;
    }
    if (blur) SkMask::FreeImage(blurred.fImage);
    return 1;
  }
  auto image = SkImage::MakeRasterCopy(SkPixmap(SkImageInfo::MakeN32Premul(source_width, source_height), source, source_width * 4));
  auto surface = SkSurface::MakeRasterDirect(SkImageInfo::MakeN32Premul(width, height), pixels, width * 4);
  if (!image || !surface) return 0;
  SkPaint paint;
  const auto rgba = SkColorSetARGB(color & 255, color >> 24, (color >> 16) & 255, (color >> 8) & 255);
  paint.setImageFilter(SkDropShadowImageFilter::Make(0, 0, sigma, sigma, rgba,
    SkDropShadowImageFilter::kDrawShadowOnly_ShadowMode, nullptr));
  surface->getCanvas()->drawImage(image, x, y, &paint);
  return 1;
} catch (...) { return 0; }

int pmjs_skia65_polygon_coverage(const float* points, size_t point_count,
    float stroke_width, float miter_limit, float stroke_alpha,
    float left, float top, int width, int height, uint8_t* coverage) try {
  std::vector<uint8_t> pixels(static_cast<size_t>(width) * height * 4, 0);
  auto surface = SkSurface::MakeRasterDirect(
    SkImageInfo::MakeN32(width, height, kPremul_SkAlphaType), pixels.data(), width * 4);
  if (!surface) return 0;
  auto* canvas = surface->getCanvas();
  canvas->translate(-left, -top);
  SkPath path;
  path.moveTo(points[0], points[1]);
  for (size_t i = 1; i < point_count; ++i) path.lineTo(points[i * 2], points[i * 2 + 1]);
  path.close();
  SkPaint paint;
  paint.setColor(SK_ColorWHITE);
  canvas->save();
  canvas->clipPath(path, SkClipOp::kIntersect, true);
  canvas->drawRect(path.getBounds(), paint);
  canvas->restore();
  const size_t count = static_cast<size_t>(width) * height;
  for (size_t i = 0; i < count; ++i) {
    coverage[i * 4] = pixels[i * 4 + 3];
    coverage[i * 4 + 1] = 0;
    coverage[i * 4 + 2] = 0;
    coverage[i * 4 + 3] = 0;
  }
  class StrokeCoverage final : public SkBlitter {
   public:
    StrokeCoverage(uint8_t* pixels, int width, int height) : pixels_(pixels), width_(width), height_(height) {}
    void pixel(int x, int y, unsigned alpha, uint8_t mode) {
      if (x < 0 || y < 0 || x >= width_ || y >= height_ || !alpha) return;
      auto* p = pixels_ + (static_cast<size_t>(y) * width_ + x) * 4;
      // Preserve two spans where possible; excess overlap retries the legacy path.
      if (!singleSpan_ && p[1]) {
        if (p[3]) { overflowed_ = true; return; }
        p[3] = static_cast<uint8_t>(alpha);
        p[2] |= mode << 2;
      } else {
        p[1] = static_cast<uint8_t>(alpha);
        p[2] = mode;
      }
    }
    bool overflowed() const { return overflowed_; }
    void useSingleSpan() {
      singleSpan_ = true;
      for (size_t i = 0; i < static_cast<size_t>(width_) * height_; ++i) {
        pixels_[i * 4 + 1] = pixels_[i * 4 + 2] = pixels_[i * 4 + 3] = 0;
      }
    }
    void blitH(int x, int y, int width) override {
      for (int i = 0; i < width; ++i) pixel(x + i, y, 255, 0);
    }
    void blitAntiH(int x, int y, const SkAlpha aa[], const int16_t runs[]) override {
      while (*runs) {
        const int count = *runs;
        for (int i = 0; i < count; ++i) pixel(x + i, y, *aa, 0);
        x += count; aa += count; runs += count;
      }
    }
    void blitAntiH2(int x, int y, U8CPU a0, U8CPU a1) override {
      pixel(x, y, a0, 1); pixel(x + 1, y, a1, 1);
    }
    void blitAntiV2(int x, int y, U8CPU a0, U8CPU a1) override {
      pixel(x, y, a0, 1); pixel(x, y + 1, a1, 1);
    }
    void blitV(int x, int y, int height, SkAlpha alpha) override {
      for (int i = 0; i < height; ++i) pixel(x, y + i, alpha, 2);
    }
   private:
    uint8_t* pixels_;
    int width_, height_;
    bool overflowed_ = false, singleSpan_ = false;
  } blitter(coverage, width, height);
  paint.setStyle(SkPaint::kStroke_Style);
  paint.setStrokeWidth(stroke_width);
  paint.setStrokeMiter(miter_limit);
  SkPath strokePath;
  if (stroke_width > 0 && stroke_alpha > 0) {
    paint.getFillPath(path, &strokePath);
    strokePath.offset(-left, -top);
    SkScan::AntiFillPath(strokePath, SkRasterClip(SkIRect::MakeWH(width, height)), &blitter);
    if (blitter.overflowed()) {
      blitter.useSingleSpan();
      SkScan::AntiFillPath(strokePath, SkRasterClip(SkIRect::MakeWH(width, height)), &blitter);
    }
  }
  return 1;
} catch (...) { return 0; }

int pmjs_skia65_triangle_coverage(const float points[6],
    float stroke_width, float miter_limit, float stroke_alpha,
    float left, float top, int width, int height, uint8_t* coverage) {
  return pmjs_skia65_polygon_coverage(points, 3, stroke_width, miter_limit, stroke_alpha,
    left, top, width, height, coverage);
}

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
    face->shapingParent = hb_font_create(face->face);
    hb_ot_font_set_funcs(face->shapingParent);
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

static int draw(pmjs_skia65_font* font, const char* utf8, size_t utf8Bytes,
  const pmjs_skia65_style* style, float x, float baseline, uint8_t* rgba,
  int width, int height, size_t rowBytes, int originX, int originY, bool bgra) try {
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
  // Raster text writes directly to native N32 (BGRA on Linux). Accelerated
  // text needs bounded source coverage before rounded destination composition.
  std::vector<uint8_t> scratch;
  if (!bgra || style->accelerated_blend) scratch.resize(static_cast<size_t>(croppedWidth) * croppedHeight * 4);
  if (!bgra && !style->accelerated_blend) for (int row = 0; row < croppedHeight; ++row) for (int column = 0; column < croppedWidth; ++column) {
    const auto* input = rgba + (top + row) * rowBytes + (left + column) * 4;
    auto* output = scratch.data() + (static_cast<size_t>(row) * croppedWidth + column) * 4;
    output[0] = input[2]; output[1] = input[1]; output[2] = input[0]; output[3] = input[3];
  }
  auto surface = SkSurface::MakeRasterDirect(
    SkImageInfo::MakeN32(croppedWidth, croppedHeight, kPremul_SkAlphaType),
    bgra && !style->accelerated_blend ? rgba + top * rowBytes + left * 4 : scratch.data(),
    bgra && !style->accelerated_blend ? rowBytes : croppedWidth * 4);
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
  if (style->transformed) {
    const auto* t = style->transform;
    SkMatrix matrix; matrix.setAll(t[0], t[2], t[4], t[1], t[3], t[5], 0, 0, 1);
    surface->getCanvas()->concat(matrix);
  }
  if (run.blob) surface->getCanvas()->drawTextBlob(run.blob, x, baseline, paint);
  if (!bgra || style->accelerated_blend) for (int row = 0; row < croppedHeight; ++row) for (int column = 0; column < croppedWidth; ++column) {
    const auto* input = scratch.data() + (static_cast<size_t>(row) * croppedWidth + column) * 4;
    auto* output = rgba + (top + row) * rowBytes + (left + column) * 4;
    if (style->accelerated_blend) {
      // Accelerated source-over rounds normalized channel products, whereas
      // the raster blitter truncates its 256-based destination contribution.
      for (int channel = 0; channel < 4; ++channel) {
        const int sourceChannel = bgra || channel == 1 || channel == 3 ? channel : 2 - channel;
        output[channel] = std::min(255, input[sourceChannel] +
          (output[channel] * (255 - input[3]) + 127) / 255);
      }
    } else {
      output[0] = input[2]; output[1] = input[1]; output[2] = input[0]; output[3] = input[3];
    }
  }
  if (telemetryEnabled) counters.draw_ns += elapsed(start);
  return 1;
} catch (...) { return 0; }

int pmjs_skia65_draw(pmjs_skia65_font* font, const char* utf8, size_t utf8Bytes,
  const pmjs_skia65_style* style, float x, float baseline, uint8_t* rgba,
  int width, int height, size_t rowBytes, int originX, int originY) {
  return draw(font, utf8, utf8Bytes, style, x, baseline, rgba, width, height, rowBytes, originX, originY, false);
}

int pmjs_skia65_draw_bgra(pmjs_skia65_font* font, const char* utf8, size_t utf8Bytes,
  const pmjs_skia65_style* style, float x, float baseline, uint8_t* bgra,
  int width, int height, size_t rowBytes, int originX, int originY) {
  return draw(font, utf8, utf8Bytes, style, x, baseline, bgra, width, height, rowBytes, originX, originY, true);
}

void pmjs_skia65_font_cache_stats(pmjs_skia65_font* font, size_t* bytes, size_t* entries, size_t* metricBytes) {
  if (bytes) *bytes = font ? font->layoutBytes : 0;
  if (entries) *entries = font ? font->layouts.size() : 0;
  if (metricBytes) {
    *metricBytes = 0;
    if (font) for (const auto& face : font->faces)
      *metricBytes += face->metrics.size() * sizeof(GlyphMetrics);
  }
}

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

#include "SkColorSpace.h"
#include "SkColorSpaceXform.h"
#include "SkMatrix44.h"
void* pmjs_skia65_color_icc(const void* data, size_t size) {
  auto source = SkColorSpace::MakeICC(data, size);
  return source ? SkColorSpaceXform::New(source.get(), SkColorSpace::MakeSRGB().get()).release() : nullptr;
}
void* pmjs_skia65_color_rgb(const float p[8], float gamma) {
  SkColorSpacePrimaries primaries{p[0],p[1],p[2],p[3],p[4],p[5],p[6],p[7]};
  SkMatrix44 matrix(SkMatrix44::kUninitialized_Constructor);
  if (!primaries.toXYZD50(&matrix)) return nullptr;
  SkColorSpaceTransferFn fn{gamma,1,0,0,0,0,0};
  auto source = SkColorSpace::MakeRGB(fn, matrix);
  return source ? SkColorSpaceXform::New(source.get(), SkColorSpace::MakeSRGB().get()).release() : nullptr;
}
void pmjs_skia65_color_apply(void* transform, uint8_t* rgba, int count) {
  static_cast<SkColorSpaceXform*>(transform)->apply(SkColorSpaceXform::kRGBA_8888_ColorFormat,
    rgba, SkColorSpaceXform::kRGBA_8888_ColorFormat, rgba, count, kUnpremul_SkAlphaType);
}
void pmjs_skia65_color_close(void* transform) { delete static_cast<SkColorSpaceXform*>(transform); }
