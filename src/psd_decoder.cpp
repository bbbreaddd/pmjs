#include "psd_decoder.hpp"
#include "checked_bounds.hpp"

#include <cstring>
#include <memory>
#include <limits>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libswscale/swscale.h>
}

namespace pmjs {
std::optional<ImagePixels> decodePsdFromMemory(const void* data, std::size_t size, std::size_t maxDecodedBytes) {
  if (!data || size < 26 || size > 64U * 1024U * 1024U) return std::nullopt;
  const auto* bytes = static_cast<const std::uint8_t*>(data);
  if (std::memcmp(bytes, "8BPS\0\1", 6)) return std::nullopt;
  const auto read32 = [](const std::uint8_t* source) {
    return (std::uint32_t(source[0]) << 24) | (std::uint32_t(source[1]) << 16) |
      (std::uint32_t(source[2]) << 8) | source[3];
  };
  const auto extent = checkedImageExtent(read32(bytes + 18), read32(bytes + 14), 8192, maxDecodedBytes);
  if (!extent) return std::nullopt;
  const auto* codec = avcodec_find_decoder(AV_CODEC_ID_PSD);
  if (!codec) return std::nullopt;
  auto freeContext = [](AVCodecContext* context) { avcodec_free_context(&context); };
  auto freeFrame = [](AVFrame* frame) { av_frame_free(&frame); };
  auto freePacket = [](AVPacket* packet) { av_packet_free(&packet); };
  std::unique_ptr<AVCodecContext, decltype(freeContext)> context(avcodec_alloc_context3(codec), freeContext);
  std::unique_ptr<AVFrame, decltype(freeFrame)> frame(av_frame_alloc(), freeFrame);
  std::unique_ptr<AVPacket, decltype(freePacket)> packet(av_packet_alloc(), freePacket);
  if (!context || !frame || !packet) return std::nullopt;
  // Decoder buffers align scanlines even for very small images.
  context->max_pixels = ((extent->width + 63) & ~63) * std::int64_t((extent->height + 63) & ~63);
  context->err_recognition = AV_EF_EXPLODE;
  if (avcodec_open2(context.get(), codec, nullptr) < 0 ||
      av_new_packet(packet.get(), size) < 0) return std::nullopt;
  std::memcpy(packet->data, data, size);
  if (avcodec_send_packet(context.get(), packet.get()) < 0 ||
      avcodec_receive_frame(context.get(), frame.get()) < 0 ||
      frame->width != extent->width || frame->height != extent->height ||
      (frame->flags & AV_FRAME_FLAG_CORRUPT)) return std::nullopt;
  std::unique_ptr<SwsContext, decltype(&sws_freeContext)> scaler(sws_getContext(
    frame->width, frame->height, static_cast<AVPixelFormat>(frame->format),
    frame->width, frame->height, AV_PIX_FMT_RGBA, SWS_POINT, nullptr, nullptr, nullptr), sws_freeContext);
  if (!scaler) return std::nullopt;
  ImagePixels pixels{extent->width, extent->height, std::vector<std::uint8_t>(extent->rgbaBytes)};
  std::uint8_t* destination[] = {pixels.rgba.data(), nullptr, nullptr, nullptr};
  const int strides[] = {extent->width * 4, 0, 0, 0};
  if (sws_scale(scaler.get(), frame->data, frame->linesize, 0, frame->height,
      destination, strides) != frame->height) return std::nullopt;
  return pixels;
}
}  // namespace pmjs
