#include "mv_engine.hpp"
#include "mv_core_utils.hpp"
#include "mv_map_extra.hpp"

#include <algorithm>
#include <cmath>

namespace pmjs::mv {
namespace {
int dirX(int direction) { return direction == 6 ? 1 : direction == 4 ? -1 : 0; }
int dirY(int direction) { return direction == 2 ? 1 : direction == 8 ? -1 : 0; }
const char* vehicleName(int type) { return type == 0 ? "boat" : type == 1 ? "ship" : "airship"; }
}

void Session::setupVehicles() {
  vehicleType_ = -1; vehicleGettingOn_ = false; vehicleGettingOff_ = false;
  vehicleWalkingBgm_ = {}; vehicleWalkSpeed_ = 4;
  for (int type = 0; type < 3; ++type) {
    auto& vehicle = vehicles_[type]; vehicle = {}; vehicle.type = type;
    const auto& source = database_["system"][vehicleName(type)];
    vehicle.mapId = source["startMapId"].integer();
    vehicle.character.x = source["startX"].integer(); vehicle.character.y = source["startY"].integer();
    vehicle.character.realX = vehicle.character.x; vehicle.character.realY = vehicle.character.y;
    vehicle.character.characterName = source["characterName"].text(); vehicle.character.characterIndex = source["characterIndex"].integer();
    vehicle.character.direction = 4; vehicle.character.moveSpeed = type == 0 ? 4 : type == 1 ? 5 : 6;
    vehicle.character.walkAnime = false; vehicle.character.stepAnime = false; vehicle.bgm = source["bgm"];
  }
}

bool Session::vehicleLandingOk(int type) const {
  if (type == 2) {
    if (!MapMechanics::isAirshipLandOk(*this, player_.x, player_.y)) return false;
    return std::none_of(events_.begin(), events_.end(), [&](const Event& event) { return event.character.x == player_.x && event.character.y == player_.y; });
  }
  const int x = roundMapX(player_.x + dirX(player_.direction)), y = roundMapY(player_.y + dirY(player_.direction));
  if (x < 0 || y < 0 || x >= map()["width"].integer() || y >= map()["height"].integer()) return false;
  const int reverseBit = 1 << ((10 - player_.direction) / 2 - 1);
  if (!tilePassage(x, y, reverseBit)) return false;
  for (const auto& event : events_) if (event.priority == 1 && !event.character.through && event.character.x == x && event.character.y == y) return false;
  for (int index = 0; index < 2; ++index) if (!vehicles_[index].character.through && vehicles_[index].mapId == mapId_ && vehicles_[index].character.x == x && vehicles_[index].character.y == y) return false;
  return true;
}

bool Session::toggleVehicle() {
  if (battle_.active || vehicleGettingOn_ || vehicleGettingOff_ || followersGathering_) return false;
  if (vehicleType_ >= 0) {
    if (!vehicleLandingOk(vehicleType_)) return false;
    auto& vehicle = vehicles_[vehicleType_];
    if (vehicleType_ == 2) {
      if (!player_.directionFix) player_.direction = 2;
      player_.stopCount = 0;
    }
    synchronizeFollowers(player_.x, player_.y); vehicle.driving = false; vehicle.character.walkAnime = false; vehicle.character.stepAnime = false;
    if (!vehicle.character.directionFix) vehicle.character.direction = 4;
    vehicle.character.stopCount = 0;
    if (vehicleType_ != 2) {
      player_.through = true;
      move(player_, player_.direction); player_.through = false; player_.transparent = false;
    }
    vehicleGettingOff_ = true; player_.moveSpeed = 4; player_.through = false;
    encounterCount_ = randomInt(map()["encounterStep"].integer(30)) + randomInt(map()["encounterStep"].integer(30)) + 1;
    followersGathering_ = true;
    if (!vehicleWalkingBgm_.null()) AudioManager::playBgm(*this, vehicleWalkingBgm_);
    return true;
  }
  const int x = roundMapX(player_.x + dirX(player_.direction)), y = roundMapY(player_.y + dirY(player_.direction));
  if (vehicles_[2].mapId == mapId_ && vehicles_[2].character.x == player_.x && vehicles_[2].character.y == player_.y) vehicleType_ = 2;
  else for (int index : {1, 0}) if (vehicles_[index].mapId == mapId_ && vehicles_[index].character.x == x && vehicles_[index].character.y == y) { vehicleType_ = index; break; }
  if (vehicleType_ < 0) return false;
  vehicleWalkSpeed_ = player_.moveSpeed;
  vehicleGettingOn_ = true;
  if (vehicleType_ != 2) {
    player_.through = true;
    move(player_, player_.direction); player_.through = false;
  }
  followersGathering_ = true;
  return true;
}

void Session::updateMapVehicles() {
  for (auto& vehicle : vehicles_) {
    updateCharacter(vehicle.character, false);
    if (vehicle.type == 2) {
      vehicle.altitude = std::clamp(vehicle.altitude + (vehicle.driving ? 1 : -1), 0, 48);
      vehicle.character.stepAnime = vehicle.altitude >= 48; vehicle.character.spriteOffsetY = -vehicle.altitude;
    }
    vehicle.character.transparent = vehicle.mapId != mapId_;
  }
}

void Session::updateVehicles() {
  if (vehicleType_ < 0 || followersGathering_) return;
  auto& vehicle = vehicles_[vehicleType_];
  if (vehicleGettingOn_) {
    if (player_.moving()) return;
    if (!player_.directionFix) player_.direction = vehicle.character.direction;
    player_.stopCount = 0;
    player_.moveSpeed = vehicle.character.moveSpeed; player_.transparent = true; player_.through = vehicleType_ == 2;
    vehicleWalkingBgm_ = AudioManager::saveBgm(*this);
    vehicle.driving = true; vehicle.character.walkAnime = true; vehicle.character.stepAnime = true;
    vehicleGettingOn_ = false;
    const auto& bgm = system_.vehicleBgm[vehicleType_].null() ? vehicle.bgm : system_.vehicleBgm[vehicleType_];
    AudioManager::playBgm(*this, bgm);
  } else if (vehicleGettingOff_) {
    if (vehicle.altitude <= 0) {
      vehicleGettingOff_ = false; vehicleType_ = -1; player_.transparent = false;
    }
  } else {
    vehicle.character.x = player_.x; vehicle.character.y = player_.y;
    vehicle.character.realX = player_.realX; vehicle.character.realY = player_.realY; vehicle.character.direction = player_.direction;
    const bool bush = vehicle.type != 2 && vehicle.character.jumpCount <= 0 &&
      vehicle.character.characterName.find('!') >= 2 && tileFlag(vehicle.character.x, vehicle.character.y, 64);
    if (!bush) vehicle.character.bushDepth = 0;
    else if (!vehicle.character.moving()) vehicle.character.bushDepth = 12;
  }
}

bool Session::vehicleEventCommand(const EventCommand& entry, Interpreter& context) {
  (void)context;
  const auto& p = entry.parameters;
  switch (entry.code) {
    case 202: {
      const int index = p[0].integer();
      if (index < 0 || index >= 3) return true;
      auto& vehicle = vehicles_[index];
      const bool indirect = p[1].integer() != 0;
      vehicle.mapId = indirect ? variable(p[2].integer()).integer() : p[2].integer();
      const double x = indirect ? variable(p[3].integer()).number() : p[3].number();
      const double y = indirect ? variable(p[4].integer()).number() : p[4].number();
      vehicle.character.x = Value(std::floor(x + 0.5)).integer();
      vehicle.character.y = Value(std::floor(y + 0.5)).integer();
      vehicle.character.realX = x; vehicle.character.realY = y;
      if (vehicle.driving) {
        vehicle.mapId = mapId_; vehicle.character.x = player_.x; vehicle.character.y = player_.y;
        vehicle.character.realX = player_.realX; vehicle.character.realY = player_.realY; vehicle.character.direction = player_.direction;
      } else if (vehicle.mapId == mapId_) {
        if (vehicle.character.walkAnime || vehicle.character.stepAnime) vehicle.character.pattern = 1;
        vehicle.character.animationCount = 0;
      }
      return true;
    }
    case 206: toggleVehicle(); return true;
    case 323: {
      const int index = p[0].integer();
      if (index >= 0 && index < 3) { vehicles_[index].character.characterName = p[1].text(); vehicles_[index].character.characterIndex = p[2].integer(); }
      return true;
    }
    default: return false;
  }
}

}  // namespace pmjs::mv
