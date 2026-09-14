#include "resources.hpp"
#include "checked_bounds.hpp"

#include <algorithm>
#include <array>
#include <cstdio>
#include <cstdlib>
#include <fstream>
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

std::optional<ImagePixels> decodeImage(const std::filesystem::path& path) {
  try {
    std::ifstream file(path, std::ios::binary | std::ios::ate);
    if (!file.is_open()) return std::nullopt;
    const auto size = file.tellg();
    constexpr std::streamoff kMaxImageFileSize = 64 * 1024 * 1024;
    if (size <= 0 || size > kMaxImageFileSize) return std::nullopt;
    file.seekg(0, std::ios::beg);
    std::vector<std::uint8_t> buffer(static_cast<std::size_t>(size));
    if (!file.read(reinterpret_cast<char*>(buffer.data()), size)) return std::nullopt;
    return decodeMemory(buffer.data(), buffer.size());
  } catch (...) {
    return std::nullopt;
  }
}
}

ImageStore::~ImageStore() {
  for (auto& slot : slots_) {
    if (slot.live) glDeleteTextures(1, &slot.texture);
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

std::optional<ImagePixels> ImageStore::decodeFile(
    const std::filesystem::path& path) {
  return decodeImage(path);
}

std::optional<ImageInfo> ImageStore::loadPng(const std::filesystem::path& path,
                                             bool retainCpuPixels) {
  if (auto cached = acquireCached(path)) {
    if (retainCpuPixels) this->retainCpuPixels(cached->handle);
    return cached;
  }
  auto pixels = decodeImage(path);
  if (!pixels) return std::nullopt;
  return installDecoded(path, std::move(*pixels), retainCpuPixels);
}

std::optional<ImageInfo> ImageStore::installDecoded(
    const std::filesystem::path& path, ImagePixels pixels,
    bool retainCpuPixels) {
  if (auto cached = acquireCached(path)) {
    if (retainCpuPixels) this->retainCpuPixels(cached->handle);
    return cached;
  }
  const std::string cacheKey = std::filesystem::weakly_canonical(path).generic_string();

  auto created = createRgba(pixels.width, pixels.height, pixels.rgba.data());
  if (!created) return std::nullopt;
  const std::size_t index = (created->handle & indexMask) - 1U;
  slots_[index].cacheKey = cacheKey;
  slots_[index].retainCpuPixels = retainCpuPixels;
  if (retainCpuPixels) {
    slots_[index].cachedPixels = std::move(pixels);
    slots_[index].cpuPixelFrames = 0;
  }
  pathCache_.emplace(cacheKey, created->handle);
  return created;
}

std::optional<ImageInfo> ImageStore::installDecodedMemory(
    ImagePixels pixels, bool retainCpuPixels) {
  auto created = createRgba(pixels.width, pixels.height, pixels.rgba.data());
  if (!created) return std::nullopt;
  const std::size_t index = (created->handle & indexMask) - 1U;
  slots_[index].retainCpuPixels = retainCpuPixels;
  if (retainCpuPixels) {
    slots_[index].cachedPixels = std::move(pixels);
    slots_[index].cpuPixelFrames = 0;
  }
  return created;
}

bool ImageStore::retainCpuPixels(ImageHandle handle) {
  const auto info = lookup(handle);
  if (!info) return false;
  const std::size_t index = (handle & indexMask) - 1U;
  auto& slot = slots_[index];
  if (slot.cacheKey.empty()) return false;
  if (!slot.cachedPixels) slot.cachedPixels = decodeImage(slot.cacheKey);
  if (!slot.cachedPixels) return false;
  slot.retainCpuPixels = true;
  slot.cpuPixelFrames = 0;
  return true;
}

std::optional<ImageInfo> ImageStore::acquireCached(
    const std::filesystem::path& path) {
  const std::string cacheKey = std::filesystem::weakly_canonical(path).generic_string();
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
  if (slot.cacheKey.empty()) return nullptr;
  if (slot.retainCpuPixels) {
    if (!slot.cachedPixels) slot.cachedPixels = decodeImage(slot.cacheKey);
    return slot.cachedPixels ? &*slot.cachedPixels : nullptr;
  }
  if (!slot.cachedPixels) slot.cachedPixels = decodeImage(slot.cacheKey);
  slot.cpuPixelFrames = 60;
  return slot.cachedPixels ? &*slot.cachedPixels : nullptr;
}

std::optional<ImageInfo> ImageStore::createRgba(int width, int height,
                                                 const void* pixels) {
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
  slot.cachedPixels.reset();
  slot.live = true;
  ++liveCount_;
  gpuBytes_ += extent->rgbaBytes;
  peakGpuBytes_ = std::max(peakGpuBytes_, gpuBytes_);
  return ImageInfo{makeHandle(index, slot.generation), width, height, texture};
}

std::optional<ImageInfo> ImageStore::createRenderTarget(int width, int height) {
  return createRgba(width, height, nullptr);
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
      static_cast<std::size_t>(slot.height) * 4U +
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
      static_cast<std::size_t>(slot.width) * slot.height * 4U,
      slot.cachedPixels ? slot.cachedPixels->rgba.capacity() : 0U,
      slot.lastUsedSerial,
      slot.references == 0 && slot.pins == 0 &&
        slot.inFlight.load(std::memory_order_acquire) == 0 &&
        !slot.cacheKey.empty(),
      slot.cacheKey});
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
  return ImageInfo{handle, slot.width, slot.height, slot.texture};
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
