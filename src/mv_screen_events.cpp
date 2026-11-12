#include "mv_engine.hpp"
#include <cmath>

namespace pmjs::mv {
namespace {
using Object = Value::Object;
using Array = Value::Array;
Object initialScreen() {
  return {{"@", "Game_Screen"}, {"_fadeInDuration", 0}, {"_tone", Array{0,0,0,0}}, {"_toneTarget", Array{0,0,0,0}}, {"_toneDuration", 0},
    {"_flashColor", Array{0,0,0,0}}, {"_flashDuration", 0}, {"_shakePower", 0}, {"_shakeSpeed", 0}, {"_shakeDuration", 0}, {"_shakeDirection", 1}, {"_shake", 0},
    {"_zoomX", 0}, {"_zoomY", 0}, {"_zoomScale", 1}, {"_zoomScaleTarget", 1}, {"_zoomDuration", 0}, {"_weatherType", "none"}, {"_weatherPower", 0}, {"_weatherPowerTarget", 0}, {"_weatherDuration", 0}};
}
void tweenTone(Object& state) {
  const int duration = state["_toneDuration"].integer();
  if (duration <= 0) return;
  auto& tone = std::get<Array>(state["_tone"].data);
  for (std::size_t i = 0; i < 4; ++i) tone[i] = (tone[i].number() * (duration - 1) + state["_toneTarget"][i].number()) / duration;
  state["_toneDuration"] = duration - 1;
}
}
Value Session::screenState() const {
  auto state = screenEffects_.null() ? initialScreen() : std::get<Object>(screenEffects_.data);
  state["_brightness"] = brightness_; state["_fadeOutDuration"] = fadeOut_; state["_pictures"] = pictures_;
  return state;
}
std::array<double, 4> Session::screenTone() const {
  const auto& tone = screenEffects_["_tone"];
  return {tone[0].number(), tone[1].number(), tone[2].number(), tone[3].number()};
}
std::array<double, 4> Session::screenFlashColor() const {
  const auto& color = screenEffects_["_flashColor"];
  return {color[0].number(), color[1].number(), color[2].number(), color[3].number()};
}
bool Session::screenEventCommand(const Value& entry, Interpreter& context) {
  if (screenEffects_.null()) screenEffects_ = initialScreen();
  auto& state = std::get<Object>(screenEffects_.data);
  const auto& p = entry["parameters"];
  const int code = entry["code"].integer();
  if (code == 221 || code == 222) {
    if (message_.busy) return false;
    fadeOut_ = code == 221 ? 24 : 0; state["_fadeInDuration"] = code == 222 ? 24 : 0;
    context.wait = 24; ++context.index; return false;
  }
  if (code == 223) {
    state["_toneTarget"] = p[0]; state["_toneDuration"] = p[1];
    if (!p[1].integer()) state["_tone"] = p[0];
    if (p[2].boolean()) context.wait = p[1].integer();
    return true;
  }
  if (code == 224) {
    state["_flashColor"] = p[0]; state["_flashDuration"] = p[1];
    if (p[2].boolean()) context.wait = p[1].integer();
    return true;
  }
  if (code == 225) {
    state["_shakePower"] = p[0]; state["_shakeSpeed"] = p[1]; state["_shakeDuration"] = p[2];
    if (p[3].boolean()) context.wait = p[2].integer();
    return true;
  }
  if (code == 236) {
    if (!battle_.active) {
      const auto type = p[0].text(); const int duration = p[2].integer();
      if (type != "none" || duration == 0) state["_weatherType"] = type;
      state["_weatherPowerTarget"] = type == "none" ? Value(0) : p[1]; state["_weatherDuration"] = duration;
      if (!duration) state["_weatherPower"] = state["_weatherPowerTarget"];
      if (p[3].boolean()) context.wait = duration;
    }
    return true;
  }
  if (code < 231 || code > 235) return false;
  const int id = p[0].integer() + (battle_.active ? 100 : 0);
  if (id < 0) return true;
  if (id >= static_cast<int>(pictures_.size())) pictures_.resize(id + 1);
  if (code == 235) { pictures_[id] = {}; return true; }
  if (code == 231) {
    const auto x = p[3].integer() ? variable(p[4].integer()) : p[4];
    const auto y = p[3].integer() ? variable(p[5].integer()) : p[5];
    pictures_[id] = Object{{"@", "Game_Picture"}, {"_name", p[1]}, {"_origin", p[2]}, {"_x", x}, {"_y", y},
      {"_scaleX", p[6]}, {"_scaleY", p[7]}, {"_opacity", p[8]}, {"_blendMode", p[9]},
      {"_targetX", x}, {"_targetY", y}, {"_targetScaleX", p[6]}, {"_targetScaleY", p[7]}, {"_targetOpacity", p[8]}, {"_duration", 0},
      {"_tone", Value{}}, {"_toneTarget", Value{}}, {"_toneDuration", 0}, {"_angle", 0}, {"_rotationSpeed", 0}};
    return true;
  }
  if (!pictures_[id].null()) {
    auto& picture = std::get<Object>(pictures_[id].data);
    if (code == 232) {
      picture["_origin"] = p[2];
      picture["_targetX"] = p[3].integer() ? variable(p[4].integer()) : p[4];
      picture["_targetY"] = p[3].integer() ? variable(p[5].integer()) : p[5];
      picture["_targetScaleX"] = p[6]; picture["_targetScaleY"] = p[7]; picture["_targetOpacity"] = p[8];
      picture["_blendMode"] = p[9]; picture["_duration"] = p[10];
    } else if (code == 233) picture["_rotationSpeed"] = p[1];
    else if (code == 234) {
      if (picture["_tone"].null()) picture["_tone"] = Array{0,0,0,0};
      picture["_toneTarget"] = p[1]; picture["_toneDuration"] = p[2];
      if (!p[2].integer()) picture["_tone"] = p[1];
    }
  }
  if (code == 232 && p[11].boolean()) context.wait = p[10].integer();
  if (code == 234 && p[3].boolean()) context.wait = p[2].integer();
  return true;
}
void Session::ensureScreenEffects() {
  if (screenEffects_.null()) screenEffects_ = initialScreen();
}
void Session::updateScreenState() {
  ensureScreenEffects();
  auto& state = std::get<Object>(screenEffects_.data);
  if (fadeOut_ > 0) { brightness_ = brightness_ * (fadeOut_ - 1) / fadeOut_; --fadeOut_; }
  int duration = state["_fadeInDuration"].integer();
  if (duration > 0) { brightness_ = (brightness_ * (duration - 1) + 255) / duration; state["_fadeInDuration"] = duration - 1; }
  tweenTone(state);
  duration = state["_flashDuration"].integer();
  if (duration > 0) {
    auto& color = std::get<Array>(state["_flashColor"].data); color[3] = color[3].number() * (duration - 1) / duration;
    state["_flashDuration"] = duration - 1;
  }
  duration = state["_shakeDuration"].integer();
  double shake = state["_shake"].number();
  if (duration > 0 || shake != 0) {
    const double power = state["_shakePower"].number();
    const double delta = power * state["_shakeSpeed"].number() * state["_shakeDirection"].number(1) / 10;
    shake = duration <= 1 && shake * (shake + delta) < 0 ? 0 : shake + delta;
    state["_shake"] = shake;
    if (shake > power * 2) state["_shakeDirection"] = -1;
    if (shake < -power * 2) state["_shakeDirection"] = 1;
    state["_shakeDuration"] = duration - 1;
  }
  for (const auto& name : {"zoom", "weather"}) {
    const std::string prefix = std::string("_") + name;
    duration = state[prefix + "Duration"].integer();
    if (duration <= 0) continue;
    const auto value = prefix + (std::string(name) == "zoom" ? "Scale" : "Power");
    state[value] = (state[value].number() * (duration - 1) + state[value + "Target"].number()) / duration;
    state[prefix + "Duration"] = duration - 1;
    if (std::string(name) == "weather" && duration == 1 && state["_weatherPowerTarget"].number() == 0) state["_weatherType"] = "none";
  }
  for (auto& value : pictures_) {
    if (value.null()) continue;
    auto& picture = std::get<Object>(value.data);
    duration = picture["_duration"].integer();
    if (duration > 0) {
      for (const auto& pair : {std::pair{"_x", "_targetX"}, {"_y", "_targetY"}, {"_scaleX", "_targetScaleX"}, {"_scaleY", "_targetScaleY"}, {"_opacity", "_targetOpacity"}})
        picture[pair.first] = (picture[pair.first].number() * (duration - 1) + picture[pair.second].number()) / duration;
      picture["_duration"] = duration - 1;
    }
    tweenTone(picture);
    picture["_angle"] = picture["_angle"].number() + picture["_rotationSpeed"].number() / 2;
  }
}
}  // namespace pmjs::mv
