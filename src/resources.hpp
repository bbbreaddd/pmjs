#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <memory>
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
  bool premultiplied = false;
  bool knownAllZero = false;
};

struct ImagePixels {
  int width = 0;
  int height = 0;
  std::vector<std::uint8_t> rgba;
};

struct PreparedImageCell {
  std::array<int, 4> rect{}, crop{}, atlas{};
  std::array<std::uint8_t, 4> fill{};
  int page = -1;
};

struct PreparedImagePage {
  std::filesystem::path path;
  int width = 0, height = 0;
};

struct PreparedImageDescriptor {
  int version = 1, width = 0, height = 0, halo = 1;
  std::optional<std::array<std::uint8_t, 4>> uniform;
  std::vector<PreparedImageCell> cells;
  std::vector<PreparedImagePage> pages;
};

struct SpriteImageRegion {
  ImageInfo image;
  std::array<float, 4> source{}, atlas{};
  int logicalWidth = 0, logicalHeight = 0, halo = 0;
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

class ImageFileSource {
 public:
  ~ImageFileSource();
  const std::string& key() const { return key_; }
  const std::filesystem::path& path() const { return path_; }
  ImageFileSource(const ImageFileSource&) = delete;
  ImageFileSource& operator=(const ImageFileSource&) = delete;

 private:
  friend class ImageStore;
  ImageFileSource() = default;
  int descriptor_ = -1;
  std::size_t size_ = 0;
  std::int64_t modifiedSeconds_ = 0;
  std::int64_t modifiedNanoseconds_ = 0;
  std::filesystem::path path_;
  std::string key_;
};

class ImageStore {
 public:
  static constexpr std::size_t defaultWarmBudgetBytes = 4U * 1024U * 1024U;

  ImageStore() = default;
  ~ImageStore();

  ImageStore(const ImageStore&) = delete;
  ImageStore& operator=(const ImageStore&) = delete;

  // Opening captures the file identity before async work; atomic replacement
  // cannot redirect an in-flight load to a different inode.
  static std::unique_ptr<ImageFileSource> openFile(const std::filesystem::path& path);
  static std::optional<ImagePixels> decodeFile(const ImageFileSource& source);
  static std::optional<ImagePixels> decodeMemory(const void* data, std::size_t size);
  static std::optional<ImagePixels> decodePngFromMemory(const void* data, std::size_t size);
  static std::optional<ImagePixels> decodeJpegFromMemory(const void* data, std::size_t size);
  void clearPreparedIndex() { preparedSources_.clear(); }
  bool installPrepared(const std::filesystem::path& sourcePath,
                       const std::filesystem::path& directory,
                       PreparedImageDescriptor descriptor,
                       const std::string& expectedSourceIdentity = {});
  std::optional<ImageInfo> acquirePrepared(const ImageFileSource& source,
                                          bool retainCpuPixels = false);
  struct PreparedLoad;
  std::shared_ptr<PreparedLoad> capturePrepared(const ImageFileSource& source) const;
  static bool validatePrepared(PreparedLoad& load, bool retainCpuPixels = false);
  std::optional<ImageInfo> installPreparedLoad(const ImageFileSource& source,
      std::shared_ptr<PreparedLoad> load, bool retainCpuPixels);
  std::optional<ImageInfo> inspect(ImageHandle handle) const;
  bool hasCpuPixels(ImageHandle handle) const;
  std::optional<SpriteImageRegion> resolveSpriteRegion(
      ImageHandle handle, float x, float y, float width, float height,
      bool premultiplied = true);
  std::optional<ImagePixels> readPixelsRegion(ImageHandle handle,
                                            int x, int y, int width, int height) const;
  std::optional<ImageInfo> acquireCached(const ImageFileSource& source);
  std::optional<ImageInfo> loadPng(const std::filesystem::path& path,
                                   bool retainCpuPixels = false);
  std::optional<ImageInfo> installDecoded(const ImageFileSource& source,
                                          ImagePixels pixels,
                                          bool retainCpuPixels = false);
  std::optional<ImageInfo> installDecodedMemory(ImagePixels pixels,
                                                bool retainCpuPixels = false);
  std::optional<ImageInfo> createRgba(int width, int height, const void* pixels, bool premultiplied = false);
  // GPU-only image storage. readPixels() intentionally returns no CPU copy.
  std::optional<ImageInfo> createRenderTarget(int width, int height,
                                             bool premultiplied = false);
  bool isRenderTarget(ImageHandle handle) const;
  std::uint64_t textureEpoch() const { return textureEpoch_; }
  bool ensureMipmaps(ImageHandle handle, bool premultiplied);
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
  // Pixi samples premultiplied texels; keep the straight CPU snapshot intact.
  std::optional<ImageInfo> lookupPremultiplied(ImageHandle handle);
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
  std::uint64_t preparedHits() const { return preparedHits_; }
  std::uint64_t preparedRegions() const { return preparedRegions_; }
  std::uint64_t preparedMaterializations() const { return preparedMaterializations_; }
  std::uint64_t preparedRegionReads() const { return preparedRegionReads_; }
  const std::unordered_map<std::string, std::uint64_t>& preparedFallbacks() const { return preparedFallbacks_; }
  void notePreparedFallback(ImageHandle handle, const std::string& reason);
  bool hasPreparedBacking(ImageHandle handle) const;
  bool hasUniformPreparedBacking(ImageHandle handle) const;
  std::vector<ImageMemoryEntry> memoryEntries() const;

