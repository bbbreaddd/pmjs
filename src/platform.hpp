#pragma once

#include <cstdint>
#include <string>
#include <utility>

struct SDL_Window;
struct _SDL_GameController;
using SDL_GameController = _SDL_GameController;
using SDL_GLContext = void*;

namespace pmjs {

class Platform {
 public:
  Platform(int width, int height, std::string title);
  ~Platform();

  Platform(const Platform&) = delete;
  Platform& operator=(const Platform&) = delete;

  bool pollEvents();
  bool inputDown(const std::string& action) const;
  bool inputPressed(const std::string& action) const;
  std::uint32_t inputState() const;
  bool windowFocused() const { return windowFocused_; }
  bool windowVisible() const { return windowVisible_; }
  std::pair<int, int> drawableSize() const;
  void finishLogicStep();
  void finishGpuWork();
  void swap();
  int requestedSwapInterval() const { return requestedSwapInterval_; }
  bool swapIntervalAccepted() const { return swapIntervalAccepted_; }
  int swapInterval() const { return swapInterval_; }
  void printGraphicsDiagnostics() const;

 private:
  SDL_Window* window_ = nullptr;
  SDL_GLContext context_ = nullptr;
  SDL_GameController* controller_ = nullptr;
  std::uint16_t down_ = 0;
  std::uint16_t pressed_ = 0;
  bool hotkeyDown_ = false;
  bool startDown_ = false;
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
