#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace pmjs {

using ImageHandle = std::uint32_t;
constexpr std::uint32_t canvasHandleTag = 0x80000000U;

struct ImageInfo {
  ImageHandle handle = 0;
  int width = 0;
  int height = 0;
  std::uint32_t texture = 0;
};

struct ImagePixels {
  int width = 0;
  int height = 0;
  std::vector<std::uint8_t> rgba;
};

struct ImageMemoryEntry {
  ImageHandle handle = 0;
  int width = 0;
  int height = 0;
  std::uint32_t references = 0;
  std::uint32_t inFlight = 0;
  std::size_t gpuBytes = 0;
  std::size_t cpuBytes = 0;
  std::string path;
};

class ImageStore {
 public:
  ImageStore() = default;
  ~ImageStore();

  ImageStore(const ImageStore&) = delete;
  ImageStore& operator=(const ImageStore&) = delete;

  static std::optional<ImagePixels> decodeFile(const std::filesystem::path& path);
  static std::optional<ImagePixels> decodeMemory(const void* data, std::size_t size);
  static std::optional<ImagePixels> decodePngFromMemory(const void* data, std::size_t size);
  static std::optional<ImagePixels> decodeJpegFromMemory(const void* data, std::size_t size);
  std::optional<ImageInfo> acquireCached(const std::filesystem::path& path);
  std::optional<ImageInfo> loadPng(const std::filesystem::path& path,
                                   bool retainCpuPixels = false);
  std::optional<ImageInfo> installDecoded(const std::filesystem::path& path,
                                          ImagePixels pixels,
                                          bool retainCpuPixels = false);
  std::optional<ImageInfo> createRgba(int width, int height, const void* pixels);
  const ImagePixels* readPixels(ImageHandle handle) const;
  bool updateRgba(ImageHandle handle, const void* pixels);
  bool updateRgbaRegion(ImageHandle handle, int x, int y, int width, int height,
                        const void* pixels, int sourceRowPixels);
  bool retainCpuPixels(ImageHandle handle);
  bool retain(ImageHandle handle);
  bool release(ImageHandle handle);
  bool beginUse(ImageHandle handle);
  bool endUse(ImageHandle handle);
  void update();
  std::optional<ImageInfo> lookup(ImageHandle handle) const;
  std::size_t liveCount() const { return liveCount_; }
  std::size_t gpuBytes() const { return gpuBytes_; }
  std::size_t peakGpuBytes() const { return peakGpuBytes_; }
  std::size_t cpuBytes() const;
  std::vector<ImageMemoryEntry> memoryEntries() const;

 private:
  struct Slot {
    std::uint16_t generation = 1;
    std::uint32_t texture = 0;
    int width = 0;
    int height = 0;
    std::uint32_t references = 0;
    std::atomic<std::uint32_t> inFlight{0};
    std::uint8_t unreferencedFrames = 0;
    mutable std::uint16_t cpuPixelFrames = 0;
    // Atlas CPU pixels are retained for the lifetime of the slot so blt()
    // never pays a second disk open + PNG decode after a grace timer expires.
    // Freed only in destroySlot alongside the GPU texture.
    bool retainCpuPixels = false;
    std::string cacheKey;
    mutable std::optional<ImagePixels> cachedPixels;
    bool live = false;
  };

  static ImageHandle makeHandle(std::size_t index, std::uint16_t generation);
  void destroySlot(std::size_t index);
  std::deque<Slot> slots_;
  std::unordered_map<std::string, ImageHandle> pathCache_;
  std::size_t liveCount_ = 0;
  std::size_t gpuBytes_ = 0;
  std::size_t peakGpuBytes_ = 0;
};

}  // namespace pmjs