 private:
  struct PreparedBacking;
  struct Slot {
    std::uint16_t generation = 1;
    std::uint32_t texture = 0;
    std::shared_ptr<PreparedBacking> prepared;
    int width = 0;
    int height = 0;
    std::uint32_t references = 0;
    std::atomic<std::uint32_t> inFlight{0};
    std::uint32_t pins = 0;
    std::uint64_t lastUsedSerial = 0;
    mutable std::uint16_t cpuPixelFrames = 0;
    // Atlas CPU pixels are retained for the lifetime of the slot so blt()
    // never pays a second pixel readback. Freed only in destroySlot
    // alongside the GPU texture.
    bool gpuOnly = false;
    bool renderTarget = false;
    bool premultiplied = false;
    bool knownAllZero = false;
    std::uint32_t premultipliedTexture = 0;
    bool mipmapsReady = false, premultipliedMipmapsReady = false;
    std::size_t mipmapBytes = 0, premultipliedMipmapBytes = 0;
    bool retainCpuPixels = false;
    std::string cacheKey;
    std::filesystem::path sourcePath;
    mutable std::optional<ImagePixels> cachedPixels;
    bool live = false;
  };

  void clearPrepared(Slot& slot);
  bool materialize(Slot& slot, bool premultiplied);
  static ImagePixels* preparedPixels(PreparedBacking& backing, std::size_t page);
  static std::optional<ImagePixels> readPreparedRegion(PreparedBacking& backing,
      int x, int y, int width, int height);
  std::optional<ImageInfo> preparedPage(Slot& slot, std::size_t page, bool premultiplied);
  static ImageHandle makeHandle(std::size_t index, std::uint16_t generation);
  void markUsed(Slot& slot);
  std::size_t residentBytes(const Slot& slot) const;
  std::uint64_t textureEpoch_ = 0;
  void destroySlot(std::size_t index);
  void clearPremultipliedTexture(Slot& slot);
  std::deque<Slot> slots_;
  std::unordered_map<std::string, ImageHandle> pathCache_;
  std::unordered_map<std::string, std::shared_ptr<PreparedBacking>> preparedSources_;
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
  std::uint64_t preparedHits_ = 0, preparedRegions_ = 0, preparedMaterializations_ = 0;
  mutable std::uint64_t preparedRegionReads_ = 0;
  std::unordered_map<std::string, std::uint64_t> preparedFallbacks_;
  ImageHandle fallbackHandle_ = 0;
  std::uint64_t fallbackUses_ = 0;
};

}  // namespace pmjs
