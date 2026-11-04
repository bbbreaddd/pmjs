#include "log.hpp"
#include "resources.hpp"
#include "astc_texture.hpp"
#include <SDL_video.h>
#include "prepared_page.hpp"
#include "texture_artifact.hpp"
#include "file_identity.hpp"
#include "checked_bounds.hpp"
#include "png_recovery.hpp"
#include "png_color.hpp"
#include "psd_decoder.hpp"

#include <algorithm>
#include <bit>
#include <array>
#include <chrono>
#include <charconv>
#include <cstdio>
#include <cstring>
#include <cmath>
#include <cstdlib>
#include <cerrno>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <setjmp.h>
#include <vector>
#include <stdexcept>
#include <new>
#include <mutex>
#include <sstream>
extern "C" {
#include <libavutil/sha.h>
#include <libavutil/mem.h>
}

#include <GLES3/gl3.h>
#include <GLES2/gl2ext.h>
#include <jpeglib.h>
#include <webp/decode.h>
#include <png.h>
#include <lz4.h>

namespace pmjs {

ImageEncryptionKey imageEncryptionKey(const std::string& hex) {
  if (hex.size() != 32) throw std::runtime_error("invalid image encryption key");
  ImageEncryptionKey result{};
  for (std::size_t i = 0; i < result.size(); ++i) {
    unsigned value = 0;
    const auto* at = hex.data() + i * 2;
    const auto parsed = std::from_chars(at, at + 2, value, 16);
    if (parsed.ec != std::errc{} || parsed.ptr != at + 2)
      throw std::runtime_error("invalid image encryption key");
    result[i] = static_cast<std::uint8_t>(value);
  }
  return result;
}

namespace {
constexpr std::uint32_t indexMask = 0xffffU;
constexpr std::uint16_t generationMask = 0x7fffU;
constexpr std::size_t preparedPageCacheBudget = 32U * 1024U * 1024U;

bool allZeroRgba(const void* pixels, int width, int height, int rowPixels) {
  const auto* bytes = static_cast<const std::uint8_t*>(pixels);
  const auto rowBytes = static_cast<std::size_t>(width) * 4U;
  const auto stride = static_cast<std::size_t>(rowPixels) * 4U;
  for (int row = 0; row < height; ++row) {
    const auto* begin = bytes + static_cast<std::size_t>(row) * stride;
    if (std::any_of(begin, begin + rowBytes,
                   [](std::uint8_t value) { return value != 0; })) return false;
  }
  return true;
}

int grayscaleChannels(const ImagePixels& pixels) {
  // Keep the constant-pixel representation independent of channel compression.
  if (pixels.width == 1 && pixels.height == 1) return 4;
  bool opaque = true;
  for (std::size_t i = 0; i < pixels.rgba.size(); i += 4) {
    if (pixels.rgba[i] != pixels.rgba[i + 1] || pixels.rgba[i] != pixels.rgba[i + 2]) return 4;
    opaque &= pixels.rgba[i + 3] == 255;
  }
  return opaque ? 1 : 2;
}

bool validBlockGrid(const PreparedImageDescriptor& descriptor) {
  if (!descriptor.blockGrid) return true;
  const auto [block, frameWidth, frameHeight] = *descriptor.blockGrid;
  if (block != 64 || frameWidth <= 0 || frameHeight <= 0 || descriptor.uniform ||
      descriptor.width % frameWidth || descriptor.height % frameHeight) return false;
  const auto references = static_cast<std::uint64_t>((frameWidth+block-1)/block) *
    ((frameHeight+block-1)/block) * (descriptor.width/frameWidth) * (descriptor.height/frameHeight);
  if (references > 65536) return false;
  for (const auto& cell : descriptor.cells) {
    const auto& r = cell.rect;
    const int x = r[0] % frameWidth, y = r[1] % frameHeight;
    if (x % block || y % block || x+r[2] > frameWidth || y+r[3] > frameHeight ||
        ((x+r[2]) % block && x+r[2] != frameWidth) ||
        ((y+r[3]) % block && y+r[3] != frameHeight)) return false;
    if (!cell.crop[2] && !cell.crop[3]) continue;
    if (r[2] != std::min(block, frameWidth-x) || r[3] != std::min(block, frameHeight-y) ||
        cell.crop != std::array<int, 4>{0, 0, r[2], r[3]}) return false;
  }
  return true;
}

ImageChannelStorage grayscaleStorage(int channels) {
  if (channels == 1) return {1, {0, 1, 2, 3}, {0, 0, 0, 5}};
  if (channels == 2) return {2, {0, 3, 1, 2}, {0, 0, 0, 1}};
  return {};
}

ImageChannelStorage imageStorage(const ImagePixels& pixels) { return imageChannelStorage(pixels); }

std::uint32_t uploadTexture(int width, int height, const void* rgba, ImageChannelStorage storage,
                            std::uint32_t texture = 0, bool packed = false) {
  const int channels = storage.channels;
  // SDL owns the GL context. Some firmware SDL builds make it current through an EGL
  // provider other than the libEGL this addon links, so its EGL cannot see the context
  // even though its GLES entry points can. Ask SDL instead of the linked EGL.
  if (SDL_GL_GetCurrentContext() == nullptr) return 0;
  for (int attempt = 0; ; ++attempt) {
    const auto error = glGetError();
    if (error == GL_NO_ERROR) break;
    if (error == GL_CONTEXT_LOST_KHR || attempt == 15) return 0;
  }
  std::vector<std::uint8_t> compact;
  const auto* bytes = static_cast<const std::uint8_t*>(rgba);
  const auto count = static_cast<std::size_t>(width) * height;
  if (channels != 4 && rgba && !packed) {
    compact.resize(count * channels);
    bool exact = true;
    for (std::size_t i = 0; i < count; ++i) {
      std::array<std::uint8_t, 6> components{0, 0, 0, 0, 0, 255};
      for (int c = 0; c < channels; ++c)
        components[c] = compact[i * channels + c] = bytes[i * 4 + storage.source[c]];
      for (int c = 0; c < 4; ++c)
        exact &= components[storage.swizzle[c]] == bytes[i * 4 + c];
    }
    if (!exact) { if (texture) glDeleteTextures(1, &texture); return 0; }
    bytes = compact.data();
  }
  if (!texture) glGenTextures(1, &texture);
  try {
    glBindTexture(GL_TEXTURE_2D, texture);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    if (channels != 4) {
      constexpr std::array<GLenum, 4> parameters{GL_TEXTURE_SWIZZLE_R, GL_TEXTURE_SWIZZLE_G,
        GL_TEXTURE_SWIZZLE_B, GL_TEXTURE_SWIZZLE_A};
      constexpr std::array<GLint, 6> components{GL_RED, GL_GREEN, GL_BLUE, GL_ALPHA, GL_ZERO, GL_ONE};
      for (std::size_t c = 0; c < parameters.size(); ++c)
        glTexParameteri(GL_TEXTURE_2D, parameters[c], components[storage.swizzle[c]]);
    }
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    const auto format = channels == 1 ? GL_RED : channels == 2 ? GL_RG : GL_RGBA;
    const auto internalFormat = channels == 1 ? GL_R8 : channels == 2 ? GL_RG8 : GL_RGBA;
    glTexImage2D(GL_TEXTURE_2D, 0, internalFormat, width, height, 0, format, GL_UNSIGNED_BYTE, bytes);
    if (!texture || glGetError() != GL_NO_ERROR) {
      if (texture) glDeleteTextures(1, &texture);
      return 0;
    }
  } catch (...) {
    if (texture) glDeleteTextures(1, &texture);
    throw;
  }

  return texture;
}

std::optional<ImagePixels> decodePngFromMemory(const void *data, std::size_t size,
                                               std::size_t maxDecodedBytes = 128U * 1024U * 1024U) {
  if (!data || size < 8)
    return std::nullopt;
  struct Input {
    const unsigned char *data;
    size_t size, offset;
  };
  struct State {
    png_structp png = nullptr;
    png_infop info = nullptr;
    ~State() { if (png) png_destroy_read_struct(&png, info ? &info : nullptr, nullptr); }
    Input input;
    ImageColorTransform transform;
    ImagePixels result;
    std::vector<png_bytep> rows;
  };
  const auto state = std::make_unique<State>();
  auto& png = state->png;
  auto& info = state->info;
  png = png_create_read_struct(PNG_LIBPNG_VER_STRING, nullptr, nullptr, nullptr);
  info = png ? png_create_info_struct(png) : nullptr;
  if (!info) return std::nullopt;
  state->input = {static_cast<const unsigned char *>(data), size, 0};
  auto &transform = state->transform;
  auto &result = state->result;
  auto &rows = state->rows;
  if (setjmp(png_jmpbuf(png))) {
    return std::nullopt;
  }
  png_set_chunk_malloc_max(png, 1024U * 1024U);
  png_set_read_fn(png, &state->input, [](png_structp reader, png_bytep output, png_size_t length) {
    auto &in = *static_cast<Input *>(png_get_io_ptr(reader));
    if (length > in.size - in.offset)
      png_error(reader, "truncated PNG");
    std::memcpy(output, in.data + in.offset, length);
    in.offset += length;
  });
  png_read_info(png, info);
  const auto extent = checkedImageExtent(png_get_image_width(png, info), png_get_image_height(png, info),
                                         16384, maxDecodedBytes);
  if (!extent) {
    return std::nullopt;
  }
  configurePng(png, info, transform);
  png_set_interlace_handling(png);
  png_read_update_info(png, info);
  result.width = extent->width;
  result.height = extent->height;
  result.rgba.resize(extent->rgbaBytes);
  rows.resize(result.height);
  for (int y = 0; y < result.height; ++y)
    rows[y] = result.rgba.data() + size_t(y) * result.width * 4;
  png_read_image(png, rows.data());
  png_read_end(png, info);
  transform.apply(result.rgba.data(), result.width * result.height);
  return std::move(result);
}

struct JpegError {
  jpeg_error_mgr base;
  jmp_buf recovery;
};

void recoverJpegError(j_common_ptr decoder) {
  auto* error = reinterpret_cast<JpegError*>(decoder->err);
  longjmp(error->recovery, 1);
}

std::optional<ImagePixels> decodeJpegFromMemory(const void* data, std::size_t size,
    std::size_t maxDecodedBytes = 128U*1024U*1024U) {
  if (!data || size < 4) return std::nullopt;
  jpeg_decompress_struct decoder{};
  JpegError error{};
  decoder.err = jpeg_std_error(&error.base);
  error.base.error_exit = recoverJpegError;
  struct State {
    ImageColorTransform colorTransform;
    std::vector<unsigned char> profile;
    std::vector<unsigned char> raw;
  };
  const auto state = std::make_unique<State>();
  auto& colorTransform = state->colorTransform;
  auto& profile = state->profile;
  auto& raw = state->raw;
  if (setjmp(error.recovery)) {
    jpeg_destroy_decompress(&decoder);
    return std::nullopt;
  }
  jpeg_create_decompress(&decoder);
  jpeg_save_markers(&decoder, JPEG_APP0 + 2, 0xffff);
  jpeg_mem_src(&decoder, static_cast<const unsigned char*>(data), size);
  if (jpeg_read_header(&decoder, TRUE) != JPEG_HEADER_OK) {
    jpeg_destroy_decompress(&decoder);
    return std::nullopt;
  }
  const auto extent = checkedImageExtent(
      static_cast<int>(decoder.image_width),
      static_cast<int>(decoder.image_height), 16384, maxDecodedBytes);
  if (!extent) {
    jpeg_destroy_decompress(&decoder);
    return std::nullopt;
  }
  const bool cmyk = decoder.jpeg_color_space == JCS_CMYK || decoder.jpeg_color_space == JCS_YCCK;
  decoder.out_color_space = cmyk ? JCS_CMYK : JCS_RGB;
  jpeg_start_decompress(&decoder);
  const std::size_t width = static_cast<std::size_t>(extent->width);
  const std::size_t channels = cmyk ? 4 : 3;
  const std::size_t rgbBytes = width * extent->height * channels;
  raw.resize(rgbBytes);
  while (decoder.output_scanline < decoder.output_height) {
    JSAMPROW row = raw.data() + decoder.output_scanline * width * channels;
    jpeg_read_scanlines(&decoder, &row, 1);
  }
  if (!cmyk) {
    std::array<jpeg_saved_marker_ptr, 256> parts{};
    unsigned total = 0;
    bool valid = true;
    for (auto *marker = decoder.marker_list; marker; marker = marker->next) {
      if (marker->marker != JPEG_APP0 + 2 || marker->data_length < 14 ||
          std::memcmp(marker->data, "ICC_PROFILE\0", 12))
        continue;
      const unsigned index = marker->data[12], count = marker->data[13];
      if (!count || !index || index > count || (total && total != count) || parts[index]) {
        valid = false;
        break;
      }
      total = count;
      parts[index] = marker;
    }
    for (unsigned part = 1; valid && part <= total; ++part) {
      const auto *marker = parts[part];
      if (!marker || marker->data_length - 14 > 1024U * 1024U - profile.size()) {
        valid = false;
        break;
      }
      profile.insert(profile.end(), marker->data + 14, marker->data + marker->data_length);
    }
    if (valid && !profile.empty())
      colorTransform.icc(profile.data(), profile.size());
  }
  jpeg_finish_decompress(&decoder);
  jpeg_destroy_decompress(&decoder);

  ImagePixels result;
  result.width = extent->width;
  result.height = extent->height;
  result.rgba.resize(extent->rgbaBytes);
  for (std::size_t source = 0, destination = 0; source < rgbBytes; source += channels, destination += 4U) {
    for (size_t channel = 0; channel < 3; ++channel) {
      result.rgba[destination + channel] = cmyk
        ? unsigned(raw[source + channel]) * raw[source + 3] / 255
        : raw[source + channel];
    }
    result.rgba[destination + 3U] = 255;
  }
  colorTransform.apply(result.rgba.data(),result.width*result.height);
  return result;
}

std::optional<ImagePixels> decodeMemory(const void* data, std::size_t size,
    std::size_t maxDecodedBytes = 128U*1024U*1024U) {
  if (!data || size < 4) return std::nullopt;
  const auto* bytes = static_cast<const std::uint8_t*>(data);
  if (std::memcmp(bytes, "PML4", 4) == 0) {
    auto pixels = readLz4Page({bytes, size}, maxDecodedBytes);
    if (!pixels) return std::nullopt;
    return ImagePixels{pixels->width, pixels->height, std::move(pixels->rgba)};
  }
  if (size >= 8 && png_sig_cmp(bytes, 0, 8) == 0) {
    if (auto pixels = decodePngFromMemory(data, size, maxDecodedBytes)) return pixels;
  }
  if (size >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff) {
    return decodeJpegFromMemory(data, size, maxDecodedBytes);
  }
  if (size >= 12 && std::memcmp(bytes, "RIFF", 4) == 0 && std::memcmp(bytes + 8, "WEBP", 4) == 0) {
    int width = 0, height = 0;
    if (!WebPGetInfo(bytes, size, &width, &height)) return std::nullopt;
    const auto extent = checkedImageExtent(width, height, 16384, maxDecodedBytes);
    if (!extent) return std::nullopt;
    ImagePixels pixels{width, height, std::vector<uint8_t>(extent->rgbaBytes)};
    if (!WebPDecodeRGBAInto(bytes, size, pixels.rgba.data(), pixels.rgba.size(), width * 4)) return std::nullopt;
    ImageColorTransform transform;
    bool animated = false;
    const unsigned char *profile = nullptr;
    size_t profileSize = 0;
    for (size_t offset = 12; offset + 8 <= size;) {
      const auto *chunk = bytes + offset;
      size_t length =
          size_t(chunk[4]) | size_t(chunk[5]) << 8 | size_t(chunk[6]) << 16 | size_t(chunk[7]) << 24;
      if (length > size - offset - 8)
        break;
      if (!std::memcmp(chunk, "ANIM", 4))
        animated = true;
      if (!std::memcmp(chunk, "ICCP", 4)) {
        profile = chunk + 8;
        profileSize = length;
      }
      offset += 8 + length + (length & 1);
    }
    if (!animated && profile)
      transform.icc(profile, profileSize);
    transform.apply(pixels.rgba.data(), width * height);
    return pixels;
  }
  if (size >= 6 && std::memcmp(bytes, "8BPS\0\1", 6) == 0) return decodePsdFromMemory(data, size, maxDecodedBytes);
  if (auto recovered = recoverPngBytes({bytes, size}, maxDecodedBytes))
    return decodePngFromMemory(recovered->data(), recovered->size(), maxDecodedBytes);
  return std::nullopt;
}

std::optional<ImagePixels> readTexturePixelsFromGpu(const ImageInfo& image, ImageChannelStorage storage = {},
    std::optional<std::array<int, 4>> region = std::nullopt) {
  const auto rect = region.value_or(std::array<int, 4>{0, 0, image.width, image.height});
  const auto extent = checkedImageExtent(rect[2], rect[3]);
  if (!extent || rect[0] < 0 || rect[1] < 0 || rect[0] > image.width - rect[2] ||
      rect[1] > image.height - rect[3]) return std::nullopt;
  ImagePixels pixels{rect[2], rect[3],
                     std::vector<std::uint8_t>(extent->rgbaBytes)};
  GLint previousRead = 0, previousBuffer = 0;
  glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &previousRead);
  glGetIntegerv(GL_PIXEL_PACK_BUFFER_BINDING, &previousBuffer);
  constexpr std::array<GLenum, 4> parameters = {
    GL_PACK_ALIGNMENT, GL_PACK_ROW_LENGTH, GL_PACK_SKIP_PIXELS, GL_PACK_SKIP_ROWS
  };
  std::array<GLint, 4> previousPack{};
  for (std::size_t index = 0; index < parameters.size(); ++index) {
    glGetIntegerv(parameters[index], &previousPack[index]);
    glPixelStorei(parameters[index], index == 0 ? 1 : 0);
  }
  GLuint framebuffer = 0;
  glGenFramebuffers(1, &framebuffer);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, framebuffer);
  if (framebuffer) {
    glFramebufferTexture2D(GL_READ_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                          GL_TEXTURE_2D, image.texture, 0);
  }
  const bool complete = framebuffer != 0 &&
    glCheckFramebufferStatus(GL_READ_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE;
  glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
  // The uploaded texture remains this owner's snapshot if its source changes.
  // Texture row zero is the decoded first row; no screen-space flip is needed.
  if (complete) {
    while (glGetError() != GL_NO_ERROR) {}
    glReadPixels(rect[0], rect[1], rect[2], rect[3], GL_RGBA,
                 GL_UNSIGNED_BYTE, pixels.rgba.data());
    // Texture swizzles do not apply to framebuffer reads.
    if (storage.channels != 4) for (std::size_t i = 0; i < pixels.rgba.size(); i += 4) {
      const std::array<std::uint8_t, 6> components{pixels.rgba[i], pixels.rgba[i + 1],
        pixels.rgba[i + 2], pixels.rgba[i + 3], 0, 255};
      for (int c = 0; c < 4; ++c) pixels.rgba[i + c] = components[storage.swizzle[c]];
    }
  }
  const bool readSucceeded = complete && glGetError() == GL_NO_ERROR;
  glBindBuffer(GL_PIXEL_PACK_BUFFER, static_cast<GLuint>(previousBuffer));
  glBindFramebuffer(GL_READ_FRAMEBUFFER, static_cast<GLuint>(previousRead));
  glDeleteFramebuffers(1, &framebuffer);
  for (std::size_t index = 0; index < parameters.size(); ++index) {
    glPixelStorei(parameters[index], previousPack[index]);
  }
  return readSucceeded ? std::optional<ImagePixels>(std::move(pixels)) : std::nullopt;
}
}

std::optional<ImagePixels> ImageStore::readTexturePixels(const ImageInfo& image,
    ImageChannelStorage storage, std::optional<std::array<int,4>> region) const {
  if (rendering_) ++renderReadbacks_;
  return readTexturePixelsFromGpu(image, storage, region);
}

ImageFileSource::~ImageFileSource() {
  if (descriptor_ >= 0) close(descriptor_);
}

std::unique_ptr<ImageFileSource> ImageStore::openFile(const std::filesystem::path& path,
    std::optional<ImageEncryptionKey> encryptionKey) {
  std::error_code error;
  const auto resolved = std::filesystem::canonical(path, error);
  if (error) return nullptr;
  std::unique_ptr<ImageFileSource> source(new ImageFileSource());
  source->descriptor_ = open(resolved.c_str(), O_RDONLY | O_CLOEXEC | O_NONBLOCK);
  struct stat info{};
  if (source->descriptor_ < 0 || fstat(source->descriptor_, &info) != 0 ||
      !S_ISREG(info.st_mode) || info.st_size <= 0 || info.st_size > 64 * 1024 * 1024) return nullptr;
  source->path_ = resolved;
  source->size_ = static_cast<std::size_t>(info.st_size);
  source->modifiedSeconds_ = info.st_mtim.tv_sec;
  source->modifiedNanoseconds_ = info.st_mtim.tv_nsec;
  source->key_ = fileIdentity(resolved, info);
  source->encryptionKey_ = encryptionKey;
  if (encryptionKey) {
    source->key_ += ":png-view:";
    constexpr char digits[] = "0123456789abcdef";
    for (const auto byte : *encryptionKey) {
      source->key_ += digits[byte >> 4]; source->key_ += digits[byte & 15];
    }
  }
  return source;
}

namespace {
std::string preparedDigest(const void* data, std::size_t size) {
  auto* sha = av_sha_alloc();
  if (!sha) throw std::bad_alloc();
  std::array<std::uint8_t, 32> digest{};
  av_sha_init(sha, 256);
  av_sha_update(sha, static_cast<const std::uint8_t*>(data), size);
  av_sha_final(sha, digest.data());
  av_free(sha);
  return std::string(reinterpret_cast<const char*>(digest.data()), digest.size());
}
}

struct ImageStore::SharedPreparedPage {
  std::mutex mutex;
  std::weak_ptr<ImagePixels> pixels;
  std::weak_ptr<SparsePalettePage> sparse;
  std::string key;
  std::atomic<std::uint64_t> lastCpuUse{0};
};
struct ImageStore::PreparedPool {
  std::mutex mutex;
  std::unordered_map<std::string, std::weak_ptr<SharedPreparedPage>> pages;
  std::atomic<std::uint64_t> hits{0};
  std::atomic<std::uint64_t> cpuClock{0};
};
struct ImageStore::SharedTexture {
  ImageStore* owner = nullptr;
  std::uint32_t texture = 0;
  std::size_t bytes = 0;
  ImageChannelStorage storage;
  bool mipmapsReady = false;
  std::size_t mipmapBytes = 0;
  ~SharedTexture() {
    if (texture) {
      glDeleteTextures(1, &texture);
      owner->gpuBytes_ -= bytes + mipmapBytes;
      ++owner->textureEpoch_;
    }
  }
};

struct ImageStore::PaletteBacking {
  ImageStore* owner = nullptr;
  std::uint32_t indices = 0, table = 0, premultipliedTable = 0, blocks = 0, residual = 0;
  int height = 0, indexChannels = 2;
  bool premultipliedReady = false;
  std::vector<std::uint8_t> colors;
  std::size_t bytes = 0;
  ~PaletteBacking() {
    const std::array<GLuint, 5> textures{indices, table, premultipliedTable, blocks, residual};
    glDeleteTextures(textures.size(), textures.data());
    owner->gpuBytes_ -= bytes;
    ++owner->textureEpoch_;
  }
};

struct ImageStore::PreparedBacking {
  std::string sourceIdentity, sourceHash;
  std::shared_ptr<std::atomic<std::uint64_t>> pageDecodes;
  std::shared_ptr<PreparedPool> pool;
  struct Page {
    std::shared_ptr<ImageFileSource> source;
    std::shared_ptr<ImagePixels> pixels;
    std::shared_ptr<SparsePalettePage> sparse;
    bool sparseChecked = false, sparseFormat = false, sparseDisabled = false;
    bool indexedFormat = false;
    std::shared_ptr<SharedPreparedPage> shared;
    std::shared_ptr<SharedTexture> sharedTexture, sharedPremultipliedTexture;
    std::uint32_t texture = 0, premultipliedTexture = 0, compactTexture = 0;
    ImageChannelStorage storage{0};
    std::shared_ptr<PaletteBacking> palette;
    std::vector<std::shared_ptr<PaletteBacking>> retiredPalettes;
    bool paletteChecked = false;
    std::uint64_t lastGpuUse = 0;
    std::filesystem::path path;
    std::string identity, expectedHash;
    bool verifyHash = false;
  };
  PreparedImageDescriptor descriptor;
  std::shared_ptr<ImageFileSource> textureSource;
  std::filesystem::path texturePath;
  std::string textureHash;
  bool textureChecked = false;
  std::vector<Page> pages;
  std::vector<ImageHandle> cellImages;
  std::vector<std::size_t> recentCells;
  std::vector<std::array<int,4>> evictedFrames;
  bool frameCacheDisabled = false;
  std::size_t gpuBytes = 0;
  std::optional<bool> compactEligible;
  bool compactRealizationFailed = false;
  std::array<std::uint32_t, 4> compactTables{};
  struct BlockTextures {
    std::uint32_t atlas = 0, table = 0;
    int channels = 0;
    std::shared_ptr<SharedTexture> sharedAtlas;
  };
  std::array<BlockTextures, 2> blockTextures{};
  std::uint32_t channelAtlas = 0, channelTable = 0;
  int channelHeight = 0;
  bool channelChecked = false;
  std::optional<bool> blockEligible;
  bool blockRealizationFailed = false;

