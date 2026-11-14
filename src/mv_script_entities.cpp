#include "mv_engine.hpp"
#include "mv_core_utils.hpp"
#include "mv_windows.hpp"
#include "mv_sprites.hpp"
#include <cmath>
#include <stdexcept>

namespace pmjs::mv {
Session::~Session() { detachRuntimeEntities(true); }
void Session::detachRuntimeEntities(bool all) {
  if (all) for (auto& effect : visualEffects_) if (effect.balloonSprite) effect.balloonSprite->active = false;
  if (all && weatherRuntime_) weatherRuntime_->active = false;
  for (auto it = runtimeCharacters_.begin(); it != runtimeCharacters_.end();) {
    if (!all && it->first < 0) { ++it; continue; }
    if (auto object = it->second.lock()) object->detach();
    it = runtimeCharacters_.erase(it);
  }
  if (all) {
    detachRuntimeEnemies();
    for (const auto& [id, weak] : runtimeActors_) { (void)id; if (auto object = weak.lock()) object->detach(); }
    runtimeActors_.clear(); cameraTarget_.reset();
  }
}
std::shared_ptr<RuntimeCharacter> Session::runtimeCharacter(int id) {
  if (auto object = runtimeCharacters_[id].lock()) return object;
  Character* character = id == -1 ? &player_ : nullptr;
  if (id <= -5 && id >= -7) character=&vehicles_[static_cast<std::size_t>(-id-5)].character;
  if (id <= -2 && id >= -4) character=&followers_[static_cast<std::size_t>(-id-2)];
  if (id > 0) for (auto& event : events_) if (event.id == id) { character = &event.character; break; }
  if (!character) { runtimeCharacters_.erase(id); return {}; }
  auto object = std::make_shared<RuntimeCharacter>(); object->id = id; object->mapId = mapId_; object->attached = character;
  runtimeCharacters_[id] = object; return object;
}
std::shared_ptr<RuntimeActor> Session::runtimeActor(int id) {
  if (id <= 0 || database_["actors"][id].null()) return {};
  if (auto object = runtimeActors_[id].lock()) return object;
  if (!actors_.contains(id)) initializeActor(id);
  // Initialization may publish this actor through a script lifecycle override.
  if (auto object = runtimeActors_[id].lock()) return object;
  auto object = std::make_shared<RuntimeActor>(); object->id = id; object->attached = &actors_.at(id);
  runtimeActors_[id] = object; return object;
}
std::shared_ptr<RuntimeActor> Session::runtimeEnemy(int index) {
  return index >= 0 && index < static_cast<int>(battle_.enemies.size()) ? runtimeBattler(battle_.enemies[index]) : nullptr;
}
void Session::detachRuntimeEnemies() {
  for (const auto& [index, weak] : runtimeEnemies_) { (void)index; if (auto object = weak.lock()) object->detach(); }
  for (const auto& [index, weak] : runtimeEnemySprites_) {
    (void)index;
    if (auto object = weak.lock()) { object->active = false; object->value->setBattler(object->enemy ? &object->enemy->value() : nullptr); }
  }
  runtimeEnemySprites_.clear(); runtimeEnemies_.clear();
}
std::shared_ptr<RuntimeActor> Session::runtimeBattler(Battler& battler) {
  if (!battler.enemy && actors_.contains(battler.id) && &actors_.at(battler.id) == &battler) return runtimeActor(battler.id);
  for (std::size_t i = 0; i < battle_.enemies.size(); ++i) if (&battle_.enemies[i] == &battler) {
    const int index = static_cast<int>(i);
    if (auto object = runtimeEnemies_[index].lock()) return object;
    auto object = std::make_shared<RuntimeActor>(); object->id = index; object->attached = &battler;
    runtimeEnemies_[index] = object; return object;
  }
  auto object = std::make_shared<RuntimeActor>(); object->id = battler.id; object->retained = std::make_unique<Battler>(battler); return object;
}
void Session::initializeActorSkills(const std::shared_ptr<RuntimeActor>& object) {
  auto& actor = object->value(); actor.skills.clear();
  for (const auto& learning : database_["classes"][actor.classId]["learnings"].array())
    if (learning["level"].integer() <= actor.level) actor.skills.insert(learning["skillId"].integer());
}
void Session::initializeActorMembers(const std::shared_ptr<RuntimeActor>& object) {
  const int id = object->id; object->value() = Battler{}; object->value().id = id;
}
Value Session::runtimeCharacterCommand(const std::shared_ptr<RuntimeCharacter>& object, const std::string& method, const Value::Array& arguments) {
  auto& character = object->value();
  if (method.starts_with("followers.")) {
    const auto action=method.substr(10);
    if (action=="visible") { if (!arguments.empty()) followersVisible_=arguments[0].boolean(); return followersVisible_; }
    if (action=="gather") { followersGathering_=true; return Value::undefined(); }
    if (action=="isGathering") return followersGathering_;
    if (action=="isMoving") return std::any_of(followers_.begin(),followers_.end(),[](const auto& follower) { return follower.moving(); });
    if (action=="isGathered") return std::all_of(followers_.begin(),followers_.end(),[&](const auto& follower) { return !follower.moving() && follower.x==player_.x && follower.y==player_.y; });
    if (action=="synchronize") { synchronizeFollowers(arguments.at(0).number(),arguments.at(1).number()); for (auto& follower:followers_) follower.direction=arguments.at(2).integer(); }
    else if (action=="updateMove") { for (int i=2;i>=0;--i) chaseCharacter(followers_[i],i ? followers_[i-1] : player_); }
    else if (action=="update" || action=="refresh") updateFollowers();
    else if (action=="jumpAll") { for (auto& follower:followers_) { follower.jumpPeak=player_.jumpPeak; follower.jumpCount=player_.jumpCount; follower.x=player_.x; follower.y=player_.y; } }
    else throw std::invalid_argument("follower operation is not bound: "+action);
    return Value::undefined();
  }
  if (method=="isLandOk" && object->id<=-5 && object->id>=-7) return vehicleLandingOk(-object->id-5,arguments.at(0).integer(),arguments.at(1).integer(),arguments.at(2).integer());
  if (method=="initialize") { character=Character{}; character.through=object->id<=-2; return Value::undefined(); }
  if (method=="update") { updateCharacter(character,false); return Value::undefined(); }

  if (method == "isDashing" && arguments.empty() && object->attached == &player_) return playerDashing_;
  if (method == "findDirectionTo" && arguments.size() == 2) return findDirectionTo(character, arguments[0].integer(), arguments[1].integer());
  if (method == "refresh" && arguments.empty() && object->attached == &player_) { updatePlayerGraphic(); return Value::undefined(); }
  if ((method == "screenX" || method == "screenY") && arguments.empty()) return characterScreenPosition(character)[method == "screenX" ? 0 : 1];
  if (method == "jump" && arguments.size() == 2) { jumpCharacter(character, arguments[0].integer(), arguments[1].integer()); return Value::undefined(); }
  if ((method == "setMoveRoute" || method == "forceMoveRoute") && arguments.size() == 1) {
    setCharacterRoute(character, arguments[0], method == "forceMoveRoute");
    return Value::undefined();
  }
  if (method == "moveStraight" && arguments.size() == 1) move(character, arguments[0].integer());
  else if (method == "setMovementSuccess" && arguments.size() == 1) character.movementSuccess = arguments[0].boolean();
  else if (method == "setPosition" && arguments.size() == 2) {
    character.x = static_cast<int>(std::floor(arguments[0].number() + .5));
    character.y = static_cast<int>(std::floor(arguments[1].number() + .5));
    character.realX = arguments[0].number(); character.realY = arguments[1].number();
  }
  else if (method == "locate" && arguments.size() == 2) {
    if (object->attached == &player_) locatePlayer(arguments[0].number(), arguments[1].number());
    else locateCharacter(character, arguments[0].number(), arguments[1].number());
  }
  else if (method == "setDirection" && arguments.size() == 1) {
    const int direction = arguments[0].integer();
    if (!character.directionFix && direction) character.direction = direction;
    character.stopCount = 0;
  } else throw std::invalid_argument("character operation is not bound: " + method);
  return Value::undefined();
}
void Session::setCharacterRoute(Character& character, const Value& route, bool forcing) {
  if (forcing && !character.routeForcing) {
    character.originalRoute = Value::Object{{"list", character.route}, {"repeat", character.routeRepeat}, {"skippable", character.routeSkippable}, {"wait", false}};
    character.originalRouteIndex = character.routeIndex;
  }
  character.route = route["list"].array(); character.routeIndex = 0; character.routeWait = 0;
  character.routeRepeat = route["repeat"].boolean(); character.routeSkippable = route["skippable"].boolean(); character.routeForcing = forcing;
}
void Session::setCameraTarget(std::shared_ptr<RuntimeCharacter> target, double speed) {
  if (!target) throw std::invalid_argument("camera target must be a native character");
  cameraTarget_ = std::move(target); cameraSpeed_ = speed && !std::isnan(speed) ? speed : 800;
  if (!savedCamera_) savedCamera_ = std::array{mapState_.lastDisplayX, mapState_.lastDisplayY};
}
std::array<double, 2> Session::characterScreenPosition(const Character& character) const {
  const double tw = tileWidth(), th = tileHeight();
  const double width = map()["width"].number(), height = map()["height"].number();
  const double visibleX = screenWidth_ / tw, visibleY = screenHeight_ / th;
  const double cameraX = savedCamera_ ? (*savedCamera_)[0] : width < visibleX ? (width - visibleX) / 2 : std::clamp(player_.realX - (visibleX - 1) / 2, 0.0, width - visibleX);
  const double cameraY = savedCamera_ ? (*savedCamera_)[1] : height < visibleY ? (height - visibleY) / 2 : std::clamp(player_.realY - (visibleY - 1) / 2, 0.0, height - visibleY);
  const double x = deltaMapX(character.realX, cameraX), y = deltaMapY(character.realY, cameraY);
  const bool object = character.tileId > 0 || ImageManager::isObjectCharacter(character.characterName);
  const double jump = character.jumpCount > 0 ? (character.jumpPeak * character.jumpPeak - std::pow(std::abs(character.jumpCount - character.jumpPeak), 2)) / 2 : 0;
  return {std::floor(x * tw + tw / 2 + .5), std::floor(y * th + th - (object ? 0 : 6) - jump + .5)};
}
}
