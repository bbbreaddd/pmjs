#include "platform.hpp"

#include <SDL.h>
#include <EGL/egl.h>
#include <GLES3/gl3.h>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <utility>
#include <vector>

namespace pmjs {

namespace {

constexpr std::uint16_t leftBit = 1U << 0U;
constexpr std::uint16_t rightBit = 1U << 1U;
constexpr std::uint16_t upBit = 1U << 2U;
constexpr std::uint16_t downBit = 1U << 3U;
constexpr std::uint16_t okBit = 1U << 4U;
constexpr std::uint16_t escapeBit = 1U << 5U;
constexpr std::uint16_t shiftBit = 1U << 6U;
constexpr std::uint16_t controlBit = 1U << 7U;
constexpr std::uint16_t tabBit = 1U << 8U;
constexpr std::uint16_t pageupBit = 1U << 9U;
constexpr std::uint16_t pagedownBit = 1U << 10U;
constexpr std::uint16_t debugBit = 1U << 11U;

bool environmentFlag(const char* name) {
  const char* value = std::getenv(name);
  if (!value) return false;
  const std::string text(value);
  return text == "1" || text == "true" || text == "on" || text == "yes";
}

int swapIntervalFromEnvironment() {
  const char* value = std::getenv("PMJS_SWAP_INTERVAL");
  if (!value || !*value) return 1;
  char* end = nullptr;
  const long parsed = std::strtol(value, &end, 10);
  if (!end || *end != '\0' || parsed < -1 || parsed > 1) {
    throw std::runtime_error("PMJS_SWAP_INTERVAL must be -1, 0, or 1");
  }
  return static_cast<int>(parsed);
}

bool softwareRenderer(const char* renderer) {
  std::string value = renderer ? renderer : "";
  std::transform(value.begin(), value.end(), value.begin(),
    [](unsigned char character) { return static_cast<char>(std::tolower(character)); });
  return value.find("llvmpipe") != std::string::npos ||
         value.find("softpipe") != std::string::npos ||
         value.find("swiftshader") != std::string::npos;
}

std::uint16_t actionBit(const std::string& action) {
  if (action == "left") return leftBit;
  if (action == "right") return rightBit;
  if (action == "up") return upBit;
  if (action == "down") return downBit;
  if (action == "ok") return okBit;
  if (action == "escape") return escapeBit;
  if (action == "shift") return shiftBit;
  if (action == "control") return controlBit;
  if (action == "tab") return tabBit;
  if (action == "pageup") return pageupBit;
  if (action == "pagedown") return pagedownBit;
  if (action == "debug") return debugBit;
  return 0;
}

const char* actionForKey(SDL_Keycode key) {
  switch (key) {
    case SDLK_LEFT: return "left";
    case SDLK_RIGHT: return "right";
    case SDLK_UP: return "up";
    case SDLK_DOWN: return "down";
    case SDLK_RETURN:
    case SDLK_SPACE:
    case SDLK_z: return "ok";
    case SDLK_ESCAPE:
    case SDLK_x: return "escape";
    case SDLK_LSHIFT:
    case SDLK_RSHIFT: return "shift";
    case SDLK_LCTRL:
    case SDLK_RCTRL:
    case SDLK_LALT:
    case SDLK_RALT: return "control";
    case SDLK_TAB: return "tab";
    case SDLK_q:
    case SDLK_PAGEUP: return "pageup";
    case SDLK_w:
    case SDLK_PAGEDOWN: return "pagedown";
    case SDLK_F9: return "debug";
    default: return nullptr;
  }
}

const char* actionForButton(std::uint8_t button) {
  switch (button) {
    case SDL_CONTROLLER_BUTTON_DPAD_LEFT: return "left";
    case SDL_CONTROLLER_BUTTON_DPAD_RIGHT: return "right";
    case SDL_CONTROLLER_BUTTON_DPAD_UP: return "up";
    case SDL_CONTROLLER_BUTTON_DPAD_DOWN: return "down";
    case SDL_CONTROLLER_BUTTON_A: return "ok";
    case SDL_CONTROLLER_BUTTON_B: return "escape";
    case SDL_CONTROLLER_BUTTON_X: return "shift";
    case SDL_CONTROLLER_BUTTON_Y: return "escape";
    case SDL_CONTROLLER_BUTTON_LEFTSHOULDER: return "pageup";
    case SDL_CONTROLLER_BUTTON_RIGHTSHOULDER: return "pagedown";
    case SDL_CONTROLLER_BUTTON_START: return "escape";
    case SDL_CONTROLLER_BUTTON_LEFTSTICK: return "shift";
    case SDL_CONTROLLER_BUTTON_RIGHTSTICK: return "control";
    default: return nullptr;
  }
}

int browserKeyCode(SDL_Keycode key) {
  if (key >= SDLK_a && key <= SDLK_z) return key - SDLK_a + 65;
  if (key >= SDLK_0 && key <= SDLK_9) return key;
  if (key >= SDLK_F1 && key <= SDLK_F12) return key - SDLK_F1 + 112;
  switch (key) {
    case SDLK_KP_0: return 96;
    case SDLK_KP_1: return 97;
    case SDLK_KP_2: return 98;
    case SDLK_KP_3: return 99;
    case SDLK_KP_4: return 100;
    case SDLK_KP_5: return 101;
    case SDLK_KP_6: return 102;
    case SDLK_KP_7: return 103;
    case SDLK_KP_8: return 104;
    case SDLK_KP_9: return 105;
    case SDLK_BACKSPACE: return 8;
    case SDLK_TAB: return 9;
    case SDLK_RETURN: case SDLK_KP_ENTER: return 13;
    case SDLK_LSHIFT: case SDLK_RSHIFT: return 16;
    case SDLK_LCTRL: case SDLK_RCTRL: return 17;
    case SDLK_LALT: case SDLK_RALT: return 18;
    case SDLK_ESCAPE: return 27;
    case SDLK_SPACE: return 32;
    case SDLK_PAGEUP: return 33;
    case SDLK_PAGEDOWN: return 34;
    case SDLK_END: return 35;
    case SDLK_HOME: return 36;
    case SDLK_LEFT: return 37;
    case SDLK_UP: return 38;
    case SDLK_RIGHT: return 39;
    case SDLK_DOWN: return 40;
    case SDLK_INSERT: return 45;
    case SDLK_DELETE: return 46;
    case SDLK_SEMICOLON: return 186;
    case SDLK_EQUALS: return 187;
    case SDLK_COMMA: return 188;
    case SDLK_MINUS: return 189;
    case SDLK_PERIOD: return 190;
    case SDLK_SLASH: return 191;
    case SDLK_BACKQUOTE: return 192;
    case SDLK_LEFTBRACKET: return 219;
    case SDLK_BACKSLASH: return 220;
    case SDLK_RIGHTBRACKET: return 221;
    case SDLK_QUOTE: return 222;
    default: return 0;
  }
}

void setPhysical(std::vector<int>& values, int code, bool down) {
  auto found = std::find(values.begin(), values.end(), code);
  if (down && found == values.end()) values.push_back(code);
  if (!down && found != values.end()) values.erase(found);
}


const char* legacyActionForKeyCode(int code) {
  switch (code) {
    case 37: return "left";
    case 39: return "right";
    case 38: return "up";
    case 40: return "down";
    case 13: case 32: case 90: return "ok";
    case 27: case 88: return "escape";
    case 16: return "shift";
    case 17: case 18: return "control";
    case 9: return "tab";
    case 33: case 81: return "pageup";
    case 34: case 87: return "pagedown";
    case 120: return "debug";
    default: return nullptr;
  }
}

const char* legacyActionForBrowserButton(int button) {
  switch (button) {
    case 0: return "ok";
    case 1: case 3: case 9: return "escape";
    case 2: case 10: return "shift";
    case 4: return "pageup";
    case 5: return "pagedown";
    case 11: return "control";
    case 12: return "up";
    case 13: return "down";
    case 14: return "left";
    case 15: return "right";
    default: return nullptr;
  }
}

std::string browserCode(SDL_Scancode scan) {
  if (scan >= SDL_SCANCODE_A && scan <= SDL_SCANCODE_Z)
    return std::string("Key") + static_cast<char>('A' + scan - SDL_SCANCODE_A);
  if (scan >= SDL_SCANCODE_1 && scan <= SDL_SCANCODE_9)
    return std::string("Digit") + static_cast<char>('1' + scan - SDL_SCANCODE_1);
  if (scan == SDL_SCANCODE_0) return "Digit0";
  if (scan >= SDL_SCANCODE_KP_1 && scan <= SDL_SCANCODE_KP_9)
    return std::string("Numpad") + static_cast<char>('1' + scan - SDL_SCANCODE_KP_1);
  if (scan == SDL_SCANCODE_KP_0) return "Numpad0";
  switch (scan) {
    case SDL_SCANCODE_LSHIFT: return "ShiftLeft";
    case SDL_SCANCODE_RSHIFT: return "ShiftRight";
    case SDL_SCANCODE_LCTRL: return "ControlLeft";
    case SDL_SCANCODE_RCTRL: return "ControlRight";
    case SDL_SCANCODE_LALT: return "AltLeft";
    case SDL_SCANCODE_RALT: return "AltRight";
    case SDL_SCANCODE_RETURN: return "Enter";
    case SDL_SCANCODE_ESCAPE: return "Escape";
    case SDL_SCANCODE_SPACE: return "Space";
    case SDL_SCANCODE_TAB: return "Tab";
    case SDL_SCANCODE_LEFT: return "ArrowLeft";
    case SDL_SCANCODE_RIGHT: return "ArrowRight";
    case SDL_SCANCODE_UP: return "ArrowUp";
    case SDL_SCANCODE_DOWN: return "ArrowDown";
    default: return SDL_GetScancodeName(scan);
  }
}

std::string browserKey(SDL_Keycode key) {
  if (key >= SDLK_a && key <= SDLK_z)
    return std::string(1, static_cast<char>(key));
  switch (key) {
    case SDLK_LSHIFT: case SDLK_RSHIFT: return "Shift";
    case SDLK_LCTRL: case SDLK_RCTRL: return "Control";
    case SDLK_LALT: case SDLK_RALT: return "Alt";
    case SDLK_LGUI: case SDLK_RGUI: return "Meta";
    case SDLK_LEFT: return "ArrowLeft";
    case SDLK_RIGHT: return "ArrowRight";
    case SDLK_UP: return "ArrowUp";
    case SDLK_DOWN: return "ArrowDown";
    case SDLK_ESCAPE: return "Escape";
    case SDLK_RETURN: case SDLK_KP_ENTER: return "Enter";
    case SDLK_SPACE: return " ";
    default: return SDL_GetKeyName(key);
  }
}

double stickAxis(SDL_GameController* controller, SDL_GameControllerAxis axis) {
  const double value = SDL_GameControllerGetAxis(controller, axis) / 32768.0;
  return std::abs(value) < 0.25 ? 0.0 : value;
}

}  // namespace

int standardGamepadButton(int button) {
  if (button >= SDL_CONTROLLER_BUTTON_A && button <= SDL_CONTROLLER_BUTTON_Y) return button;
  if (button == SDL_CONTROLLER_BUTTON_LEFTSHOULDER) return 4;
  if (button == SDL_CONTROLLER_BUTTON_RIGHTSHOULDER) return 5;
  if (button == SDL_CONTROLLER_BUTTON_BACK) return 8;
  if (button == SDL_CONTROLLER_BUTTON_START) return 9;
  if (button == SDL_CONTROLLER_BUTTON_LEFTSTICK) return 10;
  if (button == SDL_CONTROLLER_BUTTON_RIGHTSTICK) return 11;
  if (button >= SDL_CONTROLLER_BUTTON_DPAD_UP && button <= SDL_CONTROLLER_BUTTON_DPAD_RIGHT)
    return button - SDL_CONTROLLER_BUTTON_DPAD_UP + 12;
  if (button == SDL_CONTROLLER_BUTTON_GUIDE) return 16;
  return -1;
}

Platform::Platform(int width, int height, std::string title) {
  if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_GAMECONTROLLER | SDL_INIT_AUDIO) != 0) {
    throw std::runtime_error(std::string("SDL_Init failed: ") + SDL_GetError());
  }
  // Window is the physical drawable; the game size stays with the renderer.
  SDL_Rect bounds{};
  if (SDL_GetDisplayBounds(0, &bounds) == 0 && bounds.w > 0 && bounds.h > 0) {
    displayWidth_ = bounds.w;
    displayHeight_ = bounds.h;
  } else {
    displayWidth_ = width;
    displayHeight_ = height;
  }
  std::pair<int, int> windowSize = {displayWidth_, displayHeight_};
  const char* sizeOverride = std::getenv("PMJS_WINDOW_SIZE");
  if (sizeOverride && *sizeOverride) {
    int overrideWidth = 0, overrideHeight = 0;
    char extra = '\0';
    if (std::sscanf(sizeOverride, "%dx%d%c", &overrideWidth, &overrideHeight,
                     &extra) != 2 ||
        overrideWidth <= 0 || overrideHeight <= 0) {
      SDL_Quit();
      throw std::runtime_error("PMJS_WINDOW_SIZE must look like 640x480");
    }
    windowSize = {overrideWidth, overrideHeight};
  }
  windowWidth_ = windowSize.first;
  windowHeight_ = windowSize.second;
  const char* mappingFile = std::getenv("SDL_GAMECONTROLLERCONFIG_FILE");
  if (mappingFile && *mappingFile) SDL_GameControllerAddMappingsFromFile(mappingFile);
  for (int index = 0; index < SDL_NumJoysticks(); ++index)
    if (SDL_IsGameController(index))
      if (auto* controller = SDL_GameControllerOpen(index)) controllers_.push_back(controller);

  SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_ES);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 0);
  SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER, 1);
  SDL_GL_SetAttribute(SDL_GL_RED_SIZE, 8);
  SDL_GL_SetAttribute(SDL_GL_GREEN_SIZE, 8);
  SDL_GL_SetAttribute(SDL_GL_BLUE_SIZE, 8);
  SDL_GL_SetAttribute(SDL_GL_ALPHA_SIZE, 8);

  window_ = SDL_CreateWindow(title.c_str(), SDL_WINDOWPOS_CENTERED,
                             SDL_WINDOWPOS_CENTERED, windowWidth_,
                             windowHeight_,
                             SDL_WINDOW_OPENGL | SDL_WINDOW_SHOWN);
  if (!window_) {
    SDL_Quit();
    throw std::runtime_error(std::string("SDL_CreateWindow failed: ") + SDL_GetError());
  }
  const std::uint32_t windowFlags = SDL_GetWindowFlags(window_);
  windowFocused_ = (windowFlags & SDL_WINDOW_INPUT_FOCUS) != 0;
  windowVisible_ = (windowFlags & SDL_WINDOW_SHOWN) != 0 &&
    (windowFlags & (SDL_WINDOW_HIDDEN | SDL_WINDOW_MINIMIZED)) == 0;

  context_ = SDL_GL_CreateContext(window_);
  if (!context_) {
    SDL_DestroyWindow(window_);
    window_ = nullptr;
    SDL_Quit();
    throw std::runtime_error(std::string("SDL_GL_CreateContext failed: ") + SDL_GetError());
  }
  const auto drawable = drawableSize();
  std::cout << "[pmjs] display=" << displayWidth_ << "x" << displayHeight_
            << " window=" << windowWidth_ << "x" << windowHeight_
            << " drawable=" << drawable.first << "x" << drawable.second
            << '\n';
  SDL_ClearError();
  requestedSwapInterval_ = swapIntervalFromEnvironment();
  const int swapResult = SDL_GL_SetSwapInterval(requestedSwapInterval_);
  swapIntervalAccepted_ = swapResult == 0;
  swapInterval_ = SDL_GL_GetSwapInterval();
  if (environmentFlag("PMJS_GRAPHICS_DIAGNOSTICS")) {
    std::cout << "[pmjs] swap_interval requested=" << requestedSwapInterval_
              << " accepted=" << (swapIntervalAccepted_ ? "yes" : "no")
              << " driver=" << swapInterval_;
    if (swapResult != 0) std::cout << " error=\"" << SDL_GetError() << '\"';
    std::cout << '\n';
    printGraphicsDiagnostics();
  } else if (swapResult != 0) {
    std::cerr << "[pmjs] swap interval unavailable: " << SDL_GetError() << '\n';
  }
  const auto* renderer = reinterpret_cast<const char*>(glGetString(GL_RENDERER));
  if (environmentFlag("PMJS_REQUIRE_HARDWARE_GL") && softwareRenderer(renderer)) {
    SDL_GL_DeleteContext(context_);
    context_ = nullptr;
    SDL_DestroyWindow(window_);
    window_ = nullptr;
    SDL_Quit();
    throw std::runtime_error(std::string("software OpenGL renderer rejected: ") +
                             (renderer ? renderer : "unknown"));
  }
}

