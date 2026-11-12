#include "mv_core_input.hpp"
#include <iostream>
#include <iomanip>
#include <sstream>
#include <stdexcept>

using pmjs::mv::core::Input;
using pmjs::mv::core::Gamepad;
namespace {
void require(bool result, const char* message) { if (!result) throw std::runtime_error(message); }
void trace() {
  Input input;
  std::map<int, Gamepad> pads;
  int retries = 0, prevented = 0;
  std::string line;
  const std::vector<std::string> names{"ok","cancel","menu","escape","shift","control","tab","pageup","pagedown","left","right","up","down","debug","action","2","10","01"};
  while (std::getline(std::cin, line)) {
    std::istringstream fields(line); std::string operation; fields >> operation;
    if (operation == "down") {
      int key, pending; fields >> key >> pending;
      prevented += Input::shouldPreventDefault(key); retries += input.keyDown(key, pending);
    } else if (operation == "up") { int key; fields >> key; input.keyUp(key); }
    else if (operation == "clear") input.clear();
    else if (operation == "repeat") fields >> input.keyRepeatWait >> input.keyRepeatInterval;
    else if (operation == "keymap" || operation == "padmap") {
      int code; std::string name; fields >> code >> name;
      auto& mapper = operation == "keymap" ? input.keyMapper : input.gamepadMapper;
      if (name == "-") mapper.erase(code); else mapper[code] = name;
    } else if (operation == "pad") {
      Gamepad pad; std::string buttons; double x, y;
      fields >> pad.index >> pad.connected >> buttons >> x >> y;
      if (buttons != "-") for (char down : buttons) pad.buttons.push_back(down == '1');
      pad.axes = {x, y}; pads[pad.index] = std::move(pad);
    } else if (operation == "update") {
      double date; fields >> date;
      std::vector<Gamepad> connected; for (const auto& [index, pad] : pads) { (void)index; connected.push_back(pad); }
      input.update(connected, date);
      std::cout << '[' << input.dir4() << ',' << input.dir8() << ',' << std::setprecision(17) << input.date() << ',' << retries << ',' << prevented;
      for (const auto& name : names) std::cout << ',' << (int(input.isPressed(name)) | (int(input.isTriggered(name)) << 1) |
        (int(input.isRepeated(name)) << 2) | (int(input.isLongPressed(name)) << 3));
      std::cout << "]\n";
    } else throw std::runtime_error("unknown input trace operation: " + operation);
    if (fields.fail()) throw std::runtime_error("invalid input trace: " + line);
  }
}
}
int main(int argc, char**) try {
  if (argc > 1) { trace(); return 0; }
  Input input;
  input.keyDown(90); input.update({}, 100);
  require(input.isTriggered("ok") && input.isRepeated("ok"), "first press must trigger and repeat");
  for (int i = 1; i <= 24; ++i) input.update({}, 100 + i);
  require(input.isRepeated("ok") && input.isLongPressed("ok"), "held key must repeat at the wait boundary");
  input.keyDown(38); input.update({}, 200);
  require(!input.isLongPressed("ok") && input.isPressed("ok"), "latest button owns repeat and long-press timing");
  input.keyDown(39); input.update({}, 201);
  require(input.dir4() == 6 && input.dir8() == 9, "diagonal movement must prefer the newly added axis");
  input.clear(); require(input.date() == 0 && !input.isPressed("ok"), "clear must release inputs and reset date");
  input.keyDown(27); input.update({}, 300);
  require(input.isTriggered("menu") && input.isTriggered("cancel"), "escape must alias menu and cancel");
  std::cout << "native MV core input checks passed\n";
  return 0;
} catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
