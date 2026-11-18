#include "assets/asset_processor.hpp"
#include "assets/prepared_page.hpp"

#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <functional>
#include <future>
#include <iostream>
#include <source_location>
#include <stdexcept>
#include <string>
#include <unistd.h>
#include <png.h>
#include <zlib.h>

namespace {
void require(bool condition, const std::source_location& location = std::source_location::current()) {
  if (!condition) throw std::runtime_error("asset processor fixture assertion failed at line " + std::to_string(location.line()));
}
using pmjs::AssetColor;
void write(const std::filesystem::path& path, int width, int height,
           const std::function<AssetColor(int, int)>& pixels, double gamma = 0, int depth = 8) {
  FILE* file = std::fopen(path.c_str(), "wb");
  require(file);
  png_structp png = png_create_write_struct(PNG_LIBPNG_VER_STRING, nullptr, nullptr, nullptr);
  png_infop info = png_create_info_struct(png);
  require(png && info);
  if (setjmp(png_jmpbuf(png))) throw std::runtime_error("fixture write failed");
  png_init_io(png, file);
  png_set_IHDR(png, info, width, height, depth, PNG_COLOR_TYPE_RGBA,
    PNG_INTERLACE_NONE, PNG_COMPRESSION_TYPE_DEFAULT, PNG_FILTER_TYPE_DEFAULT);
  if (gamma) png_set_gAMA(png, info, gamma);
  png_write_info(png, info);
  std::vector<std::uint8_t> row(static_cast<std::size_t>(width) * 4 * (depth / 8));
  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      const auto rgba = pixels(x, y);
      for (int channel = 0; channel < 4; ++channel) {
        const auto offset = (static_cast<std::size_t>(x) * 4 + channel) * (depth / 8);
        row[offset] = rgba[channel];
        if (depth == 16) row[offset + 1] = rgba[channel] / 2;
      }
    }
    png_write_row(png, row.data());
  }
  png_write_end(png, info);
  png_destroy_write_struct(&png, &info);
  std::fclose(file);
}
void writeMode(const std::filesystem::path& path, int colorType, double gamma) {
  FILE* file = std::fopen(path.c_str(), "wb");
  require(file);
  png_structp png = png_create_write_struct(PNG_LIBPNG_VER_STRING, nullptr, nullptr, nullptr);
  png_infop info = png_create_info_struct(png);
  require(png && info);
  if (setjmp(png_jmpbuf(png))) throw std::runtime_error("mode fixture write failed");
  png_init_io(png, file);
  png_set_IHDR(png, info, 29, 17, 8, colorType, PNG_INTERLACE_NONE,
    PNG_COMPRESSION_TYPE_DEFAULT, PNG_FILTER_TYPE_DEFAULT);
  if (gamma) png_set_gAMA(png, info, gamma);
  if (colorType == PNG_COLOR_TYPE_PALETTE) {
    png_color palette[3]{{13,37,71},{53,97,149},{113,191,239}};
    png_byte alpha[3]{0,87,255};
    png_set_PLTE(png, info, palette, 3);
    png_set_tRNS(png, info, alpha, 3, nullptr);
  }
  png_write_info(png, info);
  const int channels = colorType == PNG_COLOR_TYPE_GRAY_ALPHA ? 2 : colorType == PNG_COLOR_TYPE_RGB ? 3 : 1;
  std::vector<std::uint8_t> row(static_cast<std::size_t>(29 * channels));
  for (int y = 0; y < 17; ++y) {
    for (int x = 0; x < 29; ++x) for (int channel = 0; channel < channels; ++channel)
      row[static_cast<std::size_t>(x * channels + channel)] = static_cast<std::uint8_t>(
        x >= 6 && x < 23 && y >= 5 && y < 12 ?
          (colorType == PNG_COLOR_TYPE_PALETTE ? (x + y) % 3 : (x * 7 + y * 11 + channel * 19) % 256) : 0);
    png_write_row(png, row.data());
  }
  png_write_end(png, info); png_destroy_write_struct(&png, &info); std::fclose(file);
}
std::vector<std::uint8_t> decode(const std::filesystem::path& path) {
  if (path.extension() == ".pml4") {
    std::ifstream file(path, std::ios::binary);
    const std::vector<std::uint8_t> encoded(std::istreambuf_iterator<char>(file), {});
    auto pixels = pmjs::readLz4Page(encoded, 2048U * 2048U * 4U);
    require(pixels.has_value());
    return std::move(pixels->rgba);
  }
  png_image image{};
  image.version = PNG_IMAGE_VERSION;
  require(png_image_begin_read_from_file(&image, path.c_str()));
  image.format = PNG_FORMAT_RGBA;
  std::vector<std::uint8_t> bytes(PNG_IMAGE_SIZE(image));
  require(png_image_finish_read(&image, nullptr, bytes.data(), 0, nullptr));
  png_image_free(&image);
  return bytes;
}
int colorType(const std::filesystem::path& path) {
  std::ifstream file(path, std::ios::binary);
  std::array<unsigned char, 26> header{};
  require(static_cast<bool>(file.read(reinterpret_cast<char*>(header.data()), header.size())));
  return header[25];
}
void verify(const std::filesystem::path& source, const std::filesystem::path& output,
            const pmjs::PreparedAsset& asset) {
  const auto reference = decode(source);
  std::vector<std::vector<std::uint8_t>> pages;
  for (const auto& page : asset.pages) {
    require(page.width <= 2048 && page.height <= 2048);
    pages.push_back(decode(output / page.path));
  }
  auto pixels = [&](int x, int y) {
    const auto offset = (static_cast<std::size_t>(y) * asset.width + x) * 4;
    return AssetColor{reference[offset], reference[offset + 1], reference[offset + 2], reference[offset + 3]};
  };
  auto compare = [&](int x, int y, const AssetColor& actual) {
    if (actual != pixels(x, y)) throw std::runtime_error("fixture reconstruction mismatch at " + std::to_string(x) + "," + std::to_string(y));
  };
  if (asset.uniform) {
    for (int y = 0; y < asset.height; ++y) for (int x = 0; x < asset.width; ++x)
      compare(x, y, *asset.uniform);
  } else {
    std::vector<bool> covered(static_cast<std::size_t>(asset.width) * asset.height);
    for (const auto& cell : asset.cells) {
      for (int y = std::max(0, cell.rect[1]); y < std::min(asset.height, cell.rect[1] + cell.rect[3]); ++y)
        for (int x = std::max(0, cell.rect[0]); x < std::min(asset.width, cell.rect[0] + cell.rect[2]); ++x) {
          const auto position = static_cast<std::size_t>(y) * asset.width + x;
          require(!covered[position]); covered[position] = true;
          const int localX = x - cell.rect[0], localY = y - cell.rect[1];
          AssetColor actual = cell.fill;
          if (cell.page >= 0 && localX >= cell.crop[0] && localY >= cell.crop[1] &&
              localX - cell.crop[0] < cell.crop[2] && localY - cell.crop[1] < cell.crop[3]) {
            const auto& page = asset.pages[cell.page];
            const auto offset = (static_cast<std::size_t>(cell.atlas[1] + localY - cell.crop[1]) * page.width +
              cell.atlas[0] + localX - cell.crop[0]) * 4;
            std::copy_n(pages[cell.page].data() + offset, 4, actual.data());
          }
          compare(x, y, actual);
        }
    }
    require(std::all_of(covered.begin(), covered.end(), [](bool value) { return value; }));
  }
  for (const auto& cell : asset.cells) if (cell.page >= 0) {
    const auto& page = asset.pages[cell.page];
    for (int y = -asset.halo; y < cell.crop[3] + asset.halo; ++y)
      for (int x = -asset.halo; x < cell.crop[2] + asset.halo; ++x) {
        const auto offset = (static_cast<std::size_t>(cell.atlas[1] + y) * page.width + cell.atlas[0] + x) * 4;
        AssetColor actual{}; std::copy_n(pages[cell.page].data() + offset, 4, actual.data());
        require(actual == pixels(std::clamp(cell.rect[0] + cell.crop[0] + x, 0, asset.width - 1),
          std::clamp(cell.rect[1] + cell.crop[1] + y, 0, asset.height - 1)));
      }
  }
}
}
int main() {
  const auto root = std::filesystem::temp_directory_path() / ("pmjs-asset-test-" + std::to_string(::getpid()));
  std::filesystem::create_directories(root);
  try {
    const auto source = root / "source.png";
    auto check = [&](int width, int height, const std::function<AssetColor(int,int)>& pixels,
                     const pmjs::AssetRecipe& recipe = {}, double gamma = 0, int depth = 8) {
      std::filesystem::remove_all(root / "output");
      write(source, width, height, pixels, gamma, depth);
      auto effective = recipe;
      if (effective.columns == 1 && effective.rows == 1 && !effective.crop)
        effective.crop = pmjs::AssetRect{0,0,width,height};
      pmjs::PreparedAsset result;
      try {
        result = pmjs::prepareAssetImage(source, root / "output", effective);
        verify(source, root / "output", result);
        pmjs::AssetPreparationStats stats;
        pmjs::AssetPreparationOptions options;
        options.lz4Pages = true; options.statistics = &stats;
        const auto fast = pmjs::prepareAssetImage(source, root / "lz4", effective, nullptr, options);
        verify(source, root / "lz4", fast);
        require(stats.pngEncodes == 0 && stats.lz4Encodes == fast.pages.size());
        require(fast.cells.size() == result.cells.size() && fast.pages.size() == result.pages.size());
        for (std::size_t i = 0; i < result.pages.size(); ++i)
          require(decode(root / "output" / result.pages[i].path) == decode(root / "lz4" / fast.pages[i].path));
        const auto replayed = pmjs::prepareAssetImage(source, root / "lz4-replay", effective, &result, options);
        verify(source, root / "lz4-replay", replayed);
        const auto pngReplay = pmjs::prepareAssetImage(source, root / "png-replay", effective, &replayed);
        verify(source, root / "png-replay", pngReplay);
      }
      catch (...) { std::cerr << "failed fixture " << width << "x" << height << " gamma=" << gamma << " depth=" << depth << "\n"; throw; }
      return result;
    };
    auto result = check(5, 7, [](int,int) { return AssetColor{13, 27, 31, 0}; });
    require(result.uniform == AssetColor({13, 27, 31, 0}));
    // Equal non-fill row endpoints do not prove that the interior is uniform.
    write(source,20,12,[](int x,int y) {
      return x == 10 && y == 6 ? AssetColor{13,27,32,0} : AssetColor{13,27,31,0};
    });
    bool nonuniformRefused = false;
    try { pmjs::prepareAssetImage(source,root/"nonuniform",{1,1,pmjs::AssetRect{0,0,20,12},{}}); }
    catch (const pmjs::AssetPreparationUnsupported&) { nonuniformRefused = true; }
    require(nonuniformRefused);
    const std::array<std::array<std::uint8_t, 8>, 2> collisions{{
      {0x46,0xd0,0x32,0x5b,0x53,0x02,0xa3,0x0c}, {0x8c,0x95,0x5e,0x00,0xcd,0xef,0xf3,0x56}}};
    require(crc32(0, collisions[0].data(), 8) == crc32(0, collisions[1].data(), 8));
    result = check(16,8,[&](int x,int y) {
      if (y != 2 || x % 8 < 2 || x % 8 >= 4) return AssetColor{};
      const auto* bytes = collisions[x / 8].data() + (x % 8 - 2) * 4;
      return AssetColor{bytes[0],bytes[1],bytes[2],bytes[3]};
    }, {2,1,pmjs::AssetRect{2,2,2,1},{}});
    {
      auto missing = result, overlapping = result, changed = result;
      missing.cells.clear();
      overlapping.cells.push_back(overlapping.cells.front());
      changed.cells.front().fill[0] ^= 255;
      for (const auto& damaged : {missing, overlapping, changed}) {
        bool rejected = false;
        try { verify(source, root / "output", damaged); }
        catch (const std::runtime_error&) { rejected = true; }
        require(rejected);
      }
    }
    require(result.cells[0].atlas != result.cells[1].atlas);
    for (const int shift : {0,1}) {
      auto overlapping = result;
      ++overlapping.pages[0].width;
      overlapping.cells[1].page = overlapping.cells[0].page;
      overlapping.cells[1].atlas = overlapping.cells[0].atlas;
      overlapping.cells[1].atlas[0] += shift;
      const auto destination = root / ("conflicting-atlas-" + std::to_string(shift));
      const auto repaired = pmjs::prepareAssetImage(source, destination,
        {2,1,pmjs::AssetRect{2,2,2,1},{}}, &overlapping);
      verify(source, destination, repaired);
      require(repaired.cells[0].atlas != repaired.cells[1].atlas);
    }
    // Modal ties use RGBA byte order, independently of the native word order.
    result = check(128,64,[](int x,int) {
      return x % 64 >= 16 && x % 64 < 48 ? AssetColor{2,0,0,0} : AssetColor{1,200,0,0};
    }, {2,1,std::nullopt,{}});
    require(result.cells.size() == 2);
    for (const auto& cell : result.cells) {
      require(cell.fill == AssetColor({1,200,0,0}));
      require(cell.crop == pmjs::AssetRect({16,0,32,64}));
    }
    // Painterly interiors cannot overflow the perimeter background probe.
    for (const std::uint8_t alpha : {254,255}) {
      result = check(256,256,[alpha](int x,int y) {
        const int localX = x % 128, localY = y % 128;
        const auto frame = static_cast<std::uint8_t>(y / 128 * 2 + x / 128 + 1);
        if (localX < 16 || localX >= 112 || localY < 16 || localY >= 112)
          return AssetColor{frame,37,71,0};
        const int index = localY * 128 + localX;
        return AssetColor{static_cast<std::uint8_t>(index),static_cast<std::uint8_t>(index >> 8),19,alpha};
      }, {2,2,std::nullopt,{}});
      require(result.cells.size() == 4);
      for (std::size_t i = 0; i < result.cells.size(); ++i) {
        require(result.cells[i].fill == AssetColor({static_cast<std::uint8_t>(i+1),37,71,0}));
        require(result.cells[i].crop == pmjs::AssetRect({16,16,96,96}));
      }
    }
    // Per-cell modes reset at both frame columns and frame rows.
    result = check(128,128,[](int x,int y) {
      const auto frame = static_cast<std::uint8_t>(y / 64 * 2 + x / 64 + 1);
      return x % 64 == 32 && y % 64 == 32 ? AssetColor{99,98,97,0} : AssetColor{frame,2,3,0};
    }, {2,2,std::nullopt,{}});
    require(result.cells.size() == 4);
    for (std::size_t i=0;i<result.cells.size();++i) {
      require(result.cells[i].fill == AssetColor({static_cast<std::uint8_t>(i+1),2,3,0}));
      require(result.cells[i].crop == pmjs::AssetRect({32,32,1,1}));
    }
    result = check(40, 20, [](int x, int y) {
      return y == 10 && (x == 10 || x == 30) ? AssetColor{67, 89, 23, 0} : AssetColor{};
    }, {2,1,std::nullopt,{}});
    require(result.cells.size() == 2 && result.cells[0].crop[2] == 1);
    require(result.cells[0].atlas == result.cells[1].atlas);
    const auto replayed = pmjs::prepareAssetImage(source, root / "indexed", {2,1,std::nullopt,{}}, &result);
    verify(source, root / "indexed", replayed);
    require(replayed.cells.size() == result.cells.size() && replayed.pages.size() == result.pages.size());
    for (std::size_t index = 0; index < result.pages.size(); ++index) {
      auto bytes = [](const std::filesystem::path& file) {
        std::ifstream input(file, std::ios::binary);
        return std::string(std::istreambuf_iterator<char>(input), {});
      };
      require(bytes(root / "output" / result.pages[index].path) ==
              bytes(root / "indexed" / replayed.pages[index].path));
    }
    auto malformed = result;
    malformed.cells[0].crop[2] = 0;
    const auto recovered = pmjs::prepareAssetImage(source, root / "invalid-layout",
      {2,1,std::nullopt,{}}, &malformed);
    verify(source, root / "invalid-layout", recovered);
    require(recovered.pages.size() == result.pages.size());
    result = check(128, 64, [](int x, int y) {
      const int localX = x % 64;
      const AssetColor background = x < 64 ? AssetColor{255,255,255,0} : AssetColor{17,37,71,0};
      if (localX == 32 && y == 32) return AssetColor{11,22,33,157};
      if (localX == 33 && y == 32) return AssetColor{11,22,33,0};
      return background;
    }, {2,1,std::nullopt,{}});
    require(result.cells[0].fill == AssetColor({255,255,255,0}));
    require(result.cells[1].fill == AssetColor({17,37,71,0}));
    for (const auto& cell : result.cells) require(cell.crop == pmjs::AssetRect({32,32,2,1}));
    std::uint64_t preparedPixels = 0;
    for (const auto& page : result.pages) preparedPixels += static_cast<std::uint64_t>(page.width) * page.height;
    require(preparedPixels <= 2U * 8U * 7U);
    const auto modalReplay = pmjs::prepareAssetImage(source, root / "modal-replay", {2,1,std::nullopt,{}}, &result);
    verify(source, root / "modal-replay", modalReplay);
    for (std::size_t index = 0; index < result.cells.size(); ++index) {
      require(modalReplay.cells[index].fill == result.cells[index].fill);
      require(modalReplay.cells[index].crop == result.cells[index].crop);
    }
    // The most frequent color can require a larger crop than transparent black.
    result = check(128,64,[](int x,int y) {
      return x % 64 >= 7 && x % 64 < 57 && y >= 7 && y < 57 ? AssetColor{255,255,255,0} : AssetColor{};
    }, {2,1,std::nullopt,{}});
    for (const auto& cell : result.cells) {
      require(cell.fill == AssetColor{});
      require(cell.crop == pmjs::AssetRect({7,7,50,50}));
    }
    require(result.pages.size() == 1 && result.pages[0].width * result.pages[0].height == 56 * 56);
    // Equal packed costs retain the previous fill and layout.
    result = check(128,64,[](int x,int y) {
      return (x % 64 < 4 || x % 64 >= 60) && (y < 4 || y >= 60) ? AssetColor{} : AssetColor{255,255,255,0};
    }, {2,1,std::nullopt,{}});
    for (const auto& cell : result.cells) {
      require(cell.fill == AssetColor{});
      require(cell.crop == pmjs::AssetRect({0,0,64,64}));
    }
    require(result.pages.size() == 1 && result.pages[0].width * result.pages[0].height == 70 * 70);
    result = check(128,64,[](int x,int y) {
      return x % 64 >= 7 && x % 64 < 57 && y >= 7 && y < 57 ? AssetColor{255,255,255,0} : AssetColor{19,37,71,255};
    }, {2,1,pmjs::AssetRect{7,7,50,50},{19,37,71,255}});
    for (const auto& cell : result.cells) {
      require(cell.fill == AssetColor({19,37,71,255}));
      require(cell.crop == pmjs::AssetRect({7,7,50,50}));
    }
    // Equal frame interiors can have different halos at the source image edges.
    // Sharing the interior must preserve every original boundary sample.
    const auto repeatedInterior = [](int x,int y) {
      if (y < 16 || y >= 112) return AssetColor{};
      const int localX = x % 128;
      return AssetColor{static_cast<std::uint8_t>((localX * 7 + y * 11) % 199 + 1),
        static_cast<std::uint8_t>((localX + y) % 193 + 1),73,
        static_cast<std::uint8_t>((localX + y) % 5 ? 255 : 0)};
    };
    result = check(384,128,repeatedInterior,{3,1,std::nullopt,{}});
    const auto shared = result;
    require(shared.cells.size() > 3);
    for (const auto& cell : shared.cells) {
      require(cell.rect[0] / 128 == (cell.rect[0] + cell.rect[2] - 1) / 128);
      require(cell.rect[2] > 0 && cell.rect[3] > 0);
    }
    const auto explicitFrames = pmjs::prepareAssetImage(source, root / "explicit-frames",
      {3,1,pmjs::AssetRect{0,16,128,96},{}});
    verify(source, root / "explicit-frames", explicitFrames);
    require(explicitFrames.cells.size() == 3);
    for (int frame = 0; frame < 3; ++frame) {
      require(explicitFrames.cells[frame].rect == pmjs::AssetRect({frame * 128,0,128,128}));
      require(explicitFrames.cells[frame].crop == pmjs::AssetRect({0,16,128,96}));
    }
    const auto pagePixels = [](const pmjs::PreparedAsset& asset) {
      std::uint64_t total = 0;
      for (const auto& page : asset.pages) total += static_cast<std::uint64_t>(page.width) * page.height;
      return total;
    };
    require(pagePixels(shared) < pagePixels(explicitFrames));
    // Output failure is final: competing layouts no longer write their own PNGs.
    for (const int columns : {1, 2}) for (const std::size_t budget : {0U, 64U * 1024U * 1024U}) {
      write(source,128,64,[](int x,int y) {
        return x == 64 && y == 32 ? AssetColor{11,22,33,157} : AssetColor{255,255,255,0};
      });
      const auto destination = root / ("blocked-final-" + std::to_string(columns) + "-" + std::to_string(budget));
      std::filesystem::create_directories(destination / "page-0.png");
      std::ofstream(destination / "retained") << "retained";
      pmjs::AssetPreparationStats stats;
      bool outputFailed = false;
      try { pmjs::prepareAssetImage(source,destination,{columns,1,std::nullopt,{}},nullptr,{budget,&stats}); }
      catch (const std::runtime_error& error) {
        outputFailed = std::string(error.what()).find("cannot write prepared PNG") != std::string::npos;
      }
      require(outputFailed && stats.liveWorkspaceBytes == 0);
      if (!budget) require(stats.peakWorkspaceBytes == 0 && stats.temporaryFiles > 0);
      require(std::filesystem::exists(destination / "retained"));
      for (const auto& file : std::filesystem::directory_iterator(destination))
        require(!file.path().filename().string().starts_with(".tiles-"));
    }
    const auto blockPixels = [](int x,int y) {
      const int frame = x / 525, localX = x % 525;
      const int bx = localX / 64, by = y / 64;
      const bool common = bx == 3 && by == 2;
      if (!common && ((bx != 0 && bx != 8) || (by != 0 && by != 6))) return AssetColor{255,255,255,0};
      const int kind = common ? 0 : (frame + (bx == 8) + (by == 6)) % 3;
      const auto value = static_cast<std::uint8_t>((localX % 64 * 7 + y % 64 * 11 + kind * 53) % 255 + 1);
      return AssetColor{value,static_cast<std::uint8_t>(value / 2),value,
        static_cast<std::uint8_t>((localX + y + kind) % 5 ? 255 : 0)};
    };
    result = check(1575,397,blockPixels,{3,1,std::nullopt,{}});
    require(result.blockGrid == std::array<int,3>({64,525,397}));
    const auto blocks = result;
    require(blocks.cells.size() > 3 && blocks.cells.size() <= 4096);
    const pmjs::PreparedAssetCell* commonBlock = nullptr;
    for (const auto& cell : blocks.cells) if (cell.rect[0] % 525 == 192 && cell.rect[1] == 128) {
      if (commonBlock) require(cell.page == commonBlock->page && cell.atlas == commonBlock->atlas);
      else commonBlock = &cell;
    }
    require(commonBlock != nullptr);
    require(std::any_of(blocks.cells.begin(),blocks.cells.end(),[](const auto& cell) {
      return !cell.crop[2] && (cell.rect[2] > 64 || cell.rect[3] > 64);
    }));
    require(std::any_of(blocks.cells.begin(),blocks.cells.end(),[](const auto& cell) {
      return cell.crop[2] && (cell.rect[2] == 13 || cell.rect[3] == 13);
    }));
    const auto blockReplay = pmjs::prepareAssetImage(source,root/"block-replay",{3,1,std::nullopt,{}},&blocks);
    verify(source,root/"block-replay",blockReplay);
    require(blockReplay.blockGrid == blocks.blockGrid && blockReplay.cells.size() == blocks.cells.size());
    for (std::size_t index=0;index<blocks.pages.size();++index)
      require(decode(root/"output"/blocks.pages[index].path) == decode(root/"block-replay"/blockReplay.pages[index].path));
    const auto blockDefaultRecipe = pmjs::prepareAssetImage(source,root/"block-default-replay",{},&blocks);
    require(blockDefaultRecipe.blockGrid == blocks.blockGrid);
    verify(source,root/"block-default-replay",blockDefaultRecipe);
    const auto ordinaryBlocks = pmjs::prepareAssetImage(source,root/"block-ordinary",
      {3,1,pmjs::AssetRect{0,0,525,397},{}});
    verify(source,root/"block-ordinary",ordinaryBlocks);
    require(!ordinaryBlocks.blockGrid && pagePixels(blocks) < pagePixels(ordinaryBlocks));
    for (const bool wrongSize : {false,true}) {
      auto malformed=blocks;
      if (wrongSize) (*malformed.blockGrid)[0]=32;
      else malformed.cells.front().rect[0]+=1;
      const auto destination=root/(wrongSize?"block-invalid-size":"block-invalid-partition");
      const auto repaired=pmjs::prepareAssetImage(source,destination,{3,1,std::nullopt,{}},&malformed);
      verify(source,destination,repaired);
      require(repaired.blockGrid == blocks.blockGrid);
    }
    result=check(1575,397,[](int x,int y) {
      return AssetColor{static_cast<std::uint8_t>(x%199+1),static_cast<std::uint8_t>(y%193+1),
        static_cast<std::uint8_t>((x*17+y*13)%251+1),255};
    },{3,1,std::nullopt,{}});
    require(!result.blockGrid);
    write(source,384,128,repeatedInterior);
    const auto sharedReplay = pmjs::prepareAssetImage(source, root / "shared-replay",
      {3,1,std::nullopt,{}}, &shared);
    verify(source, root / "shared-replay", sharedReplay);
    require(sharedReplay.cells.size() == shared.cells.size() && sharedReplay.pages.size() == shared.pages.size());
    for (std::size_t index = 0; index < shared.cells.size(); ++index) {
      const auto& actual = sharedReplay.cells[index];
      const auto& expected = shared.cells[index];
      require(actual.rect == expected.rect && actual.crop == expected.crop && actual.fill == expected.fill &&
        actual.page == expected.page && actual.atlas == expected.atlas);
    }
    for (const bool overlap : {false,true}) {
      auto invalidPieces = shared;
      if (overlap) invalidPieces.cells.push_back(shared.cells.front());
      else invalidPieces.cells.erase(invalidPieces.cells.begin());
      const auto destination = root / (overlap ? "overlapping-pieces" : "missing-piece");
      const auto repaired = pmjs::prepareAssetImage(source, destination,
        {3,1,std::nullopt,{}}, &invalidPieces);
      verify(source, destination, repaired);
      require(repaired.cells.size() == shared.cells.size() && pagePixels(repaired) == pagePixels(shared));
    }
    // Power-of-two sheets keep whole frame cells for direct frame resolution.
    result = check(512,128,repeatedInterior,{4,1,std::nullopt,{}});
    require(result.cells.size() == 4);
    for (int frame = 0; frame < 4; ++frame) {
      require(result.cells[frame].rect == pmjs::AssetRect({frame * 128,0,128,128}));
      require(result.cells[frame].crop == pmjs::AssetRect({0,16,128,96}));
    }
    // Distinct interiors do not justify additional pieces and their padded area.
    result = check(384,128,[](int x,int y) {
      if (y < 16 || y >= 112) return AssetColor{};
      return AssetColor{static_cast<std::uint8_t>(x % 128 + 1),
        static_cast<std::uint8_t>(y + 1),static_cast<std::uint8_t>(x / 128 + 1),255};
    }, {3,1,std::nullopt,{}});
    require(result.cells.size() == 3);
    for (int frame = 0; frame < 3; ++frame) {
      require(result.cells[frame].rect == pmjs::AssetRect({frame * 128,0,128,128}));
      require(result.cells[frame].crop == pmjs::AssetRect({0,16,128,96}));
    }
    // Shared physical crops need no further interior splitting.
    result = check(384,128,[](int x,int y) {
      const int localX = x % 128;
      if (localX < 16 || localX >= 112 || y < 16 || y >= 112) return AssetColor{};
      return AssetColor{static_cast<std::uint8_t>(localX + 1),static_cast<std::uint8_t>(y + 1),73,255};
    }, {3,1,std::nullopt,{}});
    require(result.cells.size() == 3);
    for (const auto& cell : result.cells)
      require(cell.page == result.cells[0].page && cell.atlas == result.cells[0].atlas);
    // Unequal crop sizes cannot have equal interiors.
    result = check(384,128,[](int x,int y) {
      const int localX = x % 128, end = 112 - x / 128;
      if (localX < 16 || localX >= end || y < 16 || y >= 112) return AssetColor{};
      return AssetColor{static_cast<std::uint8_t>(localX + 1),static_cast<std::uint8_t>(y + 1),73,255};
    }, {3,1,std::nullopt,{}});
    require(result.cells.size() == 3);
    for (int frame = 0; frame < 3; ++frame)
      require(result.cells[frame].crop == pmjs::AssetRect({16,16,96-frame,96}));
    result = check(40, 20, [](int x, int y) {
      return y == 10 && (x == 19 || x == 20) ? AssetColor{67, 89, 23, 128} : AssetColor{};
    }, {2,1,std::nullopt,{}});
    require(result.cells[0].atlas != result.cells[1].atlas);
    check(25, 21, [](int x,int y) {
      return y == 10 && x >= 10 && x < 15 ? AssetColor{static_cast<std::uint8_t>((x-10) * 30),
        71, 97, static_cast<std::uint8_t>((x-10) * 50)} : AssetColor{};
    });
    pmjs::AssetRecipe opaque{2, 1, pmjs::AssetRect{4, 4, 3, 3}, {211, 219, 227, 255}};
    check(20, 10, [](int x, int y) {
      return x % 10 == 5 && y == 5 ? AssetColor{20, 30, 40, 0} : AssetColor{211, 219, 227, 255};
    }, opaque);
    write(source, 20, 10, [](int x,int y) { return x == 0 && y == 0 ? AssetColor{255,0,0,255} : AssetColor{211,219,227,255}; });
    bool refused = false;
    try { pmjs::prepareAssetImage(source, root / "invalid", opaque); }
    catch (const pmjs::AssetPreparationUnsupported&) { refused = true; }
    require(refused);
    for (const auto point : {std::array<int,2>{3,5}, {7,5}, {5,3}, {5,7}}) {
      write(source,20,10,[&](int x,int y) {
        return x % 10 == point[0] && y == point[1] ? AssetColor{211,219,228,0} : opaque.backdrop;
      });
      refused = false;
      try { pmjs::prepareAssetImage(source,root/"invalid-edge",opaque); }
      catch (const pmjs::AssetPreparationUnsupported&) { refused = true; }
      require(refused);
    }
    for (const int depth : {8}) for (const double gamma : {0.0, 0.45455, 1.0, 0.7})
      check(49, 37, [](int x,int y) {
        if (x < 10 || x >= 39 || y < 10 || y >= 27) return AssetColor{};
        x -= 10; y -= 10;
        return AssetColor{static_cast<std::uint8_t>(x * 7), static_cast<std::uint8_t>(y * 11),
          static_cast<std::uint8_t>((x+y) * 3), static_cast<std::uint8_t>((x+y) * 5)};
      }, {}, gamma, depth);
    for (const int mode : {PNG_COLOR_TYPE_PALETTE, PNG_COLOR_TYPE_GRAY, PNG_COLOR_TYPE_GRAY_ALPHA, PNG_COLOR_TYPE_RGB})
      for (const double gamma : {0.0,1.0,0.7}) {
        std::filesystem::remove_all(root / "mode");
        writeMode(source, mode, gamma);
        const auto original = decode(source);
        AssetColor background{};
        std::copy_n(original.data(), 4, background.data());
        const pmjs::AssetRecipe full{1,1,pmjs::AssetRect{0,0,29,17},background};
        try {
          const auto converted = pmjs::prepareAssetImage(source, root / "mode", full);
          verify(source, root / "mode", converted);
          pmjs::AssetPreparationOptions options; options.lz4Pages = true;
          const auto fast = pmjs::prepareAssetImage(source, root / "lz4-mode", full, &converted, options);
          verify(source, root / "lz4-mode", fast);
        }
        catch (...) { std::cerr << "failed mode=" << mode << " gamma=" << gamma << "\n"; throw; }
      }
    result = check(162, 108, [](int x,int y) {
      return x % 18 == 9 && y % 18 == 9 ? AssetColor{11,22,33,44} : AssetColor{};
    }, {9,6,std::nullopt,{}});
    require(result.cells.size() == 54);
    for (const auto& cell : result.cells) require(cell.atlas == result.cells[0].atlas);
    const auto bytes = [](const std::filesystem::path& file) {
      std::ifstream input(file, std::ios::binary);
      return std::string(std::istreambuf_iterator<char>(input), {});
    };
    const auto reference = result;
    const auto referencePng = bytes(root / "output" / result.pages.front().path);
    for (const std::size_t budget : {0U, 2048U, 64U * 1024U * 1024U, 128U * 1024U * 1024U, 256U * 1024U * 1024U}) {
      const auto destination = root / ("workspace-" + std::to_string(budget));
      pmjs::AssetPreparationStats stats;
      const auto actual = pmjs::prepareAssetImage(source, destination, {9,6,std::nullopt,{}}, nullptr, {budget,&stats});
      verify(source, destination, actual);
      require(actual.cells.size() == reference.cells.size() && actual.pages.size() == reference.pages.size());
      for (std::size_t index = 0; index < actual.cells.size(); ++index) {
        const auto& a = actual.cells[index]; const auto& b = reference.cells[index];
        require(a.rect == b.rect && a.crop == b.crop && a.fill == b.fill && a.atlas == b.atlas && a.page == b.page);
      }
      require(bytes(destination / actual.pages.front().path) == referencePng);
      require(stats.peakWorkspaceBytes <= budget && stats.liveWorkspaceBytes == 0);
      if (budget == 0) require(stats.workspaceConstrained);
      require(stats.pngEncodes == actual.pages.size());
      if (budget <= 2048) {
        require(stats.sourceDecodes >= 3 && stats.temporaryFiles > 0 && stats.spillBytesRead > 0 && stats.spillBytesWritten > 0);
      } else if (stats.workspaceLimitBytes >= 128U * 1024U) {
        require(stats.sourceDecodes == 1 && stats.sourceCacheHits > 0 && stats.temporaryFiles == 0);
      }
      for (const auto& file : std::filesystem::directory_iterator(destination))
        require(file.path().extension() == ".png");
    }
    std::vector<std::future<void>> workers;
    for (int index = 0; index < 4; ++index) workers.push_back(std::async(std::launch::async, [&, index] {
      pmjs::AssetPreparationStats stats;
      const auto destination = root / ("concurrent-" + std::to_string(index));
      const auto actual = pmjs::prepareAssetImage(source, destination, {9,6,std::nullopt,{}}, nullptr, {128U * 1024U,&stats});
      verify(source, destination, actual);
      require(stats.peakWorkspaceBytes <= 128U * 1024U && stats.liveWorkspaceBytes == 0);
      require(bytes(destination / actual.pages.front().path) == referencePng);
    }));
    for (auto& worker : workers) worker.get();
    result = check(40, 20, [](int x,int y) { return x == 10 && y == 10 ? AssetColor{11,22,33,44} : AssetColor{}; },
      {2,1,std::nullopt,{}});
    require(result.cells[1].page == -1 && result.cells[1].crop[2] == 0);
    const pmjs::AssetRecipe multiPageRecipe{2,2,pmjs::AssetRect{0,0,1800,1200},{}};
    result = check(3600, 2400, [](int x,int y) {
      const int localX = x % 1800, localY = y % 1200;
      if (localX < 5 || localX >= 1795 || localY < 5 || localY >= 1195) return AssetColor{};
      return AssetColor{static_cast<std::uint8_t>(x / 1800 * 100 + localY % 97),43,59,255};
    }, multiPageRecipe);
    require(result.pages.size() == 2);
    const auto repeated = pmjs::prepareAssetImage(source, root / "repeat", multiPageRecipe);
    require(repeated.pages.size() == result.pages.size());
    for (std::size_t index = 0; index < result.pages.size(); ++index)
      require(decode(root / "repeat" / repeated.pages[index].path) == decode(root / "output" / result.pages[index].path));
    result = check(576, 384, [](int x,int y) {
      const int frame = std::min(40, y / 64 * 9 + x / 64);
      return x % 64 == 32 && y % 64 == 32 ? AssetColor{static_cast<std::uint8_t>(frame+10),37,71,200} :
        AssetColor{1,2,3,0};
    }, {9,6,std::nullopt,{}});
    require(result.cells.size() == 54 && result.pages.size() == 1);
    require(result.pages[0].width * result.pages[0].height <= 42 * 7 * 7);
    for (const auto& cell : result.cells) {
      require(cell.fill == AssetColor({1,2,3,0}));
      require(cell.crop == pmjs::AssetRect({32,32,1,1}));
    }
    for (const int colors : {255,256}) {
      result = check(128,128,[colors](int x,int y) {
        if (x < 40 || x >= 72 || y < 40 || y >= 56) return AssetColor{};
        const int value = ((y-40)*32+x-40) % colors + 1;
        return AssetColor{static_cast<std::uint8_t>(value / 2),77,99,
          static_cast<std::uint8_t>(value % 2 ? 128 : 0)};
      });
      require(result.pages.size() == 1);
      require(colorType(root / "output" / result.pages[0].path) ==
        (colors == 255 ? PNG_COLOR_TYPE_PALETTE : PNG_COLOR_TYPE_RGBA));
    }
    for (const int size : {7,6}) {
      write(source,size,size,[](int x,int y) {
        return x == 3 && y == 3 ? AssetColor{31,41,51,61} : AssetColor{};
      });
      const auto output = root / ("no-benefit-" + std::to_string(size));
      std::filesystem::create_directories(output);
      std::ofstream(output / "retained-source") << "retained";
      refused = false;
      try { pmjs::prepareAssetImage(source,output); }
      catch (const pmjs::AssetPreparationUnsupported&) { refused = true; }
      require(refused && std::filesystem::exists(output / "retained-source"));
      require(std::distance(std::filesystem::directory_iterator(output),
        std::filesystem::directory_iterator{}) == 1);
    }
    write(source, 8, 8, [](int x,int y) { return AssetColor{static_cast<std::uint8_t>(x + 1),static_cast<std::uint8_t>(y + 1),31,255}; });
    refused = false;
    try { pmjs::prepareAssetImage(source, root / "dense"); }
    catch (const pmjs::AssetPreparationUnsupported&) { refused = true; }
    require(refused && !std::filesystem::exists(root / "dense"));
    {
      pmjs::AssetPreparationOptions options;
      options.lz4Pages = true;
      for (const int width : {1280, 3376}) {
        write(source, width, 720, [](int x, int y) {
          return AssetColor{static_cast<std::uint8_t>(x), static_cast<std::uint8_t>(y), 31, 255};
        });
        const auto output = root / ("standalone-" + std::to_string(width));
        const auto standalone = pmjs::prepareAssetImage(source, output, {}, nullptr, options);
        require(!standalone.pages.empty());
        for (const auto& page : standalone.pages) require(page.path.extension() == ".pml4");
        verify(source, output, standalone);
        const auto replay = pmjs::prepareAssetImage(source, output, {}, &standalone, options);
        verify(source, output, replay);
      }
    }
    result = check(128, 96, [](int x, int y) {
      return AssetColor{static_cast<std::uint8_t>(x + 1), static_cast<std::uint8_t>(y + 1), 31, 255};
    }, {2,2,std::nullopt,{}});
    require(result.cells.size() == 4 && !result.pages.empty());
    require(pagePixels(result) > static_cast<std::size_t>(result.width) * result.height);
    write(source, 384, 256, [](int x,int y) {
      const auto frame = static_cast<std::uint8_t>((y / 64) * 6 + x / 64);
      return AssetColor{static_cast<std::uint8_t>(frame + 1), 33, 77, 255};
    });
    result = pmjs::prepareAssetImage(source, root / "dense-grid", {6,4,std::nullopt,{}});
    verify(source, root / "dense-grid", result);
    require(!result.uniform && result.pages.empty() && result.cells.size() == 24);
    for (std::size_t index = 0; index < result.cells.size(); ++index) {
      const auto& cell = result.cells[index];
      require(cell.fill == AssetColor({static_cast<std::uint8_t>(index + 1),33,77,255}));
      require(cell.page == -1 && cell.crop == pmjs::AssetRect({0,0,0,0}));
    }
    result = check(512, 512, [](int x,int) {
      return AssetColor{static_cast<std::uint8_t>(x / 128 % 2 ? 71 : 19), 33, 77, 255};
    }, {4,4,std::nullopt,{}});
    require(result.pages.empty() && result.cells.size() == 16);
    write(source, 8, 8, [](int,int) { return AssetColor{13,27,31,0}; }, 0, 16);
    const auto wideTransparent = pmjs::prepareAssetImage(source, root / "16bit");
    require(wideTransparent.uniform == AssetColor({13,27,31,0}));
    {
      write(source, 512, 256, [](int x, int y) {
        return AssetColor{std::uint8_t(x%127), std::uint8_t(y%7), 47, 93};
      });
      pmjs::AssetRecipe recipe; recipe.columns = 2; recipe.rows = 1; recipe.framePages = true;
      pmjs::AssetPreparationStats stats;
      pmjs::AssetPreparationOptions options; options.workspaceBytes = 1024*1024; options.statistics = &stats;
      const auto limited = pmjs::prepareAssetImage(source,root/"texture-limited",recipe,nullptr,options);
      require(limited.framePages && limited.textureArtifact.empty() && stats.workspaceConstrained);
      require(stats.peakWorkspaceBytes <= options.workspaceBytes && stats.liveWorkspaceBytes == 0);
      verify(source,root/"texture-limited",limited);
    }
    {
      pmjs::AssetPreparationOptions options;
      options.workspaceBytes = 64U * 1024U * 1024U;
      options.lz4Pages = true;
      write(source, 2048, 128, [](int x, int y) {
        return AssetColor{static_cast<std::uint8_t>(x), static_cast<std::uint8_t>(y), 31, 255};
      });
      const auto layout = pmjs::prepareAssetImage(source, root / "cache-reference", {}, nullptr, options);
      require(layout.pages.size() > 1);
      for (const bool lz4 : {false, true}) {
        pmjs::AssetPreparationStats stats;
        options.lz4Pages = lz4;
        options.statistics = &stats;
        const auto output = root / (lz4 ? "cache-lz4" : "cache-png");
        const auto replay = pmjs::prepareAssetImage(source, output, {}, &layout, options);
        verify(source, output, replay);
        require(replay.pages.size() == layout.pages.size());
        require(stats.sourceDecodes == 1 && stats.sourceCacheHits >= layout.pages.size() - 1);
        require(stats.liveWorkspaceBytes == 0 && stats.peakWorkspaceBytes <= options.workspaceBytes);
        options.statistics = nullptr;
      }
      write(source, 64, 64, [](int x, int y) {
        return x >= 24 && x < 40 && y >= 24 && y < 40 ? AssetColor{31,41,51,61} : AssetColor{};
      });
      const auto single = pmjs::prepareAssetImage(source, root / "cache-single", {}, nullptr, options);
      require(single.pages.size() == 1);
      for (const bool lz4 : {false, true}) {
        pmjs::AssetPreparationStats stats;
        options.lz4Pages = lz4;
        options.statistics = &stats;
        auto page = single.pages.back().path;
        page.replace_extension(lz4 ? ".pml4" : ".png");
        const auto output = root / (lz4 ? "cache-retry-lz4" : "cache-retry-png");
        std::filesystem::create_directories(output / page);
        const auto recovered = pmjs::prepareAssetImage(source, output, {}, &single, options);
        verify(source, output, recovered);
        require(stats.sourceDecodes >= 2 && stats.liveWorkspaceBytes == 0);
        require(stats.peakWorkspaceBytes <= options.workspaceBytes);
        const auto blocked = root / (lz4 ? "cache-blocked-lz4" : "cache-blocked-png");
        std::filesystem::create_directories(blocked / page);
        std::ofstream(blocked / page / "retained") << "retained";
        bool failed = false;
        try { pmjs::prepareAssetImage(source, blocked, {}, &single, options); }
        catch (const std::exception&) { failed = true; }
        require(failed && stats.liveWorkspaceBytes == 0);
        require(std::filesystem::exists(blocked / page / "retained"));
        options.statistics = nullptr;
      }
    }
    for (const int height : {11200, 13488, 16384}) {
      write(source, 16, height, [](int x, int y) { return AssetColor{static_cast<unsigned char>(x*13), static_cast<unsigned char>(y%251), 71, 255}; });
      const auto directory = root / ("tall-" + std::to_string(height));
      const auto tall = pmjs::prepareAssetImage(source, directory);
      require(tall.height == height && tall.width == 16);
      require(std::all_of(tall.pages.begin(), tall.pages.end(), [](const auto& page) { return page.width <= 2048 && page.height <= 2048; }));
      verify(source, directory, tall);
    }
    write(source, 1, 16385, [](int, int) { return AssetColor{}; });
    bool rejectedTall = false;
    try { pmjs::prepareAssetImage(source, root / "too-tall"); }
    catch (const pmjs::AssetPreparationUnsupported&) { rejectedTall = true; }
    require(rejectedTall);
    pmjs::AssetPreparationOptions automaticOptions;
    automaticOptions.lz4Pages = true;
    automaticOptions.allowPalettes = true;
    for (const bool lz4 : {false, true}) {
      write(source, 2048, 2048, [lz4](int x, int y) {
        if (!lz4 && (x >= 1024 || y >= 1024)) return AssetColor{};
        return AssetColor{static_cast<unsigned char>(x%8*31), static_cast<unsigned char>(y%8*31), 63,
          static_cast<unsigned char>((x/8)%2 ? 255 : 0)};
      });
      automaticOptions.lz4Pages = lz4;
      const auto directory = root / (lz4 ? "automatic-lz4" : "automatic-png");
      const auto automatic = pmjs::prepareAssetImage(source, directory, {}, nullptr, automaticOptions);
      require(automatic.framePages && automatic.textureArtifact == "texture.pmtx");
      require(automatic.textureRetainedBytes < automatic.ordinaryRetainedBytes);
      verify(source, directory, automatic);
    }
    // Nonzero hidden-RGB fills in multiple cells can require source reconstruction.
    for (const bool mixed : {false, true}) {
      write(source, 2048, 1024, [mixed](int x, int y) {
        if (x % 1024 == 512 && y == 512) return AssetColor{17,37,71,255};
        return mixed && x < 1024 ? AssetColor{} : AssetColor{19,41,73,0};
      });
      const auto directory = root / (mixed ? "mixed-fill" : "multi-fill");
      const auto filled = pmjs::prepareAssetImage(source, directory, {2,1,std::nullopt,{}}, nullptr, automaticOptions);
      require(filled.cells.size() > 1);
      require(filled.textureArtifact.empty() == mixed);
      require(filled.framePages != mixed);
      verify(source, directory, filled);
    }
    // Redundant dense palettes for fill-only cells retain ordinary preparation on ties.
    write(source, 2048, 1024, [](int x, int) {
      return x < 1024 ? AssetColor{159,40,214,255} : AssetColor{17,137,171,255};
    });
    for (const bool lz4 : {false, true}) {
      automaticOptions.lz4Pages = lz4;
      const auto directory = root / (lz4 ? "fill-only-lz4" : "fill-only-png");
      const auto fillOnly = pmjs::prepareAssetImage(source, directory, {2,1,std::nullopt,{}}, nullptr, automaticOptions);
      require(fillOnly.pages.empty() && fillOnly.cells.size() == 2);
      require(fillOnly.textureArtifact.empty() && !fillOnly.framePages);
      require(fillOnly.textureRetainedBytes > 0 && fillOnly.textureRetainedBytes == fillOnly.ordinaryRetainedBytes);
      verify(source, directory, fillOnly);
    }
    write(source, 2048, 2048, [](int x, int y) { return AssetColor{static_cast<unsigned char>(x%8*31), static_cast<unsigned char>(y%8*31), 63, static_cast<unsigned char>((x/8)%2 ? 255 : 0)}; });
    automaticOptions.workspaceBytes = 32U*1024U*1024U;
    const auto constrained = pmjs::prepareAssetImage(source, root / "automatic-constrained", {}, nullptr, automaticOptions);
    require(!constrained.framePages && constrained.textureArtifact.empty());
    verify(source, root / "automatic-constrained", constrained);
    write(source, 8192, 4096, [](int x,int y) { return x == 4000 && y == 3000 ? AssetColor{31,41,51,61} : AssetColor{}; });
    result = pmjs::prepareAssetImage(source, root / "large");
    require(result.width == 8192 && result.height == 4096 && result.halo == 10);
    require(result.cells[0].crop == pmjs::AssetRect({4000,3000,1,1}));
    require(result.pages[0].width == 21 && result.pages[0].height == 21);
    std::filesystem::remove_all(root);
    std::cout << "asset processor: exact RGBA, padding, dedup, halo, decoder parity and oversized streaming passed\n";
  } catch (...) { std::filesystem::remove_all(root); throw; }
}
