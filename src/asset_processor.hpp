#pragma once

#include <array>
#include <cstdint>
#include <cstddef>
#include <filesystem>
#include <optional>
#include <stdexcept>
#include <vector>
#include <string>

namespace pmjs {
class AssetPreparationDecodeError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};
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
  bool framePages = false;
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
  std::optional<std::array<int, 3>> blockGrid;
  std::optional<int> blockChannels = std::nullopt;
  std::optional<bool> compactEligible = std::nullopt;
  std::vector<PreparedAssetCell> cells;
  std::vector<PreparedAssetPage> pages;
  std::string compression;
  std::filesystem::path textureArtifact;
  bool framePages = false;
  std::uint64_t ordinaryRetainedBytes = 0, textureRetainedBytes = 0;
};
struct AssetPreparationStats {
  std::uint64_t sourceDecodes = 0, sourceCacheHits = 0;
  std::uint64_t pngEncodes = 0, encodedPixels = 0;
  std::uint64_t lz4Encodes = 0;
  std::uint64_t temporaryFiles = 0, spillBytesWritten = 0, spillBytesRead = 0;
  std::size_t workspaceLimitBytes = 0, peakWorkspaceBytes = 0, liveWorkspaceBytes = 0;
  bool workspaceConstrained = false;
};
struct AssetPreparationOptions {
  std::size_t workspaceBytes = 256U * 1024U * 1024U;
  AssetPreparationStats* statistics = nullptr;
  bool lz4Pages = false;
  bool allowAstc = false;
  std::string astcQuality = "medium";
};
void writePreparedPng(const std::filesystem::path& path, int width, int height,
                      const std::vector<std::uint8_t>& bytes);
PreparedAsset prepareAssetImage(const std::filesystem::path& source,
                               const std::filesystem::path& staging,
                               const AssetRecipe& recipe = {},
                               const PreparedAsset* layout = nullptr,
                               const AssetPreparationOptions& options = {});
}
