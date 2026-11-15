#include "dialog.hpp"

#include <SDL.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "canvas.hpp"
#include "platform.hpp"
#include "renderer.hpp"
#include "resources.hpp"
#include "vfs.hpp"

namespace {

namespace fs = std::filesystem;

void pushKey(std::uint32_t type, SDL_Keycode key) {
  SDL_Event event{};
  event.type = type;
  event.key.keysym.sym = key;
  event.key.repeat = 0;
  if (SDL_PushEvent(&event) != 1) {
    std::cerr << "SDL_PushEvent failed\n";
    std::exit(1);
  }
}

void pushKeyRepeat(SDL_Keycode key) {
  SDL_Event event{};
  event.type = SDL_KEYDOWN;
  event.key.keysym.sym = key;
  event.key.repeat = 1;
  if (SDL_PushEvent(&event) != 1) {
    std::cerr << "SDL_PushEvent failed\n";
    std::exit(1);
  }
}

void pushQuit() {
  SDL_Event event{};
  event.type = SDL_QUIT;
  if (SDL_PushEvent(&event) != 1) {
    std::cerr << "SDL_PushEvent failed\n";
    std::exit(1);
  }
}

void releaseAll(pmjs::Platform& platform) {
  pushKey(SDL_KEYUP, SDLK_RETURN);
  pushKey(SDL_KEYUP, SDLK_x);
  pushKey(SDL_KEYUP, SDLK_RIGHT);
  for (int i = 0; i < 8; ++i) platform.pollEvents();
}

struct Push {
  int atMilliseconds;
  std::uint32_t type;
  SDL_Keycode key;
};

std::atomic<int> landedPushes{0};

void after(std::vector<Push> pushes) {
  std::thread([pushes]() {
    for (const auto& push : pushes) {
      std::this_thread::sleep_for(
        std::chrono::milliseconds(push.atMilliseconds));
      pushKey(push.type, push.key);
      ++landedPushes;
    }
  }).detach();
}

void afterQuit(int milliseconds) {
  std::thread([milliseconds]() {
    std::this_thread::sleep_for(std::chrono::milliseconds(milliseconds));
    pushQuit();
    ++landedPushes;
  }).detach();
}

void awaitPushes(int expected) {
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(15);
  while (landedPushes.load() < expected) {
    if (std::chrono::steady_clock::now() > deadline) {
      std::cerr << "FAIL: timed out waiting for helper pushes\n";
      std::exit(1);
    }
    SDL_Delay(5);
  }
}

int failures = 0;

void check(bool condition, const char* message) {
  if (!condition) {
    std::cerr << "FAIL: " << message << '\n';
    ++failures;
  } else {
    std::cerr << "ok: " << message << '\n';
  }
}

}  // namespace

