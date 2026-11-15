#pragma once
#include <cstdint>
#include <filesystem>
#include <span>
#include <string_view>
namespace pmjs {
void encodeAstc4x4(const std::filesystem::path& file, int width, int height,
                  std::span<std::uint8_t> rgba, std::string_view quality = "medium");
}
