#include "media_decoder.hpp"
#include "checked_bounds.hpp"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libavutil/error.h>
#include <libavutil/imgutils.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

#include <algorithm>
#include <chrono>
#include <charconv>
#include <cerrno>
#include <cmath>
#include <cstring>
#include <deque>
#include <memory>
#include <stdexcept>

namespace pmjs {
namespace {

std::string ffError(int code) {
  char text[AV_ERROR_MAX_STRING_SIZE]{};
  av_strerror(code, text, sizeof(text));
  return text;
}

void fail(std::string* error, const std::string& message) {
  if (error) *error = message;
}

struct FormatDeleter { void operator()(AVFormatContext* value) const { avformat_close_input(&value); } };
struct CodecDeleter { void operator()(AVCodecContext* value) const { avcodec_free_context(&value); } };
struct PacketDeleter { void operator()(AVPacket* value) const { av_packet_free(&value); } };
struct FrameDeleter { void operator()(AVFrame* value) const { av_frame_free(&value); } };
struct SwrDeleter { void operator()(SwrContext* value) const { swr_free(&value); } };
using Format = std::unique_ptr<AVFormatContext, FormatDeleter>;
using Codec = std::unique_ptr<AVCodecContext, CodecDeleter>;
using Packet = std::unique_ptr<AVPacket, PacketDeleter>;
using Frame = std::unique_ptr<AVFrame, FrameDeleter>;
using Swr = std::unique_ptr<SwrContext, SwrDeleter>;
using Sws = std::unique_ptr<SwsContext, decltype(&sws_freeContext)>;

struct MemoryInput {
  explicit MemoryInput(std::vector<std::uint8_t> source) : bytes(std::move(source)) {
    constexpr int bufferSize = 32768;
    auto* buffer = static_cast<unsigned char*>(av_malloc(bufferSize));
    if (!buffer) throw std::runtime_error("cannot allocate media input buffer");
    context = avio_alloc_context(buffer, bufferSize, 0, this, read, nullptr, seek);
    if (!context) { av_free(buffer); throw std::runtime_error("cannot allocate media input"); }
  }
  ~MemoryInput() { avio_context_free(&context); }
  MemoryInput(const MemoryInput&) = delete;
  MemoryInput& operator=(const MemoryInput&) = delete;

  static int read(void* opaque, std::uint8_t* output, int requested) {
    auto& input = *static_cast<MemoryInput*>(opaque);
    if (input.position >= input.bytes.size()) return AVERROR_EOF;
    const auto count = std::min<std::size_t>(requested, input.bytes.size() - input.position);
    std::memcpy(output, input.bytes.data() + input.position, count);
    input.position += count;
    return static_cast<int>(count);
  }
  static std::int64_t seek(void* opaque, std::int64_t offset, int whence) {
    auto& input = *static_cast<MemoryInput*>(opaque);
    if (whence == AVSEEK_SIZE) return static_cast<std::int64_t>(input.bytes.size());
    const int origin = whence & ~AVSEEK_FORCE;
    std::int64_t base = 0;
    if (origin == SEEK_CUR) base = static_cast<std::int64_t>(input.position);
    else if (origin == SEEK_END) base = static_cast<std::int64_t>(input.bytes.size());
    else if (origin != SEEK_SET) return AVERROR(EINVAL);
    if (offset < -base || offset > static_cast<std::int64_t>(input.bytes.size()) - base)
      return AVERROR(EINVAL);
    input.position = static_cast<std::size_t>(base + offset);
    return static_cast<std::int64_t>(input.position);
  }

