#include "mv_core_display.hpp"
#include <iostream>
#include <stdexcept>

using namespace pmjs::mv::core;

namespace {
void require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }
}

int main() try {
  const auto frame = spriteFrame({-4, -3, 20, 11}, 16, 8);
  require(frame.real.x == 0 && frame.real.y == 0, "sprite frame clamps the origin");
  require(frame.real.width == 16 && frame.real.height == 8, "sprite frame clamps to the bitmap");
  require(frame.pivot.x == -4 && frame.pivot.y == -3, "sprite frame keeps the clipped pivot");

  ScreenSprite screen;
  screen.setColor(NAN, -5, 127.6);
  require(screen.color[0] == 0.0f, "screen color maps NaN to zero");
  require(screen.color[1] == 0.0f, "screen color clamps negatives");
  require(screen.color[2] == float(128.0 / 255.0), "screen color rounds half up");
  screen.setWhite();
  require(screen.color[0] == 1.0f && screen.color[1] == 1.0f && screen.color[2] == 1.0f, "screen color white");

  Tilemap tilemap;
  require(tilemap.isReady(), "empty tilemap is ready");
  PixelBitmap bitmap;
  bitmap.loadingState = "loading";
  bitmap.loaded = false;
  tilemap.bitmaps[0] = &bitmap;
  require(!tilemap.isReady(), "tilemap waits for pending bitmaps");
  bitmap.loadingState = "none";
  require(tilemap.isReady(), "tilemap reports loaded bitmaps");

  bitmap.touchedAt = 0;
  tilemap.update();
  require(bitmap.touchedAt > 0, "tilemap update touches its bitmaps");
  require(tilemap.animationFrame == 0, "tilemap animation starts on the first frame");
  for (int i = 0; i < 29; ++i) tilemap.update();
  require(tilemap.animationFrame == 1, "tilemap animation advances every thirty updates");

  Window window;
  window.setCursorRect(NAN, -1.5, 2.9, NAN);
  require(window.cursorRect.x == 0 && window.cursorRect.y == -2, "window cursor floors and zeroes NaN coordinates");
  require(window.cursorRect.width == 2 && window.cursorRect.height == 0, "window cursor floors its size");
  window.setTone(NAN, 4.5, -3);
  require(window.tone[0] == 0 && window.tone[1] == 4.5 && window.tone[2] == -3, "window tone keeps finite values and zeroes NaN");

  ShaderTilemap shader;
  const auto revision = shader.revision_;
  shader.refreshTileset();
  require(shader.revision_ > revision, "shader tilemap repaints after a tileset refresh");

  Container parent;
  const auto layer = std::make_shared<WindowLayer>();
  layer->addChild(std::make_shared<Container>());
  require(layer->children.size() == 1, "window layer owns a child");
  parent.addChild(layer);
  parent.removeChild(layer.get());
  require(layer->children.empty(), "removed window layer releases its children");

  std::cout << "native MV core display checks passed\n";
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
