#include "mv_engine.hpp"
#include "mv_core_utils.hpp"
#include "mv_windows.hpp"
#include "mv_sprites.hpp"
#include <cmath>
#include <stdexcept>
#include <limits>

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
void Session::initializeRuntimeCharacter(const std::shared_ptr<RuntimeCharacter>& object, const std::string& method) {
  if (runtimeHooks_ && runtimeHooks_->characterLifecycle && runtimeHooks_->characterLifecycle(object, method)) return;
  runtimeCharacterCommand(object, "initMembers", {});
  if (object->id == -1) runtimeCharacterCommand(object, "initPlayerMembers", {});
}
std::shared_ptr<RuntimeCharacter> Session::runtimeFollower(int memberIndex) {
  if (memberIndex < 1 || memberIndex > std::numeric_limits<int>::max() - 4)
    throw std::invalid_argument("follower member index is outside the supported integer range");
  const auto count = static_cast<std::size_t>(memberIndex);
  while (followers_.size() < count) { followers_.emplace_back(); followers_.back().through = true; }
  return runtimeCharacter(memberIndex <= 3 ? -memberIndex - 1 : -memberIndex - 4);
}
std::shared_ptr<RuntimeCharacter> Session::runtimeCharacter(int id) {
  if (auto object = runtimeCharacters_[id].lock()) return object;
  Character* character = id == -1 ? &player_ : nullptr;
  if (id <= -5 && id >= -7) character=&vehicles_[static_cast<std::size_t>(-id-5)].character;
  if (id <= -2 && id >= -4) character=&followers_[static_cast<std::size_t>(-id-2)];
  if (id <= -8) { const auto index = static_cast<std::size_t>(-static_cast<long long>(id)-5); if (index < followers_.size()) character=&followers_[index]; }
  if (id > 0) for (auto& event : events_) if (event.id == id) { character = &event.character; break; }
  if (!character) { runtimeCharacters_.erase(id); return {}; }
  auto object = std::make_shared<RuntimeCharacter>(); object->id = id; object->mapId = mapId_; object->attached = character;
  if (id > 0) for (const auto& event : events_) if (event.id == id) { object->originalPattern = event.originalPattern; break; }
  runtimeCharacters_[id] = object; return object;
}
std::shared_ptr<RuntimeActor> Session::runtimeActor(int id) {
  if (id <= 0 || database_["actors"][id].null()) return {};
  if (auto object = runtimeActors_[id].lock()) return object;
  if (!actors_.contains(id)) initializeActor(id);
  // Initialization may publish this actor through a script lifecycle override.
  if (auto object = runtimeActors_[id].lock()) return object;
  auto object = std::make_shared<RuntimeActor>(); object->id = id; object->attached = &actors_.at(id);
  for (const auto& action : object->value().actions) { runtimeActions_[action->identity] = action; if (action->subject.expired() && !action->value.enemy && action->value.actorId == id) action->subject = object; }
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
    for (const auto& action : battler.actions) { runtimeActions_[action->identity] = action; if (action->subject.expired() && action->value.enemy && action->value.subject == index) action->subject = object; }
    runtimeEnemies_[index] = object; return object;
  }
  auto object = std::make_shared<RuntimeActor>(); object->id = battler.id; object->retained = std::make_unique<Battler>(battler); return object;
}
void Session::initializeActorSkills(const std::shared_ptr<RuntimeActor>& object) {
  auto& actor = object->value(); actor.skills.clear();
  for (const auto& learning : database_["classes"][actor.classId]["learnings"].array())
    if (learning["level"].integer() <= actor.level && !dispatchActorMethod(actor, "learnSkill", {learning["skillId"]}, object))
      actor.skills.insert(learning["skillId"].integer());
}
void Session::initializeActorMembers(const std::shared_ptr<RuntimeActor>& object) {
  const int id = object->id; object->value() = Battler{}; object->value().id = id;
}
std::shared_ptr<RuntimeCharacter> Session::runtimeCharacterFor(Character& character) {
  if (&character == &player_) return runtimeCharacter(-1);
  for (const auto& event : events_) if (&event.character == &character) return runtimeCharacter(event.id);
  for (std::size_t index = 0; index < vehicles_.size(); ++index) if (&vehicles_[index].character == &character) return runtimeCharacter(-5 - static_cast<int>(index));
  for (std::size_t index = 0; index < followers_.size(); ++index) if (&followers_[index] == &character) return runtimeFollower(index + 1);
  return nullptr;
}
Value Session::runtimeCharacterCommand(const std::shared_ptr<RuntimeCharacter>& object, const std::string& method, const Value::Array& arguments) {
  auto& character = object->value();
  if (method == "isMapPassable") return characterMapPassable(arguments.at(0).integer(), arguments.at(1).integer(), arguments.at(2).integer(), character);
  if (method == "isCollidedWithCharacters") return characterCollision(arguments.at(0).integer(), arguments.at(1).integer(), character);
  if (method == "isOnBush") return tileFlag(character.x, character.y, 64);
  if (method == "increaseSteps") { increaseCharacterSteps(character); return Value::undefined(); }
  if (method == "setImage") {
    character.characterName = arguments.at(0).text(); character.characterIndex = arguments.at(1).integer(); character.tileId = 0;
    return Value::undefined();
  }
  if (method == "updateStop") { updateCharacterStop(character); return Value::undefined(); }
  if (method == "updateMove") { updateCharacterMove(character, &character == &player_ && playerDashing_); return Value::undefined(); }
  if (method == "updateRoutineMove") { updateRoute(character); return Value::undefined(); }
  if (method == "makeEncounterTroopId") return makeEncounterTroopId();
  if (method == "makeEncounterCount") { const int step = map()["encounterStep"].integer(); encounterCount_ = std::floor(random() * step) + std::floor(random() * step) + 1; return Value::undefined(); }
  if (method == "updateNonmoving") { updatePlayerNonmoving(arguments.at(0).boolean(), false); return Value::undefined(); }
  if (method == "loadSystemSettings" && object->id >= -7 && object->id <= -5) {
    auto& vehicle = vehicles_[-object->id - 5];
    const auto& data = database_["system"][object->id == -5 ? "boat" : object->id == -6 ? "ship" : "airship"];
    vehicle.mapId = data["startMapId"].integer();
    locateCharacter(character, data["startX"].number(), data["startY"].number());
    character.characterName = data["characterName"].text(); character.characterIndex = data["characterIndex"].integer();
    return Value::undefined();
  }
  if (method.starts_with("event.") || method == "isStarting" || method == "lock" || method == "unlock" || method == "start" || method == "setupPageSettings" || method == "updateParallel" || method == "checkEventTriggerAuto") {
    for (auto& event : events_) if (&event.character == &character) {
      if (method == "event.trigger") { if (!arguments.empty()) event.trigger = arguments[0].integer(); return event.trigger; }
      if (method == "event.starting") { if (!arguments.empty()) event.starting = arguments[0].boolean(); return event.starting; }
      if (method == "event.locked") { if (!arguments.empty()) event.locked = arguments[0].boolean(); return event.locked; }
      if (method == "event.prelockDirection") { if (!arguments.empty()) event.prelockDirection = arguments[0].integer(); return event.prelockDirection; }
      if (method == "isStarting") return event.starting;
      if (method == "setupPageSettings") setupEventPageSettings(event);
      if (method == "unlock" && event.locked) { event.locked = false; if (!character.directionFix && event.prelockDirection) character.direction = event.prelockDirection; }
      if (method == "lock" && !event.locked) {
        event.prelockDirection = character.direction;
        if (!character.directionFix) {
          const auto x = deltaMapX(player_.x, character.x), y = deltaMapY(player_.y, character.y);
          if (std::abs(x) > std::abs(y)) character.direction = x > 0 ? 6 : 4;
          else if (y) character.direction = y > 0 ? 2 : 8;
        }
        event.locked = true;
      }
      if (method == "start" && event.page >= 0 && map()["events"][event.id]["pages"][event.page]["list"].arrayLength() > 1) {
        event.starting = true;
        if (event.trigger <= 2 && (!runtimeHooks_ || !runtimeHooks_->characterLifecycle || !runtimeHooks_->characterLifecycle(object, "lock"))) runtimeCharacterCommand(object, "lock", {});
      }
      if (method == "checkEventTriggerAuto" && event.trigger == 3 && (!runtimeHooks_ || !runtimeHooks_->characterLifecycle || !runtimeHooks_->characterLifecycle(object, "start"))) runtimeCharacterCommand(object, "start", {});
      if (method == "updateParallel" && event.page >= 0 && event.trigger == 4) {
        if (!event.parallel.running) setupInterpreter(event.parallel, map()["events"][event.id]["pages"][event.page]["list"].array(), event.id);
        advanceInterpreter(event.parallel);
      }
      return Value::undefined();
    }
    throw std::runtime_error("event is no longer attached to the current map");
  }
  if (method == "initEventMembers") {
    for (auto& event : events_) if (&event.character == &character) {
      const int id = event.id; event = Event{}; event.id = id; object->originalPattern = event.originalPattern;
      return Value::undefined();
    }
    throw std::runtime_error("event is no longer attached to the current map");
  }
  if (method == "needsMapReload") { if (!arguments.empty()) playerNeedsMapReload_ = arguments[0].boolean(); return playerNeedsMapReload_; }
  if (method == "originalPattern") {
    if (!arguments.empty()) object->originalPattern = arguments[0].integer();
    if (object->attached) for (auto& event : events_) if (&event.character == &character) {
      if (!arguments.empty()) event.originalPattern = object->originalPattern;
      object->originalPattern = event.originalPattern; break;
    }
    return object->originalPattern;
  }
  if (method == "processMoveCommand") { processRouteCommand(character, arguments.at(0)); return Value::undefined(); }
  if (method == "isMoveRouteForcing") return character.routeForcing;
  if (method == "isNormalPriority") {
    for (const auto& event : events_) if (&event.character == &character) return event.priority == 1;
    return true;
  }
  if (method == "requestAnimation" || method == "requestBalloon") {
    if (object->attached && (object->id < 0 || object->mapId == mapId_)) requestAnimation(0, object->id, arguments.at(0).integer(), false, method == "requestBalloon");
    return Value::undefined();
  }
  if (method == "vehicleType") {
    if (!arguments.empty()) { const int type = arguments[0].integer(); if (type < -1 || type > 2) throw std::invalid_argument("invalid vehicle type"); vehicleType_ = type; }
    return vehicleType_;
  }
  if (method == "vehicleGettingOn") { if (!arguments.empty()) vehicleGettingOn_ = arguments[0].boolean(); return vehicleGettingOn_; }
  if (method == "vehicleGettingOff") { if (!arguments.empty()) vehicleGettingOff_ = arguments[0].boolean(); return vehicleGettingOff_; }
  if (method == "getOnVehicle") return &character == &player_ && vehicleType_ < 0 && toggleVehicle();
  if (method == "getOffVehicle") return &character == &player_ && vehicleType_ >= 0 && toggleVehicle();
  if (method == "vehicleCanMove" && object->id <= -5 && object->id >= -7) return object->id != -7 || vehicles_[2].altitude >= 48;
  if (method == "setupPage" || method == "updateSelfMovement") {
    for (auto& event : events_) if (&event.character == &character) {
      if (method == "setupPage") setupEventPage(event); else updateSelfMovement(event);
      return Value::undefined();
    }
    throw std::runtime_error("event is no longer attached to the current map");
  }
  if (method == "pageIndex") {
    if (object->id <= 0 || !object->attached || object->mapId != mapId_)
      throw std::runtime_error("event is no longer attached to the current map");
    const auto found = std::find_if(events_.begin(), events_.end(), [&](const Event& event) { return event.id == object->id && &event.character == object->attached; });
    if (found == events_.end()) throw std::runtime_error("event is no longer attached to the current map");
    if (!arguments.empty()) {
      const double index = arguments[0].number(-3);
      const auto count = map()["events"][object->id]["pages"].arrayLength();
      if (!std::isfinite(index) || index != std::floor(index) || index < -2 || index >= static_cast<double>(count))
        throw std::invalid_argument("event page index is outside its page range");
      found->page = static_cast<int>(index);
    }
    return found->page;
  }
  if (method.starts_with("followers.")) {
    const auto action=method.substr(10);
    if (action=="visible") { if (!arguments.empty()) followersVisible_=arguments[0].boolean(); return followersVisible_; }
    if (action=="gather") { followersGathering_=true; return Value::undefined(); }
    if (action=="isGathering") return followersGathering_;
    if (action=="isMoving") return std::any_of(followers_.begin(),followers_.end(),[](const auto& follower) { return follower.moving(); });
    if (action=="isGathered") return std::all_of(followers_.begin(),followers_.end(),[&](const auto& follower) { return !follower.moving() && follower.x==player_.x && follower.y==player_.y; });
    if (action=="synchronize") { synchronizeFollowers(arguments.at(0).number(),arguments.at(1).number()); for (auto& follower:followers_) follower.direction=arguments.at(2).integer(); }
    else if (action=="updateMove") { for (int i=static_cast<int>(followers_.size())-1;i>=0;--i) chaseCharacter(followers_[i],i ? followers_[i-1] : player_); }
    else if (action=="update" || action=="refresh") updateFollowers();
    else if (action=="jumpAll") { for (auto& follower:followers_) { follower.jumpPeak=player_.jumpPeak; follower.jumpCount=player_.jumpCount; follower.x=player_.x; follower.y=player_.y; } }
    else throw std::invalid_argument("follower operation is not bound: "+action);
    return Value::undefined();
  }
  if (method=="isLandOk" && object->id<=-5 && object->id>=-7) return vehicleLandingOk(-object->id-5,arguments.at(0).integer(),arguments.at(1).integer(),arguments.at(2).integer());
  if (method=="initMembers") { character = Character{}; return Value::undefined(); }
  if (method=="initPlayerMembers" && object->id == -1) {
    vehicleType_ = -1; vehicleGettingOn_ = false; vehicleGettingOff_ = false;
    playerDashing_ = false; playerNeedsMapReload_ = false; encounterCount_ = 0; pendingTransfer_.reset(); playerFadeType_ = 0;
    transferFadeStarted_ = false;
    return Value::undefined();
  }
  if (method=="initialize") { character=Character{}; character.through=object->id<=-2; return Value::undefined(); }
  if (method=="update") { updateCharacter(character,false); return Value::undefined(); }
  if (method=="straighten") {
    if (character.walkAnime || character.stepAnime) character.pattern=1;
    character.animationCount=0; return Value::undefined();
  }

  if (method == "isDashing" && arguments.empty() && object->attached == &player_) return playerDashing_;
  if (method == "findDirectionTo" && arguments.size() == 2) return findDirectionTo(character, arguments[0].integer(), arguments[1].integer());
  if (method == "refresh" && arguments.empty() && object->attached == &player_) { updatePlayerGraphic(); return Value::undefined(); }
  if (method == "isObjectCharacter") return character.tileId > 0 || ImageManager::isObjectCharacter(character.characterName);
  if (method == "jumpHeight") return (character.jumpPeak * character.jumpPeak - std::pow(std::abs(character.jumpCount - character.jumpPeak), 2)) / 2;
  if (method == "screenZ") {
    int priority = 1;
    for (const auto& event : events_) if (&event.character == &character) { priority = event.priority; break; }
    return priority * 2 + 1;
  }
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
std::array<double, 2> Session::runtimeMapAdjustedPosition(double x, double y) const {
  const double tw = tileWidth(), th = tileHeight();
  const double width = map()["width"].number(), height = map()["height"].number();
  const double visibleX = screenWidth_ / tw, visibleY = screenHeight_ / th;
  const double cameraX = savedCamera_ ? (*savedCamera_)[0] : width < visibleX ? (width - visibleX) / 2 : std::clamp(player_.realX - (visibleX - 1) / 2, 0.0, width - visibleX);
  const double cameraY = savedCamera_ ? (*savedCamera_)[1] : height < visibleY ? (height - visibleY) / 2 : std::clamp(player_.realY - (visibleY - 1) / 2, 0.0, height - visibleY);
  return {loopHorizontal() && x < cameraX - (width - visibleX) / 2 ? x - cameraX + width : x - cameraX,
    loopVertical() && y < cameraY - (height - visibleY) / 2 ? y - cameraY + height : y - cameraY};
}
std::array<double, 3> Session::runtimeMapShadow() const {
  const auto& airship = vehicles_[2];
  if (airship.mapId != mapId_ || airship.altitude <= 0) return {0, 0, 0};
  const double tw = tileWidth(), th = tileHeight();
  const auto scrolled = runtimeMapAdjustedPosition(airship.character.realX, airship.character.realY);
  const double x = scrolled[0], y = scrolled[1];
  const bool object = airship.character.characterName.find('!') < 2;
  return {std::floor(x * tw + tw / 2 + .5), std::floor(y * th + th - (object ? 0 : 6) + .5),
    255.0 * std::clamp(airship.altitude / 48.0F, 0.0F, 1.0F)};
}
std::array<double, 2> Session::runtimeCharacterScreenPosition(const std::shared_ptr<RuntimeCharacter>& character) const {
  if (runtimeHooks_ && runtimeHooks_->characterPosition)
    if (const auto point = runtimeHooks_->characterPosition(character)) return *point;
  const auto point = characterScreenPosition(character->value());
  return {point[0] + character->value().spriteOffsetX, point[1] + character->value().spriteOffsetY};
}
std::array<double, 2> Session::characterScreenPosition(const Character& character) const {
  const double tw = tileWidth(), th = tileHeight();
  const auto scrolled = runtimeMapAdjustedPosition(character.realX, character.realY);
  const double x = scrolled[0], y = scrolled[1];
  const bool object = character.tileId > 0 || ImageManager::isObjectCharacter(character.characterName);
  const double jump = character.jumpCount > 0 ? (character.jumpPeak * character.jumpPeak - std::pow(std::abs(character.jumpCount - character.jumpPeak), 2)) / 2 : 0;
  return {std::floor(x * tw + tw / 2 + .5), std::floor(y * th + th - (object ? 0 : 6) - jump + .5)};
}
}
