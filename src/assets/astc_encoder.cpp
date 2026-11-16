#include "astc_encoder.hpp"
#include <astcenc.h>
#include <array>
#include <fstream>
#include <memory>
#include <stdexcept>
#include <vector>

namespace pmjs {
void encodeAstc4x4(const std::filesystem::path& file, int width, int height,
                  std::span<std::uint8_t> rgba, std::string_view quality) {
  if (width <= 0 || height <= 0 || rgba.size() != std::size_t(width) * height * 4)
    throw std::invalid_argument("invalid ASTC input extent");
  const auto check = [](astcenc_error error) {
    if (error != ASTCENC_SUCCESS) throw std::runtime_error(astcenc_get_error_string(error));
  };
  astcenc_config config{};
  const float preset = quality == "fast" ? ASTCENC_PRE_FAST :
    quality == "medium" ? ASTCENC_PRE_MEDIUM : quality == "thorough" ? ASTCENC_PRE_THOROUGH : -1;
  if (preset < 0) throw std::invalid_argument("ASTC quality must be fast, medium or thorough");
  check(astcenc_config_init(ASTCENC_PRF_LDR, 4, 4, 1, preset, 0, &config));
  astcenc_context* context = nullptr;
  check(astcenc_context_alloc(&config, 1, &context));
  std::unique_ptr<astcenc_context, decltype(&astcenc_context_free)> owner(context, astcenc_context_free);
  void* slice = rgba.data();
  astcenc_image image{static_cast<unsigned>(width), static_cast<unsigned>(height), 1, ASTCENC_TYPE_U8, &slice};
  const astcenc_swizzle swizzle{ASTCENC_SWZ_R, ASTCENC_SWZ_G, ASTCENC_SWZ_B, ASTCENC_SWZ_A};
  std::vector<std::uint8_t> bytes(std::size_t((width + 3) / 4) * ((height + 3) / 4) * 16);
  check(astcenc_compress_image(context, &image, &swizzle, bytes.data(), bytes.size(), 0));
  std::array<std::uint8_t, 16> header{0x13, 0xab, 0xa1, 0x5c, 4, 4, 1};
  for (int i = 0; i < 3; ++i) {
    header[7 + i] = (width >> (8 * i)) & 255;
    header[10 + i] = (height >> (8 * i)) & 255;
  }
  header[13] = 1;
  std::ofstream output(file, std::ios::binary | std::ios::trunc);
  output.write(reinterpret_cast<const char*>(header.data()), header.size());
  output.write(reinterpret_cast<const char*>(bytes.data()), bytes.size());
  if (!output) throw std::runtime_error("cannot write ASTC output");
}
}