  std::vector<std::uint8_t> bytes;
  std::size_t position = 0;
  AVIOContext* context = nullptr;
};

Format open(const std::filesystem::path& path, std::string* error) {
  AVFormatContext* raw = nullptr;
  const int result = avformat_open_input(&raw, path.c_str(), nullptr, nullptr);
  if (result < 0) {
    fail(error, "cannot open media: " + ffError(result));
    return nullptr;
  }
  Format format(raw);
  const int info = avformat_find_stream_info(format.get(), nullptr);
  if (info < 0) {
    fail(error, "cannot inspect media streams: " + ffError(info));
    return nullptr;
  }
  return format;
}

Format open(MemoryInput& input, std::string* error) {
  AVFormatContext* raw = avformat_alloc_context();
  if (!raw) { fail(error, "cannot allocate media context"); return nullptr; }
  raw->pb = input.context;
  raw->flags |= AVFMT_FLAG_CUSTOM_IO;
  const int result = avformat_open_input(&raw, nullptr, nullptr, nullptr);
  if (result < 0) {
    if (raw) avformat_free_context(raw);
    fail(error, "cannot open media bytes: " + ffError(result));
    return nullptr;
  }
  Format format(raw);
  const int info = avformat_find_stream_info(format.get(), nullptr);
  if (info < 0) {
    fail(error, "cannot inspect media streams: " + ffError(info));
    return nullptr;
  }
  return format;
}

std::pair<int, Codec> decoder(AVFormatContext* format, AVMediaType type,
                              std::string* error) {
  const int index = av_find_best_stream(format, type, -1, -1, nullptr, 0);
  if (index < 0) {
    fail(error, std::string("media has no ") + av_get_media_type_string(type) +
                  " stream");
    return {-1, Codec{nullptr}};
  }
  const AVCodec* implementation =
    avcodec_find_decoder(format->streams[index]->codecpar->codec_id);
  if (!implementation) {
    fail(error, "no decoder for codec " +
                  std::string(avcodec_get_name(
                    format->streams[index]->codecpar->codec_id)));
    return {-1, Codec{nullptr}};
  }
  Codec context(avcodec_alloc_context3(implementation));
  if (!context) {
    fail(error, "cannot allocate decoder");
    return {-1, Codec{nullptr}};
  }
  int result = avcodec_parameters_to_context(
    context.get(), format->streams[index]->codecpar);
  if (result >= 0) result = avcodec_open2(context.get(), implementation, nullptr);
  if (result < 0) {
    fail(error, "cannot open decoder: " + ffError(result));
    return {-1, Codec{nullptr}};
  }
  return {index, std::move(context)};
}

bool timeToStreamTimestamp(double timestamp, AVRational timeBase, std::int64_t* outTarget) {
  if (!std::isfinite(timestamp) || timestamp < 0.0) return false;
  const double tb = av_q2d(timeBase);
  if (tb <= 0.0 || !std::isfinite(tb)) return false;
  const double rawTarget = timestamp / tb;
  if (!std::isfinite(rawTarget) || rawTarget > 9e18) return false;
  *outTarget = static_cast<std::int64_t>(rawTarget);
  return true;
}

std::optional<std::uint64_t> metadataNumber(AVDictionary* first,
                                            AVDictionary* second,
                                            const char* name) {
  const AVDictionaryEntry* entry = av_dict_get(first, name, nullptr, 0);
  if (!entry) entry = av_dict_get(second, name, nullptr, 0);
  if (!entry || !entry->value) return std::nullopt;
  std::uint64_t value = 0;
  const char* end = entry->value + std::char_traits<char>::length(entry->value);
  const auto parsed = std::from_chars(entry->value, end, value);
  return parsed.ec == std::errc{} ? std::optional<std::uint64_t>{value}
                                  : std::nullopt;
}

}  // namespace

double DecodedAudio::duration() const {
  return sampleRate > 0 && channels > 0
    ? static_cast<double>(samples.size()) / sampleRate / channels : 0.0;
}

std::optional<MediaInfo> MediaDecoder::probe(const std::filesystem::path& path,
                                             std::string* error) {
  auto format = open(path, error);
  if (!format) return std::nullopt;
  MediaInfo result;
  result.container = format->iformat && format->iformat->name
    ? format->iformat->name : "unknown";
  if (format->duration != AV_NOPTS_VALUE)
    result.duration = static_cast<double>(format->duration) / AV_TIME_BASE;
  for (unsigned index = 0; index < format->nb_streams; ++index) {
    const auto* parameters = format->streams[index]->codecpar;
    if (parameters->codec_type == AVMEDIA_TYPE_AUDIO && result.audioCodec.empty()) {
      result.audioCodec = avcodec_get_name(parameters->codec_id);
      result.audioSampleRate = parameters->sample_rate;
      result.audioChannels = parameters->ch_layout.nb_channels;
    } else if (parameters->codec_type == AVMEDIA_TYPE_VIDEO &&
               result.videoCodec.empty()) {
      result.videoCodec = avcodec_get_name(parameters->codec_id);
      result.videoWidth = parameters->width;
      result.videoHeight = parameters->height;
    }
  }
  return result;
}

std::optional<DecodedAudio> MediaDecoder::decodeAudio(
    const std::filesystem::path& path, std::string* error) {
  auto format = open(path, error);
  if (!format) return std::nullopt;
  auto [streamIndex, codec] = decoder(format.get(), AVMEDIA_TYPE_AUDIO, error);
  if (!codec) return std::nullopt;

  AVChannelLayout outputLayout{};
  av_channel_layout_default(&outputLayout, 2);
  SwrContext* rawResampler = nullptr;
  int result = swr_alloc_set_opts2(&rawResampler, &outputLayout, AV_SAMPLE_FMT_FLT,
    48000, &codec->ch_layout, codec->sample_fmt, codec->sample_rate, 0, nullptr);
  av_channel_layout_uninit(&outputLayout);
  Swr resampler(rawResampler);
  if (result < 0 || !resampler || (result = swr_init(resampler.get())) < 0) {
    fail(error, "cannot initialize audio conversion: " + ffError(result));
    return std::nullopt;
  }

  DecodedAudio output;
  const auto loopStart = metadataNumber(format->streams[streamIndex]->metadata,
                                         format->metadata, "LOOPSTART");
  const auto loopLength = metadataNumber(format->streams[streamIndex]->metadata,
                                          format->metadata, "LOOPLENGTH");
  const auto loopEnd = metadataNumber(format->streams[streamIndex]->metadata,
                                       format->metadata, "LOOPEND");
  Packet packet(av_packet_alloc());
  Frame frame(av_frame_alloc());
  if (!packet || !frame) {
    fail(error, "cannot allocate audio decode buffers");
    return std::nullopt;
  }
  const auto drain = [&]() -> bool {
    while (true) {
      const int received = avcodec_receive_frame(codec.get(), frame.get());
      if (received == AVERROR(EAGAIN) || received == AVERROR_EOF) return true;
      if (received < 0) { fail(error, "audio decode failed: " + ffError(received)); return false; }
      const int capacity = av_rescale_rnd(
        swr_get_delay(resampler.get(), codec->sample_rate) + frame->nb_samples,
        output.sampleRate, codec->sample_rate, AV_ROUND_UP);
      const std::size_t start = output.samples.size();
      output.samples.resize(start + static_cast<std::size_t>(capacity) * 2U);
      std::uint8_t* destination = reinterpret_cast<std::uint8_t*>(
        output.samples.data() + start);
      const int converted = swr_convert(resampler.get(), &destination, capacity,
        const_cast<const std::uint8_t**>(frame->extended_data), frame->nb_samples);
      if (converted < 0) { fail(error, "audio conversion failed: " + ffError(converted)); return false; }
      output.samples.resize(start + static_cast<std::size_t>(converted) * 2U);
      av_frame_unref(frame.get());
    }
  };
  while ((result = av_read_frame(format.get(), packet.get())) >= 0) {
    if (packet->stream_index == streamIndex) {
      while ((result = avcodec_send_packet(codec.get(), packet.get())) == AVERROR(EAGAIN))
        if (!drain()) return std::nullopt;
      if (result < 0) { fail(error, "cannot submit audio packet: " + ffError(result)); return std::nullopt; }
      if (!drain()) return std::nullopt;
    }
    av_packet_unref(packet.get());
  }
  if (result != AVERROR_EOF) { fail(error, "cannot read audio packet: " + ffError(result)); return std::nullopt; }
  result = avcodec_send_packet(codec.get(), nullptr);
  if (result < 0 && result != AVERROR_EOF) { fail(error, "cannot flush audio decoder: " + ffError(result)); return std::nullopt; }
  if (!drain()) return std::nullopt;
  while (swr_get_delay(resampler.get(), output.sampleRate) > 0) {
    const int capacity = static_cast<int>(
      swr_get_delay(resampler.get(), output.sampleRate));
    const std::size_t start = output.samples.size();
    output.samples.resize(start + static_cast<std::size_t>(capacity) * 2U);
    std::uint8_t* destination = reinterpret_cast<std::uint8_t*>(
      output.samples.data() + start);
    const int converted = swr_convert(resampler.get(), &destination, capacity,
                                      nullptr, 0);
    if (converted < 0) {
      fail(error, "audio flush failed: " + ffError(converted));
      return std::nullopt;
    }
    output.samples.resize(start + static_cast<std::size_t>(converted) * 2U);
    if (converted == 0) break;
  }
  if (loopStart) {
    output.loopStartFrame = av_rescale_rnd(*loopStart, output.sampleRate,
      codec->sample_rate, AV_ROUND_NEAR_INF);
    const auto sourceEnd = loopLength ? *loopStart + *loopLength
                                     : loopEnd.value_or(0);
    if (sourceEnd > *loopStart) output.loopEndFrame = av_rescale_rnd(
      sourceEnd, output.sampleRate, codec->sample_rate, AV_ROUND_NEAR_INF);
  }
  return output;
}

struct VideoDecoderSession::Impl {
  explicit Impl(const std::filesystem::path& path) {
    std::string error;
    format = open(path, &error);
    if (!format) throw std::runtime_error(error);
    auto opened = decoder(format.get(), AVMEDIA_TYPE_VIDEO, &error);
    streamIndex = opened.first;
    codec = std::move(opened.second);
    if (!codec) throw std::runtime_error(error);
    stream = format->streams[streamIndex];
    packet.reset(av_packet_alloc());
    decoded.reset(av_frame_alloc());
    selected.reset(av_frame_alloc());
    if (!packet || !decoded || !selected)
      throw std::runtime_error("cannot allocate video buffers");
    info.container = format->iformat && format->iformat->name
      ? format->iformat->name : "unknown";
    info.videoCodec = avcodec_get_name(codec->codec_id);
    info.videoWidth = codec->width; info.videoHeight = codec->height;
    const AVRational frameRate = av_guess_frame_rate(format.get(), stream, nullptr);
    if (frameRate.num > 0 && frameRate.den > 0)
      info.videoFrameRate = av_q2d(frameRate);
    if (format->duration != AV_NOPTS_VALUE)
      info.duration = static_cast<double>(format->duration) / AV_TIME_BASE;
  }

