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
  int transformed;
  float transform[6];
  int accelerated_blend; /* Rounded source-over for accelerated Canvas text. */
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
PMJS_SKIA65_API int pmjs_skia65_rect_bgra(uint8_t* pixels, int width, int height,
  int left, int top, const float rect[4], uint32_t color, float stroke,
  const float gradient[4], const float* offsets, const uint32_t* colors, size_t count);
PMJS_SKIA65_API int pmjs_skia65_image_bgra(uint8_t* pixels, int width, int height,
  int left, int top, const uint8_t* source, int source_width, int source_height,
  const float src[4], const float dst[4], float alpha, int smoothing);
/* Strided destinations and BGRA sources are premultiplied; image_rgba sources are straight. */
PMJS_SKIA65_API int pmjs_skia65_rect_bgra_strided(uint8_t* pixels, int width, int height,
  size_t row_bytes, int left, int top, const float rect[4], uint32_t color, float stroke,
  const float gradient[4], const float* offsets, const uint32_t* colors, size_t count);
PMJS_SKIA65_API int pmjs_skia65_image_bgra_strided(uint8_t* pixels, int width, int height,
  size_t row_bytes, int left, int top, const uint8_t* source, int source_width, int source_height,
  size_t source_row_bytes, const float src[4], const float dst[4], float alpha, int smoothing);
PMJS_SKIA65_API int pmjs_skia65_image_rgba_strided(uint8_t* pixels, int width, int height,
  size_t row_bytes, int left, int top, const uint8_t* source, int source_width, int source_height,
  size_t source_row_bytes, const float src[4], const float dst[4], float alpha, int smoothing);
PMJS_SKIA65_API int pmjs_skia65_image_premul_rgba_strided(uint8_t* pixels, int width, int height,
  size_t row_bytes, int left, int top, const uint8_t* source, int source_width, int source_height,
  size_t source_row_bytes, const float src[4], const float dst[4], float alpha, int smoothing);
PMJS_SKIA65_API int pmjs_skia65_circle_coverage(float x, float y, float radius,
  const float transform[6], int left, int top, int width, int height, uint8_t* coverage, const float* clips, size_t clip_count);
/* Path points are in destination space; stroke geometry uses the supplied transform. */
PMJS_SKIA65_API int pmjs_skia65_path_coverage(const float* points,
  const uint32_t* sizes, const uint8_t* closed, size_t count,
  const float* commands, size_t command_count, const float* dash, size_t dash_count, float dash_offset,
  const float transform[6],
  float stroke, int cap, int join, float miter_limit, int antialias, int even_odd,
  int left, int top, int width, int height, uint8_t* coverage);
typedef struct {
  int kind, composite, clear;
  uint32_t color;
  float alpha, geometry[6], transform[6];
  const float* offsets;
  const uint32_t* colors;
  size_t count;
  const float* clip_points;
  const uint32_t* clip_sizes;
  const uint32_t* clip_counts;
  const uint8_t* clip_even_odd;
  size_t clip_count;
} pmjs_skia65_path_style;
PMJS_SKIA65_API int pmjs_skia65_path_bgra(const float* points,
  const uint32_t* sizes, const uint8_t* closed, size_t count,
  const float* commands, size_t command_count, const float* dash, size_t dash_count, float dash_offset,
  const float transform[6],
  float stroke, int cap, int join, float miter_limit, int antialias, int even_odd,
  int left, int top, int width, int height, uint8_t* pixels, size_t row_bytes, const pmjs_skia65_path_style* style);
PMJS_SKIA65_API int pmjs_skia65_shadow_bgra(const uint8_t* source, int source_width, int source_height,
  float x, float y, float blur, uint32_t color, int geometry_mask, uint8_t* pixels, int width, int height);
/* RGBA8: fill coverage, first stroke, packed two-bit span rules, second stroke. */
PMJS_SKIA65_API int pmjs_skia65_polygon_coverage(const float* points, size_t point_count,
  float stroke_width, float miter_limit, float stroke_alpha,
  float left, float top, int width, int height, uint8_t* coverage);
PMJS_SKIA65_API int pmjs_skia65_triangle_coverage(const float points[6],
  float stroke_width, float miter_limit, float stroke_alpha,
  float left, float top, int width, int height, uint8_t* coverage);
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

PMJS_SKIA65_API void* pmjs_skia65_color_icc(const void* data, size_t size);
PMJS_SKIA65_API void* pmjs_skia65_color_rgb(const float primaries[8], float gamma);
PMJS_SKIA65_API void pmjs_skia65_color_apply(void* transform, uint8_t* rgba, int count);
PMJS_SKIA65_API void pmjs_skia65_color_close(void* transform);

#ifdef __cplusplus
}
#endif
#endif
