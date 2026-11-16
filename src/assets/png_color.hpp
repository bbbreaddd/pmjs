#pragma once
#ifdef PMJS_HAS_SKIA65
#include "skia65/pmjs_skia65.h"
#endif
#include <png.h>

namespace pmjs {
struct ImageColorTransform {
  ImageColorTransform() = default;
  ImageColorTransform(const ImageColorTransform &) = delete;
  ImageColorTransform &operator=(const ImageColorTransform &) = delete;
  void *value = nullptr;
  ~ImageColorTransform() { reset(); }
  void reset() {
#ifdef PMJS_HAS_SKIA65
    pmjs_skia65_color_close(value);
#endif
    value = nullptr;
  }
  void icc(const void *data, size_t size) {
#ifdef PMJS_HAS_SKIA65
    reset();
    value = pmjs_skia65_color_icc(data, size);
#else
    (void)data;
    (void)size;
#endif
  }
  void apply(unsigned char *rgba, int count) const {
#ifdef PMJS_HAS_SKIA65
    if (value)
      pmjs_skia65_color_apply(value, rgba, count);
#else
    (void)rgba;
    (void)count;
#endif
  }
};
inline void configurePng(png_structp png, png_infop info, ImageColorTransform &transform) {
  const int color = png_get_color_type(png, info);
  const int depth = png_get_bit_depth(png, info);
  if (color & PNG_COLOR_MASK_COLOR) {
    png_charp name;
    int compression;
    png_bytep profile;
    png_uint_32 length;
    if (!png_get_valid(png, info, PNG_INFO_sRGB)) {
      if (png_get_iCCP(png, info, &name, &compression, &profile, &length))
        transform.icc(profile, length);
#ifdef PMJS_HAS_SKIA65
      else {
        double wX, wY, rX, rY, gX, gY, bX, bY, gamma;
        if (png_get_cHRM(png, info, &wX, &wY, &rX, &rY, &gX, &gY, &bX, &bY) &&
            png_get_gAMA(png, info, &gamma) && gamma > 0) {
          const float primaries[] = {float(rX), float(rY), float(gX), float(gY),
                                     float(bX), float(bY), float(wX), float(wY)};
          transform.value = pmjs_skia65_color_rgb(primaries, float(1 / gamma));
        }
      }
#endif
    }
  }
  // Quantize encoded samples before gamma or profile conversion.
  if (depth == 16)
    png_set_strip_16(png);
  if (color == PNG_COLOR_TYPE_PALETTE)
    png_set_palette_to_rgb(png);
  if (color == PNG_COLOR_TYPE_GRAY && depth < 8)
    png_set_expand_gray_1_2_4_to_8(png);
  const bool transparent = png_get_valid(png, info, PNG_INFO_tRNS);
  if (transparent)
    png_set_tRNS_to_alpha(png);
  if (!(color & PNG_COLOR_MASK_COLOR))
    png_set_gray_to_rgb(png);
  if (!(color & PNG_COLOR_MASK_ALPHA) && !transparent)
    png_set_add_alpha(png, 255, PNG_FILLER_AFTER);
  if (!transform.value) {
    double gamma = 0.45455;
    png_get_gAMA(png, info, &gamma);
    if (!(gamma > 0 && gamma <= 21474.83))
      gamma = 0.45455;
    png_set_gamma(png, 2.2, gamma);
  }
}
} // namespace pmjs
