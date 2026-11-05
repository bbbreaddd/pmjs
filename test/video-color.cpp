#include "video_color.hpp"

#include <array>
#include <cstdint>
#include <iostream>

int main() {
  const std::array<std::array<int, 2>, 7> sizes{{{1, 1}, {2, 2}, {7, 5}, {64, 33}, {640, 480}, {1, 9}, {9, 1}}};
  // Scalar Rec.601 reference outputs, including per-axis chroma rounding.
  const std::array<std::array<std::uint64_t, 2>, 7> expected{{
    {549578233166823072ULL, 549578233166823072ULL},
    {2241029341319229937ULL, 2241029341319229937ULL},
    {10231786645609863056ULL, 15085558196532142704ULL},
    {580058609320180928ULL, 12725006136725203781ULL},
    {11477640712264574989ULL, 1243290021509014669ULL},
    {1209435979362453842ULL, 1209435979362453842ULL},
    {1209435979362453842ULL, 1209435979362453842ULL}
  }};
  for (std::size_t index = 0; index < sizes.size(); ++index) {
    const auto& size = sizes[index];
    pmjs::VideoYuv420 frame;
    frame.width = size[0]; frame.height = size[1];
    frame.planes.resize(frame.width * frame.height +
      2 * ((frame.width + 1) / 2) * ((frame.height + 1) / 2));
    std::uint32_t state = 0x12345678;
    for (auto& byte : frame.planes) {
      state = state * 1664525U + 1013904223U;
      byte = static_cast<std::uint8_t>(state >> 24);
    }
    for (bool canvas : {false, true}) {
      std::vector<std::uint8_t> rgba;
      frame.convert(rgba, canvas);
      std::uint64_t hash = 14695981039346656037ULL;
      for (auto byte : rgba) { hash ^= byte; hash *= 1099511628211ULL; }
      if (hash != expected[index][canvas ? 1 : 0]) {
        std::cerr << "video conversion changed at " << frame.width << 'x' << frame.height
          << " canvas=" << canvas << '\n';
        return 1;
      }
    }
  }
}
