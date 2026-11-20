#include "assets/asset_processor.hpp"
#include "assets/texture_artifact.hpp"
#include "graphics/renderer.hpp"
#include "graphics/resources.hpp"
#include "platform/platform.hpp"

#include <algorithm>
#include <array>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <vector>
#include <unistd.h>

namespace {
void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}

struct FixtureDirectory {
  std::filesystem::path path;
  FixtureDirectory() {
    const auto root = std::filesystem::current_path() / ".cache/tests";
    std::filesystem::create_directories(root);
    auto name = (root / "grayscale-images-XXXXXX").string();
    require(mkdtemp(name.data()) != nullptr, "fixture directory creation failed");
    path = name;
  }
  ~FixtureDirectory() { std::filesystem::remove_all(path); }
};

std::vector<std::uint8_t> draw(pmjs::Renderer& renderer, const pmjs::ImageInfo& image,
    bool nearest, bool transformed, bool tone) {
  namespace packet = pmjs::scene_packet;
  std::array<std::uint32_t, packet::metadataStride> metadata{1, packet::noParent,
    image.handle, 0xa7c3e9, 0, 0, 0};
  if (nearest) metadata[5] |= packet::nearestSampling;
  if (tone) metadata[5] |= packet::hasSpriteColor;
  std::array<float, packet::valueStride> values{};
  values[0] = 64.0F / image.width; values[3] = 48.0F / image.height; values[6] = 0.63F;
  values[11] = values[13] = image.width; values[12] = values[14] = image.height;
  if (transformed) {
    values[0] *= -0.81F; values[1] = 0.027F; values[2] = 0.017F;
    values[3] *= 0.73F; values[4] = 60.25F; values[5] = 3.375F;
  }
  if (tone) { values[33] = 0.13F; values[34] = -0.07F; values[35] = 0.04F; values[36] = 0.65F; }
  renderer.setClearColor(0.1F, 0.2F, 0.3F, 1);
  renderer.beginFrame();
  require(renderer.queueScene(packet::version, metadata.data(), metadata.size(),
    values.data(), values.size(), 1), "scene packet rejected");
  renderer.renderScene();
  return renderer.captureSceneRawPremultiplied();
}

void compare(pmjs::Renderer& renderer, const pmjs::ImageInfo& actual, const pmjs::ImageInfo& reference) {
  for (bool nearest : {false, true}) for (bool transformed : {false, true}) for (bool tone : {false, true}) {
    const auto result = draw(renderer, actual, nearest, transformed, tone);
    const auto expected = draw(renderer, reference, nearest, transformed, tone);
    const auto tolerance = nearest ? 0 : 1;
    require(std::equal(result.begin(), result.end(), expected.begin(), expected.end(),
      [&](auto a, auto b) { return std::abs(int(a) - int(b)) <= tolerance; }), "image sampling changed pixels");
  }
}
}