Platform::~Platform() {
  for (auto* controller : controllers_) if (controller) SDL_GameControllerClose(controller);
  if (context_) SDL_GL_DeleteContext(context_);
  if (window_) SDL_DestroyWindow(window_);
  SDL_Quit();
}

std::uint32_t Platform::windowId() const { return SDL_GetWindowID(window_); }

bool Platform::pollEvents() {
  SDL_Event event;
  while (SDL_PollEvent(&event)) {
    if (event.type == SDL_QUIT) return false;
    if (event.type == SDL_CONTROLLERDEVICEADDED && SDL_IsGameController(event.cdevice.which)) {
      const int instance = SDL_JoystickGetDeviceInstanceID(event.cdevice.which);
      const auto existing = std::find_if(controllers_.begin(), controllers_.end(), [&](auto* candidate) {
        return candidate && SDL_JoystickInstanceID(SDL_GameControllerGetJoystick(candidate)) == instance;
      });
      if (existing == controllers_.end()) {
        if (auto* controller = SDL_GameControllerOpen(event.cdevice.which)) {
          auto freeSlot = std::find(controllers_.begin(), controllers_.end(), nullptr);
          if (freeSlot == controllers_.end()) controllers_.push_back(controller);
          else *freeSlot = controller;
        }
      }
    }
    if (event.type == SDL_CONTROLLERDEVICEREMOVED) {
      for (auto it = controllers_.begin(); it != controllers_.end(); ++it) {
        if (!*it || SDL_JoystickInstanceID(SDL_GameControllerGetJoystick(*it)) != event.cdevice.which) continue;
        SDL_GameControllerClose(*it);
        *it = nullptr;
        break;
      }
      gamepadPressed_.erase(std::remove_if(gamepadPressed_.begin(), gamepadPressed_.end(),
        [&](const auto& entry) { return entry.first == event.cdevice.which; }), gamepadPressed_.end());
      gamepadDown_.erase(std::remove_if(gamepadDown_.begin(), gamepadDown_.end(),
        [&](const auto& entry) { return entry.first == event.cdevice.which; }), gamepadDown_.end());
      recomputeLegacyInput();
      hotkeyDown_ = startDown_ = false;
    }
    if (event.type == SDL_WINDOWEVENT && event.window.windowID ==
        SDL_GetWindowID(window_)) {
      switch (event.window.event) {
        case SDL_WINDOWEVENT_FOCUS_GAINED: windowFocused_ = true; break;
        case SDL_WINDOWEVENT_FOCUS_LOST:
          windowFocused_ = false;
          keysDown_.clear(); keysPressed_.clear(); keyEvents_.clear();
          gamepadDown_.clear(); gamepadPressed_.clear();
          down_ = pressed_ = 0;
          break;
        case SDL_WINDOWEVENT_SHOWN:
        case SDL_WINDOWEVENT_RESTORED: windowVisible_ = true; break;
        case SDL_WINDOWEVENT_HIDDEN:
        case SDL_WINDOWEVENT_MINIMIZED: windowVisible_ = false; break;
        default: break;
      }
    }
    const char* action = nullptr;
    bool isDown = false;
    if (event.type == SDL_KEYDOWN || event.type == SDL_KEYUP) {
      if (!windowFocused_) continue;
      action = actionForKey(event.key.keysym.sym);
      isDown = event.type == SDL_KEYDOWN;
      const int code = browserKeyCode(event.key.keysym.sym);
      if (code) {
        const bool alreadyDown = std::find(keysDown_.begin(), keysDown_.end(), code) != keysDown_.end();
        if (isDown && !alreadyDown && !event.key.repeat) keysPressed_.push_back(code);
        setPhysical(keysDown_, code, isDown);
        keyEvents_.push_back({code, isDown, event.key.repeat != 0,
          (event.key.keysym.mod & KMOD_CAPS) != 0, browserCode(event.key.keysym.scancode),
          browserKey(event.key.keysym.sym), (event.key.keysym.mod & KMOD_SHIFT) != 0,
          (event.key.keysym.mod & KMOD_CTRL) != 0,
          (event.key.keysym.mod & KMOD_ALT) != 0,
          (event.key.keysym.mod & KMOD_GUI) != 0});
      }
      if (isDown && event.key.repeat) action = nullptr;
    } else if (event.type == SDL_CONTROLLERBUTTONDOWN ||
               event.type == SDL_CONTROLLERBUTTONUP) {
      if (!windowFocused_) continue;
      auto controller = std::find_if(controllers_.begin(), controllers_.end(), [&](auto* candidate) {
        return candidate && SDL_JoystickInstanceID(SDL_GameControllerGetJoystick(candidate)) == event.cbutton.which;
      });
      if (controller == controllers_.end()) continue;
      isDown = event.type == SDL_CONTROLLERBUTTONDOWN;
      if (event.cbutton.button == SDL_CONTROLLER_BUTTON_BACK ||
          event.cbutton.button == SDL_CONTROLLER_BUTTON_GUIDE) {
        hotkeyDown_ = isDown;
        if (hotkeyDown_ && startDown_) return false;
      }
      if (event.cbutton.button == SDL_CONTROLLER_BUTTON_START) {
        startDown_ = isDown;
        if (hotkeyDown_ && startDown_) return false;
      }
      const int button = standardGamepadButton(event.cbutton.button);
      if (button < 0) continue;
      auto entry = std::find_if(gamepadPressed_.begin(), gamepadPressed_.end(), [&](const auto& value) {
        return value.first == event.cbutton.which;
      });
      if (entry == gamepadPressed_.end()) {
        gamepadPressed_.push_back({event.cbutton.which, {}});
        entry = std::prev(gamepadPressed_.end());
      }
      auto heldEntry = std::find_if(gamepadDown_.begin(), gamepadDown_.end(), [&](const auto& value) {
        return value.first == event.cbutton.which;
      });
      if (heldEntry == gamepadDown_.end()) {
        gamepadDown_.push_back({event.cbutton.which, {}});
        heldEntry = std::prev(gamepadDown_.end());
      }
      const bool fresh = isDown &&
        std::find(heldEntry->second.begin(), heldEntry->second.end(), button) == heldEntry->second.end();
      if (fresh)
        if (std::find(entry->second.begin(), entry->second.end(), button) == entry->second.end()) entry->second.push_back(button);
      setPhysical(heldEntry->second, button, isDown);
      action = actionForButton(event.cbutton.button);
    }
    if (!action) continue;
    const std::uint16_t bit = actionBit(action);
    if (isDown) {
      if ((down_ & bit) == 0) pressed_ |= bit;
      down_ |= bit;
    } else {
      down_ &= static_cast<std::uint16_t>(~bit);
    }
  }
  return true;
}