  std::optional<bool> sourceSampling;
  bool requiresSourceSampling() {
    if (!sourceSampling) {
      sourceSampling = false;
      if (descriptor.framePages) {
        GLint maximum = 0;
        glGetIntegerv(GL_MAX_TEXTURE_SIZE, &maximum);
        sourceSampling = descriptor.width <= maximum && descriptor.height <= maximum &&
          checkedImageExtent(descriptor.width, descriptor.height, 16384).has_value();
      }
    }
    return *sourceSampling;
  }

  void clearBlockTextures() {
    glDeleteTextures(1, &channelAtlas); glDeleteTextures(1, &channelTable);
    channelAtlas = channelTable = 0;
    for (auto& textures : blockTextures) {
      if (!textures.sharedAtlas) glDeleteTextures(1, &textures.atlas);
      glDeleteTextures(1, &textures.table);
      textures = {};
    }
  }

  void clearCompactTextures() {
    for (auto& page : pages) if (page.compactTexture) {
      glDeleteTextures(1, &page.compactTexture);
      page.compactTexture = 0;
    }
    glDeleteTextures(static_cast<GLsizei>(compactTables.size()), compactTables.data());
    compactTables = {};
  }
};

struct ImageStore::PreparedLoad {
  std::shared_ptr<PreparedBacking> backing;
  std::shared_ptr<TileLoad> tiles;
  bool validated = false;
  std::shared_ptr<ImageFileSource> sourceToVerify, original;
  std::shared_ptr<std::atomic<unsigned>> invalidations;
  std::shared_ptr<PreparationFailures> failures;
  std::string sourceName;
  std::optional<ImagePixels> pixels;
};

std::uint64_t ImageStore::preparedSharedPageHits() const {
  return preparedPool_->hits.load(std::memory_order_relaxed);
}

std::shared_ptr<ImageStore::SharedTexture> ImageStore::shareTexture(
    const std::string& key, std::uint32_t texture, std::size_t bytes, ImageChannelStorage storage) {
  try {
    auto result = std::make_shared<SharedTexture>();
    preparedTextures_[key] = result;
    result->owner = this; result->texture = texture; result->bytes = bytes;
    result->storage = storage;
    return result;
  } catch (const std::bad_alloc&) {
    // A failed optional sharing record leaves the existing private owner intact.
    return {};
  }
}

std::string ImageStore::preparedTextureKey(PreparedBacking& backing, bool premultiplied) {
  const auto& descriptor = backing.descriptor;
  std::ostringstream key;
  key << "full:" << descriptor.version << ':' << descriptor.width << ':' << descriptor.height
      << ':' << descriptor.halo << ':' << premultiplied << ':';
  const auto add = [&key](const auto& values) {
    for (const auto value : values) key << static_cast<int>(value) << ',';
    key << ';';
  };
  if (descriptor.uniform) add(*descriptor.uniform);
  key << '|';
  if (descriptor.blockGrid) add(*descriptor.blockGrid);
  key << '|';
  for (std::size_t i = 0; i < backing.pages.size(); ++i) {
    if (!backing.pages[i].shared && !preparedPixels(backing, i)) return {};
    key << backing.pages[i].shared->key << '|';
  }
  for (const auto& cell : descriptor.cells) {
    add(cell.rect); add(cell.crop); add(cell.atlas); add(cell.fill); key << cell.page << '|';
  }
  const auto encoded = key.str();
  return preparedDigest(encoded.data(), encoded.size());
}

bool ImageStore::detachSharedTexture(Slot& slot) {
  if (!slot.sharedTexture) return true;
  auto pixels = readTexturePixels(ImageInfo{0, slot.width, slot.height, slot.texture}, slot.storage);
  if (!pixels) return false;
  const auto texture = uploadTexture(slot.width, slot.height, pixels->rgba.data(), {});
  if (!texture) return false;
  const auto bytes = static_cast<std::size_t>(slot.width)*slot.height*4U;
  gpuBytes_ += bytes; peakGpuBytes_ = std::max(peakGpuBytes_, gpuBytes_);
  clearPremultipliedTexture(slot);
  slot.sharedTexture.reset();
  slot.texture = texture; slot.storage = {};
  slot.mipmapBytes = 0; slot.mipmapsReady = false;
  ++textureEpoch_; ++textureCreates_; textureUploadBytes_ += bytes;
  return true;
}

ImageStore::ImageStore() : preparedPool_(std::make_shared<PreparedPool>()) {
  const char* diagnostics = std::getenv("PMJS_GRAPHICS_DIAGNOSTICS");
  tileDiagnostics_ = diagnostics && std::string(diagnostics) == "1";
}

ImageStore::~ImageStore() {
  if (preparedCopyProgram_) glDeleteProgram(preparedCopyProgram_);
  if (preparedCopyVao_) glDeleteVertexArrays(1, &preparedCopyVao_);
  *alive_ = false;
  for (auto& slot : slots_) {
    if (slot.live) {
      clearRetiredTextures(slot);
      if (slot.prepared) {
        slot.prepared->clearBlockTextures();
        slot.prepared->clearCompactTextures();
        for (auto& page : slot.prepared->pages) {
          if (!page.sharedPremultipliedTexture && page.premultipliedTexture && page.premultipliedTexture != page.texture) glDeleteTextures(1, &page.premultipliedTexture);
          if (!page.sharedTexture && page.texture) glDeleteTextures(1, &page.texture);
        }
      }
      clearPremultipliedTexture(slot);
      ++textureEpoch_;
      if (!slot.sharedTexture) glDeleteTextures(1, &slot.texture);
      slot.sharedTexture.reset();
      slot.prepared.reset();
    }
  }
}

ImageHandle ImageStore::fallbackHandle() {
  if (fallbackHandle_ != 0 && inspect(fallbackHandle_)) return fallbackHandle_;
  std::array<std::uint32_t, 16> checkerboard{};
  for (int y = 0; y < 4; ++y) {
    for (int x = 0; x < 4; ++x) {
      const bool magenta = ((x ^ y) & 1) != 0;
      checkerboard[static_cast<std::size_t>(y * 4 + x)] = magenta ? 0xffff00ffU : 0xff000000U;
    }
  }
  auto created = createRgba(4, 4, checkerboard.data());
  if (!created) return 0;
  pin(created->handle);
  const std::size_t index = (created->handle & indexMask) - 1U;
  slots_[index].references = 0;
  fallbackHandle_ = created->handle;
  return fallbackHandle_;
}

std::optional<ImageInfo> ImageStore::acquireFallback() {
  auto handle = fallbackHandle();
  if (handle == 0 || !retain(handle)) return std::nullopt;
  ++fallbackUses_;
  return inspect(handle);
}

std::size_t ImageStore::fallbackReferences() const {
  if (fallbackHandle_ == 0) return 0;
  const std::size_t index = (fallbackHandle_ & indexMask) - 1U;
  if (index >= slots_.size() || !slots_[index].live) return 0;
  return slots_[index].references;
}

std::optional<ImagePixels> ImageStore::decodeMemory(const void* data, std::size_t size) {
  return pmjs::decodeMemory(data, size);
}

std::optional<ImagePixels> ImageStore::decodePngFromMemory(const void* data, std::size_t size) {
  return pmjs::decodePngFromMemory(data, size);
}

std::optional<ImagePixels> ImageStore::decodeJpegFromMemory(const void* data, std::size_t size) {
  return pmjs::decodeJpegFromMemory(data, size);
}

std::optional<std::vector<std::uint8_t>> ImageStore::readCapturedBytes(const ImageFileSource& source) {
  if (source.encryptionKey_ && source.size_ < 32) return std::nullopt;
  std::vector<std::uint8_t> bytes(source.size_);
  std::size_t offset = 0;
  while (offset < bytes.size()) {
    const auto read = pread(source.descriptor_, bytes.data() + offset,
        bytes.size() - offset, static_cast<off_t>(offset));
    if (read < 0 && errno == EINTR) continue;
    if (read <= 0) return std::nullopt;
    offset += static_cast<std::size_t>(read);
  }
  struct stat current{};
  // Atomic replacement can unlink this inode and change ctime without changing
  // its bytes. Size and mtime detect writes to the held source instead.
  if (fstat(source.descriptor_, &current) != 0 ||
      current.st_size != static_cast<off_t>(source.size_) ||
      current.st_mtim.tv_sec != source.modifiedSeconds_ ||
      current.st_mtim.tv_nsec != source.modifiedNanoseconds_) {
    return std::nullopt;
  }
  if (source.encryptionKey_) {
    constexpr std::array<std::uint8_t, 16> signature{
      0x52, 0x50, 0x47, 0x4d, 0x56, 0, 0, 0, 0, 3, 1, 0, 0, 0, 0, 0};
    if (!std::equal(signature.begin(), signature.end(), bytes.begin())) return std::nullopt;
    for (std::size_t i = 0; i < 16; ++i) bytes[16 + i] ^= (*source.encryptionKey_)[i];
    constexpr std::array<std::uint8_t, 8> pngSignature{137, 80, 78, 71, 13, 10, 26, 10};
    if (!std::equal(pngSignature.begin(), pngSignature.end(), bytes.begin() + 16)) return std::nullopt;
  }
  return bytes;
}

std::optional<ImagePixels> ImageStore::decodeFile(const ImageFileSource& source, std::size_t maxDecodedBytes) {
  const auto bytes = readCapturedBytes(source);
  const auto offset = source.encryptionKey_ ? 16U : 0U;
  return bytes ? pmjs::decodeMemory(bytes->data() + offset, bytes->size() - offset, maxDecodedBytes) : std::nullopt;
}

std::optional<ImageInfo> ImageStore::loadPng(const std::filesystem::path& path,
                                             bool retainCpuPixels, const std::string& tileSet) {
  auto source = openFile(path);
  if (!source) return std::nullopt;
  if (auto cached = acquireCached(*source, tileSet)) {
    if (retainCpuPixels) this->retainCpuPixels(cached->handle);
    return cached;
  }
  if (!tileSet.empty()) {
    auto load = capturePrepared(*source, tileSet);
    if (load) {
      if (validatePrepared(*load, retainCpuPixels)) {
        if (auto image = installPreparedLoad(*source, load, retainCpuPixels)) return image;
      }
      auto pixels = decodePreparedFallback(*load);
      if (!pixels) return std::nullopt;
      return installDecoded(*source, std::move(*pixels), retainCpuPixels);
    }
  } else if (auto prepared = acquirePrepared(*source, retainCpuPixels)) return prepared;
  auto pixels = decodeFile(*source);
  if (!pixels) return std::nullopt;
  return installDecoded(*source, std::move(*pixels), retainCpuPixels);
}

std::optional<ImageInfo> ImageStore::installDecoded(
    const ImageFileSource& source, ImagePixels pixels,
    bool retainCpuPixels) {
  if (auto cached = acquireCached(source)) {
    if (retainCpuPixels) this->retainCpuPixels(cached->handle);
    return cached;
  }
  const std::string& cacheKey = source.key();

  auto created = createDecoded(pixels, storageDecision(source.key()));
  if (!created) return std::nullopt;
  const std::size_t index = (created->handle & indexMask) - 1U;
  try {
    slots_[index].cacheKey = cacheKey;
    slots_[index].sourcePath = source.path();
    slots_[index].retainCpuPixels = retainCpuPixels;
    if (retainCpuPixels) {
      slots_[index].cachedPixels = std::move(pixels);
      slots_[index].cpuPixelFrames = 0;
    }
    pathCache_.emplace(cacheKey, created->handle);
  } catch (...) {
    destroySlot(index);
    throw;
  }
  return created;
}

std::optional<ImageInfo> ImageStore::installDecodedMemory(
    ImagePixels pixels, bool /* retainCpuPixels */) {
  auto created = createDecoded(pixels);
  if (!created) return std::nullopt;
  const std::size_t index = (created->handle & indexMask) - 1U;
  // Memory images have no path to decode again after their load bytes are gone.
  slots_[index].retainCpuPixels = true;
  slots_[index].cachedPixels = std::move(pixels);
  slots_[index].cpuPixelFrames = 0;
  return created;
}

bool ImageStore::retainCpuPixels(ImageHandle handle) {
  const auto info = inspect(handle);
  if (!info) return false;
  const std::size_t index = (handle & indexMask) - 1U;
  auto& slot = slots_[index];
  if (slot.astc && !promoteAstc(slot)) return false;
  if (slot.cachedPixels) {
    slot.retainCpuPixels = true;
    slot.cpuPixelFrames = 0;
    if (slot.prepared) for (auto& page : slot.prepared->pages) page.pixels.reset();
    return true;
  }
  if (slot.cacheKey.empty() && !slot.palette && !slot.tiles) return false;
  slot.cachedPixels = (slot.palette || slot.prepared || slot.tiles) ?
    readPixelsRegion(handle, 0, 0, info->width, info->height) :
    readTexturePixels(*info, slot.storage);
  if (!slot.cachedPixels) return false;
  slot.retainCpuPixels = true;
  slot.cpuPixelFrames = 0;
  if (slot.prepared) for (auto& page : slot.prepared->pages) page.pixels.reset();
  return true;
}

std::optional<ImageInfo> ImageStore::acquireCached(
    const ImageFileSource& source, const std::string& tileSet) {
  const auto effective = effectiveTileSet(source, tileSet);
  const std::string cacheKey = source.key() + (effective.empty() ? "" : "\n"+effective);
  const auto cached = pathCache_.find(cacheKey);
  if (cached != pathCache_.end()) {
    const auto info = inspect(cached->second);
    if (info) {
      const std::size_t index = (cached->second & indexMask) - 1U;
      const bool wasWarm = slots_[index].references == 0 &&
        slots_[index].pins == 0 &&
        slots_[index].inFlight.load(std::memory_order_acquire) == 0;
      ++slots_[index].references;
      markUsed(slots_[index]);
      ++cacheHits_;
      if (slots_[index].prepared) ++preparedHits_;
      if (tileDiagnostics_ && slots_[index].tiles) ++tileHits_;
      if (wasWarm) ++warmHits_;
      return info;
    }
    pathCache_.erase(cached);
  }
  return std::nullopt;
}

const ImagePixels* ImageStore::readPixels(ImageHandle handle) const {
  const std::uint32_t encodedIndex = handle & indexMask;
  const auto info = inspect(handle);
  if (!info || encodedIndex == 0) return nullptr;
  auto& slot = const_cast<ImageStore*>(this)->slots_[encodedIndex - 1U];
  if (slot.astc && !const_cast<ImageStore*>(this)->promoteAstc(slot)) return nullptr;
  if (slot.cachedPixels) {
    if (!slot.retainCpuPixels && !slot.cacheKey.empty()) slot.cpuPixelFrames = 60;
    return &*slot.cachedPixels;
  }
  if (slot.cacheKey.empty() && !slot.palette && !slot.tiles) return nullptr;
  slot.cachedPixels = (slot.palette || slot.prepared || slot.tiles) ?
    readPixelsRegion(handle, 0, 0, info->width, info->height) :
    readTexturePixels(*info, slot.storage);
  if (!slot.retainCpuPixels) slot.cpuPixelFrames = 60;
  return slot.cachedPixels ? &*slot.cachedPixels : nullptr;
}

std::optional<ImageInfo> ImageStore::createRgba(int width, int height,
                                                 const void* pixels, bool premultiplied) {
  return createImage(width, height, pixels, premultiplied, {});
}

std::size_t ImageStore::decodedStorageBytes(const ImagePixels& pixels) {
  return pixels.rgba.size()/4*imageStorage(pixels).channels;
}

ImageStorageDecision ImageStore::classifyStorage(const ImagePixels& pixels) { return classifyImageStorage(pixels); }

bool ImageStore::installStorageDecision(const std::filesystem::path& path,
    const std::string& sourceIdentity, ImageStorageDecision decision, const std::string& backingHash) {
  if (sourceIdentity.empty() || decision.width <= 0 || decision.height <= 0 ||
      (!backingHash.empty() && !validContentHash(backingHash)) ||
      decision.width > 16384 || decision.height > 16384 ||
      (decision.paletteBits != 0 && decision.paletteBits != 8 && decision.paletteBits != 16) ||
      (decision.channels.channels != 1 && decision.channels.channels != 2 && decision.channels.channels != 4)) return false;
  if (decision.paletteBits && decision.channels.channels != 4) return false;
  for (auto c : decision.channels.source) if (c > 3) return false;
  for (auto c : decision.channels.swizzle)
    if (c >= decision.channels.channels && c != 4 && c != 5) return false;
  if (decision.hasPixelFacts && decision.opaque && decision.allZero) return false;
  const auto source = openFile(path);
  if (!source) return false;
  if (source->key() != sourceIdentity &&
      (!inodeOnlyChange(sourceIdentity, source->key()) ||
       !fileContentMatches(source->path(), source->key(), backingHash))) return false;
  storageDecisions_[source->key()] = decision;
  return true;
}

const ImageStorageDecision* ImageStore::storageDecision(const std::string& key) const {
  auto found = storageDecisions_.find(key);
  if (found == storageDecisions_.end()) {
    const auto separator = key.rfind('\n');
    if (separator != std::string::npos) found = storageDecisions_.find(key.substr(0, separator));
  }
  return found == storageDecisions_.end() ? nullptr : &found->second;
}

std::optional<ImageInfo> ImageStore::createDecoded(const ImagePixels& pixels,
    const ImageStorageDecision* decision) {
  if (decision && (decision->width != pixels.width || decision->height != pixels.height)) decision = nullptr;
  if (decision) ++storageDecisionHits_;
  auto result = createImage(pixels.width, pixels.height, pixels.rgba.data(), false,
                     decision ? decision->channels : imageStorage(pixels), makePalette(pixels, decision), decision);
  if (!result && decision)
    return createImage(pixels.width, pixels.height, pixels.rgba.data(), false, {});
  return result;
}

std::shared_ptr<ImageStore::PaletteBacking> ImageStore::makePalette(const ImagePixels& pixels, const ImageStorageDecision* decision) {
  if (decision && !decision->paletteBits) return {};
  const auto channels = decision ? 4 : imageStorage(pixels).channels;
  if (channels == 1) return {};
  const std::size_t colorLimit = decision ? (decision->paletteBits == 8 ? 256 : 65536) :
    channels == 2 ? 256 : 65536;
  const auto count = pixels.rgba.size() / 4;
  std::unordered_map<std::uint32_t, std::uint16_t> colors;
  colors.reserve(4096);
  const int stagingChannels = decision ? decision->paletteBits / 8 : 2;
  std::vector<std::uint8_t> entries, indices(count * stagingChannels);
  for (std::size_t i = 0; i < count; ++i) {
    std::uint32_t key;
    std::memcpy(&key, pixels.rgba.data() + i * 4, 4);
    auto found = colors.find(key);
    if (found == colors.end()) {
      if (colors.size() == colorLimit) return {};
      found = colors.emplace(key, static_cast<std::uint16_t>(colors.size())).first;
      entries.insert(entries.end(), pixels.rgba.data() + i * 4, pixels.rgba.data() + i * 4 + 4);
    }
    indices[i * stagingChannels] = found->second & 255;
    if (stagingChannels == 2) indices[i * 2 + 1] = found->second >> 8;
  }
  const int indexChannels = decision ? decision->paletteBits / 8 : colors.size() <= 256 ? 1 : 2;
  if (count * (channels - indexChannels) <= ((colors.size()+255)/256)*1024) return {};
  auto result = std::make_shared<PaletteBacking>();
  result->owner = this;
  result->height = static_cast<int>((colors.size() + 255) / 256);
  entries.resize(static_cast<std::size_t>(result->height) * 256 * 4);
  result->colors = std::move(entries);
  result->indexChannels = decision ? decision->paletteBits / 8 : colors.size() <= 256 ? 1 : 2;
  if (result->indexChannels == 1 && stagingChannels == 2) {
    for (std::size_t i = 0; i < count; ++i) indices[i] = indices[i * 2];
    indices.resize(count);
  }
  // Normalized indices retain hardware nearest selection at ordinary RGBA
  // coordinates. Missing green in R8 reads as zero. Never interpolate indices.
  ImageChannelStorage indexStorage{result->indexChannels};
  result->indices = uploadTexture(pixels.width, pixels.height, indices.data(), indexStorage, 0, true);
  if (!result->indices) return {};
  result->bytes = indices.size();
  gpuBytes_ += result->bytes;
  result->table = uploadTexture(256, result->height, result->colors.data(), {});
  if (!result->table) return {};
  gpuBytes_ += result->colors.size();
  result->bytes += result->colors.size();
  textureCreates_ += 2;
  ++textureEpoch_;
  textureUploadBytes_ += result->bytes;
  peakGpuBytes_ = std::max(peakGpuBytes_, gpuBytes_);
  return result;
}

std::shared_ptr<ImageStore::PaletteBacking> ImageStore::makeSparsePalette(const SparsePalettePage& page, bool sparseAllowed) {
  if ((page.packed && (!page.blocks.empty() || !page.residual.empty())) ||
      (!sparseAllowed && page.indexBytes != 2)) return {};
  auto result = std::make_shared<PaletteBacking>();
  result->owner = this; result->indexChannels = page.packed ? 1 : page.indexBytes;
  result->height = (page.colors.size() / 4 + 255) / 256;
  result->colors = page.colors; result->colors.resize(std::size_t(result->height) * 1024);
  const auto record = [&](std::size_t bytes) { result->bytes += bytes; gpuBytes_ += bytes; };
  if (page.packed) {
    result->indices = uploadTexture(page.width, page.height, page.base.data(), ImageChannelStorage{1}, 0, true);
    if (!result->indices) return {};
    record(page.base.size());
  } else if (sparseAllowed) {
    result->indices = uploadTexture(page.width, page.height, page.base.data(), ImageChannelStorage{1}, 0, true);
    if (!result->indices) return {};
    record(page.base.size());
    while (glGetError() != GL_NO_ERROR) {}
    glGenTextures(1, &result->blocks); glBindTexture(GL_TEXTURE_2D, result->blocks);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGB32UI, (page.width + 7) / 8, (page.height + 7) / 8,
      0, GL_RGB_INTEGER, GL_UNSIGNED_INT, page.blocks.data());
    if (!result->blocks || glGetError() != GL_NO_ERROR) return {};
    record(page.blocks.size() * 12);
    const auto count = page.residual.size() / page.indexBytes;
    const auto texels = page.indexBytes == 3 ? page.residual.size() : count;
    const int channels = page.indexBytes == 3 ? 1 : 2;
    const int width = std::min<std::size_t>(page.indexBytes == 3 ? 2048 : 1024, texels);
    const int height = (texels + width - 1) / width;
    auto residual = page.residual; residual.resize(std::size_t(width) * height * channels);
    result->residual = uploadTexture(width, height, residual.data(), ImageChannelStorage{channels}, 0, true);
    if (!result->residual) return {};
    record(residual.size());
  } else {
    const auto indices = page.denseIndices();
    result->indices = uploadTexture(page.width, page.height, indices.data(), ImageChannelStorage{2}, 0, true);
    if (!result->indices) return {};
    record(indices.size());
  }
  result->table = uploadTexture(256, result->height, result->colors.data(), {});
  if (!result->table) return {};
  record(result->colors.size());
  textureCreates_ += sparseAllowed && !page.packed ? 4 : 2;
  ++textureEpoch_; textureUploadBytes_ += result->bytes;
  peakGpuBytes_ = std::max(peakGpuBytes_, gpuBytes_);
  return result;
}

bool ImageStore::hasPaletteStorage(ImageHandle handle) const {
  const auto info = inspect(handle);
  if (!info) return false;
  const auto& slot = slots_[(handle & indexMask) - 1U];
  if (slot.palette) return true;
  const auto* decision = storageDecision(slot.cacheKey);
  return decision && decision->width == slot.width && decision->height == slot.height &&
    decision->paletteBits != 0;
}

