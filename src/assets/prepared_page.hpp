#pragma once

#include <cstddef>
#include <cstdint>
#include <array>
#include <filesystem>
#include <optional>
#include <span>
#include <vector>

namespace pmjs {
struct PreparedPagePixels;
struct SparsePalettePage {
  int width = 0, height = 0, indexBytes = 2;
  std::vector<std::uint8_t> base, colors, residual;
  // Low/high occupancy words and a block-major residual offset for each 8×8 block.
  std::vector<std::array<std::uint32_t, 3>> blocks;
  // A packed page stores one byte per pixel and has no exceptional blocks.
  bool packed = false;
  std::size_t gpuBytes() const;
  std::size_t cpuBytes() const { return base.capacity() + colors.capacity() + residual.capacity() + blocks.capacity() * 12; }
  std::vector<std::uint8_t> denseIndices() const;
  void copyRow(int x, int y, std::span<std::uint8_t> rgba) const;
  PreparedPagePixels pixels() const;
};
struct PreparedPagePixels {
  int width = 0, height = 0;
  std::vector<std::uint8_t> rgba;
};
struct ChannelBlockPage {
  int width = 0, height = 0;
  std::vector<std::array<std::uint32_t, 4>> blocks;
  std::vector<std::uint8_t> bytes;
  std::size_t gpuBytes() const;
  PreparedPagePixels pixels() const;
};
std::optional<ChannelBlockPage> makeChannelBlockPage(int width, int height,
    std::span<const std::uint8_t> rgba, std::size_t retainedLimit = 0);
void writeLz4Page(const std::filesystem::path& path, int width, int height,
                  std::span<const std::uint8_t> rgba, bool sparsePalette = false,
                  std::uint64_t* retainedBytes = nullptr);
std::optional<PreparedPagePixels> readLz4Page(std::span<const std::uint8_t> encoded,
                                           std::size_t maxDecodedBytes);
// Extended color tables are in-memory only; encoded pages retain sixteen-bit indices.
std::optional<SparsePalettePage> makeSparsePalettePage(int width, int height,
    std::span<const std::uint8_t> rgba, std::size_t colorLimit = 65536);
std::optional<SparsePalettePage> makeIndexedPalettePage(int width, int height,
    std::span<const std::uint8_t> rgba);
std::optional<SparsePalettePage> readSparsePalettePage(std::span<const std::uint8_t> encoded,
    std::size_t maxDecodedBytes);
std::optional<SparsePalettePage> readIndexedPalettePage(std::span<const std::uint8_t> encoded,
    std::size_t maxDecodedBytes);
std::vector<std::uint8_t> compressLz4Artifact(std::span<const std::uint8_t> bytes);
std::optional<std::vector<std::uint8_t>> decompressLz4Artifact(
    std::span<const std::uint8_t> encoded, std::size_t maxDecodedBytes);
}
