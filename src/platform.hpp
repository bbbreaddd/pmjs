#pragma once

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

struct SDL_Window;
struct _SDL_GameController;
using SDL_GameController = _SDL_GameController;
using SDL_GLContext = void*;

namespace pmjs {

int standardGamepadButton(int sdlButton);

class Platform {
 public:
  struct KeyEvent { int keyCode; bool down; bool repeat; bool capsLock; std::string code; std::string key; bool shift; bool ctrl; bool alt; bool meta; };
  struct GamepadState { int index; int instance; bool connected; std::string id; std::vector<int> buttonsDown; std::vector<int> buttonsPressed; std::vector<double> axes; };
  Platform(int width, int height, std::string title);
  ~Platform();

  Platform(const Platform&) = delete;
  Platform& operator=(const Platform&) = delete;

  bool pollEvents();
  bool inputDown(const std::string& action) const;
  bool inputPressed(const std::string& action) const;
  const std::vector<int>& keysDown() const { return keysDown_; }
  const std::vector<int>& keysPressed() const { return keysPressed_; }
  const std::vector<KeyEvent>& keyEvents() const { return keyEvents_; }
  void clearKeyEvents() { keyEvents_.clear(); }
  std::vector<GamepadState> gamepads() const;
  bool consumePress(const std::string& action);
  std::uint32_t inputState() const;
  bool windowFocused() const { return windowFocused_; }
  std::uint32_t windowId() const;
  bool windowVisible() const { return windowVisible_; }
  std::pair<int, int> drawableSize() const;
  int windowWidth() const { return windowWidth_; }
  int windowHeight() const { return windowHeight_; }
  int displayWidth() const { return displayWidth_ > 0 ? displayWidth_ : windowWidth_; }
  int displayHeight() const { return displayHeight_ > 0 ? displayHeight_ : windowHeight_; }
  void setWindowTitle(const std::string& title);
  void finishLogicStep();
  // Clears edges consumed by a simulation step.
  void consumePressed();
  void finishGpuWork();
  void swap();
  int requestedSwapInterval() const { return requestedSwapInterval_; }
  bool swapIntervalAccepted() const { return swapIntervalAccepted_; }
  int swapInterval() const { return swapInterval_; }
  void printGraphicsDiagnostics() const;

 private:
  void recomputeLegacyInput();
  SDL_Window* window_ = nullptr;
  SDL_GLContext context_ = nullptr;
  std::vector<SDL_GameController*> controllers_;
  std::uint16_t down_ = 0;
  std::uint16_t pressed_ = 0;
  bool hotkeyDown_ = false;
  bool startDown_ = false;
  std::vector<int> keysDown_;
  std::vector<int> keysPressed_;
  std::vector<KeyEvent> keyEvents_;
  std::vector<std::pair<int, std::vector<int>>> gamepadDown_;
  std::vector<std::pair<int, std::vector<int>>> gamepadPressed_;
  int windowWidth_ = 0;
  int windowHeight_ = 0;
  int displayWidth_ = -1;
  int displayHeight_ = -1;
  bool windowFocused_ = true;
  bool windowVisible_ = true;
  bool swapIntervalAccepted_ = false;
  int requestedSwapInterval_ = 1;
  int swapInterval_ = 0;
};

}  // namespace pmjs