bool ImageStore::realizeSourceTexture(ImageHandle handle) try {
  auto& slot = slots_[(handle & indexMask)-1U];
  if (!slot.prepared || !slot.prepared->requiresSourceSampling() || slot.texture || slot.premultipliedTexture) return false;
  auto& backing = *slot.prepared;
  if (backing.textureChecked) return slot.palette || backing.channelAtlas;
  backing.textureChecked = true;
  std::optional<PreparedTexture> built;
  std::optional<TextureLayout> layout;
  const auto source = std::move(backing.textureSource);
  std::unique_ptr<AVSHA, decltype(&av_free)> artifactDigest(nullptr, &av_free);
  std::size_t hashedBytes = 0;
  if (source && !backing.textureHash.empty()) {
    artifactDigest.reset(av_sha_alloc());
    if (!artifactDigest) throw std::bad_alloc();
    av_sha_init(artifactDigest.get(), 256);
  }
  TextureReader reader;
  if (source) {
    reader = [source, &artifactDigest, &hashedBytes](std::size_t offset, std::span<std::uint8_t> bytes) {
      if (offset > source->size_ || bytes.size() > source->size_-offset) return false;
      std::size_t done = 0;
      while (done < bytes.size()) {
        const auto count = pread(source->descriptor_, bytes.data()+done, bytes.size()-done, offset+done);
        if (count <= 0) return false;
        done += count;
      }
      if (artifactDigest) {
        if (offset != hashedBytes) return false;
        av_sha_update(artifactDigest.get(), bytes.data(), bytes.size());
        hashedBytes += bytes.size();
      }
      return true;
    };
    layout = readTextureLayout(reader, source->size_);
    if (!layout || layout->width != slot.width || layout->height != slot.height) {
      layout.reset(); ++textureArtifactFailures_; textureArtifactFailureReason_ = "layout";
    }
  } else if (!backing.descriptor.textureArtifact.empty()) {
    ++textureArtifactFailures_; textureArtifactFailureReason_ = "missing";
  }
  auto upload = [&](const TextureLayout& l, bool artifact) {
    if (l.kind == TextureKind::Channels && !compactSamplingEnabled_) return false;
    struct UnpackState {
      std::array<GLenum,4> names{GL_UNPACK_ALIGNMENT,GL_UNPACK_ROW_LENGTH,GL_UNPACK_SKIP_ROWS,GL_UNPACK_SKIP_PIXELS};
      std::array<GLint,4> values{};
      GLint binding = 0, buffer = 0;
      UnpackState() {
        glGetIntegerv(GL_TEXTURE_BINDING_2D,&binding);
        glGetIntegerv(GL_PIXEL_UNPACK_BUFFER_BINDING,&buffer);
        for (std::size_t i=0;i<names.size();++i) glGetIntegerv(names[i],&values[i]);
        glBindBuffer(GL_PIXEL_UNPACK_BUFFER,0);
        for (std::size_t i=0;i<names.size();++i) glPixelStorei(names[i],i == 0 ? 1 : 0);
      }
      ~UnpackState() {
        glBindTexture(GL_TEXTURE_2D,binding); glBindBuffer(GL_PIXEL_UNPACK_BUFFER,buffer);
        for (std::size_t i=0;i<names.size();++i) glPixelStorei(names[i],values[i]);
      }
    } unpack;
    GLint maximum = 0; glGetIntegerv(GL_MAX_TEXTURE_SIZE, &maximum);
    for (const auto& p : l.planes) if (p.width > unsigned(maximum) || p.height > unsigned(maximum)) return false;
    struct Textures {
      std::vector<GLuint> ids;
      ~Textures() { glDeleteTextures(ids.size(), ids.data()); }
    } textures;
    textures.ids.resize(l.planes.size());
    auto palette = std::make_shared<PaletteBacking>(); palette->owner = this;
    std::size_t bytes = 0;
    const auto formats = [](TextureFormat f) -> std::array<GLenum,3> {
      switch(f) {
        case TextureFormat::R8:return {GL_R8,GL_RED,GL_UNSIGNED_BYTE};
        case TextureFormat::RG8:return {GL_RG8,GL_RG,GL_UNSIGNED_BYTE};
        case TextureFormat::RGBA8:return {GL_RGBA8,GL_RGBA,GL_UNSIGNED_BYTE};
        case TextureFormat::RGB32UI:return {GL_RGB32UI,GL_RGB_INTEGER,GL_UNSIGNED_INT};
        case TextureFormat::RGBA32UI:return {GL_RGBA32UI,GL_RGBA_INTEGER,GL_UNSIGNED_INT};
      }
      return {};
    };
    while (glGetError() != GL_NO_ERROR) {}
    for (std::size_t i = 0; i < l.planes.size(); ++i) {
      const auto& p = l.planes[i]; const auto f = formats(p.format);
      glGenTextures(1,&textures.ids[i]); glBindTexture(GL_TEXTURE_2D,textures.ids[i]);
      glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_NEAREST);
      glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_NEAREST);
      glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_S,GL_CLAMP_TO_EDGE);
      glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_T,GL_CLAMP_TO_EDGE);
      glPixelStorei(GL_UNPACK_ALIGNMENT,1);
      glTexImage2D(GL_TEXTURE_2D,0,f[0],p.width,p.height,0,f[1],f[2],nullptr);
      if (!textures.ids[i] || glGetError()!=GL_NO_ERROR) return false;
      bytes += std::size_t(p.width)*p.height*textureTexelBytes(p.format);
    }
    const auto consume = [&](std::size_t i, const TextureChunk& c, std::span<const std::uint8_t> data) {
      const auto& p = l.planes[i]; const auto f = formats(p.format);
      glBindTexture(GL_TEXTURE_2D,textures.ids[i]);
      glTexSubImage2D(GL_TEXTURE_2D,0,0,c.y,p.width,c.rows,f[1],f[2],data.data());
      if (glGetError()!=GL_NO_ERROR) return false;
      if (l.kind != TextureKind::Channels && i == 1) palette->colors.insert(palette->colors.end(),data.begin(),data.end());
      return true;
    };
    if (artifact) {
      if (!readTextureChunks(reader,l,consume,textureArtifactStagingBytes_)) return false;
      if (artifactDigest) {
        std::array<std::uint8_t,32> digest{};
        av_sha_final(artifactDigest.get(), digest.data());
        constexpr char digits[] = "0123456789abcdef";
        std::string hash;
        for (const auto byte : digest) { hash += digits[byte >> 4]; hash += digits[byte & 15]; }
        if (hashedBytes != source->size_ || hash != backing.textureHash) return false;
      }
    } else {
      for (std::size_t i = 0; i < l.planes.size(); ++i) {
        if constexpr (std::endian::native == std::endian::big) {
          auto& data = built->bytes[i];
          if (textureTexelBytes(l.planes[i].format) >= 12)
            for (std::size_t j = 0; j < data.size(); j += 4) std::reverse(data.begin()+j,data.begin()+j+4);
        }
        if (!consume(i,TextureChunk{0,l.planes[i].height},built->bytes[i])) return false;
      }
    }
    if (l.kind == TextureKind::Channels) {
      backing.channelAtlas = textures.ids[0]; backing.channelTable = textures.ids[1];
      backing.channelHeight = l.planes[0].height; backing.channelChecked = true;
      backing.gpuBytes += bytes; ++blockTextureUploads_;
    } else {
      palette->indices = textures.ids[0]; palette->table = textures.ids[1];
      palette->indexChannels = l.kind == TextureKind::Dense8 ? 1 : l.kind == TextureKind::Sparse24 ? 3 : 2;
      palette->height = l.planes[1].height; palette->bytes = bytes;
      if (textures.ids.size() == 4) { palette->blocks = textures.ids[2]; palette->residual = textures.ids[3]; }
      slot.palette = std::move(palette);
    }
    textureCreates_ += textures.ids.size(); textureEpoch_ += textures.ids.size();
    std::fill(textures.ids.begin(),textures.ids.end(),0);
    gpuBytes_ += bytes; peakGpuBytes_ = std::max(peakGpuBytes_,gpuBytes_); textureUploadBytes_ += bytes;
    for (auto& p : backing.pages) { p.pixels.reset(); p.sparse.reset(); }
    return true;
  };
  if (layout) {
    if (upload(*layout,true)) { ++textureArtifactLoads_; return true; }
    ++textureArtifactFailures_; textureArtifactFailureReason_ = "chunk-or-upload";
  }
  ++sourceTextureBuilds_;
  auto pixels = readPixelsRegion(handle,0,0,slot.width,slot.height);
  if (!pixels) return false;
  const auto* decision = storageDecision(slot.cacheKey);
  if (decision && (decision->width != slot.width || decision->height != slot.height)) decision = nullptr;
  built = makePreparedTexture(*pixels,decision);
  return built && upload(built->layout,false);
} catch (const std::bad_alloc&) {
  ++textureArtifactFailures_; textureArtifactFailureReason_ = "allocation"; return false;
}

std::optional<PaletteImageRegion> ImageStore::resolvePaletteImage(ImageHandle handle, bool premultiplied) {
  auto info = inspect(handle);
  if (!info) return std::nullopt;
  auto& slot = slots_[(handle & indexMask) - 1U];
  if (!slot.paletteChecked && !slot.texture && !slot.astc) {
    if (realizeSourceTexture(handle)) {
      slot.paletteChecked = true;
      if (!slot.palette) return std::nullopt;
    }
    slot.paletteChecked = true;
    const auto* decision = storageDecision(slot.cacheKey);
    if (decision && (decision->width != slot.width || decision->height != slot.height)) decision = nullptr;
    if (decision) ++storageDecisionHits_;
    const bool sourcePalette = slot.prepared && slot.prepared->requiresSourceSampling();
    if (decision && !decision->paletteBits && !sourcePalette) return std::nullopt;
    auto pixels = slot.palette ? std::optional<ImagePixels>{} : readPixelsRegion(handle, 0, 0, slot.width, slot.height);
    if (pixels) {
      if (sourcePalette && decision && decision->paletteBits == 16) {
        auto sparse = makeSparsePalettePage(pixels->width, pixels->height, pixels->rgba);
        if (sparse) slot.palette = makeSparsePalette(*sparse, true);
      }
      if (!slot.palette) slot.palette = makePalette(*pixels, decision);
      if (!slot.palette && sourcePalette) {
        auto sparse = makeSparsePalettePage(pixels->width, pixels->height, pixels->rgba, 262144);
        if (sparse && sparse->indexBytes == 3 &&
            sparse->gpuBytes() + sparse->colors.size() * 3 < pixels->rgba.size())
          slot.palette = makeSparsePalette(*sparse, true);
      }
    }
    if (slot.palette && slot.prepared)
      for (auto& page : slot.prepared->pages) page.pixels.reset();
  }
  if (!slot.palette) return std::nullopt;
  const auto table = paletteTable(*slot.palette, premultiplied);
  if (!table) return std::nullopt;
  info->texture = slot.palette->indices;
  info->premultiplied = premultiplied;
  return PaletteImageRegion{*info, table, slot.palette->blocks, slot.palette->residual};
}

std::uint32_t ImageStore::paletteTable(PaletteBacking& palette, bool premultiplied) {
  auto table = palette.table;
  if (premultiplied && !palette.premultipliedReady) {
    bool changed = false;
    auto colors = palette.colors;
    for (std::size_t i = 0; i < colors.size(); i += 4)
      for (int c = 0; c < 3; ++c) {
        const auto value = static_cast<std::uint8_t>((unsigned(colors[i + c]) * colors[i + 3] + 127) / 255);
        changed |= value != colors[i + c];
        colors[i + c] = value;
      }
    if (changed) {
      if (!palette.premultipliedTable) {
        palette.premultipliedTable = uploadTexture(256, palette.height, colors.data(), {});
        if (!palette.premultipliedTable) return 0;
        palette.bytes += colors.size();
        gpuBytes_ += colors.size();
        textureUploadBytes_ += colors.size();
        ++textureCreates_; ++textureEpoch_;
        peakGpuBytes_ = std::max(peakGpuBytes_, gpuBytes_);
      }
    }
    palette.premultipliedReady = true;
  }
  if (premultiplied && palette.premultipliedTable) table = palette.premultipliedTable;
  return table;
}

std::optional<ImagePixels> ImageStore::readPalettePixels(const Slot& slot, std::optional<std::array<int, 4>> region) const {
  if (slot.prepared) {
    const auto r = region.value_or(std::array<int,4>{0,0,slot.width,slot.height});
    bool acquired = false;
    auto pixels = readPreparedRegion(*slot.prepared,r[0],r[1],r[2],r[3],&acquired);
    if (acquired) trimPreparedPages();
    return pixels;
  }
  ++paletteReadbacks_;
  auto pixels = readTexturePixels({0, slot.width, slot.height, slot.palette->indices}, {}, region);
  if (!pixels) return std::nullopt;
  for (std::size_t i = 0; i < pixels->rgba.size(); i += 4) {
    const auto index = unsigned(pixels->rgba[i]) | (unsigned(pixels->rgba[i + 1]) << 8);
    if (index * 4 + 4 > slot.palette->colors.size()) return std::nullopt;
    std::copy_n(slot.palette->colors.data() + index * 4, 4, pixels->rgba.data() + i);
  }
  return pixels;
}

bool ImageStore::materializePalette(Slot& slot) {
  auto pixels = readPalettePixels(slot);
  if (!pixels) return false;
  const auto storage = imageStorage(*pixels);
  const auto bytes = static_cast<std::size_t>(slot.width) * slot.height * storage.channels;
  const auto texture = uploadTexture(slot.width, slot.height, pixels->rgba.data(), storage);
  if (!texture) return false;
  slot.texture = texture;
  slot.storage = storage;
  gpuBytes_ += bytes;
  textureUploadBytes_ += bytes;
  ++textureCreates_; ++textureEpoch_;
  peakGpuBytes_ = std::max(peakGpuBytes_, gpuBytes_);
  // Earlier operations in this submission may still reference the index view.
  slot.retiredPalette = std::move(slot.palette);
  if (slot.inFlight.load(std::memory_order_acquire) == 0) clearRetiredTextures(slot);
  return true;
}

std::size_t ImageStore::paletteGpuBytes(const Slot& slot) const {
  std::size_t pages = 0;
  if (slot.prepared) for (const auto& page : slot.prepared->pages)
    { if (page.palette) pages += page.palette->bytes;
      for (const auto& palette : page.retiredPalettes) pages += palette->bytes; }
  return pages + (slot.palette ? slot.palette->bytes : 0U) +
    (slot.retiredPalette ? slot.retiredPalette->bytes : 0U);
}

std::size_t ImageStore::paletteCpuBytes(const Slot& slot) const {
  std::size_t pages = 0;
  if (slot.prepared) for (const auto& page : slot.prepared->pages)
    { if (page.palette) pages += page.palette->colors.capacity();
      for (const auto& palette : page.retiredPalettes) pages += palette->colors.capacity(); }
  return pages + (slot.palette ? slot.palette->colors.capacity() : 0U) +
    (slot.retiredPalette ? slot.retiredPalette->colors.capacity() : 0U);
}

std::optional<ImageInfo> ImageStore::createImage(int width, int height,
    const void* pixels, bool premultiplied, ImageChannelStorage storage,
    std::shared_ptr<PaletteBacking> palette, const ImageStorageDecision* decision) {
  const int channels = storage.channels;
  const auto extent = checkedImageExtent(width, height, 16384);
  if (!extent) return std::nullopt;
  std::size_t index = 0;
  while (index < slots_.size() && slots_[index].live) ++index;
  if (index >= indexMask) return std::nullopt;
  if (index == slots_.size()) slots_.emplace_back();
  const auto texture = palette ? 0U : uploadTexture(width, height, pixels, storage);
  if (!texture && !palette) return std::nullopt;
  if (!palette) ++textureCreates_;
  ++textureEpoch_;
  if (pixels && !palette) {
    textureUploadBytes_ += static_cast<std::uint64_t>(width) *
        static_cast<std::uint64_t>(height) * channels;
  }

  auto& slot = slots_[index];
  ++slot.contentRevision;
  slot.texture = texture;
  slot.palette = std::move(palette);
  slot.paletteChecked = true;
  slot.prepared.reset();
  slot.mipmapsReady = slot.premultipliedMipmapsReady = false;
  slot.mipmapBytes = slot.premultipliedMipmapBytes = 0;
  slot.width = width;
  slot.height = height;
  slot.storage = storage;
  slot.references = 1;
  slot.inFlight.store(0, std::memory_order_relaxed);
  slot.pins = 0;
  markUsed(slot);
  slot.cpuPixelFrames = 0;
  slot.retainCpuPixels = false;
  slot.cacheKey.clear();
  slot.sourcePath.clear();
  slot.lastPreparedFallbackReason.clear();
  slot.cachedPixels.reset();
  slot.gpuOnly = pixels == nullptr;
  slot.renderTarget = false;
  slot.premultiplied = premultiplied;
  slot.knownAllZero = pixels && (decision && decision->hasPixelFacts ? decision->allZero : allZeroRgba(pixels, width, height, width));
  if (decision && decision->hasPixelFacts) {
    slot.opaque = decision->opaque;
    slot.opacityRevision = slot.contentRevision;
  }
  slot.live = true;
  ++liveCount_;
  if (texture) gpuBytes_ += static_cast<std::size_t>(width) * height * channels;
  peakGpuBytes_ = std::max(peakGpuBytes_, gpuBytes_);
  return ImageInfo{makeHandle(index, slot.generation), width, height, texture,
                   premultiplied, slot.knownAllZero};
}

std::optional<ImageInfo> ImageStore::createRenderTarget(int width, int height,
                                                       bool premultiplied) {
  auto image = createRgba(width, height, nullptr, premultiplied);
  if (image) slots_[(image->handle & indexMask) - 1U].renderTarget = true;
  return image;
}

std::size_t ImageStore::cpuBytes() const {
  std::size_t result = 0;
  std::unordered_set<const void*> seen;
  for (const auto& slot : slots_) {
    if (slot.live && slot.cachedPixels) result += slot.cachedPixels->rgba.capacity();
    if (slot.live) {
      result += paletteCpuBytes(slot);
      if (slot.prepared) for (const auto& page : slot.prepared->pages)
        { if (page.palette && !seen.insert(page.palette.get()).second) result -= page.palette->colors.capacity();
          for (const auto& palette : page.retiredPalettes)
            if (!seen.insert(palette.get()).second) result -= palette->colors.capacity(); }
    }
    if (slot.live && slot.prepared) for (const auto& page : slot.prepared->pages)
      {
        if (page.pixels && seen.insert(page.pixels.get()).second) result += page.pixels->rgba.capacity();
        if (page.sparse && seen.insert(page.sparse.get()).second) result += page.sparse->cpuBytes();
      }
  }
  return result;
}

std::size_t ImageStore::residentBytes(const Slot& slot) const {
  std::size_t ownedCells = 0;
  if (slot.prepared) for (const auto image : slot.prepared->cellImages)
    if (inspect(image)) ownedCells += residentBytes(slots_[(image & indexMask)-1U]);
  if (slot.prepared) for (const auto& frame : preparedFrames_)
    if (frame.owner == slot.prepared.get()) ownedCells += frame.bytes;
  const auto sharedMipBytes = (slot.sharedTexture ? slot.sharedTexture->mipmapBytes : 0U) +
      (slot.sharedPremultipliedTexture ? slot.sharedPremultipliedTexture->mipmapBytes : 0U);
  if (slot.prepared) {
    for (const auto& page : slot.prepared->pages) {
      if (page.sharedTexture) ownedCells += page.sharedTexture->bytes + page.sharedTexture->mipmapBytes;
      if (page.sharedPremultipliedTexture) ownedCells += page.sharedPremultipliedTexture->bytes + page.sharedPremultipliedTexture->mipmapBytes;
    }
    for (const auto& block : slot.prepared->blockTextures)
      if (block.sharedAtlas) ownedCells += block.sharedAtlas->bytes;
  }
  return paletteGpuBytes(slot) + paletteCpuBytes(slot) + ownedCells + sharedMipBytes + slot.retiredTextureBytes + slot.textureBytes() *
      ((slot.texture ? 1U : 0U) + (slot.premultipliedTexture && slot.premultipliedTexture != slot.texture ? 1U : 0U)) +
      (slot.prepared ? slot.prepared->gpuBytes : 0U) +
      slot.mipmapBytes + slot.premultipliedMipmapBytes +
      (slot.cachedPixels ? slot.cachedPixels->rgba.capacity() : 0U) +
      (slot.prepared ? [&]() { std::size_t bytes = 0; for (const auto& page : slot.prepared->pages) { if (page.pixels) bytes += page.pixels->rgba.capacity(); if (page.sparse) bytes += page.sparse->cpuBytes(); } return bytes; }() : 0U);
}

std::size_t ImageStore::warmBytes() const {
  std::size_t result = 0;
  std::unordered_map<const void*, std::size_t> warm;
  std::unordered_set<const void*> active;
  for (const auto& slot : slots_) {
    if (!slot.live) continue;
    const bool isWarm = slot.references == 0 && slot.pins == 0 &&
        slot.inFlight.load(std::memory_order_acquire) == 0 && !slot.cacheKey.empty();
    auto bytes = isWarm ? residentBytes(slot) : 0U;
    const auto shared = [&](const void* pointer, std::size_t size) {
      if (!pointer) return;
      if (isWarm) { bytes -= size; warm[pointer] = size; }
      else active.insert(pointer);
    };
    const auto texture = [&](const std::shared_ptr<SharedTexture>& owner) {
      if (owner) shared(owner.get(), owner->bytes + owner->mipmapBytes);
    };
    texture(slot.sharedTexture); texture(slot.sharedPremultipliedTexture);
    if (slot.prepared) {
      for (const auto& page : slot.prepared->pages) {
        if (page.pixels) shared(page.pixels.get(), page.pixels->rgba.capacity());
        if (page.sparse) shared(page.sparse.get(), page.sparse->cpuBytes());
        texture(page.sharedTexture); texture(page.sharedPremultipliedTexture);
        if (page.palette) shared(page.palette.get(), page.palette->bytes + page.palette->colors.capacity());
        for (const auto& palette : page.retiredPalettes) shared(palette.get(), palette->bytes + palette->colors.capacity());
      }
      for (const auto& block : slot.prepared->blockTextures) texture(block.sharedAtlas);
    }
    result += bytes;
  }
  for (const auto& [pointer, bytes] : warm) if (!active.contains(pointer)) result += bytes;
  return result + tileWarmBytes();
}

std::size_t ImageStore::warmCount() const {
  std::size_t result = 0;
  for (const auto& slot : slots_) {
    if (slot.live && slot.references == 0 && slot.pins == 0 &&
        slot.inFlight.load(std::memory_order_acquire) == 0 &&
        !slot.cacheKey.empty()) ++result;
  }
  return result;
}

std::size_t ImageStore::warmFileCount() const {
  std::unordered_set<const ImageFileSource*> files;
  for (const auto& slot : slots_) {
    if (!slot.live || slot.references != 0 || slot.pins != 0 || slot.cacheKey.empty() ||
        slot.inFlight.load(std::memory_order_acquire) != 0) continue;
    if (slot.prepared) for (const auto& page : slot.prepared->pages)
      if (page.source) files.insert(page.source.get());
    if (slot.astc) {
      if (slot.astc->original) files.insert(slot.astc->original.get());
      for (const auto& page : slot.astc->pages) if (page) files.insert(page.get());
    }
    collectTileFiles(slot, files);
  }
  return files.size();
}

std::size_t ImageStore::pinnedBytes() const {
  std::size_t result = 0;
  for (std::size_t i = 0; i < slots_.size(); ++i) {
    const auto& slot = slots_[i];
    if (!slot.live || slot.pins == 0) continue;
    const ImageHandle h = makeHandle(i, slot.generation);
    if (h == fallbackHandle_) continue;  // store-internal; exclude from user metrics
    result += residentBytes(slot);
  }
  return result;
}

std::size_t ImageStore::pinnedCount() const {
  std::size_t result = 0;
  for (std::size_t i = 0; i < slots_.size(); ++i) {
    const auto& slot = slots_[i];
    if (!slot.live || slot.pins == 0) continue;
    const ImageHandle h = makeHandle(i, slot.generation);
    if (h == fallbackHandle_) continue;  // store-internal; exclude from user metrics
    ++result;
  }
  return result;
}

std::vector<ImageMemoryEntry> ImageStore::memoryEntries() const {
  std::vector<ImageMemoryEntry> result;
  result.reserve(liveCount_);
  for (std::size_t index = 0; index < slots_.size(); ++index) {
    const auto& slot = slots_[index];
    if (!slot.live) continue;
    std::size_t sharedGpuBytes = 0;
    std::unordered_set<const SharedTexture*> seenTextures;
    const auto addTexture = [&](const std::shared_ptr<SharedTexture>& texture, bool includeBase) {
      if (texture && seenTextures.insert(texture.get()).second)
        sharedGpuBytes += (includeBase ? texture->bytes : 0U) + texture->mipmapBytes;
    };
    addTexture(slot.sharedTexture, false);
    addTexture(slot.sharedPremultipliedTexture, false);
    if (slot.prepared) {
      for (const auto& page : slot.prepared->pages) {
        addTexture(page.sharedTexture, true);
        addTexture(page.sharedPremultipliedTexture, true);
      }
      for (const auto& block : slot.prepared->blockTextures) addTexture(block.sharedAtlas, true);
    }
    const bool sceneryBacking = slot.prepared || slot.tiles;
    result.push_back({makeHandle(index, slot.generation), slot.width, slot.height,
      slot.references, slot.inFlight.load(std::memory_order_acquire), slot.pins,
      paletteGpuBytes(slot) + slot.retiredTextureBytes + slot.textureBytes() *
        ((slot.texture ? 1U : 0U) + (slot.premultipliedTexture && slot.premultipliedTexture != slot.texture ? 1U : 0U)) +
        (slot.prepared ? slot.prepared->gpuBytes : 0U) +
        slot.mipmapBytes + slot.premultipliedMipmapBytes + sharedGpuBytes,
      paletteCpuBytes(slot) + (slot.cachedPixels ? slot.cachedPixels->rgba.capacity() : 0U) +
        (slot.prepared ? [&]() { std::size_t bytes = 0; for (const auto& page : slot.prepared->pages) { if (page.pixels) bytes += page.pixels->rgba.capacity(); if (page.sparse) bytes += page.sparse->cpuBytes(); } return bytes; }() : 0U),
      slot.lastUsedSerial,
      slot.references == 0 && slot.pins == 0 &&
        slot.inFlight.load(std::memory_order_acquire) == 0 &&
        !slot.cacheKey.empty(),
      sceneryBacking, slot.sceneryFullMaterialized,
      slot.sceneryFirstMaterializationCaller,
      slot.sourcePath.generic_string()});
    auto& entry = result.back();
    entry.astc = bool(slot.astc);
    entry.fullTextureResident = slot.texture || slot.premultipliedTexture || slot.palette;
    entry.palette = bool(slot.palette);
    entry.paletteSparse = slot.palette && slot.palette->blocks != 0;
    entry.paletteIndexBits = slot.palette ? slot.palette->indexChannels * 8 : 0;
    if (slot.prepared) for (const auto& page : slot.prepared->pages) if (page.palette) {
      entry.palette = true;
      entry.paletteSparse |= page.palette->blocks != 0;
      entry.paletteIndexBits = std::max(entry.paletteIndexBits, page.palette->indexChannels * 8);
    }

  }
  return result;
}