int main() try {
  pmjs::Platform platform(64, 48, "Image storage differential");
  FixtureDirectory fixture;
  pmjs::ImageStore images;
  images.setWarmBudgetBytes(0);
  images.setPalettizationEnabled(true);
  pmjs::Renderer renderer(64, 48, images);
  for (const bool opaque : {false, true}) {
    pmjs::ImagePixels pixels{257, 64, std::vector<std::uint8_t>(257 * 64 * 4)};
    for (std::size_t i = 0; i < pixels.rgba.size(); i += 4) {
      const auto gray = static_cast<std::uint8_t>(i / 4);
      pixels.rgba[i] = pixels.rgba[i + 1] = pixels.rgba[i + 2] = gray;
      pixels.rgba[i + 3] = opaque ? 255 : (i / 1024) % 2 ? gray / 3 : 255 - gray;
    }
    const auto path = fixture.path / "grayscale.png";
    pmjs::writePreparedPng(path, pixels.width, pixels.height, pixels.rgba);
    const auto source = pmjs::ImageStore::openFile(path);
    auto storage = pmjs::ImageStore::classifyStorage(pixels);
    require(storage.channels.channels == (opaque ? 1 : 2), "grayscale classification changed");
    require(images.installStorageDecision(path, source->key(), storage), "storage decision rejected");
    const auto loaded = images.loadPng(path), alias = images.loadPng(path);
    require(loaded && alias && loaded->handle == alias->handle, "load did not reuse its resident image");
    require(images.gpuBytes() == pixels.rgba.size(), "ordinary image changed its RGBA storage");
    std::filesystem::remove(path);
    for (int frame = 0; frame < 61; ++frame) images.update();
    require(!images.hasCpuPixels(loaded->handle), "CPU image did not expire");
    const auto readback = images.readPixelsRegion(loaded->handle, 0, 0, pixels.width, pixels.height);
    require(readback && readback->rgba == pixels.rgba, "GPU readback changed hidden RGB or alpha");
    const auto control = images.createRgba(pixels.width, pixels.height, pixels.rgba.data());
    require(control.has_value(), "RGBA control failed");
    compare(renderer, *loaded, *control);
    const std::array<std::uint8_t, 4> changed{17, 43, 91, 127};
    require(images.updateRgbaRegion(loaded->handle, 19, 37, 1, 1, changed.data(), 1), "image write failed");
    const auto updated = images.readPixelsRegion(alias->handle, 19, 37, 1, 1);
    require(updated && std::equal(updated->rgba.begin(), updated->rgba.end(), changed.begin(), changed.end()),
      "aliased image did not observe mutation");
    renderer.beginFrame();
    images.release(loaded->handle); images.release(alias->handle); images.release(control->handle); images.update();
    require(images.gpuBytes() == 0, "ordinary image storage leaked");
  }
  for (const unsigned colors : {127U, 1024U}) {
    constexpr int width = 512, height = 256;
    pmjs::ImagePixels pixels{width, height, std::vector<std::uint8_t>(width * height * 4)};
    for (std::size_t i = 0; i < pixels.rgba.size() / 4; ++i) {
      const unsigned index = i * 73 % colors;
      pixels.rgba[i*4] = index & 255;
      pixels.rgba[i*4+1] = index >> 8;
      pixels.rgba[i*4+2] = (index * 17) & 255;
      pixels.rgba[i*4+3] = (index * 31) & 255;
    }
    const auto source = fixture.path / "palette.png", staging = fixture.path / std::to_string(colors);
    pmjs::writePreparedPng(source, width, height, pixels.rgba);
    std::filesystem::create_directory(staging);
    const auto artifact = pmjs::makePreparedTexture(pixels, nullptr, 0, true);
    require(artifact.has_value(), "palette artifact fixture failed");
    pmjs::writeTextureArtifact(staging / "texture.pmtx", *artifact);
    constexpr int halo = 1;
    constexpr int pageWidth = width / 2 + halo * 2, pageHeight = height + halo * 2;
    pmjs::PreparedImageDescriptor descriptor;
    descriptor.width = width; descriptor.height = height; descriptor.halo = halo;
    descriptor.framePages = true; descriptor.textureArtifact = "texture.pmtx";
    for (int cell = 0; cell < 2; ++cell) {
      const int x = width / 2 * cell;
      const auto page = std::to_string(cell) + ".png";
      std::vector<std::uint8_t> recovery(pageWidth * pageHeight * 4);
      for (int row = 0; row < pageHeight; ++row) for (int column = 0; column < pageWidth; ++column) {
        const auto sx = std::clamp(x + column - halo, 0, width - 1);
        const auto sy = std::clamp(row - halo, 0, height - 1);
        std::copy_n(pixels.rgba.begin() + (sy * width + sx) * 4, 4,
          recovery.begin() + (row * pageWidth + column) * 4);
      }
      pmjs::writePreparedPng(staging / page, pageWidth, pageHeight, recovery);
      descriptor.pages.push_back({page, pageWidth, pageHeight});
      descriptor.cells.push_back({{x,0,width/2,height}, {0,0,width/2,height},
        {halo,halo,width/2,height}, {}, cell});
    }
    require(images.installPrepared(source, staging, descriptor), "palette preparation rejected");
    const auto loaded = images.loadPng(source), control = images.createRgba(width, height, pixels.rgba.data());
    require(loaded && control, "palette fixture load failed");
    const auto view = images.resolvePaletteImage(loaded->handle, false);
    require(view.has_value(), "prepared palette artifact did not activate");
    const auto owners = images.memoryEntries();
    require(std::any_of(owners.begin(), owners.end(), [&](const auto& owner) {
      return owner.handle == loaded->handle && owner.paletteIndexBits == (colors <= 256U ? 8 : 16);
    }), "prepared palette used an unexpected index width");
    const auto readback = images.readPixelsRegion(loaded->handle, 0, 0, width, height);
    require(readback && readback->rgba == pixels.rgba, "prepared recovery changed source pixels");
    compare(renderer, *loaded, *control);
    renderer.beginFrame();
    images.release(loaded->handle); images.release(control->handle); images.update();
    require(images.gpuBytes() == 0 && !images.inspect(loaded->handle), "prepared palette resources leaked");
  }
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
