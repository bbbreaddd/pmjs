#include "tile_assets.hpp"

#include <algorithm>
#include <unordered_map>
#include <numeric>
#include <tuple>

namespace pmjs {
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

PreparedTileAssets prepareTileAssets(const std::vector<TileAssetInput>& inputs,
                                    const std::filesystem::path& staging) {
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
    auto decoded = ImageStore::decodeFile(*input.source, decodeBudget);
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
      for (int y = -halo; y < r[3]+halo; ++y) for (int x = -halo; x < r[2]+halo; ++x) {
        const int sx = std::clamp(r[0]+x, 0, source.width-1), sy = std::clamp(r[1]+y, 0, source.height-1);
        std::copy_n(decoded->rgba.data()+(static_cast<std::size_t>(sy)*source.width+sx)*4, 4,
          piece.bytes.data()+(static_cast<std::size_t>(y+halo)*piece.width+x+halo)*4);
      }
      std::uint64_t hash = 14695981039346656037ULL;
      for (const auto byte : piece.bytes) hash = (hash ^ byte)*1099511628211ULL;
      const auto candidates = unique.equal_range(hash);
      auto index = pieces.size();
      for (auto entry = candidates.first; entry != candidates.second; ++entry) {
        const auto& candidate = pieces[entry->second];
        if (candidate.width == piece.width && candidate.height == piece.height && candidate.bytes == piece.bytes) {
          index = entry->second; break;
        }
      }
      if (index == pieces.size()) {
        uniqueBytes += piece.bytes.size();
        if (uniqueBytes > budget-metadataReserve-pageReserve)
          throw AssetPreparationUnsupported("tile packing exceeds the working storage budget");
        unique.emplace(hash, index);
        pieces.push_back(std::move(piece));
      }
      indices.push_back(index);
      PreparedAssetCell region; region.rect = r; region.crop = {0, 0, r[2], r[3]};
      source.regions.push_back(region);
    }
    sourcePieces.push_back(std::move(indices)); result.sources.push_back(std::move(source));
  }
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
