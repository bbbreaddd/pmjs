#pragma once

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <stdexcept>

namespace pmjs {
enum class PixelEncoding { StraightRGBA8, PremultipliedRGBA8, PremultipliedBGRA8 };

// Views never own or expose Canvas storage to JavaScript. Rows are top-down.
template<class Byte> struct BasicPixelView {
  Byte* data;
  int width, height;
  std::size_t rowBytes;
  PixelEncoding encoding;

  BasicPixelView(Byte* pixels, std::size_t bytes, int w, int h,
                 std::size_t stride, PixelEncoding format)
      : data(pixels), width(w), height(h), rowBytes(stride), encoding(format) {
    if (w <= 0 || h <= 0 || static_cast<std::size_t>(w) > SIZE_MAX / 4 ||
        stride < static_cast<std::size_t>(w) * 4 ||
        static_cast<std::size_t>(h - 1) > (SIZE_MAX - static_cast<std::size_t>(w) * 4) / stride ||
        !pixels || bytes < static_cast<std::size_t>(h - 1) * stride + static_cast<std::size_t>(w) * 4)
      throw std::invalid_argument("invalid pixel view");
  }
  Byte* row(int y) const { return data + static_cast<std::size_t>(y) * rowBytes; }
};
using PixelView = BasicPixelView<std::uint8_t>;
using ConstPixelView = BasicPixelView<const std::uint8_t>;

inline constexpr std::uint8_t importCanvasChannel(unsigned color, unsigned alpha) {
  return (color * alpha + 127) / 255;
}
inline constexpr auto canvasReciprocals = [] {
  std::array<std::uint32_t, 256> values{};
  for (unsigned alpha = 1; alpha < 256; ++alpha)
    values[alpha] = ((std::uint64_t{255} << 24) + (alpha >> 1)) / alpha;
  return values;
}();
inline constexpr std::uint8_t exportCanvasChannel(unsigned color, unsigned alpha) {
  return std::min<std::uint64_t>(255,
    (std::uint64_t{canvasReciprocals[alpha]} * color + (1U << 23)) >> 24);
}

inline void convertPixel(const std::uint8_t* source, PixelEncoding from,
                         std::uint8_t* destination, PixelEncoding to) {
  const unsigned alpha = source[3];
  const unsigned red = source[from == PixelEncoding::PremultipliedBGRA8 ? 2 : 0];
  const unsigned green = source[1];
  const unsigned blue = source[from == PixelEncoding::PremultipliedBGRA8 ? 0 : 2];
  const auto channel = [&](unsigned value) -> std::uint8_t {
    if (from == PixelEncoding::StraightRGBA8 && to != from) return importCanvasChannel(value, alpha);
    if (to == PixelEncoding::StraightRGBA8 && from != to) return exportCanvasChannel(value, alpha);
    return value;
  };
  destination[to == PixelEncoding::PremultipliedBGRA8 ? 2 : 0] = channel(red);
  destination[1] = channel(green);
  destination[to == PixelEncoding::PremultipliedBGRA8 ? 0 : 2] = channel(blue);
  destination[3] = alpha;
}
inline void convertPixels(ConstPixelView source, PixelView destination) {
  if (source.width != destination.width || source.height != destination.height)
    throw std::invalid_argument("pixel view dimensions differ");
  for (int y = 0; y < source.height; ++y)
    for (int x = 0; x < source.width; ++x)
      convertPixel(source.row(y) + x * 4, source.encoding,
                   destination.row(y) + x * 4, destination.encoding);
}
}  // namespace pmjs