  bool seek(double timestamp, std::string* error) {
    std::int64_t target = 0;
    if (!timeToStreamTimestamp(timestamp, stream->time_base, &target)) {
      fail(error, "invalid seek timestamp or stream time base");
      return false;
    }
    const int result = av_seek_frame(format.get(), streamIndex, target,
                                     AVSEEK_FLAG_BACKWARD);
    if (result < 0) { fail(error, "video seek failed: " + ffError(result)); return false; }
    avcodec_flush_buffers(codec.get());
    av_packet_unref(packet.get());
    av_frame_unref(decoded.get());
    av_frame_unref(selected.get());
    queued.clear();
    sentEof = false; exhausted = false; lastTimestamp = -1.0;
    hasPresentedFrame = false;
    ++stats.seeks;
    if (lastRequestedTimestamp && timestamp < *lastRequestedTimestamp)
      ++stats.backwardSeeks;
    countingAfterSeek = true;
    return true;
  }

  std::optional<double> decodeNext(std::string* error) {
    const auto decodeStarted = std::chrono::steady_clock::now();
    while (true) {
      int result = avcodec_receive_frame(codec.get(), decoded.get());
      if (result >= 0) {
        stats.decodeMs += std::chrono::duration<double, std::milli>(
          std::chrono::steady_clock::now() - decodeStarted).count();
        const auto best = decoded->best_effort_timestamp;
        const double timestamp = best == AV_NOPTS_VALUE ? 0.0
          : best * av_q2d(stream->time_base);
        lastTimestamp = timestamp;
        ++stats.decodedFrames;
        if (countingAfterSeek) ++stats.decodedAfterSeek;
        return timestamp;
      }
      if (result != AVERROR(EAGAIN) && result != AVERROR_EOF) {
        fail(error, "video decode failed: " + ffError(result)); return std::nullopt;
      }
      if (result == AVERROR_EOF) return std::nullopt;
      while (true) {
        result = av_read_frame(format.get(), packet.get());
        if (result == AVERROR_EOF) {
          if (!sentEof) { avcodec_send_packet(codec.get(), nullptr); sentEof = true; }
          break;
        }
        if (result < 0) { fail(error, "cannot read video: " + ffError(result)); return std::nullopt; }
        if (packet->stream_index != streamIndex) { av_packet_unref(packet.get()); continue; }
        result = avcodec_send_packet(codec.get(), packet.get());
        av_packet_unref(packet.get());
        if (result < 0 && result != AVERROR(EAGAIN)) {
          fail(error, "cannot submit video packet: " + ffError(result));
          return std::nullopt;
        }
        break;
      }
    }
  }