void Platform::recomputeLegacyInput() {
  down_ = pressed_ = 0;
  for (int code : keysDown_) {
    if (const char* action = legacyActionForKeyCode(code)) down_ |= actionBit(action);
  }
  for (int code : keysPressed_) {
    if (const char* action = legacyActionForKeyCode(code)) pressed_ |= actionBit(action);
  }
  for (const auto& pad : gamepadDown_) {
    for (int button : pad.second)
      if (const char* action = legacyActionForBrowserButton(button)) down_ |= actionBit(action);
  }
  for (const auto& pad : gamepadPressed_) {
    for (int button : pad.second)
      if (const char* action = legacyActionForBrowserButton(button)) pressed_ |= actionBit(action);
  }
}

bool Platform::inputDown(const std::string& action) const {
  return (down_ & actionBit(action)) != 0;
}

bool Platform::inputPressed(const std::string& action) const {
  return (pressed_ & actionBit(action)) != 0;
}

std::uint32_t Platform::inputState() const {
  return static_cast<std::uint32_t>(down_) |
    (static_cast<std::uint32_t>(pressed_) << 16U);
}

void Platform::finishLogicStep() { consumePressed(); }

bool Platform::consumePress(const std::string& action) {
  const std::uint16_t bit = actionBit(action);
  if ((pressed_ & bit) == 0) return false;
  pressed_ &= static_cast<std::uint16_t>(~bit);
  return true;
}

