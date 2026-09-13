#pragma once

#include <cstddef>
#include <limits>
#include <optional>

namespace pmjs {

struct ImageExtent {
  int width = 0;
  int height = 0;
  std::size_t strideBytes = 0;
  std::size_t rgbBytes = 0;
  std::size_t rgbaBytes = 0;
};

inline std::optional<ImageExtent> checkedImageExtent(
    int width, int height,
    int maxDimension = 8192,
    std::size_t maxAllocationBytes = 64 * 1024 * 1024) {
  if (width <= 0 || height <= 0) return std::nullopt;
  if (width > maxDimension || height > maxDimension) return std::nullopt;

  const auto w = static_cast<std::size_t>(width);
  const auto h = static_cast<std::size_t>(height);

  // Check w * 4 overflow
  if (w > std::numeric_limits<std::size_t>::max() / 4U) return std::nullopt;
  const std::size_t stride = w * 4U;

  // Check w * h overflow
  if (h > std::numeric_limits<std::size_t>::max() / w) return std::nullopt;
  const std::size_t pixels = w * h;

  // Check w * h * 3 overflow
  if (pixels > std::numeric_limits<std::size_t>::max() / 3U) return std::nullopt;
  const std::size_t rgbBytes = pixels * 3U;

  // Check w * h * 4 overflow
  if (pixels > std::numeric_limits<std::size_t>::max() / 4U) return std::nullopt;
  const std::size_t rgbaBytes = pixels * 4U;

  if (rgbaBytes > maxAllocationBytes) return std::nullopt;

  return ImageExtent{width, height, stride, rgbBytes, rgbaBytes};
}

}  // namespace pmjs
