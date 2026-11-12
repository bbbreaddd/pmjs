#pragma once

#include "program_binary_cache.hpp"

#include "image_storage.hpp"
#include "memory_accounting.hpp"

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace pmjs {

using ImageEncryptionKey = std::array<std::uint8_t, 16>;
ImageEncryptionKey imageEncryptionKey(const std::string& hex);

struct SparsePalettePage;

struct PreparationFailures {
  std::mutex mutex;
  std::unordered_set<std::string> sources;
  void record(const std::string& source) { const std::lock_guard lock(mutex); sources.insert(source); }
  std::vector<std::string> consume() {
    const std::lock_guard lock(mutex);
    std::vector<std::string> result(sources.begin(), sources.end()); sources.clear(); return result;
  }
};

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

// A deferred reader keeps its crop alive at the revision it observed. Pixel
// storage is captured only if the image changes before the reader executes.
struct ImagePixelSnapshot {
  int x = 0, y = 0, width = 0, height = 0;
  bool premultiplied = false;
  std::optional<ImagePixels> pixels;
  void setPixels(std::optional<ImagePixels> value);
  void trackPixels(const std::shared_ptr<MemoryCharge>& charge,
                   const std::shared_ptr<MemoryLedger>& ledger);
 private:
  std::vector<std::weak_ptr<MemoryCharge>> accounting_;
};

struct PreparedImageCell {
  std::array<int, 4> rect{}, crop{}, atlas{};
  std::array<std::uint8_t, 4> fill{};
  int page = -1;
};

struct PreparedImagePage {
  std::filesystem::path path;
  int width = 0, height = 0;
  std::optional<ImageStorageDecision> storage = std::nullopt;
};

struct PreparedImageDescriptor {
  int version = 1, width = 0, height = 0, halo = 1;
  std::optional<std::array<std::uint8_t, 4>> uniform;
  std::vector<PreparedImageCell> cells;
  std::vector<PreparedImagePage> pages;
  std::optional<std::array<int, 3>> blockGrid;
  std::optional<int> blockChannels = std::nullopt;
  std::optional<bool> compactEligible = std::nullopt;
  std::string compression;
  std::filesystem::path textureArtifact;
  bool framePages = false;
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
  // Also names the snapshot's content: snapshots are verified copies of the source.
  std::string sourceHash;
};
struct PreparedTileSet {
  int version = 1, halo = 1;
  std::string identity;
  std::filesystem::path directory;
  std::vector<PreparedImagePage> pages;
  std::vector<std::string> pageHashes;
  std::vector<PreparedTileSource> sources;
};

struct SpriteImageRegion {
  ImageInfo image;
  std::array<float, 4> source{}, atlas{};
  int logicalWidth = 0, logicalHeight = 0, halo = 0;
  std::uint32_t paletteTable = 0, paletteBlocks = 0, paletteResidual = 0;
};

struct PaletteImageRegion {
  ImageInfo image;
  std::uint32_t table = 0, blocks = 0, residual = 0;
};

struct CompactImageRegion {
  ImageInfo image;
  std::array<float, 4> contentBounds{}, fill{};
  std::array<float, 2> atlasOffset{};
  int logicalWidth = 0, logicalHeight = 0;
  std::uint32_t indexX = 0, indexY = 0, phaseX = 0, phaseY = 0;
};

struct BlockImageRegion {
  ImageInfo image;
  std::uint32_t table = 0;
  std::array<int, 3> blockGrid{};
  std::array<int, 2> tableSize{};
  int logicalWidth = 0, logicalHeight = 0;
  int planar = 0;
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
  bool sceneryBacking = false;
  bool sceneryFullMaterialized = false;
  std::string sceneryFirstMaterializationCaller;
  std::string path;
  bool astc = false;
  bool paletteSparse = false;
  bool fullTextureResident = false;
  bool palette = false;
  int paletteIndexBits = 0;
  ImageHandle sceneryParent = 0;
  std::array<int, 4> sceneryRect{};
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
  std::optional<ImageEncryptionKey> encryptionKey_;
};

class ImageStore {
 public:
  static constexpr std::size_t defaultWarmBudgetBytes = 32U * 1024U * 1024U;
  static constexpr std::size_t defaultPreparedFrameCacheBytes = 32U * 1024U * 1024U;
  static constexpr std::size_t warmEntryLimit = 256;
  static constexpr std::size_t warmFileLimit = 128;
  // Bounds retained successful inode-only content verifications.
  static constexpr std::size_t tileVerificationCacheEntryLimit = 64;
  static constexpr std::size_t tileVerificationCacheByteLimit = 32U * 1024U;

  explicit ImageStore(std::filesystem::path programCacheRoot = {});
  ProgramBinaryCache& programCache() { return programCache_; }
  ~ImageStore();

  ImageStore(const ImageStore&) = delete;
  ImageStore& operator=(const ImageStore&) = delete;

  // Opening captures the file identity before async work; atomic replacement
  // cannot redirect an in-flight load to a different inode.
  static std::unique_ptr<ImageFileSource> openFile(const std::filesystem::path& path,
      std::optional<ImageEncryptionKey> encryptionKey = std::nullopt);
  static ImageStorageDecision classifyStorage(const ImagePixels& pixels);
  bool installStorageDecision(const std::filesystem::path& path,
      const std::string& sourceIdentity, ImageStorageDecision decision,
      const std::string& backingHash = {});
  void clearStorageDecisions() { storageDecisions_.clear(); }
  std::uint64_t storageDecisionHits() const { return storageDecisionHits_; }
  static std::size_t decodedStorageBytes(const ImagePixels& pixels);
  static std::optional<std::vector<std::uint8_t>> readCapturedBytes(const ImageFileSource& source);
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
  std::size_t tileVerificationCacheEntries() const;
  // Approximation including key storage, hash nodes and bucket pointers.
  std::size_t tileVerificationCacheEstimatedBytes() const;
  void noteTileLoadFallback() { if (tileDiagnostics_) ++tileFallbacks_["page-validation"]; }
  std::vector<std::string> consumePreparationFailures() { return preparationFailures_->consume(); }
  unsigned consumePreparationInvalidations() { return preparationInvalidations_->exchange(0, std::memory_order_relaxed); }
  void clearPreparedIndex() { preparedSources_.clear(); }
  bool installPrepared(const std::filesystem::path& sourcePath,
                       const std::filesystem::path& directory,
                       PreparedImageDescriptor descriptor,
                       const std::string& expectedSourceIdentity = {},
                       const std::vector<std::string>* pageIdentities = nullptr,
                       std::vector<std::string>* capturedPages = nullptr,
                       const std::string& backingHash = {},
                       const std::vector<std::string>* pageHashes = nullptr,
                       const std::string& textureHash = {});
  std::optional<ImageInfo> acquirePrepared(const ImageFileSource& source,
                                          bool retainCpuPixels = false);
  struct PreparedLoad;
  std::shared_ptr<PreparedLoad> capturePrepared(const ImageFileSource& source,
      const std::string& tileSet = {}) const;
  bool validatePrepared(PreparedLoad& load, bool retainCpuPixels = false);
  std::shared_ptr<ImageFileSource> capturePreparedFallback(const PreparedLoad& load);
  std::optional<ImagePixels> decodePreparedFallback(const PreparedLoad& load) const;
  std::optional<ImageInfo> installPreparedLoad(const ImageFileSource& source,
      std::shared_ptr<PreparedLoad> load, bool retainCpuPixels);
  std::optional<ImageInfo> inspect(ImageHandle handle) const;
  std::optional<bool> isOpaque(ImageHandle handle);
  bool hasCpuPixels(ImageHandle handle) const;
  std::optional<SpriteImageRegion> resolveSpriteRegion(
      ImageHandle handle, float x, float y, float width, float height,
      bool premultiplied = true, bool paletteOnly = false, bool sparseAllowed = false);
  std::optional<PaletteImageRegion> resolvePaletteImage(ImageHandle handle, bool premultiplied);
  bool hasPaletteStorage(ImageHandle handle) const;
  std::uint64_t sceneryWindowHits() const { return sceneryWindowHits_; }
  std::uint64_t sceneryWindowUploads() const { return sceneryWindowUploads_; }
  std::uint64_t sceneryFullFallbacks() const { return sceneryFullFallbacks_; }
  std::uint64_t sceneryScrollWindows() const { return sceneryScrollWindows_; }
  std::uint64_t sceneryScrollCopyBytes() const { return sceneryScrollCopyBytes_; }
  std::uint64_t sceneryScrollUploadBytes() const { return sceneryScrollUploadBytes_; }
  std::uint64_t sceneryScrollFallbacks() const { return sceneryScrollFallbacks_; }
  std::uint64_t sceneryWindowReadMicros() const { return sceneryWindowReadMicros_; }
  std::uint64_t sceneryWindowPremultiplyMicros() const { return sceneryWindowPremultiplyMicros_; }
  std::uint64_t sceneryWindowCreateMicros() const { return sceneryWindowCreateMicros_; }
  void noteSceneryWindowRejection(ImageHandle handle, const char* reason);
  const std::unordered_map<std::string, std::uint64_t>& sceneryWindowRejections() const {
    return sceneryWindowRejections_;
  }
  const std::unordered_map<std::string, std::uint64_t>& sceneryBackingRejections() const {
    return sceneryBackingRejections_;
  }
  // Frame textures use ordinary sampling with approximate filtering.
  std::optional<SpriteImageRegion> resolvePreparedFrameRegion(
      ImageHandle handle, float x, float y, float width, float height,
      bool premultiplied = true, bool linearPalette = false, bool cacheSource = false);
  void setPreparedFrameCacheBudget(std::size_t bytes);
  std::size_t preparedFrameCacheBudget() const { return preparedFrameBudgetBytes_; }
  std::size_t preparedFrameCacheBytes() const { return preparedFrameBytes_; }
  std::size_t preparedFrameResidentBytes() const { return preparedFrameResidentBytes_; }
  std::size_t preparedFrameEvictedBytes() const { return preparedFrameResidentBytes_ - preparedFrameBytes_; }
  std::size_t preparedFramePeakResidentBytes() const { return preparedFramePeakResidentBytes_; }
  void setCompactSamplingEnabled(bool enabled) { compactSamplingEnabled_ = enabled; }
  void setPreparedCropUploadsEnabled(bool enabled) { preparedCropUploadsEnabled_ = enabled; }
  std::uint64_t compactUploadFailures() const { return compactUploadFailures_; }
  std::uint64_t compactTextureUploads() const { return compactTextureUploads_; }
  std::uint64_t preparedCropUploads() const { return preparedCropUploads_; }
  std::uint64_t preparedCropUploadBytes() const { return preparedCropUploadBytes_; }
  std::uint64_t blockTextureUploads() const { return blockTextureUploads_; }
  std::uint64_t blockUploadFailures() const { return blockUploadFailures_; }
  std::uint64_t textureArtifactLoads() const { return textureArtifactLoads_; }
  std::uint64_t textureArtifactFailures() const { return textureArtifactFailures_; }
  std::size_t textureArtifactStagingBytes() const { return textureArtifactStagingBytes_; }
  std::uint64_t sourceTextureBuilds() const { return sourceTextureBuilds_; }
  const std::string& textureArtifactFailureReason() const { return textureArtifactFailureReason_; }
  std::uint64_t blockRegions() const { return blockRegions_; }
  std::optional<BlockImageRegion> resolveBlockRegion(ImageHandle handle,
      bool premultiplied = true);

  std::uint64_t preparedFrameCacheHits() const { return preparedFrameHits_; }
  std::vector<std::array<float,4>> preparedSpriteParts(ImageHandle handle, const std::array<float,4>& source) const;
  void trimPreparedPageTextures();
  std::size_t preparedPageTextureBytes() const;
  std::uint64_t preparedFrameConversions() const { return preparedFrameConversions_; }
  double preparedFrameConversionMs() const { return preparedFrameConversionMs_; }
  std::uint64_t preparedFrameCacheBypasses() const { return preparedFrameBypasses_; }
  std::uint64_t renderReadbacks() const { return renderReadbacks_; }
  std::uint64_t preparedFrameUploadBytes() const { return preparedFrameUploadBytes_; }
  std::uint64_t paletteReadbacks() const { return paletteReadbacks_; }
  std::uint64_t preparedFrameCacheMisses() const { return preparedFrameMisses_; }
  std::uint64_t preparedFrameCacheEvictions() const { return preparedFrameEvictions_; }
  std::optional<CompactImageRegion> resolveCompactRegion(
      ImageHandle handle, float x, float y, float width, float height);
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
  std::optional<std::uint64_t> contentRevision(ImageHandle handle) const;
  std::uint64_t textureEpoch() const { return textureEpoch_; }
  bool ensureMipmaps(ImageHandle handle, bool premultiplied);
  const ImagePixels* readPixels(ImageHandle handle) const;
  using ResidentImageVisitor = std::function<void(const std::string&, const ImagePixels*, const std::string&)>;
  bool visitResidentImages(ImageHandle handle, const ResidentImageVisitor& visitor) const;
  bool updateRgba(ImageHandle handle, const void* pixels);
  bool updateRgbaRegion(ImageHandle handle, int x, int y, int width, int height,
                        const void* pixels, int sourceRowPixels, bool imageKnownAllZero = false);
  std::shared_ptr<ImagePixelSnapshot> deferPixelRead(ImageHandle handle,
      int x, int y, int width, int height);
  bool preservePixelReads(ImageHandle handle);
  bool retainCpuPixels(ImageHandle handle);
  bool retain(ImageHandle handle);
  bool release(ImageHandle handle);
  bool pin(ImageHandle handle);
  bool unpin(ImageHandle handle);
  bool touch(ImageHandle handle);
  bool beginUse(ImageHandle handle);
  bool endUse(ImageHandle handle);
  void update();
  std::optional<ImageInfo> lookup(ImageHandle handle,
      const char* caller = "image-lookup") const;
  // Pixi samples premultiplied texels; keep the straight CPU snapshot intact.
  std::optional<ImageInfo> lookupPremultiplied(ImageHandle handle,
      const char* caller = "image-lookup");
  ImageHandle fallbackHandle();
  std::optional<ImageInfo> acquireFallback();
  std::uint64_t fallbackUses() const { return fallbackUses_; }
  std::size_t fallbackReferences() const;
  std::size_t liveCount() const { return liveCount_; }
  std::size_t gpuBytes() const { return gpuBytes_; }
  std::size_t peakGpuBytes() const { return peakGpuBytes_; }
  std::size_t cpuBytes() const { return cpuMemory_->bytes(); }
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
  std::uint64_t preparedPageDecodes() const { return preparedPageDecodes_->load(std::memory_order_relaxed); }
  std::uint64_t preparedSharedPageHits() const;
  std::uint64_t preparedSharedTextureHits() const { return preparedSharedTextureHits_; }
  std::uint64_t preparedRegionReads() const { return preparedRegionReads_; }
  const std::unordered_map<std::string, std::uint64_t>& preparedFallbacks() const { return preparedFallbacks_; }
  void notePreparedFallback(ImageHandle handle, const std::string& reason);
  bool hasPreparedBacking(ImageHandle handle) const;
  bool hasUniformPreparedBacking(ImageHandle handle) const;
  std::vector<ImageMemoryEntry> memoryEntries() const;

 private:
  friend class Renderer;
  bool rendering_ = false;
  mutable std::uint64_t renderReadbacks_ = 0;
  std::uint64_t preparedFrameUploadBytes_ = 0;
  std::optional<ImagePixels> readTexturePixels(const ImageInfo& image, ImageChannelStorage storage = {},
      std::optional<std::array<int,4>> region = std::nullopt) const;
  struct PixelReads {
    std::vector<std::weak_ptr<ImagePixelSnapshot>> readers;
    std::size_t sweepAt = 64;
  };
  std::unordered_map<ImageHandle, PixelReads> pixelReads_;
  struct SharedPreparedPage;
  struct PreparedPool;
  struct SharedTexture;
  struct PaletteBacking;
  struct PreparedBacking;
  bool realizeSourceTexture(ImageHandle handle);
  std::uint64_t textureArtifactLoads_ = 0, textureArtifactFailures_ = 0, sourceTextureBuilds_ = 0;
  std::size_t textureArtifactStagingBytes_ = 0;
  std::string textureArtifactFailureReason_;
  ProgramBinaryCache programCache_;
  std::shared_ptr<PreparedPool> preparedPool_;
  std::unordered_map<std::string, std::weak_ptr<SharedTexture>> preparedTextures_;
  std::unordered_map<std::string, std::weak_ptr<PaletteBacking>> preparedPalettes_;
  std::shared_ptr<SharedTexture> shareTexture(const std::string& key, std::uint32_t texture,
      std::size_t bytes, ImageChannelStorage storage);
  std::string preparedTextureKey(PreparedBacking& backing, bool premultiplied);

  std::optional<ImageInfo> convertPreparedFrame(ImageHandle handle, const std::array<int, 4>& storage, bool premultiplied);
  std::uint32_t preparedCopyProgram_ = 0, preparedCopyVao_ = 0;
  std::uint64_t preparedFrameConversions_ = 0, preparedFrameBypasses_ = 0;
  mutable std::uint64_t paletteReadbacks_ = 0;
  double preparedFrameConversionMs_ = 0;
  struct PreparedFrame {
    const PreparedBacking* owner;
    std::array<int, 4> source;
    std::array<int, 4> storage;
    ImageHandle image;
    bool premultiplied;
    std::size_t bytes;
    std::uint64_t lastUsed;
  };
  std::vector<PreparedFrame> preparedFrames_;
  // Keep evicted textures alive until all queued draws from this frame finish.
  std::vector<ImageHandle> activePreparedFrames_;
  std::size_t preparedFrameBudgetBytes_ = defaultPreparedFrameCacheBytes;
  std::size_t preparedFrameBytes_ = 0;
  std::size_t preparedFrameResidentBytes_ = 0, preparedFramePeakResidentBytes_ = 0;
  bool compactSamplingEnabled_ = true, preparedCropUploadsEnabled_ = true;
  std::uint64_t compactUploadFailures_ = 0, compactTextureUploads_ = 0;
  std::uint64_t preparedCropUploads_ = 0, preparedCropUploadBytes_ = 0;
  std::uint64_t blockTextureUploads_ = 0, blockUploadFailures_ = 0, blockRegions_ = 0;
  std::uint64_t preparedFrameClock_ = 0, preparedFrameHits_ = 0;
  std::uint64_t preparedFrameMisses_ = 0, preparedFrameEvictions_ = 0;
  void clearPreparedFrames(const PreparedBacking* owner);
  void trimPreparedFrames(std::size_t targetBytes);
  struct TilePrototype;
  struct TileCatalog;
  struct TilePages;
  struct TileBacking;
  void visitResidentTileImages(const TileBacking& tiles, const ResidentImageVisitor& visitor) const;
  struct TileLoad;
  struct Slot {
    std::shared_ptr<PaletteBacking> palette, retiredPalette;
    bool paletteChecked = false;
    struct AstcBacking {
      std::shared_ptr<ImageFileSource> original;
      std::vector<std::shared_ptr<ImageFileSource>> pages;
    };
    std::shared_ptr<AstcBacking> astc;
    std::size_t compressedBytes = 0;
    // Preserve both alpha representations until pending image users finish.
    std::array<std::uint32_t, 2> retiredTextures{};
    std::size_t retiredTextureBytes = 0;
    std::size_t textureBytes() const {
      return compressedBytes ? compressedBytes : static_cast<std::size_t>(width) * height * storage.channels;
    };

    std::uint16_t generation = 1;
    std::uint64_t contentRevision = 0;
    std::uint64_t opacityRevision = 0;
    bool opaque = false;
    std::uint32_t texture = 0;
    std::shared_ptr<SharedTexture> sharedTexture, sharedPremultipliedTexture;
    std::size_t preparedFrameBytes = 0;
    std::shared_ptr<PreparedBacking> prepared;
    std::shared_ptr<TileBacking> tiles;
    int width = 0;
    int height = 0;
    ImageChannelStorage storage;
    std::uint32_t references = 0;
    std::atomic<std::uint32_t> inFlight{0};
    std::uint32_t pins = 0;
    std::uint64_t lastUsedSerial = 0;
    mutable std::uint16_t cpuPixelFrames = 0;
    // Prepared CPU copies age out while their immutable backing remains reloadable.
    bool gpuOnly = false;
    bool renderTarget = false;
    bool premultiplied = false;
    bool knownAllZero = false;
    std::uint32_t premultipliedTexture = 0;
    bool mipmapsReady = false, premultipliedMipmapsReady = false;
    std::size_t mipmapBytes = 0, premultipliedMipmapBytes = 0;
    bool retainCpuPixels = false;
    bool sceneryFullMaterialized = false;
    std::string sceneryFirstMaterializationCaller;
    std::string cacheKey;
    std::filesystem::path sourcePath;
    std::string lastPreparedFallbackReason;
    mutable std::optional<ImagePixels> cachedPixels;
    mutable MemoryCharge cachedPixelCharge;
    bool live = false;
  };
  void setCachedPixels(const Slot& slot, std::optional<ImagePixels> pixels) const;
  std::shared_ptr<MemoryLedger> cpuMemory_ = std::make_shared<MemoryLedger>();

  std::shared_ptr<TileLoad> captureTileLoad(const ImageFileSource& source, const std::string& identity) const;
  bool validateTileLoad(TileLoad& load, bool retainCpu);
  std::optional<ImagePixels> decodeTileFallback(const TileLoad& load) const;
  enum class TileIdentityState { exact, inodeOnly, verified, changed };
  TileIdentityState tileIdentityState(const std::string& expected,
      const ImageFileSource& file, const std::string& hash) const;
  bool tileContentMatches(const std::string& expectedIdentity,
      const ImageFileSource& file, const std::string& hash, std::span<const std::uint8_t> bytes) const;
  std::shared_ptr<ImageFileSource> captureTileSnapshot(TilePrototype& prototype,
      std::size_t source) const;
  std::optional<ImagePixels> decodeTileSnapshot(TilePrototype& prototype,
      std::size_t source) const;
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
  mutable std::mutex tileFileMutex_;
  mutable std::mutex tileVerificationMutex_;
  mutable std::unordered_set<std::string> verifiedTileFiles_;
  mutable std::size_t tileVerificationCacheEstimatedBytes_ = 0;
  std::shared_ptr<ImageFileSource> captureTileFile(const std::filesystem::path& path) const;
  std::uint64_t tileHits_ = 0, tileRegions_ = 0, tileMaterializations_ = 0;
  std::uint64_t sceneryWindowHits_ = 0;
  std::uint64_t sceneryWindowUploads_ = 0, sceneryFullFallbacks_ = 0;
  std::uint64_t sceneryScrollWindows_ = 0, sceneryScrollCopyBytes_ = 0;
  std::uint64_t sceneryScrollUploadBytes_ = 0, sceneryScrollFallbacks_ = 0;
  std::uint64_t sceneryWindowReadMicros_ = 0, sceneryWindowCreateMicros_ = 0;
  std::uint64_t sceneryWindowPremultiplyMicros_ = 0;
  std::unordered_map<std::string, std::uint64_t> sceneryWindowRejections_;
  std::unordered_map<std::string, std::uint64_t> sceneryBackingRejections_;
  std::uint64_t tilePageDecodes_ = 0, tilePageUploads_ = 0;
  std::unordered_map<std::string, std::uint64_t> tileFallbacks_, tileRegionSets_;
  void clearPrepared(Slot& slot);
  void trimPreparedPages() const;
  static void reserveFramePage(PreparedBacking& backing, std::size_t index);
  std::unordered_map<std::string, ImageStorageDecision> storageDecisions_;
  std::uint64_t storageDecisionHits_ = 0;
  const ImageStorageDecision* storageDecision(const std::string& key) const;

  std::optional<ImagePixels> readPalettePixels(const Slot& slot, std::optional<std::array<int, 4>> region = std::nullopt) const;
  bool materializePalette(Slot& slot);
  std::size_t paletteGpuBytes(const Slot& slot) const;
  std::size_t paletteCpuBytes(const Slot& slot) const;
  bool materialize(Slot& slot, bool premultiplied);
  std::optional<ImageInfo> lookupAstc(ImageHandle handle, bool premultiplied);
  bool promoteAstc(Slot& slot, const void* replacement = nullptr);
  void clearRetiredTextures(Slot& slot);
  bool supportsAstc() const;
  mutable std::optional<bool> astcSupported_;
  std::optional<std::size_t> uploadPreparedCrops(Slot& slot, std::uint32_t& texture);
  static ImagePixels* preparedPixels(PreparedBacking& backing, std::size_t page, bool* acquired = nullptr);
  static std::optional<ImagePixels> readPreparedRegion(PreparedBacking& backing,
      int x, int y, int width, int height, bool* acquired = nullptr);
  static bool readPreparedRegionInto(PreparedBacking& backing, int x, int y,
      int width, int height, ImagePixels& destination, int destinationX,
      int destinationY, bool* acquired = nullptr);
  std::optional<ImageInfo> preparedPage(Slot& slot, std::size_t page, bool premultiplied,
      PaletteImageRegion* paletteView = nullptr, bool sparseAllowed = false);
  std::uint32_t paletteTable(PaletteBacking& palette, bool premultiplied);
  std::shared_ptr<PaletteBacking> makeSparsePalette(const SparsePalettePage& page, bool sparseAllowed);
  static bool preparedSparsePage(PreparedBacking& backing, std::size_t index);
  static ImageHandle makeHandle(std::size_t index, std::uint16_t generation);
  void markUsed(Slot& slot);
  std::size_t residentBytes(const Slot& slot) const;
  std::uint64_t textureEpoch_ = 0;
  void destroySlot(std::size_t index);
  void clearPremultipliedTexture(Slot& slot);
  std::optional<ImageInfo> createDecoded(const ImagePixels& pixels,
      const ImageStorageDecision* decision = nullptr);
  std::optional<ImageInfo> createImage(int width, int height, const void* pixels,
                                     bool premultiplied, ImageChannelStorage storage,
      std::shared_ptr<PaletteBacking> palette = {}, const ImageStorageDecision* decision = nullptr);
  bool detachSharedTexture(Slot& slot);
  bool promoteToRgba(Slot& slot, const void* replacement = nullptr);
  std::deque<Slot> slots_;
  std::unordered_map<std::string, ImageHandle> pathCache_;
  std::shared_ptr<PreparationFailures> preparationFailures_ = std::make_shared<PreparationFailures>();
  std::shared_ptr<std::atomic<unsigned>> preparationInvalidations_ = std::make_shared<std::atomic<unsigned>>(0);
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
  std::shared_ptr<std::atomic<std::uint64_t>> preparedPageDecodes_ =
      std::make_shared<std::atomic<std::uint64_t>>(0);
  std::uint64_t preparedSharedTextureHits_ = 0;
  mutable std::uint64_t preparedRegionReads_ = 0;
  std::unordered_map<std::string, std::uint64_t> preparedFallbacks_;
  ImageHandle fallbackHandle_ = 0;
  std::uint64_t fallbackUses_ = 0;
};

}  // namespace pmjs
