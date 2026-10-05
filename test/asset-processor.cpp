#include "asset_processor.hpp"

#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <stdexcept>
#include <string>
#include <unistd.h>
#include <png.h>

namespace {
void require(bool condition) { if (!condition) throw std::runtime_error("asset processor fixture assertion failed"); }
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
  for (int y = 0; y < asset.height; ++y) for (int x = 0; x < asset.width; ++x) {
    AssetColor actual{};
    if (asset.uniform) actual = *asset.uniform;
    else {
      bool found = false;
      for (const auto& cell : asset.cells) {
        const int localX = x - cell.rect[0], localY = y - cell.rect[1];
        if (localX < 0 || localY < 0 || localX >= cell.rect[2] || localY >= cell.rect[3]) continue;
        require(!found); found = true;
        actual = cell.fill;
        if (cell.page >= 0 && localX >= cell.crop[0] && localY >= cell.crop[1] &&
            localX - cell.crop[0] < cell.crop[2] && localY - cell.crop[1] < cell.crop[3]) {
          const auto& page = asset.pages[cell.page];
          const auto offset = (static_cast<std::size_t>(cell.atlas[1] + localY - cell.crop[1]) * page.width +
            cell.atlas[0] + localX - cell.crop[0]) * 4;
          std::copy_n(pages[cell.page].data() + offset, 4, actual.data());
        }
      }
      require(found);
    }
    if (actual != pixels(x, y)) throw std::runtime_error("fixture reconstruction mismatch at " + std::to_string(x) + "," + std::to_string(y));
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
      }
      catch (...) { std::cerr << "failed fixture " << width << "x" << height << " gamma=" << gamma << " depth=" << depth << "\n"; throw; }
      return result;
    };
    auto result = check(5, 7, [](int,int) { return AssetColor{13, 27, 31, 0}; });
    require(result.uniform == AssetColor({13, 27, 31, 0}));
    result = check(40, 20, [](int x, int y) {
      return y == 10 && (x == 10 || x == 30) ? AssetColor{67, 89, 23, 0} : AssetColor{};
    }, {2,1,std::nullopt,{}});
    require(result.cells.size() == 2 && result.cells[0].crop[2] == 1);
    require(result.cells[0].atlas == result.cells[1].atlas);
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
        }
        catch (...) { std::cerr << "failed mode=" << mode << " gamma=" << gamma << "\n"; throw; }
      }
    result = check(162, 108, [](int x,int y) {
      return x % 18 == 9 && y % 18 == 9 ? AssetColor{11,22,33,44} : AssetColor{};
    }, {9,6,std::nullopt,{}});
    require(result.cells.size() == 54);
    for (const auto& cell : result.cells) require(cell.atlas == result.cells[0].atlas);
    result = check(40, 20, [](int x,int y) { return x == 10 && y == 10 ? AssetColor{11,22,33,44} : AssetColor{}; },
      {2,1,std::nullopt,{}});
    require(result.cells[1].page == -1 && result.cells[1].crop[2] == 0);
    result = check(3600, 2400, [](int x,int y) {
      const int localX = x % 1800, localY = y % 1200;
      if (localX < 5 || localX >= 1795 || localY < 5 || localY >= 1195) return AssetColor{};
      return AssetColor{static_cast<std::uint8_t>(x / 1800 * 100 + localY % 97),43,59,255};
    }, {2,2,std::nullopt,{}});
    require(result.pages.size() == 2);
    const auto repeated = pmjs::prepareAssetImage(source, root / "repeat", {2,2,std::nullopt,{}});
    require(repeated.pages.size() == result.pages.size());
    for (std::size_t index = 0; index < result.pages.size(); ++index)
      require(decode(root / "repeat" / repeated.pages[index].path) == decode(root / "output" / result.pages[index].path));
    result = check(576, 384, [](int x,int y) {
      const int frame = std::min(40, y / 64 * 9 + x / 64);
      return x % 64 == 32 && y % 64 == 32 ? AssetColor{static_cast<std::uint8_t>(frame+10),37,71,200} :
        AssetColor{1,2,3,0};
    }, {9,6,std::nullopt,{}});
    require(result.cells.size() == 54 && result.pages.size() == 1);
    require(result.pages[0].width * result.pages[0].height <= 42 * 70 * 70);
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
    write(source, 8, 8, [](int,int) { return AssetColor{13,27,31,0}; }, 0, 16);
    refused = false;
    try { pmjs::prepareAssetImage(source, root / "16bit"); }
    catch (const pmjs::AssetPreparationUnsupported&) { refused = true; }
    require(refused);
    write(source, 8192, 4096, [](int x,int y) { return x == 4000 && y == 3000 ? AssetColor{31,41,51,61} : AssetColor{}; });
    result = pmjs::prepareAssetImage(source, root / "large");
    require(result.width == 8192 && result.height == 4096 && result.halo == 10);
    require(result.cells[0].crop == pmjs::AssetRect({4000,3000,1,1}));
    require(result.pages[0].width == 21 && result.pages[0].height == 21);
    std::filesystem::remove_all(root);
    std::cout << "asset processor: exact RGBA, padding, dedup, halo, decoder parity and oversized streaming passed\n";
  } catch (...) { std::filesystem::remove_all(root); throw; }
}
