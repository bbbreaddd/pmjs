#pragma once

#include <cstddef>
#include <cstdint>

namespace pmjs {

struct ColorHash {
  std::size_t operator()(std::uint32_t value) const noexcept {
    value ^= value >> 16;
    value *= 0x85ebca6bU;
    value ^= value >> 13;
    value *= 0xc2b2ae35U;
    value ^= value >> 16;
    return value;
  }
};

}  // namespace pmjs