  std::optional<VideoFrame> convertCurrent(double timestamp,
                                            std::vector<std::uint8_t> rgba,
                                            std::string* error) {
    const auto extent = checkedImageExtent(decoded->width, decoded->height,
                                            8192, 128 * 1024 * 1024);
    if (!extent) {
      av_frame_unref(decoded.get());
      fail(error, "invalid video frame dimensions");
      return std::nullopt;
    }
    const int width = extent->width, height = extent->height;
    if (!scaler || scalerWidth != width || scalerHeight != height ||
        scalerFormat != decoded->format) {
      scaler.reset(sws_getContext(width, height,
        static_cast<AVPixelFormat>(decoded->format), width, height,
        AV_PIX_FMT_RGBA, SWS_BILINEAR, nullptr, nullptr, nullptr));
      scalerWidth = width; scalerHeight = height; scalerFormat = decoded->format;
    }
    if (!scaler) {
      av_frame_unref(decoded.get());
      fail(error, "cannot initialize video conversion");
      return std::nullopt;
    }
    const auto rgbaBytes = static_cast<std::size_t>(width) * height * 4U;
    if (rgba.capacity() < rgbaBytes) ++stats.rgbaAllocations;
    rgba.resize(rgbaBytes);
    VideoFrame output{width, height, timestamp, std::move(rgba)};
    std::uint8_t* planes[] = {output.rgba.data(), nullptr, nullptr, nullptr};
    int strides[] = {width * 4, 0, 0, 0};
    const auto convertStarted = std::chrono::steady_clock::now();
    sws_scale(scaler.get(), decoded->data, decoded->linesize, 0, height,
              planes, strides);
    stats.convertMs += std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now() - convertStarted).count();
    av_frame_unref(decoded.get());
    ++stats.convertedFrames;
    return output;
  }

