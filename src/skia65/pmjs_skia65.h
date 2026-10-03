#ifndef PMJS_SKIA65_H
#define PMJS_SKIA65_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define PMJS_SKIA65_API __attribute__((visibility("default")))
typedef struct pmjs_skia65_font pmjs_skia65_font;

typedef struct {
  float size;
  float stroke_width;
  float miter_limit;
  uint32_t rgba;
  int stroke;
  int join; /* 0=miter, 1=round, 2=bevel */
  int cap; /* 0=butt, 1=round, 2=square */
  int bold;
  int italic;
  int hinting; /* SkPaint: 0=none, 1=slight, 2=normal, 3=full */
  int auto_hint;
} pmjs_skia65_style;

typedef struct {
  double width;
  float left, right, ascent, descent, font_ascent, font_descent;
} pmjs_skia65_metrics;

typedef struct {
  size_t cache_bytes, cache_limit, cache_entries;
  uint64_t layout_requests, layout_hits, draw_calls, shape_ns, draw_ns;
} pmjs_skia65_stats;

PMJS_SKIA65_API const char* pmjs_skia65_identity(void);
PMJS_SKIA65_API pmjs_skia65_font* pmjs_skia65_font_open(const char* filename);
PMJS_SKIA65_API pmjs_skia65_font* pmjs_skia65_font_open_many(const char* const* filenames, size_t count);
PMJS_SKIA65_API void pmjs_skia65_font_close(pmjs_skia65_font* font);
/* Returns 0 on invalid/unsupported input.
 * Drawing uses caller-owned premultiplied RGBA8, including existing pixels. */
PMJS_SKIA65_API int pmjs_skia65_measure(pmjs_skia65_font* font, const char* utf8, size_t utf8_bytes,
  const pmjs_skia65_style* style, double* advance);
PMJS_SKIA65_API int pmjs_skia65_draw(pmjs_skia65_font* font, const char* utf8, size_t utf8_bytes,
  const pmjs_skia65_style* style, float x, float baseline, uint8_t* rgba,
  int width, int height, size_t row_bytes, int origin_x, int origin_y);
PMJS_SKIA65_API int pmjs_skia65_draw_bgra(pmjs_skia65_font* font, const char* utf8, size_t utf8_bytes,
  const pmjs_skia65_style* style, float x, float baseline, uint8_t* bgra,
  int width, int height, size_t row_bytes, int origin_x, int origin_y);
PMJS_SKIA65_API int pmjs_skia65_measure_metrics(pmjs_skia65_font* font, const char* utf8, size_t utf8_bytes,
  const pmjs_skia65_style* style, pmjs_skia65_metrics* metrics);
PMJS_SKIA65_API void pmjs_skia65_get_stats(pmjs_skia65_stats* stats);
PMJS_SKIA65_API void pmjs_skia65_cache_limits(size_t bytes, int entries);
/* Conservative clipped ink bounds [left, top, right, bottom]; empty = all zero.
 * Integer crop translation preserves the release's glyph subpixel phase. */
PMJS_SKIA65_API int pmjs_skia65_bounds(pmjs_skia65_font* font, const char* utf8, size_t utf8_bytes,
  const pmjs_skia65_style* style, float x, float baseline, int width, int height, int bounds[4]);
PMJS_SKIA65_API void pmjs_skia65_font_cache_stats(pmjs_skia65_font* font, size_t* bytes, size_t* entries, size_t* metric_bytes);
PMJS_SKIA65_API void pmjs_skia65_set_telemetry(int enabled);

#ifdef __cplusplus
}
#endif
#endif
