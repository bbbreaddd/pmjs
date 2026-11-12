// RPG Maker MV input behavior: Copyright (c) 2015 KADOKAWA CORPORATION./YOJI OJIMA.
// MIT license retained in third_party/rpg-maker-mv.LICENSE.
#include "mv_core_input.hpp"
#include <algorithm>
#include <charconv>
#include <cmath>
#include <limits>

namespace pmjs::mv::core {
namespace {
std::optional<std::uint32_t> arrayIndex(const std::string& name) {
  std::uint32_t value = 0;
  const auto [end, error] = std::from_chars(name.data(), name.data() + name.size(), value);
  if (error != std::errc{} || end != name.data() + name.size() ||
      value == std::numeric_limits<std::uint32_t>::max() || std::to_string(value) != name) return {};
  return value;
}
int direction(int x, int y) { return x || y ? 5 - y * 3 + x : 0; }
}

Input::Input()
    : keyMapper{{9,"tab"},{13,"ok"},{16,"shift"},{17,"control"},{18,"control"},{27,"escape"},
        {32,"ok"},{33,"pageup"},{34,"pagedown"},{37,"left"},{38,"up"},{39,"right"},{40,"down"},
        {45,"escape"},{81,"pageup"},{87,"pagedown"},{88,"escape"},{90,"ok"},{96,"escape"},
        {98,"down"},{100,"left"},{102,"right"},{104,"up"},{120,"debug"}},
      gamepadMapper{{0,"ok"},{1,"cancel"},{2,"shift"},{3,"menu"},{4,"pageup"},{5,"pagedown"},
        {12,"up"},{13,"down"},{14,"left"},{15,"right"}} {}

void Input::clear() {
  current_.clear(); previous_.clear(); order_.clear(); gamepadStates_.clear();
  latest_.reset(); pressedTime_ = 0; dir4_ = 0; dir8_ = 0; preferredAxis_ = 0; date_ = 0;
}
void Input::setCurrent(const std::string& name, bool pressed) {
  if (!current_.contains(name)) {
    auto position = order_.end();
    if (const auto index = arrayIndex(name)) position = std::find_if(order_.begin(), order_.end(), [&](const std::string& existing) {
      const auto other = arrayIndex(existing); return !other || *other > *index;
    });
    order_.insert(position, name);
  }
  current_[name] = pressed;
}
bool Input::keyDown(int keyCode, bool resourceRetryPending) {
  if (keyCode == 144) clear();
  const auto found = keyMapper.find(keyCode);
  if (found == keyMapper.end() || found->second.empty()) return false;
  if (resourceRetryPending && found->second == "ok") return true;
  setCurrent(found->second, true); return false;
}
void Input::keyUp(int keyCode) {
  const auto found = keyMapper.find(keyCode);
  if (found != keyMapper.end() && !found->second.empty()) setCurrent(found->second, false);
  if (keyCode == 0) clear();
}
bool Input::shouldPreventDefault(int code) {
  return code == 8 || code == 33 || code == 34 || (code >= 37 && code <= 40);
}
void Input::updateGamepad(const Gamepad& pad) {
  auto& previous = gamepadStates_[pad.index];
  std::vector<std::optional<bool>> next(std::max<std::size_t>(16, pad.buttons.size()));
  for (int button = 12; button < 16; ++button) next[button] = false;
  for (std::size_t i = 0; i < pad.buttons.size(); ++i) next[i] = pad.buttons[i];
  const double x = pad.axes.size() > 0 ? pad.axes[0] : 0, y = pad.axes.size() > 1 ? pad.axes[1] : 0;
  if (y < -0.5) next[12] = true; else if (y > 0.5) next[13] = true;
  if (x < -0.5) next[14] = true; else if (x > 0.5) next[15] = true;
  for (std::size_t i = 0; i < next.size(); ++i) {
    const auto old = i < previous.size() ? previous[i] : std::nullopt;
    if (next[i] == old) continue;
    const auto mapped = gamepadMapper.find(static_cast<int>(i));
    if (mapped != gamepadMapper.end() && !mapped->second.empty()) setCurrent(mapped->second, next[i].value_or(false));
  }
  previous = std::move(next);
}
void Input::update(const std::vector<Gamepad>& pads, double now) {
  for (const auto& pad : pads) if (pad.connected) updateGamepad(pad);
  if (latest_ && current(*latest_)) ++pressedTime_; else latest_.reset();
  for (const auto& name : order_) {
    const bool down = current(name);
    if (down && !previous_[name]) { latest_ = name; pressedTime_ = 0; date_ = now; }
    previous_[name] = down;
  }
  int x = int(isPressed("right")) - int(isPressed("left"));
  int y = int(isPressed("down")) - int(isPressed("up"));
  dir8_ = direction(x, y);
  if (x && y) { if (preferredAxis_ == 'x') y = 0; else x = 0; }
  else if (x) preferredAxis_ = 'y'; else if (y) preferredAxis_ = 'x';
  dir4_ = direction(x, y);
}
bool Input::current(std::string_view name) const {
  const auto found = current_.find(name); return found != current_.end() && found->second;
}
bool Input::escapeCompatible(std::string_view name) { return name == "cancel" || name == "menu"; }
bool Input::isPressed(std::string_view name) const {
  return (escapeCompatible(name) && isPressed("escape")) || current(name);
}
bool Input::isTriggered(std::string_view name) const {
  return (escapeCompatible(name) && isTriggered("escape")) || (latest_ && *latest_ == name && pressedTime_ == 0);
}
bool Input::isRepeated(std::string_view name) const {
  const bool repeat = pressedTime_ == 0 || (pressedTime_ >= static_cast<std::uint64_t>(std::max(0, keyRepeatWait)) &&
    keyRepeatInterval != 0 && std::fmod(static_cast<double>(pressedTime_), keyRepeatInterval) == 0);
  return (escapeCompatible(name) && isRepeated("escape")) || (latest_ && *latest_ == name && repeat);
}
bool Input::isLongPressed(std::string_view name) const {
  return (escapeCompatible(name) && isLongPressed("escape")) ||
    (latest_ && *latest_ == name && pressedTime_ >= static_cast<std::uint64_t>(std::max(0, keyRepeatWait)));
}
}

