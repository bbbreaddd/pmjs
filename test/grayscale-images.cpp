#include "asset_processor.hpp"
#include "platform.hpp"
#include "renderer.hpp"
#include "resources.hpp"
#include "prepared_page.hpp"
#include "texture_artifact.hpp"
#include <fstream>

#include <GLES3/gl3.h>
#include <dlfcn.h>
#include <png.h>
#include <unistd.h>
#include <algorithm>
#include <array>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <vector>

namespace {
std::array<int, 4> lastReadRect{};
}

extern "C" void GL_APIENTRY glReadPixels(GLint x, GLint y, GLsizei width, GLsizei height,
    GLenum format, GLenum type, void* pixels) {
  static const auto read = reinterpret_cast<decltype(&glReadPixels)>(dlsym(RTLD_NEXT, "glReadPixels"));
  if (!read) throw std::runtime_error("cannot resolve GL readback");
  lastReadRect = {x, y, width, height};
  read(x, y, width, height, format, type, pixels);
}

namespace {
void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
void writePng(const std::filesystem::path& path, const pmjs::ImagePixels& pixels) {
  png_image png{};
  png.version = PNG_IMAGE_VERSION;
  png.width = pixels.width; png.height = pixels.height;
  png.format = PNG_FORMAT_RGBA;
  require(png_image_write_to_file(&png, path.c_str(), 0, pixels.rgba.data(), 0, nullptr), "PNG fixture failed");
}
std::vector<std::uint8_t> render(pmjs::Renderer& renderer, pmjs::ImageHandle handle,
    int width, int height, int variant, std::array<int, 4> crop = {}) {
  namespace packet = pmjs::scene_packet;
  const bool filter = variant % 3 != 0;
  const auto nodes = filter ? 3U : 1U;
  std::vector<std::uint32_t> metadata(nodes * packet::metadataStride);
  std::vector<float> values(nodes * packet::valueStride);
  for (std::size_t i = 0; i < nodes; ++i) {
    metadata[i * packet::metadataStride + 1] = packet::noParent;
    metadata[i * packet::metadataStride + 3] = 0xa7c3e9;
    auto* v = values.data() + i * packet::valueStride;
    v[0] = v[3] = v[6] = 1;
  }
  const auto sprite = filter ? 1U : 0U;
  auto* m = metadata.data() + sprite * packet::metadataStride;
  auto* v = values.data() + sprite * packet::valueStride;
  m[0] = variant & 512 ? 2 : 1; m[1] = filter ? 0 : packet::noParent; m[2] = handle;
  m[4] = (variant / 12) % 4;
  m[5] = (variant & 1 ? packet::nearestSampling : 0) |
    (variant & 2 ? packet::premultipliedSpriteTexture : 0) |
    (variant & 4 ? packet::hasClipRectangle : 0) |
    (variant & 32 ? packet::mipmapSampling : 0) |
    (variant & (64 | 256) ? packet::hasSpriteColor : 0) |
    (variant & 128 ? packet::standaloneBitmapRegion : 0) |
    (variant & 1024 ? packet::clampedTilingSampling : 0);
  if (variant & 64) {
    v[37] = 0.8F; v[38] = 0.2F; v[39] = 0.4F; v[40] = 0.5F;
  }
  if (variant & 256) { v[33] = 0.13F; v[34] = -0.07F; v[35] = 0.04F; v[36] = 0.65F; }
  v[0] = 64.0F / width; v[3] = 48.0F / height; v[6] = 0.63F;
  v[11] = v[13] = static_cast<float>(width);
  v[12] = v[14] = static_cast<float>(height);
  if (variant & 512) {
    v[9] = -width * 0.25F; v[10] = -height * 0.125F;
    v[11] = width * 1.5F; v[12] = height * 1.75F;
  }
  if (crop[2] > 0) {
    v[0] = 64.0F / crop[2]; v[3] = 48.0F / crop[3];
    v[9] = crop[0]; v[10] = crop[1]; v[11] = crop[2]; v[12] = crop[3];
  }
  if (variant & 8) {
    v[0] *= -0.81F; v[1] = 0.027F; v[2] = 0.017F; v[3] *= 0.73F;
    v[4] = 60.25F; v[5] = 3.375F;
    v[9] = 0.3F; v[10] = 0.7F;
    v[11] -= 1.8F; v[12] -= 2.1F;
  }
  if (variant & 4) { v[17] = 7; v[18] = 5; v[19] = 49; v[20] = 31; }
  if (filter) {
    metadata[0] = 6;
    metadata[4] = variant % 3 == 1 ? 25 : 0;
    auto* f = values.data();
    if (variant % 3 == 1) {
      const std::array<float, 20> matrix = {
        0.7F, 0, 0.1F, 0, 0.05F, 0.2F, 0.9F, 0, 0, 0.02F,
        0, 0.1F, 0.8F, 0, 0.03F, 0, 0, 0, 1, 0};
      std::copy_n(matrix.data(), 10, f + 7);
      std::copy_n(matrix.data() + 10, 10, f + 22);
      f[32] = 0.8F; f[33] = 1;
    } else { f[7] = 1; f[8] = 1; }
    metadata[2 * packet::metadataStride] = 7;
    metadata[2 * packet::metadataStride + 1] = 0;
  }
  renderer.setClearColor(variant & 16 ? 0.2F : 0, 0.1F, 0.05F, variant & 16 ? 1 : 0);
  renderer.beginFrame();
  require(renderer.queueScene(packet::version, metadata.data(), metadata.size(),
    values.data(), values.size(), nodes), "scene packet rejected");
  renderer.renderScene();
  return renderer.captureSceneRawPremultiplied();
}
}

