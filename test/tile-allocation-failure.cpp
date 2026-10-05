#include "platform.hpp"
#include "renderer.hpp"
#include "tile_assets.hpp"

#include <GLES3/gl3.h>
#include <algorithm>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <unistd.h>

namespace {
int textureCountdown = 0, bufferFailures = 0;
GLenum pendingError = GL_NO_ERROR;
void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
}
extern "C" {
void __real_glTexImage2D(GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, const void*);
void __real_glBufferData(GLenum, GLsizeiptr, const void*, GLenum);
GLenum __real_glGetError();
void __wrap_glTexImage2D(GLenum target, GLint level, GLint format, GLsizei width,
    GLsizei height, GLint border, GLenum sourceFormat, GLenum type, const void* pixels) {
  if (textureCountdown && --textureCountdown == 0) { pendingError = GL_OUT_OF_MEMORY; return; }
  __real_glTexImage2D(target, level, format, width, height, border, sourceFormat, type, pixels);
}
void __wrap_glBufferData(GLenum target, GLsizeiptr size, const void* pixels, GLenum usage) {
  if (bufferFailures) { --bufferFailures; pendingError = GL_OUT_OF_MEMORY; return; }
  __real_glBufferData(target, size, pixels, usage);
}
GLenum __wrap_glGetError() {
  if (pendingError != GL_NO_ERROR) { const auto error = pendingError; pendingError = GL_NO_ERROR; return error; }
  return __real_glGetError();
}
}

int main() try {
  setenv("PMJS_GRAPHICS_DIAGNOSTICS", "1", 1);
  pmjs::Platform platform(32, 32, "Tile allocation failure");
  char temporary[] = "/tmp/pmjs-tile-allocation-XXXXXX";
  const auto* directory = mkdtemp(temporary);
  require(directory, "temporary directory failed");
  const std::filesystem::path root(directory);
  pmjs::ImagePixels pixels{6, 6, std::vector<std::uint8_t>(6*6*4)};
  for (int i = 0; i < 36; ++i) {
    pixels.rgba[i*4] = i*7; pixels.rgba[i*4+1] = 211-i*3;
    pixels.rgba[i*4+2] = i*5; pixels.rgba[i*4+3] = i%3 ? 255 : 97;
  }
  pmjs::writePreparedPng(root/"source.png", 6, 6, pixels.rgba);
  pmjs::writePreparedPng(root/"snapshot.png", 6, 6, pixels.rgba);
  pmjs::ImagePixels page{8, 8, std::vector<std::uint8_t>(8*8*4)};
  for (int y = 0; y < 5; ++y) for (int x = 0; x < 5; ++x)
    std::copy_n(pixels.rgba.data()+(y*6+x)*4, 4, page.rgba.data()+(y*8+x)*4);
  pmjs::writePreparedPng(root/"page.png", 8, 8, page.rgba);
  {
    pmjs::ImageStore images;
    images.setWarmBudgetBytes(0);
    pmjs::PreparedTileSet descriptor;
    descriptor.identity = "active"; descriptor.directory = root; descriptor.pages = {{"page.png", 8, 8}};
    descriptor.sources.push_back({root/"source.png", root/"snapshot.png",
      pmjs::ImageStore::openFile(root/"source.png")->key(), 6, 6,
      {{{1, 1, 3, 3}, {1, 1, 3, 3}, 0}}});
    require(images.installTileSet(descriptor), "catalog installation failed");
    const auto active = images.loadPng(root/"source.png", false, "active");
    require(active && images.hasTileBacking(active->handle), "initial prepared load failed");
    const auto initialBytes = images.gpuBytes();
    for (int upload : {1, 2}) {
      descriptor.identity = "failed-"+std::to_string(upload);
      require(images.installTileSet(descriptor), "failure catalog installation failed");
      textureCountdown = upload;
      const auto fallback = images.loadPng(root/"source.png", false, descriptor.identity);
      require(textureCountdown == 0 && fallback && !images.hasTileBacking(fallback->handle), "failed upload did not select ordinary backing");
      require(images.readPixels(fallback->handle)->rgba == pixels.rgba, "upload fallback changed source pixels");
      require(images.hasTileBacking(active->handle), "upload failure invalidated existing owner");
      images.release(fallback->handle); images.update();
      require(images.gpuBytes() == initialBytes, "partial atlas upload leaked storage");
    }
    require(images.tileFallbacks().at("page-allocation") == 2, "upload failure diagnostics missing");
    const auto ordinary = images.loadPng(root/"source.png");
    require(ordinary.has_value(), "ordinary control load failed");
    {
      pmjs::Renderer renderer(32, 32, images);
      auto draw = [&](pmjs::ImageHandle image) {
        const auto layer = renderer.createTileLayer({{image, {1, 1, 3, 3}, {0, 0}, {0, 0}}});
        require(layer != 0, "tile layer creation failed");
        const std::array<std::uint32_t, pmjs::scene_packet::metadataStride> metadata{4, 0xffffffffU, layer, 0xffffff, 0, 8, 0};
        std::array<float, pmjs::scene_packet::valueStride> values{};
        values[0] = values[3] = 4; values[4] = 3.25F; values[5] = 5.5F; values[6] = 0.73F;
        renderer.beginFrame();
        require(renderer.queueScene(pmjs::scene_packet::version, metadata.data(), metadata.size(), values.data(), values.size(), 1), "tile submission failed");
        renderer.releaseTileLayer(layer);
        renderer.renderScene();
        return renderer.captureSceneRawPremultiplied();
      };
      const auto expected = draw(ordinary->handle);
      bufferFailures = 1;
      require(draw(active->handle) == expected && bufferFailures == 0, "buffer allocation fallback changed pixels");
      require(images.tileFallbacks().at("tile-geometry-allocation") == 1, "buffer failure diagnostics missing");
      bufferFailures = 2;
      bool refused = false;
      try { draw(active->handle); } catch (const std::runtime_error&) { refused = true; }
      require(refused && bufferFailures == 0, "failed ordinary retry published partial output");
      require(draw(active->handle) == expected, "allocation failure prevented later exact recovery");
      for (int attempt = 0; attempt < 2; ++attempt) {
        if (attempt == 1) {
          const auto snapshot = renderer.renderToImage(32, 32);
          require(snapshot.has_value(), "snapshot warmup failed");
          images.release(snapshot->handle); images.update();
        }
        const auto bytesBefore = images.gpuBytes();
        const auto targetBytesBefore = renderer.stats().rendererTargetBytes;
        textureCountdown = 1;
        bool allocationFailed = false;
        try { renderer.renderToImage(32, 32); } catch (const std::bad_alloc&) { allocationFailed = true; }
        require(allocationFailed && textureCountdown == 0, "snapshot allocation did not report recoverable failure");
        require(images.gpuBytes() == bytesBefore && renderer.stats().rendererTargetBytes == targetBytesBefore,
          "failed snapshot leaked image or renderer storage");
        require(draw(ordinary->handle) == expected, "snapshot allocation failure prevented ordinary rendering");
      }
      renderer.beginFrame();
      require(renderer.tileGeometryGpuBytes() == 0, "failed tile buffers leaked storage");
    }
    images.release(active->handle); images.release(ordinary->handle); images.update();
    require(images.gpuBytes() == 0 && images.liveCount() == 0, "teardown retained allocations");
  }
  std::filesystem::remove_all(root);
  std::cout << "atlas and geometry allocation failure preserve exact output and owners\n";
  return 0;
} catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
