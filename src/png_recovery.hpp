#pragma once

#include <cstdint>
#include <optional>
#include <span>
#include <vector>

namespace pmjs {

// Recover metadata only when chunk checksums and a complete bounded pixel stream agree.
std::optional<std::vector<std::uint8_t>> recoverPngBytes(
    std::span<const std::uint8_t> bytes,
    std::size_t maxDecodedBytes = 128U*1024U*1024U);

}  // namespace pmjs