int main() {
  pmjs::Platform platform(64, 48, "Grayscale image differential");
  char temporary[] = "/tmp/pmjs-grayscale-images-XXXXXX";
  const auto* directory = mkdtemp(temporary);
  require(directory, "temporary directory failed");
  const std::filesystem::path root(directory);
  std::size_t comparisons = 0;
  {
    pmjs::ImageStore images;
    images.setWarmBudgetBytes(0);
    pmjs::Renderer renderer(64, 48, images);
    for (int color = 0; color < 3; ++color) for (const bool opaque : {false, true}) {
      if (color == 2 && !opaque) continue;
      pmjs::ImagePixels pixels{256, 256, std::vector<std::uint8_t>(256 * 256 * 4)};
      for (int alpha = 0; alpha < 256; ++alpha) for (int gray = 0; gray < 256; ++gray) {
        const auto i = static_cast<std::size_t>(alpha * 256 + gray) * 4;
        pixels.rgba[i] = pixels.rgba[i + 1] = pixels.rgba[i + 2] = gray;
        pixels.rgba[i + 3] = opaque ? 255 : alpha;
        if (color == 1) {
          pixels.rgba[i] = 0;
          pixels.rgba[i + 1] = opaque ? 255 : 0;
        } else if (color == 2) {
          pixels.rgba[i + 1] = pixels.rgba[i + 2] = alpha;
        }
      }
      const auto path = root / (std::to_string(color) + (opaque ? "opaque.png" : "alpha.png"));
      writePng(path, pixels);
      const auto decision = pmjs::ImageStore::classifyStorage(pixels);
      require(images.installStorageDecision(path, pmjs::ImageStore::openFile(path)->key(), decision), "prepared storage decision rejected");
      const auto before = images.gpuBytes(), uploads = images.textureUploadBytes();
      const auto compact = images.loadPng(path);
      const int channels = color == 2 ? 2 : opaque ? 1 : 2;
      const auto bytes = static_cast<std::size_t>(256 * 256 * channels);
      require(compact && images.gpuBytes() - before == bytes &&
        images.textureUploadBytes() - uploads == bytes, "decoded storage or upload accounting wrong");
      const auto cached = images.loadPng(path);
      require(cached && cached->handle == compact->handle, "cached owners lost shared identity");
      std::filesystem::remove(path);
      const auto* read = images.readPixels(compact->handle);
      require(read && read->rgba == pixels.rgba, "compact GPU readback lost hidden RGB or alpha");
      for (int frame = 0; frame < 65; ++frame) images.update();
      require(!images.hasCpuPixels(compact->handle), "CPU snapshot failed to expire");
      require(images.readPixels(compact->handle)->rgba == pixels.rgba, "expired snapshot reconstructed incorrectly");
      const auto control = images.createRgba(256, 256, pixels.rgba.data());
      require(control.has_value(), "RGBA control failed");
      for (int variant = 0; variant < 48; ++variant) {
        require(render(renderer, compact->handle, 256, 256, variant) ==
          render(renderer, control->handle, 256, 256, variant), "compact rendering differs from RGBA control");
        ++comparisons;
      }
      // Sample every gray/alpha pair at native resolution through the unchanged shader.
      const auto full = [&](pmjs::ImageHandle handle) {
        renderer.beginFrame();
        require(renderer.queueImage(handle, {1, 0, 0, 1, 0, 0}, {0, 0, 256, 256},
          1, 0xffffff, pmjs::BlendMode::normal), "full image draw failed");
        return renderer.renderToRgba(256, 256, 0, pmjs::AlphaMode::premultiplied);
      };
      require(full(compact->handle) == full(control->handle), "full-resolution compact sampling differs");
      ++comparisons;
      require(images.ensureMipmaps(compact->handle, false), "compact mipmaps failed");
      const auto mipBytes = static_cast<std::size_t>((65536 - 1) / 3 * channels);
      const auto entries = images.memoryEntries();
      const auto entry = std::find_if(entries.begin(), entries.end(), [&](const auto& e) { return e.handle == compact->handle; });
      require(entry != entries.end() && entry->gpuBytes == (bytes + mipBytes) * (opaque ? 1 : 2),
        "base, premultiplied or mipmap accounting wrong");
      // A pitched colour write must preserve untouched texels and every retained owner.
      const auto textureBefore = images.lookup(compact->handle)->texture;
      const auto layer = renderer.createTileLayer({{compact->handle, {0, 0, 256, 256}, {}, {}}});
      require(layer != 0, "retained tile geometry failed");
      const std::array<std::uint8_t, 8> patch{17, 43, 91, 127, 0, 0, 0, 0};
      require(images.updateRgbaRegion(compact->handle, 19, 37, 1, 1, patch.data(), 2), "compact colour write failed");
      std::copy_n(patch.data(), 4, pixels.rgba.data() + (37 * 256 + 19) * 4);
      require(images.lookup(cached->handle)->texture == images.lookup(compact->handle)->texture,
        "promotion detached shared owner");
      require(images.readPixels(cached->handle)->rgba == pixels.rgba, "promotion corrupted CPU RGBA contract");
      for (int frame = 0; frame < 65; ++frame) images.update();
      require(images.readPixels(compact->handle)->rgba == pixels.rgba, "promotion corrupted untouched GPU texels");
      require(images.updateRgba(control->handle, pixels.rgba.data()), "control update failed");
      require(images.lookup(compact->handle)->texture == textureBefore, "promotion changed retained texture name");
      renderer.beginFrame();
      require(renderer.queueTileLayer(layer, {0.25F, 0, 0, 0.1875F, 0, 0}, {}, 1,
        0xffffff, pmjs::BlendMode::normal), "retained tile submission failed");
      renderer.renderScene();
      const auto retainedPixels = renderer.captureSceneRawPremultiplied();
      const auto controlLayer = renderer.createTileLayer({{control->handle, {0, 0, 256, 256}, {}, {}}});
      require(controlLayer != 0, "control tile geometry failed");
      renderer.beginFrame();
      require(renderer.queueTileLayer(controlLayer, {0.25F, 0, 0, 0.1875F, 0, 0}, {}, 1,
        0xffffff, pmjs::BlendMode::normal), "control submission failed");
      renderer.renderScene();
      require(retainedPixels == renderer.captureSceneRawPremultiplied(), "retained layer uses stale texture after promotion");
      renderer.releaseTileLayer(layer);
      renderer.releaseTileLayer(controlLayer);
      for (int variant : {0, 3, 9, 17}) {
        require(render(renderer, compact->handle, 256, 256, variant) ==
          render(renderer, control->handle, 256, 256, variant), "promoted pixels differ from RGBA control");
        ++comparisons;
      }
      require(images.ensureMipmaps(compact->handle, true), "promoted mipmaps failed");
      images.release(cached->handle); images.release(compact->handle); images.release(control->handle);
      images.update();
      require(images.gpuBytes() == 0 && !images.inspect(compact->handle), "compact or promoted resources leaked");
    }

    // Unequal hidden RGB prevents compression even at alpha zero.
    pmjs::ImagePixels coloured{3, 5, std::vector<std::uint8_t>(3 * 5 * 4, 63)};
    coloured.rgba[0] = 64; coloured.rgba[3] = 0;
    auto colour = images.installDecodedMemory(coloured);
    require(colour && images.gpuBytes() == coloured.rgba.size(), "hidden colour was classified as grayscale");
    images.release(colour->handle);
    images.update();

    // Constant white RGB channels cannot remain constant after premultiplication.
    pmjs::ImagePixels whiteChannels{256, 1, std::vector<std::uint8_t>(256 * 4)};
    for (int value = 0; value < 256; ++value) {
      const auto i = static_cast<std::size_t>(value) * 4;
      whiteChannels.rgba[i] = whiteChannels.rgba[i + 2] = 255;
      whiteChannels.rgba[i + 1] = whiteChannels.rgba[i + 3] = value;
    }
    const auto white = images.installDecodedMemory(whiteChannels);
    require(white && images.gpuBytes() == whiteChannels.rgba.size(),
      "translucent constant channels bypassed premultiplication requirements");
    const auto whiteControl = images.createRgba(256, 1, whiteChannels.rgba.data());
    require(whiteControl.has_value(), "constant-channel RGBA control failed");
    for (int variant : {0, 1, 3, 5}) {
      require(render(renderer, white->handle, 256, 1, variant) ==
        render(renderer, whiteControl->handle, 256, 1, variant), "constant-channel fallback differs");
      ++comparisons;
    }
    images.release(white->handle); images.release(whiteControl->handle); images.update();

    // Odd row widths, full replacement, retained CPU bytes and recycled slots.
    pmjs::ImagePixels odd{3, 5, std::vector<std::uint8_t>(3 * 5 * 4, 73)};
    auto oddImage = images.installDecodedMemory(odd);
    require(oddImage && images.gpuBytes() == 60, "ordinary memory image must use RGBA storage");
    odd.rgba[0] = 17; odd.rgba[1] = 43; odd.rgba[2] = 91;
    const auto uploadBefore = images.textureUploadBytes();
    require(images.updateRgba(oddImage->handle, odd.rgba.data()) && images.gpuBytes() == 60 &&
      images.textureUploadBytes() - uploadBefore == 60, "full promotion uploaded redundant data");
    require(images.readPixels(oddImage->handle)->rgba == odd.rgba, "full replacement lost retained pixels");
    images.release(oddImage->handle); images.update();
    std::fill(odd.rgba.begin(), odd.rgba.end(), 73);
    for (std::size_t i = 3; i < odd.rgba.size(); i += 4) odd.rgba[i] = 255;
    writePng(root / "odd.png", odd);
    const auto oddDecision = pmjs::ImageStore::classifyStorage(odd);
    require(images.installStorageDecision(root / "odd.png", pmjs::ImageStore::openFile(root / "odd.png")->key(), oddDecision), "odd storage decision rejected");
    const auto opaqueOdd = images.loadPng(root / "odd.png");
    require(opaqueOdd && images.gpuBytes() == 15 && images.readPixels(opaqueOdd->handle)->rgba == odd.rgba,
      "odd opaque rows lost alignment or alpha");
    const auto oddControl = images.createRgba(3, 5, odd.rgba.data());
    for (int variant : {0, 1, 3, 9}) {
      require(render(renderer, opaqueOdd->handle, 3, 5, variant) ==
        render(renderer, oddControl->handle, 3, 5, variant), "odd grayscale sampling differs from RGBA");
      ++comparisons;
    }
    images.release(opaqueOdd->handle); images.release(oddControl->handle); images.update();
    auto target = images.createRenderTarget(3, 5);
    require(target && images.gpuBytes() == 60, "recycled render target acquired compact storage");
    images.release(target->handle);
    images.update();

    // A prepared physical page includes multiple cells; classify the whole page.
    for (const bool colored : {false, true}) for (const bool indexed : {false, true}) {
      pmjs::ImagePixels page{16, 8, std::vector<std::uint8_t>(16 * 8 * 4)};
      for (int y = 1; y < 7; ++y) for (int x = 0; x < 16; ++x) {
        if (x % 8 == 0 || x % 8 == 7) continue;
        const auto i = static_cast<std::size_t>(y * 16 + x) * 4;
        page.rgba[i] = page.rgba[i + 1] = page.rgba[i + 2] = y * 16 + x;
        if (colored) page.rgba[i + 1] = 0;
        page.rgba[i + 3] = y * 16 + x;
      }
      writePng(root / "source.png", page); writePng(root / "page.png", page);
      pmjs::PreparedImageDescriptor descriptor;
      descriptor.width = 16; descriptor.height = 8;
      descriptor.pages.push_back({"page.png", 16, 8});
      if (indexed) descriptor.pages.back().storage = pmjs::ImageStore::classifyStorage(page);
      descriptor.cells.push_back({{0, 0, 8, 8}, {1, 1, 6, 6}, {1, 1, 6, 6}, {}, 0});
      descriptor.cells.push_back({{8, 0, 8, 8}, {1, 1, 6, 6}, {9, 1, 6, 6}, {}, 0});
      require(images.installPrepared(root / "source.png", root, descriptor), "prepared grayscale install failed");
      const auto pageDecodes = images.preparedPageDecodes();
      const auto logical = images.loadPng(root / "source.png");
      const auto region = images.resolveSpriteRegion(logical->handle, 0, 0, 8, 8, false);
      require(region && images.gpuBytes() == 256, "prepared grayscale page not compressed");
      require(images.resolveSpriteRegion(logical->handle, 8, 0, 8, 8, true) && images.gpuBytes() == 512,
        "prepared premultiplied page accounting wrong");
      require(images.preparedPageDecodes() - pageDecodes == 1,
        "straight and premultiplied uploads repeated the validation decode");
      auto pageControl = images.createRgba(16, 8, page.rgba.data());
      for (int variant : {0, 1, 3, 5}) {
        require(render(renderer, logical->handle, 8, 8, variant) ==
          render(renderer, pageControl->handle, 8, 8, variant), "prepared grayscale page differs from RGBA");
        ++comparisons;
      }
      images.release(logical->handle); images.release(pageControl->handle); images.update();
      require(images.gpuBytes() == 0, "prepared grayscale allocations leaked");
      // Hidden colour in another cell prevents compression of the shared page.
      page.rgba[(1 * 16 + 9) * 4] = 93;
      page.rgba[(1 * 16 + 9) * 4 + 3] = 0;
      writePng(root / "source.png", page); writePng(root / "page.png", page);
      require(images.installPrepared(root / "source.png", root, descriptor), "mixed page install failed");
      const auto mixed = images.loadPng(root / "source.png");
      require(mixed && images.resolveSpriteRegion(mixed->handle, 0, 0, 8, 8, false) &&
        images.gpuBytes() == 512, "mixed prepared page compressed only the reached grayscale cell");
      images.release(mixed->handle); images.update();
      require(images.gpuBytes() == 0, "mixed page allocations leaked");
    }

    // Logical tile views share compressed pages until the last owner releases them.
    for (const bool colored : {false, true}) {
      pmjs::ImagePixels tile{6, 6, std::vector<std::uint8_t>(6 * 6 * 4)};
      for (std::size_t i = 0; i < tile.rgba.size(); i += 4) {
        tile.rgba[i] = tile.rgba[i + 1] = tile.rgba[i + 2] = 17 + i / 4;
        if (colored) tile.rgba[i + 1] = 0;
        tile.rgba[i + 3] = 63 + i / 4;
      }
      pmjs::ImagePixels tilePage{8, 8, std::vector<std::uint8_t>(8 * 8 * 4)};
      for (int y = 0; y < 8; ++y) for (int x = 0; x < 8; ++x)
        std::copy_n(tile.rgba.data() + (std::clamp(y - 1, 0, 5) * 6 + std::clamp(x - 1, 0, 5)) * 4,
          4, tilePage.rgba.data() + (y * 8 + x) * 4);
      writePng(root / "tile-page.png", tilePage);
      pmjs::PreparedTileSet tiles;
      tiles.identity = "grayscale-tiles"; tiles.directory = root;
      tiles.pages.push_back({"tile-page.png", 8, 8, pmjs::ImageStore::classifyStorage(tilePage)});
      for (const char* name : {"tile-a.png", "tile-b.png"}) {
        const auto path = root / name;
        writePng(path, tile);
        tiles.sources.push_back({path, path, pmjs::ImageStore::openFile(path)->key(), 6, 6,
          {{{0, 0, 6, 6}, {1, 1, 6, 6}, 0}}, {}});
      }
      require(images.installTileSet(tiles), "grayscale tile set rejected");
      const auto firstTile = images.loadPng(root / "tile-a.png", false, tiles.identity);
      const auto secondTile = images.loadPng(root / "tile-b.png", false, tiles.identity);
      require(firstTile && secondTile && images.gpuBytes() == 256, "tile owners duplicated compressed pages");
      const auto tileControl = images.createRgba(6, 6, tile.rgba.data());
      for (int variant : {0, 1, 3, 5}) {
        require(render(renderer, secondTile->handle, 6, 6, variant) ==
          render(renderer, tileControl->handle, 6, 6, variant), "shared grayscale tile pixels differ");
        ++comparisons;
      }
      images.release(tileControl->handle); images.release(firstTile->handle); images.update();
      require(images.inspect(secondTile->handle) && images.readPixels(secondTile->handle)->rgba == tile.rgba,
        "releasing a tile view damaged another owner");
      images.release(secondTile->handle); images.update();
      require(images.gpuBytes() == 0, "shared compressed tile pages leaked");
    }
    {
      pmjs::ImagePixels pixels{128, 128, std::vector<std::uint8_t>(128*128*4, 0)};
      const auto path = root / "indexed-pixel-facts.png";
      writePng(path, pixels);
      const auto decision = pmjs::ImageStore::classifyStorage(pixels);
      require(decision.hasPixelFacts && decision.allZero && !decision.opaque, "zero facts differ");
      require(images.installStorageDecision(path, pmjs::ImageStore::openFile(path)->key(), decision),
        "pixel facts rejected");
      const auto image = images.loadPng(path);
      require(image && images.inspect(image->handle)->knownAllZero && images.isOpaque(image->handle) == false,
        "indexed zero/opacity facts not applied");
      for (std::size_t i = 0; i < pixels.rgba.size(); i += 4) {
        pixels.rgba[i] = 17; pixels.rgba[i+1] = 33; pixels.rgba[i+2] = 65; pixels.rgba[i+3] = 255;
      }
      require(images.updateRgba(image->handle, pixels.rgba.data()) &&
        !images.inspect(image->handle)->knownAllZero && images.isOpaque(image->handle) == true,
        "mutation retained stale indexed facts");
      require(images.readPixels(image->handle)->rgba == pixels.rgba, "mutated indexed pixels differ");
      images.release(image->handle); images.update();
      images.clearStorageDecisions();
    }
    // Each page fits a palette even when the complete logical image does not.
    for (const bool wide : {false, true}) {
      const int frameWidth = wide ? 511 : 512, frameHeight = wide ? 510 : 512;
      pmjs::ImagePixels source{frameWidth * 2, frameHeight, std::vector<std::uint8_t>(frameWidth * 2 * frameHeight * 4)};
      pmjs::PreparedImageDescriptor descriptor;
      descriptor.width = source.width; descriptor.height = source.height;
      std::size_t expectedBytes = 0;
      for (int side = 0; side < 2; ++side) {
        pmjs::ImagePixels page{frameWidth + 2, frameHeight + 2, std::vector<std::uint8_t>((frameWidth + 2) * (frameHeight + 2) * 4)};
        for (int y = 0; y < page.height; ++y) for (int x = 0; x < page.width; ++x) {
          const auto color = (std::clamp(y - 1, 0, frameHeight - 1) * frameWidth + std::clamp(x - 1, 0, frameWidth - 1)) % (wide ? 65536 : 256);
          auto* p = page.rgba.data() + (y * page.width + x) * 4;
          p[0] = color & 255; p[1] = color >> 8; p[2] = side ? 137 : 51;
          p[3] = wide ? 255 : (color * 31) & 255;
          if (x > 0 && x <= frameWidth && y > 0 && y <= frameHeight)
            std::copy_n(p, 4, source.rgba.data() + ((y - 1) * source.width + side * frameWidth + x - 1) * 4);
        }
        const auto filename = std::string(wide ? "wide" : "narrow") + std::to_string(side) + "-page.pml4";
        pmjs::writeLz4Page(root / filename, page.width, page.height, page.rgba, true);
        descriptor.pages.push_back({filename, page.width, page.height});
        descriptor.pages.back().storage = pmjs::ImageStore::classifyStorage(page);
        require(descriptor.pages.back().storage->paletteBits == (wide ? 16 : 8), "prepared page palette decision differs");
        descriptor.cells.push_back({{side * frameWidth, 0, frameWidth, frameHeight}, {0, 0, frameWidth, frameHeight}, {1, 1, frameWidth, frameHeight}, {}, side});
        expectedBytes += page.width * page.height * (wide ? 2 : 1) + (wide ? 256 : 2) * 1024;
      }
      const auto path = root / (wide ? "wide-pages.png" : "narrow-pages.png");
      const auto aliasPath = root / (wide ? "wide-alias.png" : "narrow-alias.png");
      writePng(path, source); writePng(aliasPath, source);
      require(images.installPrepared(path, root, descriptor) && images.installPrepared(aliasPath, root, descriptor),
        "page palette descriptor rejected");
      const auto image = images.loadPng(path), alias = images.loadPng(aliasPath);
      const auto control = images.createRgba(source.width, source.height, source.rgba.data());
      require(image && alias && control, "page palette source load failed");
      if (wide) {
        const auto first = images.resolveSpriteRegion(image->handle, 0, 0, frameWidth, frameHeight, false);
        const auto second = images.resolveSpriteRegion(alias->handle, 0, 0, frameWidth, frameHeight, false);
        require(first && second && !first->paletteTable && first->image.texture == second->image.texture,
          "uncompiled wide page must share an ordinary texture");
        for (int side = 0; side < 2; ++side) {
          const std::array<int, 4> crop{side * frameWidth, 0, frameWidth, frameHeight};
          for (int variant : {0, 1, 2, 3, 5, 258, 321}) {
            require(render(renderer, alias->handle, source.width, source.height, variant, crop) ==
              render(renderer, control->handle, source.width, source.height, variant, crop),
              "ordinary wide-page fallback changed pixels");
            ++comparisons;
          }
        }
        require(images.sourceTextureBuilds() == 0, "wide fallback compiled a texture during drawing");
        images.release(image->handle); images.update();
        require(images.readPixelsRegion(alias->handle, 513, 7, 9, 3).has_value(), "wide alias lost its backing");
        images.release(alias->handle); images.release(control->handle); images.update();
        require(images.gpuBytes() == 0 && images.cpuBytes() == 0, "wide fallback resources leaked");
        continue;
      }


      for (int side = 0; side < 2; ++side) {
        const std::array<int, 4> crop{side * frameWidth, 0, frameWidth, frameHeight};
        for (const bool premultiplied : {false, true}) {
          const auto region = images.resolveSpriteRegion(image->handle, crop[0], 0, frameWidth, frameHeight, premultiplied, true);
          const auto shared = images.resolveSpriteRegion(alias->handle, crop[0], 0, frameWidth, frameHeight, premultiplied, true);
          require(region && shared && region->paletteTable && region->image.texture == shared->image.texture &&
            region->paletteTable == shared->paletteTable, "prepared palette was not shared");
        }
      }
      const auto memory = images.memoryEntries();
      const auto controlOwner = std::find_if(memory.begin(), memory.end(), [&](const auto& entry) { return entry.handle == control->handle; });
      require(controlOwner != memory.end(), "palette control owner missing");
      require(images.gpuBytes() - controlOwner->gpuBytes == expectedBytes,
        ("prepared page palettes allocated RGBA or duplicated storage: actual=" +
          std::to_string(images.gpuBytes() - controlOwner->gpuBytes) + " expected=" +
          std::to_string(expectedBytes)).c_str());
      require(std::count_if(memory.begin(), memory.end(), [&](const auto& entry) {
        return (entry.handle == image->handle || entry.handle == alias->handle) && entry.gpuBytes == expectedBytes && entry.palette && entry.paletteIndexBits == (wide ? 16 : 8);
      }) == 2, "prepared page palette ownership accounting differs");
      const auto view = images.resolveSpriteRegion(alias->handle, 0, 0, frameWidth, frameHeight, false, true);
      images.setWarmBudgetBytes(64 * 1024 * 1024);
      images.release(image->handle); images.update();
      require(images.warmCount() == 1 && images.warmBytes() == 0, "warm palette charged storage retained by an active owner");
      images.setWarmBudgetBytes(0); images.update();
      require(glIsTexture(view->image.texture), "released owner deleted a shared palette page");
      for (int side = 0; side < 2; ++side) {
        const std::array<int, 4> crop{side * frameWidth, 0, frameWidth, frameHeight};
        for (int variant : {0, 2, 3, 6, 65, 66, 68, 258, 321}) {
          const auto actual = render(renderer, alias->handle, source.width, source.height, variant, crop);
          const auto expected = render(renderer, control->handle, source.width, source.height, variant, crop);
          if (actual != expected) {
            const auto at = std::mismatch(actual.begin(), actual.end(), expected.begin()).first - actual.begin();
            std::fprintf(stderr, "page wide=%d side=%d variant=%d byte=%td actual=%u expected=%u\n", wide, side, variant, at, actual[at], expected[at]);
          }
          require(actual == expected, "prepared palette crop rendering differs");
          ++comparisons;
        }
      }
      const auto read = images.readPixelsRegion(alias->handle, 513, 7, 9, 3);
      require(read && std::equal(read->rgba.begin(), read->rgba.begin() + 36, source.rgba.begin() + (7 * source.width + 513) * 4),
        "prepared palette region read changed source pixels");
      const std::array<std::uint8_t, 4> replacement{11, 29, 73, 109};
      require(images.updateRgbaRegion(alias->handle, 513, 7, 1, 1, replacement.data(), 1), "prepared palette mutation failed");
      const auto changed = images.readPixelsRegion(alias->handle, 513, 7, 1, 1);
      require(changed && std::equal(changed->rgba.begin(), changed->rgba.end(), replacement.begin()), "prepared palette mutation returned stale pixels");
      require(!glIsTexture(view->image.texture), "mutation kept an unused immutable page palette");
      images.release(alias->handle); images.release(control->handle); images.update();
      require(images.gpuBytes() == 0 && images.cpuBytes() == 0, "prepared page palette resources leaked");
    }
    // Exercise index-width selection and every 16-bit address, including hidden RGB and odd dimensions.
    for (const unsigned colorCount : {256U, 257U, 65536U}) for (const bool opaque : {false, true}) {
      const int width = colorCount == 256 ? 1280 : colorCount == 257 ? 1920 : 2049;
      const int height = colorCount == 256 ? 720 : colorCount == 257 ? 1080 : 2048;
      pmjs::ImagePixels pixels{width, height, std::vector<std::uint8_t>(width * height * 4)};
      for (std::size_t i = 0; i < pixels.rgba.size() / 4; ++i) {
        const unsigned color = i % colorCount;
        pixels.rgba[i * 4] = color & 255;
        pixels.rgba[i * 4 + 1] = color >> 8;
        pixels.rgba[i * 4 + 2] = (color * 17 + (color >> 8) * 7) & 255;
        pixels.rgba[i * 4 + 3] = opaque ? 255 : (color * 31) & 255;
      }
      const auto path = root / (std::to_string(colorCount) + (opaque ? "-palette-opaque.png" : "-palette-alpha.png"));
      writePng(path, pixels);
      const auto decision = pmjs::ImageStore::classifyStorage(pixels);
      require(decision.paletteBits == (colorCount <= 256 ? 8 : 16), "offline palette classification differs");
      const auto source = pmjs::ImageStore::openFile(path);
      require(source && !images.installStorageDecision(path, "stale-identity", decision),
        "storage decision accepted an unrelated source identity");
      require(images.installStorageDecision(path, source->key(), decision), "storage decision installation failed");
      const auto directory = root / (path.stem().string() + "-prepared");
      std::filesystem::create_directories(directory);
      const unsigned indexBytes = colorCount <= 256 ? 1 : 2;
      pmjs::PreparedTexture encoded;
      encoded.layout.width = width; encoded.layout.height = height;
      encoded.layout.kind = indexBytes == 1 ? pmjs::TextureKind::Dense8 : pmjs::TextureKind::Dense16;
      encoded.layout.planes = {{unsigned(width), unsigned(height), indexBytes == 1 ? pmjs::TextureFormat::R8 : pmjs::TextureFormat::RG8, {}},
        {256, (colorCount + 255) / 256, pmjs::TextureFormat::RGBA8, {}}};
      encoded.bytes.resize(2);
      encoded.bytes[0].resize(std::size_t(width)*height*indexBytes);
      encoded.bytes[1].resize(((colorCount+255)/256)*1024);
      std::copy_n(pixels.rgba.data(),std::size_t(colorCount)*4,encoded.bytes[1].data());
      for (std::size_t i = 0; i < std::size_t(width)*height; ++i) {
        encoded.bytes[0][i*indexBytes] = i % colorCount & 255;
        if (indexBytes == 2) encoded.bytes[0][i*2+1] = (i % colorCount) >> 8;
      }
      pmjs::writeTextureArtifact(directory / "texture.pmtx", encoded);
      pmjs::PreparedImageDescriptor descriptor;
      descriptor.width = width; descriptor.height = height; descriptor.halo = 1;
      descriptor.framePages = true; descriptor.textureArtifact = "texture.pmtx";
      for (int y = 0; y < height; y += 2046) for (int x = 0; x < width; x += 2046) {
        const int w = std::min(2046,width-x), h = std::min(2046,height-y);
        pmjs::ImagePixels page{w+2,h+2,std::vector<std::uint8_t>(std::size_t(w+2)*(h+2)*4)};
        for (int py = 0; py < h+2; ++py) for (int px = 0; px < w+2; ++px)
          std::copy_n(pixels.rgba.data()+(std::size_t(std::clamp(y+py-1,0,height-1))*width+std::clamp(x+px-1,0,width-1))*4,
            4,page.rgba.data()+(std::size_t(py)*(w+2)+px)*4);
        const auto filename = "recovery-"+std::to_string(descriptor.pages.size())+".pml4";
        pmjs::writeLz4Page(directory / filename,page.width,page.height,page.rgba);
        descriptor.cells.push_back({{x,y,w,h},{0,0,w,h},{1,1,w,h},{},int(descriptor.pages.size())});
        descriptor.pages.push_back({filename,page.width,page.height});
      }
      require(images.installPrepared(path, directory, descriptor), "startup texture fixture rejected");
      std::ifstream file(directory / descriptor.textureArtifact, std::ios::binary);
      std::vector<std::uint8_t> artifact(std::filesystem::file_size(directory / descriptor.textureArtifact));
      file.read(reinterpret_cast<char*>(artifact.data()), artifact.size());
      const auto layout = pmjs::readTextureLayout([&](std::size_t offset, std::span<std::uint8_t> out) {
        if (offset > artifact.size() || out.size() > artifact.size()-offset) return false;
        std::copy_n(artifact.data()+offset,out.size(),out.data()); return true;
      }, artifact.size());
      require(layout.has_value(), "startup texture layout unavailable");
      std::size_t paletteBytes = 0;
      for (const auto& plane : layout->planes) paletteBytes += std::size_t(plane.width)*plane.height*pmjs::textureTexelBytes(plane.format);
      const auto indexed = images.loadPng(path);
      require(indexed && !indexed->texture, "prepared image eagerly allocated RGBA storage");
      const auto view = images.resolvePaletteImage(indexed->handle, false);
      require(view && view->image.texture && view->table, "prepared palette view unavailable");
      require(images.gpuBytes() == paletteBytes, "prepared allocation accounting differs");
      require(images.sourceTextureBuilds() == 0, "drawing rebuilt startup texture data");
      const auto entries = images.memoryEntries();
      require(std::any_of(entries.begin(), entries.end(), [&](const auto& entry) {
        return entry.handle == indexed->handle && entry.paletteIndexBits == int(indexBytes * 8);
      }), "palette index width did not match its color count");
      const auto roundtrip = images.readPixelsRegion(indexed->handle, 0, 0, width, height);
      require(roundtrip && roundtrip->rgba == pixels.rgba, "16-bit palette readback changed RGBA bytes");
      for (const pmjs::AssetRect rect : {pmjs::AssetRect{0, 0, 1, 1},
          {width - 1, height - 1, 1, 1}, {13, 7, 17, 9}, {0, height - 1, width, 1}}) {
        glPixelStorei(GL_PACK_ALIGNMENT, 8);
        glPixelStorei(GL_PACK_ROW_LENGTH, 29);
        glPixelStorei(GL_PACK_SKIP_PIXELS, 3);
        glPixelStorei(GL_PACK_SKIP_ROWS, 2);
        lastReadRect = {-1,-1,-1,-1};
        const auto region = images.readPixelsRegion(indexed->handle, rect[0], rect[1], rect[2], rect[3]);
        require(region && region->rgba.size() == std::size_t(rect[2]) * rect[3] * 4,
          "palette region extent differs");
        require(lastReadRect == rect || lastReadRect == pmjs::AssetRect{-1,-1,-1,-1},
          "palette region read unrelated source texels");
        for (int y = 0; y < rect[3]; ++y)
          require(std::memcmp(region->rgba.data() + std::size_t(y) * rect[2] * 4,
            pixels.rgba.data() + (std::size_t(y + rect[1]) * width + rect[0]) * 4,
            std::size_t(rect[2]) * 4) == 0, "palette region changed source pixels");
        GLint value = 0;
        for (const auto parameter : {GL_PACK_ALIGNMENT, GL_PACK_ROW_LENGTH, GL_PACK_SKIP_PIXELS, GL_PACK_SKIP_ROWS}) {
          glGetIntegerv(parameter, &value);
          require(value == (parameter == GL_PACK_ALIGNMENT ? 8 : parameter == GL_PACK_ROW_LENGTH ? 29 :
            parameter == GL_PACK_SKIP_PIXELS ? 3 : 2), "palette region changed pixel pack state");
        }
        glPixelStorei(GL_PACK_ALIGNMENT, 4); glPixelStorei(GL_PACK_ROW_LENGTH, 0);
        glPixelStorei(GL_PACK_SKIP_PIXELS, 0); glPixelStorei(GL_PACK_SKIP_ROWS, 0);
      }
      require(!images.readPixelsRegion(indexed->handle, -1, 0, 1, 1) &&
        !images.readPixelsRegion(indexed->handle, width, 0, 1, 1), "palette region accepted invalid bounds");
      const auto control = images.createRgba(width, height, pixels.rgba.data());
      const auto tilingPath = root / (path.stem().string() + "-linear-tiling.png");
      std::filesystem::copy_file(path, tilingPath, std::filesystem::copy_options::overwrite_existing);
      for (int variant : {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 16, 17, 20, 21, 24, 25, 28, 29, 64, 65, 130, 131, 194, 195, 256, 257, 258, 259, 320, 321, 512, 513, 1536, 1537}) {
        const bool linearTiling = (variant & 512) && !(variant & 1);
        const auto sampled = linearTiling ? images.loadPng(tilingPath) : indexed;
        require(sampled.has_value(), "palette sampling fixture failed");
        const auto actual = render(renderer, sampled->handle, width, height, variant);
        const auto expected = render(renderer, control->handle, width, height, variant);
        const int tolerance = variant & 1 ? 0 : 1;
        const bool matches = std::equal(actual.begin(), actual.end(), expected.begin(),
          [tolerance](auto a, auto b) { return std::abs(int(a) - int(b)) <= tolerance; });
        if (!matches) {
          int maxDelta = 0;
          for (std::size_t i = 0; i < actual.size(); ++i)
            maxDelta = std::max(maxDelta, std::abs(int(actual[i]) - int(expected[i])));
          std::fprintf(stderr, "palette colors=%u opaque=%d variant=%d max_delta=%d\n", colorCount, opaque, variant, maxDelta);
        }
        require(matches, "palette rendering differs from RGBA");
        if (linearTiling) {
          require(!images.resolvePaletteImage(sampled->handle, false),
            "linear tiling retained shader-decoded palette storage");
          images.release(sampled->handle);
        }
        ++comparisons;
      }
      require(images.resolvePaletteImage(indexed->handle, false).has_value(),
        "nearest draws promoted the palette to RGBA");
      const auto premultiplied = images.resolvePaletteImage(indexed->handle, true);
      require(premultiplied && premultiplied->image.texture == view->image.texture,
        "premultiplied palette duplicated index storage");
      const auto afterPremultiply = images.gpuBytes();
      require(images.resolvePaletteImage(indexed->handle, true).has_value() &&
        images.gpuBytes() == afterPremultiply, "premultiplied palette was recreated");
      auto snapshot = images.deferPixelRead(indexed->handle, 0, 0, 2, 1);
      require(images.beginUse(indexed->handle), "palette pending-use setup failed");
      const auto rgba = images.lookup(indexed->handle);
      require(rgba && rgba->texture && glIsTexture(view->image.texture),
        "RGBA promotion destroyed an in-flight palette texture");
      require(!images.resolvePaletteImage(indexed->handle, false), "promoted image kept an active index view");
      require(render(renderer, indexed->handle, width, height, 0) ==
        render(renderer, control->handle, width, height, 0), "palette linear fallback differs from RGBA");
      ++comparisons;
      const std::array<std::uint8_t, 4> replacement{11, 29, 73, 109};
      require(images.updateRgbaRegion(indexed->handle, 0, 0, 1, 1, replacement.data(), 1),
        "palette mutation failed");
      require(snapshot->pixels && std::equal(snapshot->pixels->rgba.begin(), snapshot->pixels->rgba.end(), pixels.rgba.begin()),
        "palette mutation changed a deferred reader's snapshot");
      require(images.endUse(indexed->handle), "palette pending-use release failed");
      require(!glIsTexture(view->image.texture), "retired palette survived its last pending reader");
      const auto changed = images.readPixelsRegion(indexed->handle, 0, 0, 1, 1);
      require(changed && std::equal(changed->rgba.begin(), changed->rgba.end(), replacement.begin()),
        "mutated palette fallback returned stale pixels");
      renderer.beginFrame();
      images.release(indexed->handle); images.release(control->handle); images.update();
      require(images.gpuBytes() == 0, "palette or promoted RGBA allocations leaked");
      if (opaque && colorCount == 256) {
        pixels.rgba[3] = 254;
        writePng(path, pixels);
        require(!images.installStorageDecision(path, source->key(), decision),
          "changed source accepted stale storage metadata");
        const auto oldHits = images.storageDecisionHits();
        const auto changed = images.loadPng(path);
        require(changed && images.storageDecisionHits() == oldHits && !images.resolvePaletteImage(changed->handle, false),
          "changed image must use ordinary storage until the next startup");
        const auto owners = images.memoryEntries();
        require(std::any_of(owners.begin(), owners.end(), [&](const auto& owner) {
          return owner.handle == changed->handle && owner.paletteIndexBits == 0;
        }), "changed source unexpectedly compiled a palette");
        images.release(changed->handle); images.update();
        require(images.gpuBytes() == 0, "changed-source palette leaked");
        auto rgbaDecision = decision;
        rgbaDecision.paletteBits = 0;
        const auto currentSource = pmjs::ImageStore::openFile(path);
        require(images.installStorageDecision(path, currentSource->key(), rgbaDecision),
          "ordinary-storage decision installation failed");
        const auto ordinary = images.loadPng(path);
        require(ordinary && ordinary->texture && !images.resolvePaletteImage(ordinary->handle, false),
          "ordinary-storage decision rediscovered palette eligibility");
        images.release(ordinary->handle); images.update();
        require(images.gpuBytes() == 0, "ordinary-storage decision leaked");
      }
      if (opaque && colorCount == 65536) {
        pmjs::PreparedImageDescriptor descriptor;
        pmjs::AssetRecipe recipe; recipe.columns = 3; recipe.rows = 2; recipe.framePages = true;
        const auto asset = pmjs::prepareAssetImage(path, root / "prepared-palette", recipe);
        descriptor.width = width; descriptor.height = height; descriptor.halo = asset.halo;
        descriptor.framePages = asset.framePages;
        for (const auto& page : asset.pages)
          descriptor.pages.push_back({page.path, page.width, page.height});
        for (const auto& cell : asset.cells)
          descriptor.cells.push_back({cell.rect, cell.crop, cell.atlas, cell.fill, cell.page});
        require(images.installPrepared(path, root / "prepared-palette", descriptor), "prepared palette installation failed");
        const auto prepared = images.loadPng(path);
        const auto preparedHits = images.storageDecisionHits();
        require(prepared && images.resolvePaletteImage(prepared->handle, false),
          "prepared image did not realize a full palette");
        require(images.storageDecisionHits() == preparedHits + 1, "prepared image ignored storage metadata");
        require(images.gpuBytes() == paletteBytes, "prepared palette retained an extra RGBA texture");
        require(images.cpuBytes() < 512 * 1024, "resident palette retained decoded preparation pages");
        const auto preparedPixels = images.readPixelsRegion(prepared->handle, 0, 0, width, height);
        require(preparedPixels && preparedPixels->rgba == pixels.rgba,
          "prepared palette reconstruction changed pixels");
        images.release(prepared->handle); images.update();
        require(images.gpuBytes() == 0, "prepared palette allocation leaked");

        pixels.rgba[3] = 254; // The original opaque color still occurs elsewhere.
        const auto overflowPath = root / "palette-overflow.png";
        writePng(overflowPath, pixels);
        const auto overflow = images.loadPng(overflowPath);
        require(overflow && overflow->texture && !images.resolvePaletteImage(overflow->handle, false),
          "65,537 colors must fall back to a full texture without truncating indices");
        require(images.gpuBytes() == pixels.rgba.size(), "palette overflow fallback accounting differs");
        images.release(overflow->handle); images.update();
        require(images.gpuBytes() == 0, "palette overflow fallback leaked");
      }
    }
    {
      pmjs::ImagePixels pixels{2, 1, {11, 29, 73, 109, 43, 89, 127, 173}};
      const auto path = root / "invalid-channel-hint.png";
      writePng(path, pixels);
      pmjs::ImageStorageDecision decision{2, 1, 0, {1, {0, 1, 2, 3}, {0, 0, 0, 5}}};
      require(images.installStorageDecision(path, pmjs::ImageStore::openFile(path)->key(), decision),
        "channel-hint fixture installation failed");
      const auto image = images.loadPng(path);
      const auto readback = images.readPixelsRegion(image->handle, 0, 0, 2, 1);
      require(readback && readback->rgba == pixels.rgba, "incorrect compact hint changed source pixels");
      images.release(image->handle); images.update();
      require(images.gpuBytes() == 0, "invalid channel hint leaked an allocation");
    }
    require(glGetError() == GL_NO_ERROR, "grayscale operations left a GL error");
  }
  std::filesystem::remove_all(root);
  std::cout << comparisons << " exact RGBA/compact rendering comparisons; exhaustive channel/alpha readback and ownership passed\n";
}
