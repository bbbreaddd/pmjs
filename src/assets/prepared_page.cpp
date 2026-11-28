#include "prepared_page.hpp"

#include <array>
#include <algorithm>
#include <bit>
#include <unordered_map>
#include <cstring>
#include <cstdio>
#include <memory>
#include <stdexcept>
#include <lz4.h>
#include <zlib.h>

namespace pmjs {
namespace {
constexpr std::size_t headerBytes = 32;
constexpr std::size_t artifactHeaderBytes = 24;
constexpr std::uint32_t maximumExtent = 2048;
constexpr std::size_t maximumArtifactBytes = 64U * 1024U * 1024U;
std::uint32_t checksum(std::span<const std::uint8_t> bytes) {
  return static_cast<std::uint32_t>(crc32(0, bytes.data(), static_cast<uInt>(bytes.size())));
}
void put(std::span<std::uint8_t> bytes, std::size_t offset, std::uint32_t value) {
  for (int i = 0; i < 4; ++i) bytes[offset + i] = static_cast<std::uint8_t>(value >> (8 * i));
}
std::uint32_t get(std::span<const std::uint8_t> bytes, std::size_t offset) {
  std::uint32_t value = 0;
  for (int i = 0; i < 4; ++i) value |= static_cast<std::uint32_t>(bytes[offset + i]) << (8 * i);
  return value;
}
unsigned paletteIndex(const SparsePalettePage& page, std::size_t pixel) {
  unsigned index = page.base[pixel];
  if (!page.packed && index == 255) {
    const int x = pixel % page.width, y = pixel / page.width;
    const int bit = (y % 8) * 8 + x % 8;
    const auto& block = page.blocks[(y / 8) * ((page.width + 7) / 8) + x / 8];
    const auto rank = std::popcount(block[bit / 32] & ((1U << (bit % 32)) - 1)) +
      (bit >= 32 ? std::popcount(block[0]) : 0);
    const auto at = (block[2] + rank) * page.indexBytes;
    index = page.residual[at] | (unsigned(page.residual[at + 1]) << 8);
    if (page.indexBytes == 3) index |= unsigned(page.residual[at + 2]) << 16;
  }
  return index;
}
}
void writeLz4Page(const std::filesystem::path& path, int width, int height,
                  std::span<const std::uint8_t> rgba, bool sparsePalette, std::uint64_t* retainedBytes) {
  if (width <= 0 || height <= 0 || width > static_cast<int>(maximumExtent) ||
      height > static_cast<int>(maximumExtent) || rgba.size() != static_cast<std::size_t>(width) * height * 4)
    throw std::runtime_error("invalid LZ4 page extent");
  std::vector<std::uint8_t> payload;
  std::optional<SparsePalettePage> sparse;
  if (sparsePalette) {
    sparse = makeIndexedPalettePage(width, height, rgba);
    if (!sparse) sparse = makeSparsePalettePage(width, height, rgba);
  }
  // Raw pages retain RGBA recovery pixels and at least one GPU byte per pixel.
  if (retainedBytes) *retainedBytes = sparse
    ? sparse->base.size() + sparse->colors.size() + sparse->residual.size() + sparse->blocks.size()*12 + sparse->gpuBytes()
    : std::uint64_t(width)*height*5;
  if (sparse) {
    if (sparse->packed) {
      payload.resize(4 + sparse->colors.size() + sparse->base.size());
      put(payload, 0, sparse->colors.size() / 4);
      std::size_t at = 4;
      for (const auto* bytes : {&sparse->colors, &sparse->base}) {
        std::copy(bytes->begin(), bytes->end(), payload.begin() + at);
        at += bytes->size();
      }
      const auto colors = sparse->colors.size() / 4;
      for (std::size_t i = 0; i < sparse->base.size(); ++i) {
        const auto index = sparse->base[i];
        if (index >= colors ||
            std::memcmp(sparse->colors.data() + index * 4, rgba.data() + i * 4, 4))
          throw std::runtime_error("indexed palette reconstruction differs from source");
      }
    } else {
      payload.resize(8 + sparse->colors.size() + sparse->base.size() + sparse->blocks.size() * 12 + sparse->residual.size());
      put(payload, 0, sparse->colors.size() / 4); put(payload, 4, sparse->residual.size() / 2);
      std::size_t at = 8;
      const auto copy = [&](std::span<const std::uint8_t> bytes) {
        std::copy(bytes.begin(), bytes.end(), payload.begin() + at); at += bytes.size();
      };
      copy(sparse->colors); copy(sparse->base);
      for (const auto& block : sparse->blocks) for (auto word : block) { put(payload, at, word); at += 4; }
      copy(sparse->residual);
      const auto indices = sparse->denseIndices();
      for (std::size_t i = 0; i < indices.size() / 2; ++i) {
        const auto index = unsigned(indices[i * 2]) | (unsigned(indices[i * 2 + 1]) << 8);
        if (std::memcmp(sparse->colors.data() + index * 4, rgba.data() + i * 4, 4))
          throw std::runtime_error("sparse palette reconstruction differs from source");
      }
    }
    rgba = payload;
  }
  std::vector<char> compressed(static_cast<std::size_t>(LZ4_compressBound(static_cast<int>(rgba.size()))));
  const int length = LZ4_compress_default(reinterpret_cast<const char*>(rgba.data()), compressed.data(),
    static_cast<int>(rgba.size()), static_cast<int>(compressed.size()));
  if (length <= 0) throw std::runtime_error("cannot compress LZ4 page");
  std::array<std::uint8_t, headerBytes> header{};
  std::memcpy(header.data(), "PML4", 4);
  put(header, 4, sparse ? (sparse->packed ? 3 : 2) : 1); put(header, 8, width); put(header, 12, height);
  put(header, 16, rgba.size()); put(header, 20, length);
  put(header, 24, checksum(rgba)); put(header, 28, checksum(std::span(header).first(28)));
  std::unique_ptr<FILE, int(*)(FILE*)> file(std::fopen(path.c_str(), "wb"), &std::fclose);
  if (!file || std::fwrite(header.data(), 1, header.size(), file.get()) != header.size() ||
      std::fwrite(compressed.data(), 1, length, file.get()) != static_cast<std::size_t>(length))
    throw std::runtime_error("cannot write LZ4 page");
  if (std::fclose(file.release()) != 0) throw std::runtime_error("cannot write LZ4 page");
}
std::optional<PreparedPagePixels> readLz4Page(std::span<const std::uint8_t> encoded,
                                           std::size_t maxDecodedBytes) {
  if (encoded.size() >= headerBytes && !std::memcmp(encoded.data(), "PML4", 4) &&
      (get(encoded, 4) == 2 || get(encoded, 4) == 3)) {
    auto sparse = get(encoded, 4) == 3 ? readIndexedPalettePage(encoded, maxDecodedBytes) :
      readSparsePalettePage(encoded, maxDecodedBytes);
    return sparse ? std::optional(sparse->pixels()) : std::nullopt;
  }
  if (encoded.size() < headerBytes || std::memcmp(encoded.data(), "PML4", 4) || get(encoded, 4) != 1 ||
      get(encoded, 28) != checksum(encoded.first(28))) return std::nullopt;
  const auto width = get(encoded, 8), height = get(encoded, 12);
  const auto decoded = get(encoded, 16), length = get(encoded, 20);
  if (!width || !height || width > maximumExtent || height > maximumExtent ||
      decoded != width * height * 4 || decoded > maxDecodedBytes || !length ||
      length > static_cast<unsigned>(LZ4_compressBound(static_cast<int>(decoded))) ||
      encoded.size() != headerBytes + static_cast<std::size_t>(length)) return std::nullopt;
  PreparedPagePixels pixels{static_cast<int>(width), static_cast<int>(height), std::vector<std::uint8_t>(decoded)};
  if (LZ4_decompress_safe(reinterpret_cast<const char*>(encoded.data() + headerBytes),
        reinterpret_cast<char*>(pixels.rgba.data()), static_cast<int>(length), static_cast<int>(decoded)) !=
        static_cast<int>(decoded) || checksum(pixels.rgba) != get(encoded, 24)) return std::nullopt;
  return pixels;
}
std::size_t ChannelBlockPage::gpuBytes() const {
  return blocks.size() * 16 + ((bytes.size() + 8191) / 8192) * 8192;
}
PreparedPagePixels ChannelBlockPage::pixels() const {
  PreparedPagePixels result{width, height, std::vector<std::uint8_t>(std::size_t(width) * height * 4)};
  for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x)
    for (int channel = 0; channel < 4; ++channel) {
      const auto entry = blocks[std::size_t(y / 8) * ((width + 7) / 8) + x / 8][channel];
      result.rgba[(std::size_t(y) * width + x) * 4 + channel] = entry & 0x80000000U ?
        entry & 255U : bytes[entry + (y % 8) * 8 + x % 8];
    }
  return result;
}
std::optional<ChannelBlockPage> makeChannelBlockPage(int width, int height,
    std::span<const std::uint8_t> rgba, std::size_t retainedLimit, bool exportPlan) {
  if (width <= 0 || height <= 0 || width > 16384 || height > 16384 ||
      std::uint64_t(width)*height*4 > 128U*1024U*1024U ||
      rgba.size() != std::size_t(width) * height * 4 || rgba.size() < 256 * 1024) return std::nullopt;
  struct Hash {
    std::size_t operator()(const std::array<std::uint8_t, 64>& bytes) const {
      std::size_t hash = 14695981039346656037ULL;
      for (auto value : bytes) hash = (hash ^ value) * 1099511628211ULL;
      return hash;
    }
  };
  ChannelBlockPage page;
  page.width = width; page.height = height;
  const std::size_t cols = static_cast<std::size_t>((width + 7) / 8);
  const std::size_t rows = static_cast<std::size_t>((height + 7) / 8);
  page.blocks.resize(cols * rows);
  std::unordered_map<std::array<std::uint8_t, 64>, std::uint32_t, Hash> dictionary;
  const bool buildPlan = exportPlan && cols * rows * 4 >= 16384U;
  std::vector<std::uint8_t> planStream;
  std::uint32_t uniformRun = 0;
  auto flushUniform = [&]() {
    while (uniformRun > 0) {
      const std::uint32_t chunk = std::min<std::uint32_t>(uniformRun, 128U);
      planStream.push_back(static_cast<std::uint8_t>(chunk - 1U));
      uniformRun -= chunk;
    }
  };
  for (int by = 0; by < height; by += 8) for (int bx = 0; bx < width; bx += 8)
    for (int channel = 0; channel < 4; ++channel) {
      std::array<std::uint8_t, 64> block;
      for (int y = 0; y < 8; ++y) for (int x = 0; x < 8; ++x)
        block[y * 8 + x] = rgba[(std::size_t(std::min(by + y, height - 1)) * width +
          std::min(bx + x, width - 1)) * 4 + channel];
      auto& entry = page.blocks[std::size_t(by / 8) * cols + bx / 8][channel];
      if (std::all_of(block.begin(), block.end(), [&](auto value) { return value == block[0]; })) {
        entry = 0x80000000U | block[0];
        if (buildPlan) ++uniformRun;
      } else {
        const auto [at, inserted] = dictionary.try_emplace(block, page.bytes.size());
        if (inserted) page.bytes.insert(page.bytes.end(), block.begin(), block.end());
        entry = at->second;
        if (buildPlan) {
          flushUniform();
          std::uint32_t idx = entry / 64U;
          std::uint8_t first = static_cast<std::uint8_t>(0x80U | (idx & 0x3FU));
          idx >>= 6U;
          if (idx) first |= 0x40U;
          planStream.push_back(first);
          while (idx) {
            std::uint8_t next = static_cast<std::uint8_t>(idx & 0x7FU);
            idx >>= 7U;
            if (idx) next |= 0x80U;
            planStream.push_back(next);
          }
        }
      }
    }
  if (buildPlan) flushUniform();
  if (page.bytes.empty() || (retainedLimit ? page.gpuBytes() >= retainedLimit :
      page.gpuBytes() * 100 > rgba.size() * 85)) return std::nullopt;
  if (buildPlan) {
    ChannelBlockPlan plan;
    plan.width = width;
    plan.height = height;
    plan.uniqueCount = static_cast<std::uint32_t>(page.bytes.size() / 64U);
    plan.stream = std::move(planStream);
    page.plan = std::move(plan);
  }
  return page;
}