  Format format{nullptr}; Codec codec{nullptr}; Packet packet{nullptr};
  struct RawFrame { double timestamp; Frame frame; };
  Frame decoded{nullptr}; Frame selected{nullptr};
  std::deque<RawFrame> queued;
  Sws scaler{nullptr, sws_freeContext};
  AVStream* stream = nullptr; int streamIndex = -1;
  int scalerWidth = 0, scalerHeight = 0, scalerFormat = -1;
  double lastTimestamp = -1.0; bool sentEof = false;
  std::optional<double> lastRequestedTimestamp;
  bool exhausted = false;
  bool hasPresentedFrame = false;
  bool countingAfterSeek = false;
  MediaInfo info;
  VideoDecodeStats stats;
};

VideoDecoderSession::VideoDecoderSession(const std::filesystem::path& path)
    : impl_(std::make_unique<Impl>(path)) {}
VideoDecoderSession::~VideoDecoderSession() = default;
const MediaInfo& VideoDecoderSession::info() const { return impl_->info; }
VideoDecodeStats VideoDecoderSession::stats() const { return impl_->stats; }

bool VideoDecoderSession::prefetchOne(std::string* error) {
  if (impl_->exhausted || impl_->queued.size() >= 3) return false;
  const auto timestamp = impl_->decodeNext(error);
  if (!timestamp) { impl_->exhausted = true; return false; }
  Frame raw{av_frame_alloc()};
  if (!raw) { fail(error, "cannot allocate queued video frame");
    impl_->exhausted = true; return false; }
  av_frame_move_ref(raw.get(), impl_->decoded.get());
  impl_->queued.push_back({*timestamp, std::move(raw)});
  ++impl_->stats.prefetchedFrames;
  impl_->stats.maxQueuedFrames = std::max<std::uint64_t>(
    impl_->stats.maxQueuedFrames, impl_->queued.size());
  return true;
}

std::size_t VideoDecoderSession::queuedFrames() const {
  return impl_->queued.size();
}

bool VideoDecoderSession::exhausted() const { return impl_->exhausted; }

std::optional<VideoFrame> VideoDecoderSession::frame(double timestamp,
                                                     std::string* error) {
  std::vector<std::uint8_t> rgba;
  return frame(timestamp, rgba, error);
}