void Platform::consumePressed() {
  pressed_ = 0;
  keysPressed_.clear();
  gamepadPressed_.clear();
  keyEvents_.clear();
}

std::vector<Platform::GamepadState> Platform::gamepads() const {
  std::vector<GamepadState> result;
  for (std::size_t index = 0; index < controllers_.size(); ++index) {
    auto* controller = controllers_[index];
    if (!controller) {
      result.push_back({static_cast<int>(index), -1, false, "", {}, {}, {}});
      continue;
    }
    const int instance = SDL_JoystickInstanceID(SDL_GameControllerGetJoystick(controller));
    const char* name = SDL_GameControllerName(controller);
    GamepadState pad{static_cast<int>(index), instance, true, name ? name : "Game Controller", {}, {}, {}};
    if (!windowFocused_) {
      pad.axes = {0, 0, 0, 0};
      result.push_back(std::move(pad));
      continue;
    }
    for (int button = 0; button < SDL_CONTROLLER_BUTTON_MAX; ++button) {
      const int mapped = standardGamepadButton(button);
      if (mapped >= 0 && SDL_GameControllerGetButton(controller, static_cast<SDL_GameControllerButton>(button)))
        pad.buttonsDown.push_back(mapped);
    }
    if (SDL_GameControllerGetAxis(controller, SDL_CONTROLLER_AXIS_TRIGGERLEFT) > 8192)
      pad.buttonsDown.push_back(6);
    if (SDL_GameControllerGetAxis(controller, SDL_CONTROLLER_AXIS_TRIGGERRIGHT) > 8192)
      pad.buttonsDown.push_back(7);
    for (const auto& entry : gamepadPressed_) if (entry.first == instance) pad.buttonsPressed = entry.second;
    pad.axes = {stickAxis(controller, SDL_CONTROLLER_AXIS_LEFTX), stickAxis(controller, SDL_CONTROLLER_AXIS_LEFTY),
      stickAxis(controller, SDL_CONTROLLER_AXIS_RIGHTX), stickAxis(controller, SDL_CONTROLLER_AXIS_RIGHTY)};
    result.push_back(std::move(pad));
  }
  return result;
}

