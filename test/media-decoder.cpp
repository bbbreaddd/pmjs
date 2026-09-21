#include "media_decoder.hpp"

#include <filesystem>
#include <iostream>
#include <string>

int main(int argc, char** argv) {
  if (argc != 2) return 2;
  pmjs::VideoDecoderSession decoder{std::filesystem::path(argv[1])};
  std::string error;

  const auto first = decoder.frame(0.0, &error);
  if (!first) {
    std::cerr << error << '\n';
    return 1;
  }
  const auto before = decoder.stats();

  const auto catchUp = decoder.frame(0.25, &error);
  if (!catchUp) {
    std::cerr << error << '\n';
    return 1;
  }
  const auto after = decoder.stats();
  const auto decoded = after.decodedFrames - before.decodedFrames;
  const auto skipped = after.skippedFrames - before.skippedFrames;
  const auto converted = after.convertedFrames - before.convertedFrames;

  if (decoded <= 1 || skipped != decoded - 1 || converted != 1 ||
      catchUp->rgba.size() !=
        static_cast<std::size_t>(catchUp->width * catchUp->height * 4)) {
    std::cerr << "unexpected decode stats: decoded=" << decoded
              << " skipped=" << skipped << " converted=" << converted << '\n';
    return 1;
  }
}
