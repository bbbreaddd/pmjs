#include "media_decoder.hpp"

#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

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

  auto reusable = std::move(first->rgba);
  auto catchUp = decoder.frame(0.25, reusable, &error);
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

  reusable = std::move(catchUp->rgba);
  const auto beforeRepeated = decoder.stats();
  if (decoder.frame(0.25, reusable, &error) ||
      decoder.stats().decodedFrames != beforeRepeated.decodedFrames ||
      decoder.stats().seeks != 0) {
    std::cerr << "repeated request decoded or sought again\n";
    return 1;
  }
  for (int tick = 16; tick <= 45; ++tick) {
    const double target = static_cast<double>(tick) / 60.0;
    auto frame = decoder.frame(target, reusable, &error);
    if (frame) {
      if (frame->timestamp > target + 0.000001 ||
          frame->rgba.data() != firstPixels) {
        std::cerr << "invalid monotonic playback frame\n";
        return 1;
      }
      reusable = std::move(frame->rgba);
    }
  }
  const auto sequential = decoder.stats();
  if (sequential.seeks != 0 || sequential.backwardSeeks != 0 ||
      sequential.decodedFrames > 10 || sequential.noNewFrameDue == 0) {
    std::cerr << "monotonic playback sought or re-decoded frames\n";
    return 1;
  }
  auto backward = decoder.frame(0.1, reusable, &error);
  if (!backward || backward->timestamp > 0.100001 ||
      decoder.stats().seeks != 1 || decoder.stats().backwardSeeks != 1) {
    std::cerr << "explicit backward seek failed\n";
    return 1;
  }
}
