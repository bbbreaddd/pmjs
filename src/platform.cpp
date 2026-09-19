#include "platform.hpp"

#include <SDL.h>
#include <EGL/egl.h>
#include <GLES3/gl3.h>

#include <algorithm>
#include <cctype>
#include <cstdint>
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

}  // namespace

Platform::Platform(int width, int height, std::string title) {
  if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_GAMECONTROLLER | SDL_INIT_AUDIO) != 0) {
    throw std::runtime_error(std::string("SDL_Init failed: ") + SDL_GetError());
  }
  // Window is the physical drawable; the game size stays with the renderer.
  std::pair<int, int> windowSize = {width, height};
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
  } else {
    SDL_Rect bounds{};
    if (SDL_GetDisplayBounds(0, &bounds) == 0 && bounds.w > 0 &&
        bounds.h > 0) {
      windowSize = {bounds.w, bounds.h};
      displayWidth_ = bounds.w;
      displayHeight_ = bounds.h;
    }
  }
  windowWidth_ = windowSize.first;
  windowHeight_ = windowSize.second;
  for (int index = 0; index < SDL_NumJoysticks(); ++index) {
    if (!SDL_IsGameController(index)) continue;
    controller_ = SDL_GameControllerOpen(index);
    if (controller_) break;
  }

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
  if (controller_) SDL_GameControllerClose(controller_);
  if (context_) SDL_GL_DeleteContext(context_);
  if (window_) SDL_DestroyWindow(window_);
  SDL_Quit();
}

bool Platform::pollEvents() {
  SDL_Event event;
  while (SDL_PollEvent(&event)) {
    if (event.type == SDL_QUIT) return false;
    if (event.type == SDL_WINDOWEVENT && event.window.windowID ==
        SDL_GetWindowID(window_)) {
      switch (event.window.event) {
        case SDL_WINDOWEVENT_FOCUS_GAINED: windowFocused_ = true; break;
        case SDL_WINDOWEVENT_FOCUS_LOST: windowFocused_ = false; break;
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
      action = actionForKey(event.key.keysym.sym);
      isDown = event.type == SDL_KEYDOWN;
      if (isDown && event.key.repeat) action = nullptr;
    } else if (event.type == SDL_CONTROLLERBUTTONDOWN ||
               event.type == SDL_CONTROLLERBUTTONUP) {
      isDown = event.type == SDL_CONTROLLERBUTTONDOWN;
      if (event.cbutton.button == SDL_CONTROLLER_BUTTON_BACK ||
          event.cbutton.button == SDL_CONTROLLER_BUTTON_GUIDE) {
        hotkeyDown_ = isDown;
        if (hotkeyDown_ && startDown_) return false;
        continue;
      }
      if (event.cbutton.button == SDL_CONTROLLER_BUTTON_START) {
        startDown_ = isDown;
        if (hotkeyDown_ && startDown_) return false;
      }
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

void Platform::consumePressed() { pressed_ = 0; }

void Platform::finishGpuWork() { glFinish(); }

void Platform::swap() { SDL_GL_SwapWindow(window_); }

std::pair<int, int> Platform::drawableSize() const {
  int width = 0, height = 0;
  SDL_GL_GetDrawableSize(window_, &width, &height);
  if (width <= 0 || height <= 0) return {windowWidth_, windowHeight_};
  return {width, height};
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
