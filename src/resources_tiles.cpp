#include "resources.hpp"
#include "checked_bounds.hpp"

#include <algorithm>
#include <cmath>
#include <unordered_set>
#include <mutex>

namespace pmjs {
namespace {
constexpr std::uint32_t tileIndexMask = 0xffffU;
std::string tileKey(const std::string& source, const std::string& identity) {
  return source + '\n' + identity;
}
bool inside(const std::array<int, 4>& r, int width, int height) {
  return r[0] >= 0 && r[1] >= 0 && r[2] > 0 && r[3] > 0 &&
    r[0] <= width-r[2] && r[1] <= height-r[3];
}
}
namespace {
struct TileDecoded {
  std::mutex mutex;
  std::vector<ImagePixels> pixels;
  std::atomic<bool> reported{false};
  bool validated = false;
};
}
struct ImageStore::TilePrototype {
  mutable std::mutex mutex;
  std::weak_ptr<TileDecoded> decoded;
  std::weak_ptr<TilePages> pageOwner;
  PreparedTileSet descriptor;
  std::vector<std::shared_ptr<ImageFileSource>> pages, snapshots;
  std::shared_ptr<std::atomic<std::size_t>> accounting;
  std::size_t metadataBytes = 0;
  ~TilePrototype() {
    if (accounting) accounting->fetch_sub(metadataBytes, std::memory_order_relaxed);
  }
};
struct ImageStore::TileCatalog {
  PreparedTileSet descriptor;
  std::vector<std::string> pageIdentities, snapshotIdentities;
  std::weak_ptr<TilePrototype> captured;
  std::shared_ptr<std::atomic<std::size_t>> accounting;
  std::size_t metadataBytes = 0;
  ~TileCatalog() {
    if (accounting) accounting->fetch_sub(metadataBytes, std::memory_order_relaxed);
  }
};
struct ImageStore::TilePages {
  ImageStore* store = nullptr;
  std::shared_ptr<bool> alive;
  std::vector<ImageHandle> images;
  ~TilePages() {
    if (alive && *alive) for (const auto image : images) store->release(image);
  }
};
struct ImageStore::TileBacking {
  std::shared_ptr<TilePrototype> prototype;
  std::shared_ptr<TilePages> pages;
  std::size_t source = 0;
};
struct ImageStore::TileLoad {
  std::shared_ptr<TilePrototype> prototype;
  std::size_t source = 0;
  std::string key;
  std::shared_ptr<TileDecoded> decoded;
  std::shared_ptr<TilePages> cachedPages;
  std::optional<ImagePixels> ordinary;
};
void ImageStore::collectTileFiles(const Slot& slot,
    std::unordered_set<const ImageFileSource*>& files) const {
  if (!slot.tiles) return;
  const auto& prototype = *slot.tiles->prototype;
  for (const auto& file : prototype.pages) if (file) files.insert(file.get());
  for (const auto& file : prototype.snapshots) if (file) files.insert(file.get());
}
void ImageStore::clearTileSetIndex() {
  tileSets_.clear();
  std::erase_if(tileFiles_, [](const auto& entry) { return entry.second.expired(); });
}
std::shared_ptr<ImageFileSource> ImageStore::captureTileFile(const std::filesystem::path& path) const {
  auto file = openFile(path);
  if (!file) return nullptr;
  if (auto shared = tileFiles_[file->key()].lock()) return shared;
  std::shared_ptr<ImageFileSource> shared(std::move(file));
  tileFiles_[shared->key()] = shared;
  return shared;
}
namespace {
std::size_t descriptorBytes(const PreparedTileSet& descriptor) {
  std::size_t bytes = descriptor.identity.capacity()+descriptor.directory.native().capacity()+
    descriptor.sources.capacity()*sizeof(PreparedTileSource)+descriptor.pages.capacity()*sizeof(PreparedImagePage);
  for (const auto& source : descriptor.sources) bytes +=
    source.regions.capacity()*sizeof(PreparedTileRegion)+source.identity.capacity()+
      source.path.native().capacity()+source.snapshot.native().capacity();
  for (const auto& page : descriptor.pages) bytes += page.path.native().capacity();
  return bytes;
}
}
std::string ImageStore::effectiveTileSet(const ImageFileSource& source, const std::string& identity) const {
  const auto set = tileSets_.find(identity);
  if (set != tileSets_.end()) for (const auto& entry : set->second->descriptor.sources)
    if (entry.identity == source.key()) return identity;
  return {};
}
bool ImageStore::installTileSet(PreparedTileSet descriptor) {
  if (descriptor.version != 1 || descriptor.halo < 1 || descriptor.halo > 32 || descriptor.identity.empty() ||
      descriptor.identity.size() > 256 || descriptor.pages.empty() || descriptor.pages.size() > 4096 ||
      descriptor.sources.empty() || descriptor.sources.size() > 512 || !descriptor.directory.is_absolute()) return false;
  auto catalog = std::make_shared<TileCatalog>();
  for (const auto& page : descriptor.pages) {
    if (page.width <= 0 || page.height <= 0 || page.width > 2048 || page.height > 2048 ||
        page.path.empty() || page.path.is_absolute() || page.path.has_parent_path()) return false;
    auto file = openFile(descriptor.directory/page.path);
    if (!file) return false;
    catalog->pageIdentities.push_back(file->key());
  }
  std::unordered_set<std::string> sources;
  for (const auto& source : descriptor.sources) {
    if (!checkedImageExtent(source.width, source.height, 8192, 128U*1024U*1024U) ||
        source.regions.size() > 65536 || !source.snapshot.is_absolute()) return false;
    auto original = openFile(source.path);
    auto snapshot = openFile(source.snapshot);
    if (!original || !snapshot || original->key() != source.identity || !sources.insert(source.identity).second) return false;
    for (const auto& region : source.regions) {
      if (!inside(region.rect, source.width, source.height) || region.page < 0 ||
          static_cast<std::size_t>(region.page) >= descriptor.pages.size()) return false;
      const auto& page = descriptor.pages[region.page];
      if (!inside(region.atlas, page.width, page.height) || region.atlas[0] < descriptor.halo || region.atlas[1] < descriptor.halo ||
          region.atlas[0]+region.atlas[2]+descriptor.halo > page.width || region.atlas[1]+region.atlas[3]+descriptor.halo > page.height ||
          region.atlas[2] != region.rect[2] || region.atlas[3] != region.rect[3]) return false;
    }
    catalog->snapshotIdentities.push_back(snapshot->key());
  }
  catalog->descriptor = std::move(descriptor);
  catalog->metadataBytes = sizeof(TileCatalog)+descriptorBytes(catalog->descriptor)+
    (catalog->pageIdentities.capacity()+catalog->snapshotIdentities.capacity())*sizeof(std::string);
  for (const auto& key : catalog->pageIdentities) catalog->metadataBytes += key.capacity();
  for (const auto& key : catalog->snapshotIdentities) catalog->metadataBytes += key.capacity();
  catalog->accounting = tileMetadataBytes_;
  tileMetadataBytes_->fetch_add(catalog->metadataBytes, std::memory_order_relaxed);
  tileSets_[catalog->descriptor.identity] = std::move(catalog);
  return true;
}
std::shared_ptr<ImageStore::TileLoad> ImageStore::captureTileLoad(
    const ImageFileSource& source, const std::string& identity) const {
  const auto found = tileSets_.find(identity);
  if (found == tileSets_.end()) return nullptr;
  const auto& descriptor = found->second->descriptor;
  for (std::size_t i = 0; i < descriptor.sources.size(); ++i) {
    if (descriptor.sources[i].identity != source.key()) continue;
    auto load = std::make_shared<TileLoad>();
    auto prototype = found->second->captured.lock();
    if (!prototype) {
      prototype = std::make_shared<TilePrototype>();
      prototype->descriptor = descriptor;
      for (std::size_t page = 0; page < descriptor.pages.size(); ++page) {
        auto file = captureTileFile(descriptor.directory/descriptor.pages[page].path);
        if (!file || file->key() != found->second->pageIdentities[page]) return nullptr;
        prototype->pages.push_back(std::move(file));
      }
      for (std::size_t entry = 0; entry < descriptor.sources.size(); ++entry) {
        auto file = captureTileFile(descriptor.sources[entry].snapshot);
        if (!file || file->key() != found->second->snapshotIdentities[entry]) return nullptr;
        prototype->snapshots.push_back(std::move(file));
      }
      prototype->metadataBytes = sizeof(TilePrototype)+descriptorBytes(prototype->descriptor)+
        (prototype->pages.capacity()+prototype->snapshots.capacity())*sizeof(std::shared_ptr<ImageFileSource>);
      prototype->accounting = tileMetadataBytes_;
      tileMetadataBytes_->fetch_add(prototype->metadataBytes, std::memory_order_relaxed);
      found->second->captured = prototype;
    }
    load->prototype = prototype; load->source = i; load->key = tileKey(source.key(), identity);
    load->cachedPages = prototype->pageOwner.lock();
    { std::lock_guard lock(prototype->mutex);
      load->decoded = prototype->decoded.lock();
      if (!load->decoded) { load->decoded = std::make_shared<TileDecoded>(); prototype->decoded = load->decoded; }
    }
    return load;
  }
  return nullptr;
}
std::shared_ptr<ImageFileSource> ImageStore::captureTileFallback(const TileLoad& load) {
  return load.prototype->snapshots[load.source];
}

bool ImageStore::validateTileLoad(TileLoad& load, bool retainCpu) {
  const auto& prototype = *load.prototype;
  std::lock_guard lock(load.decoded->mutex);
  if (!load.cachedPages && !load.decoded->validated) {
    std::vector<ImagePixels> decoded;
    for (std::size_t i = 0; i < prototype.pages.size(); ++i) {
      auto pixels = decodeFile(*prototype.pages[i]);
      const auto& page = prototype.descriptor.pages[i];
      if (!pixels || pixels->width != page.width || pixels->height != page.height) return false;
      decoded.push_back(std::move(*pixels));
    }
    load.decoded->pixels = std::move(decoded); load.decoded->validated = true;
  }
  if (retainCpu && !load.ordinary) {
    load.ordinary = decodeFile(*prototype.snapshots[load.source]);
    const auto& source = prototype.descriptor.sources[load.source];
    if (!load.ordinary || load.ordinary->width != source.width || load.ordinary->height != source.height) return false;
  }
  return true;
}
std::optional<ImageInfo> ImageStore::insertTileView(std::shared_ptr<TileBacking> backing,
    int width, int height, const std::string& cacheKey) {
  std::size_t index = 0;
  while (index < slots_.size() && slots_[index].live) ++index;
  if (index >= tileIndexMask) return std::nullopt;
  if (index == slots_.size()) slots_.emplace_back();
  auto& slot = slots_[index];
  slot.tiles = std::move(backing); slot.width = width; slot.height = height;
  slot.texture = slot.premultipliedTexture = 0; slot.channels = 4;
  slot.references = 1; slot.pins = 0; slot.inFlight.store(0);
  slot.cacheKey = cacheKey; slot.sourcePath = slot.tiles->prototype->descriptor.sources[slot.tiles->source].path;
  slot.gpuOnly = slot.renderTarget = slot.premultiplied = slot.knownAllZero = false;
  slot.retainCpuPixels = false; slot.cachedPixels.reset(); slot.cpuPixelFrames = 0;
  slot.mipmapsReady = slot.premultipliedMipmapsReady = false;
  slot.mipmapBytes = slot.premultipliedMipmapBytes = 0;
  slot.live = true; markUsed(slot); ++liveCount_;
  const auto handle = makeHandle(index, slot.generation);
  if (!cacheKey.empty()) pathCache_[cacheKey] = handle;
  return inspect(handle);
}
std::optional<ImageInfo> ImageStore::installTileLoad(std::shared_ptr<TileLoad> load, bool retainCpu) {
  auto existing = pathCache_.find(load->key);
  if (existing != pathCache_.end() && retain(existing->second)) {
    const auto image = inspect(existing->second);
    if (retainCpu) {
      auto& slot = slots_[(image->handle & tileIndexMask)-1U];
      if (!slot.cachedPixels && load->ordinary) slot.cachedPixels = std::move(load->ordinary);
      retainCpuPixels(image->handle);
    }
    if (tileDiagnostics_) ++tileHits_; return image;
  }
  const auto& descriptor = load->prototype->descriptor;
  auto pages = load->cachedPages ? load->cachedPages : load->prototype->pageOwner.lock();
  if (!pages) {
    pages = std::make_shared<TilePages>(); pages->store = this; pages->alive = alive_;
    // Both sampling modes are prewarmed before the image's ready event. Logical
    // views share these allocations; page ownership is independent of display trees.
    for (const auto& pixels : load->decoded->pixels) {
      auto image = createDecoded(pixels);
      if (!image) { if (tileDiagnostics_) ++tileFallbacks_["page-allocation"]; return std::nullopt; }
      pages->images.push_back(image->handle);
      if (!lookupPremultiplied(image->handle)) { if (tileDiagnostics_) ++tileFallbacks_["page-allocation"]; return std::nullopt; }
      if (tileDiagnostics_) ++tilePageUploads_;
    }
    load->prototype->pageOwner = pages;
  }
  if (tileDiagnostics_ && !load->cachedPages && !load->decoded->reported.exchange(true)) tilePageDecodes_ += load->decoded->pixels.size();
  auto backing = std::make_shared<TileBacking>(); backing->prototype = load->prototype;
  backing->pages = std::move(pages); backing->source = load->source;
  const auto& source = descriptor.sources[load->source];
  auto image = insertTileView(std::move(backing), source.width, source.height, load->key);
  if (!image) return std::nullopt;
  auto& slot = slots_[(image->handle & tileIndexMask)-1U];
  slot.retainCpuPixels = retainCpu; slot.cachedPixels = std::move(load->ordinary);
  if (tileDiagnostics_) ++tileHits_; return image;
}
std::optional<ImageInfo> ImageStore::createTileSlot(ImageHandle handle, int width, int height) {
  auto info = inspect(handle);
  if (!info || !hasTileBacking(handle) || width < info->width || height < info->height ||
      !checkedImageExtent(width, height)) return std::nullopt;
  auto slot = insertTileView(slots_[(handle & tileIndexMask)-1U].tiles, width, height, {});
  if (slot) slots_[(slot->handle & tileIndexMask)-1U].premultiplied = true;
  return slot ? inspect(slot->handle) : std::nullopt;
}
bool ImageStore::hasTileBacking(ImageHandle handle) const {
  return inspect(handle) && slots_[(handle & tileIndexMask)-1U].tiles != nullptr;
}
std::optional<ImagePixels> ImageStore::readTileRegion(const Slot& slot, int x, int y, int width, int height) const {
  const auto& backing = *slot.tiles;
  const auto& source = backing.prototype->descriptor.sources[backing.source];
  if (!slot.cachedPixels) {
    for (const auto& region : source.regions) {
      const auto& r = region.rect;
      if (x >= r[0] && y >= r[1] && x+width <= r[0]+r[2] && y+height <= r[1]+r[3])
        return readPixelsRegion(backing.pages->images[region.page],
          region.atlas[0]+x-r[0], region.atlas[1]+y-r[1], width, height);
    }
    auto ordinary = decodeFile(*backing.prototype->snapshots[backing.source]);
    if (!ordinary || ordinary->width != source.width || ordinary->height != source.height) return std::nullopt;
    if (ordinary->width != slot.width || ordinary->height != slot.height) {
      ImagePixels padded{slot.width, slot.height,
        std::vector<std::uint8_t>(static_cast<std::size_t>(slot.width)*slot.height*4)};
      const auto rows = std::min(slot.height, ordinary->height);
      const auto columns = std::min(slot.width, ordinary->width);
      for (int row = 0; row < rows; ++row)
        std::copy_n(ordinary->rgba.data()+static_cast<std::size_t>(row)*ordinary->width*4,
          static_cast<std::size_t>(columns)*4, padded.rgba.data()+static_cast<std::size_t>(row)*slot.width*4);
      slot.cachedPixels = std::move(padded);
    } else slot.cachedPixels = std::move(ordinary);
  }
  if (!slot.retainCpuPixels) slot.cpuPixelFrames = 60;
  const auto& ordinary = *slot.cachedPixels;
  ImagePixels result{width, height, std::vector<std::uint8_t>(static_cast<std::size_t>(width)*height*4)};
  // Fixed logical slots include transparent padding beyond the source image.
  for (int row = 0; row < height && y+row < source.height; ++row) {
    if (x >= source.width) break;
    const int count = std::min(width, source.width-x);
    std::copy_n(ordinary.rgba.data()+(static_cast<std::size_t>(y+row)*ordinary.width+x)*4,
      static_cast<std::size_t>(count)*4, result.rgba.data()+static_cast<std::size_t>(row)*width*4);
  }
  return result;
}
std::optional<SpriteImageRegion> ImageStore::resolveTileRegion(Slot& slot,
    float x, float y, float width, float height, bool premultiplied) {
  const auto& backing = *slot.tiles;
  if (x < 0 || y < 0 || x+width > slot.width || y+height > slot.height) {
    if (tileDiagnostics_) ++tileFallbacks_["logical-bounds"]; return std::nullopt;
  }
  const auto& source = backing.prototype->descriptor.sources[backing.source];
  for (const auto& region : source.regions) {
    const auto& r = region.rect;
    if (x < r[0] || y < r[1] || x+width > r[0]+r[2] || y+height > r[1]+r[3]) continue;
    auto image = (premultiplied || slot.premultiplied) ? lookupPremultiplied(backing.pages->images[region.page]) : lookup(backing.pages->images[region.page]);
    if (!image) return std::nullopt;
    if (tileDiagnostics_) { ++tileRegions_; ++tileRegionSets_[backing.prototype->descriptor.identity]; }
    return SpriteImageRegion{*image,
      {static_cast<float>(r[0]), static_cast<float>(r[1]), static_cast<float>(r[2]), static_cast<float>(r[3])},
      {static_cast<float>(region.atlas[0]), static_cast<float>(region.atlas[1]), static_cast<float>(r[2]), static_cast<float>(r[3])},
      slot.width, slot.height, backing.prototype->descriptor.halo};
  }
  if (tileDiagnostics_) ++tileFallbacks_["unknown-region"];
  return std::nullopt;
}
std::size_t ImageStore::tileWarmBytes() const {
  std::unordered_set<const TilePages*> active, warm;
  std::size_t bytes = 0;
  for (const auto& slot : slots_) if (slot.live && slot.tiles) {
    auto* pages = slot.tiles->pages.get();
    if (slot.references || slot.pins || slot.inFlight.load(std::memory_order_acquire)) active.insert(pages);
    else warm.insert(pages);
  }
  for (const auto* pages : warm) if (!active.contains(pages))
    for (const auto image : pages->images) if (inspect(image))
      bytes += residentBytes(slots_[(image & tileIndexMask)-1U]);
  return bytes;
}
}