bool ImageStore::updateRgba(ImageHandle handle, const void* pixels) {
  const auto info = lookup(handle);
  if (!info || !pixels) return false;
  if (!preservePixelReads(handle)) return false;
  auto& slot = slots_[(handle & indexMask) - 1U];
  ++slot.contentRevision;
  slot.knownAllZero = false;
  if (!detachSharedTexture(slot)) return false;
  clearPrepared(slot);
  if (!slot.astc) clearPremultipliedTexture(slot);
  const bool compact = slot.storage.channels != 4;
  bool ok = false;
  if (compact) {
    ok = promoteToRgba(slot, pixels);
  } else {
    while (glGetError() != GL_NO_ERROR) {}
    glBindTexture(GL_TEXTURE_2D, slot.texture);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, info->width, info->height,
                    GL_RGBA, GL_UNSIGNED_BYTE, pixels);
    ok = glGetError() == GL_NO_ERROR;
  }
  if (ok) {
    if (slot.cachedPixels) std::copy_n(static_cast<const std::uint8_t*>(pixels),
        slot.cachedPixels->rgba.size(), slot.cachedPixels->rgba.data());
    slot.knownAllZero = !slot.gpuOnly && !slot.renderTarget &&
        allZeroRgba(pixels, info->width, info->height, info->width);
    slots_[(handle & indexMask) - 1U].mipmapsReady = false;
    ++textureFullUpdates_;
    if (!compact) textureUploadBytes_ += static_cast<std::uint64_t>(info->width) *
        static_cast<std::uint64_t>(info->height) * 4U;
  }
  if (!ok) slot.cachedPixels.reset();
  return ok;
}

bool ImageStore::updateRgbaRegion(ImageHandle handle, int x, int y, int width,
                                  int height, const void* pixels,
                                  int sourceRowPixels) {
  const auto info = lookup(handle);
  if (!info || !pixels || x < 0 || y < 0 || width <= 0 || height <= 0 ||
      x + width > info->width || y + height > info->height ||
      sourceRowPixels < width) return false;
  if (!preservePixelReads(handle)) return false;
  auto& slot = slots_[(handle & indexMask) - 1U];
  ++slot.contentRevision;
  const bool canProveZero = slot.knownAllZero ||
      (x == 0 && y == 0 && width == info->width && height == info->height);
  slot.knownAllZero = false;
  if (!detachSharedTexture(slot)) return false;
  clearPrepared(slot);
  if (!slot.astc) clearPremultipliedTexture(slot);
  if (slot.storage.channels != 4 && !promoteToRgba(slot)) return false;
  while (glGetError() != GL_NO_ERROR) {}
  glBindTexture(GL_TEXTURE_2D, slot.texture);
  glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
  glPixelStorei(GL_UNPACK_ROW_LENGTH, sourceRowPixels);
  glTexSubImage2D(GL_TEXTURE_2D, 0, x, y, width, height, GL_RGBA,
                  GL_UNSIGNED_BYTE, pixels);
  glPixelStorei(GL_UNPACK_ROW_LENGTH, 0);
  const bool ok = glGetError() == GL_NO_ERROR;
  if (ok) {
    if (slot.cachedPixels) for (int row = 0; row < height; ++row)
      std::copy_n(static_cast<const std::uint8_t*>(pixels) + static_cast<std::size_t>(row)*sourceRowPixels*4,
                  static_cast<std::size_t>(width)*4,
                  slot.cachedPixels->rgba.data() + (static_cast<std::size_t>(y+row)*slot.width+x)*4);
    slot.knownAllZero = !slot.gpuOnly && !slot.renderTarget && canProveZero &&
        allZeroRgba(pixels, width, height, sourceRowPixels);
    slots_[(handle & indexMask) - 1U].mipmapsReady = false;
    ++textureRegionUpdates_;
    textureUploadBytes_ += static_cast<std::uint64_t>(width) *
        static_cast<std::uint64_t>(height) * 4U;
  }
  if (!ok) slot.cachedPixels.reset();
  return ok;
}

std::shared_ptr<ImagePixelSnapshot> ImageStore::deferPixelRead(ImageHandle handle,
    int x, int y, int width, int height) {
  const auto info = inspect(handle);
  if (!info || x < 0 || y < 0 || width <= 0 || height <= 0 ||
      int64_t(x) + width > info->width || int64_t(y) + height > info->height) return {};
  auto snapshot = std::make_shared<ImagePixelSnapshot>();
  snapshot->x = x; snapshot->y = y;
  snapshot->width = width; snapshot->height = height;
  snapshot->premultiplied = info->premultiplied;
  auto& readers = pixelReads_[handle];
  std::erase_if(readers, [](const auto& reader) { return reader.expired(); });
  readers.push_back(snapshot);
  return snapshot;
}

bool ImageStore::preservePixelReads(ImageHandle handle) {
  const auto found = pixelReads_.find(handle);
  if (found == pixelReads_.end()) return true;
  for (const auto& reader : found->second) if (auto snapshot = reader.lock()) {
    if (!snapshot->pixels) {
      snapshot->pixels = readPixelsRegion(handle, snapshot->x, snapshot->y,
        snapshot->width, snapshot->height);
      if (!snapshot->pixels) return false;
    }
  }
  pixelReads_.erase(found);
  return true;
}

bool ImageStore::supportsAstc() const {
  if (astcSupported_) return *astcSupported_;
  GLint major = 0, minor = 0, extensions = 0;
  glGetIntegerv(GL_MAJOR_VERSION, &major); glGetIntegerv(GL_MINOR_VERSION, &minor);
  bool supported = major > 3 || (major == 3 && minor >= 2);
  glGetIntegerv(GL_NUM_EXTENSIONS, &extensions);
  for (GLint i = 0; !supported && i < extensions; ++i) {
    const auto* extension = reinterpret_cast<const char*>(glGetStringi(GL_EXTENSIONS, i));
    supported = extension && (std::strcmp(extension, "GL_KHR_texture_compression_astc_ldr") == 0 ||
      std::strcmp(extension, "GL_KHR_texture_compression_astc_hdr") == 0);
  }
  astcSupported_ = supported;
  return supported;
}

std::optional<ImageInfo> ImageStore::lookupAstc(ImageHandle handle, bool premultiplied) {
  auto& slot = slots_[(handle & indexMask)-1U];
  const auto fallback = [&](const char* reason) -> std::optional<ImageInfo> {
    ++preparedFallbacks_[reason];
    if (!promoteAstc(slot)) return std::nullopt;
    return premultiplied ? lookupPremultiplied(handle) : lookup(handle);
  };
  if (!supportsAstc()) return fallback("astc-unsupported");
  const bool separate = premultiplied && slot.astc->pages.size() > 1;
  auto& texture = separate ? slot.premultipliedTexture : slot.texture;
  if (!texture) {
    const auto& page = slot.astc->pages[separate ? 1 : 0];
    const auto bytes = page ? readCapturedBytes(*page) : std::nullopt;
    if (!bytes || !validAstc4x4(*bytes, slot.width, slot.height)) {
      preparationInvalidations_->fetch_or(1, std::memory_order_relaxed);
      preparationFailures_->record(slot.sourcePath.string());
      return fallback("astc-invalid");
    }
    while (glGetError() != GL_NO_ERROR) {}
    GLuint created = 0;
    glGenTextures(1, &created); glBindTexture(GL_TEXTURE_2D, created);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glCompressedTexImage2D(GL_TEXTURE_2D, 0, 0x93B0, slot.width, slot.height, 0,
      static_cast<GLsizei>(slot.compressedBytes), bytes->data() + 16);
    if (!created || glGetError() != GL_NO_ERROR) {
      glDeleteTextures(1, &created);
      return fallback("astc-upload");
    }
    texture = created;
    gpuBytes_ += slot.compressedBytes; textureUploadBytes_ += slot.compressedBytes;
    peakGpuBytes_ = std::max(peakGpuBytes_, gpuBytes_);
    ++textureCreates_; ++textureEpoch_;
  }
  auto image = inspect(handle);
  image->texture = texture; image->premultiplied = premultiplied;
  return image;
}

bool ImageStore::promoteAstc(Slot& slot, const void* replacement) {
  if (!slot.astc) return true;
  auto pixels = replacement ? std::optional<ImagePixels>{} :
    (slot.astc->original ? decodeFile(*slot.astc->original) : std::nullopt);
  if (!replacement && !pixels) return false;
  GLint binding = 0; glGetIntegerv(GL_TEXTURE_BINDING_2D, &binding);
  const auto texture = uploadTexture(slot.width, slot.height,
    replacement ? replacement : pixels->rgba.data(), {});
  if (!texture) { glBindTexture(GL_TEXTURE_2D, binding); return false; }
  slot.retiredTextures = {slot.texture,
    slot.premultipliedTexture != slot.texture ? slot.premultipliedTexture : 0U};
  slot.retiredTextureBytes = slot.textureBytes() *
    ((slot.retiredTextures[0] ? 1U : 0U) + (slot.retiredTextures[1] ? 1U : 0U));
  slot.premultipliedTexture = 0;
  ++textureCreates_;
  slot.texture = texture; slot.storage = {}; slot.compressedBytes = 0; slot.astc.reset();
  slot.mipmapBytes = 0; slot.mipmapsReady = false;
  gpuBytes_ += slot.textureBytes();
  peakGpuBytes_ = std::max(peakGpuBytes_, gpuBytes_);
  if (slot.inFlight.load(std::memory_order_acquire) == 0) clearRetiredTextures(slot);
  textureUploadBytes_ += slot.textureBytes(); ++textureEpoch_;
  if (pixels) { slot.cachedPixels = std::move(pixels); slot.cpuPixelFrames = slot.retainCpuPixels ? 0 : 60; }
  return true;
}

void ImageStore::clearRetiredTextures(Slot& slot) {
  slot.retiredPalette.reset();
  if (slot.prepared) for (auto& page : slot.prepared->pages) page.retiredPalettes.clear();
  if (!slot.retiredTextureBytes) return;
  glDeleteTextures(static_cast<GLsizei>(slot.retiredTextures.size()), slot.retiredTextures.data());
  gpuBytes_ -= slot.retiredTextureBytes;
  slot.retiredTextures = {}; slot.retiredTextureBytes = 0;
  ++textureEpoch_;
}

bool ImageStore::promoteToRgba(Slot& slot, const void* replacement) {
  if (slot.astc) return promoteAstc(slot, replacement);
  std::optional<ImagePixels> snapshot;
  if (!replacement) {
    snapshot = readTexturePixels(ImageInfo{0, slot.width, slot.height, slot.texture}, slot.storage);
    if (!snapshot) return false;
    replacement = snapshot->rgba.data();
  }
  while (glGetError() != GL_NO_ERROR) {}
  glBindTexture(GL_TEXTURE_2D, slot.texture);
  glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, slot.width, slot.height, 0,
              GL_RGBA, GL_UNSIGNED_BYTE, replacement);
  if (glGetError() != GL_NO_ERROR) return false;
  // Retained geometry holds this texture name across image mutations.
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_SWIZZLE_R, GL_RED);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_SWIZZLE_G, GL_GREEN);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_SWIZZLE_B, GL_BLUE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_SWIZZLE_A, GL_ALPHA);
  clearPremultipliedTexture(slot);
  const auto count = static_cast<std::size_t>(slot.width) * slot.height;
  gpuBytes_ -= count * slot.storage.channels + slot.mipmapBytes;
  slot.mipmapBytes = 0;
  slot.mipmapsReady = false;
  slot.storage = {}; slot.compressedBytes = 0;
  gpuBytes_ += count * 4;
  peakGpuBytes_ = std::max(peakGpuBytes_, gpuBytes_);
  ++textureEpoch_;
  textureUploadBytes_ += count * 4;
  return true;
}

ImageHandle ImageStore::makeHandle(std::size_t index, std::uint16_t generation) {
  return (static_cast<std::uint32_t>(generation & generationMask) << 16U) |
         static_cast<std::uint32_t>(index + 1U);
}

std::optional<ImageInfo> ImageStore::inspect(ImageHandle handle) const {
  if ((handle & canvasHandleTag) != 0) return std::nullopt;
  const std::uint32_t encodedIndex = handle & indexMask;
  if (encodedIndex == 0) return std::nullopt;
  const std::size_t index = encodedIndex - 1U;
  const auto generation = static_cast<std::uint16_t>(handle >> 16U);
  if (index >= slots_.size()) return std::nullopt;
  const auto& slot = slots_[index];
  if (!slot.live || slot.generation != generation) return std::nullopt;
  return ImageInfo{handle, slot.width, slot.height, slot.texture,
                   slot.premultiplied, slot.knownAllZero};
}

std::optional<std::uint64_t> ImageStore::contentRevision(ImageHandle handle) const {
  if (!inspect(handle)) return std::nullopt;
  const auto& slot = slots_[(handle & indexMask) - 1U];
  // External framebuffer writes have no tracked content revision.
  if (slot.gpuOnly || slot.renderTarget || slot.tiles) return std::nullopt;
  return slot.contentRevision;
}

std::optional<bool> ImageStore::isOpaque(ImageHandle handle) {
  const auto revision = contentRevision(handle);
  if (!revision) return std::nullopt;
  const auto index = (handle & indexMask) - 1U;
  // Render targets retain an alpha channel regardless of their current pixels.
  if (slots_[index].renderTarget) return false;
  if (slots_[index].opacityRevision == *revision)
    return slots_[index].opaque;
  const auto info = inspect(handle);
  std::optional<ImagePixels> snapshot;
  const auto* pixels = readPixels(handle);
  if (!pixels) {
    snapshot = readPixelsRegion(handle, 0, 0, info->width, info->height);
    if (snapshot) pixels = &*snapshot;
  }
  if (!pixels) return std::nullopt;
  bool opaque = true;
  for (size_t i = 3; i < pixels->rgba.size(); i += 4) {
    if (pixels->rgba[i] != 255) { opaque = false; break; }
  }
  slots_[index].opaque = opaque;
  slots_[index].opacityRevision = *revision;
  return opaque;
}

bool ImageStore::isRenderTarget(ImageHandle handle) const {
  if (!inspect(handle)) return false;
  return slots_[(handle & indexMask) - 1U].renderTarget;
}

std::optional<ImageInfo> ImageStore::lookupPremultiplied(ImageHandle handle,
    const char* caller) {
  auto info = inspect(handle);
  if (!info) return info;
  auto& slot = slots_[(handle & indexMask) - 1U];
  if (slot.astc) return lookupAstc(handle, true);
  if (slot.palette) {
    if (!materializePalette(slot)) return std::nullopt;
    return lookupPremultiplied(handle, caller);
  }
  if (info->premultiplied) return info->texture ? info : lookup(handle, caller);
  if (slot.prepared || slot.tiles) {
    const bool sceneryBacking = slot.prepared || slot.tiles;
    if (!materialize(slot, true)) return std::nullopt;
    if (sceneryBacking && !slot.sceneryFullMaterialized) {
      slot.sceneryFullMaterialized = true;
      slot.sceneryFirstMaterializationCaller = caller ? caller : "unknown";
      ++sceneryFullFallbacks_;
    }
    info->texture = slot.premultipliedTexture; info->premultiplied = true;
    return info;
  }
  // Render targets are already framebuffer pixels, not decoded straight images.
  if (slot.gpuOnly) return info;
  if (!slot.premultipliedTexture) {
    auto pixels = slot.cachedPixels &&
        slot.cachedPixels->width == info->width &&
        slot.cachedPixels->height == info->height
      ? std::optional<ImagePixels>(*slot.cachedPixels)
      : readTexturePixels(*info, slot.storage);
    if (!pixels) return std::nullopt;
    bool changed = false;
    for (std::size_t offset = 0; offset < pixels->rgba.size(); offset += 4) {
      const unsigned alpha = pixels->rgba[offset + 3];
      for (std::size_t channel = 0; channel < 3; ++channel) {
        auto& value = pixels->rgba[offset + channel];
        const auto converted = static_cast<std::uint8_t>((value * alpha + 127) / 255);
        changed |= converted != value;
        value = converted;
      }
    }
    if (!changed) {
      slot.premultipliedTexture = slot.texture;
    } else {
      const auto texture = uploadTexture(info->width, info->height, pixels->rgba.data(), slot.storage);
      if (!texture) return std::nullopt;
      const auto bytes = static_cast<std::size_t>(info->width) * info->height * slot.storage.channels;
      slot.premultipliedTexture = texture;
      ++textureCreates_;
      ++textureEpoch_;
      textureUploadBytes_ += bytes;
      gpuBytes_ += bytes;
      peakGpuBytes_ = std::max(peakGpuBytes_, gpuBytes_);
    }
  }
  info->texture = slot.premultipliedTexture;
  info->premultiplied = true;
  return info;
}

bool ImageStore::ensureMipmaps(ImageHandle handle, bool premultiplied) {
  const auto dimensions = inspect(handle);
  if (!dimensions || (dimensions->width & (dimensions->width - 1)) ||
      (dimensions->height & (dimensions->height - 1))) return false;
  auto& original = slots_[(handle & indexMask)-1U];
  if (original.astc && !promoteAstc(original)) return false;
  const auto info = premultiplied ? lookupPremultiplied(handle) : lookup(handle);
  if (!info || (info->width & (info->width - 1)) || (info->height & (info->height - 1))) return false;
  auto& slot = slots_[(handle & indexMask) - 1U];
  const bool separate = info->texture != slot.texture;
  const auto& shared = separate ? slot.sharedPremultipliedTexture : slot.sharedTexture;
  auto& ready = shared ? shared->mipmapsReady :
      (separate ? slot.premultipliedMipmapsReady : slot.mipmapsReady);
  auto& bytes = shared ? shared->mipmapBytes :
      (separate ? slot.premultipliedMipmapBytes : slot.mipmapBytes);
  if (ready && !slot.renderTarget) return true;
  while (glGetError() != GL_NO_ERROR) {}
  glBindTexture(GL_TEXTURE_2D, info->texture);
  glGenerateMipmap(GL_TEXTURE_2D);
  if (glGetError() != GL_NO_ERROR) throw std::runtime_error("cannot generate image mipmaps");
  if (!bytes) {
    for (int w = info->width, h = info->height; w > 1 || h > 1;) {
      w = std::max(1, w / 2); h = std::max(1, h / 2);
      bytes += static_cast<std::size_t>(w) * h * slot.storage.channels;
    }
    gpuBytes_ += bytes;
    peakGpuBytes_ = std::max(peakGpuBytes_, gpuBytes_);
  }
  ready = true;
  return true;
}

void ImageStore::clearPremultipliedTexture(Slot& slot) {
  gpuBytes_ -= slot.premultipliedMipmapBytes;
  slot.premultipliedMipmapBytes = 0;
  slot.premultipliedMipmapsReady = false;
  if (!slot.sharedPremultipliedTexture && slot.premultipliedTexture && slot.premultipliedTexture != slot.texture) {
    ++textureEpoch_;
    glDeleteTextures(1, &slot.premultipliedTexture);
    gpuBytes_ -= slot.textureBytes();
  }
  slot.premultipliedTexture = 0;
  slot.sharedPremultipliedTexture.reset();
}

bool ImageStore::retain(ImageHandle handle) {
  if (!inspect(handle)) return false;
  const std::size_t index = (handle & indexMask) - 1U;
  ++slots_[index].references;
  markUsed(slots_[index]);
  return true;
}

void ImageStore::markUsed(Slot& slot) {
  slot.lastUsedSerial = ++useSerial_;
}

bool ImageStore::pin(ImageHandle handle) {
  if (!inspect(handle)) return false;
  auto& slot = slots_[(handle & indexMask) - 1U];
  ++slot.pins;
  markUsed(slot);
  return true;
}

bool ImageStore::unpin(ImageHandle handle) {
  if (!inspect(handle)) return false;
  const std::size_t index = (handle & indexMask) - 1U;
  auto& slot = slots_[index];
  if (slot.pins == 0) return false;
  --slot.pins;
  if (slot.pins == 0 && slot.references == 0 && slot.cacheKey.empty() &&
      slot.inFlight.load(std::memory_order_acquire) == 0) destroySlot(index);
  return true;
}

bool ImageStore::touch(ImageHandle handle) {
  if (!inspect(handle)) return false;
  markUsed(slots_[(handle & indexMask) - 1U]);
  return true;
}

void ImageStore::destroySlot(std::size_t index) {
  auto& slot = slots_[index];
  clearRetiredTextures(slot);
  slot.palette.reset();
  slot.paletteChecked = false;
  preparedFrameResidentBytes_ -= slot.preparedFrameBytes;
  slot.preparedFrameBytes = 0;
  if (slot.prepared) clearPreparedFrames(slot.prepared.get());
  pixelReads_.erase(makeHandle(index, slot.generation));
  slot.astc.reset();
  slot.sceneryFullMaterialized = false;
  slot.sceneryFirstMaterializationCaller.clear();
  clearPremultipliedTexture(slot);
  if (!slot.cacheKey.empty()) pathCache_.erase(slot.cacheKey);
  ++textureEpoch_;
  if (!slot.sharedTexture) glDeleteTextures(1, &slot.texture);
  gpuBytes_ -= slot.mipmapBytes;
  slot.mipmapBytes = 0;
  if (slot.texture && !slot.sharedTexture) gpuBytes_ -= slot.textureBytes();
  slot.sharedTexture.reset();
  if (slot.prepared) {
    slot.prepared->clearBlockTextures();
    slot.prepared->clearCompactTextures();
    for (auto& page : slot.prepared->pages) {
      if (!page.sharedPremultipliedTexture && page.premultipliedTexture && page.premultipliedTexture != page.texture) glDeleteTextures(1, &page.premultipliedTexture);
      if (!page.sharedTexture && page.texture) glDeleteTextures(1, &page.texture);
    }
    gpuBytes_ -= slot.prepared->gpuBytes;
    for (const auto image : slot.prepared->cellImages) if (image) release(image);
  }
  slot.texture = 0; slot.compressedBytes = 0;
  slot.width = 0;
  slot.height = 0;
  slot.references = 0;
  slot.inFlight.store(0, std::memory_order_relaxed);
  slot.pins = 0;
  slot.lastUsedSerial = 0;
  slot.cpuPixelFrames = 0;
  slot.retainCpuPixels = false;
  slot.cacheKey.clear();
  slot.sourcePath.clear();
  slot.lastPreparedFallbackReason.clear();
  slot.cachedPixels.reset();
  slot.prepared.reset();
  slot.tiles.reset();
  slot.live = false;
  slot.knownAllZero = false;
  slot.generation = static_cast<std::uint16_t>((slot.generation + 1U) & generationMask);
  if (slot.generation == 0) slot.generation = 1;
  --liveCount_;
}

bool ImageStore::release(ImageHandle handle) {
  const auto info = inspect(handle);
  if (!info) return false;
  const std::size_t index = (handle & indexMask) - 1U;
  auto& slot = slots_[index];
  if (slot.references == 0) return false;
  --slot.references;
  if (slot.references != 0) return true;
  markUsed(slot);
  // Anonymous RGBA surfaces cannot be reacquired by path, but explicit pins
  // may still extend their lifetime.
  if (slot.cacheKey.empty() && slot.pins == 0 &&
      slot.inFlight.load(std::memory_order_acquire) == 0) destroySlot(index);
  return true;
}

bool ImageStore::beginUse(ImageHandle handle) {
  if (!inspect(handle)) return false;
  const std::size_t index = (handle & indexMask) - 1U;
  slots_[index].inFlight.fetch_add(1, std::memory_order_acq_rel);
  return true;
}

bool ImageStore::endUse(ImageHandle handle) {
  if (!inspect(handle)) return false;
  const std::size_t index = (handle & indexMask) - 1U;
  auto& slot = slots_[index];
  const auto previous = slot.inFlight.fetch_sub(1, std::memory_order_acq_rel);
  if (previous == 0) {
    slot.inFlight.store(0, std::memory_order_release);
    return false;
  }
  if (previous == 1) clearRetiredTextures(slot);
  if (previous == 1 && slot.references == 0 && slot.pins == 0 &&
      slot.cacheKey.empty()) {
    destroySlot(index);
  }
  return true;
}

void ImageStore::update() {
  for (const auto handle : activePreparedFrames_) endUse(handle);
  activePreparedFrames_.clear();
  trimPreparedPageTextures();
  std::size_t currentWarmBytes = 0;
  for (std::size_t index = 0; index < slots_.size(); ++index) {
    auto& slot = slots_[index];
    if (!slot.live) continue;
    // Explicitly retained slots keep CPU pixels for the life of the texture;
    // on-demand buffers age out here.
    if (slot.cachedPixels && !slot.retainCpuPixels) {
      if (slot.cpuPixelFrames > 0) {
        --slot.cpuPixelFrames;
      } else {
        slot.cachedPixels.reset();
      }
    }
  }
  std::erase_if(preparedTextures_, [](const auto& entry) { return entry.second.expired(); });
  std::erase_if(preparedPalettes_, [](const auto& entry) { return entry.second.expired(); });
  {
    std::lock_guard lock(preparedPool_->mutex);
    std::erase_if(preparedPool_->pages, [](const auto& entry) { return entry.second.expired(); });
  }
  currentWarmBytes = warmBytes();
  auto overBudget = [&]() {
    return currentWarmBytes > warmBudgetBytes_ || warmCount() > warmEntryLimit ||
      warmFileCount() > warmFileLimit || (warmBudgetBytes_ == 0 && warmCount() != 0);
  };
  if (!overBudget()) return;
  std::vector<std::pair<std::uint64_t, std::size_t>> warmEntries;
  for (std::size_t index = 0; index < slots_.size(); ++index) {
    const auto& slot = slots_[index];
    if (slot.live && slot.references == 0 && slot.pins == 0 &&
        !slot.cacheKey.empty() &&
        slot.inFlight.load(std::memory_order_acquire) == 0) {
      warmEntries.emplace_back(slot.lastUsedSerial, index);
    }
  }
  std::sort(warmEntries.begin(), warmEntries.end());
  for (const auto& entry : warmEntries) {
    if (!overBudget()) break;
    const std::size_t index = entry.second;
    auto& slot = slots_[index];
    if (!slot.live || slot.references != 0 || slot.pins != 0 ||
        slot.cacheKey.empty() ||
        slot.inFlight.load(std::memory_order_acquire) != 0) continue;
    destroySlot(index);
    currentWarmBytes = warmBytes();
    ++budgetEvictions_;
  }
}

