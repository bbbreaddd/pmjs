#include "asset_processor.hpp"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <png.h>

namespace pmjs {
namespace {
constexpr int pageLimit = 2048;
constexpr std::size_t rowLimit = 1U * 1024U * 1024U;

class PngRows {
 public:
  explicit PngRows(const std::filesystem::path& path) {
    file_ = std::fopen(path.c_str(), "rb");
    if (!file_) throw std::runtime_error("cannot open preparation source");
    png_ = png_create_read_struct(PNG_LIBPNG_VER_STRING, nullptr, nullptr, nullptr);
    info_ = png_ ? png_create_info_struct(png_) : nullptr;
    if (!info_) { close(); throw std::runtime_error("cannot create PNG reader"); }
    if (setjmp(png_jmpbuf(png_))) { close(); throw std::runtime_error("invalid preparation PNG"); }
    png_set_chunk_malloc_max(png_, 1024U * 1024U);
    png_init_io(png_, file_);
    png_read_info(png_, info_);
    const auto w = png_get_image_width(png_, info_);
    const auto h = png_get_image_height(png_, info_);
    if (!w || !h || w > rowLimit / 4 || h > static_cast<unsigned>(std::numeric_limits<int>::max()) ||
        png_get_interlace_type(png_, info_) != PNG_INTERLACE_NONE) {
      close(); throw AssetPreparationUnsupported("preparation requires a bounded noninterlaced PNG");
    }
    width = static_cast<int>(w); height = static_cast<int>(h);
    const int color = png_get_color_type(png_, info_);
    const int depth = png_get_bit_depth(png_, info_);
    if (depth == 16) {
      close(); throw AssetPreparationUnsupported("16-bit PNG preparation requires the ordinary decoder");
    }
    if (color == PNG_COLOR_TYPE_PALETTE) png_set_palette_to_rgb(png_);
    if (color == PNG_COLOR_TYPE_GRAY && depth < 8) png_set_expand_gray_1_2_4_to_8(png_);
    const bool transparency = png_get_valid(png_, info_, PNG_INFO_tRNS);
    if (transparency) png_set_tRNS_to_alpha(png_);
    if (color == PNG_COLOR_TYPE_GRAY || color == PNG_COLOR_TYPE_GRAY_ALPHA) png_set_gray_to_rgb(png_);
    if (!(color & PNG_COLOR_MASK_ALPHA) && !transparency) png_set_add_alpha(png_, 255, PNG_FILLER_AFTER);
    png_set_alpha_mode(png_, PNG_ALPHA_PNG, PNG_DEFAULT_sRGB);
    png_read_update_info(png_, info_);
    if (png_get_rowbytes(png_, info_) != static_cast<std::size_t>(width) * 4) {
      close(); throw std::runtime_error("unexpected preparation PNG format");
    }
    row.resize(static_cast<std::size_t>(width) * 4);
  }
  ~PngRows() { close(); }
  PngRows(const PngRows&) = delete;
  PngRows& operator=(const PngRows&) = delete;
  void read() {
    if (setjmp(png_jmpbuf(png_))) throw std::runtime_error("cannot decode preparation PNG row");
    png_read_row(png_, row.data(), nullptr);
  }
  void finish() {
    if (setjmp(png_jmpbuf(png_))) throw std::runtime_error("cannot finish preparation PNG");
    png_read_end(png_, info_);
  }
  int width = 0, height = 0;
  std::vector<std::uint8_t> row;
 private:
  void close() {
    if (png_) png_destroy_read_struct(&png_, info_ ? &info_ : nullptr, nullptr);
    if (file_) std::fclose(file_);
    png_ = nullptr; info_ = nullptr; file_ = nullptr;
  }
  FILE* file_ = nullptr;
  png_structp png_ = nullptr;
  png_infop info_ = nullptr;
};

AssetColor pixel(const std::uint8_t* bytes) { return {bytes[0], bytes[1], bytes[2], bytes[3]}; }
bool inside(int x, int y, const AssetRect& rect) {
  return x >= rect[0] && y >= rect[1] && x - rect[0] < rect[2] && y - rect[1] < rect[3];
}
void writePng(const std::filesystem::path& path, int width, int height,
              const std::vector<std::uint8_t>& bytes) {
  std::unordered_map<std::uint32_t, std::uint8_t> colors;
  colors.reserve(256);
  std::array<std::uint8_t, 1024> palette{};
  auto colorKey = [](const std::uint8_t* rgba) {
    return static_cast<std::uint32_t>(rgba[0]) |
      (static_cast<std::uint32_t>(rgba[1]) << 8) |
      (static_cast<std::uint32_t>(rgba[2]) << 16) |
      (static_cast<std::uint32_t>(rgba[3]) << 24);
  };
  bool indexed = true;
  for (std::size_t offset = 0; offset < bytes.size(); offset += 4) {
    const auto key = colorKey(bytes.data() + offset);
    if (colors.contains(key)) continue;
    if (colors.size() == 256) { indexed = false; break; }
    const auto index = static_cast<std::uint8_t>(colors.size());
    colors.emplace(key, index);
    std::copy_n(bytes.data() + offset, 4, palette.data() + index * 4);
  }
  std::vector<std::uint8_t> indices;
  if (indexed) {
    indices.resize(bytes.size() / 4);
    for (std::size_t index = 0; index < indices.size(); ++index)
      indices[index] = colors.at(colorKey(bytes.data() + index * 4));
  }
  png_image image{};
  image.version = PNG_IMAGE_VERSION;
  image.width = static_cast<png_uint_32>(width);
  image.height = static_cast<png_uint_32>(height);
  image.format = indexed ? PNG_FORMAT_RGBA_COLORMAP : PNG_FORMAT_RGBA;
  image.colormap_entries = indexed ? static_cast<png_uint_32>(colors.size()) : 0;
  if (!png_image_write_to_file(&image, path.c_str(), 0,
      indexed ? indices.data() : bytes.data(), 0, indexed ? palette.data() : nullptr)) {
    const std::string error = image.message;
    png_image_free(&image);
    throw std::runtime_error("cannot write prepared PNG: " + error);
  }
  png_image_free(&image);
}
std::vector<std::uint8_t> readBytes(const std::filesystem::path& path, std::size_t size) {
  std::ifstream file(path, std::ios::binary);
  std::vector<std::uint8_t> bytes(size);
  if (!file.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(size)))
    throw std::runtime_error("cannot read preparation tile");
  return bytes;
}
std::uint64_t digest(const std::vector<std::uint8_t>& bytes) {
  std::uint64_t value = 14695981039346656037ULL;
  for (const auto byte : bytes) { value ^= byte; value *= 1099511628211ULL; }
  return value;
}
struct Tile {
  std::filesystem::path path;
  int width = 0, height = 0;
  int page = -1, x = 0, y = 0;
  std::size_t size() const { return static_cast<std::size_t>(width) * height * 4; }
};
}

