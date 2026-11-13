#include "mv_core_audio_graphics.hpp"
#include "runtime_core.hpp"

#include <iostream>
#include <stdexcept>
#include <utility>

namespace {
void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}
}

int main(int argc, char** argv) try {
  if (argc != 2) throw std::runtime_error("expected fixture directory");
  pmjs::RuntimeCore core(argv[1], 32, 32, "Bitmap backing ownership");
  using namespace pmjs::mv::core;
  bindRuntime(core);
  {
    const auto initial = core.canvases().liveCount();
    auto loaded = PixelBitmap::load("fixture.png");
    updateServices();
    require(loaded->isReady(), "image did not load");
    const auto image = loaded->texture();
    require(image.has_value(), "loaded image has no texture");
    require(core.canvases().liveCount() == initial, "loading allocated a writable canvas");
    PixelBitmap retained(*loaded);
    require(retained.texture()->handle == image->handle, "read-only copy did not share its image");
    loaded.reset();
    require(retained.texture().has_value(), "copy lost its retained image");
    const auto original = retained.getPixel(0, 0);
    PixelBitmap independent(retained);
    retained.fillAll("#123456");
    require(independent.getPixel(0, 0) == original, "writable copy aliased its source");
    require(retained.getPixel(0, 0) == "#123456", "loaded-image write was lost");

    auto sharedSource = PixelBitmap::load("fixture.png");
    updateServices();
    PixelBitmap sharedCopy(*sharedSource);
    sharedSource->fillAll("#123456");
    require(sharedCopy.getPixel(0, 0) == original, "image copy was changed by source mutation");
    sharedCopy.resize(4, 4);
    require(sharedCopy.getAlphaPixel(0, 0) == 0, "resize restored the original image");

    PixelBitmap drawn(4, 4);
    drawn.fillAll("#abcdef");
    require(drawn.pixels.empty(), "drawing eagerly synchronized CPU pixels");
    drawn.syncPixels();
    require(drawn.pixels.size() == 64, "explicit CPU snapshot is missing");
    drawn.clearRect(0, 0, 1, 1);
    require(drawn.pixels.empty(), "drawing retained a stale CPU snapshot");
    PixelBitmap copied(drawn), assigned;
    assigned = drawn;
    drawn.fillAll("#123456");
    require(copied.getPixel(1, 1) == "#abcdef", "copied canvas changed with source");
    require(assigned.getAlphaPixel(0, 0) == 0, "assigned canvas lost transparency");
    PixelBitmap moved(std::move(assigned));
    require(moved.getPixel(1, 1) == "#abcdef", "moved canvas lost its backing");
    PixelBitmap destination(4, 4);
    destination.blt(copied, 0, 0, 4, 4, 0, 0);
    require(destination.getAlphaPixel(0, 0) == 0, "blit lost transparent pixels");
    require(destination.getPixel(1, 1) == "#abcdef", "blit used a stale pixel snapshot");
    destination.syncPixels();
    destination.pixels[4] = 17;
    destination.commitPixels();
    require(destination.getPixel(1, 0) == "#11cdef", "explicit CPU edit was lost");
  }
  unbindRuntime(core);
  std::cout << "Bitmap backing ownership passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
