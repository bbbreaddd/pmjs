#include "platform/dialog.hpp"

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

#include "canvas/canvas.hpp"
#include "platform/platform.hpp"
#include "graphics/renderer.hpp"
#include "graphics/resources.hpp"
#include "platform/vfs.hpp"

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

void pushPointer(std::uint32_t type) {
  SDL_Event event{};
  event.type = type;
  event.button.button = SDL_BUTTON_LEFT;
  event.button.x = 400;
  event.button.y = 300;
  if (SDL_PushEvent(&event) != 1) throw std::runtime_error("cannot push pointer input");
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
  pushKey(SDL_KEYUP, SDLK_ESCAPE);
  pushKey(SDL_KEYUP, SDLK_RIGHT);
  pushKey(SDL_KEYUP, SDLK_LEFT);
  pushKey(SDL_KEYUP, SDLK_ESCAPE);
  pushKey(SDL_KEYUP, SDLK_TAB);
  pushKey(SDL_KEYUP, SDLK_SPACE);
  pushKey(SDL_KEYUP, SDLK_z);
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
  std::ofstream(root / "fonts" / "bad.ttf") << "not a font";
  pmjs::Vfs vfs(root);
  pmjs::Dialog dialog(platform, renderer, canvases, vfs);

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
  check(dialog.confirm("sure?") == true,
        "Enter activates preselected OK");
  sync(1);

  after({{400, SDL_KEYDOWN, SDLK_RIGHT},
         {200, SDL_KEYUP, SDLK_RIGHT},
         {200, SDL_KEYDOWN, SDLK_RETURN}});
  check(dialog.confirm("sure?") == false,
        "arrow focus moves to Cancel");
  sync(3);

  after({{400, SDL_KEYDOWN, SDLK_ESCAPE}});
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
  check(dialog.confirm("sure?") == true,
        "fresh press after release activates preselected OK");
  sync(2);

  after({{400, SDL_KEYDOWN, SDLK_RIGHT},
         {200, SDL_KEYUP, SDLK_RIGHT},
         {200, SDL_KEYDOWN, SDLK_RETURN}});
  check(dialog.confirm("sure?") == false, "arrow then Enter cancels");
  sync(3);
  after({{400, SDL_KEYDOWN, SDLK_RIGHT},
         {200, SDL_KEYUP, SDLK_RIGHT},
         {200, SDL_KEYDOWN, SDLK_RIGHT},
         {200, SDL_KEYUP, SDLK_RIGHT},
         {200, SDL_KEYDOWN, SDLK_RETURN}});
  check(dialog.confirm("sure?") == true, "double arrow wraps to OK");
  sync(5);

  std::string longMessage;
  for (int i = 1; i <= 30; ++i) {
    longMessage += "line " + std::to_string(i) + " of a very long prompt\n";
  }
  after({{300, SDL_KEYDOWN, SDLK_PAGEDOWN}, {100, SDL_KEYDOWN, SDLK_RETURN}});
  check(dialog.confirm(longMessage), "long messages remain interactive and scrollable");
  sync(2);
  pushKey(SDL_KEYUP, SDLK_PAGEDOWN);

  std::thread([]() {
    std::this_thread::sleep_for(std::chrono::milliseconds(400));
    pushKeyRepeat(SDLK_RETURN);
    ++landedPushes;
    std::this_thread::sleep_for(std::chrono::milliseconds(400));
    pushQuit();
    ++landedPushes;
  }).detach();
  check(dialog.confirm("sure?") == true, "keyboard repeat reaches the default button");
  sync(2);

  platform.interceptWindowClose(true);
  platform.takeWindowEvents();
  afterQuit(100);
  after({{800, SDL_KEYDOWN, SDLK_ESCAPE}});
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

  pushPointer(SDL_MOUSEBUTTONDOWN);
  pushPointer(SDL_MOUSEBUTTONUP);
  std::thread modalPointer([] {
    SDL_Delay(100);
    pushPointer(SDL_MOUSEBUTTONDOWN);
    pushPointer(SDL_MOUSEBUTTONUP);
    SDL_Delay(300);
    pushKey(SDL_KEYDOWN, SDLK_RETURN);
  });
  dialog.alert("mouse isolation");
  modalPointer.join();
  check(platform.pointerEvents().empty(), "opening and modal mouse clicks do not reach the game");
  releaseAll(platform);
  pushPointer(SDL_MOUSEBUTTONDOWN);
  pushPointer(SDL_MOUSEBUTTONUP);
  platform.pollEvents();
  check(platform.pointerEvents().size() == 2, "fresh mouse input works after dismissal");
  platform.clearPointerEvents();

  const auto captureAlert = [&](const std::string& message) {
    after({{400, SDL_KEYDOWN, SDLK_RETURN}});
    dialog.alert(message);
    auto pixels = renderer.captureDrawableRgba();
    sync(1);
    return pixels;
  };
  const auto validFontPixels = captureAlert("visible text");
  dialog.setFontOverride("fonts/bad.ttf");
  check(captureAlert("visible text") == validFontPixels,
        "invalid font override falls back to a usable candidate");
  pmjs::Vfs invalidFontVfs(root / "fonts");
  pmjs::Dialog invalidFontDialog(platform, renderer, canvases, invalidFontVfs);
  invalidFontDialog.setFontOverride("bad.ttf");
  afterQuit(400);
  bool fontThrew = false;
  try { invalidFontDialog.alert("no usable font"); }
  catch (const std::runtime_error&) { fontThrew = true; }
  check(!fontThrew, "embedded bitmap text keeps dialogs usable without game fonts");
  sync(1);
  dialog.setFontOverride("");

  const auto lineFeedPixels = captureAlert("first\nsecond");
  check(captureAlert("first\rsecond") == lineFeedPixels,
        "carriage return preserves the explicit line break");
  check(captureAlert("first\r\nsecond") == lineFeedPixels,
        "CRLF produces one line break");
  check(captureAlert("  first   second") != captureAlert("first second"),
        "indentation and repeated spaces survive layout");
  check(captureAlert("a\tb") == captureAlert("a       b"),
        "tabs advance to eight-column stops");

  after({{300, SDL_KEYDOWN, SDLK_RETURN}});
  check(dialog.prompt("default value", "seed") == std::optional<std::string>{"seed"},
        "prompt accepts the selected default value");
  sync(1);
  after({{300, SDL_KEYDOWN, SDLK_ESCAPE}});
  check(!dialog.prompt("cancel value", "seed"), "cancelled prompt returns no value");
  sync(1);
  std::thread textInput([&platform] {
    SDL_Delay(200);
    SDL_Event text{};
    text.type = SDL_TEXTINPUT;
    text.text.windowID = platform.windowId();
    SDL_strlcpy(text.text.text, "é", sizeof(text.text.text));
    SDL_PushEvent(&text);
    pushKey(SDL_KEYDOWN, SDLK_RETURN);
  });
  check(dialog.prompt("replace selected value", "seed") == std::optional<std::string>{"é"},
        "UTF-8 text replaces the prompt's selected default");
  textInput.join();
  releaseAll(platform);
  check(!platform.textInputEnabled(), "prompt restores the previous text-input state");
  after({{300, SDL_KEYDOWN, SDLK_RETURN}});
  std::string expectedDefault;
  for (int i = 0; i < 24; ++i) expectedDefault += std::string(132, 'a') + "\n";
  expectedDefault += "...";
  check(dialog.prompt("long default", std::string(5000, 'a')) == std::optional<std::string>{expectedDefault},
        "oversized prompt defaults use bounded rectangular elision");
  sync(1);

  std::thread conflictingInput([] {
    SDL_Delay(300);
    SDL_Event events[2]{};
    events[0].type = events[1].type = SDL_KEYDOWN;
    events[0].key.keysym.sym = SDLK_RETURN;
    events[1].key.keysym.sym = SDLK_ESCAPE;
    if (SDL_PeepEvents(events, 2, SDL_ADDEVENT, SDL_FIRSTEVENT, SDL_LASTEVENT) != 2)
      std::exit(1);
  });
  check(dialog.confirm("conflicting input"), "Enter before Escape accepts in event order");
  conflictingInput.join();
  releaseAll(platform);

  {
    pmjs::Renderer smallRenderer(816, 624, images);
    pmjs::Dialog smallDialog(platform, smallRenderer, canvases, vfs);
    check(smallRenderer.setScreenRenderSize(320, 240), "game changes logical render size");
    platform.windowCommand("resize", 320, 240);
    platform.pollEvents();
    smallRenderer.setDrawableSize(320, 240);
    smallRenderer.beginFrame();
    smallRenderer.queueQuad(0, 0, 320, 240, {0, 1, 0, 1});
    smallRenderer.render();
    std::string tenLines = "line";
    for (int i = 1; i < 10; ++i) tenLines += "\nline";
    after({{400, SDL_KEYDOWN, SDLK_RETURN}});
    check(smallDialog.confirm(tenLines), "small viewport confirmation stays usable");
    sync(1);
  }

  return failures == 0 ? 0 : 1;
}
