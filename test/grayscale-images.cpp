#include "platform.hpp"
#include "renderer.hpp"
#include "resources.hpp"

#include <GLES3/gl3.h>
#include <png.h>
#include <unistd.h>
#include <algorithm>
#include <array>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <vector>

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
    int width, int height, int variant) {
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
  m[0] = 1; m[1] = filter ? 0 : packet::noParent; m[2] = handle;
  m[4] = (variant / 12) % 4;
  m[5] = (variant & 1 ? packet::nearestSampling : 0) |
    (variant & 2 ? packet::premultipliedSpriteTexture : 0) |
    (variant & 4 ? packet::hasClipRectangle : 0) |
    (variant & 32 ? packet::mipmapSampling : 0);
  v[0] = 64.0F / width; v[3] = 48.0F / height; v[6] = 0.63F;
  v[11] = v[13] = static_cast<float>(width);
  v[12] = v[14] = static_cast<float>(height);
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
    for (const bool opaque : {false, true}) {
      pmjs::ImagePixels pixels{256, 256, std::vector<std::uint8_t>(256 * 256 * 4)};
      for (int alpha = 0; alpha < 256; ++alpha) for (int gray = 0; gray < 256; ++gray) {
        const auto i = static_cast<std::size_t>(alpha * 256 + gray) * 4;
        pixels.rgba[i] = pixels.rgba[i + 1] = pixels.rgba[i + 2] = gray;
        pixels.rgba[i + 3] = opaque ? 255 : alpha;
      }
      const auto path = root / (opaque ? "opaque.png" : "alpha.png");
      writePng(path, pixels);
      const auto before = images.gpuBytes(), uploads = images.textureUploadBytes();
      const auto compact = images.loadPng(path);
      const auto bytes = static_cast<std::size_t>(256 * 256 * (opaque ? 1 : 2));
      require(compact && images.gpuBytes() - before == bytes &&
        images.textureUploadBytes() - uploads == bytes, "decoded storage or upload accounting wrong");
      const auto cached = images.loadPng(path);
      require(cached && cached->handle == compact->handle, "cached owners lost shared identity");
      std::filesystem::remove(path);
      const auto* read = images.readPixels(compact->handle);
      require(read && read->rgba == pixels.rgba, "grayscale GPU readback lost hidden RGB or alpha");
      for (int frame = 0; frame < 65; ++frame) images.update();
      require(!images.hasCpuPixels(compact->handle), "CPU snapshot failed to expire");
      require(images.readPixels(compact->handle)->rgba == pixels.rgba, "expired snapshot reconstructed incorrectly");
      const auto control = images.createRgba(256, 256, pixels.rgba.data());
      require(control.has_value(), "RGBA control failed");
      for (int variant = 0; variant < 48; ++variant) {
        require(render(renderer, compact->handle, 256, 256, variant) ==
          render(renderer, control->handle, 256, 256, variant), "grayscale rendering differs from RGBA control");
        ++comparisons;
      }
      // Sample every gray/alpha pair at native resolution through the unchanged shader.
      const auto full = [&](pmjs::ImageHandle handle) {
        renderer.beginFrame();
        require(renderer.queueImage(handle, {1, 0, 0, 1, 0, 0}, {0, 0, 256, 256},
          1, 0xffffff, pmjs::BlendMode::normal), "full image draw failed");
        return renderer.renderToRgba(256, 256, 0, pmjs::AlphaMode::premultiplied);
      };
      require(full(compact->handle) == full(control->handle), "full-resolution grayscale sampling differs");
      ++comparisons;
      require(images.ensureMipmaps(compact->handle, false), "compact mipmaps failed");
      const auto mipBytes = static_cast<std::size_t>((65536 - 1) / 3 * (opaque ? 1 : 2));
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

    // Odd row widths, full replacement, retained CPU bytes and recycled slots.
    pmjs::ImagePixels odd{3, 5, std::vector<std::uint8_t>(3 * 5 * 4, 73)};
    auto oddImage = images.installDecodedMemory(odd);
    require(oddImage && images.gpuBytes() == 30, "odd gray+alpha allocation wrong");
    odd.rgba[0] = 17; odd.rgba[1] = 43; odd.rgba[2] = 91;
    const auto uploadBefore = images.textureUploadBytes();
    require(images.updateRgba(oddImage->handle, odd.rgba.data()) && images.gpuBytes() == 60 &&
      images.textureUploadBytes() - uploadBefore == 60, "full promotion uploaded redundant data");
    require(images.readPixels(oddImage->handle)->rgba == odd.rgba, "full replacement lost retained pixels");
    images.release(oddImage->handle); images.update();
    std::fill(odd.rgba.begin(), odd.rgba.end(), 73);
    for (std::size_t i = 3; i < odd.rgba.size(); i += 4) odd.rgba[i] = 255;
    writePng(root / "odd.png", odd);
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
    pmjs::ImagePixels page{16, 8, std::vector<std::uint8_t>(16 * 8 * 4)};
    for (int y = 1; y < 7; ++y) for (int x = 0; x < 16; ++x) {
      if (x % 8 == 0 || x % 8 == 7) continue;
      const auto i = static_cast<std::size_t>(y * 16 + x) * 4;
      page.rgba[i] = page.rgba[i + 1] = page.rgba[i + 2] = y * 16 + x;
      page.rgba[i + 3] = y * 16 + x;
    }
    writePng(root / "source.png", page); writePng(root / "page.png", page);
    pmjs::PreparedImageDescriptor descriptor;
    descriptor.width = 16; descriptor.height = 8;
    descriptor.pages.push_back({"page.png", 16, 8});
    descriptor.cells.push_back({{0, 0, 8, 8}, {1, 1, 6, 6}, {1, 1, 6, 6}, {}, 0});
    descriptor.cells.push_back({{8, 0, 8, 8}, {1, 1, 6, 6}, {9, 1, 6, 6}, {}, 0});
    require(images.installPrepared(root / "source.png", root, descriptor), "prepared grayscale install failed");
    const auto logical = images.loadPng(root / "source.png");
    const auto region = images.resolveSpriteRegion(logical->handle, 0, 0, 8, 8, false);
    require(region && images.gpuBytes() == 256, "prepared grayscale page not compressed");
    require(images.resolveSpriteRegion(logical->handle, 8, 0, 8, 8, true) && images.gpuBytes() == 512,
      "prepared premultiplied page accounting wrong");
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

    // Logical tile views share compressed pages until the last owner releases them.
    pmjs::ImagePixels tile{6, 6, std::vector<std::uint8_t>(6 * 6 * 4)};
    for (std::size_t i = 0; i < tile.rgba.size(); i += 4) {
      tile.rgba[i] = tile.rgba[i + 1] = tile.rgba[i + 2] = 17 + i / 4;
      tile.rgba[i + 3] = 63 + i / 4;
    }
    pmjs::ImagePixels tilePage{8, 8, std::vector<std::uint8_t>(8 * 8 * 4)};
    for (int y = 0; y < 8; ++y) for (int x = 0; x < 8; ++x)
      std::copy_n(tile.rgba.data() + (std::clamp(y - 1, 0, 5) * 6 + std::clamp(x - 1, 0, 5)) * 4,
        4, tilePage.rgba.data() + (y * 8 + x) * 4);
    writePng(root / "tile-page.png", tilePage);
    pmjs::PreparedTileSet tiles;
    tiles.identity = "grayscale-tiles"; tiles.directory = root;
    tiles.pages.push_back({"tile-page.png", 8, 8});
    for (const char* name : {"tile-a.png", "tile-b.png"}) {
      const auto path = root / name;
      writePng(path, tile);
      tiles.sources.push_back({path, path, pmjs::ImageStore::openFile(path)->key(), 6, 6,
        {{{0, 0, 6, 6}, {1, 1, 6, 6}, 0}}});
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
    require(glGetError() == GL_NO_ERROR, "grayscale operations left a GL error");
  }
  std::filesystem::remove_all(root);
  std::cout << comparisons << " exact RGBA/grayscale rendering comparisons; exhaustive gray/alpha readback and ownership passed\n";
}