void ImageStore::clearPrepared(Slot& slot) {
  if (slot.tiles) ++textureEpoch_;
  slot.tiles.reset();
  if (!slot.prepared) return;
  clearPreparedFrames(slot.prepared.get());
  if (slot.prepared->compactTables[0] || std::any_of(slot.prepared->blockTextures.begin(),
      slot.prepared->blockTextures.end(), [](const auto& textures) { return textures.atlas || textures.table; })) ++textureEpoch_;
  slot.prepared->clearBlockTextures();
  slot.prepared->clearCompactTextures();
  for (auto& page : slot.prepared->pages) {
    if (!page.sharedPremultipliedTexture && page.premultipliedTexture && page.premultipliedTexture != page.texture) glDeleteTextures(1, &page.premultipliedTexture);
    if (!page.sharedTexture && page.texture) glDeleteTextures(1, &page.texture);
  }
  gpuBytes_ -= slot.prepared->gpuBytes;
  for (const auto image : slot.prepared->cellImages) if (image) release(image);
  slot.prepared.reset();
}

bool ImageStore::installPrepared(const std::filesystem::path& sourcePath,
                                const std::filesystem::path& directory,
                                PreparedImageDescriptor descriptor,
                                const std::string& expectedSourceIdentity,
                                const std::vector<std::string>* pageIdentities, std::vector<std::string>* capturedPages,
                                const std::string& backingHash, const std::vector<std::string>* pageHashes,
                                const std::string& textureHash) {
  if (descriptor.version != 1 || descriptor.halo < 1 || descriptor.halo > 32 || !checkedImageExtent(descriptor.width, descriptor.height,
      16384, 128U * 1024U * 1024U)) return false;
  auto original = pageIdentities ? nullptr : openFile(sourcePath);
  if (pageIdentities ? (expectedSourceIdentity.empty() || pageIdentities->size() != descriptor.pages.size()) :
      (!original || (!expectedSourceIdentity.empty() && original->key() != expectedSourceIdentity &&
        !(validContentHash(backingHash) && inodeOnlyChange(expectedSourceIdentity, original->key()))))) return false;
  if ((!backingHash.empty() && !validContentHash(backingHash)) ||
      (!textureHash.empty() && !validContentHash(textureHash)) ||
      (pageHashes && (pageHashes->size() != descriptor.pages.size() ||
        !std::all_of(pageHashes->begin(), pageHashes->end(), validContentHash)))) return false;
  auto backing = std::make_shared<PreparedBacking>();
  const auto sourceIdentity = expectedSourceIdentity.empty() ? original->key() : expectedSourceIdentity;
  const bool astc = descriptor.compression == "astc-4x4";
  if (!descriptor.compression.empty() && !astc) return false;
  if (astc && (descriptor.uniform || descriptor.blockGrid || !descriptor.cells.empty() ||
      descriptor.pages.empty() || descriptor.pages.size() > 2)) return false;
  if (!astc && !descriptor.uniform && descriptor.cells.empty()) return false;
  std::size_t area = 0;
  for (const auto& cell : descriptor.cells) {
    const auto& r = cell.rect; const auto& c = cell.crop; const auto& a = cell.atlas;
    if (r[0] < 0 || r[1] < 0 || r[2] <= 0 || r[3] <= 0 ||
        r[0] > descriptor.width - r[2] || r[1] > descriptor.height - r[3] ||
        c[0] < 0 || c[1] < 0 || c[2] < 0 || c[3] < 0 ||
        c[0] > r[2] - c[2] || c[1] > r[3] - c[3]) return false;
    if (c[2] && c[3]) {
      if (cell.page < 0 || static_cast<std::size_t>(cell.page) >= descriptor.pages.size()) return false;
      const auto& page = descriptor.pages[cell.page];
      if (a[2] != c[2] || a[3] != c[3] || a[0] < descriptor.halo || a[1] < descriptor.halo ||
          a[0] + a[2] + descriptor.halo > page.width || a[1] + a[3] + descriptor.halo > page.height) return false;
    }
    area += static_cast<std::size_t>(r[2]) * r[3];
  }
  if (!validBlockGrid(descriptor)) return false;
  if (!astc && !descriptor.uniform) {
    if (area != static_cast<std::size_t>(descriptor.width) * descriptor.height) return false;
    if (descriptor.blockGrid) {
      constexpr int block = 64;
      const auto& grid = *descriptor.blockGrid;
      const int frameWidth = grid[1], frameHeight = grid[2];
      const int blocksPerFrameX = (frameWidth + block - 1) / block;
      const int blocksPerFrameY = (frameHeight + block - 1) / block;
      const int blocksAcross = blocksPerFrameX * (descriptor.width / frameWidth);
      const int totalBlocks = blocksAcross * blocksPerFrameY * (descriptor.height / frameHeight);
      std::vector<std::uint8_t> occupied(static_cast<std::size_t>(totalBlocks));
      for (const auto& cell : descriptor.cells) {
        const auto& r = cell.rect;
        const int frameX = r[0] / frameWidth, frameY = r[1] / frameHeight;
        const int localX = r[0] % frameWidth, localY = r[1] % frameHeight;
        const int firstX = frameX * blocksPerFrameX + localX / block;
        const int lastX = frameX * blocksPerFrameX + (localX + r[2] + block - 1) / block;
        const int firstY = frameY * blocksPerFrameY + localY / block;
        const int lastY = frameY * blocksPerFrameY + (localY + r[3] + block - 1) / block;
        for (int y = firstY; y < lastY; ++y)
          for (int x = firstX; x < lastX; ++x) {
            const auto index = static_cast<std::size_t>(y) * blocksAcross + x;
            if (occupied[index]) return false;
            occupied[index] = 1;
          }
      }
    } else {
      for (std::size_t i = 0; i < descriptor.cells.size(); ++i)
        for (std::size_t j = 0; j < i; ++j) {
          const auto& a = descriptor.cells[i].rect; const auto& b = descriptor.cells[j].rect;
          if (a[0] < b[0] + b[2] && b[0] < a[0] + a[2] &&
              a[1] < b[1] + b[3] && b[1] < a[1] + a[3]) return false;
        }
    }
  }
  if (descriptor.blockChannels && (!descriptor.blockGrid || *descriptor.blockChannels < 0 || *descriptor.blockChannels > 2)) return false;
  for (const auto& page : descriptor.pages) {
    if (page.width <= 0 || page.height <= 0 || page.width > (astc ? 8192 : 2048) || page.height > (astc ? 8192 : 2048) ||
        (astc && (page.width != descriptor.width || page.height != descriptor.height || page.path.extension() != ".astc")) ||
        page.path.empty() || page.path.is_absolute() || page.path.has_parent_path()) return false;
    PreparedBacking::Page prepared;
    if (pageIdentities) {
      prepared.path = directory / page.path; prepared.identity = pageIdentities->at(backing->pages.size());
      if (prepared.identity.empty()) return false;
    } else {
      auto source = openFile(directory / page.path);
      if (!source) return false;
      prepared.path = source->path(); prepared.identity = source->key();
    }
    if (pageHashes) prepared.expectedHash = pageHashes->at(backing->pages.size());
    backing->pages.push_back(std::move(prepared));
  }
  if (capturedPages) for (const auto& page : backing->pages) capturedPages->push_back(page.identity);
  if (!descriptor.textureArtifact.empty()) {
    if (descriptor.textureArtifact != "texture.pmtx" || !descriptor.framePages || astc || descriptor.uniform) return false;
    backing->texturePath = directory / descriptor.textureArtifact;
    backing->textureHash = textureHash;
  }
  backing->descriptor = std::move(descriptor);
  backing->sourceIdentity = sourceIdentity;
  backing->sourceHash = backingHash;
  const auto canonicalSource = original ? original->path().string() : sourcePath.string();
  preparedSources_[canonicalSource] = std::move(backing);
  return true;
}

std::shared_ptr<ImageStore::PreparedLoad> ImageStore::capturePrepared(
    const ImageFileSource& source, const std::string& tileSet) const {
  if (!tileSet.empty()) {
    auto tiles = captureTileLoad(source, tileSet);
    if (!tiles) return nullptr;
    auto load = std::make_shared<PreparedLoad>(); load->tiles = std::move(tiles); return load;
  }
  std::shared_ptr<PreparedBacking> prototype;
  const auto cached = pathCache_.find(source.key());
  if (cached != pathCache_.end() && inspect(cached->second))
    prototype = slots_[(cached->second & indexMask) - 1U].prepared;
  const auto found = preparedSources_.find(source.path().string());
  if (!prototype && found != preparedSources_.end() && found->second->sourceIdentity != source.key() &&
      !(validContentHash(found->second->sourceHash) && inodeOnlyChange(found->second->sourceIdentity, source.key()))) {
    preparationInvalidations_->fetch_or(1, std::memory_order_relaxed);
    preparationFailures_->record(source.path().string());
    return nullptr;
  }
  if (!prototype && found == preparedSources_.end()) return nullptr;
  auto load = std::make_shared<PreparedLoad>();
  load->invalidations = preparationInvalidations_;
  load->failures = preparationFailures_; load->sourceName = source.path().string();
  if (!prototype) prototype = found->second;
  struct stat current{};
  if (fstat(source.descriptor_, &current) != 0 ||
      current.st_size != static_cast<off_t>(source.size_) ||
      current.st_mtim.tv_sec != source.modifiedSeconds_ ||
      current.st_mtim.tv_nsec != source.modifiedNanoseconds_) {
    preparationInvalidations_->fetch_or(1, std::memory_order_relaxed);
    preparationFailures_->record(source.path().string());
    return nullptr;
  }
  load->backing = std::make_shared<PreparedBacking>();
  auto& backing = *load->backing;
  backing.pageDecodes = preparedPageDecodes_;
  backing.pool = preparedPool_;
  backing.descriptor = prototype->descriptor;
  backing.sourceIdentity = source.key();
  backing.sourceHash = prototype->sourceHash;
  if (backing.descriptor.compression == "astc-4x4") {
    load->original.reset(new ImageFileSource());
    auto& captured = *load->original;
    captured.descriptor_ = fcntl(source.descriptor_, F_DUPFD_CLOEXEC, 0);
    if (captured.descriptor_ < 0) return nullptr;
    captured.size_ = source.size_; captured.modifiedSeconds_ = source.modifiedSeconds_;
    captured.modifiedNanoseconds_ = source.modifiedNanoseconds_;
    captured.path_ = source.path_; captured.key_ = source.key_; captured.encryptionKey_ = source.encryptionKey_;
  }
  if (prototype->sourceIdentity != source.key()) {
    load->sourceToVerify.reset(new ImageFileSource());
    auto& captured = *load->sourceToVerify;
    captured.descriptor_ = fcntl(source.descriptor_, F_DUPFD_CLOEXEC, 0);
    if (captured.descriptor_ < 0) return nullptr;
    captured.size_ = source.size_; captured.modifiedSeconds_ = source.modifiedSeconds_;
    captured.modifiedNanoseconds_ = source.modifiedNanoseconds_;
    captured.path_ = source.path_; captured.key_ = source.key_;
  }
  backing.texturePath = prototype->texturePath;
  backing.textureHash = prototype->textureHash;
  backing.textureSource = prototype->textureSource ? prototype->textureSource :
    backing.texturePath.empty() ? nullptr : openFile(backing.texturePath);
  for (const auto& page : prototype->pages) {
    auto file = page.source ? page.source : std::shared_ptr<ImageFileSource>(openFile(page.path));
    if (!file || (file->key() != page.identity &&
        !(validContentHash(page.expectedHash) && inodeOnlyChange(page.identity, file->key())))) {
      preparationInvalidations_->fetch_or(1, std::memory_order_relaxed);
    preparationFailures_->record(source.path().string());
      return nullptr;
    }
    PreparedBacking::Page captured;
    captured.source = std::move(file);
    captured.path = page.path;
    captured.identity = captured.source->key();
    captured.expectedHash = page.expectedHash;
    captured.verifyHash = captured.identity != page.identity;
    backing.pages.push_back(std::move(captured));
  }
  return load;
}

std::shared_ptr<ImageFileSource> ImageStore::capturePreparedFallback(const PreparedLoad& load) {
  return load.tiles ? nullptr : load.original;
}

std::optional<ImagePixels> ImageStore::decodePreparedFallback(const PreparedLoad& load) const {
  if (load.tiles) return decodeTileFallback(*load.tiles);
  return load.original ? decodeFile(*load.original) : std::nullopt;
}

bool ImageStore::validatePrepared(PreparedLoad& load, bool retainCpu) {
  if (load.tiles) { load.validated = validateTileLoad(*load.tiles, retainCpu); return load.validated; }
  auto& backing = *load.backing;
  if (!load.validated) {
    const auto invalid = [&load]() {
      if (load.invalidations) load.invalidations->fetch_or(1, std::memory_order_relaxed);
      if (load.failures) load.failures->record(load.sourceName);
      return false;
    };
    if (load.sourceToVerify) {
      const auto bytes = readCapturedBytes(*load.sourceToVerify);
      const auto offset = load.sourceToVerify->encryptionKey_ ? 16U : 0U;
      if (!bytes || !contentHashMatches(std::span(*bytes).subspan(offset), backing.sourceHash)) return invalid();
      load.sourceToVerify.reset();
    }
    const bool deferRecovery = !retainCpu && backing.textureSource &&
      validContentHash(backing.textureHash) && std::all_of(backing.pages.begin(), backing.pages.end(),
        [](const auto& page) { return validContentHash(page.expectedHash); });
    for (std::size_t i = 0; i < backing.pages.size(); ++i) {
      if (deferRecovery) {
        auto& page = backing.pages[i];
        const auto bytes = page.source ? readCapturedBytes(*page.source) : std::nullopt;
        if (!bytes || !contentHashMatches(*bytes, page.expectedHash)) return invalid();
        page.verifyHash = true;
        continue;
      }
      if (backing.descriptor.compression == "astc-4x4") {
        const auto& page = backing.pages[i];
        const auto bytes = page.source ? readCapturedBytes(*page.source) : std::nullopt;
        if (!bytes || !validAstc4x4(*bytes, backing.descriptor.width, backing.descriptor.height) ||
            (page.verifyHash && !contentHashMatches(*bytes, page.expectedHash))) return invalid();
      } else if (!preparedSparsePage(backing, i) && !preparedPixels(backing, i)) return invalid();
      if (!retainCpu && backing.textureSource) {
        backing.pages[i].pixels.reset();
        backing.pages[i].sparse.reset();
      }
    }
    load.validated = true;
  }
  if (retainCpu && !load.pixels &&
      checkedImageExtent(backing.descriptor.width, backing.descriptor.height, 16384)) {
    load.pixels = backing.descriptor.compression == "astc-4x4" ?
      (load.original ? decodeFile(*load.original) : std::nullopt) :
      readPreparedRegion(backing, 0, 0, backing.descriptor.width, backing.descriptor.height);
    for (auto& page : backing.pages) page.pixels.reset();
    if (!load.pixels) return false;
  }
  return true;
}

std::optional<ImageInfo> ImageStore::acquirePrepared(const ImageFileSource& source,
                                                     bool retainCpu) {
  if (auto cached = acquireCached(source)) {
    if (retainCpu) retainCpuPixels(cached->handle);
    return cached;
  }
  auto load = capturePrepared(source);
  if (!load || !validatePrepared(*load, retainCpu)) return std::nullopt;
  return installPreparedLoad(source, std::move(load), retainCpu);
}

std::optional<ImageInfo> ImageStore::installPreparedLoad(const ImageFileSource& source,
    std::shared_ptr<PreparedLoad> load, bool retainCpu) {
  if (!load || !load->validated) return std::nullopt;
  // Keep the captured snapshot available if page allocation needs fallback.
  if (load->tiles) return installTileLoad(load->tiles, retainCpu);
  auto pixels = std::move(load->pixels);
  if (auto cached = acquireCached(source)) {
    auto& slot = slots_[(cached->handle & indexMask) - 1U];
    if (retainCpu && pixels && slot.prepared) {
      slot.cachedPixels = std::move(pixels);
      slot.retainCpuPixels = true;
      slot.cpuPixelFrames = 0;
      for (auto& page : slot.prepared->pages) page.pixels.reset();
    } else if (retainCpu) retainCpuPixels(cached->handle);
    return cached;
  }
  if (load->backing->descriptor.compression == "astc-4x4") {
    GLint maxTexture = 0; glGetIntegerv(GL_MAX_TEXTURE_SIZE, &maxTexture);
    if (retainCpu || !supportsAstc() || load->backing->descriptor.width > maxTexture ||
        load->backing->descriptor.height > maxTexture) {
      if (!pixels && load->original) pixels = decodeFile(*load->original);
      return pixels ? installDecoded(source, std::move(*pixels), retainCpu) : std::nullopt;
    }
    auto image = createRgba(1, 1, nullptr);
    if (!image) return std::nullopt;
    auto& slot = slots_[(image->handle & indexMask)-1U];
    glDeleteTextures(1, &slot.texture); slot.texture = 0; gpuBytes_ -= 4;
    slot.width = load->backing->descriptor.width; slot.height = load->backing->descriptor.height;
    slot.storage = grayscaleStorage(1); slot.compressedBytes = astc4x4Bytes(slot.width, slot.height);
    slot.astc = std::make_shared<Slot::AstcBacking>();
    slot.astc->original = load->original;
    for (const auto& page : load->backing->pages) slot.astc->pages.push_back(page.source);
    slot.gpuOnly = false; slot.knownAllZero = false; slot.opaque = slot.astc->pages.size() == 1;
    slot.opacityRevision = slot.contentRevision;
    slot.cacheKey = source.key(); slot.sourcePath = source.path();
    pathCache_.emplace(slot.cacheKey, image->handle); ++preparedHits_;
    return inspect(image->handle);
  }
  auto cacheKey = source.key();
  auto sourcePath = source.path();
  auto backing = std::move(load->backing);
  const auto& descriptor = backing->descriptor;
  backing->cellImages.assign(backing->descriptor.cells.size() + 1, 0);
  std::size_t index = 0;
  while (index < slots_.size() && slots_[index].live) ++index;
  if (index >= indexMask) return std::nullopt;
  if (index == slots_.size()) slots_.emplace_back();
  auto& slot = slots_[index];
  slot.prepared = std::move(backing);
  slot.width = descriptor.width; slot.height = descriptor.height;
  slot.storage = {};
  ++slot.contentRevision;
  slot.texture = slot.premultipliedTexture = 0;
  slot.references = 1; slot.pins = 0; slot.inFlight.store(0);
  slot.cacheKey = std::move(cacheKey); slot.sourcePath = std::move(sourcePath);
  slot.gpuOnly = slot.renderTarget = slot.premultiplied = false;
  slot.knownAllZero = descriptor.uniform ?
      std::all_of(descriptor.uniform->begin(), descriptor.uniform->end(),
                  [](std::uint8_t v) { return v == 0; }) :
      std::all_of(descriptor.cells.begin(), descriptor.cells.end(),
                  [](const PreparedImageCell& cell) {
                    return (cell.crop[2] == 0 || cell.crop[3] == 0) &&
                      std::all_of(cell.fill.begin(), cell.fill.end(), [](std::uint8_t v) { return v == 0; });
                  });
  if (const auto* known = storageDecision(slot.cacheKey); known && known->hasPixelFacts &&
      known->width == slot.width && known->height == slot.height) {
    slot.knownAllZero = known->allZero;
    slot.opaque = known->opaque;
    slot.opacityRevision = slot.contentRevision;
  }
  slot.retainCpuPixels = retainCpu; slot.cachedPixels = std::move(pixels); slot.cpuPixelFrames = 0;
  slot.mipmapsReady = slot.premultipliedMipmapsReady = false;
  slot.mipmapBytes = slot.premultipliedMipmapBytes = 0;
  slot.live = true; markUsed(slot); ++liveCount_; ++preparedHits_;
  const auto handle = makeHandle(index, slot.generation);
  try {
    pathCache_.emplace(slot.cacheKey, handle);
    // Upload a bounded set of immutable pages before publishing image readiness.
    // Larger page sets remain pageable rather than expanding the source sheet.
    std::size_t staged = 0;
    if (!descriptor.framePages && hasPaletteStorage(handle)) for (std::size_t page=0; page<slot.prepared->pages.size(); ++page) {
      const auto& dimensions = slot.prepared->descriptor.pages[page];
      const auto bytes = static_cast<std::size_t>(dimensions.width)*dimensions.height*4U;
      if (bytes>preparedPageCacheBudget-staged) break;
      if (!preparedPage(slot,page,true)) break;
      staged += bytes;
    }
    trimPreparedPages();
  } catch (...) {
    destroySlot(index);
    throw;
  }
  return inspect(handle);
}

void ImageStore::trimPreparedPages() const {
  // Shared CPU pages stay resident until the global byte budget needs space.
  std::vector<std::pair<std::uint64_t, PreparedBacking::Page*>> pages;
  std::size_t bytes = 0;
  std::unordered_set<const void*> seen;
  for (auto& slot : slots_) if (slot.live && slot.prepared) {
    for (auto& page : slot.prepared->pages) if (page.pixels || page.sparse) {
      if (page.pixels && seen.insert(page.pixels.get()).second) bytes += page.pixels->rgba.capacity();
      if (page.sparse && seen.insert(page.sparse.get()).second) bytes += page.sparse->cpuBytes();
      pages.emplace_back(page.shared->lastCpuUse.load(std::memory_order_relaxed), &page);
    }
  }
  if (bytes <= preparedPageCacheBudget) return;
  std::stable_sort(pages.begin(), pages.end(), [](const auto& a, const auto& b) {
    return a.first < b.first;
  });
  for (auto& [serial, page] : pages) {
    if (bytes <= preparedPageCacheBudget) break;
    if (page->pixels) {
      const auto* storage = page->pixels.get();
      bytes -= page->pixels->rgba.capacity();
      for (auto& [otherSerial, other] : pages) {
        (void)otherSerial;
        if (other->pixels.get() == storage) other->pixels.reset();
      }
    }
    if (bytes <= preparedPageCacheBudget) break;
    if (page->sparse) {
      const auto* storage = page->sparse.get();
      bytes -= page->sparse->cpuBytes();
      for (auto& [otherSerial, other] : pages) {
        (void)otherSerial;
        if (other->sparse.get() == storage) other->sparse.reset();
      }
    }
  }
}

std::vector<std::array<float,4>> ImageStore::preparedSpriteParts(ImageHandle handle,
    const std::array<float,4>& source) const {
  const auto logical = inspect(handle);
  if (!logical || source[0]<0 || source[1]<0 || source[2]<=0 || source[3]<=0 ||
      source[0]+source[2]>logical->width || source[1]+source[3]>logical->height) return {};
  const auto& slot = slots_[(handle & indexMask)-1U];
  if (!slot.prepared || slot.tiles || slot.prepared->descriptor.uniform) return {};
  const auto& backing = *slot.prepared;
  const double bytes = (std::ceil(source[2])+2*backing.descriptor.halo+1)*
    (std::ceil(source[3])+2*backing.descriptor.halo+1)*4;
  if (!backing.frameCacheDisabled && bytes<=preparedFrameBudgetBytes_) return {};
  std::vector<std::array<float,4>> parts;
  double area = 0;
  for (const auto& cell : backing.descriptor.cells) {
    const auto& r = cell.rect;
    const float x=std::max(source[0],float(r[0])), y=std::max(source[1],float(r[1]));
    const float right=std::min(source[0]+source[2],float(r[0]+r[2]));
    const float bottom=std::min(source[1]+source[3],float(r[1]+r[3]));
    if (right<=x || bottom<=y) continue;
    if (std::any_of(cell.fill.begin(),cell.fill.end(),[](auto v){return v!=0;}) || !cell.crop[2] || !cell.crop[3]) return {};
    parts.push_back({x,y,right-x,bottom-y});
    area += double(right-x)*(bottom-y);
  }
  if (parts.size()<2 || std::abs(area-double(source[2])*source[3])>0.001) return {};
  return parts;
}

std::size_t ImageStore::preparedPageTextureBytes() const {
  std::unordered_set<const SharedTexture*> seen;
  std::size_t bytes = 0;
  for (const auto& slot : slots_) if (slot.live && slot.prepared)
    for (const auto& page : slot.prepared->pages)
      for (const auto& texture : {page.sharedTexture, page.sharedPremultipliedTexture})
        if (texture && seen.insert(texture.get()).second) bytes += texture->bytes;
  return bytes;
}

void ImageStore::trimPreparedPageTextures() {
  auto bytes = preparedPageTextureBytes();
  if (bytes <= preparedPageCacheBudget) return;
  std::vector<PreparedBacking::Page*> pages;
  for (auto& slot : slots_) if (slot.live && slot.prepared)
    for (auto& page : slot.prepared->pages)
      if (page.sharedTexture || page.sharedPremultipliedTexture) pages.push_back(&page);
  std::stable_sort(pages.begin(), pages.end(), [](const auto* a, const auto* b) { return a->lastGpuUse < b->lastGpuUse; });
  for (auto* page : pages) {
    if (bytes <= preparedPageCacheBudget) break;
    page->texture = page->premultipliedTexture = 0;
    page->sharedTexture.reset(); page->sharedPremultipliedTexture.reset();
    bytes = preparedPageTextureBytes();
  }
}