namespace pmjs::mv::core {
void TouchInput::clear() { pending_={};frame_={};mousePressed_=false;screenPressed_=false;pressedTime_=0;x_=0;y_=0;date_=0; }
void TouchInput::update() { frame_=pending_;pending_={};if(isPressed())++pressedTime_; }
void TouchInput::trigger(double x,double y,double now) { pending_.triggered=true;x_=x;y_=y;date_=now; }
void TouchInput::cancel(double x,double y) { pending_.cancelled=true;x_=x;y_=y; }
void TouchInput::mouseDown(int button,double x,double y,bool inside,double now) {
  if(!inside)return;
  if(button==0){mousePressed_=true;pressedTime_=0;trigger(x,y,now);}else if(button==2)cancel(x,y);
}
void TouchInput::mouseMove(double x,double y) { if(mousePressed_)touchMove(x,y); }
void TouchInput::mouseUp(int button,double x,double y) { if(button==0){mousePressed_=false;pending_.released=true;x_=x;y_=y;} }
void TouchInput::wheel(double x,double y) { pending_.wheelX+=x;pending_.wheelY+=y; }
void TouchInput::touchStart(const std::vector<std::array<double,2>>& changed,int touches,int width,int height,double now) {
  for(const auto& point:changed)if(point[0]>=0&&point[1]>=0&&point[0]<width&&point[1]<height){
    screenPressed_=true;pressedTime_=0;if(touches>=2)cancel(point[0],point[1]);else trigger(point[0],point[1],now);
  }
}
void TouchInput::touchMove(double x,double y){pending_.moved=true;x_=x;y_=y;}
void TouchInput::touchEnd(double x,double y){screenPressed_=false;pending_.released=true;x_=x;y_=y;}
void TouchInput::pointerDown(bool touch,bool primary,double x,double y,bool inside){if(touch&&!primary&&inside)cancel(x,y);}
bool TouchInput::isRepeated()const{return isPressed()&&(frame_.triggered||(pressedTime_>=keyRepeatWait&&keyRepeatInterval!=0&&std::fmod(pressedTime_,keyRepeatInterval)==0));}
}
