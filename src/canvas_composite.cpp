#include "canvas_composite.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace pmjs {
CanvasComposite canvasComposite(std::string_view name) {
  constexpr std::string_view names[] = {
    "source-over", "source-in", "source-out", "source-atop", "destination-over",
    "destination-in", "destination-out", "destination-atop", "lighter", "copy", "xor",
    "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn",
    "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"
  };
  for (unsigned i = 0; i < std::size(names); ++i)
    if (names[i] == name) return static_cast<CanvasComposite>(i);
  throw std::invalid_argument("invalid Canvas composite operation");
}

bool canvasCompositeClearsOutside(CanvasComposite operation) {
  return operation == CanvasComposite::sourceIn || operation == CanvasComposite::sourceOut ||
    operation == CanvasComposite::destinationIn || operation == CanvasComposite::destinationAtop ||
    operation == CanvasComposite::copy;
}

namespace {
using Color = std::array<double, 3>;
double luminosity(const Color& c) { return 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]; }
double saturation(const Color& c) {
  const auto [low, high] = std::minmax_element(c.begin(), c.end());
  return *high - *low;
}
Color setLuminosity(Color c, double lum) {
  const double delta = lum - luminosity(c);
  for (auto& channel : c) channel += delta;
  const double low = *std::min_element(c.begin(), c.end());
  const double high = *std::max_element(c.begin(), c.end());
  if (low < 0) for (auto& channel : c) channel = lum + (channel - lum) * lum / (lum - low);
  if (high > 1) for (auto& channel : c) channel = lum + (channel - lum) * (1 - lum) / (high - lum);
  return c;
}
Color setSaturation(Color c, double sat) {
  std::array<unsigned, 3> order = {0, 1, 2};
  std::sort(order.begin(), order.end(), [&](unsigned a, unsigned b) { return c[a] < c[b]; });
  const auto lo = order[0], mid = order[1], hi = order[2];
  if (c[hi] > c[lo]) {
    c[mid] = (c[mid] - c[lo]) * sat / (c[hi] - c[lo]);
    c[hi] = sat;
  } else { c[mid] = c[hi] = 0; }
  c[lo] = 0;
  return c;
}
Color blend(Color backdrop, Color source, CanvasComposite operation) {
  switch (operation) {
    case CanvasComposite::hue: return setLuminosity(setSaturation(source, saturation(backdrop)), luminosity(backdrop));
    case CanvasComposite::saturation: return setLuminosity(setSaturation(backdrop, saturation(source)), luminosity(backdrop));
    case CanvasComposite::color: return setLuminosity(source, luminosity(backdrop));
    case CanvasComposite::luminosity: return setLuminosity(backdrop, luminosity(source));
    default: break;
  }
  Color output{};
  for (unsigned i = 0; i < 3; ++i) {
    const double b = backdrop[i], s = source[i];
    switch (operation) {
      case CanvasComposite::multiply: output[i] = b * s; break;
      case CanvasComposite::screen: output[i] = b + s - b * s; break;
      case CanvasComposite::overlay: output[i] = b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s); break;
      case CanvasComposite::darken: output[i] = std::min(b, s); break;
      case CanvasComposite::lighten: output[i] = std::max(b, s); break;
      case CanvasComposite::colorDodge: output[i] = b == 0 ? 0 : s == 1 ? 1 : std::min(1.0, b / (1 - s)); break;
      case CanvasComposite::colorBurn: output[i] = b == 1 ? 1 : s == 0 ? 0 : 1 - std::min(1.0, (1 - b) / s); break;
      case CanvasComposite::hardLight: output[i] = s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s); break;
      case CanvasComposite::softLight: {
        const double d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : std::sqrt(b);
        output[i] = s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (d - b);
        break;
      }
      case CanvasComposite::difference: output[i] = std::abs(b - s); break;
      case CanvasComposite::exclusion: output[i] = b + s - 2 * b * s; break;
      default: throw std::invalid_argument("invalid Canvas blend operation");
    }
  }
  return output;
}
}

void compositeCanvasPixel(std::uint8_t* destination, const std::array<double, 4>& source,
                          CanvasComposite operation, bool skiaCoverageRounding) {
  // Skia65 byte-coverage draws use a 256-based source-over row kernel.
  if (skiaCoverageRounding && operation == CanvasComposite::sourceOver) {
    const int alpha = static_cast<int>(source[3]), inverse = 256 - alpha;
    for (unsigned i = 0; i < 3; ++i) {
      const int color = alpha ? static_cast<int>(source[i]) : 0;
      destination[2 - i] = std::clamp(color + (destination[2 - i] * inverse >> 8), 0, 255);
    }
    destination[3] = std::clamp(alpha + (destination[3] * inverse >> 8), 0, 255);
    return;
  }
  const double sa = source[3] / 255.0, da = destination[3] / 255.0;
  Color sc = {source[0], source[1], source[2]};
  const Color dc = {double(destination[2]), double(destination[1]), double(destination[0])};
  if (sa == 0 && operation == CanvasComposite::sourceOver) sc = {};
  double sf = 1, df = 1 - sa;
  switch (operation) {
    case CanvasComposite::sourceOver: break;
    case CanvasComposite::sourceIn: sf = da; df = 0; break;
    case CanvasComposite::sourceOut: sf = 1 - da; df = 0; break;
    case CanvasComposite::sourceAtop: sf = da; df = 1 - sa; break;
    case CanvasComposite::destinationOver: sf = 1 - da; df = 1; break;
    case CanvasComposite::destinationIn: sf = 0; df = sa; break;
    case CanvasComposite::destinationOut: sf = 0; df = 1 - sa; break;
    case CanvasComposite::destinationAtop: sf = 1 - da; df = sa; break;
    case CanvasComposite::lighter: sf = df = 1; break;
    case CanvasComposite::copy: df = 0; break;
    case CanvasComposite::xorOp: sf = 1 - da; df = 1 - sa; break;
    default: {
      Color s{}, d{};
      for (unsigned i = 0; i < 3; ++i) {
        s[i] = sa ? std::clamp(sc[i] / source[3], 0.0, 1.0) : 0;
        d[i] = da ? std::clamp(dc[i] / destination[3], 0.0, 1.0) : 0;
      }
      const auto mixed = blend(d, s, operation);
      for (unsigned i = 0; i < 3; ++i) sc[i] = sc[i] * (1 - da) + 255 * sa * da * mixed[i];
      break;
    }
  }
  const auto byte = [](double value) { return static_cast<std::uint8_t>(std::clamp(std::round(value), 0.0, 255.0)); };
  for (unsigned i = 0; i < 3; ++i) destination[2 - i] = byte(sc[i] * sf + dc[i] * df);
  destination[3] = byte(255 * (sa * sf + da * df));
}
}  // namespace pmjs
