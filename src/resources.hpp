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
#include <unordered_set>
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

struct PreparedTileRegion {
  std::array<int, 4> rect{}, atlas{};
  int page = -1;
};
struct PreparedTileSource {
  std::filesystem::path path, snapshot;
  std::string identity;
  int width = 0, height = 0;
  std::vector<PreparedTileRegion> regions;
};
struct PreparedTileSet {
  int version = 1, halo = 1;
  std::string identity;
  std::filesystem::path directory;
  std::vector<PreparedImagePage> pages;
  std::vector<PreparedTileSource> sources;
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
  std::size_t encodedBytes() const { return size_; }
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
  static constexpr std::size_t warmEntryLimit = 256;
  static constexpr std::size_t warmFileLimit = 128;

  ImageStore();
  ~ImageStore();

  ImageStore(const ImageStore&) = delete;
  ImageStore& operator=(const ImageStore&) = delete;

  // Opening captures the file identity before async work; atomic replacement
  // cannot redirect an in-flight load to a different inode.
  static std::unique_ptr<ImageFileSource> openFile(const std::filesystem::path& path);
  static std::size_t decodedStorageBytes(const ImagePixels& pixels);
  static std::optional<ImagePixels> decodeFile(const ImageFileSource& source,
      std::size_t maxDecodedBytes = 128U*1024U*1024U);
  static std::optional<ImagePixels> decodeMemory(const void* data, std::size_t size);
  static std::optional<ImagePixels> decodePngFromMemory(const void* data, std::size_t size);
  static std::optional<ImagePixels> decodeJpegFromMemory(const void* data, std::size_t size);
  bool installTileSet(PreparedTileSet descriptor,
      const std::vector<std::string>* pageIdentities = nullptr,
      const std::vector<std::string>* snapshotIdentities = nullptr,
      std::vector<std::string>* capturedPages = nullptr, std::vector<std::string>* capturedSnapshots = nullptr);
  void clearTileSetIndex();
  std::optional<ImageInfo> createTileSlot(ImageHandle handle, int width, int height);
  bool hasTileBacking(ImageHandle handle) const;
  std::string effectiveTileSet(const ImageFileSource& source, const std::string& identity) const;
  std::uint64_t tileHits() const { return tileHits_; }
  std::uint64_t tileRegions() const { return tileRegions_; }
  const std::unordered_map<std::string, std::uint64_t>& tileRegionSets() const { return tileRegionSets_; }
  std::uint64_t tileMaterializations() const { return tileMaterializations_; }
  std::uint64_t tilePageDecodes() const { return tilePageDecodes_; }
  std::uint64_t tilePageUploads() const { return tilePageUploads_; }
  const std::unordered_map<std::string, std::uint64_t>& tileFallbacks() const { return tileFallbacks_; }
  std::size_t tileMetadataBytes() const { return tileMetadataBytes_->load(std::memory_order_relaxed); }
  void noteTileLoadFallback() { if (tileDiagnostics_) ++tileFallbacks_["page-validation"]; }
  unsigned consumePreparationInvalidations() { return preparationInvalidations_.exchange(0, std::memory_order_relaxed); }
  void clearPreparedIndex() { preparedSources_.clear(); }
  bool installPrepared(const std::filesystem::path& sourcePath,
                       const std::filesystem::path& directory,
                       PreparedImageDescriptor descriptor,
                       const std::string& expectedSourceIdentity = {},
                       const std::vector<std::string>* pageIdentities = nullptr,
                       std::vector<std::string>* capturedPages = nullptr);
  std::optional<ImageInfo> acquirePrepared(const ImageFileSource& source,
                                          bool retainCpuPixels = false);
  struct PreparedLoad;
  std::shared_ptr<PreparedLoad> capturePrepared(const ImageFileSource& source,
      const std::string& tileSet = {}) const;
  static bool validatePrepared(PreparedLoad& load, bool retainCpuPixels = false);
  static std::shared_ptr<ImageFileSource> capturePreparedFallback(const PreparedLoad& load);
  std::optional<ImageInfo> installPreparedLoad(const ImageFileSource& source,
      std::shared_ptr<PreparedLoad> load, bool retainCpuPixels);
  std::optional<ImageInfo> inspect(ImageHandle handle) const;
  bool hasCpuPixels(ImageHandle handle) const;
  std::optional<SpriteImageRegion> resolveSpriteRegion(
      ImageHandle handle, float x, float y, float width, float height,
      bool premultiplied = true);
  std::optional<ImagePixels> readPixelsRegion(ImageHandle handle,
                                            int x, int y, int width, int height) const;
  std::optional<ImageInfo> acquireCached(const ImageFileSource& source, const std::string& tileSet = {});
  std::optional<ImageInfo> loadPng(const std::filesystem::path& path,
                                   bool retainCpuPixels = false, const std::string& tileSet = {});
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
  std::size_t warmFileCount() const;
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
  struct TilePrototype;
  struct TileCatalog;
  struct TilePages;
  struct TileBacking;
  struct TileLoad;
  struct Slot {
    std::uint16_t generation = 1;
    std::uint32_t texture = 0;
    std::shared_ptr<PreparedBacking> prepared;
    std::shared_ptr<TileBacking> tiles;
    int width = 0;
    int height = 0;
    int channels = 4;
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

  std::shared_ptr<TileLoad> captureTileLoad(const ImageFileSource& source, const std::string& identity) const;
  static bool validateTileLoad(TileLoad& load, bool retainCpu);
  static std::shared_ptr<ImageFileSource> captureTileFallback(const TileLoad& load);
  std::optional<ImageInfo> installTileLoad(std::shared_ptr<TileLoad> load, bool retainCpu);
  std::optional<ImagePixels> readTileRegion(const Slot& slot, int x, int y, int width, int height) const;
  std::optional<SpriteImageRegion> resolveTileRegion(Slot& slot, float x, float y,
      float width, float height, bool premultiplied);
  std::size_t tileWarmBytes() const;
  void collectTileFiles(const Slot& slot, std::unordered_set<const ImageFileSource*>& files) const;
  std::optional<ImageInfo> insertTileView(std::shared_ptr<TileBacking> backing,
      int width, int height, const std::string& cacheKey);
  bool tileDiagnostics_ = false;
  std::shared_ptr<std::atomic<std::size_t>> tileMetadataBytes_ =
      std::make_shared<std::atomic<std::size_t>>(0);
  std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
  std::unordered_map<std::string, std::shared_ptr<TileCatalog>> tileSets_;
  mutable std::unordered_map<std::string, std::weak_ptr<ImageFileSource>> tileFiles_;
  std::shared_ptr<ImageFileSource> captureTileFile(const std::filesystem::path& path) const;
  std::uint64_t tileHits_ = 0, tileRegions_ = 0, tileMaterializations_ = 0;
  std::uint64_t tilePageDecodes_ = 0, tilePageUploads_ = 0;
  std::unordered_map<std::string, std::uint64_t> tileFallbacks_, tileRegionSets_;
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
  std::optional<ImageInfo> createDecoded(const ImagePixels& pixels);
  std::optional<ImageInfo> createImage(int width, int height, const void* pixels,
                                     bool premultiplied, int channels);
  bool promoteToRgba(Slot& slot, const void* replacement = nullptr);
  std::deque<Slot> slots_;
  std::unordered_map<std::string, ImageHandle> pathCache_;
  mutable std::atomic<unsigned> preparationInvalidations_{0};
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
