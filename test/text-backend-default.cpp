#include "text_backend.hpp"
#include "canvas.hpp"
#include <cstdlib>
#include <stdexcept>
#include <string>

int main() {
  unsetenv("PMJS_TEXT_BACKEND");
  if (std::string(pmjs::TextBackend().name()) != "skia65") return 1;
  setenv("PMJS_TEXT_BACKEND", "freetype", 1);
  pmjs::TextBackend legacy;
  if (std::string(legacy.name()) != "freetype") return 2;
  const std::filesystem::path font = PMJS_TEST_FONT;
  setenv("PMJS_TEXT_BACKEND", "skia65", 1);
  pmjs::TextBackend skia;
  if (!skia.canLoad(font) || !skia.measure({font}, "AV", 24, {})) return 4;
  const auto before = skia.stats();
  if (legacy.canLoad(font) || legacy.measure({font}, "AV", 24, {})) return 5;
  std::vector<uint8_t> pixels(64 * 32 * 4, 137);
  const auto original = pixels;
  int dirty[4] = {1, 2, 3, 4};
  if (legacy.draw({font}, "AV", 2, 24, 24, 0xffffffff, 0, {}, pixels, 64, 32, dirty)) return 6;
  if (pixels != original || dirty[0] != 1 || dirty[1] != 2 || dirty[2] != 3 || dirty[3] != 4) return 7;
  legacy.limits(123, 1);
  const auto after = skia.stats();
  if (before.cacheLimit != after.cacheLimit || before.layoutRequests != after.layoutRequests ||
      before.drawCalls != after.drawCalls || before.cacheBytes != after.cacheBytes ||
      !legacy.stats().identity.empty()) return 8;
  setenv("PMJS_TEXT_BACKEND", "invalid", 1);
  try { pmjs::TextBackend backend; return 3; }
  catch (const std::runtime_error&) {}
}
