#include "tile_assets.hpp"

#include <algorithm>
#include <cstring>
#include <list>
#include <mutex>
#include <unordered_map>
#include <numeric>
#include <tuple>
#include <zlib.h>

namespace pmjs {
std::shared_ptr<const ImagePixels> TileDecodeCache::getOrDecode(
    const ImageFileSource& source, std::size_t decodeBudget, std::size_t pageAndMetadataReserve) {
  const std::string& key = source.key();
  const std::size_t budgetAfterReserve = totalBudgetBytes_ > pageAndMetadataReserve
    ? totalBudgetBytes_ - pageAndMetadataReserve : 0;
  std::size_t availableTotal = budgetAfterReserve;
  auto pruneRetiredLocked = [&]() {
    for (auto it = retiredPinned_.begin(); it != retiredPinned_.end();) {
      if (it->first.use_count() <= 1) {
        retiredBytes_ -= it->second;
        it = retiredPinned_.erase(it);
      } else {
        ++it;
      }
    }
  };
  auto evictUnpinnedLocked = [&](std::size_t targetLive, const std::string* keepKey) {
    for (auto lruIt = lru_.end(); lruIt != lru_.begin() && cachedBytes_ + retiredBytes_ > targetLive;) {
      --lruIt;
      if (keepKey && *lruIt == *keepKey) continue;
      auto entryIt = map_.find(*lruIt);
      if (entryIt == map_.end()) {
        lruIt = lru_.erase(lruIt);
        continue;
      }
      if (entryIt->second.image.use_count() <= 1) {
        cachedBytes_ -= entryIt->second.bytes;
        map_.erase(entryIt);
        lruIt = lru_.erase(lruIt);
      }
    }
  };
  {
    std::lock_guard lock(mutex_);
    pruneRetiredLocked();
    if (!key.empty()) {
      auto it = map_.find(key);
      if (it != map_.end()) {
        lru_.splice(lru_.begin(), lru_, it->second.lruIt);
        auto hit = it->second.image;
        if (cachedBytes_ + retiredBytes_ > budgetAfterReserve) {
          evictUnpinnedLocked(budgetAfterReserve, &key);
        }
        if (cachedBytes_ + retiredBytes_ > budgetAfterReserve) return nullptr;
        return hit;
      }
    }
    const std::size_t live = cachedBytes_ + retiredBytes_;
    availableTotal = budgetAfterReserve > live ? budgetAfterReserve - live : 0;
  }
  const std::size_t effectiveBudget = std::min(decodeBudget, availableTotal / 3);
  std::optional<ImagePixels> decoded = effectiveBudget > 0 ? ImageStore::decodeFile(source, effectiveBudget) : std::nullopt;
  if (!decoded) {
    std::size_t retryAvailable = 0;
    bool evictedAny = false;
    {
      std::lock_guard lock(mutex_);
      pruneRetiredLocked();
      const std::size_t before = cachedBytes_;
      evictUnpinnedLocked(0, nullptr);
      evictedAny = cachedBytes_ < before;
      const std::size_t live = cachedBytes_ + retiredBytes_;
      retryAvailable = budgetAfterReserve > live ? budgetAfterReserve - live : 0;
    }
    if (evictedAny) {
      const std::size_t retryBudget = std::min(decodeBudget, retryAvailable / 3);
      if (retryBudget > effectiveBudget) {
        decoded = ImageStore::decodeFile(source, retryBudget);
      }
    }
    if (!decoded) return nullptr;
  }
  auto image = std::make_shared<const ImagePixels>(std::move(*decoded));
  const auto bytes = image->rgba.size();
  if (!key.empty() && bytes <= cacheLimitBytes_) {
    std::lock_guard lock(mutex_);
    pruneRetiredLocked();
    if (map_.find(key) == map_.end()) {
      const std::size_t target = cacheLimitBytes_ > bytes ? cacheLimitBytes_ - bytes : 0;
      evictUnpinnedLocked(target, nullptr);
      if (cachedBytes_ + retiredBytes_ + bytes <= cacheLimitBytes_) {
        lru_.push_front(key);
        map_.emplace(key, Entry{image, bytes, lru_.begin()});
        cachedBytes_ += bytes;
      }
    }
  }
  return image;
}

bool TileDecodeCache::evictForReserve(std::size_t reserveBytes) {
  if (reserveBytes > totalBudgetBytes_) return false;
  std::lock_guard lock(mutex_);
  for (auto it = retiredPinned_.begin(); it != retiredPinned_.end();) {
    if (it->first.use_count() <= 1) {
      retiredBytes_ -= it->second;
      it = retiredPinned_.erase(it);
    } else {
      ++it;
    }
  }
  const std::size_t target = totalBudgetBytes_ > reserveBytes ? totalBudgetBytes_ - reserveBytes : 0;
  for (auto lruIt = lru_.end(); lruIt != lru_.begin() && cachedBytes_ + retiredBytes_ > target;) {
    --lruIt;
    auto entryIt = map_.find(*lruIt);
    if (entryIt == map_.end()) {
      lruIt = lru_.erase(lruIt);
      continue;
    }
    if (entryIt->second.image.use_count() <= 1) {
      cachedBytes_ -= entryIt->second.bytes;
      map_.erase(entryIt);
      lruIt = lru_.erase(lruIt);
    }
  }
  return cachedBytes_ + retiredBytes_ <= target;
}

void TileDecodeCache::clear() {
  std::lock_guard lock(mutex_);
  for (auto& [key, entry] : map_) {
    if (entry.image.use_count() > 1) {
      retiredBytes_ += entry.bytes;
      retiredPinned_.emplace_back(std::move(entry.image), entry.bytes);
    }
  }
  map_.clear();
  lru_.clear();
  cachedBytes_ = 0;
}

std::size_t TileDecodeCache::liveBytes() {
  std::lock_guard lock(mutex_);
  for (auto it = retiredPinned_.begin(); it != retiredPinned_.end();) {
    if (it->first.use_count() <= 1) {
      retiredBytes_ -= it->second;
      it = retiredPinned_.erase(it);
    } else {
      ++it;
    }
  }
  return cachedBytes_ + retiredBytes_;
}

namespace {
constexpr int pageLimit = 2048;
struct Piece {
  int width = 0, height = 0, page = -1, x = 0, y = 0;
  std::vector<std::uint8_t> bytes;
};
struct Placement { int page, x, y; };
struct Layout {
  std::vector<Placement> positions;
  std::vector<std::array<int, 2>> dimensions;
  std::size_t bytes = 0;
};
Layout pack(const std::vector<Piece>& pieces, const std::vector<std::size_t>& order, int limit) {
  Layout result;
  result.positions.resize(pieces.size());
  int x = 0, y = 0, rowHeight = 0, usedWidth = 0;
  auto finish = [&]() {
    result.dimensions.push_back({usedWidth, y + rowHeight});
    result.bytes += static_cast<std::size_t>(usedWidth)*(y + rowHeight)*4;
    x = y = rowHeight = usedWidth = 0;
  };
  for (const auto index : order) {
    const auto& piece = pieces[index];
    if (x + piece.width > limit) { y += rowHeight; x = rowHeight = 0; }
    if (y + piece.height > pageLimit) finish();
    result.positions[index] = {static_cast<int>(result.dimensions.size()), x, y};
    x += piece.width; usedWidth = std::max(usedWidth, x); rowHeight = std::max(rowHeight, piece.height);
  }
  if (rowHeight) finish();
  return result;
}
}
std::size_t verifyTileAssets(const std::vector<TileAssetInput>& inputs,
    const PreparedTileAssets& descriptor, const std::filesystem::path& directory) {
  if (descriptor.sources.size() != inputs.size() || descriptor.halo < 1 || descriptor.halo > 32)
    throw std::runtime_error("invalid tile verification descriptor");
  std::size_t count = 0;
  for (std::size_t source = 0; source < inputs.size(); ++source) {
    auto original = ImageStore::decodeFile(*inputs[source].source);
    const auto& logical = descriptor.sources[source];
    if (!original || original->width != logical.width || original->height != logical.height)
      throw std::runtime_error("tile verification source dimensions changed");
    if (logical.regions.size() != inputs[source].rectangles.size()) throw std::runtime_error("tile verification demand missing");
    for (std::size_t index = 0; index < logical.regions.size(); ++index)
      if (logical.regions[index].rect != inputs[source].rectangles[index]) throw std::runtime_error("tile verification demand changed");
    for (std::size_t pageIndex = 0; pageIndex < descriptor.pages.size(); ++pageIndex) {
      const auto& page = descriptor.pages[pageIndex];
      if (page.path.is_absolute() || page.path.has_parent_path() || page.width > 2048 || page.height > 2048)
        throw std::runtime_error("invalid tile verification page");
      auto file = ImageStore::openFile(directory/page.path);
      auto decoded = file ? ImageStore::decodeFile(*file) : std::nullopt;
      if (!decoded || decoded->width != page.width || decoded->height != page.height)
        throw std::runtime_error("invalid tile verification page dimensions");
      for (const auto& region : logical.regions) {
        if (region.page != static_cast<int>(pageIndex)) continue;
        const auto& r = region.rect; const auto& a = region.atlas; const int halo = descriptor.halo;
        if (r[0] < 0 || r[1] < 0 || r[2] <= 0 || r[3] <= 0 ||
            r[0]+r[2] > original->width || r[1]+r[3] > original->height ||
            a[0] < halo || a[1] < halo || a[2] != r[2] || a[3] != r[3] ||
            a[0]+a[2]+halo > page.width || a[1]+a[3]+halo > page.height)
          throw std::runtime_error("invalid tile verification region bounds");
        for (int y = -halo; y < r[3]+halo; ++y) for (int x = -halo; x < r[2]+halo; ++x) {
          const int sx = std::clamp(r[0]+x, 0, original->width-1), sy = std::clamp(r[1]+y, 0, original->height-1);
          const auto from = original->rgba.data()+(static_cast<std::size_t>(sy)*original->width+sx)*4;
          const auto to = decoded->rgba.data()+(static_cast<std::size_t>(a[1]+y)*page.width+a[0]+x)*4;
          if (!std::equal(from, from+4, to)) throw std::runtime_error("prepared tile RGBA differs from captured source");
        }
        ++count;
      }
    }
    for (const auto& region : logical.regions) if (region.page < 0 || static_cast<std::size_t>(region.page) >= descriptor.pages.size())
      throw std::runtime_error("invalid tile verification page index");
  }
  return count;
}

PreparedTileAssets replayTileAssets(const std::vector<TileAssetInput>& inputs,
    const PreparedTileAssets& layout, const std::filesystem::path& staging, TileDecodeCache* cache) {
  if (!staging.is_absolute() || inputs.size() > 512)
    throw std::runtime_error("invalid tile preparation inputs");
  if (layout.version != 1 || layout.halo < 1 || layout.halo > 32 ||
      layout.sources.size() != inputs.size() || layout.pages.empty() || layout.pages.size() > 4096)
    throw AssetPreparationUnsupported("indexed tile layout is incompatible");
  const int halo = layout.halo;
  std::size_t totalPageBytes = 0;
  std::size_t maxPageBufferBytes = 0;
  for (std::size_t pageIndex = 0; pageIndex < layout.pages.size(); ++pageIndex) {
    const auto& page = layout.pages[pageIndex];
    if (page.path.is_absolute() || page.path.has_parent_path() ||
        page.path != "tiles-" + std::to_string(pageIndex) + ".png" ||
        page.width <= 0 || page.height <= 0 || page.width > pageLimit || page.height > pageLimit)
      throw AssetPreparationUnsupported("invalid indexed tile page");
    const auto pBytes = static_cast<std::size_t>(page.width) * page.height * 4;
    totalPageBytes += pBytes;
    maxPageBufferBytes = std::max(maxPageBufferBytes, static_cast<std::size_t>(page.width) * page.height * 5);
  }
  struct RegionRef { std::size_t source, region; };
  std::vector<std::vector<RegionRef>> pageRegions(layout.pages.size());
  for (std::size_t sourceIndex = 0; sourceIndex < inputs.size(); ++sourceIndex) {
    const auto& input = inputs[sourceIndex];
    const auto& logical = layout.sources[sourceIndex];
    if (!input.source || input.rectangles.size() > 65536 ||
        logical.regions.size() != input.rectangles.size() ||
        logical.width <= 0 || logical.height <= 0)
      throw AssetPreparationUnsupported("indexed tile demand does not match");
    for (std::size_t regionIndex = 0; regionIndex < logical.regions.size(); ++regionIndex) {
      const auto& region = logical.regions[regionIndex];
      const auto& r = region.rect;
      const auto& a = region.atlas;
      if (r != input.rectangles[regionIndex] ||
          region.page < 0 || static_cast<std::size_t>(region.page) >= layout.pages.size())
        throw AssetPreparationUnsupported("indexed tile region does not match");
      const auto& page = layout.pages[region.page];
      if (r[0] < 0 || r[1] < 0 || r[2] <= 0 || r[3] <= 0 ||
          r[0] > logical.width - r[2] || r[1] > logical.height - r[3] ||
          a[0] < halo || a[1] < halo || a[2] != r[2] || a[3] != r[3] ||
          a[0] + a[2] + halo > page.width || a[1] + a[3] + halo > page.height)
        throw AssetPreparationUnsupported("indexed tile region bounds are invalid");
      pageRegions[region.page].push_back({sourceIndex, regionIndex});
    }
  }
  constexpr std::size_t budget = 64U * 1024U * 1024U;
  constexpr std::size_t metadataReserve = 8U * 1024U * 1024U;
  const std::size_t reserve = metadataReserve + maxPageBufferBytes;
  if (reserve >= budget)
    throw AssetPreparationUnsupported("tile replay exceeds working storage budget");
  TileDecodeCache localCache;
  TileDecodeCache& activeCache = cache ? *cache : localCache;
  PreparedTileAssets result;
  result.version = 1;
  result.halo = halo;
  result.pageBytes = totalPageBytes;
  result.pages = layout.pages;
  result.sources.resize(inputs.size());
  std::vector<bool> countedOrdinary(inputs.size(), false);
  for (std::size_t sourceIndex = 0; sourceIndex < inputs.size(); ++sourceIndex) {
    const auto& logical = layout.sources[sourceIndex];
    TileAssetSource outSource;
    outSource.width = logical.width;
    outSource.height = logical.height;
    outSource.regions.reserve(logical.regions.size());
    for (const auto& region : logical.regions) {
      PreparedAssetCell cell = region;
      cell.crop = {0, 0, region.rect[2], region.rect[3]};
      outSource.regions.push_back(cell);
    }
    result.sources[sourceIndex] = std::move(outSource);
  }
  auto decodeSource = [&](std::size_t sourceIndex) -> std::shared_ptr<const ImagePixels> {
    const auto& input = inputs[sourceIndex];
    const auto& logical = layout.sources[sourceIndex];
    const auto encodedBytes = input.source->encodedBytes();
    if (encodedBytes > (budget - reserve) / 3)
      throw AssetPreparationUnsupported("tile source exceeds replay decode budget");
    const auto decodeBudget = (budget - reserve - 3 * encodedBytes) / 3;
    auto decoded = activeCache.getOrDecode(*input.source, decodeBudget, reserve + 3 * encodedBytes);
    if (!decoded)
      throw AssetPreparationUnsupported("tile source exceeds the decode budget or cannot be decoded");
    if (decoded->width != logical.width || decoded->height != logical.height)
      throw AssetPreparationUnsupported("indexed tile source dimensions changed");
    if (!countedOrdinary[sourceIndex]) {
      result.ordinaryBytes += ImageStore::decodedStorageBytes(*decoded);
      countedOrdinary[sourceIndex] = true;
    }
    return decoded;
  };
  for (std::size_t sourceIndex = 0; sourceIndex < inputs.size(); ++sourceIndex) {
    if (layout.sources[sourceIndex].regions.empty()) {
      decodeSource(sourceIndex);
    }
  }
  for (std::size_t pageIndex = 0; pageIndex < layout.pages.size(); ++pageIndex) {
    const auto& page = layout.pages[pageIndex];
    const auto pixelCount = static_cast<std::size_t>(page.width) * page.height;
    std::vector<std::uint8_t> bytes(pixelCount * 4, 0);
    std::vector<std::uint8_t> written(pixelCount, 0);
    std::size_t currentSource = SIZE_MAX;
    std::shared_ptr<const ImagePixels> decoded;
    for (const auto& ref : pageRegions[pageIndex]) {
      if (ref.source != currentSource) {
        decoded.reset();
        decoded = decodeSource(ref.source);
        currentSource = ref.source;
      }
      const auto& region = layout.sources[ref.source].regions[ref.region];
      const auto& r = region.rect;
      const auto& a = region.atlas;
      const int pieceWidth = r[2] + 2 * halo;
      const int pieceHeight = r[3] + 2 * halo;
      const int dstLeft = a[0] - halo;
      const int dstTop = a[1] - halo;
      const int srcLeft = r[0] - halo;
      const bool interiorHorizontal = srcLeft >= 0 && pieceWidth <= decoded->width - srcLeft;
      for (int y = 0; y < pieceHeight; ++y) {
        const int sy = std::clamp(r[1] + y - halo, 0, decoded->height - 1);
        const auto* srcRow = decoded->rgba.data() + static_cast<std::size_t>(sy) * decoded->width * 4;
        const auto dstRowOffset = static_cast<std::size_t>(dstTop + y) * page.width + dstLeft;
        auto* dstRow = bytes.data() + dstRowOffset * 4;
        auto* markRow = written.data() + dstRowOffset;
        if (interiorHorizontal) {
          const auto* from = srcRow + static_cast<std::size_t>(srcLeft) * 4;
          const auto spanBytes = static_cast<std::size_t>(pieceWidth) * 4;
          if (std::find(markRow, markRow + pieceWidth, 1) == markRow + pieceWidth) {
            std::memcpy(dstRow, from, spanBytes);
            std::fill_n(markRow, pieceWidth, 1);
            continue;
          }
          if (std::find(markRow, markRow + pieceWidth, 0) == markRow + pieceWidth) {
            if (std::memcmp(dstRow, from, spanBytes) != 0)
              throw AssetPreparationUnsupported("indexed tile replay has conflicting overlapping placements");
            continue;
          }
        }
        for (int x = 0; x < pieceWidth; ++x) {
          const int sx = std::clamp(srcLeft + x, 0, decoded->width - 1);
          const auto* srcPx = srcRow + static_cast<std::size_t>(sx) * 4;
          auto* dstPx = dstRow + static_cast<std::size_t>(x) * 4;
          if (!markRow[x]) {
            std::memcpy(dstPx, srcPx, 4);
            markRow[x] = 1;
          } else if (std::memcmp(srcPx, dstPx, 4) != 0) {
            throw AssetPreparationUnsupported("indexed tile replay has conflicting overlapping placements");
          }
        }
      }
    }
    writePreparedPng(staging / page.path, page.width, page.height, bytes);
  }
  return result;
}

PreparedTileAssets prepareTileAssets(const std::vector<TileAssetInput>& inputs,
                                    const std::filesystem::path& staging,
                                    TileDecodeCache* cache) {
  if (!staging.is_absolute() || inputs.size() > 512) throw std::runtime_error("invalid tile preparation inputs");
  PreparedTileAssets result;
  // A logical sheet may be 8192 pixels wide. Preserve the neighborhood reached
  // by the minimum GLES mediump precision, independently of the packed page.
  result.halo = 10;
  const int halo = result.halo;
  std::vector<Piece> pieces;
  std::vector<std::vector<std::size_t>> sourcePieces;
  // Hashes select candidates; dimensions and all RGBA bytes establish equality.
  std::unordered_multimap<std::uint64_t, std::size_t> unique;
  constexpr std::size_t budget = 64U*1024U*1024U;
  constexpr std::size_t metadataReserve = 8U*1024U*1024U;
  constexpr std::size_t pageReserve = pageLimit*pageLimit*4U;
  std::size_t uniqueBytes = 0;
  std::size_t regionCount = 0;
  for (const auto& input : inputs) {
    if (!input.source || input.rectangles.size() > 65536) throw std::runtime_error("invalid tile source");
    regionCount += input.rectangles.size();
    const auto encodedBytes = input.source->encodedBytes();
    if (regionCount > 8192 || encodedBytes > (budget-metadataReserve-uniqueBytes)/3)
      throw AssetPreparationUnsupported("tile packing exceeds the working storage budget");
    // Encoded recovery copies and high-bit-depth decoder frames need headroom.
    const auto decodeBudget = (budget-metadataReserve-uniqueBytes-3*encodedBytes)/3;
    auto decoded = cache
      ? cache->getOrDecode(*input.source, decodeBudget, metadataReserve + uniqueBytes + 3 * encodedBytes)
      : ([&]() -> std::shared_ptr<const ImagePixels> {
          auto d = ImageStore::decodeFile(*input.source, decodeBudget);
          return d ? std::make_shared<const ImagePixels>(std::move(*d)) : nullptr;
        })();
    if (!decoded) throw AssetPreparationUnsupported("tile source exceeds the decode budget or cannot be decoded");
    TileAssetSource source;
    source.width = decoded->width; source.height = decoded->height;
    result.ordinaryBytes += ImageStore::decodedStorageBytes(*decoded);
    std::vector<std::size_t> indices;
    for (const auto& r : input.rectangles) {
      if (r[0] < 0 || r[1] < 0 || r[2] <= 0 || r[3] <= 0 ||
          r[0] > source.width-r[2] || r[1] > source.height-r[3] ||
          r[2]+2*halo > pageLimit || r[3]+2*halo > pageLimit)
        throw AssetPreparationUnsupported("tile rectangle cannot be packed exactly");
      Piece piece;
      piece.width = r[2]+2*halo; piece.height = r[3]+2*halo;
      const auto pieceBytes = static_cast<std::size_t>(piece.width)*piece.height*4;
      if (pieceBytes > budget-metadataReserve-uniqueBytes ||
          decoded->rgba.capacity() > budget-metadataReserve-uniqueBytes-pieceBytes)
        throw AssetPreparationUnsupported("tile packing exceeds the working storage budget");
      piece.bytes.resize(pieceBytes);
      for (int y = -halo; y < r[3]+halo; ++y) {
        const int sy = std::clamp(r[1]+y, 0, source.height-1), left = r[0]-halo;
        auto* target = piece.bytes.data()+static_cast<std::size_t>(y+halo)*piece.width*4;
        const auto* row = decoded->rgba.data()+static_cast<std::size_t>(sy)*source.width*4;
        if (left >= 0 && piece.width <= source.width-left)
          std::copy_n(row+static_cast<std::size_t>(left)*4, static_cast<std::size_t>(piece.width)*4, target);
        else for (int x = 0; x < piece.width; ++x)
          std::copy_n(row+static_cast<std::size_t>(std::clamp(left+x,0,source.width-1))*4,4,target+static_cast<std::size_t>(x)*4);
      }
      const auto hash = crc32(0, piece.bytes.data(), static_cast<uInt>(piece.bytes.size()));
      const auto candidates = unique.equal_range(hash);
      auto index = pieces.size();
      for (auto entry = candidates.first; entry != candidates.second; ++entry) {
        const auto& candidate = pieces[entry->second];
        if (candidate.width == piece.width && candidate.height == piece.height && candidate.bytes == piece.bytes) {
          index = entry->second; break;
        }
      }
      if (index == pieces.size()) {
        if (uniqueBytes + piece.bytes.size() > budget - metadataReserve - pageReserve)
          throw AssetPreparationUnsupported("tile packing exceeds the working storage budget");
        if (cache && !cache->evictForReserve(metadataReserve + uniqueBytes + piece.bytes.size() + pageReserve + 3 * encodedBytes))
          throw AssetPreparationUnsupported("tile packing exceeds the working storage budget");
        uniqueBytes += piece.bytes.size();
        unique.emplace(hash, index);
        pieces.push_back(std::move(piece));
      }
      indices.push_back(index);
      PreparedAssetCell region; region.rect = r; region.crop = {0, 0, r[2], r[3]};
      source.regions.push_back(region);
    }
    sourcePieces.push_back(std::move(indices)); result.sources.push_back(std::move(source));
  }
  if (cache && !cache->evictForReserve(metadataReserve + uniqueBytes + pageReserve))
    throw AssetPreparationUnsupported("tile packing exceeds the working storage budget");
  std::vector<std::size_t> order(pieces.size()); std::iota(order.begin(), order.end(), 0);
  std::stable_sort(order.begin(), order.end(), [&](auto a, auto b) {
    return std::tie(pieces[a].height, pieces[a].width) > std::tie(pieces[b].height, pieces[b].width);
  });
  Layout best; best.bytes = SIZE_MAX;
  int minimumWidth = 1;
  for (const auto& piece : pieces) minimumWidth = std::max(minimumWidth, piece.width);
  for (int width = minimumWidth; width <= pageLimit; width += 16) {
    auto candidate = pack(pieces, order, width);
    if (candidate.bytes < best.bytes) best = std::move(candidate);
  }
  auto maximum = pack(pieces, order, pageLimit);
  if (maximum.bytes < best.bytes) best = std::move(maximum);
  result.pageBytes = best.bytes;
  for (std::size_t page = 0; page < best.dimensions.size(); ++page) {
    const auto dims = best.dimensions[page];
    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(dims[0])*dims[1]*4);
    for (std::size_t index = 0; index < pieces.size(); ++index) {
      const auto at = best.positions[index]; const auto& piece = pieces[index];
      if (at.page != static_cast<int>(page)) continue;
      for (int row = 0; row < piece.height; ++row)
        std::copy_n(piece.bytes.data()+static_cast<std::size_t>(row)*piece.width*4,
          static_cast<std::size_t>(piece.width)*4,
          bytes.data()+(static_cast<std::size_t>(at.y+row)*dims[0]+at.x)*4);
    }
    const auto name = "tiles-"+std::to_string(page)+".png";
    writePreparedPng(staging/name, dims[0], dims[1], bytes);
    result.pages.push_back({name, dims[0], dims[1]});
  }
  for (std::size_t source = 0; source < result.sources.size(); ++source)
    for (std::size_t region = 0; region < result.sources[source].regions.size(); ++region) {
      auto& r = result.sources[source].regions[region];
      const auto at = best.positions[sourcePieces[source][region]];
      r.page = at.page; r.atlas = {at.x+halo, at.y+halo, r.rect[2], r.rect[3]};
    }
  return result;
}
}
