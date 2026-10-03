#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <numbers>

namespace pmjs {

inline std::array<float, 2> spatialEffectGains(int channels, float x, float y, float z) {
  // MZ's OpenAL/Web Audio bridge spatializes mono buffers only.
  if (channels != 1) return {1, 1};
  const double distance = std::hypot(static_cast<double>(x), static_cast<double>(y), static_cast<double>(z));
  double azimuth = std::atan2(static_cast<double>(x), -static_cast<double>(z));
  if (azimuth < -std::numbers::pi / 2) azimuth = -std::numbers::pi - azimuth;
  else if (azimuth > std::numbers::pi / 2) azimuth = std::numbers::pi - azimuth;
  const double angle = (azimuth + std::numbers::pi / 2) / 2;
  // Inverse Web Audio attenuation ignores maxDistance. Undo FFmpeg's mono
  // upmix attenuation before applying the panner's equal-power gains.
  const double gain = std::sqrt(2.0) / std::max(1.0, distance);
  return {static_cast<float>(gain * std::cos(angle)), static_cast<float>(gain * std::sin(angle))};
}

}  // namespace pmjs