std::optional<VideoFrame> VideoDecoderSession::frame(
    double timestamp, std::vector<std::uint8_t>& reusableRgba,
    std::string* error) {
  if (!std::isfinite(timestamp) || timestamp < 0.0) {
    fail(error, "invalid video timestamp"); return std::nullopt;
  }
  constexpr double epsilon = 0.000001;
  if (impl_->lastRequestedTimestamp &&
      (timestamp + epsilon < *impl_->lastRequestedTimestamp ||
       timestamp > *impl_->lastRequestedTimestamp + 2.0)) {
    if (!impl_->seek(timestamp, error)) return std::nullopt;
  }
  impl_->lastRequestedTimestamp = timestamp;
  av_frame_unref(impl_->selected.get());
  std::optional<double> selectedTimestamp;
  while (true) {
    if (impl_->queued.empty() && !prefetchOne(error)) break;
    if (impl_->queued.empty()) break;
    if (impl_->queued.front().timestamp > timestamp + epsilon && selectedTimestamp)
      break;
    if (impl_->queued.front().timestamp > timestamp + epsilon &&
        impl_->hasPresentedFrame && !selectedTimestamp) {
      ++impl_->stats.noNewFrameDue;
      return std::nullopt;
    }
    if (selectedTimestamp) {
      av_frame_unref(impl_->selected.get());
      ++impl_->stats.skippedFrames;
    }
    selectedTimestamp = impl_->queued.front().timestamp;
    av_frame_move_ref(impl_->selected.get(), impl_->queued.front().frame.get());
    impl_->queued.pop_front();
  }
  if (!selectedTimestamp) {
    if (error && !error->empty()) return std::nullopt;
    ++impl_->stats.noNewFrameDue;
    return std::nullopt;
  }
  av_frame_move_ref(impl_->decoded.get(), impl_->selected.get());
  impl_->countingAfterSeek = false;
  auto result = impl_->convertCurrent(*selectedTimestamp,
                                      std::move(reusableRgba), error);
  if (result) impl_->hasPresentedFrame = true;
  return result;
}

struct AudioDecoderSession::Impl {
  explicit Impl(const std::filesystem::path& path) {
    std::string error;
    auto opened = open(path, &error);
    if (!opened) throw std::runtime_error(error);
    initialize(std::move(opened));
  }

  explicit Impl(std::vector<std::uint8_t> bytes)
      : memory(std::make_unique<MemoryInput>(std::move(bytes))) {
    std::string error;
    auto opened = open(*memory, &error);
    if (!opened) throw std::runtime_error(error);
    initialize(std::move(opened));
  }

  void initialize(Format openedFormat) {
    if (!openedFormat) throw std::runtime_error("cannot open audio bytes");
    format = std::move(openedFormat);
    std::string error;
    auto opened = decoder(format.get(), AVMEDIA_TYPE_AUDIO, &error);
    streamIndex = opened.first; codec = std::move(opened.second);
    if (!codec) throw std::runtime_error(error);
    stream = format->streams[streamIndex];
    AVChannelLayout layout{};
    av_channel_layout_default(&layout, 2);
    SwrContext* raw = nullptr;
    int result = swr_alloc_set_opts2(&raw, &layout, AV_SAMPLE_FMT_FLT, 48000,
      &codec->ch_layout, codec->sample_fmt, codec->sample_rate, 0, nullptr);
    av_channel_layout_uninit(&layout);
    resampler.reset(raw);
    if (result < 0 || !resampler || (result = swr_init(resampler.get())) < 0)
      throw std::runtime_error("cannot initialize audio stream: " + ffError(result));
    packet.reset(av_packet_alloc()); frame.reset(av_frame_alloc());
    if (!packet || !frame) throw std::runtime_error("cannot allocate audio stream buffers");
    if (format->duration != AV_NOPTS_VALUE)
      durationSeconds = static_cast<double>(format->duration) / AV_TIME_BASE;
    const auto start = metadataNumber(stream->metadata, format->metadata, "LOOPSTART");
    const auto length = metadataNumber(stream->metadata, format->metadata, "LOOPLENGTH");
    const auto end = metadataNumber(stream->metadata, format->metadata, "LOOPEND");
    if (start) {
      loopStart = av_rescale_rnd(*start, 48000, codec->sample_rate, AV_ROUND_NEAR_INF);
      const auto sourceEnd = length ? *start + *length : end.value_or(0);
      if (sourceEnd > *start) loopEnd = av_rescale_rnd(sourceEnd, 48000,
        codec->sample_rate, AV_ROUND_NEAR_INF);
    }
  }

