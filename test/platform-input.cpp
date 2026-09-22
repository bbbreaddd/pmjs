#include "platform.hpp"

#include <SDL.h>

#include <cstdint>
#include <iostream>

int main() {
  const std::pair<int, int> buttonMappings[] = {
    {SDL_CONTROLLER_BUTTON_A, 0}, {SDL_CONTROLLER_BUTTON_B, 1},
    {SDL_CONTROLLER_BUTTON_X, 2}, {SDL_CONTROLLER_BUTTON_Y, 3},
    {SDL_CONTROLLER_BUTTON_LEFTSHOULDER, 4}, {SDL_CONTROLLER_BUTTON_RIGHTSHOULDER, 5},
    {SDL_CONTROLLER_BUTTON_BACK, 8}, {SDL_CONTROLLER_BUTTON_START, 9},
    {SDL_CONTROLLER_BUTTON_LEFTSTICK, 10}, {SDL_CONTROLLER_BUTTON_RIGHTSTICK, 11},
    {SDL_CONTROLLER_BUTTON_DPAD_UP, 12}, {SDL_CONTROLLER_BUTTON_DPAD_DOWN, 13},
    {SDL_CONTROLLER_BUTTON_DPAD_LEFT, 14}, {SDL_CONTROLLER_BUTTON_DPAD_RIGHT, 15},
    {SDL_CONTROLLER_BUTTON_GUIDE, 16}
  };
  for (const auto& [sdlButton, browserButton] : buttonMappings) {
    if (pmjs::standardGamepadButton(sdlButton) != browserButton) {
      std::cerr << "incorrect standard gamepad button mapping: " << sdlButton << '\n';
      return 1;
    }
  }
  pmjs::Platform platform(64, 64, "pmjs input test");
  SDL_Event event{};
  event.type = SDL_WINDOWEVENT;
  event.window.windowID = platform.windowId();
  event.window.event = SDL_WINDOWEVENT_FOCUS_GAINED;
  if (SDL_PushEvent(&event) != 1 || !platform.pollEvents()) return 1;
  event = {};
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
  if (platform.keysDown() != std::vector<int>{13} ||
      platform.keysPressed() != std::vector<int>{13} ||
      platform.keyEvents().size() != 1) return 1;
  platform.finishLogicStep();
  if (!platform.keysPressed().empty()) return 1;
  if (platform.inputState() != ok) {
    std::cerr << "pressed bits survived the logic step\n";
    return 1;
  }
  event = {};
  event.type = SDL_CONTROLLERDEVICEREMOVED;
  event.cdevice.which = -1;
  if (SDL_PushEvent(&event) != 1 || !platform.pollEvents()) return 1;
  if (!platform.inputDown("ok")) {
    std::cerr << "controller removal cleared held keyboard action\n";
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
  event = {};
  event.type = SDL_KEYDOWN;
  event.key.keysym.sym = SDLK_a;
  if (SDL_PushEvent(&event) != 1 || !platform.pollEvents()) return 1;
  if (platform.keysPressed().empty() || platform.keysPressed().back() != 65) return 1;
  platform.consumePressed();
  if ((platform.inputState() & escapePressed) != 0) {
    std::cerr << "consumePressed did not clear the pressed edge\n";
    return 1;
  }
  event = {};
  event.type = SDL_WINDOWEVENT;
  event.window.windowID = platform.windowId();
  event.window.event = SDL_WINDOWEVENT_FOCUS_LOST;
  if (SDL_PushEvent(&event) != 1 || !platform.pollEvents()) return 1;
  if (!platform.keysDown().empty() || !platform.keysPressed().empty() ||
      platform.inputState() != 0) {
    std::cerr << "focus loss retained physical input\n";
    return 1;
  }
  event = {};
  event.type = SDL_WINDOWEVENT;
  event.window.windowID = platform.windowId();
  event.window.event = SDL_WINDOWEVENT_FOCUS_GAINED;
  if (SDL_PushEvent(&event) != 1 || !platform.pollEvents()) return 1;
  event = {};
  event.type = SDL_KEYDOWN;
  event.key.keysym.sym = SDLK_RETURN;
  if (SDL_PushEvent(&event) != 1 || !platform.pollEvents()) return 1;

  const int firstIndex = SDL_JoystickAttachVirtual(SDL_JOYSTICK_TYPE_GAMECONTROLLER,
    SDL_CONTROLLER_BUTTON_MAX, SDL_CONTROLLER_AXIS_MAX, 0);
  const int secondIndex = SDL_JoystickAttachVirtual(SDL_JOYSTICK_TYPE_GAMECONTROLLER,
    SDL_CONTROLLER_BUTTON_MAX, SDL_CONTROLLER_AXIS_MAX, 0);
  if (firstIndex < 0 || secondIndex < 0 || !platform.pollEvents()) return 1;
  SDL_Joystick* first = SDL_JoystickOpen(firstIndex);
  SDL_Joystick* second = SDL_JoystickOpen(secondIndex);
  if (!first || !second) return 1;
  SDL_JoystickSetVirtualButton(first, SDL_CONTROLLER_BUTTON_X, 1);
  SDL_JoystickSetVirtualButton(second, SDL_CONTROLLER_BUTTON_Y, 1);
  if (!platform.pollEvents()) return 1;
  if (!platform.inputDown("shift") || !platform.inputDown("escape")) {
    std::cerr << "virtual controller actions were not held\n";
    return 1;
  }
  SDL_JoystickDetachVirtual(firstIndex);
  if (!platform.pollEvents()) return 1;
  if (!platform.inputDown("ok") || !platform.inputDown("escape") ||
      platform.inputDown("shift")) {
    std::cerr << "controller removal did not preserve remaining actions\n";
    return 1;
  }
  SDL_JoystickClose(first);
  SDL_JoystickClose(second);
  return 0;
}
