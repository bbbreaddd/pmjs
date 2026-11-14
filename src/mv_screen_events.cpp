#include "mv_engine.hpp"
#include "mv_sprites.hpp"
#include <atomic>
#include <cmath>

namespace pmjs::mv {
std::uint64_t nextRuntimeIdentity() { static std::atomic<std::uint64_t> next{0}; return ++next; }
namespace {
using Object = Value::Object;
using Array = Value::Array;
std::shared_ptr<RuntimeTone> makeTone(const Value& value) {
  if (value.null()) return {};
  auto tone = std::make_shared<RuntimeTone>();
  for (std::size_t i = 0; i < 4; ++i) tone->values[i] = value[i].number();
  return tone;
}
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
Value RuntimeTone::snapshot() const { return Array{values[0], values[1], values[2], values[3]}; }
Value RuntimePicture::snapshot() const {
  auto result = std::get<Object>(state.data);
  result["_tone"] = tone ? tone->snapshot() : Value{};
  result["_toneTarget"] = toneTarget ? toneTarget->snapshot() : Value{};
  return result;
}
void RuntimePicture::restore(const Value& value) {
  state = value;
  tone = makeTone(state["_tone"]); toneTarget = makeTone(state["_toneTarget"]);
  auto& fields = std::get<Object>(state.data);
  fields.erase("_tone"); fields.erase("_toneTarget");
}
Value Session::screenState() const {
  auto state = screenEffects_.null() ? initialScreen() : std::get<Object>(screenEffects_.data);
  state["_brightness"] = brightness_; state["_fadeOutDuration"] = fadeOut_; Array savedPictures;
  for (const auto& picture : pictures_) savedPictures.push_back(picture ? picture->snapshot() : Value{});
  state["_pictures"] = std::move(savedPictures);
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
    pictures_[id] = createRuntimePicture(id);
    dispatchPicture(pictures_[id], "initialize");
    dispatchPicture(pictures_[id], "show", {p[1], p[2], x, y, p[6], p[7], p[8], p[9]});
    return true;
  }
  if (pictures_[id]) {
    if (code == 232) {
      const auto x = p[3].integer() ? variable(p[4].integer()) : p[4];
      const auto y = p[3].integer() ? variable(p[5].integer()) : p[5];
      dispatchPicture(pictures_[id], "move", {p[2], x, y, p[6], p[7], p[8], p[9], p[10]});
    } else if (code == 233) dispatchPicture(pictures_[id], "rotate", {p[1]});
    else if (code == 234) {
      dispatchPicture(pictures_[id], "tint", {p[1], p[2]});
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
  const auto activePictures = pictures_;
  for (const auto& picture : activePictures) {
    if (!picture) continue;
    dispatchPicture(picture, "update");
    if (runtimeHooks_ && runtimeHooks_->sprite) runtimeHooks_->sprite(picture);
  }
  if (runtimeHooks_ && runtimeHooks_->updateSprites) runtimeHooks_->updateSprites();
}
bool Session::ownsPictureSprite(const RuntimePicture& picture) const {
  const auto found = pictureSprites_.find(picture.slot);
  return found != pictureSprites_.end() && found->second == picture.sprite;
}
std::shared_ptr<RuntimePicture> Session::createRuntimePicture(int slot) {
  auto picture = std::make_shared<RuntimePicture>();
  picture->state = Object{}; picture->slot = slot;
  if (slot >= 0) {
    auto& sprite = pictureSprites_[slot];
    if (!sprite) sprite = std::make_shared<Sprite_Picture>(slot);
    picture->sprite = sprite;
  } else picture->sprite = std::make_shared<Sprite_Picture>(slot);
  return picture;
}
std::shared_ptr<RuntimePicture> Session::runtimePicture(int id) const {
  const int slot = id + (battle_.active ? 100 : 0);
  return slot >= 0 && slot < static_cast<int>(pictures_.size()) ? pictures_[slot] : nullptr;
}
void Session::dispatchPicture(const std::shared_ptr<RuntimePicture>& value, const std::string& method, const Array& arguments) {
  if (!runtimeHooks_ || !runtimeHooks_->picture || !runtimeHooks_->picture(value, method, arguments))
    invokePictureBase(value, method, arguments);
}
void Session::invokePictureBase(const std::shared_ptr<RuntimePicture>& value, const std::string& method, const Array& arguments) {
  auto& picture = std::get<Object>(value->state.data);
  const auto dispatch = [&](const std::string& name) {
    dispatchPicture(value, name);
  };
  if (method == "initialize") {
    dispatch("initBasic"); dispatch("initTarget"); dispatch("initTone"); dispatch("initRotation");
  } else if (method == "initBasic") {
    picture["@"] = "Game_Picture"; picture["_name"] = "";
    for (const auto* key : {"_origin", "_x", "_y", "_blendMode"}) picture[key] = 0;
    picture["_scaleX"] = picture["_scaleY"] = 100; picture["_opacity"] = 255;
  } else if (method == "initTarget") {
    for (const auto& pair : {std::pair{"_x", "_targetX"}, {"_y", "_targetY"}, {"_scaleX", "_targetScaleX"}, {"_scaleY", "_targetScaleY"}, {"_opacity", "_targetOpacity"}})
      picture[pair.second] = picture[pair.first];
    picture["_duration"] = 0;
  } else if (method == "initTone") {
    value->tone.reset(); value->toneTarget.reset(); picture["_toneDuration"] = 0;
  } else if (method == "initRotation") {
    picture["_angle"] = 0; picture["_rotationSpeed"] = 0;
  } else if (method == "show") {
    if (arguments.size() != 8) throw std::invalid_argument("picture show requires eight arguments");
    const char* keys[] = {"_name", "_origin", "_x", "_y", "_scaleX", "_scaleY", "_opacity", "_blendMode"};
    for (std::size_t i = 0; i < 8; ++i) picture[keys[i]] = arguments[i];
    dispatch("initTarget"); dispatch("initTone"); dispatch("initRotation");
  } else if (method == "move") {
    if (arguments.size() != 8) throw std::invalid_argument("picture move requires eight arguments");
    const char* keys[] = {"_origin", "_targetX", "_targetY", "_targetScaleX", "_targetScaleY", "_targetOpacity", "_blendMode", "_duration"};
    for (std::size_t i = 0; i < 8; ++i) picture[keys[i]] = arguments[i];
  } else if (method == "rotate") {
    if (arguments.size() != 1) throw std::invalid_argument("picture rotate requires one argument");
    picture["_rotationSpeed"] = arguments[0];
  } else if (method == "tint") {
    if (arguments.size() != 2 || arguments[0].array().size() != 4) throw std::invalid_argument("picture tint requires four components and a duration");
    if (!value->tone) value->tone = std::make_shared<RuntimeTone>();
    value->toneTarget = makeTone(arguments[0]); picture["_toneDuration"] = arguments[1];
    if (!arguments[1].integer()) value->tone = makeTone(arguments[0]);
  } else if (method == "update") {
    dispatch("updateMove"); dispatch("updateTone"); dispatch("updateRotation");
  } else if (method == "updateMove") {
    const int duration = picture["_duration"].integer();
    if (duration > 0) {
      for (const auto& pair : {std::pair{"_x", "_targetX"}, {"_y", "_targetY"}, {"_scaleX", "_targetScaleX"}, {"_scaleY", "_targetScaleY"}, {"_opacity", "_targetOpacity"}})
        picture[pair.first] = (picture[pair.first].number() * (duration - 1) + picture[pair.second].number()) / duration;
      picture["_duration"] = duration - 1;
    }
  } else if (method == "updateTone") {
    const int duration = picture["_toneDuration"].integer();
    if (duration > 0 && value->tone && value->toneTarget) {
      for (std::size_t i = 0; i < 4; ++i)
        value->tone->values[i] = (value->tone->values[i] * (duration - 1) + value->toneTarget->values[i]) / duration;
      picture["_toneDuration"] = duration - 1;
    }
  }
  else if (method == "updateRotation") picture["_angle"] = picture["_angle"].number() + picture["_rotationSpeed"].number() / 2;
  else if (method == "syncSprite") {
    if (value->slot < 0) value->sprite->syncFromPicture(value->state);
    else if (value->slot < static_cast<int>(pictures_.size()) && pictures_[value->slot]) value->sprite->syncFromPicture(pictures_[value->slot]->state);
    else value->sprite->visible = false;
  }
  else throw std::invalid_argument("unknown native picture method: " + method);
}
}  // namespace pmjs::mv
