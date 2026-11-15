#include "assets/asset_processor.hpp"
#include "graphics/astc_texture.hpp"
#include "platform/platform.hpp"
#include "graphics/resources.hpp"
#include <GLES3/gl31.h>
#include <algorithm>
#include <array>
#include <filesystem>
#include <iostream>
#include <fstream>
#include <stdexcept>
#include <unistd.h>

namespace {
void require(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
struct Fixture {
  std::filesystem::path root;
  ~Fixture() { std::error_code error; std::filesystem::remove_all(root, error); }
};
}
int main(int argc, char** argv) try {
  require(argc == 2 || argc == 3, "asset fixture root required");
  Fixture fixture{std::filesystem::path(argv[1]) / ("astc-images-" + std::to_string(getpid()))};
  std::filesystem::create_directories(fixture.root);
  pmjs::Platform platform(32, 24, "ASTC resources");
  pmjs::ImageStore images;
  images.setWarmBudgetBytes(0);
  const int width = 4097, height = 2048;
  std::vector<std::uint8_t> original(std::size_t(width) * height * 4);
  for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
    const auto i = (std::size_t(y) * width + x) * 4;
    original[i] = x < 2048 ? 205 : 40; original[i+1] = 33; original[i+2] = 70;
    original[i+3] = x < 2048 ? 255 : 128;
  }
  const auto source = fixture.root / "source.png", directory = fixture.root / "prepared";
  pmjs::writePreparedPng(source, width, height, original);
  pmjs::AssetPreparationOptions options; options.allowAstc = true;
  const auto asset = pmjs::prepareAssetImage(source, directory, {}, nullptr, options);
  require(asset.compression == "astc-4x4" && asset.pages.size() == 2, "large translucent image should prepare both ASTC alpha representations");
  pmjs::PreparedImageDescriptor descriptor;
  descriptor.width = width; descriptor.height = height; descriptor.compression = asset.compression;
  for (const auto& page : asset.pages) descriptor.pages.push_back({page.path, page.width, page.height});
  require(images.installPrepared(source, directory, descriptor), "ASTC descriptor installation failed");
  auto image = images.loadPng(source);
  require(bool(image), "prepared ASTC image load failed");
  if (argc == 3) {
    require(images.sceneryWindowUploads() == 0, "unsupported ASTC must not create scenery windows");
    const auto* fallbackPixels = images.readPixels(image->handle);
    require(fallbackPixels && fallbackPixels->rgba == original, "unsupported ASTC fallback must preserve authored pixels");
    const auto entries = images.memoryEntries();
    require(std::none_of(entries.begin(), entries.end(), [](const auto& e) { return e.astc; }), "unsupported ASTC must not remain active");
    std::cout << "Unsupported ASTC falls back to ordinary lossless scenery storage\n";
    return 0;
  }
  const auto premultiplied = images.lookupPremultiplied(image->handle);
  require(bool(premultiplied) && premultiplied->texture, "premultiplied ASTC materialization failed");
  auto entries = images.memoryEntries();
  const auto owner = std::find_if(entries.begin(), entries.end(), [&](const auto& e) { return e.handle == image->handle; });
  require(owner != entries.end() && owner->astc && owner->cpuBytes == 0 && owner->gpuBytes == pmjs::astc4x4Bytes(width, height), "ASTC storage must include edge block padding without retaining pixels");
  require(images.sceneryWindowUploads() == 0, "full ASTC images should not create scenery windows");
  GLint compressed = 0; glBindTexture(GL_TEXTURE_2D, premultiplied->texture);
  glGetTexLevelParameteriv(GL_TEXTURE_2D, 0, GL_TEXTURE_COMPRESSED, &compressed);
  require(compressed == GL_TRUE, "compressed texture upload did not activate");
  GLuint failedBuffer = 0;
  glGenBuffers(1, &failedBuffer); glBindBuffer(GL_PIXEL_UNPACK_BUFFER, failedBuffer);
  glBufferData(GL_PIXEL_UNPACK_BUFFER, 4, nullptr, GL_STREAM_DRAW);
  require(!images.retainCpuPixels(image->handle), "invalid upload state must reject promotion");
  glBindBuffer(GL_PIXEL_UNPACK_BUFFER, 0); glDeleteBuffers(1, &failedBuffer);
  require(glIsTexture(premultiplied->texture) && images.memoryEntries()[0].astc,
    "failed promotion must preserve the old compressed resource");
  require(!images.ensureMipmaps(image->handle, true) && images.memoryEntries()[0].astc,
    "rejected non-power-of-two mipmaps should preserve compressed storage");
  const std::array<std::uint8_t,4> replacement{7, 8, 9, 255};
  const auto straightTexture = images.lookup(image->handle)->texture;
  require(images.beginUse(image->handle), "pending image user should retain the old physical textures");
  require(images.updateRgbaRegion(image->handle, width-1, height-1, 1, 1, replacement.data(), 1), "ASTC mutation should promote to authored RGBA");
  require(glIsTexture(straightTexture) && glIsTexture(premultiplied->texture),
    "promotion must retain both compressed textures while a user is pending");
  require(images.gpuBytes() == std::size_t(width) * height * 4 + 2 * pmjs::astc4x4Bytes(width, height),
    "retired compressed textures must remain in resident byte accounting");
  require(images.endUse(image->handle) && !glIsTexture(straightTexture) && !glIsTexture(premultiplied->texture),
    "completed image use must retire old compressed textures");
  const auto* pixels = images.readPixels(image->handle);
  require(pixels && std::equal(pixels->rgba.begin(), pixels->rgba.end()-4, original.begin()), "mutation fallback must preserve every untouched authored pixel");
  require(std::equal(replacement.begin(), replacement.end(), pixels->rgba.end()-4), "mutation pixel was lost");
  entries = images.memoryEntries();
  require(std::none_of(entries.begin(), entries.end(), [](const auto& e) { return e.astc; }), "mutated image must leave the lossy path");
  const auto beforeRelease = images.gpuBytes();
  const bool released = images.release(image->handle);
  images.update();
  if (!released || images.gpuBytes()) std::cerr << "GPU before release=" << beforeRelease << " after=" << images.gpuBytes() << " live=" << images.liveCount() << '\n';
  require(released && images.gpuBytes() == 0, "compressed and promoted textures must release exactly once");
  images.setWarmBudgetBytes(64U * 1024U * 1024U);
  image = images.loadPng(source);
  require(image && images.release(image->handle) && images.warmFileCount() == 3,
    "unmaterialized ASTC must account for held original and artifact files in the warm cache");
  require(images.retain(image->handle), "warm ASTC image should remain reusable");
  const auto region = images.readPixelsRegion(image->handle, width-1, height-1, 1, 1);
  require(region && std::equal(region->rgba.begin(), region->rgba.end(), original.end()-4),
    "CPU region reads must recover exact authored pixels before GPU materialization");
  images.release(image->handle); images.setWarmBudgetBytes(0); images.update();
  require(images.warmFileCount() == 0 && images.gpuBytes() == 0,
    "warm eviction must release ASTC file ownership and promoted GPU storage");
  // Corrupted prepared output takes the ordinary source path.
  { std::ofstream corrupt(directory / asset.pages[0].path, std::ios::binary | std::ios::trunc); corrupt << "invalid"; }
  require(images.installPrepared(source, directory, descriptor), "corruption fixture metadata should install");
  image = images.loadPng(source, true);
  require(bool(image), "corrupted ASTC must fall back to the original PNG");
  pixels = images.readPixels(image->handle);
  require(pixels && pixels->rgba == original, "corrupted ASTC fallback is not lossless");
  images.release(image->handle);
  images.update();
  // Opaque data shares alpha representations; mipmaps recover authored pixels.
  const int opaqueWidth = 4096;
  std::vector<std::uint8_t> opaque(std::size_t(opaqueWidth) * height * 4);
  for (std::size_t i = 0; i < opaque.size(); i += 4) {
    opaque[i] = (i / 4) % opaqueWidth < 2048 ? 205 : 40;
    opaque[i+1] = 33; opaque[i+2] = 70; opaque[i+3] = 255;
  }
  const auto opaqueSource = fixture.root / "opaque.png", opaqueDirectory = fixture.root / "opaque";
  pmjs::writePreparedPng(opaqueSource, opaqueWidth, height, opaque);
  const auto opaqueAsset = pmjs::prepareAssetImage(opaqueSource, opaqueDirectory, {}, nullptr, options);
  require(opaqueAsset.compression == "astc-4x4" && opaqueAsset.pages.size() == 1, "opaque images should prepare a single ASTC representation");
  pmjs::AssetRecipe frames; frames.columns = 4; frames.rows = 2;
  const auto framed = pmjs::prepareAssetImage(opaqueSource, fixture.root / "frames", frames, nullptr, options);
  require(framed.compression == "astc-4x4",
    "opted-in sprite sheets should use full ASTC storage without a size or frame-grid filter");
  pmjs::AssetPreparationOptions lossless;
  const auto losslessFrames = pmjs::prepareAssetImage(opaqueSource, fixture.root / "lossless-frames", frames, nullptr, lossless);
  require(losslessFrames.compression.empty() && losslessFrames.cells.size() == 8,
    "default lossless mode must preserve prepared-frame storage");
  descriptor.width = opaqueWidth; descriptor.pages.clear();
  descriptor.pages.push_back({opaqueAsset.pages[0].path, opaqueWidth, height});
  require(images.installPrepared(opaqueSource, opaqueDirectory, descriptor), "opaque descriptor installation failed");
  image = images.loadPng(opaqueSource);
  const auto straight = images.lookup(image->handle);
  const auto premult = images.lookupPremultiplied(image->handle);
  require(straight && premult && straight->texture == premult->texture && images.gpuBytes() == pmjs::astc4x4Bytes(opaqueWidth, height), "opaque ASTC should share alpha representations");
  require(images.ensureMipmaps(image->handle, true), "mipmap consumer should promote to lossless storage");
  pixels = images.readPixels(image->handle);
  require(pixels && pixels->rgba == opaque, "mipmap fallback must recover original pixels");
  images.release(image->handle); images.update();
  require(images.gpuBytes() == 0, "mipmap fallback storage should release without accounting drift");
  std::fill(opaque.begin(), opaque.end(), 255);
  const auto exactSource = fixture.root / "exact.png";
  pmjs::writePreparedPng(exactSource, opaqueWidth, height, opaque);
  require(pmjs::prepareAssetImage(exactSource, fixture.root / "exact", {}, nullptr, options).compression == "astc-4x4", "opted-in uniform images should also use ASTC");
  for (std::size_t i = 0; i < opaque.size(); i += 4) {
    opaque[i] = opaque[i+1] = opaque[i+2] = (i/4) % opaqueWidth < 2048 ? 60 : 180;
  }
  pmjs::writePreparedPng(exactSource, opaqueWidth, height, opaque);
  pmjs::AssetRecipe halves; halves.columns = 2;
  require(pmjs::prepareAssetImage(exactSource, fixture.root / "gray", halves, nullptr, options).compression == "astc-4x4", "opted-in opaque grayscale should also use ASTC");
  for (std::size_t i = 3; i < opaque.size(); i += 4) opaque[i] = (i/4) % opaqueWidth < 2048 ? 64 : 192;
  pmjs::writePreparedPng(exactSource, opaqueWidth, height, opaque);
  require(pmjs::prepareAssetImage(exactSource, fixture.root / "gray-alpha", frames, nullptr, options).compression == "astc-4x4",
    "opted-in grayscale-alpha images should also use ASTC");
  opaque.resize(std::size_t(2048) * 2048 * 4);
  for (std::size_t i = 0; i < opaque.size(); i += 4) { opaque[i] = 200; opaque[i+1] = 30; opaque[i+2] = 80; opaque[i+3] = 255; }
  pmjs::writePreparedPng(exactSource, 2048, 2048, opaque);
  require(pmjs::prepareAssetImage(exactSource, fixture.root / "small", {}, nullptr, options).compression == "astc-4x4", "ASTC must not impose a minimum image area");
  std::vector<std::uint8_t> tiny{11,22,33,128};
  pmjs::writePreparedPng(exactSource, 1, 1, tiny);
  const auto tinyAsset = pmjs::prepareAssetImage(exactSource, fixture.root / "tiny", {}, nullptr, options);
  require(tinyAsset.compression == "astc-4x4" && tinyAsset.pages.size() == 2 &&
    std::filesystem::file_size(fixture.root / "tiny" / tinyAsset.pages[0].path) == 32,
    "opted-in one-pixel images must prepare both padded alpha representations");
  std::cout << "ASTC preparation, block padding, activation, mutation, ownership and corrupted-output fallback passed\n";
  return 0;
} catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
