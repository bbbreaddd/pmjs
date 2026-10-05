#include "canvas.hpp"
#include "checked_bounds.hpp"

#include <algorithm>
#include <cmath>

namespace pmjs {
namespace {
bool contains(const CanvasClip& clip, double x, double y) {
  int crossings = 0, winding = 0;
  for (const auto& path : clip.paths) {
    for (size_t i = 0; i < path.size(); ++i) {
      const auto& a = path[i];
      const auto& b = path[(i + 1) % path.size()];
      if ((a[1] > y) != (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) {
        ++crossings;
        winding += b[1] > a[1] ? 1 : -1;
      }
    }
  }
  return clip.evenOdd ? (crossings & 1) != 0 : winding != 0;
}
bool passesClips(const std::vector<CanvasClip>& clips, double x, double y) {
  return std::all_of(clips.begin(), clips.end(), [&](const auto& clip) { return contains(clip, x, y); });
}
bool validPaint(const CanvasPaint& paint) {
  if (!std::all_of(paint.geometry.begin(), paint.geometry.end(), [](double v) { return std::isfinite(v); }) ||
      !std::all_of(paint.transform.begin(), paint.transform.end(), [](double v) { return std::isfinite(v); }) ||
      paint.offsets.size() != paint.colors.size()) return false;
  for (size_t i = 0; i < paint.offsets.size(); ++i)
    if (!std::isfinite(paint.offsets[i]) || paint.offsets[i] < 0 || paint.offsets[i] > 1 ||
        (i && paint.offsets[i] < paint.offsets[i - 1])) return false;
  if (paint.kind == CanvasPaint::Kind::radial && (paint.geometry[2] < 0 || paint.geometry[5] < 0)) return false;
  if (paint.kind == CanvasPaint::Kind::pattern) {
    const auto extent = checkedImageExtent(paint.width, paint.height);
    return extent && paint.pixels.size() == extent->rgbaBytes &&
      (paint.repeat == "repeat" || paint.repeat == "repeat-x" || paint.repeat == "repeat-y" || paint.repeat == "no-repeat");
  }
  return true;
}
std::array<double, 4> samplePaint(const CanvasPaint& paint, double x, double y) {
  if (paint.kind == CanvasPaint::Kind::pattern) {
    const auto& t = paint.transform;
    const double determinant = t[0] * t[3] - t[1] * t[2];
    if (!std::isfinite(determinant) || std::abs(determinant) < 0.000001) return {};
    const double px = x - t[4], py = y - t[5];
    double sx = std::floor((t[3] * px - t[2] * py) / determinant);
    double sy = std::floor((-t[1] * px + t[0] * py) / determinant);
    if (!std::isfinite(sx) || !std::isfinite(sy)) return {};
    if (paint.repeat == "repeat" || paint.repeat == "repeat-x") sx = std::fmod(std::fmod(sx, paint.width) + paint.width, paint.width);
    else if (sx < 0 || sx >= paint.width) return {};
    if (paint.repeat == "repeat" || paint.repeat == "repeat-y") sy = std::fmod(std::fmod(sy, paint.height) + paint.height, paint.height);
    else if (sy < 0 || sy >= paint.height) return {};
    const size_t offset = (static_cast<size_t>(sy) * paint.width + static_cast<size_t>(sx)) * 4;
    return {double(paint.pixels[offset]), double(paint.pixels[offset + 1]),
            double(paint.pixels[offset + 2]), double(paint.pixels[offset + 3])};
  }
  uint32_t color = paint.color;
  if (paint.kind != CanvasPaint::Kind::solid) {
    if (paint.offsets.empty()) return {};
    const auto& g = paint.geometry;
    const double dx = g[3] - g[0], dy = g[4] - g[1], px = x - g[0], py = y - g[1];
    double amount = 0;
    if (paint.kind == CanvasPaint::Kind::linear) {
      const double length = dx * dx + dy * dy;
      amount = length ? (px * dx + py * dy) / length : 0;
    } else {
      const double dr = g[5] - g[2];
      if (std::abs(dx) < 0.000001 && std::abs(dy) < 0.000001) {
        amount = dr ? (std::hypot(px, py) - g[2]) / dr : 0;
      } else {
        const double a = dx * dx + dy * dy - dr * dr;
        const double b = -2 * (px * dx + py * dy + g[2] * dr);
        const double c = px * px + py * py - g[2] * g[2];
        const double discriminant = b * b - 4 * a * c;
        if (discriminant >= 0) amount = std::abs(a) < 0.000001 ?
          (std::abs(b) < 0.000001 ? 0 : -c / b) : (-b + std::sqrt(discriminant)) / (2 * a);
      }
    }
    if (!std::isfinite(amount)) return {};
    amount = std::clamp(amount, 0.0, 1.0);
    size_t lower = 0, upper = paint.offsets.size() - 1;
    for (size_t i = 1; i < paint.offsets.size(); ++i) if (paint.offsets[i] >= amount) { lower = i - 1; upper = i; break; }
    const double span = paint.offsets[upper] - paint.offsets[lower];
    const double mix = span ? std::clamp((amount - paint.offsets[lower]) / span, 0.0, 1.0) : 0;
    color = 0;
    for (unsigned shift : {24U, 16U, 8U, 0U}) {
      const double a = (paint.colors[lower] >> shift) & 255, b = (paint.colors[upper] >> shift) & 255;
      color |= static_cast<uint32_t>(std::round(a * (1 - mix) + b * mix)) << shift;
    }
  }
  const unsigned alpha = color & 255;
  return {double(importCanvasChannel(color >> 24, alpha)),
          double(importCanvasChannel((color >> 16) & 255, alpha)),
          double(importCanvasChannel((color >> 8) & 255, alpha)), double(alpha)};
}
}

bool CanvasStore::compositePixels(CanvasHandle handle, int x, int y, int width, int height,
    std::span<const uint8_t> pixels, std::span<const uint8_t> clip,
    CanvasComposite operation, double alpha) {
  const auto extent = checkedImageExtent(width, height);
  if (!extent || pixels.size() != extent->rgbaBytes || clip.size() != extent->rgbaBytes / 4 ||
      !std::isfinite(alpha) || alpha < 0 || alpha > 1) return false;
  auto* surface = writableContent(handle);
  if (!surface || !realizeContent(*surface)) return false;
  for (int row = 0; row < height; ++row) for (int column = 0; column < width; ++column) {
    const int64_t px = int64_t(x) + column, py = int64_t(y) + row;
    const size_t index = size_t(row) * width + column;
    if (!clip[index] || px < 0 || py < 0 || px >= surface->width || py >= surface->height) continue;
    const auto* source = pixels.data() + index * 4;
    auto* destination = surface->pixels.data() + (py * surface->width + px) * 4;
    compositeCanvasPixel(destination, {source[0] * alpha, source[1] * alpha,
      source[2] * alpha, source[3] * alpha}, operation);
    if (destination[0] > destination[3] || destination[1] > destination[3] || destination[2] > destination[3])
      surface->mayHaveOverAlpha = true;
  }
  markDirty(*surface, x, y, width, height);
  return true;
}

bool CanvasStore::paintCircle(CanvasHandle handle, const CanvasCirclePaint& request) {
  if (!std::isfinite(request.x) || !std::isfinite(request.y) || !std::isfinite(request.radius) ||
      request.radius < 0 || !std::isfinite(request.alpha) || request.alpha < 0 || request.alpha > 1 ||
      !std::all_of(request.transform.begin(), request.transform.end(), [](float v) { return std::isfinite(v); }) ||
      !validPaint(request.paint)) return false;
  for (const auto& clip : request.clips) for (const auto& path : clip.paths) for (const auto& point : path)
    if (!std::isfinite(point[0]) || !std::isfinite(point[1])) return false;
  auto* surface = lookupContent(handle);
  if (!surface) return false;
  const auto& t = request.transform;
  const double cx = t[0] * request.x + t[2] * request.y + t[4];
  const double cy = t[1] * request.x + t[3] * request.y + t[5];
  const double rx = request.radius * std::hypot(double(t[0]), double(t[2]));
  const double ry = request.radius * std::hypot(double(t[1]), double(t[3]));
  if (!std::isfinite(cx) || !std::isfinite(cy) || !std::isfinite(rx) || !std::isfinite(ry)) return false;
  const int left = std::clamp(std::floor(cx - rx) - 2, 0.0, double(surface->width));
  const int top = std::clamp(std::floor(cy - ry) - 2, 0.0, double(surface->height));
  const int right = std::clamp(std::ceil(cx + rx) + 2, 0.0, double(surface->width));
  const int bottom = std::clamp(std::ceil(cy + ry) + 2, 0.0, double(surface->height));
  std::vector<std::array<float, 4>> rectangles;
  bool rectangularClip = true;
  for (const auto& clip : request.clips) {
    if (clip.paths.size() != 1 || clip.paths[0].size() != 5 || clip.paths[0].front() != clip.paths[0].back()) {
      rectangularClip = false; break;
    }
    const auto& path = clip.paths[0];
    double x0 = path[0][0], x1 = x0, y0 = path[0][1], y1 = y0;
    for (size_t i = 1; i < path.size(); ++i) {
      if (path[i][0] != path[i - 1][0] && path[i][1] != path[i - 1][1]) { rectangularClip = false; break; }
      x0 = std::min(x0, path[i][0]); x1 = std::max(x1, path[i][0]);
      y0 = std::min(y0, path[i][1]); y1 = std::max(y1, path[i][1]);
    }
    if (!rectangularClip) break;
    if (!rectangles.empty()) {
      x1 = std::min(x1, double(rectangles[0][0] + rectangles[0][2]));
      y1 = std::min(y1, double(rectangles[0][1] + rectangles[0][3]));
      x0 = std::max(x0, double(rectangles[0][0])); y0 = std::max(y0, double(rectangles[0][1]));
    }
    rectangles = {{float(x0), float(y0), float(std::max(0.0, x1 - x0)), float(std::max(0.0, y1 - y0))}};
  }
  const bool separateClip = rectangularClip && request.composite != CanvasComposite::sourceOver;
  std::vector<uint8_t> coverage;
  if (right > left && bottom > top) coverage = circleCoverage(request.x, request.y, request.radius,
    request.transform, left, top, right - left, bottom - top,
    rectangularClip ? rectangles : std::vector<std::array<float, 4>>{});
  const bool unbounded = canvasCompositeClearsOutside(request.composite);
  if (coverage.empty() && !unbounded) return true;
  surface = writableContent(handle);
  if (!surface || !realizeContent(*surface)) return false;
  const int x0 = unbounded ? 0 : left, y0 = unbounded ? 0 : top;
  const int x1 = unbounded ? surface->width : right, y1 = unbounded ? surface->height : bottom;
  for (int y = y0; y < y1; ++y) for (int x = x0; x < x1; ++x) {
    if (!rectangularClip && !passesClips(request.clips, x + 0.5, y + 0.5)) continue;
    double clipCoverage = 1;
    if (separateClip && !rectangles.empty()) {
      const auto& clip = rectangles[0];
      const double width = std::max(0.0, std::min(x + 1.0, double(clip[0] + clip[2])) - std::max(double(x), double(clip[0])));
      const double height = std::max(0.0, std::min(y + 1.0, double(clip[1] + clip[3])) - std::max(double(y), double(clip[1])));
      clipCoverage = width * height;
      if (!clipCoverage) continue;
    }
    const unsigned mask = x >= left && x < right && y >= top && y < bottom && !coverage.empty() ?
      coverage[size_t(y - top) * (right - left) + x - left] : 0;
    if (!mask && !unbounded) continue;
    auto source = samplePaint(request.paint, x + 0.5, y + 0.5);
    if (request.composite == CanvasComposite::sourceOver) {
      const unsigned scale = std::round(request.alpha * 256), cov = mask + 1;
      for (auto& channel : source) channel = (unsigned(channel) * scale >> 8) * cov >> 8;
    } else {
      const double paintCoverage = std::min(1.0, mask / (255 * clipCoverage));
      for (auto& channel : source) channel *= request.alpha * paintCoverage;
    }
    auto* destination = surface->pixels.data() + (size_t(y) * surface->width + x) * 4;
    const std::array<uint8_t, 4> backdrop = {destination[0], destination[1], destination[2], destination[3]};
    compositeCanvasPixel(destination, source, request.composite, true);
    // Clip coverage masks the completed operation, including transparent-source clearing.
    if (clipCoverage < 1) for (unsigned i = 0; i < 4; ++i)
      destination[i] = std::round(destination[i] * clipCoverage + backdrop[i] * (1 - clipCoverage));
    if (destination[0] > destination[3] || destination[1] > destination[3] || destination[2] > destination[3])
      surface->mayHaveOverAlpha = true;
  }
  markDirty(*surface, x0, y0, x1 - x0, y1 - y0);
  return true;
}
}  // namespace pmjs