  bool seek(double timestamp, std::string* error) {
    std::int64_t target = 0;
    if (!timeToStreamTimestamp(timestamp, stream->time_base, &target)) {
      fail(error, "invalid seek timestamp or stream time base");
      return false;
    }
    const int result = av_seek_frame(format.get(), streamIndex, target,
                                     AVSEEK_FLAG_BACKWARD);
    if (result < 0) { fail(error, "audio seek failed: " + ffError(result)); return false; }
    avcodec_flush_buffers(codec.get()); swr_close(resampler.get());
    if (swr_init(resampler.get()) < 0) { fail(error, "audio resampler reset failed"); return false; }
    pending.clear(); pendingOffset = 0; sentEof = false;
    discardUntil = timestamp;
    return true;
  }

  bool decodeOne(std::string* error) {
    while (true) {
      int result = avcodec_receive_frame(codec.get(), frame.get());
      if (result >= 0) {
        const int capacity = av_rescale_rnd(
          swr_get_delay(resampler.get(), codec->sample_rate) + frame->nb_samples,
          48000, codec->sample_rate, AV_ROUND_UP);
        const std::size_t start = pending.size();
        pending.resize(start + static_cast<std::size_t>(capacity) * 2U);
        std::uint8_t* destination = reinterpret_cast<std::uint8_t*>(pending.data() + start);
        const int converted = swr_convert(resampler.get(), &destination, capacity,
          const_cast<const std::uint8_t**>(frame->extended_data), frame->nb_samples);
        if (converted < 0) { fail(error, "audio conversion failed: " + ffError(converted)); return false; }
        pending.resize(start + static_cast<std::size_t>(converted) * 2U);
        if (discardUntil > 0.0) {
          const auto frameTime = frame->best_effort_timestamp == AV_NOPTS_VALUE ? 0.0
            : frame->best_effort_timestamp * av_q2d(stream->time_base);
          const auto frameEnd = frameTime + static_cast<double>(frame->nb_samples) /
            codec->sample_rate;
          if (frameEnd <= discardUntil) pending.resize(start);
          else if (frameTime < discardUntil) {
            const auto discardFrames = static_cast<std::size_t>(
              (discardUntil - frameTime) * 48000.0);
            const auto discardSamples = std::min(discardFrames * 2U,
                                                  pending.size() - start);
            pending.erase(pending.begin() + start,
                          pending.begin() + start + discardSamples);
          }
          if (frameEnd >= discardUntil) discardUntil = 0.0;
        }
        av_frame_unref(frame.get());
        return true;
      }
      if (result == AVERROR_EOF) {
        if (resampler) {
          const int delay = swr_get_delay(resampler.get(), 48000);
          if (delay > 0) {
            const std::size_t start = pending.size();
            pending.resize(start + static_cast<std::size_t>(delay) * 2U);
            std::uint8_t* destination = reinterpret_cast<std::uint8_t*>(pending.data() + start);
            const int converted = swr_convert(resampler.get(), &destination, delay, nullptr, 0);
            if (converted > 0) {
              pending.resize(start + static_cast<std::size_t>(converted) * 2U);
              return true;
            }
            pending.resize(start);
          }
        }
        return false;
      }
      if (result != AVERROR(EAGAIN)) {
        fail(error, "audio decode failed: " + ffError(result)); return false;
      }
      while (true) {
        result = av_read_frame(format.get(), packet.get());
        if (result == AVERROR_EOF) {
          if (!sentEof) { avcodec_send_packet(codec.get(), nullptr); sentEof = true; }
          break;
        }
        if (result < 0) { fail(error, "cannot read audio: " + ffError(result)); return false; }
        if (packet->stream_index != streamIndex) { av_packet_unref(packet.get()); continue; }
        result = avcodec_send_packet(codec.get(), packet.get());
        av_packet_unref(packet.get());
        if (result < 0 && result != AVERROR(EAGAIN)) {
          fail(error, "cannot submit audio packet: " + ffError(result)); return false;
        }
        break;
      }
    }
  }

  std::unique_ptr<MemoryInput> memory;
  Format format{nullptr}; Codec codec{nullptr}; Packet packet{nullptr};
  Frame frame{nullptr}; Swr resampler{nullptr}; AVStream* stream = nullptr;
  int streamIndex = -1; double durationSeconds = 0.0, discardUntil = 0.0;
  std::uint64_t loopStart = 0, loopEnd = 0; bool sentEof = false;
  std::vector<float> pending; std::size_t pendingOffset = 0;
};

