#pragma once

#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace pmjs {

struct MediaInfo {
  std::string container;
  std::string audioCodec;
  std::string videoCodec;
  double duration = 0.0;
  int audioSampleRate = 0;
  int audioChannels = 0;
  int videoWidth = 0;
  int videoHeight = 0;
};

struct DecodedAudio {
  int sampleRate = 48000;
  int channels = 2;
  std::vector<float> samples;
  std::uint64_t loopStartFrame = 0;
  std::uint64_t loopEndFrame = 0;
  double duration() const;
};

struct VideoFrame {
  int width = 0;
  int height = 0;
  double timestamp = 0.0;
  std::vector<std::uint8_t> rgba;
};

struct VideoDecodeStats {
  std::uint64_t decodedFrames = 0;
  std::uint64_t skippedFrames = 0;
  std::uint64_t convertedFrames = 0;
};

class AudioDecoderSession {
 public:
  explicit AudioDecoderSession(const std::filesystem::path& path);
  explicit AudioDecoderSession(std::vector<std::uint8_t> bytes);
  ~AudioDecoderSession();
  AudioDecoderSession(const AudioDecoderSession&) = delete;
  AudioDecoderSession& operator=(const AudioDecoderSession&) = delete;
  double duration() const;
  std::uint64_t loopStartFrame() const;
  std::uint64_t loopEndFrame() const;
  bool seek(double timestamp, std::string* error = nullptr);
  std::vector<float> read(std::size_t frames,
                          std::string* error = nullptr);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

class VideoDecoderSession {
 public:
  explicit VideoDecoderSession(const std::filesystem::path& path);
  ~VideoDecoderSession();
  VideoDecoderSession(const VideoDecoderSession&) = delete;
  VideoDecoderSession& operator=(const VideoDecoderSession&) = delete;
  const MediaInfo& info() const;
  VideoDecodeStats stats() const;
  std::optional<VideoFrame> frame(double timestamp,
                                  std::string* error = nullptr);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

class MediaDecoder {
 public:
  static std::optional<MediaInfo> probe(const std::filesystem::path& path,
                                        std::string* error = nullptr);
  static std::optional<DecodedAudio> decodeAudio(
    const std::filesystem::path& path, std::string* error = nullptr);
  static std::optional<VideoFrame> decodeVideoFrame(
    const std::filesystem::path& path, double timestamp,
    std::string* error = nullptr);
};

}  // namespace pmjs
