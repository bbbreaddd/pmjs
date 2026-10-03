#include "media_decoder.hpp"

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <limits>
#include <stdexcept>
#include <vector>

namespace {
void require(bool ok, const char* message) {
  if (!ok) throw std::runtime_error(message);
}

void checkSamples(pmjs::AudioDecoderSession& decoder,
                  const std::vector<float>& reference,
                  std::size_t offset, std::size_t frames) {
  std::string error;
  const auto samples = decoder.read(frames, &error);
  const auto count = std::min(frames * 2, reference.size() - offset * 2);
  require(error.empty() && samples.size() == count, "unexpected audio read length");
  for (std::size_t index = 0; index < count; ++index) {
    if (!std::isfinite(samples[index]) ||
        std::abs(samples[index] - reference[offset * 2 + index]) >= 2e-6F) {
      std::cerr << "frame=" << offset + index / 2 << " expected="
                << reference[offset * 2 + index] << " actual=" << samples[index] << '\n';
      throw std::runtime_error("seek returned samples from the wrong playback position");
    }
  }
}

void checkSeek(pmjs::AudioDecoderSession& decoder,
               const std::vector<float>& reference) {
  checkSamples(decoder, reference, 0, 256);
  for (double timestamp : {0.1, 0.2, 0.2995, 0.1, 0.0}) {
    std::string error;
    require(decoder.seek(timestamp, &error) && error.empty(), "audio seek failed");
    const auto offset = static_cast<std::size_t>(std::llround(timestamp * 48000));
    checkSamples(decoder, reference, offset, 64);
  }
  require(!decoder.seek(-1) &&
    !decoder.seek(std::numeric_limits<double>::quiet_NaN()) &&
    !decoder.seek(std::numeric_limits<double>::infinity()), "invalid seek accepted");
  checkSamples(decoder, reference, 64, 64);
  std::string error;
  require(decoder.seek(0, &error), "rewind failed");
  checkSamples(decoder, reference, 0, reference.size() / 2 + 1);
  require(decoder.read(1, &error).empty(), "audio did not reach EOF");
  require(decoder.seek(0.1, &error), "seek after EOF failed");
  checkSamples(decoder, reference, 4800, 64);
}
}

int main(int argc, char** argv) {
  if (argc != 2) return 2;
  try {
    const std::filesystem::path path(argv[1]);
    std::string error;
    const auto reference = pmjs::MediaDecoder::decodeAudio(path, &error);
    require(reference && reference->sampleRate == 48000 && reference->channels == 2 &&
      reference->samples.size() == 28800, "short audio fixture did not decode");
    require(reference->samples[4800 * 2] - reference->samples[0] > 0.02F,
      "audio fixture must distinguish playback positions");
    pmjs::AudioDecoderSession file(path);
    checkSeek(file, reference->samples);
    std::ifstream input(path, std::ios::binary);
    std::vector<std::uint8_t> bytes((std::istreambuf_iterator<char>(input)),
                                   std::istreambuf_iterator<char>());
    pmjs::AudioDecoderSession memory(std::move(bytes));
    checkSeek(memory, reference->samples);
    std::cout << "audio seek position tests passed\n";
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
