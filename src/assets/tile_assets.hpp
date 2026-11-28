#pragma once

#include "asset_processor.hpp"
#include "graphics/resources.hpp"
#include <list>
#include <mutex>
#include <unordered_map>

namespace pmjs {
struct TileAssetInput {
  std::shared_ptr<ImageFileSource> source;
  std::vector<AssetRect> rectangles;
  std::string sourceHash;
};
struct TileAssetSource {
  int width = 0, height = 0;
  std::vector<PreparedAssetCell> regions;
};
struct PreparedTileAssets {
  int version = 1, halo = 1;
  std::vector<TileAssetSource> sources;
  std::vector<PreparedAssetPage> pages;
  std::size_t ordinaryBytes = 0, pageBytes = 0;
};
class TileDecodeCache {
 public:
  std::shared_ptr<const ImagePixels> getOrDecode(const ImageFileSource& source,
                                                 std::size_t decodeBudget,
                                                 std::size_t pageAndMetadataReserve = 0);
  bool evictForReserve(std::size_t reserveBytes);
  void clear();
  std::size_t liveBytes();

 private:
  struct Entry {
    std::shared_ptr<const ImagePixels> image;
    std::size_t bytes = 0;
    std::list<std::string>::iterator lruIt;
  };
  static constexpr std::size_t cacheLimitBytes_ = 32U * 1024U * 1024U;
  static constexpr std::size_t totalBudgetBytes_ = 64U * 1024U * 1024U;
  std::mutex mutex_;
  std::list<std::string> lru_;
  std::unordered_map<std::string, Entry> map_;
  std::vector<std::pair<std::shared_ptr<const ImagePixels>, std::size_t>> retiredPinned_;
  std::size_t cachedBytes_ = 0;
  std::size_t retiredBytes_ = 0;
};

std::size_t verifyTileAssets(const std::vector<TileAssetInput>& inputs,
    const PreparedTileAssets& descriptor, const std::filesystem::path& directory);
PreparedTileAssets replayTileAssets(const std::vector<TileAssetInput>& inputs,
    const PreparedTileAssets& layout, const std::filesystem::path& staging,
    TileDecodeCache* cache = nullptr);
PreparedTileAssets prepareTileAssets(const std::vector<TileAssetInput>& inputs,
                                    const std::filesystem::path& staging,
                                    TileDecodeCache* cache = nullptr);
}
