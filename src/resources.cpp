#include "resources.hpp"
#include "checked_bounds.hpp"

#include <algorithm>
#include <array>
#include <cstdio>
#include <cstdlib>
#include <cerrno>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <setjmp.h>
#include <vector>

#include <GLES3/gl3.h>
#include <jpeglib.h>
#include <png.h>

namespace pmjs {

namespace {
constexpr std::uint32_t indexMask = 0xffffU;
constexpr std::uint16_t generationMask = 0x7fffU;

std::optional<ImagePixels> decodePngFromMemory(const void* data, std::size_t size) {
  if (!data || size < 8) return std::nullopt;
  png_image image{};
  image.version = PNG_IMAGE_VERSION;
  if (!png_image_begin_read_from_memory(&image, data, size)) return std::nullopt;
  image.format = PNG_FORMAT_RGBA;
  const auto extent = checkedImageExtent(static_cast<int>(image.width), static_cast<int>(image.height));
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

std::optional<ImagePixels> decodeJpegFromMemory(const void* data, std::size_t size) {
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
      static_cast<int>(decoder.image_height));
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

std::optional<ImagePixels> decodeMemory(const void* data, std::size_t size) {
  if (!data || size < 4) return std::nullopt;
  const auto* bytes = static_cast<const std::uint8_t*>(data);
  if (size >= 8 && png_sig_cmp(bytes, 0, 8) == 0) {
    return decodePngFromMemory(data, size);
  }
  if (size >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff) {
    return decodeJpegFromMemory(data, size);
  }
  return std::nullopt;
}

std::optional<ImagePixels> readTexturePixels(const ImageInfo& image) {
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

ImageStore::~ImageStore() {
  for (auto& slot : slots_) {
    if (slot.live) {
      clearPremultipliedTexture(slot);
      glDeleteTextures(1, &slot.texture);
    }
  }
}

ImageHandle ImageStore::fallbackHandle() {
  if (fallbackHandle_ != 0 && lookup(fallbackHandle_)) return fallbackHandle_;
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
  return lookup(handle);
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

std::optional<ImagePixels> ImageStore::decodeFile(const ImageFileSource& source) {
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
  return decodeMemory(bytes.data(), bytes.size());
}

std::optional<ImageInfo> ImageStore::loadPng(const std::filesystem::path& path,
                                             bool retainCpuPixels) {
  auto source = openFile(path);
  if (!source) return std::nullopt;
  if (auto cached = acquireCached(*source)) {
    if (retainCpuPixels) this->retainCpuPixels(cached->handle);
    return cached;
  }
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

  auto created = createRgba(pixels.width, pixels.height, pixels.rgba.data());
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
  auto created = createRgba(pixels.width, pixels.height, pixels.rgba.data());
  if (!created) return std::nullopt;
  const std::size_t index = (created->handle & indexMask) - 1U;
  // Memory images have no path to decode again after their load bytes are gone.
  slots_[index].retainCpuPixels = true;
  slots_[index].cachedPixels = std::move(pixels);
  slots_[index].cpuPixelFrames = 0;
  return created;
}

bool ImageStore::retainCpuPixels(ImageHandle handle) {
  const auto info = lookup(handle);
  if (!info) return false;
  const std::size_t index = (handle & indexMask) - 1U;
  auto& slot = slots_[index];
  if (slot.cachedPixels) {
    slot.retainCpuPixels = true;
    slot.cpuPixelFrames = 0;
    return true;
  }
  if (slot.cacheKey.empty()) return false;
  slot.cachedPixels = readTexturePixels(*info);
  if (!slot.cachedPixels) return false;
  slot.retainCpuPixels = true;
  slot.cpuPixelFrames = 0;
  return true;
}

std::optional<ImageInfo> ImageStore::acquireCached(
    const ImageFileSource& source) {
  const std::string& cacheKey = source.key();
  const auto cached = pathCache_.find(cacheKey);
  if (cached != pathCache_.end()) {
    const auto info = lookup(cached->second);
    if (info) {
      const std::size_t index = (cached->second & indexMask) - 1U;
      const bool wasWarm = slots_[index].references == 0 &&
        slots_[index].pins == 0 &&
        slots_[index].inFlight.load(std::memory_order_acquire) == 0;
      ++slots_[index].references;
      markUsed(slots_[index]);
      ++cacheHits_;
      if (wasWarm) ++warmHits_;
      return info;
    }
    pathCache_.erase(cached);
  }
  return std::nullopt;
}

const ImagePixels* ImageStore::readPixels(ImageHandle handle) const {
  const std::uint32_t encodedIndex = handle & indexMask;
  const auto info = lookup(handle);
  if (!info || encodedIndex == 0) return nullptr;
  const auto& slot = slots_[encodedIndex - 1U];
  if (slot.cachedPixels) {
    if (!slot.retainCpuPixels && !slot.cacheKey.empty()) slot.cpuPixelFrames = 60;
    return &*slot.cachedPixels;
  }
  if (slot.cacheKey.empty()) return nullptr;
  slot.cachedPixels = readTexturePixels(*info);
  if (!slot.retainCpuPixels) slot.cpuPixelFrames = 60;
  return slot.cachedPixels ? &*slot.cachedPixels : nullptr;
}

std::optional<ImageInfo> ImageStore::createRgba(int width, int height,
                                                 const void* pixels, bool premultiplied) {
  const auto extent = checkedImageExtent(width, height);
  if (!extent) return std::nullopt;
  GLuint texture = 0;
  while (glGetError() != GL_NO_ERROR) {}
  glGenTextures(1, &texture);
  glBindTexture(GL_TEXTURE_2D, texture);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, width, height, 0, GL_RGBA,
               GL_UNSIGNED_BYTE, pixels);
  if (texture == 0 || glGetError() != GL_NO_ERROR) {
    if (texture) glDeleteTextures(1, &texture);
    return std::nullopt;
  }
  ++textureCreates_;
  if (pixels) {
    textureUploadBytes_ += static_cast<std::uint64_t>(width) *
        static_cast<std::uint64_t>(height) * 4U;
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
  slot.width = width;
  slot.height = height;
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
  slot.live = true;
  ++liveCount_;
  gpuBytes_ += extent->rgbaBytes;
  peakGpuBytes_ = std::max(peakGpuBytes_, gpuBytes_);
  return ImageInfo{makeHandle(index, slot.generation), width, height, texture, premultiplied};
}

std::optional<ImageInfo> ImageStore::createRenderTarget(int width, int height) {
  auto image = createRgba(width, height, nullptr);
  if (image) slots_[(image->handle & indexMask) - 1U].renderTarget = true;
  return image;
}

std::size_t ImageStore::cpuBytes() const {
  std::size_t result = 0;
  for (const auto& slot : slots_) {
    if (slot.live && slot.cachedPixels) result += slot.cachedPixels->rgba.capacity();
  }
  return result;
}

std::size_t ImageStore::residentBytes(const Slot& slot) {
  return static_cast<std::size_t>(slot.width) *
      static_cast<std::size_t>(slot.height) * 4U *
      (slot.premultipliedTexture && slot.premultipliedTexture != slot.texture ? 2U : 1U) +
      (slot.cachedPixels ? slot.cachedPixels->rgba.capacity() : 0U);
}

std::size_t ImageStore::warmBytes() const {
  std::size_t result = 0;
  for (const auto& slot : slots_) {
    if (slot.live && slot.references == 0 && slot.pins == 0 &&
        slot.inFlight.load(std::memory_order_acquire) == 0 &&
        !slot.cacheKey.empty()) result += residentBytes(slot);
  }
  return result;
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
      static_cast<std::size_t>(slot.width) * slot.height * 4U *
        (slot.premultipliedTexture && slot.premultipliedTexture != slot.texture ? 2U : 1U),
      slot.cachedPixels ? slot.cachedPixels->rgba.capacity() : 0U,
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
  while (glGetError() != GL_NO_ERROR) {}
  glBindTexture(GL_TEXTURE_2D, info->texture);
  glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
  glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, info->width, info->height,
                  GL_RGBA, GL_UNSIGNED_BYTE, pixels);
  const bool ok = glGetError() == GL_NO_ERROR;
  if (ok) {
    clearPremultipliedTexture(slots_[(handle & indexMask) - 1U]);
    ++textureFullUpdates_;
    textureUploadBytes_ += static_cast<std::uint64_t>(info->width) *
        static_cast<std::uint64_t>(info->height) * 4U;
  }
  return ok;
}

bool ImageStore::updateRgbaRegion(ImageHandle handle, int x, int y, int width,
                                  int height, const void* pixels,
                                  int sourceRowPixels) {
  const auto info = lookup(handle);
  if (!info || !pixels || x < 0 || y < 0 || width <= 0 || height <= 0 ||
      x + width > info->width || y + height > info->height ||
      sourceRowPixels < width) return false;
  while (glGetError() != GL_NO_ERROR) {}
  glBindTexture(GL_TEXTURE_2D, info->texture);
  glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
  glPixelStorei(GL_UNPACK_ROW_LENGTH, sourceRowPixels);
  glTexSubImage2D(GL_TEXTURE_2D, 0, x, y, width, height, GL_RGBA,
                  GL_UNSIGNED_BYTE, pixels);
  glPixelStorei(GL_UNPACK_ROW_LENGTH, 0);
  const bool ok = glGetError() == GL_NO_ERROR;
  if (ok) {
    clearPremultipliedTexture(slots_[(handle & indexMask) - 1U]);
    ++textureRegionUpdates_;
    textureUploadBytes_ += static_cast<std::uint64_t>(width) *
        static_cast<std::uint64_t>(height) * 4U;
  }
  return ok;
}

ImageHandle ImageStore::makeHandle(std::size_t index, std::uint16_t generation) {
  return (static_cast<std::uint32_t>(generation & generationMask) << 16U) |
         static_cast<std::uint32_t>(index + 1U);
}

std::optional<ImageInfo> ImageStore::lookup(ImageHandle handle) const {
  if ((handle & canvasHandleTag) != 0) return std::nullopt;
  const std::uint32_t encodedIndex = handle & indexMask;
  if (encodedIndex == 0) return std::nullopt;
  const std::size_t index = encodedIndex - 1U;
  const auto generation = static_cast<std::uint16_t>(handle >> 16U);
  if (index >= slots_.size()) return std::nullopt;
  const auto& slot = slots_[index];
  if (!slot.live || slot.generation != generation) return std::nullopt;
  return ImageInfo{handle, slot.width, slot.height, slot.texture, slot.premultiplied};
}

bool ImageStore::isRenderTarget(ImageHandle handle) const {
  if (!lookup(handle)) return false;
  return slots_[(handle & indexMask) - 1U].renderTarget;
}

std::optional<ImageInfo> ImageStore::lookupPremultiplied(ImageHandle handle) {
  auto info = lookup(handle);
  if (!info || info->premultiplied) return info;
  auto& slot = slots_[(handle & indexMask) - 1U];
  // Render targets are already framebuffer pixels, not decoded straight images.
  if (slot.gpuOnly) return info;
  if (!slot.premultipliedTexture) {
    auto pixels = readTexturePixels(*info);
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
      while (glGetError() != GL_NO_ERROR) {}
      GLuint texture = 0;
      glGenTextures(1, &texture);
      glBindTexture(GL_TEXTURE_2D, texture);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
      glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
      glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
      glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, info->width, info->height, 0,
        GL_RGBA, GL_UNSIGNED_BYTE, pixels->rgba.data());
      if (!texture || glGetError() != GL_NO_ERROR) {
        if (texture) glDeleteTextures(1, &texture);
        return std::nullopt;
      }
      slot.premultipliedTexture = texture;
      ++textureCreates_;
      textureUploadBytes_ += pixels->rgba.size();
      gpuBytes_ += pixels->rgba.size();
      peakGpuBytes_ = std::max(peakGpuBytes_, gpuBytes_);
    }
  }
  info->texture = slot.premultipliedTexture;
  info->premultiplied = true;
  return info;
}

void ImageStore::clearPremultipliedTexture(Slot& slot) {
  if (slot.premultipliedTexture && slot.premultipliedTexture != slot.texture) {
    glDeleteTextures(1, &slot.premultipliedTexture);
    gpuBytes_ -= static_cast<std::size_t>(slot.width) * slot.height * 4U;
  }
  slot.premultipliedTexture = 0;
}

bool ImageStore::retain(ImageHandle handle) {
  if (!lookup(handle)) return false;
  const std::size_t index = (handle & indexMask) - 1U;
  ++slots_[index].references;
  markUsed(slots_[index]);
  return true;
}

void ImageStore::markUsed(Slot& slot) {
  slot.lastUsedSerial = ++useSerial_;
}

bool ImageStore::pin(ImageHandle handle) {
  if (!lookup(handle)) return false;
  auto& slot = slots_[(handle & indexMask) - 1U];
  ++slot.pins;
  markUsed(slot);
  return true;
}

bool ImageStore::unpin(ImageHandle handle) {
  if (!lookup(handle)) return false;
  const std::size_t index = (handle & indexMask) - 1U;
  auto& slot = slots_[index];
  if (slot.pins == 0) return false;
  --slot.pins;
  if (slot.pins == 0 && slot.references == 0 && slot.cacheKey.empty() &&
      slot.inFlight.load(std::memory_order_acquire) == 0) destroySlot(index);
  return true;
}

bool ImageStore::touch(ImageHandle handle) {
  if (!lookup(handle)) return false;
  markUsed(slots_[(handle & indexMask) - 1U]);
  return true;
}

void ImageStore::destroySlot(std::size_t index) {
  auto& slot = slots_[index];
  clearPremultipliedTexture(slot);
  if (!slot.cacheKey.empty()) pathCache_.erase(slot.cacheKey);
  glDeleteTextures(1, &slot.texture);
  gpuBytes_ -= static_cast<std::size_t>(slot.width) *
               static_cast<std::size_t>(slot.height) * 4U;
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
  slot.live = false;
  slot.generation = static_cast<std::uint16_t>((slot.generation + 1U) & generationMask);
  if (slot.generation == 0) slot.generation = 1;
  --liveCount_;
}

bool ImageStore::release(ImageHandle handle) {
  const auto info = lookup(handle);
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
  if (!lookup(handle)) return false;
  const std::size_t index = (handle & indexMask) - 1U;
  slots_[index].inFlight.fetch_add(1, std::memory_order_acq_rel);
  return true;
}

bool ImageStore::endUse(ImageHandle handle) {
  if (!lookup(handle)) return false;
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
  if (currentWarmBytes <= warmBudgetBytes_) return;
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
    if (currentWarmBytes <= warmBudgetBytes_) break;
    const std::size_t index = entry.second;
    auto& slot = slots_[index];
    if (!slot.live || slot.references != 0 || slot.pins != 0 ||
        slot.cacheKey.empty() ||
        slot.inFlight.load(std::memory_order_acquire) != 0) continue;
    currentWarmBytes -= residentBytes(slot);
    destroySlot(index);
    ++budgetEvictions_;
  }
}

}  // namespace pmjs
