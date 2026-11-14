#include "mv_engine.hpp"
#include "mv_core_utils.hpp"
#include "mv_windows.hpp"
#include "mv_sprites.hpp"
#include <cmath>
#include <stdexcept>

namespace pmjs::mv {
Session::~Session() { detachRuntimeEntities(true); }
void Session::detachRuntimeEntities(bool all) {
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
  if (method == "isDashing" && arguments.empty() && object->attached == &player_) return playerDashing_;
  if (method == "findDirectionTo" && arguments.size() == 2) return findDirectionTo(character, arguments[0].integer(), arguments[1].integer());
  if (method == "refresh" && arguments.empty() && object->attached == &player_) { updatePlayerGraphic(); return Value::undefined(); }
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
