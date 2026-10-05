#pragma once

#include <array>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <stdexcept>
#include <vector>

namespace pmjs {
class AssetPreparationUnsupported : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};
using AssetColor = std::array<std::uint8_t, 4>;
using AssetRect = std::array<int, 4>;
struct AssetRecipe {
  int columns = 1;
  int rows = 1;
  std::optional<AssetRect> crop;
  AssetColor backdrop{};
};
struct PreparedAssetCell {
  AssetRect rect{};
  AssetRect crop{};
  AssetColor fill{};
  int page = -1;
  AssetRect atlas{};
};
struct PreparedAssetPage {
  std::filesystem::path path;
  int width = 0;
  int height = 0;
};
struct PreparedAsset {
  int width = 0;
  int height = 0;
  int halo = 0;
  std::optional<AssetColor> uniform;
  std::vector<PreparedAssetCell> cells;
  std::vector<PreparedAssetPage> pages;
};
PreparedAsset prepareAssetImage(const std::filesystem::path& source,
                               const std::filesystem::path& staging,
                               const AssetRecipe& recipe = {});
}
