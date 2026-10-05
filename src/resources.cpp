#include "resources.hpp"
#include "checked_bounds.hpp"
#include "png_recovery.hpp"
#include "psd_decoder.hpp"

#include <algorithm>
#include <array>
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

#include <GLES3/gl3.h>
#include <jpeglib.h>
#include <png.h>

namespace pmjs {

namespace {
constexpr std::uint32_t indexMask = 0xffffU;
constexpr std::uint16_t generationMask = 0x7fffU;

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

std::uint32_t uploadTexture(int width, int height, const void* rgba, int channels,
                            std::uint32_t texture = 0) {
  std::vector<std::uint8_t> compact;
  const auto* bytes = static_cast<const std::uint8_t*>(rgba);
  const auto count = static_cast<std::size_t>(width) * height;
  if (channels != 4) {
    compact.resize(count * channels);
    for (std::size_t i = 0; i < count; ++i) {
      compact[i * channels] = bytes[i * 4];
      if (channels == 2) compact[i * 2 + 1] = bytes[i * 4 + 3];
    }
    bytes = compact.data();
  }
  while (glGetError() != GL_NO_ERROR) {}
  if (!texture) glGenTextures(1, &texture);
  glBindTexture(GL_TEXTURE_2D, texture);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  if (channels != 4) {
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_SWIZZLE_G, GL_RED);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_SWIZZLE_B, GL_RED);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_SWIZZLE_A, channels == 1 ? GL_ONE : GL_GREEN);
  }
  glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
  const auto format = channels == 1 ? GL_RED : channels == 2 ? GL_RG : GL_RGBA;
  const auto storage = channels == 1 ? GL_R8 : channels == 2 ? GL_RG8 : GL_RGBA;
  glTexImage2D(GL_TEXTURE_2D, 0, storage, width, height, 0, format, GL_UNSIGNED_BYTE, bytes);
  if (!texture || glGetError() != GL_NO_ERROR) {
    if (texture) glDeleteTextures(1, &texture);
    return 0;
  }
  return texture;
}

std::optional<ImagePixels> decodePngFromMemory(const void* data, std::size_t size,
    std::size_t maxDecodedBytes = 128U*1024U*1024U) {
  if (!data || size < 8) return std::nullopt;
  png_image image{};
  image.version = PNG_IMAGE_VERSION;
  if (!png_image_begin_read_from_memory(&image, data, size)) return std::nullopt;
  image.format = PNG_FORMAT_RGBA;
  const auto extent = checkedImageExtent(static_cast<int>(image.width), static_cast<int>(image.height), 8192, maxDecodedBytes);
  if (!extent) {
    png_image_free(&image);
    return std::nullopt;
  }
  ImagePixels result;
  result.width = extent->width;
  result.height = extent->height;
  result.rgba.resize(extent->rgbaBytes);
  if (!png_image_finish_read(&image, nullptr, result.rgba.data(), 0, nullptr)) {
    png_image_free(&image);
    return std::nullopt;
  }
  png_image_free(&image);
  return result;
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
  std::uint8_t* raw = nullptr;
  if (setjmp(error.recovery)) {
    std::free(raw);
    jpeg_destroy_decompress(&decoder);
    return std::nullopt;
  }
  jpeg_create_decompress(&decoder);
  jpeg_mem_src(&decoder, static_cast<const unsigned char*>(data), size);
  if (jpeg_read_header(&decoder, TRUE) != JPEG_HEADER_OK) {
    jpeg_destroy_decompress(&decoder);
    return std::nullopt;
  }
  const auto extent = checkedImageExtent(
      static_cast<int>(decoder.image_width),
      static_cast<int>(decoder.image_height), 8192, maxDecodedBytes);
  if (!extent) {
    jpeg_destroy_decompress(&decoder);
    return std::nullopt;
  }
  decoder.out_color_space = JCS_RGB;
  jpeg_start_decompress(&decoder);
  const std::size_t width = static_cast<std::size_t>(extent->width);
  const std::size_t rgbBytes = extent->rgbBytes;
  raw = static_cast<std::uint8_t*>(std::malloc(rgbBytes));
  if (!raw) {
    jpeg_destroy_decompress(&decoder);
    return std::nullopt;
  }
  while (decoder.output_scanline < decoder.output_height) {
    JSAMPROW row = raw + decoder.output_scanline * width * 3U;
    jpeg_read_scanlines(&decoder, &row, 1);
  }
  jpeg_finish_decompress(&decoder);
  jpeg_destroy_decompress(&decoder);

  ImagePixels result;
  result.width = extent->width;
  result.height = extent->height;
  result.rgba.resize(extent->rgbaBytes);
  for (std::size_t source = 0, destination = 0; source < rgbBytes;
       source += 3U, destination += 4U) {
    result.rgba[destination] = raw[source];
    result.rgba[destination + 1U] = raw[source + 1U];
    result.rgba[destination + 2U] = raw[source + 2U];
    result.rgba[destination + 3U] = 255;
  }
  std::free(raw);
  return result;
}

