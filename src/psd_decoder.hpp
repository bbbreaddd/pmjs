#pragma once

#include "image_storage.hpp"
#include <cstddef>
#include <optional>

namespace pmjs {
std::optional<ImagePixels> decodePsdFromMemory(const void* data, std::size_t size,
    std::size_t maxDecodedBytes = 128U*1024U*1024U);
}  // namespace pmjs