std::optional<ChannelBlockPage> replayChannelBlockPage(int width, int height,
    std::span<const std::uint8_t> rgba, const ChannelBlockPlan& plan, std::size_t retainedLimit) {
  if (width <= 0 || height <= 0 || width > 16384 || height > 16384 ||
      std::uint64_t(width) * height * 4 > 128U * 1024U * 1024U ||
      rgba.size() != std::size_t(width) * height * 4 || rgba.size() < 256 * 1024 ||
      plan.width != width || plan.height != height || plan.uniqueCount == 0) return std::nullopt;
  const std::size_t cols = static_cast<std::size_t>((width + 7) / 8);
  const std::size_t rows = static_cast<std::size_t>((height + 7) / 8);
  const std::size_t totalEntries = cols * rows * 4U;
  if (plan.uniqueCount > totalEntries) return std::nullopt;
  ChannelBlockPage page;
  page.width = width;
  page.height = height;
  page.blocks.resize(cols * rows);
  page.bytes.resize(static_cast<std::size_t>(plan.uniqueCount) * 64U);
  std::size_t cursor = 0;
  std::size_t entryIndex = 0;
  std::uint32_t nextUnique = 0;
  auto extractBlock = [&](std::size_t idx, std::array<std::uint8_t, 64>& out) {
    const std::size_t blockIdx = idx >> 2U;
    const int channel = static_cast<int>(idx & 3U);
    const int bx = static_cast<int>(blockIdx % cols) * 8;
    const int by = static_cast<int>(blockIdx / cols) * 8;
    for (int y = 0; y < 8; ++y) {
      const int sy = std::min(by + y, height - 1);
      for (int x = 0; x < 8; ++x) {
        const int sx = std::min(bx + x, width - 1);
        out[y * 8 + x] = rgba[(static_cast<std::size_t>(sy) * width + sx) * 4 + channel];
      }
    }
  };
  std::array<std::uint8_t, 64> block;
  while (cursor < plan.stream.size() && entryIndex < totalEntries) {
    const std::uint8_t tag = plan.stream[cursor++];
    if ((tag & 0x80U) == 0) {
      const std::size_t run = static_cast<std::size_t>(tag) + 1U;
      if (entryIndex + run > totalEntries) return std::nullopt;
      for (std::size_t k = 0; k < run; ++k) {
        extractBlock(entryIndex, block);
        const std::uint8_t v = block[0];
        if (!std::all_of(block.begin(), block.end(), [v](std::uint8_t b) { return b == v; }))
          return std::nullopt;
        page.blocks[entryIndex >> 2U][entryIndex & 3U] = 0x80000000U | v;
        ++entryIndex;
      }
    } else {
      std::uint32_t dictIdx = tag & 0x3FU;
      if (tag & 0x40U) {
        int shift = 6;
        for (;;) {
          if (cursor >= plan.stream.size() || shift > 28) return std::nullopt;
          const std::uint8_t b = plan.stream[cursor++];
          dictIdx |= static_cast<std::uint32_t>(b & 0x7FU) << shift;
          if ((b & 0x80U) == 0) break;
          shift += 7;
        }
      }
      if (dictIdx > nextUnique || dictIdx >= plan.uniqueCount) return std::nullopt;
      extractBlock(entryIndex, block);
      auto* slot = page.bytes.data() + static_cast<std::size_t>(dictIdx) * 64U;
      if (dictIdx == nextUnique) {
        std::memcpy(slot, block.data(), 64);
        ++nextUnique;
      } else if (std::memcmp(slot, block.data(), 64) != 0) {
        return std::nullopt;
      }
      page.blocks[entryIndex >> 2U][entryIndex & 3U] = dictIdx * 64U;
      ++entryIndex;
    }
  }
  if (cursor != plan.stream.size() || entryIndex != totalEntries || nextUnique != plan.uniqueCount)
    return std::nullopt;
  if (retainedLimit ? page.gpuBytes() >= retainedLimit : page.gpuBytes() * 100 > rgba.size() * 85)
    return std::nullopt;
  return page;
}
std::size_t SparsePalettePage::gpuBytes() const {
  const auto texels = residual.size() / (indexBytes == 3 ? 1 : 2);
  const auto residualWidth = std::min<std::size_t>(indexBytes == 3 ? 2048 : 1024, texels);
  return base.size() + blocks.size() * 12 + ((colors.size() + 1023) / 1024) * 1024 +
    (residualWidth ? ((texels + residualWidth - 1) / residualWidth) * residualWidth * (indexBytes == 3 ? 1 : 2) : 0);
}
std::vector<std::uint8_t> SparsePalettePage::denseIndices() const {
  std::vector<std::uint8_t> indices(base.size() * indexBytes);
  if (packed) {
    for (std::size_t i = 0; i < base.size(); ++i) indices[i * indexBytes] = base[i];
    return indices;
  }
  for (std::size_t i = 0; i < base.size(); ++i) {
    const unsigned index = paletteIndex(*this, i);
    for (int byte = 0; byte < indexBytes; ++byte) indices[i * indexBytes + byte] = index >> (byte * 8);
  }
  return indices;
}
void SparsePalettePage::copyRow(int x, int y, std::span<std::uint8_t> rgba) const {
  const auto first = static_cast<std::size_t>(y) * width + x;
  for (std::size_t i = 0; i < rgba.size() / 4; ++i)
    std::copy_n(colors.data() + paletteIndex(*this, first + i) * 4, 4, rgba.data() + i * 4);
}
PreparedPagePixels SparsePalettePage::pixels() const {
  PreparedPagePixels result{width, height, std::vector<std::uint8_t>(base.size() * 4)};
  for (int y = 0; y < height; ++y)
    copyRow(0, y, std::span(result.rgba).subspan(static_cast<std::size_t>(y) * width * 4, width * 4));
  return result;
}
std::optional<SparsePalettePage> makeSparsePalettePage(int width, int height,
    std::span<const std::uint8_t> rgba, std::size_t colorLimit) {
  if (width <= 0 || height <= 0 || width > 8192 || height > 8192 ||
      rgba.size() != std::size_t(width) * height * 4 || rgba.size() < 256 * 1024) return std::nullopt;
  struct Color { std::uint32_t value, count; };
  std::vector<Color> colors;
  std::unordered_map<std::uint32_t, std::uint32_t> lookup;
  for (std::size_t i = 0; i < rgba.size();) {
    const auto value = get(rgba, i);
    auto end = i + 4;
    while (end < rgba.size() && get(rgba, end) == value) end += 4;
    auto [at, inserted] = lookup.try_emplace(value, colors.size());
    if (inserted) {
      if (colors.size() == std::min<std::size_t>(colorLimit, 262144)) return std::nullopt;
      colors.push_back({value, 0});
    }
    colors[at->second].count += (end - i) / 4;
    i = end;
  }
  if (colors.size() <= 256) return std::nullopt;
  std::sort(colors.begin(), colors.end(), [](const auto& a, const auto& b) {
    return a.count != b.count ? a.count > b.count : a.value < b.value;
  });
  std::size_t exceptions = 0;
  for (std::size_t i = 255; i < colors.size(); ++i) exceptions += colors[i].count;
  if (colorLimit <= 65536 && exceptions > rgba.size() / 4 / 16) return std::nullopt;
  SparsePalettePage page;
  page.width = width; page.height = height; page.indexBytes = colors.size() > 65536 ? 3 : 2;
  page.base.resize(rgba.size() / 4); page.colors.resize(colors.size() * 4);
  page.blocks.resize(std::size_t((width + 7) / 8) * ((height + 7) / 8));
  page.residual.reserve(exceptions * page.indexBytes);
  for (std::size_t i = 0; i < colors.size(); ++i) { put(page.colors, i * 4, colors[i].value); lookup[colors[i].value] = i; }
  for (int by = 0; by < height; by += 8) for (int bx = 0; bx < width; bx += 8) {
    auto& block = page.blocks[(by / 8) * ((width + 7) / 8) + bx / 8];
    block[2] = page.residual.size() / page.indexBytes;
    for (int y = by; y < std::min(by + 8, height); ++y) for (int x = bx; x < std::min(bx + 8, width); ++x) {
      const auto pixel = std::size_t(y) * width + x;
      const auto index = lookup.at(get(rgba, pixel * 4));
      page.base[pixel] = std::min<std::uint32_t>(index, 255);
      if (index >= 255) {
        const auto bit = (y % 8) * 8 + x % 8;
        block[bit / 32] |= 1U << (bit % 32);
        for (int byte = 0; byte < page.indexBytes; ++byte) page.residual.push_back(index >> (byte * 8));
      }
    }
  }
  const auto denseBytes = page.base.size() * page.indexBytes + ((page.colors.size() + 1023) / 1024) * 1024;
  if (page.gpuBytes() * 100 > denseBytes * 85) return std::nullopt;
  return page;
}
std::optional<SparsePalettePage> makeIndexedPalettePage(int width, int height,
    std::span<const std::uint8_t> rgba) {
  if (width <= 0 || height <= 0 || width > int(maximumExtent) || height > int(maximumExtent) ||
      rgba.size() != std::size_t(width) * height * 4) return std::nullopt;
  const auto count = rgba.size() / 4;
  if (count < 4096) return std::nullopt;
  std::vector<std::uint32_t> colors;
  std::unordered_map<std::uint32_t, std::uint16_t> lookup;
  for (std::size_t i = 0; i < count;) {
    const auto value = get(rgba, i * 4);
    auto end = i + 1;
    while (end < count && get(rgba, end * 4) == value) ++end;
    if (!lookup.contains(value)) {
      if (colors.size() == 256) return std::nullopt;
      lookup.emplace(value, static_cast<std::uint16_t>(colors.size()));
      colors.push_back(value);
    }
    i = end;
  }
  SparsePalettePage page;
  page.width = width; page.height = height; page.packed = true;
  page.colors.resize(colors.size() * 4);
  for (std::size_t i = 0; i < colors.size(); ++i) put(page.colors, i * 4, colors[i]);
  page.base.resize(count);
  for (std::size_t i = 0; i < count;) {
    const auto value = get(rgba, i * 4);
    auto end = i + 1;
    while (end < count && get(rgba, end * 4) == value) ++end;
    std::fill(page.base.begin() + i, page.base.begin() + end, static_cast<std::uint8_t>(lookup.at(value)));
    i = end;
  }
  if (page.gpuBytes() >= rgba.size()) return std::nullopt;
  return page;
}
std::optional<SparsePalettePage> readSparsePalettePage(std::span<const std::uint8_t> encoded,
    std::size_t maxDecodedBytes) {
  if (encoded.size() < headerBytes || std::memcmp(encoded.data(), "PML4", 4) || get(encoded, 4) != 2 ||
      get(encoded, 28) != checksum(encoded.first(28))) return std::nullopt;
  const auto width = get(encoded, 8), height = get(encoded, 12), decoded = get(encoded, 16), length = get(encoded, 20);
  if (!width || !height || width > maximumExtent || height > maximumExtent || width * height * 4 > maxDecodedBytes ||
      decoded < 8 || decoded > width * height * 4 || !length ||
      length > unsigned(LZ4_compressBound(int(decoded))) || encoded.size() != headerBytes + std::size_t(length)) return std::nullopt;
  std::vector<std::uint8_t> packed(decoded);
  if (LZ4_decompress_safe(reinterpret_cast<const char*>(encoded.data() + headerBytes),
      reinterpret_cast<char*>(packed.data()), length, decoded) != int(decoded) || checksum(packed) != get(encoded, 24)) return std::nullopt;
  const auto colors = get(packed, 0), residuals = get(packed, 4);
  const auto count = std::size_t(width) * height, blocks = std::size_t((width + 7) / 8) * ((height + 7) / 8);
  if (colors <= 256 || colors > 65536 || !residuals || residuals > count / 16 ||
      packed.size() != 8 + colors * 4 + count + blocks * 12 + residuals * 2) return std::nullopt;
  SparsePalettePage page;
  page.width = width; page.height = height;
  page.colors.assign(packed.begin() + 8, packed.begin() + 8 + colors * 4);
  std::size_t at = 8 + colors * 4;
  page.base.assign(packed.begin() + at, packed.begin() + at + count); at += count;
  page.blocks.resize(blocks);
  for (auto& block : page.blocks) for (auto& word : block) { word = get(packed, at); at += 4; }
  page.residual.assign(packed.begin() + at, packed.end());
  std::size_t offset = 0;
  for (unsigned by = 0; by < height; by += 8) for (unsigned bx = 0; bx < width; bx += 8) {
    const auto& block = page.blocks[(by / 8) * ((width + 7) / 8) + bx / 8];
    if (block[2] != offset) return std::nullopt;
    for (unsigned bit = 0; bit < 64; ++bit) {
      const auto x = bx + bit % 8, y = by + bit / 8;
      const bool exceptional = (block[bit / 32] >> (bit % 32)) & 1;
      if (x >= width || y >= height) { if (exceptional) return std::nullopt; continue; }
      if ((page.base[y * width + x] == 255) != exceptional) return std::nullopt;
      if (exceptional) {
        if (offset >= residuals) return std::nullopt;
        const auto index = unsigned(page.residual[offset * 2]) | (unsigned(page.residual[offset * 2 + 1]) << 8);
        if (index < 255 || index >= colors) return std::nullopt;
        ++offset;
      }
    }
  }
  if (offset != residuals || page.gpuBytes() * 100 > (count * 2 + ((colors * 4 + 1023) / 1024) * 1024) * 85) return std::nullopt;
  return page;
}
std::optional<SparsePalettePage> readIndexedPalettePage(std::span<const std::uint8_t> encoded,
    std::size_t maxDecodedBytes) {
  if (encoded.size() < headerBytes || std::memcmp(encoded.data(), "PML4", 4) || get(encoded, 4) != 3 ||
      get(encoded, 28) != checksum(encoded.first(28))) return std::nullopt;
  const auto width = get(encoded, 8), height = get(encoded, 12), decoded = get(encoded, 16), length = get(encoded, 20);
  const auto count = std::size_t(width) * height;
  if (!width || !height || width > maximumExtent || height > maximumExtent ||
      decoded < 4 || decoded > maxDecodedBytes || !length ||
      length > unsigned(LZ4_compressBound(int(decoded))) ||
      encoded.size() != headerBytes + std::size_t(length)) return std::nullopt;
  std::vector<std::uint8_t> payload(decoded);
  if (LZ4_decompress_safe(reinterpret_cast<const char*>(encoded.data() + headerBytes),
      reinterpret_cast<char*>(payload.data()), length, decoded) != int(decoded) ||
      checksum(payload) != get(encoded, 24)) return std::nullopt;
  const auto colors = get(payload, 0);
  if (!colors || colors > 256 || decoded != 4 + colors * 4 + count) return std::nullopt;
  SparsePalettePage page;
  page.width = width; page.height = height; page.packed = true;
  page.colors.assign(payload.begin() + 4, payload.begin() + 4 + colors * 4);
  page.base.assign(payload.begin() + 4 + colors * 4, payload.end());
  for (const auto index : page.base) if (index >= colors) return std::nullopt;
  return page;
}
std::vector<std::uint8_t> compressLz4Artifact(std::span<const std::uint8_t> bytes) {
  if (bytes.empty() || bytes.size() > maximumArtifactBytes)
    throw std::runtime_error("invalid prepared artifact size");
  const auto bound = static_cast<std::size_t>(LZ4_compressBound(static_cast<int>(bytes.size())));
  std::vector<std::uint8_t> encoded(artifactHeaderBytes + bound);
  std::memcpy(encoded.data(), "PMA1", 4);
  put(encoded, 4, 1);
  put(encoded, 8, static_cast<std::uint32_t>(bytes.size()));
  const int length = LZ4_compress_default(reinterpret_cast<const char*>(bytes.data()),
    reinterpret_cast<char*>(encoded.data() + artifactHeaderBytes),
    static_cast<int>(bytes.size()), static_cast<int>(bound));
  if (length <= 0) throw std::runtime_error("cannot compress prepared artifact");
  put(encoded, 12, static_cast<std::uint32_t>(length));
  put(encoded, 16, checksum(bytes));
  put(encoded, 20, checksum(std::span(encoded).subspan(artifactHeaderBytes,
    static_cast<std::size_t>(length))));
  encoded.resize(artifactHeaderBytes + static_cast<std::size_t>(length));
  return encoded;
}
std::optional<std::vector<std::uint8_t>> decompressLz4Artifact(
    std::span<const std::uint8_t> encoded, std::size_t maxDecodedBytes) {
  if (encoded.size() < artifactHeaderBytes || std::memcmp(encoded.data(), "PMA1", 4) ||
      get(encoded, 4) != 1) return std::nullopt;
  const auto decoded = get(encoded, 8), length = get(encoded, 12);
  if (!decoded || decoded > maximumArtifactBytes || decoded > maxDecodedBytes || !length ||
      length > static_cast<unsigned>(LZ4_compressBound(static_cast<int>(decoded))) ||
      encoded.size() != artifactHeaderBytes + static_cast<std::size_t>(length) ||
      checksum(encoded.subspan(artifactHeaderBytes)) != get(encoded, 20)) return std::nullopt;
  std::vector<std::uint8_t> bytes(decoded);
  if (LZ4_decompress_safe(reinterpret_cast<const char*>(encoded.data() + artifactHeaderBytes),
        reinterpret_cast<char*>(bytes.data()), static_cast<int>(length), static_cast<int>(decoded)) !=
        static_cast<int>(decoded) || checksum(bytes) != get(encoded, 16)) return std::nullopt;
  return bytes;
}
}
