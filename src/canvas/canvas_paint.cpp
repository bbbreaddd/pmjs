#include "canvas.hpp"
#include "core/checked_bounds.hpp"
#ifdef PMJS_HAS_SKIA65
#include "skia65/pmjs_skia65.h"
#endif

#include <algorithm>
#include <cmath>
#include <utility>

namespace pmjs {
namespace {
class ClipRows {
 public:
  ClipRows(const std::vector<CanvasClip>& clips, int left, int right)
      : clips_(clips), left_(left), right_(right) {
    for (const auto& clip : clips) {
      if (clip.paths.size() != 1 || clip.paths[0].size() != 5 || clip.paths[0].front() != clip.paths[0].back()) {
        rectangular_ = false; break;
      }
      const auto& path = clip.paths[0];
      double x0 = path[0][0], y0 = path[0][1], x1 = x0, y1 = y0;
      for (size_t i = 0; i < 4; ++i) {
        const auto& a = path[i]; const auto& b = path[i + 1]; const auto& c = path[(i + 2) % 4];
        if (a == b || (a[0] != b[0] && a[1] != b[1]) || (a[1] == b[1]) == (b[1] == c[1])) {
          rectangular_ = false; break;
        }
        x0 = std::min(x0, a[0]); y0 = std::min(y0, a[1]);
        x1 = std::max(x1, a[0]); y1 = std::max(y1, a[1]);
      }
      if (!rectangular_) break;
      rectangle_[0] = std::max(rectangle_[0], x0); rectangle_[1] = std::max(rectangle_[1], y0);
      rectangle_[2] = std::min(rectangle_[2], x1); rectangle_[3] = std::min(rectangle_[3], y1);
    }
  }
  bool contains(int x, int y) {
    if (clips_.empty()) return true;
    if (rectangular_) return x + 0.5 >= rectangle_[0] && y + 0.5 >= rectangle_[1] &&
      x + 0.5 < rectangle_[2] && y + 0.5 < rectangle_[3];
    if (y != row_) {
      coverage_.assign(right_ - left_, 1);
      for (const auto& clip : clips_) {
        crossings_.clear();
        for (const auto& path : clip.paths) for (size_t i = 0; i < path.size(); ++i) {
          const auto& a = path[i]; const auto& b = path[(i + 1) % path.size()];
          if ((a[1] > y + 0.5) == (b[1] > y + 0.5)) continue;
          const double at = (b[0] - a[0]) * (y + 0.5 - a[1]) / (b[1] - a[1]) + a[0];
          if (!std::isnan(at)) crossings_.emplace_back(at, b[1] > a[1] ? 1 : -1);
        }
        std::sort(crossings_.begin(), crossings_.end(), [](const auto& a, const auto& b) { return a.first > b.first; });
        size_t next = 0;
        int64_t winding = 0;
        for (int column = right_ - 1; column >= left_; --column) {
          while (next < crossings_.size() && crossings_[next].first > column + 0.5)
            winding += crossings_[next++].second;
          coverage_[column - left_] &= clip.evenOdd ? (next & 1) != 0 : winding != 0;
        }
      }
      row_ = y;
    }
    return coverage_[x - left_] != 0;
  }
 private:
  const std::vector<CanvasClip>& clips_;
  int left_, right_, row_ = -1;
  bool rectangular_ = true;
  std::array<double, 4> rectangle_ = {-INFINITY, -INFINITY, INFINITY, INFINITY};
  std::vector<uint8_t> coverage_;
  std::vector<std::pair<double, int>> crossings_;
};
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
    if (!std::isfinite(determinant) || determinant == 0) return {};
    const double px = x - t[4], py = y - t[5];
    const double sx = (t[3] * px - t[2] * py) / determinant;
    const double sy = (-t[1] * px + t[0] * py) / determinant;
    if (!std::isfinite(sx) || !std::isfinite(sy)) return {};
    const auto sample = [&](double column, double row) -> std::array<double, 4> {
      if (paint.repeat == "repeat" || paint.repeat == "repeat-x") column = std::fmod(std::fmod(column, paint.width) + paint.width, paint.width);
      else if (column < 0 || column >= paint.width) return {};
      if (paint.repeat == "repeat" || paint.repeat == "repeat-y") row = std::fmod(std::fmod(row, paint.height) + paint.height, paint.height);
      else if (row < 0 || row >= paint.height) return {};
      const size_t offset = (static_cast<size_t>(row) * paint.width + static_cast<size_t>(column)) * 4;
      return {double(paint.pixels[offset]), double(paint.pixels[offset + 1]),
              double(paint.pixels[offset + 2]), double(paint.pixels[offset + 3])};
    };
    if (!paint.smoothing) return sample(std::floor(sx), std::floor(sy));
    const double x0 = std::floor(sx - 0.5), y0 = std::floor(sy - 0.5);
    const double fx = std::floor((sx - 0.5 - x0) * 16) / 16, fy = std::floor((sy - 0.5 - y0) * 16) / 16;
    const auto a = sample(x0, y0), b = sample(x0 + 1, y0), c = sample(x0, y0 + 1), d = sample(x0 + 1, y0 + 1);
    std::array<double, 4> result;
    for (unsigned i = 0; i < 4; ++i) result[i] = std::floor(
      (a[i] * (1 - fx) + b[i] * fx) * (1 - fy) + (c[i] * (1 - fx) + d[i] * fx) * fy);
    return result;
  }
  if (paint.kind == CanvasPaint::Kind::linear || paint.kind == CanvasPaint::Kind::radial) {
    const auto& t = paint.transform;
    const double determinant = t[0] * t[3] - t[1] * t[2];
    if (!std::isfinite(determinant) || determinant == 0) return {};
    const double px = x - t[4], py = y - t[5];
    x = (t[3] * px - t[2] * py) / determinant;
    y = (-t[1] * px + t[0] * py) / determinant;
  }
  uint32_t color = paint.color;
  if (paint.kind != CanvasPaint::Kind::solid) {
    if (paint.offsets.empty()) return {};
    const auto& g = paint.geometry;
    const double dx = g[3] - g[0], dy = g[4] - g[1], px = x - g[0], py = y - g[1];
    double amount = 0;
    if (paint.kind == CanvasPaint::Kind::linear) {
      const double length = dx * dx + dy * dy;
      if (!length) return {};
      amount = (px * dx + py * dy) / length;
    } else {
      const double dr = g[5] - g[2];
      const double a = dx * dx + dy * dy - dr * dr;
      const double b = -2 * (px * dx + py * dy + g[2] * dr);
      const double c = px * px + py * py - g[2] * g[2];
      if (a == 0) {
        if (b == 0) return {};
        amount = -c / b;
        if (g[2] + amount * dr < 0) return {};
      } else {
        const double discriminant = b * b - 4 * a * c;
        if (discriminant < 0) return {};
        const double first = (-b - std::sqrt(discriminant)) / (2 * a);
        const double second = (-b + std::sqrt(discriminant)) / (2 * a);
        const bool firstValid = g[2] + first * dr >= 0;
        const bool secondValid = g[2] + second * dr >= 0;
        if (!firstValid && !secondValid) return {};
        amount = firstValid ? (secondValid ? std::max(first, second) : first) : second;
      }
    }
    if (!std::isfinite(amount)) return {};
    amount = std::clamp(amount, 0.0, 1.0);
    size_t lower = 0, upper = paint.offsets.size() - 1;
    const auto stop = std::lower_bound(paint.offsets.begin() + 1, paint.offsets.end(), amount);
    if (stop != paint.offsets.end()) { upper = stop - paint.offsets.begin(); lower = upper - 1; }
    const double span = paint.offsets[upper] - paint.offsets[lower];
    const double mix = span ? std::clamp((amount - paint.offsets[lower]) / span, 0.0, 1.0) : 0;
    color = 0;
    for (unsigned shift : {24U, 16U, 8U, 0U}) {
      const double a = (paint.colors[lower] >> shift) & 255, b = (paint.colors[upper] >> shift) & 255;
      color |= static_cast<uint32_t>(std::round(a * (1 - mix) + b * mix)) << shift;
    }
  }
  const unsigned alpha = color & 255;
  const auto channel = [&](unsigned value) {
    return double(paint.kind == CanvasPaint::Kind::solid ?
      paintCanvasChannel(value, alpha) : importCanvasChannel(value, alpha));
  };
  return {channel(color >> 24), channel((color >> 16) & 255), channel((color >> 8) & 255), double(alpha)};
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
    // Four distinct extrema, with alternating nonzero horizontal/vertical
    // edges, prove the rectangle rather than merely its bounding box.
    if (x0 == x1 || y0 == y1) { rectangularClip = false; break; }
    for (size_t i = 0; i < 4; ++i) {
      const auto& a = path[i]; const auto& b = path[i + 1];
      const auto& c = path[(i + 2) % 4];
      const bool horizontal = a[1] == b[1];
      if (a == b || horizontal == (b[1] == c[1]) ||
          (a[0] != x0 && a[0] != x1) || (a[1] != y0 && a[1] != y1)) {
        rectangularClip = false; break;
      }
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
  ClipRows clipRows(request.clips, x0, x1);
  for (int y = y0; y < y1; ++y) for (int x = x0; x < x1; ++x) {
    if (!rectangularClip && !clipRows.contains(x, y)) continue;
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
bool CanvasStore::paintPath(CanvasHandle handle, const CanvasPathPaint& request) {
  if (!std::isfinite(request.alpha) || request.alpha < 0 || request.alpha > 1 ||
      !std::isfinite(request.stroke) || request.stroke < 0 ||
      !std::isfinite(request.miterLimit) || request.miterLimit <= 0 ||
      !std::isfinite(request.dashOffset) || request.dash.size() % 2 ||
      !std::all_of(request.dash.begin(), request.dash.end(), [](float v) { return std::isfinite(v) && v >= 0; }) ||
      !std::all_of(request.commands.begin(), request.commands.end(), [](float v) { return std::isfinite(v); }) ||
      request.cap < 0 || request.cap > 2 || request.join < 0 || request.join > 2 ||
      request.paths.size() != request.closed.size() || !validPaint(request.paint) ||
      !std::all_of(request.transform.begin(), request.transform.end(), [](float v) { return std::isfinite(v); }))
    throw std::invalid_argument("invalid Canvas path paint");
  for (const auto& clip : request.clips) for (const auto& path : clip.paths) for (const auto& point : path)
    if (!std::isfinite(point[0]) || !std::isfinite(point[1])) throw std::invalid_argument("invalid Canvas clip point");
  double minX = INFINITY, minY = INFINITY, maxX = -INFINITY, maxY = -INFINITY;
  std::vector<float> points;
  std::vector<uint32_t> sizes;
  for (const auto& path : request.paths) {
    sizes.push_back(path.size());
    for (const auto& p : path) {
      if (!std::isfinite(float(p[0])) || !std::isfinite(float(p[1]))) throw std::invalid_argument("invalid Canvas path point");
      points.push_back(p[0]); points.push_back(p[1]);
      minX = std::min(minX, p[0]); minY = std::min(minY, p[1]);
      maxX = std::max(maxX, p[0]); maxY = std::max(maxY, p[1]);
    }
  }
  auto* surface = lookupContent(handle);
  if (!surface) throw std::invalid_argument("invalid Canvas handle");
  const auto& t = request.transform;
  const double determinant = double(t[0]) * t[3] - double(t[1]) * t[2];
  if (!std::isfinite(determinant) || determinant == 0 || points.empty()) return true;
#ifndef PMJS_HAS_SKIA65
  return false;
#else
  const double padding = request.stroke / 2 * std::max(1.0, request.join == 0 ? request.miterLimit : 1.0) *
    (std::hypot(double(t[0]), double(t[1])) + std::hypot(double(t[2]), double(t[3]))) + 1;
  const int left = std::clamp(std::floor(minX - padding), 0.0, double(surface->width));
  const int top = std::clamp(std::floor(minY - padding), 0.0, double(surface->height));
  const int right = std::clamp(std::ceil(maxX + padding), 0.0, double(surface->width));
  const int bottom = std::clamp(std::ceil(maxY + padding), 0.0, double(surface->height));
  const bool unbounded = !request.clear && canvasCompositeClearsOutside(request.composite);
  if ((right <= left || bottom <= top) && !unbounded) return true;
  if (request.paint.kind != CanvasPaint::Kind::pattern && !(surface->opaque && unbounded)) {
    pmjs_skia65_path_style style{};
    style.kind = static_cast<int>(request.paint.kind);
    style.color = request.paint.color;
    style.alpha = request.alpha;
    style.composite = static_cast<int>(request.composite);
    style.clear = request.clear;
    std::copy(request.paint.geometry.begin(), request.paint.geometry.end(), style.geometry);
    std::copy(request.paint.transform.begin(), request.paint.transform.end(), style.transform);
    std::vector<float> offsets(request.paint.offsets.begin(), request.paint.offsets.end());
    style.offsets = offsets.data(); style.colors = request.paint.colors.data(); style.count = offsets.size();
    std::vector<float> clipPoints;
    std::vector<uint32_t> clipSizes, clipCounts;
    std::vector<uint8_t> clipRules;
    for (const auto& clip : request.clips) {
      clipCounts.push_back(clip.paths.size()); clipRules.push_back(clip.evenOdd);
      for (const auto& path : clip.paths) {
        clipSizes.push_back(path.size());
        for (const auto& point : path) { clipPoints.push_back(point[0]); clipPoints.push_back(point[1]); }
      }
    }
    style.clip_points = clipPoints.data(); style.clip_sizes = clipSizes.data();
    style.clip_counts = clipCounts.data(); style.clip_even_odd = clipRules.data(); style.clip_count = clipCounts.size();
    surface = writableContent(handle);
    if (!surface || !realizeContent(*surface)) throw std::runtime_error("Canvas path realization failed");
    const int x0 = unbounded ? 0 : left & ~3, y0 = unbounded ? 0 : top & ~3;
    const int x1 = unbounded ? surface->width : right, y1 = unbounded ? surface->height : bottom;
    if (x1 <= x0 || y1 <= y0) return true;
    if (!pmjs_skia65_path_bgra(points.data(), sizes.data(), request.closed.data(), sizes.size(),
        request.commands.data(), request.commands.size(), request.dash.data(), request.dash.size(), request.dashOffset,
        t.data(), request.stroke, request.cap, request.join, request.miterLimit, !request.clear, request.evenOdd,
        x0, y0, x1 - x0, y1 - y0, surface->pixels.data() + (size_t(y0) * surface->width + x0) * 4,
        size_t(surface->width) * 4, &style)) throw std::runtime_error("Canvas path painting failed");
    markDirty(*surface, x0, y0, x1 - x0, y1 - y0);
    return true;
  }
  std::vector<uint8_t> coverage;
  if (right > left && bottom > top) {
    coverage.resize(size_t(right - left) * (bottom - top));
    if (!pmjs_skia65_path_coverage(points.data(), sizes.data(), request.closed.data(), sizes.size(),
        request.commands.data(), request.commands.size(), request.dash.data(), request.dash.size(), request.dashOffset,
        t.data(), request.stroke, request.cap, request.join, request.miterLimit, !request.clear, request.evenOdd,
        left, top, right - left, bottom - top, coverage.data()))
      throw std::runtime_error("Canvas path rasterization failed");
  }
  surface = writableContent(handle);
  if (!surface || !realizeContent(*surface)) throw std::runtime_error("Canvas path realization failed");
  const int x0 = unbounded ? 0 : left, y0 = unbounded ? 0 : top;
  const int x1 = unbounded ? surface->width : right, y1 = unbounded ? surface->height : bottom;
  ClipRows clipRows(request.clips, x0, x1);
  for (int y = y0; y < y1; ++y) for (int x = x0; x < x1; ++x) {
    if (!clipRows.contains(x, y)) continue;
    const unsigned mask = x >= left && x < right && y >= top && y < bottom && !coverage.empty() ?
      coverage[size_t(y - top) * (right - left) + x - left] : 0;
    if (!mask && !unbounded) continue;
    auto* destination = surface->pixels.data() + (size_t(y) * surface->width + x) * 4;
    if (request.clear) {
      for (unsigned i = 0; i < 4; ++i) destination[i] = unsigned(destination[i]) * (256 - mask) >> 8;
    } else {
      auto source = samplePaint(request.paint, x + 0.5, y + 0.5);
      const unsigned scale = std::round(request.alpha * 256);
      for (auto& channel : source) channel = (unsigned(channel) * scale >> 8) * (mask + 1) >> 8;
      compositeCanvasPixel(destination, source, request.composite, true);
      if (!mask && surface->opaque && request.composite == CanvasComposite::copy) destination[3] = 255;
      if (destination[0] > destination[3] || destination[1] > destination[3] || destination[2] > destination[3])
        surface->mayHaveOverAlpha = true;
    }
  }
  markDirty(*surface, x0, y0, x1 - x0, y1 - y0);
  return true;
#endif
}
bool CanvasStore::paintShadow(CanvasHandle handle, CanvasHandle sourceHandle, double x, double y,
    double blur, uint32_t color, const CanvasPaintState& state, bool geometryMask) {
  if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(blur) || blur < 0 ||
      !std::isfinite(state.alpha) || state.alpha < 0 || state.alpha > 1 ||
      (geometryMask && !validPaint(state.paint))) return false;
  auto* source = lookupContent(sourceHandle);
  auto* surface = lookupContent(handle);
  if (!source || !surface || !realizeContent(*source)) return false;
  bool visible = false;
  for (size_t i = 3; i < source->pixels.size(); i += 4) visible |= source->pixels[i] != 0;
  if (!visible && !canvasCompositeClearsOutside(state.composite)) return true;
  std::vector<uint8_t> pixels(size_t(surface->width) * surface->height * 4);
#ifdef PMJS_HAS_SKIA65
  if (!pmjs_skia65_shadow_bgra(source->pixels.data(), source->width, source->height, x, y,
      blur, color, geometryMask,
      pixels.data(), surface->width, surface->height)) return false;
#else
  // Portable builds use a separable Gaussian over the source alpha mask.
  const double sigma = blur ? 0.288675 * blur + 0.5 : 0;
  const int radius = std::min(8192.0, std::ceil(sigma * 3));
  std::vector<double> kernel(2 * radius + 1, 1), horizontal(size_t(source->width) * source->height);
  double total = 0;
  for (int i = -radius; i <= radius; ++i) total += kernel[i + radius] = sigma ? std::exp(-i * double(i) / (2 * sigma * sigma)) : 1;
  for (auto& weight : kernel) weight /= total;
  for (int row = 0; row < source->height; ++row) for (int column = 0; column < source->width; ++column)
    for (int i = -radius; i <= radius; ++i) if (column + i >= 0 && column + i < source->width)
      horizontal[size_t(row) * source->width + column] += source->pixels[(size_t(row) * source->width + column + i) * 4 + 3] * kernel[i + radius];
  for (int row = 0; row < surface->height; ++row) for (int column = 0; column < surface->width; ++column) {
    const int sx = std::floor(column - x), sy = std::floor(row - y);
    double coverage = 0;
    if (sx >= 0 && sx < source->width) for (int i = -radius; i <= radius; ++i)
      if (sy + i >= 0 && sy + i < source->height) coverage += horizontal[size_t(sy + i) * source->width + sx] * kernel[i + radius];
    auto* pixel = pixels.data() + (size_t(row) * surface->width + column) * 4;
    const unsigned alpha = std::round(coverage * (color & 255) / 255);
    pixel[0] = importCanvasChannel((color >> 8) & 255, alpha);
    pixel[1] = importCanvasChannel((color >> 16) & 255, alpha);
    pixel[2] = importCanvasChannel(color >> 24, alpha); pixel[3] = alpha;
  }
#endif
  surface = writableContent(handle);
  if (!surface || !realizeContent(*surface)) return false;
  ClipRows clipRows(state.clips, 0, surface->width);
  for (int row = 0; row < surface->height; ++row) for (int column = 0; column < surface->width; ++column) {
    if (!clipRows.contains(column, row)) continue;
    const auto offset = (size_t(row) * surface->width + column) * 4;
    const auto* p = pixels.data() + offset;
    if (!p[3] && !canvasCompositeClearsOutside(state.composite)) continue;
    const double paintAlpha = !geometryMask ? 1 :
      samplePaint(state.paint, column + 0.5 - x, row + 0.5 - y)[3] / 255;
    compositeCanvasPixel(surface->pixels.data() + offset,
      {std::round(p[2] * state.alpha * paintAlpha), std::round(p[1] * state.alpha * paintAlpha),
       std::round(p[0] * state.alpha * paintAlpha), std::round(p[3] * state.alpha * paintAlpha)}, state.composite, true);
    const auto* destination = surface->pixels.data() + offset;
    if (destination[0] > destination[3] || destination[1] > destination[3] || destination[2] > destination[3])
      surface->mayHaveOverAlpha = true;
  }
  markDirty(*surface, 0, 0, surface->width, surface->height);
  return true;
}
bool CanvasStore::drawAffineImage(CanvasHandle handle, uint32_t sourceHandle, const CanvasAffineImage& request) {
  if (!std::isfinite(request.alpha) || request.alpha < 0 || request.alpha > 1 ||
      !std::all_of(request.geometry.begin(), request.geometry.end(), [](double v) { return std::isfinite(v); }) ||
      !std::all_of(request.transform.begin(), request.transform.end(), [](double v) { return std::isfinite(v); })) return false;
  if (request.paint && !validPaint(*request.paint)) return false;
  for (const auto& clip : request.clips) for (const auto& path : clip.paths) for (const auto& point : path)
    if (!std::isfinite(point[0]) || !std::isfinite(point[1])) return false;
  const auto& g = request.geometry;
  const auto& t = request.transform;
  const double determinant = t[0] * t[3] - t[1] * t[2];
  if (!std::isfinite(determinant)) return false;
  if (determinant == 0 || g[2] <= 0 || g[3] <= 0 || g[6] <= 0 || g[7] <= 0) return lookupContent(handle) != nullptr;
  auto* destination = lookupContent(handle);
  if (!destination) return false;
  double minX = INFINITY, minY = INFINITY, maxX = -INFINITY, maxY = -INFINITY;
  for (int i = 0; i < 4; ++i) {
    const double x = g[4] + (i & 1 ? g[6] : 0), y = g[5] + (i & 2 ? g[7] : 0);
    const double px = t[0] * x + t[2] * y + t[4], py = t[1] * x + t[3] * y + t[5];
    if (!std::isfinite(px) || !std::isfinite(py)) return false;
    minX = std::min(minX, px); minY = std::min(minY, py); maxX = std::max(maxX, px); maxY = std::max(maxY, py);
  }
  const bool unbounded = canvasCompositeClearsOutside(request.composite);
  const int left = unbounded ? 0 : int(std::clamp(std::floor(minX), 0.0, double(destination->width)));
  const int top = unbounded ? 0 : int(std::clamp(std::floor(minY), 0.0, double(destination->height)));
  const int right = unbounded ? destination->width : int(std::clamp(std::ceil(maxX), 0.0, double(destination->width)));
  const int bottom = unbounded ? destination->height : int(std::clamp(std::ceil(maxY), 0.0, double(destination->height)));
  if (right <= left || bottom <= top) return true;
  // Capture before detaching the destination, including self draws.
  std::shared_ptr<Content> captured;
  if ((sourceHandle & canvasHandleTag) != 0) {
    const auto* source = lookup(sourceHandle);
    if (!source) return false;
    captured = source->content;
  }
  destination = writableContent(handle);
  if (!destination || !realizeContent(*destination)) return false;
  std::optional<ImagePixels> region;
  const uint8_t* pixels = nullptr;
  int sourceWidth, sourceHeight, pixelWidth, offsetX = 0, offsetY = 0;
  PixelEncoding encoding;
  if ((sourceHandle & canvasHandleTag) != 0) {
    if (!realizeContent(*captured)) return false;
    sourceWidth = pixelWidth = captured->width; sourceHeight = captured->height;
    pixels = captured->pixels.data(); encoding = PixelEncoding::PremultipliedBGRA8;
  } else {
    const auto info = images_.inspect(sourceHandle);
    if (!info) return false;
    sourceWidth = info->width; sourceHeight = info->height;
    const auto* decoded = images_.hasPreparedBacking(sourceHandle) ? nullptr : images_.readPixels(sourceHandle);
    if (!decoded) {
      offsetX = std::floor(std::clamp(g[0] - 1, 0.0, double(sourceWidth)));
      offsetY = std::floor(std::clamp(g[1] - 1, 0.0, double(sourceHeight)));
      const int rx = std::ceil(std::clamp(g[0] + g[2] + 1, 0.0, double(sourceWidth)));
      const int ry = std::ceil(std::clamp(g[1] + g[3] + 1, 0.0, double(sourceHeight)));
      if (rx <= offsetX || ry <= offsetY) return true;
      region = images_.readPixelsRegion(sourceHandle, offsetX, offsetY, rx - offsetX, ry - offsetY);
      if (!region) return false;
      decoded = &*region;
    }
    pixelWidth = decoded->width; pixels = decoded->rgba.data(); encoding = info->premultiplied ? PixelEncoding::PremultipliedRGBA8 : PixelEncoding::StraightRGBA8;
  }
  if (g[0] < 0 || g[1] < 0 || g[0] + g[2] > sourceWidth || g[1] + g[3] > sourceHeight) return false;
  const auto sample = [&](int x, int y) {
    std::array<uint8_t, 4> rgba;
    convertPixel(pixels + (size_t(y - offsetY) * pixelWidth + x - offsetX) * 4,
      encoding, rgba.data(), PixelEncoding::PremultipliedRGBA8);
    return rgba;
  };
  const double inverseA = t[3] / determinant, inverseB = -t[1] / determinant;
  const double inverseC = -t[2] / determinant, inverseD = t[0] / determinant;
  const bool axis = t[1] == 0 && t[2] == 0;
  const double startX = std::floor((g[0] + ((left + 0.5 - t[4]) / t[0] - g[4]) / g[6] * g[2] - 0.5) * 65536);
  const double startY = std::floor((g[1] + ((top + 0.5 - t[5]) / t[3] - g[5]) / g[7] * g[3] - 0.5) * 65536);
  const double stepX = std::trunc(g[2] / (g[6] * t[0]) * 65536), stepY = std::trunc(g[3] / (g[7] * t[3]) * 65536);
  ClipRows clipRows(request.clips, left, right);
  for (int y = top; y < bottom; ++y) for (int x = left; x < right; ++x) {
    if (!clipRows.contains(x, y)) continue;
    const double px = x + 0.5 - t[4], py = y + 0.5 - t[5];
    double u = (inverseA * px + inverseC * py - g[4]) / g[6];
    double v = (inverseB * px + inverseD * py - g[5]) / g[7];
    std::array<double, 4> color{};
    if (u >= 0 && u < 1 && v >= 0 && v < 1) {
      double sx = g[0] + u * g[2], sy = g[1] + v * g[3];
      if (request.smoothing) {
        sx = std::clamp(axis ? (startX + (x - left) * stepX) / 65536 : sx - 0.5, 0.0, double(sourceWidth - 1));
        sy = std::clamp(axis ? (startY + (y - top) * stepY) / 65536 : sy - 0.5, 0.0, double(sourceHeight - 1));
        const int x0 = std::floor(sx), y0 = std::floor(sy);
        const auto p00 = sample(x0, y0), p10 = sample(std::min(x0 + 1, sourceWidth - 1), y0);
        const auto p01 = sample(x0, std::min(y0 + 1, sourceHeight - 1));
        const auto p11 = sample(std::min(x0 + 1, sourceWidth - 1), std::min(y0 + 1, sourceHeight - 1));
        const double fx = std::floor((sx - x0) * 16 + 0.00001) / 16, fy = std::floor((sy - y0) * 16 + 0.00001) / 16;
        for (unsigned c = 0; c < 4; ++c) color[c] = std::round(
          (p00[c] * (1 - fx) + p10[c] * fx) * (1 - fy) + (p01[c] * (1 - fx) + p11[c] * fx) * fy);
      } else {
        // Axis-aligned nearest sampling advances in 16.16 source coordinates.
        sx = axis ? (startX + (x - left) * stepX + 32768) / 65536 : sx;
        sy = axis ? (startY + (y - top) * stepY + 32768) / 65536 : sy;
        const auto rgba = sample(std::clamp(int(std::floor(sx)), 0, sourceWidth - 1),
          std::clamp(int(std::floor(sy)), 0, sourceHeight - 1));
        std::copy(rgba.begin(), rgba.end(), color.begin());
      }
    }
    if (request.paint) {
      const double maskAlpha = color[3] / 255;
      color = samplePaint(*request.paint, x + 0.5, y + 0.5);
      for (auto& channel : color) channel = std::round(channel * maskAlpha);
    }
    for (auto& channel : color) channel *= request.alpha;
    auto* target = destination->pixels.data() + (size_t(y) * destination->width + x) * 4;
    compositeCanvasPixel(target, color, request.composite);
    if (target[0] > target[3] || target[1] > target[3] || target[2] > target[3]) destination->mayHaveOverAlpha = true;
  }
  markDirty(*destination, left, top, right - left, bottom - top);
  return true;
}
}  // namespace pmjs
