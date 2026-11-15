#include "media/encrypted_audio_file.hpp"
#include "media/media_decoder.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <vector>

namespace {
void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}
}

int main(int argc, char** argv) try {
  if (argc < 2) return 2;
  std::string hex;
  std::cin >> hex;
  require(hex.size() == 32, "test requires a 16-byte key on stdin");
  pmjs::AudioEncryptionKey key{};
  for (std::size_t i = 0; i < key.size(); ++i)
    key[i] = static_cast<std::uint8_t>(std::stoul(hex.substr(i * 2, 2), nullptr, 16));
  std::uint64_t verifiedBytes = 0, loopedFiles = 0;
  for (int fileIndex = 1; fileIndex < argc; ++fileIndex) {
    std::ifstream source(argv[fileIndex], std::ios::binary);
    std::vector<std::uint8_t> encoded{std::istreambuf_iterator<char>(source), {}};
    require(encoded.size() >= 32, "short reference input");
    std::vector<std::uint8_t> expected(encoded.begin() + 16, encoded.end());
    for (std::size_t i = 0; i < key.size(); ++i) expected[i] ^= key[i];
    pmjs::EncryptedAudioFile file(argv[fileIndex], key);
    require(file.size() == static_cast<std::int64_t>(expected.size()), "logical size differs");
    std::array<std::uint8_t, 32768> buffer{};
    for (std::int64_t at = 0; at < file.size();) {
      const auto count = file.read(at, buffer);
      require(count && std::equal(buffer.begin(), buffer.begin() + count, expected.begin() + at), "decrypted stream differs");
      at += static_cast<std::int64_t>(count);
    }
    for (const auto at : {std::int64_t{0}, std::int64_t{1}, std::int64_t{15}, std::int64_t{16}, std::int64_t{17}, file.size() - 1, file.size()}) {
      for (const std::size_t length : {1, 7, 16, 31}) {
        const auto count = file.read(at, std::span(buffer).first(length));
        require(count == std::min<std::size_t>(length, expected.size() - at), "boundary read length differs");
        require(std::equal(buffer.begin(), buffer.begin() + count, expected.begin() + at), "boundary read differs");
      }
    }
    for (const auto at : {-1LL, file.size() + 1LL}) {
      bool rejected = false;
      try { file.read(at, buffer); } catch (const std::exception&) { rejected = true; }
      require(rejected, "out-of-range read accepted");
    }
    auto wrongKey = key;
    wrongKey[0] ^= 0xff; wrongKey[4] ^= 0xff;
    bool rejected = false;
    try { pmjs::EncryptedAudioFile invalid(argv[fileIndex], wrongKey); }
    catch (const std::exception&) { rejected = true; }
    require(rejected, "wrong key accepted");
    pmjs::AudioDecoderSession reference(std::move(expected));
    pmjs::AudioDecoderSession streamed(argv[fileIndex], key);
    require(reference.duration() == streamed.duration() && reference.sourceChannels() == streamed.sourceChannels(), "audio metadata differs");
    require(reference.loopStartFrame() == streamed.loopStartFrame() && reference.loopEndFrame() == streamed.loopEndFrame(), "loop metadata differs");
    if (streamed.loopEndFrame()) ++loopedFiles;
    const auto compare = [&] {
      const auto a = reference.read(4096), b = streamed.read(4096);
      require(a.size() == b.size(), "decoded sample count differs");
      for (std::size_t i = 0; i < a.size(); ++i)
        require(std::abs(a[i] - b[i]) < 0.000001F, "decoded sample differs");
    };
    compare();
    for (const auto timestamp : {streamed.duration() * 0.5, std::max(0.0, streamed.duration() - 0.05), 0.0}) {
      require(reference.seek(timestamp) && streamed.seek(timestamp), "audio seek failed");
      compare();
    }
    verifiedBytes += file.size();
  }
  std::cout << "{\"files\":" << argc - 1 << ",\"bytes\":" << verifiedBytes << ",\"loopedFiles\":" << loopedFiles << ",\"success\":true}\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n'; return 1;
}
