#pragma once

#include <algorithm>
#include <array>
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
    std::vector<std::uint8_t> horizontal(static_cast<std::size_t>(width) * 4);
    std::array<int, 2> filteredRows{-1, -1};
    const auto filterRow = [&](int row) {
      const int slot = row % 2;
      if (filteredRows[slot] == row) return;
      auto* filteredU = horizontal.data() + static_cast<std::size_t>(slot) * width * 2;
      auto* filteredV = filteredU + width;
      const auto* sourceU = uPlane + row * cw;
      const auto* sourceV = vPlane + row * cw;
      for (int x = 0; x < width; ++x) {
        // Centre-sited x/2 - 1/4, with rounding before vertical interpolation.
        const int x0 = x / 2 - (x % 2 == 0);
        const int wx = x % 2 == 0 ? 3 : 1;
        const int left = std::clamp(x0, 0, cw - 1), right = std::clamp(x0 + 1, 0, cw - 1);
        filteredU[x] = (sourceU[left] * (4 - wx) + sourceU[right] * wx + 2) / 4;
        filteredV[x] = (sourceV[left] * (4 - wx) + sourceV[right] * wx + 2) / 4;
      }
      filteredRows[slot] = row;
    };
    const auto byte = [](double value) {
      return static_cast<std::uint8_t>(std::clamp(static_cast<int>(value + 0.5), 0, 255));
    };
    // Chromium 65's float32 inverse Rec.601 transfer * limited-range matrix.
    // Keep its small nonzero cross terms and bias rounding at byte boundaries.
    static constexpr float matrix[3][4] = {
      {1.1643835306167603F, -1.5562882533797233e-08F, 1.5960266590118408F, -0.8710727095603943F},
      {1.1643836498260498F, -0.39176228642463684F, -0.8129676580429077F, 0.529305636882782F},
      {1.1643835306167603F, 2.0172319412231445F, 1.2258721153739498e-08F, -1.081675410270691F}
    };
    static const auto products = [] {
      std::array<std::array<std::array<float, 256>, 3>, 3> values{};
      for (int channel = 0; channel < 3; ++channel)
        for (int component = 0; component < 3; ++component)
          for (int code = 0; code < 256; ++code) {
            const float normalized = static_cast<float>(code) / 255.0F;
            values[channel][component][code] = normalized * matrix[channel][component];
          }
      return values;
    }();
    for (int y = 0; y < height; ++y) {
      const int y0 = y / 2 - (y % 2 == 0), wy = y % 2 == 0 ? 3 : 1;
      const int top = std::clamp(y0, 0, ch - 1), bottom = std::clamp(y0 + 1, 0, ch - 1);
      filterRow(top);
      filterRow(bottom);
      const auto* topU = horizontal.data() + static_cast<std::size_t>(top % 2) * width * 2;
      const auto* bottomU = horizontal.data() + static_cast<std::size_t>(bottom % 2) * width * 2;
      const auto* topV = topU + width;
      const auto* bottomV = bottomU + width;
      for (int x = 0; x < width; ++x) {
        const auto index = static_cast<std::size_t>(y) * width + x;
        const int luma = planes[index];
        const int u = (topU[x] * (4 - wy) + bottomU[x] * wy + 2) / 4;
        const int v = (topV[x] * (4 - wy) + bottomV[x] * wy + 2) / 4;
        auto* out = rgba.data() + index * 4;
        if (canvas) {
          // The GPU canvas/texture conversion uses the Skia Rec.601 constants.
          out[0] = byte(1.164 * luma + 1.596 * v - 0.87075 * 255);
          out[1] = byte(1.164 * luma - 0.391 * u - 0.813 * v + 0.52925 * 255);
          out[2] = byte(1.164 * luma + 2.018 * u - 1.08175 * 255);
        } else {
          for (int channel = 0; channel < 3; ++channel) {
            // Keep float32 intermediate rounding on every target.
            float value = products[channel][0][luma];
            value = value + products[channel][1][u];
            value = value + products[channel][2][v];
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
