#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

namespace pmjs {

// Packed, immutable 8-bit limited-range Rec.601 planes with centred chroma.
// This backing is retained only for browser-compatible decoded frames.
struct VideoYuv420 {
  int width = 0, height = 0;
  std::vector<std::uint8_t> planes;

#if defined(__GNUC__) && !defined(__clang__)
  __attribute__((optimize("fp-contract=off")))
#endif
  void convert(std::vector<std::uint8_t>& rgba, bool canvas) const {
#if defined(__clang__)
#pragma clang fp contract(off)
#endif
    const int cw = (width + 1) / 2, ch = (height + 1) / 2;
    const auto yBytes = static_cast<std::size_t>(width) * height;
    const auto cBytes = static_cast<std::size_t>(cw) * ch;
    rgba.resize(yBytes * 4);
    const auto* uPlane = planes.data() + yBytes;
    const auto* vPlane = uPlane + cBytes;
    const auto chroma = [cw, ch](const std::uint8_t* plane, int x, int y) {
      // Sample x/2 - 1/4 and y/2 - 1/4, rounding after EACH axis.
      // GL's 8-bit linear sampling is separable; a single bilerp changes bytes.
      const int x0 = x / 2 - (x % 2 == 0), y0 = y / 2 - (y % 2 == 0);
      const int wx = x % 2 == 0 ? 3 : 1, wy = y % 2 == 0 ? 3 : 1;
      const int left = std::clamp(x0, 0, cw - 1), right = std::clamp(x0 + 1, 0, cw - 1);
      const int top = std::clamp(y0, 0, ch - 1), bottom = std::clamp(y0 + 1, 0, ch - 1);
      const int a = (plane[top * cw + left] * (4 - wx) + plane[top * cw + right] * wx + 2) / 4;
      const int b = (plane[bottom * cw + left] * (4 - wx) + plane[bottom * cw + right] * wx + 2) / 4;
      return (a * (4 - wy) + b * wy + 2) / 4;
    };
    const auto byte = [](double value) {
      return static_cast<std::uint8_t>(std::clamp(std::floor(value + 0.5), 0.0, 255.0));
    };
    // Chromium 65's float32 inverse Rec.601 transfer * limited-range matrix.
    // Keep its small nonzero cross terms and bias rounding at byte boundaries.
    constexpr float matrix[3][4] = {
      {1.1643835306167603F, -1.5562882533797233e-08F, 1.5960266590118408F, -0.8710727095603943F},
      {1.1643836498260498F, -0.39176228642463684F, -0.8129676580429077F, 0.529305636882782F},
      {1.1643835306167603F, 2.0172319412231445F, 1.2258721153739498e-08F, -1.081675410270691F}
    };
    for (int y = 0; y < height; ++y) {
      for (int x = 0; x < width; ++x) {
        const auto index = static_cast<std::size_t>(y) * width + x;
        const int luma = planes[index], u = chroma(uPlane, x, y), v = chroma(vPlane, x, y);
        auto* out = rgba.data() + index * 4;
        if (canvas) {
          // The GPU canvas/texture conversion uses the Skia Rec.601 constants.
          out[0] = byte(1.164 * luma + 1.596 * v - 0.87075 * 255);
          out[1] = byte(1.164 * luma - 0.391 * u - 0.813 * v + 0.52925 * 255);
          out[2] = byte(1.164 * luma + 2.018 * u - 1.08175 * 255);
        } else {
          const float fy = static_cast<float>(luma) / 255.0F;
          const float fu = static_cast<float>(u) / 255.0F;
          const float fv = static_cast<float>(v) / 255.0F;
          for (int channel = 0; channel < 3; ++channel) {
            // Keep float32 intermediate rounding on every target.
            float value = fy * matrix[channel][0];
            float product = fu * matrix[channel][1];
            value = value + product;
            product = fv * matrix[channel][2];
            value = value + product;
            value = value + matrix[channel][3];
            value = value * 255.0F;
            out[channel] = byte(value);
          }
        }
        out[3] = 255;
      }
    }
  }
};

}  // namespace pmjs