void writePreparedPng(const std::filesystem::path& path, int width, int height,
                      const std::vector<std::uint8_t>& bytes) {
  if (width <= 0 || height <= 0 || bytes.size() != static_cast<std::size_t>(width)*height*4)
    throw std::runtime_error("invalid prepared PNG extent");
  writePng(path, width, height, bytes);
}

PreparedAsset prepareAssetImage(const std::filesystem::path& source,
                               const std::filesystem::path& staging,
                               const AssetRecipe& recipe) {
  PngRows input(source);
  PreparedAsset result;
  result.width = input.width; result.height = input.height;
  result.halo = (std::max(input.width, input.height) + 1023) / 1024 + 2;
  if (recipe.columns <= 0 || recipe.rows <= 0 || recipe.columns > 4096 ||
      recipe.rows > 4096 / recipe.columns || input.width % recipe.columns || input.height % recipe.rows)
    throw AssetPreparationUnsupported("preparation grid must divide the source exactly");
  const int cellWidth = input.width / recipe.columns, cellHeight = input.height / recipe.rows;
  if (recipe.crop && ((*recipe.crop)[0] < 0 || (*recipe.crop)[1] < 0 ||
      (*recipe.crop)[2] <= 0 || (*recipe.crop)[3] <= 0 ||
      (*recipe.crop)[0] > cellWidth - (*recipe.crop)[2] ||
      (*recipe.crop)[1] > cellHeight - (*recipe.crop)[3]))
    throw AssetPreparationUnsupported("preparation crop is outside a cell");
  const auto count = static_cast<std::size_t>(recipe.columns * recipe.rows);
  result.cells.resize(count);
  for (std::size_t index = 0; index < count; ++index) {
    auto& cell = result.cells[index];
    cell.rect = {static_cast<int>(index % recipe.columns) * cellWidth,
                 static_cast<int>(index / recipe.columns) * cellHeight, cellWidth, cellHeight};
    cell.fill = recipe.crop ? recipe.backdrop : AssetColor{};
    cell.crop = {cellWidth, cellHeight, 0, 0};
  }
  bool allUniform = true;
  AssetColor first{};
  for (int y = 0; y < input.height; ++y) {
    input.read();
    if (y == 0) first = pixel(input.row.data());
    const auto rowIndex = static_cast<std::size_t>(y / cellHeight) * recipe.columns;
    const int localY = y % cellHeight;
    for (int column = 0; column < recipe.columns; ++column) {
      auto& cell = result.cells[rowIndex + column];
      int left = cellWidth, right = 0;
      const auto* row = input.row.data() + static_cast<std::size_t>(cell.rect[0]) * 4;
      for (int x = 0; x < cellWidth; ++x) {
        const auto rgba = pixel(row + static_cast<std::size_t>(x) * 4);
        allUniform = allUniform && rgba == first;
        if (rgba == cell.fill) continue;
        if (recipe.crop && !inside(x, localY, *recipe.crop))
          throw AssetPreparationUnsupported("preparation recipe discards nonconstant pixels");
        left = std::min(left, x);
        right = x + 1;
      }
      if (left == cellWidth) continue;
      if (!cell.crop[2]) cell.crop = {left, localY, right - left, 1};
      else {
        const int end = std::max(cell.crop[0] + cell.crop[2], right);
        cell.crop[0] = std::min(cell.crop[0], left);
        cell.crop[2] = end - cell.crop[0];
        cell.crop[3] = localY - cell.crop[1] + 1;
      }
    }
  }
  input.finish();
  if (allUniform) { result.uniform = first; result.cells.clear(); return result; }
  if (recipe.columns == 1 && recipe.rows == 1 && !recipe.crop &&
      result.cells[0].crop == AssetRect{0, 0, result.width, result.height})
    throw AssetPreparationUnsupported("image has no eligible compact representation");
  std::filesystem::create_directories(staging);
  std::vector<Tile> tiles(count);
  std::vector<std::ofstream> files(count);
  for (std::size_t index = 0; index < count; ++index) {
    auto& cell = result.cells[index];
    if (!cell.crop[2]) { cell.crop = {0, 0, 0, 0}; continue; }
    auto& tile = tiles[index];
    tile.width = cell.crop[2] + result.halo * 2; tile.height = cell.crop[3] + result.halo * 2;
    if (tile.width > pageLimit || tile.height > pageLimit)
      throw AssetPreparationUnsupported("prepared crop exceeds the page limit");
    tile.path = staging / (".tile-" + std::to_string(index));
    std::ofstream file(tile.path, std::ios::binary | std::ios::trunc);
    if (!file) throw std::runtime_error("cannot create preparation tile");
  }
  std::size_t openTileFiles = 0, evictionCursor = 0;
  PngRows extraction(source);
  for (int y = 0; y < result.height; ++y) {
    extraction.read();
    for (std::size_t index = 0; index < count; ++index) {
      const auto& cell = result.cells[index];
      const auto& tile = tiles[index];
      if (!tile.width) continue;
      const int startY = cell.rect[1] + cell.crop[1] - result.halo;
      const int firstY = std::max(0, startY), lastY = std::min(result.height - 1, startY + tile.height - 1);
      if (y < firstY || y > lastY) continue;
      if (!files[index].is_open()) {
        if (openTileFiles >= 128) {
          while (!files[evictionCursor].is_open()) evictionCursor = (evictionCursor + 1) % count;
          files[evictionCursor].close(); --openTileFiles;
          evictionCursor = (evictionCursor + 1) % count;
        }
        files[index].open(tile.path, std::ios::binary | std::ios::app);
        if (!files[index]) throw std::runtime_error("cannot append preparation tile");
        ++openTileFiles;
      }
      const int repetitions = 1 + (y == 0 ? std::max(0, -startY) : 0) +
        (y == result.height - 1 ? std::max(0, startY + tile.height - result.height) : 0);
      const int startX = cell.rect[0] + cell.crop[0] - result.halo;
      std::vector<std::uint8_t> haloRow(static_cast<std::size_t>(tile.width) * 4);
      for (int x = 0; x < tile.width; ++x) {
        const int sourceX = std::clamp(startX + x, 0, result.width - 1);
        std::memcpy(haloRow.data() + static_cast<std::size_t>(x) * 4,
          extraction.row.data() + static_cast<std::size_t>(sourceX) * 4, 4);
      }
      for (int repeat = 0; repeat < repetitions; ++repeat)
        files[index].write(reinterpret_cast<const char*>(haloRow.data()), static_cast<std::streamsize>(haloRow.size()));
      if (!files[index]) throw std::runtime_error("cannot write preparation tile");
      if (y == lastY) { files[index].close(); --openTileFiles; }
    }
  }
  extraction.finish();
  for (auto& file : files) if (file.is_open()) file.close();
  std::unordered_map<std::uint64_t, std::vector<std::size_t>> hashes;
  std::vector<std::size_t> canonical(count);
  std::vector<std::size_t> unique;
  for (std::size_t index = 0; index < count; ++index) {
    const auto& tile = tiles[index];
    if (!tile.width) continue;
    const auto bytes = readBytes(tile.path, tile.size());
    auto& candidates = hashes[digest(bytes)];
    canonical[index] = index;
    for (const auto other : candidates) {
      if (tiles[other].width == tile.width && tiles[other].height == tile.height &&
          readBytes(tiles[other].path, tiles[other].size()) == bytes) {
        canonical[index] = other; break;
      }
    }
    if (canonical[index] == index) { candidates.push_back(index); unique.push_back(index); }
  }
  std::vector<std::ifstream> verification(count);
  std::size_t openVerificationFiles = 0;
  evictionCursor = 0;
  PngRows check(source);
  std::vector<std::uint8_t> tileRow(static_cast<std::size_t>(pageLimit) * 4);
  for (int y = 0; y < result.height; ++y) {
    check.read();
    for (int column = 0; column < recipe.columns; ++column) {
      const auto index = static_cast<std::size_t>(y / cellHeight) * recipe.columns + column;
      const auto& cell = result.cells[index];
      const int localY = y - cell.rect[1];
      if (cell.crop[2] && localY >= cell.crop[1] && localY < cell.crop[1] + cell.crop[3]) {
        if (!verification[index].is_open()) {
          if (openVerificationFiles >= 128) {
            while (!verification[evictionCursor].is_open()) evictionCursor = (evictionCursor + 1) % count;
            verification[evictionCursor].close(); --openVerificationFiles;
            evictionCursor = (evictionCursor + 1) % count;
          }
          verification[index].open(tiles[canonical[index]].path, std::ios::binary);
          if (!verification[index]) throw std::runtime_error("cannot open preparation verification tile");
          ++openVerificationFiles;
        }
        const auto offset = static_cast<std::streamoff>(localY - cell.crop[1] + result.halo) * tiles[index].width * 4 + result.halo * 4;
        verification[index].seekg(offset);
        if (!verification[index].read(reinterpret_cast<char*>(tileRow.data()), cell.crop[2] * 4))
          throw std::runtime_error("cannot verify preparation tile");
      }
      for (int x = 0; x < cellWidth; ++x) {
        const bool stored = inside(x, localY, cell.crop);
        const auto actual = stored ? pixel(tileRow.data() + static_cast<std::size_t>(x - cell.crop[0]) * 4) : cell.fill;
        if (actual != pixel(check.row.data() + static_cast<std::size_t>(cell.rect[0] + x) * 4))
          throw std::runtime_error("prepared image reconstruction differs");
      }
      if (localY == cellHeight - 1 && verification[index].is_open()) {
        verification[index].close(); --openVerificationFiles;
      }
    }
  }
  check.finish();
  auto pack = [&](int width, bool assign) {
    std::vector<PreparedAssetPage> pages;
    int page = 0, shelfX = 0, shelfY = 0, shelfHeight = 0, usedWidth = 0, usedHeight = 0;
    for (const auto index : unique) {
      auto& tile = tiles[index];
      if (shelfX + tile.width > width) { shelfX = 0; shelfY += shelfHeight; shelfHeight = 0; }
      if (shelfY + tile.height > pageLimit) {
        pages.push_back({"page-" + std::to_string(page) + ".png", usedWidth, usedHeight});
        ++page; shelfX = shelfY = shelfHeight = usedWidth = usedHeight = 0;
      }
      if (assign) { tile.page = page; tile.x = shelfX; tile.y = shelfY; }
      shelfX += tile.width; shelfHeight = std::max(shelfHeight, tile.height);
      usedWidth = std::max(usedWidth, shelfX); usedHeight = std::max(usedHeight, shelfY + tile.height);
    }
    if (!unique.empty()) pages.push_back({"page-" + std::to_string(page) + ".png", usedWidth, usedHeight});
    return pages;
  };
  auto score = [](const std::vector<PreparedAssetPage>& pages) {
    std::uint64_t area = 0;
    int longest = 0;
    for (const auto& page : pages) {
      area += static_cast<std::uint64_t>(page.width) * page.height;
      longest = std::max({longest, page.width, page.height});
    }
    return std::pair{area, longest};
  };
  int minimumWidth = 1;
  for (const auto index : unique) minimumWidth = std::max(minimumWidth, tiles[index].width);
  int bestWidth = pageLimit;
  const auto originalPages = pack(bestWidth, false);
  auto bestScore = score(originalPages);
  for (int width = minimumWidth; width < pageLimit; ++width) {
    const auto pages = pack(width, false);
    if (pages.size() > originalPages.size()) continue;
    const auto candidate = score(pages);
    if (candidate < bestScore) { bestWidth = width; bestScore = candidate; }
  }
  if (bestScore.first >= static_cast<std::uint64_t>(result.width) * result.height) {
    for (const auto& tile : tiles) if (tile.width) std::filesystem::remove(tile.path);
    throw AssetPreparationUnsupported("prepared pages do not reduce decoded storage");
  }
  result.pages = pack(bestWidth, true);
  for (std::size_t pageIndex = 0; pageIndex < result.pages.size(); ++pageIndex) {
    const auto& output = result.pages[pageIndex];
    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(output.width) * output.height * 4);
    for (const auto index : unique) {
      const auto& tile = tiles[index];
      if (tile.page != static_cast<int>(pageIndex)) continue;
      const auto content = readBytes(tile.path, tile.size());
      for (int y = 0; y < tile.height; ++y)
        std::memcpy(bytes.data() + (static_cast<std::size_t>(tile.y + y) * output.width + tile.x) * 4,
                    content.data() + static_cast<std::size_t>(y) * tile.width * 4,
                    static_cast<std::size_t>(tile.width) * 4);
    }
    writePng(staging / output.path, output.width, output.height, bytes);
  }
  for (std::size_t index = 0; index < count; ++index) if (tiles[index].width) {
    const auto& tile = tiles[canonical[index]];
    auto& cell = result.cells[index];
    cell.page = tile.page; cell.atlas = {tile.x + result.halo, tile.y + result.halo, cell.crop[2], cell.crop[3]};
    std::filesystem::remove(tiles[index].path);
  }
  return result;
}
}
