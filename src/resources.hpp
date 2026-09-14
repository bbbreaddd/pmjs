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
  std::uint32_t pins = 0;
  std::size_t gpuBytes = 0;
  std::size_t cpuBytes = 0;
  std::uint64_t lastUsedSerial = 0;
  bool warm = false;
  std::string path;
};

class ImageStore {
 public:
  static constexpr std::size_t defaultWarmBudgetBytes = 4U * 1024U * 1024U;

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
  bool pin(ImageHandle handle);
  bool unpin(ImageHandle handle);
  bool touch(ImageHandle handle);
  bool beginUse(ImageHandle handle);
  bool endUse(ImageHandle handle);
  void update();
  std::optional<ImageInfo> lookup(ImageHandle handle) const;
  ImageHandle fallbackHandle();
  std::optional<ImageInfo> acquireFallback();
  std::uint64_t fallbackUses() const { return fallbackUses_; }
  std::size_t fallbackReferences() const;
  std::size_t liveCount() const { return liveCount_; }
  std::size_t gpuBytes() const { return gpuBytes_; }
  std::size_t peakGpuBytes() const { return peakGpuBytes_; }
  std::size_t cpuBytes() const;
  void setWarmBudgetBytes(std::size_t bytes) { warmBudgetBytes_ = bytes; }
  std::size_t warmBudgetBytes() const { return warmBudgetBytes_; }
  std::size_t warmBytes() const;
  std::size_t warmCount() const;
  std::size_t pinnedBytes() const;
  std::size_t pinnedCount() const;
  std::uint64_t cacheHits() const { return cacheHits_; }
  std::uint64_t warmHits() const { return warmHits_; }
  std::uint64_t budgetEvictions() const { return budgetEvictions_; }
  std::uint64_t textureCreates() const { return textureCreates_; }
  std::uint64_t textureFullUpdates() const { return textureFullUpdates_; }
  std::uint64_t textureRegionUpdates() const { return textureRegionUpdates_; }
  std::uint64_t textureUploadBytes() const { return textureUploadBytes_; }
  std::vector<ImageMemoryEntry> memoryEntries() const;

 private:
  struct Slot {
    std::uint16_t generation = 1;
    std::uint32_t texture = 0;
    int width = 0;
    int height = 0;
    std::uint32_t references = 0;
    std::atomic<std::uint32_t> inFlight{0};
    std::uint32_t pins = 0;
    std::uint64_t lastUsedSerial = 0;
    mutable std::uint16_t cpuPixelFrames = 0;
    // Atlas CPU pixels are retained for the lifetime of the slot so blt()
    // never pays a second disk open + PNG decode. Freed only in destroySlot
    // alongside the GPU texture.
    bool retainCpuPixels = false;
    std::string cacheKey;
    mutable std::optional<ImagePixels> cachedPixels;
    bool live = false;
  };

  static ImageHandle makeHandle(std::size_t index, std::uint16_t generation);
  void markUsed(Slot& slot);
  static std::size_t residentBytes(const Slot& slot);
  void destroySlot(std::size_t index);
  std::deque<Slot> slots_;
  std::unordered_map<std::string, ImageHandle> pathCache_;
  std::size_t liveCount_ = 0;
  std::size_t gpuBytes_ = 0;
  std::size_t peakGpuBytes_ = 0;
  std::size_t warmBudgetBytes_ = defaultWarmBudgetBytes;
  std::uint64_t useSerial_ = 0;
  std::uint64_t cacheHits_ = 0;
  std::uint64_t warmHits_ = 0;
  std::uint64_t budgetEvictions_ = 0;
  std::uint64_t textureCreates_ = 0;
  std::uint64_t textureFullUpdates_ = 0;
  std::uint64_t textureRegionUpdates_ = 0;
  std::uint64_t textureUploadBytes_ = 0;
  ImageHandle fallbackHandle_ = 0;
  std::uint64_t fallbackUses_ = 0;
};

}  // namespace pmjs
