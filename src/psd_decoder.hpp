#pragma once

#include "resources.hpp"

namespace pmjs {
std::optional<ImagePixels> decodePsdFromMemory(const void* data, std::size_t size,
    std::size_t maxDecodedBytes = 128U*1024U*1024U);
}  // namespace pmjs
