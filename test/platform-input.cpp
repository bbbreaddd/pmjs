#include "platform.hpp"

#include <SDL.h>

#include <cstdint>
#include <iostream>

int main() {
  pmjs::Platform platform(64, 64, "pmjs input test");
  SDL_Event event{};
  event.type = SDL_KEYDOWN;
  event.key.keysym.sym = SDLK_RETURN;
  event.key.repeat = 0;
  if (SDL_PushEvent(&event) != 1 || !platform.pollEvents()) return 1;

  constexpr std::uint32_t ok = 1U << 4U;
  const std::uint32_t state = platform.inputState();
  if ((state & ok) == 0 || (state & (ok << 16U)) == 0) {
    std::cerr << "input state lost down or pressed bits: " << state << '\n';
    return 1;
  }
  platform.finishLogicStep();
  if (platform.inputState() != ok) {
    std::cerr << "pressed bits survived the logic step\n";
    return 1;
  }
  event = {};
  event.type = SDL_KEYDOWN;
  event.key.keysym.sym = SDLK_x;
  event.key.repeat = 0;
  if (SDL_PushEvent(&event) != 1 || !platform.pollEvents()) return 1;
  constexpr std::uint32_t escapePressed = (1U << 5U) << 16U;
  if ((platform.inputState() & escapePressed) == 0) {
    std::cerr << "pressed edge was not latched\n";
    return 1;
  }
  platform.consumePressed();
  if ((platform.inputState() & escapePressed) != 0) {
    std::cerr << "consumePressed did not clear the pressed edge\n";
    return 1;
  }
  event = {};
  event.type = SDL_CONTROLLERBUTTONDOWN;
  event.cbutton.button = SDL_CONTROLLER_BUTTON_BACK;
  if (SDL_PushEvent(&event) != 1 || !platform.pollEvents()) return 1;
  event.cbutton.button = SDL_CONTROLLER_BUTTON_START;
  if (SDL_PushEvent(&event) != 1 || platform.pollEvents()) {
    std::cerr << "hotkey plus start did not request exit\n";
    return 1;
  }
  return 0;
}