std::optional<ImagePixels> decodeMemory(const void* data, std::size_t size,
    std::size_t maxDecodedBytes = 128U*1024U*1024U) {
  if (!data || size < 4) return std::nullopt;
  const auto* bytes = static_cast<const std::uint8_t*>(data);
  if (size >= 8 && png_sig_cmp(bytes, 0, 8) == 0) {
    if (auto pixels = decodePngFromMemory(data, size, maxDecodedBytes)) return pixels;
  }
  if (size >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff) {
    return decodeJpegFromMemory(data, size, maxDecodedBytes);
  }
  if (size >= 6 && std::memcmp(bytes, "8BPS\0\1", 6) == 0) return decodePsdFromMemory(data, size, maxDecodedBytes);
  if (auto recovered = recoverPngBytes({bytes, size}, maxDecodedBytes))
    return decodePngFromMemory(recovered->data(), recovered->size(), maxDecodedBytes);
  return std::nullopt;
}

std::optional<ImagePixels> readTexturePixels(const ImageInfo& image, int channels = 4) {
  const auto extent = checkedImageExtent(image.width, image.height);
  if (!extent) return std::nullopt;
  ImagePixels pixels{image.width, image.height,
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
    glReadPixels(0, 0, image.width, image.height, GL_RGBA,
                 GL_UNSIGNED_BYTE, pixels.rgba.data());
    // Texture swizzles do not apply to framebuffer reads.
    if (channels != 4) for (std::size_t i = 0; i < pixels.rgba.size(); i += 4) {
      const auto alpha = channels == 1 ? 255 : pixels.rgba[i + 1];
      pixels.rgba[i + 1] = pixels.rgba[i + 2] = pixels.rgba[i];
      pixels.rgba[i + 3] = static_cast<std::uint8_t>(alpha);
    }
  }
  glBindBuffer(GL_PIXEL_PACK_BUFFER, static_cast<GLuint>(previousBuffer));
  glBindFramebuffer(GL_READ_FRAMEBUFFER, static_cast<GLuint>(previousRead));
  glDeleteFramebuffers(1, &framebuffer);
  for (std::size_t index = 0; index < parameters.size(); ++index) {
    glPixelStorei(parameters[index], previousPack[index]);
  }
  return complete ? std::optional<ImagePixels>(std::move(pixels)) : std::nullopt;
}
}

ImageFileSource::~ImageFileSource() {
  if (descriptor_ >= 0) close(descriptor_);
}

std::unique_ptr<ImageFileSource> ImageStore::openFile(const std::filesystem::path& path) {
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
  source->key_ = resolved.generic_string() + ':' + std::to_string(info.st_dev) + ':' +
    std::to_string(info.st_ino) + ':' + std::to_string(info.st_size) + ':' +
    std::to_string(info.st_mtim.tv_sec) + ':' + std::to_string(info.st_mtim.tv_nsec) + ':' +
    std::to_string(info.st_ctim.tv_sec) + ':' + std::to_string(info.st_ctim.tv_nsec);
  return source;
}

struct ImageStore::PreparedBacking {
  struct Page {
    std::shared_ptr<ImageFileSource> source;
    std::optional<ImagePixels> pixels;
    std::uint32_t texture = 0, premultipliedTexture = 0;
    int channels = 0;
    std::uint16_t cpuFrames = 0;
    std::filesystem::path path;
    std::string identity;
    std::uint64_t lastCpuUse = 0;
  };
  PreparedImageDescriptor descriptor;
  std::vector<Page> pages;
  std::vector<ImageHandle> cellImages;
  std::size_t gpuBytes = 0;
  std::uint64_t cpuClock = 0;
};

struct ImageStore::PreparedLoad {
  std::shared_ptr<PreparedBacking> backing;
  std::shared_ptr<TileLoad> tiles;
  bool validated = false;
  std::optional<ImagePixels> pixels;
};

ImageStore::ImageStore() {
  const char* diagnostics = std::getenv("PMJS_GRAPHICS_DIAGNOSTICS");
  tileDiagnostics_ = diagnostics && std::string(diagnostics) == "1";
}

