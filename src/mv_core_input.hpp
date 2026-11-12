#pragma once

#include <cstdint>
#include <array>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace pmjs::mv::core {

struct Gamepad {
  int index = 0;
  bool connected = true;
  std::vector<bool> buttons;
  std::vector<double> axes;
};

class Input {
 public:
  Input();
  std::map<int, std::string> keyMapper;
  std::map<int, std::string> gamepadMapper;
  int keyRepeatWait = 24;
  int keyRepeatInterval = 6;

  void clear();
  bool keyDown(int keyCode, bool resourceRetryPending = false);
  void keyUp(int keyCode);
  void update(const std::vector<Gamepad>& gamepads, double nowMilliseconds);
  bool isPressed(std::string_view name) const;
  bool isTriggered(std::string_view name) const;
  bool isRepeated(std::string_view name) const;
  bool isLongPressed(std::string_view name) const;
  int dir4() const { return dir4_; }
  int dir8() const { return dir8_; }
  double date() const { return date_; }
  static bool shouldPreventDefault(int keyCode);

 private:
  void setCurrent(const std::string& name, bool pressed);
  void updateGamepad(const Gamepad& gamepad);
  bool current(std::string_view name) const;
  static bool escapeCompatible(std::string_view name);
  std::map<std::string, bool, std::less<>> current_, previous_;
  std::vector<std::string> order_;
  std::map<int, std::vector<std::optional<bool>>> gamepadStates_;
  std::optional<std::string> latest_;
  std::uint64_t pressedTime_ = 0;
  char preferredAxis_ = 0;
  int dir4_ = 0, dir8_ = 0;
  double date_ = 0;
};

}

namespace pmjs::mv::core {
class TouchInput {
 public:
  int keyRepeatWait = 24, keyRepeatInterval = 6;
  void clear();
  void update();
  void mouseDown(int button, double x, double y, bool inside, double now);
  void mouseMove(double x, double y);
  void mouseUp(int button, double x, double y);
  void wheel(double x, double y);
  void touchStart(const std::vector<std::array<double, 2>>& changed, int touches, int width, int height, double now);
  void touchMove(double x, double y);
  void touchEnd(double x, double y);
  void touchCancel() { screenPressed_ = false; }
  void pointerDown(bool touch, bool primary, double x, double y, bool inside);
  bool isPressed() const { return mousePressed_ || screenPressed_; }
  bool isTriggered() const { return frame_.triggered; }
  bool isCancelled() const { return frame_.cancelled; }
  bool isMoved() const { return frame_.moved; }
  bool isReleased() const { return frame_.released; }
  bool isRepeated() const;
  bool isLongPressed() const { return isPressed() && pressedTime_ >= keyRepeatWait; }
  double x() const { return x_; }
  double y() const { return y_; }
  double wheelX() const { return frame_.wheelX; }
  double wheelY() const { return frame_.wheelY; }
  double date() const { return date_; }
 private:
  void trigger(double x, double y, double now);
  void cancel(double x, double y);
  struct Events { bool triggered=false, cancelled=false, moved=false, released=false; double wheelX=0, wheelY=0; } pending_, frame_;
  bool mousePressed_=false, screenPressed_=false;
  double pressedTime_=0, x_=0, y_=0, date_=0;
};
}