std::optional<ImagePixels> ImageStore::readPixelsRegion(ImageHandle handle,
    int x, int y, int width, int height) const {
  auto info = inspect(handle);
  const auto extent = checkedImageExtent(width, height, 16384);
  if (!info || !extent || x < 0 || y < 0 || x > info->width - width ||
      y > info->height - height) return std::nullopt;
  const auto& slot = slots_[(handle & indexMask) - 1U];
  // Prepared files remain authoritative when a GPU palette view also exists.
  if (slot.palette && !slot.prepared) return readPalettePixels(slot, std::array<int, 4>{x, y, width, height});
  if (slot.tiles) return readTileRegion(slot, x, y, width, height);
  if (!slot.prepared) {
    // Mutable GPU surfaces are read on demand; never retain a stale CPU copy.
    if (slot.gpuOnly || slot.renderTarget)
      return readTexturePixels(*info, slot.storage, std::array<int, 4>{x, y, width, height});
    auto* full = readPixels(handle);
    if (!full) {
      slot.cachedPixels = readTexturePixels(*info, slot.storage);
      full = slot.cachedPixels ? &*slot.cachedPixels : nullptr;
    }
    if (!full) return std::nullopt;
    if (!slot.retainCpuPixels) slot.cpuPixelFrames = 60;
    ImagePixels result{width, height, std::vector<std::uint8_t>(extent->rgbaBytes)};
    for (int row = 0; row < height; ++row)
      std::copy_n(full->rgba.data() + (static_cast<std::size_t>(y + row) * full->width + x) * 4,
                  static_cast<std::size_t>(width) * 4, result.rgba.data() + static_cast<std::size_t>(row) * width * 4);
    return result;
  }
  ++preparedRegionReads_;
  bool acquired = false;
  auto result = readPreparedRegion(*slot.prepared, x, y, width, height, &acquired);
  if (acquired) trimPreparedPages();
  return result;
}

std::optional<ImagePixels> ImageStore::readPreparedRegion(PreparedBacking& backing,
    int x, int y, int width, int height, bool* acquired) {
  const auto extent = checkedImageExtent(width, height, 16384);
  if (!extent) return std::nullopt;
  ImagePixels result{width, height, std::vector<std::uint8_t>(extent->rgbaBytes)};
  if (!readPreparedRegionInto(backing, x, y, width, height, result, 0, 0, acquired))
    return std::nullopt;
  return result;
}

bool ImageStore::readPreparedRegionInto(PreparedBacking& backing, int x, int y,
    int width, int height, ImagePixels& destination, int destinationX,
    int destinationY, bool* acquired) {
  const auto extent = checkedImageExtent(width, height, 16384);
  if (!extent || destination.width <= 0 || destination.height <= 0 ||
      destinationX < 0 || destinationY < 0 ||
      destinationX > destination.width - width ||
      destinationY > destination.height - height || x < 0 || y < 0 ||
      x > backing.descriptor.width - width ||
      y > backing.descriptor.height - height ||
      destination.rgba.size() < static_cast<std::size_t>(destination.width) *
        static_cast<std::size_t>(destination.height) * 4U) return false;
  const auto fillRectangle = [&](int left, int top, int right, int bottom,
                                 const std::array<std::uint8_t, 4>& color) {
    if (left >= right || top >= bottom ||
        std::all_of(color.begin(), color.end(), [](std::uint8_t value) { return value == 0; })) return;
    const auto rowBytes = static_cast<std::size_t>(right - left) * 4U;
    const auto stride = static_cast<std::size_t>(destination.width) * 4U;
    auto* first = destination.rgba.data() +
        static_cast<std::size_t>(destinationY + top - y) * stride +
        static_cast<std::size_t>(destinationX + left - x) * 4U;
    std::copy(color.begin(), color.end(), first);
    for (std::size_t filled = 4; filled < rowBytes;) {
      const auto count = std::min(filled, rowBytes - filled);
      std::memcpy(first + filled, first, count);
      filled += count;
    }
    for (int row = top + 1; row < bottom; ++row)
      std::memcpy(first + static_cast<std::size_t>(row - top) * stride, first, rowBytes);
  };
  if (backing.descriptor.uniform) {
    fillRectangle(x, y, x + width, y + height, *backing.descriptor.uniform);
    return true;
  }
  for (const auto& cell : backing.descriptor.cells) {
    const int left = std::max(x, cell.rect[0]), top = std::max(y, cell.rect[1]);
    const int right = std::min(x + width, cell.rect[0] + cell.rect[2]);
    const int bottom = std::min(y + height, cell.rect[1] + cell.rect[3]);
    if (left >= right || top >= bottom) continue;
    // Validated cells do not overlap; zero fill is already initialized.
    fillRectangle(left, top, right, bottom, cell.fill);
    const int cropX = cell.rect[0] + cell.crop[0], cropY = cell.rect[1] + cell.crop[1];
    const int copyLeft = std::max(left, cropX), copyTop = std::max(top, cropY);
    const int copyRight = std::min(right, cropX + cell.crop[2]);
    const int copyBottom = std::min(bottom, cropY + cell.crop[3]);
    if (copyLeft >= copyRight || copyTop >= copyBottom) continue;
    auto& page = backing.pages[cell.page];
    const bool hadSparse = bool(page.sparse);
    const bool sparse = !page.pixels && preparedSparsePage(backing, cell.page);
    const auto* pixels = sparse ? nullptr : preparedPixels(backing, cell.page, acquired);
    if (!sparse && !pixels) return false;
    if (sparse) {
      if (!hadSparse && acquired) *acquired = true;
      page.shared->lastCpuUse.store(backing.pool->cpuClock.fetch_add(1, std::memory_order_relaxed) + 1,
        std::memory_order_relaxed);
    }
    const auto rowBytes = static_cast<std::size_t>(copyRight - copyLeft) * 4U;
    for (int row = copyTop; row < copyBottom; ++row) {
      auto* destinationPixel = destination.rgba.data() +
          (static_cast<std::size_t>(destinationY + row - y) * destination.width +
           destinationX + copyLeft - x) * 4U;
      const int sourceX = cell.atlas[0] + copyLeft - cropX;
      const int sourceY = cell.atlas[1] + row - cropY;
      if (sparse) page.sparse->copyRow(sourceX, sourceY, std::span(destinationPixel, rowBytes));
      else {
        const auto* source = pixels->rgba.data() +
          (static_cast<std::size_t>(sourceY) * pixels->width + sourceX) * 4U;
        std::memcpy(destinationPixel, source, rowBytes);
      }
    }
  }
  return true;
}

void ImageStore::reserveFramePage(PreparedBacking& backing, std::size_t index) {
  if (!backing.descriptor.framePages || backing.pages[index].pixels || backing.pages[index].sparse) return;
  for (;;) {
    std::size_t resident = 0;
    PreparedBacking::Page* oldest = nullptr;
    for (std::size_t i = 0; i < backing.pages.size(); ++i) {
      auto& page = backing.pages[i];
      if (i == index || (!page.pixels && !page.sparse)) continue;
      ++resident;
      if (!oldest || page.shared->lastCpuUse.load(std::memory_order_relaxed) <
          oldest->shared->lastCpuUse.load(std::memory_order_relaxed)) oldest = &page;
    }
    if (resident < 4) return;
    oldest->pixels.reset(); oldest->sparse.reset();
  }
}

bool ImageStore::preparedSparsePage(PreparedBacking& backing, std::size_t index) {
  reserveFramePage(backing, index);
  auto& page = backing.pages[index];
  if (page.sparse) return true;
  if (page.sparseChecked && !page.sparseFormat) return false;
  page.sparseChecked = true;
  std::array<std::uint8_t, 8> header{};
  if (!page.source || pread(page.source->descriptor_, header.data(), header.size(), 0) != ssize_t(header.size()) ||
      std::memcmp(header.data(), "PML4", 4) || (header[4] != 2 && header[4] != 3)) return false;
  const auto bytes = readCapturedBytes(*page.source);
  if (!bytes || (page.verifyHash && !contentHashMatches(*bytes, page.expectedHash))) return false;
  const auto& d = backing.descriptor.pages[index];
  const auto key = preparedDigest(bytes->data(), bytes->size()) + std::to_string(d.width) + ":" + std::to_string(d.height);
  {
    std::lock_guard lock(backing.pool->mutex);
    auto& entry = backing.pool->pages[key];
    page.shared = entry.lock();
    if (!page.shared) {
      page.shared = std::make_shared<SharedPreparedPage>(); page.shared->key = key; entry = page.shared;
    }
  }
  std::lock_guard lock(page.shared->mutex);
  page.sparse = page.shared->sparse.lock();
  if (!page.sparse) {
    auto parsed = header[4] == 3 ? readIndexedPalettePage(*bytes, preparedPageCacheBudget) :
      readSparsePalettePage(*bytes, preparedPageCacheBudget);
    if (!parsed || parsed->width != d.width || parsed->height != d.height) return false;
    page.sparse = std::make_shared<SparsePalettePage>(std::move(*parsed));
    page.shared->sparse = page.sparse;
    backing.pageDecodes->fetch_add(1, std::memory_order_relaxed);
  } else backing.pool->hits.fetch_add(1, std::memory_order_relaxed);
  page.sparseFormat = true;
  page.indexedFormat = page.sparse->packed;
  page.verifyHash = false;
  page.shared->lastCpuUse.store(backing.pool->cpuClock.fetch_add(1, std::memory_order_relaxed) + 1, std::memory_order_relaxed);
  return true;
}

ImagePixels* ImageStore::preparedPixels(PreparedBacking& backing, std::size_t index, bool* acquired) {
  reserveFramePage(backing, index);
  auto& page = backing.pages[index];
  if (!page.pixels && preparedSparsePage(backing, index)) {
    std::lock_guard lock(page.shared->mutex);
    page.pixels = page.shared->pixels.lock();
    if (!page.pixels) {
      auto pixels = page.sparse->pixels();
      page.pixels = std::make_shared<ImagePixels>(ImagePixels{pixels.width, pixels.height, std::move(pixels.rgba)});
      page.shared->pixels = page.pixels;
    }
    if (!page.storage.channels) {
      const auto& known = backing.descriptor.pages[index].storage;
      page.storage = known ? known->channels : imageStorage(*page.pixels);
    }
    if (acquired) *acquired = true;
  }
  if (!page.pixels) {
    if (acquired) *acquired = true;
    const auto& dimensions = backing.descriptor.pages[index];
    const auto requestedBytes = static_cast<std::size_t>(dimensions.width)*dimensions.height*4U;
    if (requestedBytes > preparedPageCacheBudget) return nullptr;
    std::size_t cachedBytes = 0;
    std::unordered_set<const ImagePixels*> seen;
    for (const auto& candidate : backing.pages)
      if (candidate.pixels && seen.insert(candidate.pixels.get()).second)
        cachedBytes += candidate.pixels->rgba.capacity();
    while (cachedBytes > preparedPageCacheBudget - requestedBytes) {
      PreparedBacking::Page* oldest = nullptr;
      for (auto& candidate : backing.pages)
        if (&candidate != &page && candidate.pixels &&
            (!oldest || candidate.shared->lastCpuUse.load(std::memory_order_relaxed) <
              oldest->shared->lastCpuUse.load(std::memory_order_relaxed))) oldest = &candidate;
      if (!oldest) return nullptr;
      cachedBytes -= oldest->pixels->rgba.capacity();
      const auto* storage = oldest->pixels.get();
      for (auto& candidate : backing.pages)
        if (candidate.pixels.get() == storage) candidate.pixels.reset();
    }
    if (!page.shared) {
      const auto& source = *page.source;
      std::vector<std::uint8_t> encoded(source.size_);
      std::size_t offset = 0;
      while (offset < encoded.size()) {
        const auto count = pread(source.descriptor_, encoded.data() + offset,
            encoded.size() - offset, static_cast<off_t>(offset));
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return nullptr;
        offset += static_cast<std::size_t>(count);
      }
      struct stat current{};
      if (fstat(source.descriptor_, &current) != 0 ||
          current.st_size != static_cast<off_t>(source.size_) ||
          current.st_mtim.tv_sec != source.modifiedSeconds_ ||
          current.st_mtim.tv_nsec != source.modifiedNanoseconds_) return nullptr;
      if (page.verifyHash && !contentHashMatches(encoded, page.expectedHash)) return nullptr;
      page.verifyHash = false;
      const auto key = preparedDigest(encoded.data(), encoded.size()) +
          std::to_string(dimensions.width) + ":" + std::to_string(dimensions.height);
      {
        std::lock_guard lock(backing.pool->mutex);
        auto& entry = backing.pool->pages[key];
        page.shared = entry.lock();
        if (!page.shared) {
          page.shared = std::make_shared<SharedPreparedPage>();
          page.shared->key = key; entry = page.shared;
        }
      }
      std::lock_guard lock(page.shared->mutex);
      page.pixels = page.shared->pixels.lock();
      if (!page.pixels) {
        auto pixels = pmjs::decodeMemory(encoded.data(), encoded.size(), preparedPageCacheBudget);
        if (!pixels || pixels->width != dimensions.width || pixels->height != dimensions.height) return nullptr;
        backing.pageDecodes->fetch_add(1, std::memory_order_relaxed);
        page.pixels = std::make_shared<ImagePixels>(std::move(*pixels));
        page.shared->pixels = page.pixels;
      } else backing.pool->hits.fetch_add(1, std::memory_order_relaxed);
    } else {
      std::lock_guard lock(page.shared->mutex);
      page.pixels = page.shared->pixels.lock();
      if (!page.pixels) {
        auto pixels = decodeFile(*page.source);
        if (!pixels || pixels->width != dimensions.width || pixels->height != dimensions.height) return nullptr;
        backing.pageDecodes->fetch_add(1, std::memory_order_relaxed);
        page.pixels = std::make_shared<ImagePixels>(std::move(*pixels));
        page.shared->pixels = page.pixels;
      } else backing.pool->hits.fetch_add(1, std::memory_order_relaxed);
    }
    if (!page.storage.channels) {
      const auto& known = backing.descriptor.pages[index].storage;
      page.storage = known ? known->channels : imageStorage(*page.pixels);
    }
  }
  page.shared->lastCpuUse.store(backing.pool->cpuClock.fetch_add(1, std::memory_order_relaxed) + 1,
    std::memory_order_relaxed);
  return &*page.pixels;
}

std::optional<ImageInfo> ImageStore::preparedPage(Slot& slot, std::size_t index, bool premultiplied,
    PaletteImageRegion* view, bool sparseAllowed) {
  auto& backing = *slot.prepared;
  auto& page = backing.pages[index];
  page.lastGpuUse = ++preparedFrameClock_;
  if (view) {
    const bool sparse = page.sparseFormat || preparedSparsePage(backing, index);
    const bool indexed = page.indexedFormat;
    const auto& decision = backing.descriptor.pages[index].storage;
    if (sparse && !indexed && !sparseAllowed) page.sparseDisabled = true;
    bool useSparse = sparse && !indexed && sparseAllowed && !page.sparseDisabled &&
      (!decision || decision->paletteBits == 16);
    if (!page.paletteChecked || (page.palette && bool(page.palette->blocks) != useSparse)) {
      if (sparse && !page.sparse && !preparedSparsePage(backing, index)) return std::nullopt;
      if (!decision && sparse && page.sparse->packed) {
        const auto& colors = page.sparse->colors;
        const ImagePixels paletteColors{static_cast<int>(colors.size() / 4), 1, colors};
        if (imageStorage(paletteColors).channels == 1) {
          page.paletteChecked = true;
          return std::nullopt;
        }
      }
      const auto* pixels = sparse ? nullptr : preparedPixels(backing, index);
      if (!sparse && !pixels) return std::nullopt;
      if (!decision || decision->paletteBits) {
        auto key = page.shared->key + ":palette:" + std::to_string(decision ? decision->paletteBits : 0) +
          (useSparse ? ":sparse" : ":dense");
        auto palette = preparedPalettes_[key].lock();
        if (!palette) {
          palette = sparse ? makeSparsePalette(*page.sparse, useSparse) : makePalette(*pixels, decision ? &*decision : nullptr);
          if (!palette && useSparse) {
            page.sparseDisabled = true; useSparse = false;
            key.replace(key.size() - 7, 7, ":dense");
            palette = makeSparsePalette(*page.sparse, false);
          }
          if (palette) preparedPalettes_[key] = palette;
        } else ++preparedSharedTextureHits_;
        if (palette) {
          // A previous draw in this submission may still reference the old view.
          if (page.palette && slot.inFlight.load(std::memory_order_acquire)) page.retiredPalettes.push_back(page.palette);
          page.palette = std::move(palette);
        }
      }
      page.paletteChecked = true;
      trimPreparedPages();
    }
    if (page.palette) {
      view->table = paletteTable(*page.palette, premultiplied);
      if (!view->table) return std::nullopt;
      view->blocks = page.palette->blocks; view->residual = page.palette->residual;
      page.sparse.reset();
      const auto& d = backing.descriptor.pages[index];
      view->image = ImageInfo{0, d.width, d.height, page.palette->indices, premultiplied, false};
      return view->image;
    }
    return std::nullopt;
  }
  auto& texture = premultiplied ? page.premultipliedTexture : page.texture;
  auto& shared = premultiplied ? page.sharedPremultipliedTexture : page.sharedTexture;
  if (!texture) {
    bool acquired = false;
    const auto* decoded = preparedPixels(backing, index, &acquired);
    if (!decoded) return std::nullopt;
    const auto key = "page:" + page.shared->key + (premultiplied ? "p" : "s");
    if (auto existing = preparedTextures_[key].lock()) {
      shared = std::move(existing); texture = shared->texture; page.storage = shared->storage; ++preparedSharedTextureHits_;
      const auto& d = backing.descriptor.pages[index];
      if (acquired) trimPreparedPages();
      return ImageInfo{0, d.width, d.height, texture, premultiplied, false};
    }
    const auto& pixels = *decoded;
    std::vector<std::uint8_t> converted;
    const auto* bytes = pixels.rgba.data();
    if (premultiplied && page.storage.channels != 1) {
      converted = pixels.rgba;
      for (std::size_t i = 0; i < converted.size(); i += 4)
        for (std::size_t channel = 0; channel < 3; ++channel)
          converted[i + channel] = static_cast<std::uint8_t>((converted[i + channel] * converted[i + 3] + 127) / 255);
      bytes = converted.data();
    }
    texture = uploadTexture(pixels.width, pixels.height, bytes, page.storage);
    if (!texture && page.storage.channels != 4) {
      page.storage = {};
      if (premultiplied && converted.empty()) {
        converted = pixels.rgba;
        for (std::size_t i = 0; i < converted.size(); i += 4)
          for (std::size_t channel = 0; channel < 3; ++channel)
            converted[i+channel] = static_cast<std::uint8_t>((converted[i+channel]*converted[i+3]+127)/255);
        bytes = converted.data();
      }
      texture = uploadTexture(pixels.width, pixels.height, bytes, page.storage);
    }
    if (!texture) {
      if (acquired) trimPreparedPages();
      return std::nullopt;
    }
    const auto uploaded = static_cast<std::size_t>(pixels.width) * pixels.height * page.storage.channels;
    ++textureCreates_; ++textureEpoch_; textureUploadBytes_ += uploaded;
    gpuBytes_ += uploaded; peakGpuBytes_ = std::max(peakGpuBytes_, gpuBytes_);
    shared = shareTexture(key, texture, uploaded, page.storage);
    if (!shared) backing.gpuBytes += uploaded;
    if (acquired) trimPreparedPages();
  }
  const auto& dimensions = backing.descriptor.pages[index];
  return ImageInfo{0, dimensions.width, dimensions.height, texture, premultiplied, false};
}

std::optional<SpriteImageRegion> ImageStore::resolveSpriteRegion(ImageHandle handle,
    float x, float y, float width, float height, bool premultiplied, bool paletteOnly, bool sparseAllowed) {
  auto info = inspect(handle);
  if (!info || width <= 0 || height <= 0 || !std::isfinite(x) || !std::isfinite(y) ||
      !std::isfinite(width) || !std::isfinite(height) || x < 0 || y < 0 ||
      x + width > info->width || y + height > info->height) return std::nullopt;
  auto& slot = slots_[(handle & indexMask) - 1U];
  if (slot.tiles && paletteOnly) return std::nullopt;
  if (slot.tiles) return resolveTileRegion(slot, x, y, width, height, premultiplied);
  if (!slot.prepared) return std::nullopt;
  auto& backing = *slot.prepared;
  if (backing.requiresSourceSampling()) return std::nullopt;
  if (backing.descriptor.uniform && paletteOnly) return std::nullopt;
  if (backing.descriptor.uniform) {
    auto& image = backing.cellImages.back();
    if (!image) {
      auto created = createRgba(1, 1, backing.descriptor.uniform->data());
      if (!created) return std::nullopt;
      image = created->handle;
    }
    auto physical = premultiplied ? lookupPremultiplied(image) : lookup(image);
    if (!physical) return std::nullopt;
    ++preparedRegions_;
    return SpriteImageRegion{*physical, {x,y,width,height}, {0,0,1,1}, info->width, info->height};
  }
  for (std::size_t i = 0; i < backing.descriptor.cells.size(); ++i) {
    const auto& cell = backing.descriptor.cells[i]; const auto& r = cell.rect;
    if (x < r[0] || y < r[1] || x + width > r[0] + r[2] || y + height > r[1] + r[3]) continue;
    const bool zero = std::all_of(cell.fill.begin(), cell.fill.end(), [](std::uint8_t v) { return v == 0; });
    if (zero && cell.crop[2] && cell.crop[3] && (!backing.descriptor.framePages || paletteOnly)) {
      PaletteImageRegion palette;
      auto physical = preparedPage(slot, cell.page, premultiplied, paletteOnly ? &palette : nullptr, sparseAllowed);
      if (!physical) return std::nullopt;
      ++preparedRegions_;
      return SpriteImageRegion{*physical,
        {static_cast<float>(r[0] + cell.crop[0]), static_cast<float>(r[1] + cell.crop[1]),
         static_cast<float>(cell.crop[2]), static_cast<float>(cell.crop[3])},
        {static_cast<float>(cell.atlas[0]), static_cast<float>(cell.atlas[1]),
         static_cast<float>(cell.atlas[2]), static_cast<float>(cell.atlas[3])}, info->width, info->height, backing.descriptor.halo, palette.table, palette.blocks, palette.residual};
    }
    if (paletteOnly) return std::nullopt;
    if (backing.descriptor.framePages) {
      auto& recent = backing.recentCells;
      std::erase(recent, i);
      while (recent.size() >= 4) {
        const auto oldest = recent.front();
        release(backing.cellImages[oldest]);
        backing.cellImages[oldest] = 0;
        recent.erase(recent.begin());
      }
      recent.push_back(i);
    }
    auto& image = backing.cellImages[i];
    if (!image) {
      const int halo = backing.descriptor.halo;
      const auto extent = checkedImageExtent(r[2]+2*halo, r[3]+2*halo);
      if (!extent) return std::nullopt;
      const int left = std::max(0, r[0]-halo), top = std::max(0, r[1]-halo);
      const int right = std::min(info->width, r[0]+r[2]+halo), bottom = std::min(info->height, r[1]+r[3]+halo);
      auto content = readPixelsRegion(handle, left, top, right-left, bottom-top);
      if (!content) return std::nullopt;
      ImagePixels pixels{extent->width, extent->height, std::vector<std::uint8_t>(extent->rgbaBytes)};
      for (int row = 0; row < pixels.height; ++row) for (int column = 0; column < pixels.width; ++column) {
        const int sx = std::clamp(r[0]+column-halo, 0, info->width-1)-left;
        const int sy = std::clamp(r[1]+row-halo, 0, info->height-1)-top;
        std::copy_n(content->rgba.data()+(static_cast<std::size_t>(sy)*content->width+sx)*4,
                    4, pixels.rgba.data()+(static_cast<std::size_t>(row)*pixels.width+column)*4);
      }
      auto created = createDecoded(pixels);
      if (!created) return std::nullopt;
      image = created->handle;
    }
    if (backing.descriptor.framePages &&
        std::find(activePreparedFrames_.begin(), activePreparedFrames_.end(), image) == activePreparedFrames_.end()) {
      beginUse(image);
      activePreparedFrames_.push_back(image);
    }
    auto physical = premultiplied ? lookupPremultiplied(image) : lookup(image);
    if (!physical) return std::nullopt;
    ++preparedRegions_;
    return SpriteImageRegion{*physical,
      {static_cast<float>(r[0]), static_cast<float>(r[1]), static_cast<float>(r[2]), static_cast<float>(r[3])},
      {static_cast<float>(backing.descriptor.halo),static_cast<float>(backing.descriptor.halo),
       static_cast<float>(r[2]),static_cast<float>(r[3])}, info->width, info->height, backing.descriptor.halo};
  }
  return std::nullopt;
}

void ImageStore::trimPreparedFrames(std::size_t targetBytes) {
  while (preparedFrameBytes_ > targetBytes && !preparedFrames_.empty()) {
    const auto oldest = std::min_element(preparedFrames_.begin(), preparedFrames_.end(),
      [](const auto& a, const auto& b) { return a.lastUsed < b.lastUsed; });
    const auto image = oldest->image;
    auto& backing = *const_cast<PreparedBacking*>(oldest->owner);
    if (backing.evictedFrames.size() == 16) backing.frameCacheDisabled = true;
    else backing.evictedFrames.push_back(oldest->source);
    preparedFrameBytes_ -= oldest->bytes;
    preparedFrames_.erase(oldest);
    ++preparedFrameEvictions_;
    release(image);
  }
}

void ImageStore::setPreparedFrameCacheBudget(std::size_t bytes) {
  preparedFrameBudgetBytes_ = bytes;
  trimPreparedFrames(bytes);
}

void ImageStore::clearPreparedFrames(const PreparedBacking* owner) {
  for (auto it = preparedFrames_.begin(); it != preparedFrames_.end();) {
    if (it->owner != owner) { ++it; continue; }
    const auto image = it->image;
    preparedFrameBytes_ -= it->bytes;
    it = preparedFrames_.erase(it);
    release(image);
  }
}