ImageStore::~ImageStore() {
  *alive_ = false;
  for (auto& slot : slots_) {
    if (slot.live) {
      if (slot.prepared) {
        for (auto& page : slot.prepared->pages) {
          if (page.premultipliedTexture && page.premultipliedTexture != page.texture) glDeleteTextures(1, &page.premultipliedTexture);
          if (page.texture) glDeleteTextures(1, &page.texture);
        }
      }
      clearPremultipliedTexture(slot);
      ++textureEpoch_;
      glDeleteTextures(1, &slot.texture);
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

std::optional<ImagePixels> ImageStore::decodeFile(const ImageFileSource& source, std::size_t maxDecodedBytes) {
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
  return pmjs::decodeMemory(bytes.data(), bytes.size(), maxDecodedBytes);
}

std::optional<ImageInfo> ImageStore::loadPng(const std::filesystem::path& path,
                                             bool retainCpuPixels, const std::string& tileSet) {
  auto source = openFile(path);
  if (!source) return std::nullopt;
  if (auto cached = acquireCached(*source, tileSet)) {
    if (retainCpuPixels) this->retainCpuPixels(cached->handle);
    return cached;
  }
  std::shared_ptr<ImageFileSource> fallback;
  if (!tileSet.empty()) {
    auto load = capturePrepared(*source, tileSet);
    if (load) fallback = capturePreparedFallback(*load);
    if (load && validatePrepared(*load, retainCpuPixels)) {
      if (auto image = installPreparedLoad(*source, std::move(load), retainCpuPixels)) return image;
    }
  } else if (auto prepared = acquirePrepared(*source, retainCpuPixels)) return prepared;
  auto pixels = decodeFile(fallback ? *fallback : *source);
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

  auto created = createDecoded(pixels);
  if (!created) return std::nullopt;
  const std::size_t index = (created->handle & indexMask) - 1U;
  slots_[index].cacheKey = cacheKey;
  slots_[index].sourcePath = source.path();
  slots_[index].retainCpuPixels = retainCpuPixels;
  if (retainCpuPixels) {
    slots_[index].cachedPixels = std::move(pixels);
    slots_[index].cpuPixelFrames = 0;
  }
  pathCache_.emplace(cacheKey, created->handle);
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
  if (slot.cachedPixels) {
    slot.retainCpuPixels = true;
    slot.cpuPixelFrames = 0;
    return true;
  }
  if (slot.cacheKey.empty() && !slot.tiles) return false;
  slot.cachedPixels = (slot.prepared || slot.tiles) ? readPixelsRegion(handle, 0, 0, info->width, info->height) : readTexturePixels(*info, slot.channels);
  if (!slot.cachedPixels) return false;
  slot.retainCpuPixels = true;
  slot.cpuPixelFrames = 0;
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
  const auto& slot = slots_[encodedIndex - 1U];
  if (slot.cachedPixels) {
    if (!slot.retainCpuPixels && !slot.cacheKey.empty()) slot.cpuPixelFrames = 60;
    return &*slot.cachedPixels;
  }
  if (slot.cacheKey.empty() && !slot.tiles) return nullptr;
  slot.cachedPixels = (slot.prepared || slot.tiles) ? readPixelsRegion(handle, 0, 0, info->width, info->height) : readTexturePixels(*info, slot.channels);
  if (!slot.retainCpuPixels) slot.cpuPixelFrames = 60;
  return slot.cachedPixels ? &*slot.cachedPixels : nullptr;
}

std::optional<ImageInfo> ImageStore::createRgba(int width, int height,
                                                 const void* pixels, bool premultiplied) {
  return createImage(width, height, pixels, premultiplied, 4);
}

std::size_t ImageStore::decodedStorageBytes(const ImagePixels& pixels) {
  return pixels.rgba.size()/4*grayscaleChannels(pixels);
}

std::optional<ImageInfo> ImageStore::createDecoded(const ImagePixels& pixels) {
  return createImage(pixels.width, pixels.height, pixels.rgba.data(), false,
                     grayscaleChannels(pixels));
}

std::optional<ImageInfo> ImageStore::createImage(int width, int height,
    const void* pixels, bool premultiplied, int channels) {
  const auto extent = checkedImageExtent(width, height);
  if (!extent) return std::nullopt;
  const auto texture = uploadTexture(width, height, pixels, channels);
  if (!texture) return std::nullopt;
  ++textureCreates_;
  ++textureEpoch_;
  if (pixels) {
    textureUploadBytes_ += static_cast<std::uint64_t>(width) *
        static_cast<std::uint64_t>(height) * channels;
  }

  std::size_t index = 0;
  while (index < slots_.size() && slots_[index].live) ++index;
  if (index >= indexMask) {
    glDeleteTextures(1, &texture);
    return std::nullopt;
  }
  if (index == slots_.size()) slots_.emplace_back();
  auto& slot = slots_[index];
  slot.texture = texture;
  slot.prepared.reset();
  slot.mipmapsReady = slot.premultipliedMipmapsReady = false;
  slot.mipmapBytes = slot.premultipliedMipmapBytes = 0;
  slot.width = width;
  slot.height = height;
  slot.channels = channels;
  slot.references = 1;
  slot.inFlight.store(0, std::memory_order_relaxed);
  slot.pins = 0;
  markUsed(slot);
  slot.cpuPixelFrames = 0;
  slot.retainCpuPixels = false;
  slot.cacheKey.clear();
  slot.sourcePath.clear();
  slot.cachedPixels.reset();
  slot.gpuOnly = pixels == nullptr;
  slot.renderTarget = false;
  slot.premultiplied = premultiplied;
  slot.knownAllZero = pixels && allZeroRgba(pixels, width, height, width);
  slot.live = true;
  ++liveCount_;
  gpuBytes_ += static_cast<std::size_t>(width) * height * channels;
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
  for (const auto& slot : slots_) {
    if (slot.live && slot.cachedPixels) result += slot.cachedPixels->rgba.capacity();
    if (slot.live && slot.prepared) for (const auto& page : slot.prepared->pages)
      if (page.pixels) result += page.pixels->rgba.capacity();
  }
  return result;
}

std::size_t ImageStore::residentBytes(const Slot& slot) const {
  std::size_t ownedCells = 0;
  if (slot.prepared) for (const auto image : slot.prepared->cellImages)
    if (inspect(image)) ownedCells += residentBytes(slots_[(image & indexMask)-1U]);
  return ownedCells + static_cast<std::size_t>(slot.width) *
      static_cast<std::size_t>(slot.height) * slot.channels *
      ((slot.texture ? 1U : 0U) + (slot.premultipliedTexture && slot.premultipliedTexture != slot.texture ? 1U : 0U)) +
      (slot.prepared ? slot.prepared->gpuBytes : 0U) +
      slot.mipmapBytes + slot.premultipliedMipmapBytes +
      (slot.cachedPixels ? slot.cachedPixels->rgba.capacity() : 0U) +
      (slot.prepared ? [&]() { std::size_t bytes = 0; for (const auto& page : slot.prepared->pages) if (page.pixels) bytes += page.pixels->rgba.capacity(); return bytes; }() : 0U);
}

std::size_t ImageStore::warmBytes() const {
  std::size_t result = 0;
  for (const auto& slot : slots_) {
    if (slot.live && slot.references == 0 && slot.pins == 0 &&
        slot.inFlight.load(std::memory_order_acquire) == 0 &&
        !slot.cacheKey.empty()) result += residentBytes(slot);
  }
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
    result.push_back({makeHandle(index, slot.generation), slot.width, slot.height,
      slot.references, slot.inFlight.load(std::memory_order_acquire), slot.pins,
      static_cast<std::size_t>(slot.width) * slot.height * slot.channels *
        ((slot.texture ? 1U : 0U) + (slot.premultipliedTexture && slot.premultipliedTexture != slot.texture ? 1U : 0U)) +
        (slot.prepared ? slot.prepared->gpuBytes : 0U) +
        slot.mipmapBytes + slot.premultipliedMipmapBytes,
      (slot.cachedPixels ? slot.cachedPixels->rgba.capacity() : 0U) +
        (slot.prepared ? [&]() { std::size_t bytes = 0; for (const auto& page : slot.prepared->pages) if (page.pixels) bytes += page.pixels->rgba.capacity(); return bytes; }() : 0U),
      slot.lastUsedSerial,
      slot.references == 0 && slot.pins == 0 &&
        slot.inFlight.load(std::memory_order_acquire) == 0 &&
        !slot.cacheKey.empty(),
      slot.sourcePath.generic_string()});
  }
  return result;
}

bool ImageStore::updateRgba(ImageHandle handle, const void* pixels) {
  const auto info = lookup(handle);
  if (!info || !pixels) return false;
  auto& slot = slots_[(handle & indexMask) - 1U];
  slot.knownAllZero = false;
  clearPrepared(slot);
  clearPremultipliedTexture(slot);
  const bool compact = slot.channels != 4;
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
  auto& slot = slots_[(handle & indexMask) - 1U];
  const bool canProveZero = slot.knownAllZero ||
      (x == 0 && y == 0 && width == info->width && height == info->height);
  slot.knownAllZero = false;
  clearPrepared(slot);
  clearPremultipliedTexture(slot);
  if (slot.channels != 4 && !promoteToRgba(slot)) return false;
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

bool ImageStore::promoteToRgba(Slot& slot, const void* replacement) {
  std::optional<ImagePixels> snapshot;
  if (!replacement) {
    snapshot = readTexturePixels(ImageInfo{0, slot.width, slot.height, slot.texture}, slot.channels);
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
  gpuBytes_ -= count * slot.channels + slot.mipmapBytes;
  slot.mipmapBytes = 0;
  slot.mipmapsReady = false;
  slot.channels = 4;
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

bool ImageStore::isRenderTarget(ImageHandle handle) const {
  if (!inspect(handle)) return false;
  return slots_[(handle & indexMask) - 1U].renderTarget;
}

std::optional<ImageInfo> ImageStore::lookupPremultiplied(ImageHandle handle) {
  auto info = inspect(handle);
  if (!info) return info;
  if (info->premultiplied) return info->texture ? info : lookup(handle);
  auto& slot = slots_[(handle & indexMask) - 1U];
  if (slot.prepared || slot.tiles) {
    if (!materialize(slot, true)) return std::nullopt;
    info->texture = slot.premultipliedTexture; info->premultiplied = true;
    return info;
  }
  // Render targets are already framebuffer pixels, not decoded straight images.
  if (slot.gpuOnly) return info;
  if (!slot.premultipliedTexture) {
    auto pixels = readTexturePixels(*info, slot.channels);
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
      const auto texture = uploadTexture(info->width, info->height, pixels->rgba.data(), slot.channels);
      if (!texture) return std::nullopt;
      const auto bytes = static_cast<std::size_t>(info->width) * info->height * slot.channels;
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
  const auto info = premultiplied ? lookupPremultiplied(handle) : lookup(handle);
  if (!info || (info->width & (info->width - 1)) || (info->height & (info->height - 1))) return false;
  auto& slot = slots_[(handle & indexMask) - 1U];
  const bool separate = info->texture != slot.texture;
  auto& ready = separate ? slot.premultipliedMipmapsReady : slot.mipmapsReady;
  auto& bytes = separate ? slot.premultipliedMipmapBytes : slot.mipmapBytes;
  if (ready && !slot.renderTarget) return true;
  while (glGetError() != GL_NO_ERROR) {}
  glBindTexture(GL_TEXTURE_2D, info->texture);
  glGenerateMipmap(GL_TEXTURE_2D);
  if (glGetError() != GL_NO_ERROR) throw std::runtime_error("cannot generate image mipmaps");
  if (!bytes) {
    for (int w = info->width, h = info->height; w > 1 || h > 1;) {
      w = std::max(1, w / 2); h = std::max(1, h / 2);
      bytes += static_cast<std::size_t>(w) * h * slot.channels;
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
  if (slot.premultipliedTexture && slot.premultipliedTexture != slot.texture) {
    ++textureEpoch_;
    glDeleteTextures(1, &slot.premultipliedTexture);
    gpuBytes_ -= static_cast<std::size_t>(slot.width) * slot.height * slot.channels;
  }
  slot.premultipliedTexture = 0;
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
  clearPremultipliedTexture(slot);
  if (!slot.cacheKey.empty()) pathCache_.erase(slot.cacheKey);
  ++textureEpoch_;
  glDeleteTextures(1, &slot.texture);
  gpuBytes_ -= slot.mipmapBytes;
  slot.mipmapBytes = 0;
  if (slot.texture) gpuBytes_ -= static_cast<std::size_t>(slot.width) * slot.height * slot.channels;
  if (slot.prepared) {
    for (auto& page : slot.prepared->pages) {
      if (page.premultipliedTexture && page.premultipliedTexture != page.texture) glDeleteTextures(1, &page.premultipliedTexture);
      if (page.texture) glDeleteTextures(1, &page.texture);
    }
    gpuBytes_ -= slot.prepared->gpuBytes;
    for (const auto image : slot.prepared->cellImages) if (image) release(image);
  }
  slot.texture = 0;
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
  if (previous == 1 && slot.references == 0 && slot.pins == 0 &&
      slot.cacheKey.empty()) {
    destroySlot(index);
  }
  return true;
}

void ImageStore::update() {
  std::size_t currentWarmBytes = 0;
  for (std::size_t index = 0; index < slots_.size(); ++index) {
    auto& slot = slots_[index];
    if (!slot.live) continue;
    if (slot.prepared) for (auto& page : slot.prepared->pages) {
      if (page.cpuFrames) --page.cpuFrames;
      else page.pixels.reset();
    }
    // Explicitly retained slots keep CPU pixels for the life of the texture;
    // on-demand buffers age out here.
    if (slot.cachedPixels && !slot.retainCpuPixels) {
      if (slot.cpuPixelFrames > 0) {
        --slot.cpuPixelFrames;
      } else {
        slot.cachedPixels.reset();
      }
    }
    if (slot.references == 0 && slot.pins == 0 && !slot.cacheKey.empty() &&
        slot.inFlight.load(std::memory_order_acquire) == 0) {
      currentWarmBytes += residentBytes(slot);
    }
  }
  currentWarmBytes += tileWarmBytes();
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
  for (auto& page : slot.prepared->pages) {
    if (page.premultipliedTexture && page.premultipliedTexture != page.texture) glDeleteTextures(1, &page.premultipliedTexture);
    if (page.texture) glDeleteTextures(1, &page.texture);
  }
  gpuBytes_ -= slot.prepared->gpuBytes;
  for (const auto image : slot.prepared->cellImages) if (image) release(image);
  slot.prepared.reset();
}

bool ImageStore::installPrepared(const std::filesystem::path& sourcePath,
                                const std::filesystem::path& directory,
                                PreparedImageDescriptor descriptor,
                                const std::string& expectedSourceIdentity) {
  if (descriptor.version != 1 || descriptor.halo < 1 || descriptor.halo > 32 || !checkedImageExtent(descriptor.width, descriptor.height,
      8192, 128U * 1024U * 1024U)) return false;
  auto original = openFile(sourcePath);
  if (!original || (!expectedSourceIdentity.empty() && original->key() != expectedSourceIdentity)) return false;
  auto backing = std::make_shared<PreparedBacking>();
  const auto sourceIdentity = original->key();
  if (!descriptor.uniform && descriptor.cells.empty()) return false;
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
  if (!descriptor.uniform) {
    if (area != static_cast<std::size_t>(descriptor.width) * descriptor.height) return false;
    for (std::size_t i = 0; i < descriptor.cells.size(); ++i)
      for (std::size_t j = 0; j < i; ++j) {
        const auto& a = descriptor.cells[i].rect; const auto& b = descriptor.cells[j].rect;
        if (a[0] < b[0] + b[2] && b[0] < a[0] + a[2] &&
            a[1] < b[1] + b[3] && b[1] < a[1] + a[3]) return false;
      }
  }
  for (const auto& page : descriptor.pages) {
    if (page.width <= 0 || page.height <= 0 || page.width > 2048 || page.height > 2048 ||
        page.path.empty() || page.path.is_absolute() || page.path.has_parent_path()) return false;
    auto source = openFile(directory / page.path);
    if (!source) return false;
    PreparedBacking::Page prepared;
    prepared.path = source->path(); prepared.identity = source->key();
    backing->pages.push_back(std::move(prepared));
  }
  backing->descriptor = std::move(descriptor);
  preparedSources_[sourceIdentity] = std::move(backing);
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
  const auto found = preparedSources_.find(source.key());
  if (!prototype && found == preparedSources_.end()) return nullptr;
  auto load = std::make_shared<PreparedLoad>();
  if (!prototype) prototype = found->second;
  struct stat current{};
  if (fstat(source.descriptor_, &current) != 0 ||
      current.st_size != static_cast<off_t>(source.size_) ||
      current.st_mtim.tv_sec != source.modifiedSeconds_ ||
      current.st_mtim.tv_nsec != source.modifiedNanoseconds_) return nullptr;
  load->backing = std::make_shared<PreparedBacking>();
  auto& backing = *load->backing;
  backing.descriptor = prototype->descriptor;
  for (const auto& page : prototype->pages) {
    auto file = page.source ? page.source : std::shared_ptr<ImageFileSource>(openFile(page.path));
    if (!file || file->key() != page.identity) return nullptr;
    PreparedBacking::Page captured;
    captured.source = std::move(file);
    captured.path = page.path;
    captured.identity = page.identity;
    backing.pages.push_back(std::move(captured));
  }
  return load;
}

std::shared_ptr<ImageFileSource> ImageStore::capturePreparedFallback(const PreparedLoad& load) {
  return load.tiles ? captureTileFallback(*load.tiles) : nullptr;
}

bool ImageStore::validatePrepared(PreparedLoad& load, bool retainCpu) {
  if (load.tiles) { load.validated = validateTileLoad(*load.tiles, retainCpu); return load.validated; }
  auto& backing = *load.backing;
  if (!load.validated) {
    for (std::size_t i = 0; i < backing.pages.size(); ++i) {
      const auto pixels = decodeFile(*backing.pages[i].source);
      if (!pixels || pixels->width != backing.descriptor.pages[i].width ||
          pixels->height != backing.descriptor.pages[i].height) return false;
    }
    load.validated = true;
  }
  if (retainCpu && !load.pixels &&
      checkedImageExtent(backing.descriptor.width, backing.descriptor.height)) {
    load.pixels = readPreparedRegion(backing, 0, 0,
      backing.descriptor.width, backing.descriptor.height);
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
  if (load->tiles) return installTileLoad(std::move(load->tiles), retainCpu);
  auto pixels = std::move(load->pixels);
  if (auto cached = acquireCached(source)) {
    auto& slot = slots_[(cached->handle & indexMask) - 1U];
    if (retainCpu && pixels && slot.prepared) {
      slot.cachedPixels = std::move(pixels);
      slot.retainCpuPixels = true;
      slot.cpuPixelFrames = 0;
    } else if (retainCpu) retainCpuPixels(cached->handle);
    return cached;
  }
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
  slot.channels = 4;
  slot.texture = slot.premultipliedTexture = 0;
  slot.references = 1; slot.pins = 0; slot.inFlight.store(0);
  slot.cacheKey = source.key(); slot.sourcePath = source.path();
  slot.gpuOnly = slot.renderTarget = slot.premultiplied = false;
  slot.knownAllZero = descriptor.uniform ?
      std::all_of(descriptor.uniform->begin(), descriptor.uniform->end(),
                  [](std::uint8_t v) { return v == 0; }) :
      std::all_of(descriptor.cells.begin(), descriptor.cells.end(),
                  [](const PreparedImageCell& cell) {
                    return (cell.crop[2] == 0 || cell.crop[3] == 0) &&
                      std::all_of(cell.fill.begin(), cell.fill.end(), [](std::uint8_t v) { return v == 0; });
                  });
  slot.retainCpuPixels = retainCpu; slot.cachedPixels = std::move(pixels); slot.cpuPixelFrames = 0;
  slot.mipmapsReady = slot.premultipliedMipmapsReady = false;
  slot.mipmapBytes = slot.premultipliedMipmapBytes = 0;
  slot.live = true; markUsed(slot); ++liveCount_; ++preparedHits_;
  const auto handle = makeHandle(index, slot.generation);
  pathCache_[source.key()] = handle;
  return inspect(handle);
}

std::optional<ImagePixels> ImageStore::readPixelsRegion(ImageHandle handle,
    int x, int y, int width, int height) const {
  auto info = inspect(handle);
  const auto extent = checkedImageExtent(width, height);
  if (!info || !extent || x < 0 || y < 0 || x > info->width - width ||
      y > info->height - height) return std::nullopt;
  const auto& slot = slots_[(handle & indexMask) - 1U];
  if (slot.tiles) return readTileRegion(slot, x, y, width, height);
  if (!slot.prepared) {
    auto* full = readPixels(handle);
    if (!full && !slot.gpuOnly) {
      slot.cachedPixels = readTexturePixels(*info, slot.channels);
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
  return readPreparedRegion(*slot.prepared, x, y, width, height);
}

std::optional<ImagePixels> ImageStore::readPreparedRegion(PreparedBacking& backing,
    int x, int y, int width, int height) {
  const auto extent = checkedImageExtent(width, height);
  if (!extent) return std::nullopt;
  ImagePixels result{width, height, std::vector<std::uint8_t>(extent->rgbaBytes)};
  if (backing.descriptor.uniform) {
    for (std::size_t i = 0; i < result.rgba.size(); i += 4)
      std::copy(backing.descriptor.uniform->begin(), backing.descriptor.uniform->end(), result.rgba.begin() + i);
    return result;
  }
  for (const auto& cell : backing.descriptor.cells) {
    const int left = std::max(x, cell.rect[0]), top = std::max(y, cell.rect[1]);
    const int right = std::min(x + width, cell.rect[0] + cell.rect[2]);
    const int bottom = std::min(y + height, cell.rect[1] + cell.rect[3]);
    const bool needsPage = left < right && top < bottom && cell.crop[2] > 0 && cell.crop[3] > 0 &&
        left < cell.rect[0]+cell.crop[0]+cell.crop[2] && right > cell.rect[0]+cell.crop[0] &&
        top < cell.rect[1]+cell.crop[1]+cell.crop[3] && bottom > cell.rect[1]+cell.crop[1];
    const auto* page = needsPage ? preparedPixels(backing, cell.page) : nullptr;
    if (needsPage && !page) return std::nullopt;
    for (int row = top; row < bottom; ++row) for (int column = left; column < right; ++column) {
      auto* destination = result.rgba.data() + (static_cast<std::size_t>(row - y) * width + column - x) * 4;
      const int cx = column - cell.rect[0] - cell.crop[0], cy = row - cell.rect[1] - cell.crop[1];
      if (cx >= 0 && cy >= 0 && cx < cell.crop[2] && cy < cell.crop[3]) {
        const auto* pixel = page->rgba.data() +
            (static_cast<std::size_t>(cell.atlas[1] + cy) * page->width + cell.atlas[0] + cx) * 4;
        std::copy_n(pixel, 4, destination);
      } else std::copy(cell.fill.begin(), cell.fill.end(), destination);
    }
  }
  return result;
}

ImagePixels* ImageStore::preparedPixels(PreparedBacking& backing, std::size_t index) {
  auto& page = backing.pages[index];
  if (!page.pixels) {
    constexpr std::size_t pageCacheBudget = 32U * 1024U * 1024U;
    const auto& dimensions = backing.descriptor.pages[index];
    const auto requestedBytes = static_cast<std::size_t>(dimensions.width)*dimensions.height*4U;
    std::size_t cachedBytes = 0;
    for (const auto& candidate : backing.pages)
      if (candidate.pixels) cachedBytes += candidate.pixels->rgba.capacity();
    while (cachedBytes > pageCacheBudget - requestedBytes) {
      PreparedBacking::Page* oldest = nullptr;
      for (auto& candidate : backing.pages)
        if (&candidate != &page && candidate.pixels &&
            (!oldest || candidate.lastCpuUse < oldest->lastCpuUse)) oldest = &candidate;
      if (!oldest) return nullptr;
      cachedBytes -= oldest->pixels->rgba.capacity();
      oldest->pixels.reset();
    }
    auto pixels = decodeFile(*page.source);
    if (!pixels || pixels->width != backing.descriptor.pages[index].width ||
        pixels->height != backing.descriptor.pages[index].height) return nullptr;
    page.pixels = std::move(pixels);
  }
  page.cpuFrames = 60; page.lastCpuUse = ++backing.cpuClock;
  return &*page.pixels;
}

std::optional<ImageInfo> ImageStore::preparedPage(Slot& slot, std::size_t index, bool premultiplied) {
  auto& backing = *slot.prepared;
  auto& page = backing.pages[index];
  auto& texture = premultiplied ? page.premultipliedTexture : page.texture;
  if (!texture) {
    const auto* decoded = preparedPixels(backing, index);
    if (!decoded) return std::nullopt;
    const auto& pixels = *decoded;
    auto bytes = pixels.rgba;
    if (premultiplied) for (std::size_t i = 0; i < bytes.size(); i += 4)
      for (std::size_t channel = 0; channel < 3; ++channel)
        bytes[i + channel] = static_cast<std::uint8_t>((bytes[i + channel] * bytes[i + 3] + 127) / 255);
    if (!page.channels) page.channels = grayscaleChannels(pixels);
    texture = uploadTexture(pixels.width, pixels.height, bytes.data(), page.channels);
    if (!texture) return std::nullopt;
    const auto uploaded = static_cast<std::size_t>(pixels.width) * pixels.height * page.channels;
    ++textureCreates_; ++textureEpoch_; textureUploadBytes_ += uploaded;
    backing.gpuBytes += uploaded; gpuBytes_ += uploaded; peakGpuBytes_ = std::max(peakGpuBytes_, gpuBytes_);
  }
  const auto& dimensions = backing.descriptor.pages[index];
  return ImageInfo{0, dimensions.width, dimensions.height, texture, premultiplied, false};
}

std::optional<SpriteImageRegion> ImageStore::resolveSpriteRegion(ImageHandle handle,
    float x, float y, float width, float height, bool premultiplied) {
  auto info = inspect(handle);
  if (!info || width <= 0 || height <= 0 || !std::isfinite(x) || !std::isfinite(y) ||
      !std::isfinite(width) || !std::isfinite(height) || x < 0 || y < 0 ||
      x + width > info->width || y + height > info->height) return std::nullopt;
  auto& slot = slots_[(handle & indexMask) - 1U];
  if (slot.tiles) return resolveTileRegion(slot, x, y, width, height, premultiplied);
  if (!slot.prepared) return std::nullopt;
  auto& backing = *slot.prepared;
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
    if (zero && cell.crop[2] && cell.crop[3]) {
      auto physical = preparedPage(slot, cell.page, premultiplied);
      if (!physical) return std::nullopt;
      ++preparedRegions_;
      return SpriteImageRegion{*physical,
        {static_cast<float>(r[0] + cell.crop[0]), static_cast<float>(r[1] + cell.crop[1]),
         static_cast<float>(cell.crop[2]), static_cast<float>(cell.crop[3])},
        {static_cast<float>(cell.atlas[0]), static_cast<float>(cell.atlas[1]),
         static_cast<float>(cell.atlas[2]), static_cast<float>(cell.atlas[3])}, info->width, info->height, backing.descriptor.halo};
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

bool ImageStore::materialize(Slot& slot, bool premultiplied) {
  auto& texture = premultiplied && !slot.premultiplied ? slot.premultipliedTexture : slot.texture;
  premultiplied = premultiplied || slot.premultiplied;
  if (texture) return true;
  if (!slot.prepared && !slot.tiles) return false;
  const auto extent = checkedImageExtent(slot.width, slot.height, 8192, 128U * 1024U * 1024U);
  GLint maxTexture = 0; glGetIntegerv(GL_MAX_TEXTURE_SIZE, &maxTexture);
  if (!extent || slot.width > maxTexture || slot.height > maxTexture) {
    ++preparedFallbacks_["full-texture-limit"]; return false;
  }
  std::size_t slotIndex = 0; while (slotIndex < slots_.size() && &slots_[slotIndex] != &slot) ++slotIndex;
  const auto handle = makeHandle(slotIndex, slot.generation);
  while (glGetError() != GL_NO_ERROR) {}
  glGenTextures(1, &texture); glBindTexture(GL_TEXTURE_2D, texture);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
  const auto preparePixels = [premultiplied](ImagePixels& pixels) {
    if (premultiplied) for (std::size_t i = 0; i < pixels.rgba.size(); i += 4)
      for (std::size_t c = 0; c < 3; ++c)
        pixels.rgba[i+c] = static_cast<std::uint8_t>((pixels.rgba[i+c] * pixels.rgba[i+3] + 127) / 255);
  };
  bool ok = texture != 0;
  if (checkedImageExtent(slot.width, slot.height)) {
    auto pixels = readPixelsRegion(handle, 0, 0, slot.width, slot.height);
    ok = ok && pixels.has_value();
    if (ok) {
      slot.channels = grayscaleChannels(*pixels);
      preparePixels(*pixels);
      texture = uploadTexture(slot.width, slot.height, pixels->rgba.data(), slot.channels, texture);
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
  ++textureEpoch_; ++textureCreates_;
  if (slot.tiles) { if (tileDiagnostics_) ++tileMaterializations_; } else ++preparedMaterializations_;
  const auto bytes = static_cast<std::size_t>(slot.width) * slot.height * slot.channels;
  textureUploadBytes_ += bytes;
  gpuBytes_ += bytes; peakGpuBytes_ = std::max(peakGpuBytes_, gpuBytes_);
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
  if (hasTileBacking(handle)) { if (tileDiagnostics_) ++tileFallbacks_[reason]; }
  else if (hasPreparedBacking(handle)) ++preparedFallbacks_[reason];
}

std::optional<ImageInfo> ImageStore::lookup(ImageHandle handle) const {
  auto info = inspect(handle);
  if (!info || info->texture || (!slots_[(handle & indexMask)-1U].prepared && !slots_[(handle & indexMask)-1U].tiles)) return info;
  auto& self = *const_cast<ImageStore*>(this);
  if (!self.materialize(self.slots_[(handle & indexMask)-1U], false)) return std::nullopt;
  return inspect(handle);
}

}  // namespace pmjs