int main() {
  const fs::path root = fs::temp_directory_path() / "pmjs-dialog-modal-test";
  fs::create_directories(root / "fonts");
  const fs::path testFont = fs::path(__FILE__).parent_path() / "assets" / "testfont.ttf";
  fs::copy_file(testFont, root / "fonts" / "mplus-1m-regular.ttf",
                 fs::copy_options::overwrite_existing);

  pmjs::Platform platform(816, 624, "pmjs dialog test");
  pmjs::ImageStore images;
  pmjs::CanvasStore canvases(images);
  pmjs::Renderer renderer(816, 624, images);
  pmjs::Vfs vfs(root);
  pmjs::Dialog dialog(platform, renderer, canvases, vfs, 816, 624);

  int pushed = 0;
  auto sync = [&](int count) {
    pushed += count;
    awaitPushes(pushed);
    releaseAll(platform);
  };

  renderer.beginFrame();
  renderer.queueQuad(0, 0, 816, 624, {0, 1, 0, 1});
  renderer.render();
  const auto sceneBeforeDialog = renderer.captureSceneRgba();
  renderer.beginFrame();
  renderer.queueQuad(0, 0, 816, 624, {0, 0, 1, 1});
  const auto pendingCommands = renderer.commandCount();
  after({{400, SDL_KEYDOWN, SDLK_RETURN}});
  dialog.alert("hello");
  check(renderer.captureSceneRgba() == sceneBeforeDialog,
        "modal preserves the presented scene across multiple frames");
  check(renderer.commandCount() == pendingCommands,
        "modal preserves pending game commands");
  renderer.render();
  const auto resumedScene = renderer.captureSceneRgba();
  check(resumedScene[0] == 0 && resumedScene[1] == 0 && resumedScene[2] == 255,
        "pending game drawing resumes after the modal");
  sync(1);

  after({{400, SDL_KEYDOWN, SDLK_RETURN}});
  check(dialog.confirm("sure?") == false,
        "physical OK activates preselected Cancel");
  sync(1);

  after({{400, SDL_KEYDOWN, SDLK_RIGHT},
         {200, SDL_KEYUP, SDLK_RIGHT},
         {200, SDL_KEYDOWN, SDLK_RETURN}});
  check(dialog.confirm("sure?") == true,
        "toggle to OK then physical OK confirms");
  sync(3);

  {
    auto pixels = renderer.captureDrawableRgba();
    check(pixels.size() == static_cast<std::size_t>(816 * 624 * 4),
          "capture matches game geometry");
    int bright = 0;
    for (std::size_t i = 0; i < pixels.size(); i += 4) {
      if (pixels[i] > 200 && pixels[i + 1] > 200 && pixels[i + 2] > 200) {
        ++bright;
      }
    }
    check(bright > 500, "dialog text and chrome reached the screen");
  }

  after({{400, SDL_KEYDOWN, SDLK_x}});
  check(dialog.confirm("sure?") == false, "confirm escape returns false");
  sync(1);

  afterQuit(400);
  check(dialog.confirm("sure?") == false, "confirm quit returns false");
  sync(1);

  pushKey(SDL_KEYDOWN, SDLK_RETURN);
  afterQuit(400);
  check(dialog.confirm("sure?") == false,
        "stale held button does not auto-confirm");
  sync(1);

  pushKey(SDL_KEYDOWN, SDLK_RETURN);
  after({{400, SDL_KEYUP, SDLK_RETURN},
         {200, SDL_KEYDOWN, SDLK_RETURN}});
  check(dialog.confirm("sure?") == false,
        "fresh press after release activates preselected Cancel");
  sync(2);

  after({{400, SDL_KEYDOWN, SDLK_RIGHT},
         {200, SDL_KEYUP, SDLK_RIGHT},
         {200, SDL_KEYDOWN, SDLK_RETURN}});
  check(dialog.confirm("sure?") == true, "toggle then OK confirms");
  sync(3);
  after({{400, SDL_KEYDOWN, SDLK_RIGHT},
         {200, SDL_KEYUP, SDLK_RIGHT},
         {200, SDL_KEYDOWN, SDLK_RIGHT},
         {200, SDL_KEYUP, SDLK_RIGHT},
         {200, SDL_KEYDOWN, SDLK_RETURN}});
  check(dialog.confirm("sure?") == false, "double toggle wraps to Cancel");
  sync(5);

  std::string longMessage;
  for (int i = 1; i <= 30; ++i) {
    longMessage += "line " + std::to_string(i) + " of a very long prompt\n";
  }
  bool threw = false;
  try {
    dialog.confirm(longMessage);
  } catch (const std::runtime_error&) {
    threw = true;
  }
  check(threw, "over-capacity message throws instead of truncating");

  std::thread([]() {
    std::this_thread::sleep_for(std::chrono::milliseconds(400));
    pushKeyRepeat(SDLK_RETURN);
    ++landedPushes;
    std::this_thread::sleep_for(std::chrono::milliseconds(400));
    pushQuit();
    ++landedPushes;
  }).detach();
  check(dialog.confirm("sure?") == false, "repeat press is not a fresh edge");
  sync(2);

  platform.interceptWindowClose(true);
  platform.takeWindowEvents();
  afterQuit(100);
  after({{800, SDL_KEYDOWN, SDLK_x}});
  const auto closeStart = std::chrono::steady_clock::now();
  check(!dialog.confirm("close request"), "intercepted close cancels confirmation");
  const auto closeElapsed = std::chrono::steady_clock::now() - closeStart;
  check(closeElapsed < std::chrono::milliseconds(600),
        "intercepted close dismisses without waiting for fallback Escape");
  const auto closeEvents = platform.takeWindowEvents();
  check(std::any_of(closeEvents.begin(), closeEvents.end(),
      [](const auto& event) { return event.type == "close"; }),
        "modal preserves the intercepted close for its normal handler");
  sync(2);
  pushQuit();
  check(!dialog.confirm("already queued close"), "queued close cancels at modal entry");
  platform.takeWindowEvents();
  platform.interceptWindowClose(false);

  {
    pmjs::Renderer smallRenderer(320, 240, images);
    pmjs::Dialog smallDialog(platform, smallRenderer, canvases, vfs, 320, 240);
    smallRenderer.beginFrame();
    smallRenderer.queueQuad(0, 0, 320, 240, {0, 1, 0, 1});
    smallRenderer.render();
    std::string tenLines = "line";
    for (int i = 1; i < 10; ++i) tenLines += "\nline";
    after({{400, SDL_KEYDOWN, SDLK_RETURN}});
    check(!smallDialog.confirm(tenLines), "small viewport confirmation stays usable");
    const auto pixels = smallRenderer.captureDrawableRgba();
    const auto pixel = [&](int x, int y, int red, int green, int blue) {
      const auto at = static_cast<std::size_t>(y * 320 + x) * 4;
      return pixels.at(at) == red && pixels.at(at + 1) == green && pixels.at(at + 2) == blue;
    };
    check(pixel(100, 16, 255, 255, 255) && pixel(100, 223, 255, 255, 255),
          "ten-line modal fits vertically inside the small viewport");
    check(pixel(85, 195, 58, 110, 165) && pixel(235, 195, 42, 46, 51),
          "both small-viewport buttons remain inside the dialog surface");
    sync(1);
  }

  return failures == 0 ? 0 : 1;
}