std::optional<ImageInfo> ImageStore::convertPreparedFrame(ImageHandle handle,
    const std::array<int, 4>& storage, bool premultiplied) {
  const auto started = std::chrono::steady_clock::now();
  auto& source = slots_[(handle & indexMask)-1U];
  auto backing = source.prepared;
  if (!backing) return std::nullopt;
  if (!preparedCopyProgram_) {
    const char* vertex = R"(#version 300 es
      void main() {
        vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
        gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
      })";
    const char* fragment = R"(#version 300 es
      precision highp float;
      precision highp int;
      uniform sampler2D pixels;
      uniform ivec2 offset;
      uniform ivec4 bounds;
      out vec4 color;
      void main() {
        ivec2 p = clamp(ivec2(gl_FragCoord.xy) + offset, bounds.xy, bounds.zw);
        color = texelFetch(pixels, p, 0);
      })";
    const auto compile = [](GLenum kind, const char* text) {
      GLuint shader = glCreateShader(kind);
      glShaderSource(shader, 1, &text, nullptr); glCompileShader(shader);
      GLint ok = 0; glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
      if (!ok) { glDeleteShader(shader); throw std::runtime_error("prepared frame shader compilation failed"); }
      return shader;
    };
    const auto vs = compile(GL_VERTEX_SHADER, vertex);
    GLuint fs = 0;
    try { fs = compile(GL_FRAGMENT_SHADER, fragment); }
    catch (...) { glDeleteShader(vs); throw; }
    GLuint program = glCreateProgram();
    glAttachShader(program, vs); glAttachShader(program, fs); glLinkProgram(program);
    glDeleteShader(vs); glDeleteShader(fs);
    GLint ok = 0; glGetProgramiv(program, GL_LINK_STATUS, &ok);
    if (!ok) { glDeleteProgram(program); throw std::runtime_error("prepared frame shader link failed"); }
    preparedCopyProgram_ = program;
    glGenVertexArrays(1, &preparedCopyVao_);
  }
  // Resolve source pages before allocating the destination, which can grow slots_.
  std::vector<ImageInfo> pages(backing->pages.size());
  for (const auto& cell : backing->descriptor.cells) {
    if (!cell.crop[2] || !cell.crop[3]) continue;
    const auto& r = cell.rect;
    if (r[0] >= storage[0]+storage[2] || r[1] >= storage[1]+storage[3] ||
        r[0]+r[2] <= storage[0] || r[1]+r[3] <= storage[1]) continue;
    if (!pages[cell.page].texture) {
      auto image = preparedPage(source, cell.page, premultiplied);
      if (!image) return std::nullopt;
      pages[cell.page] = *image;
    }
  }
  auto image = createImage(storage[2], storage[3], nullptr, premultiplied, {});
  if (!image) return std::nullopt;
  GLint framebuffer = 0, program = 0, vao = 0, active = 0, texture = 0;
  GLint viewport[4], scissorBox[4]; GLboolean mask[4];
  glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &framebuffer);
  glGetIntegerv(GL_CURRENT_PROGRAM, &program); glGetIntegerv(GL_VERTEX_ARRAY_BINDING, &vao);
  glGetIntegerv(GL_VIEWPORT, viewport); glGetIntegerv(GL_SCISSOR_BOX, scissorBox);
  glGetBooleanv(GL_COLOR_WRITEMASK, mask); glGetIntegerv(GL_ACTIVE_TEXTURE, &active);
  glActiveTexture(GL_TEXTURE0); glGetIntegerv(GL_TEXTURE_BINDING_2D, &texture);
  const std::array<GLenum, 6> capabilities{GL_BLEND, GL_SCISSOR_TEST, GL_DEPTH_TEST,
    GL_STENCIL_TEST, GL_CULL_FACE, GL_DITHER};
  std::array<GLboolean, 6> enabled{};
  for (std::size_t i=0; i<capabilities.size(); ++i) { enabled[i]=glIsEnabled(capabilities[i]); glDisable(capabilities[i]); }
  GLuint target = 0; glGenFramebuffers(1, &target);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, target);
  glFramebufferTexture2D(GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, image->texture, 0);
  const bool complete = glCheckFramebufferStatus(GL_DRAW_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE;
  if (complete) {
    glViewport(0, 0, storage[2], storage[3]); glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    const GLfloat zero[4]{}; glClearBufferfv(GL_COLOR, 0, zero);
    glEnable(GL_SCISSOR_TEST); glUseProgram(preparedCopyProgram_); glBindVertexArray(preparedCopyVao_);
    glUniform1i(glGetUniformLocation(preparedCopyProgram_, "pixels"), 0);
    const auto clip = [&](std::array<int,4> rect) {
      int x0=rect[0], y0=rect[1], x1=x0+rect[2], y1=y0+rect[3];
      if (x0==0) x0=std::min(x0,storage[0]);
      if (y0==0) y0=std::min(y0,storage[1]);
      if (x1==backing->descriptor.width) x1=std::max(x1,storage[0]+storage[2]);
      if (y1==backing->descriptor.height) y1=std::max(y1,storage[1]+storage[3]);
      x0=std::max(x0,storage[0]); y0=std::max(y0,storage[1]);
      x1=std::min(x1,storage[0]+storage[2]); y1=std::min(y1,storage[1]+storage[3]);
      glScissor(x0-storage[0],y0-storage[1],std::max(0,x1-x0),std::max(0,y1-y0));
    };
    for (const auto& cell : backing->descriptor.cells) {
      clip(cell.rect);
      std::array<GLfloat,4> fill{};
      for (int i=0;i<4;++i) fill[i]=cell.fill[i]/255.0f;
      if (premultiplied) for (int i=0;i<3;++i) fill[i]=std::floor(cell.fill[i]*cell.fill[3]/255.0f+0.5f)/255.0f;
      glClearBufferfv(GL_COLOR, 0, fill.data());
      if (!cell.crop[2] || !cell.crop[3] || !pages[cell.page].texture) continue;
      const int x=cell.rect[0]+cell.crop[0], y=cell.rect[1]+cell.crop[1];
      clip({x,y,cell.crop[2],cell.crop[3]});
      glBindTexture(GL_TEXTURE_2D,pages[cell.page].texture);
      glUniform2i(glGetUniformLocation(preparedCopyProgram_,"offset"),
        storage[0]-x+cell.atlas[0],storage[1]-y+cell.atlas[1]);
      glUniform4i(glGetUniformLocation(preparedCopyProgram_,"bounds"),cell.atlas[0],cell.atlas[1],
        cell.atlas[0]+cell.crop[2]-1,cell.atlas[1]+cell.crop[3]-1);
      glDrawArrays(GL_TRIANGLES,0,3);
    }
  }
  glBindTexture(GL_TEXTURE_2D,texture); glActiveTexture(active);
  glBindVertexArray(vao); glUseProgram(program); glBindFramebuffer(GL_DRAW_FRAMEBUFFER,framebuffer);
  glDeleteFramebuffers(1,&target); glViewport(viewport[0],viewport[1],viewport[2],viewport[3]);
  glScissor(scissorBox[0],scissorBox[1],scissorBox[2],scissorBox[3]);
  glColorMask(mask[0],mask[1],mask[2],mask[3]);
  for (std::size_t i=0;i<capabilities.size();++i) if(enabled[i])glEnable(capabilities[i]);else glDisable(capabilities[i]);
  if (!complete) { release(image->handle); return std::nullopt; }
  ++preparedFrameConversions_;
  preparedFrameConversionMs_ += std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-started).count();
  return image;
}

std::optional<SpriteImageRegion> ImageStore::resolvePreparedFrameRegion(ImageHandle handle,
    float x, float y, float width, float height, bool premultiplied, bool linearPalette,
    bool cachePaletteSource) {
  if (!preparedFrameBudgetBytes_) return std::nullopt;
  const auto logical = inspect(handle);
  if (!logical || !std::isfinite(x) || !std::isfinite(y) || !std::isfinite(width) ||
      !std::isfinite(height) || x < 0 || y < 0 || width <= 0 || height <= 0 ||
      x + width > logical->width || y + height > logical->height) return std::nullopt;
  auto& slot = slots_[(handle & indexMask)-1U];
  if (!slot.prepared || slot.tiles || slot.prepared->descriptor.uniform) return std::nullopt;
  if (slot.prepared->requiresSourceSampling() && !cachePaletteSource) return std::nullopt;
  const int left = static_cast<int>(std::floor(x)), top = static_cast<int>(std::floor(y));
  const int right = static_cast<int>(std::ceil(x + width)), bottom = static_cast<int>(std::ceil(y + height));
  // Ordinary whole-source draws need no additional frame texture.
  if (left == 0 && top == 0 && right == logical->width && bottom == logical->height &&
      (!linearPalette || (hasPaletteStorage(handle) && !cachePaletteSource))) return std::nullopt;
  const std::array<int, 4> source{left, top, right-left, bottom-top};
  const int halo = std::max(1, slot.prepared->descriptor.halo);
  const auto extent = checkedImageExtent(source[2]+2*halo, source[3]+2*halo);
  if (!extent) return std::nullopt;
  if (linearPalette && (extent->rgbaBytes > preparedFrameBudgetBytes_ || slot.prepared->frameCacheDisabled)) {
    ++preparedFrameBypasses_;
    return std::nullopt;
  }
  const bool targetPremultiplied = premultiplied || slot.premultiplied;
  auto owner = slot.prepared;
  auto found = std::find_if(preparedFrames_.begin(), preparedFrames_.end(), [&](const auto& frame) {
    return frame.owner == slot.prepared.get() && frame.source == source &&
      frame.premultiplied == targetPremultiplied;
  });
  ImageHandle image = 0;
  std::array<int, 4> storage{left-halo, top-halo, extent->width, extent->height};
  if (found != preparedFrames_.end()) {
    ++preparedFrameHits_;
    found->lastUsed = ++preparedFrameClock_;
    image = found->image;
    storage = found->storage;
  } else if (linearPalette) {
    if (std::find(owner->evictedFrames.begin(), owner->evictedFrames.end(), source) != owner->evictedFrames.end()) {
      owner->frameCacheDisabled = true;
      ++preparedFrameBypasses_;
      return std::nullopt;
    }
    ++preparedFrameMisses_;
    const auto bytes = extent->rgbaBytes;
    trimPreparedFrames(preparedFrameBudgetBytes_ - bytes);
    auto created = convertPreparedFrame(handle, storage, targetPremultiplied);
    if (!created) return std::nullopt;
    image = created->handle;
    slots_[(image & indexMask)-1U].preparedFrameBytes = bytes;
    preparedFrameResidentBytes_ += bytes;
    preparedFramePeakResidentBytes_ = std::max(preparedFramePeakResidentBytes_, preparedFrameResidentBytes_);
    preparedFrames_.push_back({owner.get(), source, storage, image, targetPremultiplied, bytes, ++preparedFrameClock_});
    preparedFrameBytes_ += bytes;
  } else {
    ++preparedFrameMisses_;
    const int sx = std::max(0, left-halo), sy = std::max(0, top-halo);
    const int ex = std::min(logical->width, right+halo), ey = std::min(logical->height, bottom+halo);
    auto content = readPixelsRegion(handle, sx, sy, ex-sx, ey-sy);
    if (!content) return std::nullopt;
    ImagePixels pixels{extent->width, extent->height, std::vector<std::uint8_t>(extent->rgbaBytes)};
    const int leftPadding = sx - left + halo;
    const int rightPadding = leftPadding + content->width;
    for (int row = 0; row < pixels.height; ++row) {
      const int cy = std::clamp(top+row-halo, 0, logical->height-1)-sy;
      const auto* sourceRow = content->rgba.data() + static_cast<std::size_t>(cy)*content->width*4U;
      auto* destinationRow = pixels.rgba.data() + static_cast<std::size_t>(row)*pixels.width*4U;
      std::memcpy(destinationRow + leftPadding*4U, sourceRow, static_cast<std::size_t>(content->width)*4U);
      for (int column = 0; column < leftPadding; ++column)
        std::memcpy(destinationRow + column*4U, sourceRow, 4);
      for (int column = rightPadding; column < pixels.width; ++column)
        std::memcpy(destinationRow + column*4U, sourceRow + (content->width-1)*4U, 4);
    }
    if (premultiplied && !slot.premultiplied)
      for (std::size_t i = 0; i < pixels.rgba.size(); i += 4)
        if (pixels.rgba[i+3] != 255)
          for (std::size_t c = 0; c < 3; ++c)
            pixels.rgba[i+c] = static_cast<std::uint8_t>((pixels.rgba[i+c]*pixels.rgba[i+3]+127)/255);
    auto channelStorage = imageStorage(pixels);
    auto bytes = static_cast<std::size_t>(pixels.width)*pixels.height*channelStorage.channels;
    if (linearPalette || bytes > preparedFrameBudgetBytes_) {
      int x0 = pixels.width, y0 = pixels.height, x1 = 0, y1 = 0;
      for (int row = 0; row < pixels.height; ++row) for (int column = 0; column < pixels.width; ++column) {
        const auto* pixel = pixels.rgba.data()+(static_cast<std::size_t>(row)*pixels.width+column)*4U;
        if (pixel[0] || pixel[1] || pixel[2] || pixel[3]) {
          x0 = std::min(x0, column); y0 = std::min(y0, row);
          x1 = std::max(x1, column+1); y1 = std::max(y1, row+1);
        }
      }
      if (x1 == 0) {
        pixels = {1, 1, std::vector<std::uint8_t>(4)};
        storage = {left, top, 1, 1};
      } else {
        // Retain neighboring zero texels so filtering at a trimmed edge stays transparent.
        x0 = std::max(0, x0-halo); y0 = std::max(0, y0-halo);
        x1 = std::min(pixels.width, x1+halo); y1 = std::min(pixels.height, y1+halo);
        ImagePixels cropped{x1-x0, y1-y0,
          std::vector<std::uint8_t>(static_cast<std::size_t>(x1-x0)*(y1-y0)*4U)};
        for (int row = 0; row < cropped.height; ++row)
          std::copy_n(pixels.rgba.data()+(static_cast<std::size_t>(row+y0)*pixels.width+x0)*4U,
            static_cast<std::size_t>(cropped.width)*4U,
            cropped.rgba.data()+static_cast<std::size_t>(row)*cropped.width*4U);
        storage = {storage[0]+x0, storage[1]+y0, cropped.width, cropped.height};
        pixels = std::move(cropped);
      }
      channelStorage = imageStorage(pixels);
      bytes = static_cast<std::size_t>(pixels.width)*pixels.height*channelStorage.channels;
      if (bytes > preparedFrameBudgetBytes_) return std::nullopt;
    }
    trimPreparedFrames(preparedFrameBudgetBytes_-bytes);
    auto created = createImage(pixels.width, pixels.height, pixels.rgba.data(), targetPremultiplied, channelStorage);
    if (!created) return std::nullopt;
    preparedFrameUploadBytes_ += bytes;
    image = created->handle;
    slots_[(image & indexMask)-1U].preparedFrameBytes = bytes;
    preparedFrameResidentBytes_ += bytes;
    preparedFramePeakResidentBytes_ = std::max(preparedFramePeakResidentBytes_, preparedFrameResidentBytes_);
    preparedFrames_.push_back({owner.get(), source, storage, image, targetPremultiplied, bytes, ++preparedFrameClock_});
    preparedFrameBytes_ += bytes;
  }
  if (std::find(activePreparedFrames_.begin(), activePreparedFrames_.end(), image) == activePreparedFrames_.end()) {
    beginUse(image);
    activePreparedFrames_.push_back(image);
  }
  const auto physical = inspect(image);
  if (!physical) return std::nullopt;
  ++preparedRegions_;
  return SpriteImageRegion{*physical,
    {static_cast<float>(storage[0]), static_cast<float>(storage[1]),
      static_cast<float>(storage[2]), static_cast<float>(storage[3])},
    {0, 0, static_cast<float>(storage[2]), static_cast<float>(storage[3])},
    logical->width, logical->height, 0};
}

std::optional<BlockImageRegion> ImageStore::resolveBlockRegion(ImageHandle handle, bool premultiplied) try {
  if (!compactSamplingEnabled_) return std::nullopt;
  const auto logical = inspect(handle);
  if (!logical) return std::nullopt;
  auto& slot = slots_[(handle & indexMask)-1U];
  if (!slot.prepared || slot.tiles) return std::nullopt;
  auto& backing = *slot.prepared;
  const auto& descriptor = backing.descriptor;
  if (backing.requiresSourceSampling() && !slot.texture && !slot.premultipliedTexture) {
    if (!backing.channelChecked) {
      backing.channelChecked = true;
      auto pixels = readPreparedRegion(backing, 0, 0, logical->width, logical->height);
      auto channel = pixels ? makeChannelBlockPage(pixels->width, pixels->height, pixels->rgba) :
        std::optional<ChannelBlockPage>{};
      if (channel) {
        const int height = (channel->bytes.size() + 8191) / 8192;
        GLint maximum = 0;
        glGetIntegerv(GL_MAX_TEXTURE_SIZE, &maximum);
        if (maximum >= 2048 && height <= maximum) {
          channel->bytes.resize(std::size_t(height) * 8192);
          const auto atlas = uploadTexture(2048, height, channel->bytes.data(), {});
          GLuint table = 0;
          if (atlas) {
            while (glGetError() != GL_NO_ERROR) {}
            glGenTextures(1, &table); glBindTexture(GL_TEXTURE_2D, table);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
            glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA32UI, (logical->width + 7) / 8,
              (logical->height + 7) / 8, 0, GL_RGBA_INTEGER, GL_UNSIGNED_INT, channel->blocks.data());
          }
          if (atlas && table && glGetError() == GL_NO_ERROR) {
            backing.channelAtlas = atlas; backing.channelTable = table; backing.channelHeight = height;
            const auto bytes = channel->gpuBytes();
            backing.gpuBytes += bytes; gpuBytes_ += bytes;
            peakGpuBytes_ = std::max(peakGpuBytes_, gpuBytes_);
            textureCreates_ += 2; textureEpoch_ += 2; textureUploadBytes_ += bytes;
            for (auto& page : backing.pages) { page.pixels.reset(); page.sparse.reset(); }
            ++blockTextureUploads_;
          } else { glDeleteTextures(1, &atlas); glDeleteTextures(1, &table); ++blockUploadFailures_; }
        }
      }
    }
    if (backing.channelAtlas) {
      ++blockRegions_;
      return BlockImageRegion{{0, 2048, backing.channelHeight, backing.channelAtlas,
          premultiplied || slot.premultiplied, false}, backing.channelTable,
        {8, logical->width, logical->height}, {(logical->width + 7) / 8, (logical->height + 7) / 8},
        logical->width, logical->height, premultiplied && !slot.premultiplied ? 2 : 1};
    }
  }
  if (!descriptor.blockGrid || descriptor.pages.size() != 1 ||
      backing.blockRealizationFailed || (descriptor.blockChannels && !*descriptor.blockChannels) ||
      (backing.blockEligible && !*backing.blockEligible)) return std::nullopt;
  const auto [block, frameWidth, frameHeight] = *descriptor.blockGrid;
  const int columns = (frameWidth+block-1)/block, rows = (frameHeight+block-1)/block;
  const int frameColumns = logical->width/frameWidth;
  const int entries = columns*rows*frameColumns*(logical->height/frameHeight);
  const std::array<int, 2> tableSize{std::min(1024, entries), (entries+1023)/1024};
  const bool converted = premultiplied && !slot.premultiplied;
  const bool targetPremultiplied = premultiplied || slot.premultiplied;
  auto& textures = backing.blockTextures[targetPremultiplied ? 1 : 0];
  const auto& page = descriptor.pages.front();
  if (!textures.atlas) {
    bool acquired = false;
    const auto* pixels = preparedPixels(backing, 0, &acquired);
    if (!pixels) return std::nullopt;
    const int channels = descriptor.blockChannels ? *descriptor.blockChannels : grayscaleChannels(*pixels);
    if (channels > 2 || std::any_of(descriptor.cells.begin(), descriptor.cells.end(), [](const auto& cell) {
        return cell.fill[0] != cell.fill[1] || cell.fill[0] != cell.fill[2];
      })) {
      backing.blockEligible = false;
      if (acquired) trimPreparedPages();
      return std::nullopt;
    }
    const bool validatePadding = !descriptor.blockChannels && !backing.blockEligible.has_value();
    std::vector<std::uint16_t> table(static_cast<std::size_t>(tableSize[0])*tableSize[1]*2U);
    for (const auto& cell : descriptor.cells) {
      const auto& r = cell.rect;
      const int frameX = r[0]/frameWidth, frameY = r[1]/frameHeight;
      const int localX = r[0]%frameWidth, localY = r[1]%frameHeight;
      for (int y = localY; y < localY+r[3]; y += block)
        for (int x = localX; x < localX+r[2]; x += block) {
          const auto index = static_cast<std::size_t>(((frameY*frameColumns+frameX)*rows+y/block)*columns+x/block)*2U;
          if (cell.crop[2]) {
            table[index] = static_cast<std::uint16_t>(cell.atlas[0]);
            table[index+1] = static_cast<std::uint16_t>(cell.atlas[1]);
          } else {
            const auto gray = converted ? (cell.fill[0]*cell.fill[3]+127)/255 : cell.fill[0];
            table[index] = static_cast<std::uint16_t>(0x8000U|gray);
            table[index+1] = cell.fill[3];
          }
          if (!validatePadding) continue;
          const int left = std::max(0, frameX*frameWidth+x-descriptor.halo);
          const int top = std::max(0, frameY*frameHeight+y-descriptor.halo);
          const int right = std::min(logical->width, frameX*frameWidth+std::min(x+block, frameWidth)+descriptor.halo);
          const int bottom = std::min(logical->height, frameY*frameHeight+std::min(y+block, frameHeight)+descriptor.halo);
          if (!cell.crop[2] && left >= r[0] && top >= r[1] &&
              right <= r[0]+r[2] && bottom <= r[1]+r[3]) continue;
          auto expected = readPreparedRegion(backing, left, top, right-left, bottom-top);
          if (!expected) {
            if (acquired) trimPreparedPages();
            return std::nullopt;
          }
          for (int py = top; py < bottom; ++py) for (int px = left; px < right; ++px) {
            const auto* actual = expected->rgba.data()+(static_cast<std::size_t>(py-top)*expected->width+px-left)*4U;
            const auto* stored = cell.crop[2] ? pixels->rgba.data()+
              (static_cast<std::size_t>(cell.atlas[1]+py-r[1])*pixels->width+cell.atlas[0]+px-r[0])*4U : cell.fill.data();
            if (!std::equal(actual, actual+4, stored)) {
              backing.blockEligible = false;
              if (acquired) trimPreparedPages();
              return std::nullopt;
            }
          }
        }
    }
    backing.blockEligible = true;
    const auto atlasKey = "page:" + backing.pages.front().shared->key + (targetPremultiplied ? "p" : "s");
    auto sharedAtlas = preparedTextures_[atlasKey].lock();
    std::vector<std::uint8_t> atlas(static_cast<std::size_t>(page.width)*page.height*channels);
    for (std::size_t i = 0; i < static_cast<std::size_t>(page.width)*page.height; ++i) {
      const auto* source = pixels->rgba.data()+i*4U;
      atlas[i*channels] = static_cast<std::uint8_t>(converted ? (source[0]*source[3]+127)/255 : source[0]);
      if (channels == 2) atlas[i*channels+1] = source[3];
    }
    if (acquired) trimPreparedPages();
    GLint binding = 0, unpackBuffer = 0;
    glGetIntegerv(GL_TEXTURE_BINDING_2D, &binding);
    glGetIntegerv(GL_PIXEL_UNPACK_BUFFER_BINDING, &unpackBuffer);
    const std::array<GLenum, 4> unpackNames{GL_UNPACK_ALIGNMENT, GL_UNPACK_ROW_LENGTH,
      GL_UNPACK_SKIP_ROWS, GL_UNPACK_SKIP_PIXELS};
    std::array<GLint, 4> unpack{};
    for (std::size_t i = 0; i < unpack.size(); ++i) glGetIntegerv(unpackNames[i], &unpack[i]);
    glBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0);
    for (std::size_t i = 0; i < unpack.size(); ++i) glPixelStorei(unpackNames[i], i == 0 ? 1 : 0);
    while (glGetError() != GL_NO_ERROR) {}
    std::array<GLuint, 2> created{};
    if (sharedAtlas) {
      created[0] = sharedAtlas->texture;
      glGenTextures(1, &created[1]);
    } else glGenTextures(static_cast<GLsizei>(created.size()), created.data());
    for (std::size_t i = sharedAtlas ? 1U : 0U; i < created.size(); ++i) {
      glBindTexture(GL_TEXTURE_2D, created[i]);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, i == 0 ? GL_LINEAR : GL_NEAREST);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, i == 0 ? GL_LINEAR : GL_NEAREST);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
      if (i == 0) {
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_SWIZZLE_G, GL_RED);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_SWIZZLE_B, GL_RED);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_SWIZZLE_A, channels == 1 ? GL_ONE : GL_GREEN);
        glTexImage2D(GL_TEXTURE_2D, 0, channels == 1 ? GL_R8 : GL_RG8, page.width, page.height,
          0, channels == 1 ? GL_RED : GL_RG, GL_UNSIGNED_BYTE, atlas.data());
      } else {
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RG16UI, tableSize[0], tableSize[1], 0,
          GL_RG_INTEGER, GL_UNSIGNED_SHORT, table.data());
      }
    }
    const bool okay = created[0] && created[1] && glGetError() == GL_NO_ERROR;
    for (std::size_t i = 0; i < unpack.size(); ++i) glPixelStorei(unpackNames[i], unpack[i]);
    glBindBuffer(GL_PIXEL_UNPACK_BUFFER, unpackBuffer); glBindTexture(GL_TEXTURE_2D, binding);
    if (!okay) {
      if (!sharedAtlas) glDeleteTextures(1, &created[0]);
      glDeleteTextures(1, &created[1]);
      backing.blockRealizationFailed = true; ++blockUploadFailures_; return std::nullopt;
    }
    const auto tableBytes = table.size()*sizeof(std::uint16_t);
    const auto bytes = (sharedAtlas ? 0U : atlas.size()) + tableBytes;
    backing.gpuBytes += tableBytes; gpuBytes_ += bytes;
    peakGpuBytes_ = std::max(peakGpuBytes_, gpuBytes_);
    textureCreates_ += sharedAtlas ? 1 : 2; textureEpoch_ += sharedAtlas ? 1 : 2;
    textureUploadBytes_ += bytes;
    if (sharedAtlas) ++preparedSharedTextureHits_;
    else {
      sharedAtlas = shareTexture(atlasKey, created[0], atlas.size(), grayscaleStorage(channels));
      if (!sharedAtlas) backing.gpuBytes += atlas.size();
    }
    textures = {created[0], created[1], channels, std::move(sharedAtlas)};
    if (backing.pages.front().sparse) backing.pages.front().pixels.reset();
    ++blockTextureUploads_;
  }
  ++blockRegions_;
  return BlockImageRegion{{0, page.width, page.height, textures.atlas, targetPremultiplied, false},
    textures.table, *descriptor.blockGrid, tableSize, logical->width, logical->height};
} catch (const std::bad_alloc&) {
  // Reclaim cache storage without allocating the LRU bookkeeping on this path.
  for (auto& slot : slots_) if (slot.live && slot.prepared)
    for (auto& page : slot.prepared->pages) page.pixels.reset();
  // All CPU allocation precedes GL state changes and texture publication.
  if (inspect(handle)) {
    auto& backing = slots_[(handle & indexMask)-1U].prepared;
    if (backing && !backing->blockRealizationFailed) {
      backing->blockRealizationFailed = true; ++blockUploadFailures_;
    }
  }
  return std::nullopt;
}