AudioDecoderSession::AudioDecoderSession(const std::filesystem::path& path)
    : impl_(std::make_unique<Impl>(path)) {}
AudioDecoderSession::AudioDecoderSession(std::vector<std::uint8_t> bytes)
    : impl_(std::make_unique<Impl>(std::move(bytes))) {}
AudioDecoderSession::~AudioDecoderSession() = default;
double AudioDecoderSession::duration() const { return impl_->durationSeconds; }
std::uint64_t AudioDecoderSession::loopStartFrame() const { return impl_->loopStart; }
std::uint64_t AudioDecoderSession::loopEndFrame() const { return impl_->loopEnd; }
bool AudioDecoderSession::seek(double timestamp, std::string* error) {
  return std::isfinite(timestamp) && timestamp >= 0.0 && impl_->seek(timestamp, error);
}
std::vector<float> AudioDecoderSession::read(std::size_t frames,
                                             std::string* error) {
  const std::size_t requested = frames * 2U;
  while (impl_->pending.size() - impl_->pendingOffset < requested)
    if (!impl_->decodeOne(error)) break;
  const auto available = std::min(requested,
    impl_->pending.size() - impl_->pendingOffset);
  std::vector<float> output(impl_->pending.begin() + impl_->pendingOffset,
                            impl_->pending.begin() + impl_->pendingOffset + available);
  impl_->pendingOffset += available;
  if (impl_->pendingOffset > 32768U) {
    impl_->pending.erase(impl_->pending.begin(),
                         impl_->pending.begin() + impl_->pendingOffset);
    impl_->pendingOffset = 0;
  }
  return output;
}

std::optional<VideoFrame> MediaDecoder::decodeVideoFrame(
    const std::filesystem::path& path, double timestamp, std::string* error) {
  auto format = open(path, error);
  if (!format) return std::nullopt;
  auto [streamIndex, codec] = decoder(format.get(), AVMEDIA_TYPE_VIDEO, error);
  if (!codec) return std::nullopt;
  auto* stream = format->streams[streamIndex];
  if (timestamp > 0.0) {
    std::int64_t target = 0;
    if (!timeToStreamTimestamp(timestamp, stream->time_base, &target)) {
      fail(error, "invalid seek timestamp or stream time base");
      return std::nullopt;
    }
    const int seek = av_seek_frame(format.get(), streamIndex, target, AVSEEK_FLAG_BACKWARD);
    if (seek < 0) { fail(error, "video seek failed: " + ffError(seek)); return std::nullopt; }
    avcodec_flush_buffers(codec.get());
  }
  Packet packet(av_packet_alloc());
  Frame frame(av_frame_alloc());
  if (!packet || !frame) { fail(error, "cannot allocate video decode buffers"); return std::nullopt; }
  while (av_read_frame(format.get(), packet.get()) >= 0) {
    if (packet->stream_index == streamIndex) {
      int sent = avcodec_send_packet(codec.get(), packet.get());
      if (sent >= 0) {
        while (avcodec_receive_frame(codec.get(), frame.get()) >= 0) {
          const auto best = frame->best_effort_timestamp;
          const double frameTime = best == AV_NOPTS_VALUE ? 0.0 : best * av_q2d(stream->time_base);
          if (frameTime + 0.000001 < timestamp) continue;
          const auto extent = checkedImageExtent(codec->width, codec->height, 8192, 128 * 1024 * 1024);
          if (!extent) {
            fail(error, "invalid video frame dimensions");
            return std::nullopt;
          }
          VideoFrame output{extent->width, extent->height, frameTime, {}};
          output.rgba.resize(extent->rgbaBytes);
          Sws scaler(sws_getContext(output.width, output.height, codec->pix_fmt,
            output.width, output.height, AV_PIX_FMT_RGBA, SWS_BILINEAR,
            nullptr, nullptr, nullptr), sws_freeContext);
          if (!scaler) { fail(error, "cannot initialize video conversion"); return std::nullopt; }
          std::uint8_t* planes[] = {output.rgba.data(), nullptr, nullptr, nullptr};
          int strides[] = {output.width * 4, 0, 0, 0};
          sws_scale(scaler.get(), frame->data, frame->linesize, 0,
                    output.height, planes, strides);
          return output;
        }
      }
    }
    av_packet_unref(packet.get());
  }
  fail(error, "video contains no frame at requested timestamp");
  return std::nullopt;
}

}  // namespace pmjs