void Platform::finishGpuWork() { glFinish(); }

void Platform::swap() { SDL_GL_SwapWindow(window_); }

std::pair<int, int> Platform::drawableSize() const {
  int width = 0, height = 0;
  SDL_GL_GetDrawableSize(window_, &width, &height);
  if (width <= 0 || height <= 0) return {windowWidth_, windowHeight_};
  return {width, height};
}

void Platform::setWindowTitle(const std::string& title) {
  if (window_) {
    SDL_SetWindowTitle(window_, title.c_str());
  }
}

void Platform::printGraphicsDiagnostics() const {
  const auto glText = [](GLenum name) {
    const GLubyte* value = glGetString(name);
    return value ? reinterpret_cast<const char*>(value) : "unknown";
  };
  std::cout << "[pmjs] gl vendor=\"" << glText(GL_VENDOR)
            << "\" renderer=\"" << glText(GL_RENDERER)
            << "\" version=\"" << glText(GL_VERSION) << "\"\n";

  const EGLDisplay display = eglGetCurrentDisplay();
  const EGLContext context = eglGetCurrentContext();
  EGLint configId = 0;
  EGLint minSwap = -1;
  EGLint maxSwap = -1;
  if (display != EGL_NO_DISPLAY && context != EGL_NO_CONTEXT &&
      eglQueryContext(display, context, EGL_CONFIG_ID, &configId) == EGL_TRUE) {
    EGLint count = 0;
    eglGetConfigs(display, nullptr, 0, &count);
    std::vector<EGLConfig> configs(static_cast<std::size_t>(count));
    eglGetConfigs(display, configs.data(), count, &count);
    for (EGLConfig config : configs) {
      EGLint candidateId = 0;
      eglGetConfigAttrib(display, config, EGL_CONFIG_ID, &candidateId);
      if (candidateId != configId) continue;
      eglGetConfigAttrib(display, config, EGL_MIN_SWAP_INTERVAL, &minSwap);
      eglGetConfigAttrib(display, config, EGL_MAX_SWAP_INTERVAL, &maxSwap);
      break;
    }
  }
  const char* eglVendor =
    display == EGL_NO_DISPLAY ? nullptr : eglQueryString(display, EGL_VENDOR);
  const char* eglVersion =
    display == EGL_NO_DISPLAY ? nullptr : eglQueryString(display, EGL_VERSION);
  std::cout << "[pmjs] egl vendor=\"" << (eglVendor ? eglVendor : "unknown")
            << "\" version=\"" << (eglVersion ? eglVersion : "unknown")
            << "\" config=" << configId << " min_swap=" << minSwap
            << " max_swap=" << maxSwap << '\n';

  std::ostringstream drivers;
  for (int index = 0; index < SDL_GetNumVideoDrivers(); ++index) {
    if (index) drivers << ',';
    drivers << SDL_GetVideoDriver(index);
  }
  int windowWidth = 0;
  int windowHeight = 0;
  int drawableWidth = 0;
  int drawableHeight = 0;
  SDL_GetWindowSize(window_, &windowWidth, &windowHeight);
  SDL_GL_GetDrawableSize(window_, &drawableWidth, &drawableHeight);
  SDL_DisplayMode mode{};
  const int displayIndex = SDL_GetWindowDisplayIndex(window_);
  const bool haveMode = displayIndex >= 0 &&
    SDL_GetCurrentDisplayMode(displayIndex, &mode) == 0;
  int contextMajor = 0;
  int contextMinor = 0;
  int doubleBuffer = 0;
  int depthBits = 0;
  int stencilBits = 0;
  SDL_GL_GetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, &contextMajor);
  SDL_GL_GetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, &contextMinor);
  SDL_GL_GetAttribute(SDL_GL_DOUBLEBUFFER, &doubleBuffer);
  SDL_GL_GetAttribute(SDL_GL_DEPTH_SIZE, &depthBits);
  SDL_GL_GetAttribute(SDL_GL_STENCIL_SIZE, &stencilBits);
  GLint maxTextureSize = 0;
  GLint maxTextureUnits = 0;
  GLint maxRenderbufferSize = 0;
  GLint maxVertexAttributes = 0;
  glGetIntegerv(GL_MAX_TEXTURE_SIZE, &maxTextureSize);
  glGetIntegerv(GL_MAX_TEXTURE_IMAGE_UNITS, &maxTextureUnits);
  glGetIntegerv(GL_MAX_RENDERBUFFER_SIZE, &maxRenderbufferSize);
  glGetIntegerv(GL_MAX_VERTEX_ATTRIBS, &maxVertexAttributes);
  const char* renderer = reinterpret_cast<const char*>(glGetString(GL_RENDERER));
  std::cout << "[pmjs-gpu] sdl_driver="
            << (SDL_GetCurrentVideoDriver() ? SDL_GetCurrentVideoDriver() : "unknown")
            << " available_drivers=" << drivers.str()
            << " window=" << windowWidth << 'x' << windowHeight
            << " drawable=" << drawableWidth << 'x' << drawableHeight
            << " display_hz=" << (haveMode ? mode.refresh_rate : 0)
            << " gles=" << contextMajor << '.' << contextMinor
            << " double_buffer=" << doubleBuffer
            << " depth_bits=" << depthBits
            << " stencil_bits=" << stencilBits
            << " max_texture=" << maxTextureSize
            << " max_texture_units=" << maxTextureUnits
            << " max_renderbuffer=" << maxRenderbufferSize
            << " max_vertex_attributes=" << maxVertexAttributes
            << " software=" << (softwareRenderer(renderer) ? "yes" : "no") << '\n';
}

}  // namespace pmjs