std::optional<CompactImageRegion> ImageStore::resolveCompactRegion(ImageHandle handle,
    float x, float y, float width, float height) {
  if (!compactSamplingEnabled_) return std::nullopt;
  const auto info = inspect(handle);
  if (!info || !std::isfinite(x) || !std::isfinite(y) || !std::isfinite(width) ||
      !std::isfinite(height) || x < 0 || y < 0 || width <= 0 || height <= 0 ||
      x + width > info->width || y + height > info->height) return std::nullopt;
  auto& slot = slots_[(handle & indexMask) - 1U];
  if (!slot.prepared || slot.tiles || slot.prepared->descriptor.uniform) return std::nullopt;
  auto& backing = *slot.prepared;
  if (backing.compactRealizationFailed) return std::nullopt;
  const auto& descriptor = backing.descriptor;
  const auto found = std::find_if(descriptor.cells.begin(), descriptor.cells.end(), [&](const auto& cell) {
    return x >= cell.rect[0] && y >= cell.rect[1] &&
      x + width <= cell.rect[0] + cell.rect[2] && y + height <= cell.rect[1] + cell.rect[3];
  });
  if (descriptor.compactEligible && !backing.compactEligible) {
    GLint maximum = 0; glGetIntegerv(GL_MAX_TEXTURE_SIZE, &maximum);
    backing.compactEligible = *descriptor.compactEligible && info->width <= maximum && info->height <= maximum;
  }
  if (found == descriptor.cells.end() || !found->crop[2] || !found->crop[3] ||
      (backing.compactEligible && !*backing.compactEligible)) return std::nullopt;
  auto& page = backing.pages[found->page];
  const auto started = !tileDiagnostics_ || page.compactTexture ? std::chrono::steady_clock::time_point{} :
    std::chrono::steady_clock::now();
  const auto fill = descriptor.cells.front().fill;
  if (!backing.compactEligible) {
    bool acquired = false;
    GLint maxTexture = 0; glGetIntegerv(GL_MAX_TEXTURE_SIZE, &maxTexture);
    if (info->width > maxTexture || info->height > maxTexture ||
        fill[0] != fill[1] || fill[0] != fill[2] || fill[3] != 255) {
      backing.compactEligible = false; return std::nullopt;
    }
    const int inset = std::max(2, descriptor.halo);
    for (const auto& cell : descriptor.cells) {
      if (cell.fill != fill || (cell.crop[2] && cell.crop[3] &&
          (cell.crop[0] < inset || cell.crop[1] < inset ||
           cell.crop[0] + cell.crop[2] + inset > cell.rect[2] ||
           cell.crop[1] + cell.crop[3] + inset > cell.rect[3]))) {
        backing.compactEligible = false;
        if (acquired) trimPreparedPages();
        return std::nullopt;
      }
      if (!cell.crop[2] || !cell.crop[3]) continue;
      const auto* decoded = preparedPixels(backing, cell.page, &acquired);
      if (!decoded) {
        if (acquired) trimPreparedPages();
        return std::nullopt;
      }
      for (int row = 0; row < cell.crop[3]; ++row) for (int column = 0; column < cell.crop[2]; ++column) {
        const auto* pixel = decoded->rgba.data() +
            (static_cast<std::size_t>(cell.atlas[1] + row) * decoded->width + cell.atlas[0] + column) * 4U;
        if (pixel[0] != pixel[1] || pixel[0] != pixel[2] || pixel[3] != 255) {
          backing.compactEligible = false;
          if (acquired) trimPreparedPages();
          return std::nullopt;
        }
      }
    }
    backing.compactEligible = true;
    if (acquired) trimPreparedPages();
  }
  const auto powerOfTwo = [](int value) { int result = 1; while (result < value) result *= 2; return result; };
  const auto& pageSize = descriptor.pages[found->page];
  const int atlasWidth = powerOfTwo(pageSize.width), atlasHeight = powerOfTwo(pageSize.height);
  if (!page.compactTexture) {
    bool acquired = false;
    const auto* decoded = preparedPixels(backing, found->page, &acquired);
    if (!decoded) return std::nullopt;
    // Rebuild fill around retained crops instead of sampling atlas padding as image content.
    std::vector<std::uint8_t> pixels(static_cast<std::size_t>(atlasWidth) * atlasHeight, fill[0]);
    for (const auto& cell : descriptor.cells) {
      if (cell.page != found->page || !cell.crop[2] || !cell.crop[3]) continue;
      for (int row = 0; row < cell.crop[3]; ++row) for (int column = 0; column < cell.crop[2]; ++column)
        pixels[static_cast<std::size_t>(cell.atlas[1] + row) * atlasWidth + cell.atlas[0] + column] =
          decoded->rgba[(static_cast<std::size_t>(cell.atlas[1] + row) * decoded->width + cell.atlas[0] + column) * 4U];
    }
    if (acquired) trimPreparedPages();
    const bool createTables = backing.compactTables[0] == 0;
    std::array<std::vector<std::uint8_t>, 2> indices;
    std::array<std::vector<std::uint16_t>, 2> phases;
    const std::array<int, 2> lengths{info->width, info->height};
    if (createTables) for (std::size_t axis = 0; axis < lengths.size(); ++axis) {
      indices[axis].resize(static_cast<std::size_t>(lengths[axis]) * 4U);
      phases[axis].resize(static_cast<std::size_t>(lengths[axis]) * 2U);
      for (int i = 0; i < lengths[axis]; ++i) {
        indices[axis][i*4] = static_cast<std::uint8_t>(i & 255);
        indices[axis][i*4+1] = static_cast<std::uint8_t>(i >> 8);
        indices[axis][i*4+3] = 255;
        phases[axis][i*2] = i % 2 ? 0x3c00 : 0;
        phases[axis][i*2+1] = (i / 2) % 2 ? 0x3c00 : 0;
      }
    }
    GLint binding = 0, unpackBuffer = 0;
    glGetIntegerv(GL_TEXTURE_BINDING_2D, &binding);
    glGetIntegerv(GL_PIXEL_UNPACK_BUFFER_BINDING, &unpackBuffer);
    const std::array<GLenum, 4> unpackNames{GL_UNPACK_ALIGNMENT, GL_UNPACK_ROW_LENGTH,
                                         GL_UNPACK_SKIP_ROWS, GL_UNPACK_SKIP_PIXELS};
    std::array<GLint, 4> unpack{};
    for (std::size_t i = 0; i < unpack.size(); ++i) glGetIntegerv(unpackNames[i], &unpack[i]);
    glBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0);
    for (std::size_t i = 0; i < unpack.size(); ++i) glPixelStorei(unpackNames[i], i == 0 ? 1 : 0);
    while (glGetError() != GL_NO_ERROR) {}
    const auto upload = [](GLuint& texture, int width, int height, GLenum storage,
                           GLenum format, GLenum type, GLenum filter, const void* pixels) {
      glGenTextures(1, &texture); glBindTexture(GL_TEXTURE_2D, texture);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, filter);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, filter);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
      glTexImage2D(GL_TEXTURE_2D, 0, storage, width, height, 0, format, type, pixels);
    };
    GLuint atlas = 0;
    std::array<GLuint, 4> tables{};
    upload(atlas, atlasWidth, atlasHeight, GL_R8, GL_RED, GL_UNSIGNED_BYTE, GL_LINEAR, pixels.data());
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_SWIZZLE_G, GL_RED);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_SWIZZLE_B, GL_RED);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_SWIZZLE_A, GL_ONE);
    if (createTables) for (std::size_t axis = 0; axis < lengths.size(); ++axis) {
      const int tableWidth = axis == 0 ? lengths[axis] : 1, tableHeight = axis == 0 ? 1 : lengths[axis];
      upload(tables[axis], tableWidth, tableHeight, GL_RGBA8, GL_RGBA, GL_UNSIGNED_BYTE, GL_NEAREST, indices[axis].data());
      upload(tables[axis+2], tableWidth, tableHeight, GL_RG16F, GL_RG, GL_HALF_FLOAT, GL_LINEAR, phases[axis].data());
    }
    const bool ok = atlas && (!createTables || std::all_of(tables.begin(), tables.end(), [](GLuint texture) { return texture != 0; })) &&
      glGetError() == GL_NO_ERROR;
    for (std::size_t i = 0; i < unpack.size(); ++i) glPixelStorei(unpackNames[i], unpack[i]);
    glBindBuffer(GL_PIXEL_UNPACK_BUFFER, unpackBuffer); glBindTexture(GL_TEXTURE_2D, binding);
    if (!ok) {
      backing.compactRealizationFailed = true;
      ++compactUploadFailures_;
      if (atlas) glDeleteTextures(1, &atlas);
      glDeleteTextures(static_cast<GLsizei>(tables.size()), tables.data());
      return std::nullopt;
    }
    ++compactTextureUploads_;
    page.compactTexture = atlas;
    std::size_t bytes = pixels.size();
    const std::uint64_t creates = createTables ? 5 : 1;
    if (createTables) {
      backing.compactTables = tables;
      bytes += static_cast<std::size_t>(info->width + info->height) * 8U;
    }
    textureCreates_ += creates; textureEpoch_ += creates; textureUploadBytes_ += bytes;
    backing.gpuBytes += bytes; gpuBytes_ += bytes; peakGpuBytes_ = std::max(peakGpuBytes_, gpuBytes_);
    if (tileDiagnostics_) {
      const auto elapsedMs = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - started).count();
      Log() << "[pmjs-images] compact-image ready source=\"" << slot.sourcePath.generic_string()
        << "\" logical=" << info->width << 'x' << info->height << " atlas=" << atlasWidth << 'x' << atlasHeight
        << " atlas_bytes=" << pixels.size() << " lookup_bytes=" << static_cast<std::size_t>(info->width + info->height) * 8U
        << " upload_bytes=" << bytes << " realize_ms=" << std::fixed << std::setprecision(3) << elapsedMs;
    }
  }
  ++preparedRegions_;
  CompactImageRegion result;
  result.image = {0, atlasWidth, atlasHeight, page.compactTexture, false, false};
  result.contentBounds = {static_cast<float>(found->rect[0] + found->crop[0]),
    static_cast<float>(found->rect[1] + found->crop[1]),
    static_cast<float>(found->rect[0] + found->crop[0] + found->crop[2]),
    static_cast<float>(found->rect[1] + found->crop[1] + found->crop[3])};
  result.atlasOffset = {static_cast<float>(found->atlas[0]) - result.contentBounds[0],
    static_cast<float>(found->atlas[1]) - result.contentBounds[1]};
  result.logicalWidth = info->width; result.logicalHeight = info->height;
  result.indexX = backing.compactTables[0]; result.indexY = backing.compactTables[1];
  result.phaseX = backing.compactTables[2]; result.phaseY = backing.compactTables[3];
  result.fill = {fill[0] / 255.0f, fill[1] / 255.0f, fill[2] / 255.0f, 1};
  return result;
}

std::optional<std::size_t> ImageStore::uploadPreparedCrops(Slot& slot, std::uint32_t& texture) {
  if (!slot.prepared || slot.prepared->descriptor.uniform) return std::nullopt;
  auto& backing = *slot.prepared;
  const auto& cells = backing.descriptor.cells;
  const bool fullyPopulated = std::all_of(cells.begin(), cells.end(), [](const auto& cell) {
    return cell.crop == std::array<int, 4>{0, 0, cell.rect[2], cell.rect[3]};
  });
  const auto fill = fullyPopulated ? std::array<std::uint8_t, 4>{0, 0, 0, 255} : cells.front().fill;
  if (!fullyPopulated && (fill[0] != fill[1] || fill[0] != fill[2] || fill[3] != 255 ||
      std::any_of(cells.begin(), cells.end(), [&](const auto& cell) { return cell.fill != fill; })))
    return std::nullopt;
  // Only retained crops determine the image; atlas padding may be transparent or colored.
  std::vector<std::vector<std::uint8_t>> crops(cells.size());
  std::size_t uploaded = 0;
  bool acquired = false;
  for (std::size_t index = 0; index < cells.size(); ++index) {
    const auto& cell = cells[index];
    if (!cell.crop[2] || !cell.crop[3]) continue;
    const auto* page = preparedPixels(backing, cell.page, &acquired);
    if (!page) {
      if (acquired) trimPreparedPages();
      return std::nullopt;
    }
    auto& crop = crops[index];
    crop.resize(static_cast<std::size_t>(cell.crop[2]) * cell.crop[3]);
    for (int y = 0; y < cell.crop[3]; ++y) for (int x = 0; x < cell.crop[2]; ++x) {
      const auto* pixel = page->rgba.data() +
          (static_cast<std::size_t>(cell.atlas[1] + y) * page->width + cell.atlas[0] + x) * 4U;
      if (pixel[0] != pixel[1] || pixel[0] != pixel[2] || pixel[3] != 255) {
        if (acquired) trimPreparedPages();
        return std::nullopt;
      }
      crop[static_cast<std::size_t>(y) * cell.crop[2] + x] = pixel[0];
    }
    uploaded += crop.size();
  }
  for (auto& page : backing.pages) {
    if (page.sparse) page.pixels.reset();
  }
  if (acquired) trimPreparedPages();
  GLint framebuffer = 0, binding = 0, unpackBuffer = 0;
  glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &framebuffer);
  glGetIntegerv(GL_TEXTURE_BINDING_2D, &binding);
  glGetIntegerv(GL_PIXEL_UNPACK_BUFFER_BINDING, &unpackBuffer);
  const std::array<GLenum, 4> unpackNames{GL_UNPACK_ALIGNMENT, GL_UNPACK_ROW_LENGTH,
                                       GL_UNPACK_SKIP_ROWS, GL_UNPACK_SKIP_PIXELS};
  std::array<GLint, 4> unpack{};
  for (std::size_t i = 0; i < unpack.size(); ++i) glGetIntegerv(unpackNames[i], &unpack[i]);
  GLboolean colorMask[4]; glGetBooleanv(GL_COLOR_WRITEMASK, colorMask);
  const bool scissor = glIsEnabled(GL_SCISSOR_TEST), dither = glIsEnabled(GL_DITHER);
  while (glGetError() != GL_NO_ERROR) {}
  GLuint result = 0, target = 0;
  glGenTextures(1, &result); glBindTexture(GL_TEXTURE_2D, result);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_SWIZZLE_G, GL_RED);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_SWIZZLE_B, GL_RED);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_SWIZZLE_A, GL_ONE);
  glBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0);
  glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
  glPixelStorei(GL_UNPACK_ROW_LENGTH, 0);
  glPixelStorei(GL_UNPACK_SKIP_ROWS, 0);
  glPixelStorei(GL_UNPACK_SKIP_PIXELS, 0);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_R8, slot.width, slot.height, 0, GL_RED, GL_UNSIGNED_BYTE, nullptr);
  glGenFramebuffers(1, &target); glBindFramebuffer(GL_DRAW_FRAMEBUFFER, target);
  glFramebufferTexture2D(GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, result, 0);
  bool ok = result && target && glCheckFramebufferStatus(GL_DRAW_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE;
  if (ok) {
    glDisable(GL_SCISSOR_TEST); glDisable(GL_DITHER);
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    const GLfloat color[]{fill[0] / 255.0f, 0, 0, 1};
    glClearBufferfv(GL_COLOR, 0, color);
    for (std::size_t i = 0; i < cells.size(); ++i) {
      if (crops[i].empty()) continue;
      const auto& cell = cells[i];
      glTexSubImage2D(GL_TEXTURE_2D, 0, cell.rect[0] + cell.crop[0], cell.rect[1] + cell.crop[1],
                     cell.crop[2], cell.crop[3], GL_RED, GL_UNSIGNED_BYTE, crops[i].data());
    }
  }
  ok = ok && glGetError() == GL_NO_ERROR;
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, framebuffer);
  if (target) glDeleteFramebuffers(1, &target);
  glColorMask(colorMask[0], colorMask[1], colorMask[2], colorMask[3]);
  if (scissor) glEnable(GL_SCISSOR_TEST);
  if (dither) glEnable(GL_DITHER);
  for (std::size_t i = 0; i < unpack.size(); ++i) glPixelStorei(unpackNames[i], unpack[i]);
  glBindBuffer(GL_PIXEL_UNPACK_BUFFER, unpackBuffer);
  glBindTexture(GL_TEXTURE_2D, binding);
  if (!ok) { if (result) glDeleteTextures(1, &result); return std::nullopt; }
  texture = result;
  return uploaded;
}

bool ImageStore::materialize(Slot& slot, bool premultiplied) {
  auto& texture = premultiplied && !slot.premultiplied ? slot.premultipliedTexture : slot.texture;
  premultiplied = premultiplied || slot.premultiplied;
  if (texture) return true;
  if (!slot.prepared && !slot.tiles) return false;
  const auto sharedKey = slot.prepared ? preparedTextureKey(*slot.prepared, premultiplied) : std::string{};
  auto& shared = premultiplied && !slot.premultiplied ? slot.sharedPremultipliedTexture : slot.sharedTexture;
  if (!sharedKey.empty()) if (auto existing = preparedTextures_[sharedKey].lock()) {
    shared = std::move(existing); texture = shared->texture; slot.storage = shared->storage;
    ++preparedSharedTextureHits_; ++textureEpoch_;
    return true;
  }
  const auto started = tileDiagnostics_ ? std::chrono::steady_clock::now() :
    std::chrono::steady_clock::time_point{};
  const auto extent = checkedImageExtent(slot.width, slot.height, 16384, 128U * 1024U * 1024U);
  GLint maxTexture = 0; glGetIntegerv(GL_MAX_TEXTURE_SIZE, &maxTexture);
  if (!extent || slot.width > maxTexture || slot.height > maxTexture) {
    ++preparedFallbacks_["full-texture-limit"]; return false;
  }
  const auto cropUpload = preparedCropUploadsEnabled_ ? uploadPreparedCrops(slot, texture) :
    std::optional<std::size_t>{};
  if (cropUpload) {
    slot.storage = grayscaleStorage(1);
    ++preparedCropUploads_;
    preparedCropUploadBytes_ += *cropUpload;
  }
  std::size_t slotIndex = 0; while (slotIndex < slots_.size() && &slots_[slotIndex] != &slot) ++slotIndex;
  const auto handle = makeHandle(slotIndex, slot.generation);
  if (!cropUpload) {
    while (glGetError() != GL_NO_ERROR) {}
    glGenTextures(1, &texture); glBindTexture(GL_TEXTURE_2D, texture);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    const auto preparePixels = [premultiplied, &slot](ImagePixels& pixels) {
      if (premultiplied && slot.storage.channels != 1) for (std::size_t i = 0; i < pixels.rgba.size(); i += 4)
        for (std::size_t c = 0; c < 3; ++c)
          pixels.rgba[i+c] = static_cast<std::uint8_t>((pixels.rgba[i+c] * pixels.rgba[i+3] + 127) / 255);
    };
    bool ok = texture != 0;
    if (checkedImageExtent(slot.width, slot.height)) {
      auto pixels = readPixelsRegion(handle, 0, 0, slot.width, slot.height);
      ok = ok && pixels.has_value();
      if (ok) {
        const auto* decision = storageDecision(slot.cacheKey);
        if (decision && decision->width == pixels->width && decision->height == pixels->height) {
          slot.storage = decision->channels;
          ++storageDecisionHits_;
        } else slot.storage = imageStorage(*pixels);
        preparePixels(*pixels);
        texture = uploadTexture(slot.width, slot.height, pixels->rgba.data(), slot.storage, texture);
        if (!texture && decision) {
          const bool skippedPremultiply = slot.storage.channels == 1;
          slot.storage = {};
          if (skippedPremultiply) preparePixels(*pixels);
          texture = uploadTexture(slot.width, slot.height, pixels->rgba.data(), slot.storage);
        }
        ok = texture != 0;
      }
    } else {
      glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, slot.width, slot.height, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
      ok = ok && glGetError() == GL_NO_ERROR;
      constexpr int stripRows = 32;
      for (int y = 0; ok && y < slot.height; y += stripRows) {
        auto pixels = readPixelsRegion(handle, 0, y, slot.width, std::min(stripRows, slot.height - y));
        if (!pixels) { ok = false; break; }
        preparePixels(*pixels);
        glTexSubImage2D(GL_TEXTURE_2D, 0, 0, y, slot.width, pixels->height, GL_RGBA,
                        GL_UNSIGNED_BYTE, pixels->rgba.data());
        ok = glGetError() == GL_NO_ERROR;
      }
    }
    if (!ok) { if (texture) glDeleteTextures(1, &texture); texture = 0; return false; }
  }
  ++textureEpoch_; ++textureCreates_;
  if (slot.tiles) { if (tileDiagnostics_) ++tileMaterializations_; } else ++preparedMaterializations_;
  const auto bytes = slot.textureBytes();
  const auto uploaded = cropUpload.value_or(bytes);
  textureUploadBytes_ += uploaded;
  gpuBytes_ += bytes; peakGpuBytes_ = std::max(peakGpuBytes_, gpuBytes_);
  if (!sharedKey.empty()) shared = shareTexture(sharedKey, texture, bytes, slot.storage);
  if (tileDiagnostics_) {
    const auto elapsedMs = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - started).count();
    Log() << "[pmjs-images] " << (slot.tiles ? "tiled" : "prepared")
      << ' ' << (cropUpload ? "crop-upload ready" : "full-image fallback")
      << " source=\"" << slot.sourcePath.generic_string()
      << "\" last_sampling_reason=" << (slot.lastPreparedFallbackReason.empty() ? "not-recorded" : slot.lastPreparedFallbackReason)
      << " size=" << slot.width << 'x' << slot.height << " backing=" << (premultiplied ? "premultiplied" : "straight")
      << " upload_bytes=" << uploaded << " materialize_ms=" << std::fixed << std::setprecision(3) << elapsedMs
      << " realization=" << (cropUpload ? "crop-upload" : "cpu-reconstruction") << " resident_bytes=" << bytes;
  }
  return true;
}

bool ImageStore::hasCpuPixels(ImageHandle handle) const {
  return inspect(handle) && slots_[(handle & indexMask)-1U].cachedPixels.has_value();
}

bool ImageStore::hasPreparedBacking(ImageHandle handle) const {
  return inspect(handle) && (slots_[(handle & indexMask)-1U].prepared || slots_[(handle & indexMask)-1U].tiles);
}

bool ImageStore::hasUniformPreparedBacking(ImageHandle handle) const {
  return inspect(handle) && slots_[(handle & indexMask)-1U].prepared && slots_[(handle & indexMask)-1U].prepared->descriptor.uniform.has_value();
}

void ImageStore::notePreparedFallback(ImageHandle handle, const std::string& reason) {
  if (hasPreparedBacking(handle)) slots_[(handle & indexMask)-1U].lastPreparedFallbackReason = reason;
  if (hasTileBacking(handle)) { if (tileDiagnostics_) ++tileFallbacks_[reason]; }
  else if (hasPreparedBacking(handle)) ++preparedFallbacks_[reason];
}

std::optional<ImageInfo> ImageStore::lookup(ImageHandle handle,
    const char* caller) const {
  auto info = inspect(handle);
  if (!info) return info;
  auto& self = *const_cast<ImageStore*>(this);
  auto& slot = self.slots_[(handle & indexMask)-1U];
  if (slot.astc) return self.lookupAstc(handle, false);
  if (slot.palette) {
    if (!self.materializePalette(slot)) return std::nullopt;
    return self.inspect(handle);
  }
  if (info->texture) return info;
  if (!slot.prepared && !slot.tiles) return info;
  const bool sceneryBacking = slot.prepared || slot.tiles;
  if (!self.materialize(slot, false)) return std::nullopt;
  if (sceneryBacking && !slot.sceneryFullMaterialized) {
    slot.sceneryFullMaterialized = true;
    slot.sceneryFirstMaterializationCaller = caller ? caller : "unknown";
    ++self.sceneryFullFallbacks_;
  }
  return inspect(handle);
}

}  // namespace pmjs
