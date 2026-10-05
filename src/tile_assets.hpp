#pragma once

#include "asset_processor.hpp"
#include "resources.hpp"

namespace pmjs {
struct TileAssetInput {
  std::shared_ptr<ImageFileSource> source;
  std::vector<AssetRect> rectangles;
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
std::size_t verifyTileAssets(const std::vector<TileAssetInput>& inputs,
    const PreparedTileAssets& descriptor, const std::filesystem::path& directory);
PreparedTileAssets prepareTileAssets(const std::vector<TileAssetInput>& inputs,
                                    const std::filesystem::path& staging);
}
