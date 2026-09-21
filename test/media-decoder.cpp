#include "media_decoder.hpp"

#include <filesystem>
#include <iostream>
#include <string>

int main(int argc, char** argv) {
  if (argc != 2) return 2;
  pmjs::VideoDecoderSession decoder{std::filesystem::path(argv[1])};
  std::string error;

  auto first = decoder.frame(0.0, &error);
  if (!first) {
    std::cerr << error << '\n';
    return 1;
  }
  const auto* firstPixels = first->rgba.data();
  const auto before = decoder.stats();

  const auto catchUp = decoder.frame(0.25, std::move(first->rgba), &error);
  if (!catchUp) {
    std::cerr << error << '\n';
    return 1;
  }
  const auto after = decoder.stats();
  const auto decoded = after.decodedFrames - before.decodedFrames;
  const auto skipped = after.skippedFrames - before.skippedFrames;
  const auto converted = after.convertedFrames - before.convertedFrames;
  const auto allocations = after.rgbaAllocations - before.rgbaAllocations;

  if (decoded <= 1 || skipped != decoded - 1 || converted != 1 ||
      allocations != 0 || catchUp->rgba.data() != firstPixels ||
      catchUp->rgba.size() !=
        static_cast<std::size_t>(catchUp->width * catchUp->height * 4)) {
    std::cerr << "unexpected decode stats: decoded=" << decoded
              << " skipped=" << skipped << " converted=" << converted
              << " allocations=" << allocations << '\n';
    return 1;
  }
}
