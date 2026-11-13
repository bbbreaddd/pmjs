#include "mv_engine.hpp"

#include <algorithm>
#include <cmath>

namespace pmjs::mv {

void Session::locateCharacter(Character& character, double x, double y) {
  character.x = roundMapX(Value(std::floor(x + 0.5)).integer());
  character.y = roundMapY(Value(std::floor(y + 0.5)).integer());
  character.realX = character.x;
  character.realY = character.y;
  if (character.walkAnime || character.stepAnime) character.pattern = 1;
  character.animationCount = 0;
  bool normalPriority = &character == &player_;
  for (const auto& event : events_) if (&event.character == &character) normalPriority = event.priority == 1;
  const bool bush = normalPriority && character.characterName.find('!') >= 2 && tileFlag(character.x, character.y, 64);
  if (!bush) character.bushDepth = 0;
  else if (!character.moving()) character.bushDepth = 12;
}

bool Session::characterEventCommand(const Value& entry, Interpreter& context) {
  const auto& p = entry["parameters"];
  switch (entry["code"].integer()) {
    case 203: {
      if (battle_.active) return true;
      auto* target = routeCharacter(p[0].integer(), context);
      if (!target) return true;
      const auto relocate = [&](Character& character, double x, double y) {
        locateCharacter(character, x, y);
        if (&character != &player_) return;
        const double visibleX = screenWidth_ / 48.0;
        const double visibleY = screenHeight_ / 48.0;
        savedCamera_ = std::array{std::clamp(x - (visibleX - 1) / 2, 0.0, std::max(0.0, map()["width"].number() - visibleX)),
          std::clamp(y - (visibleY - 1) / 2, 0.0, std::max(0.0, map()["height"].number() - visibleY))};
        const int encounterStep = map()["encounterStep"].integer(30);
        encounterCount_ = randomInt(encounterStep) + randomInt(encounterStep) + 1;
        for (auto& follower : followers_) {
          locateCharacter(follower, x, y);
          if (!follower.directionFix) follower.direction = player_.direction;
          follower.stopCount = 0;
        }
      };
      if (p[1].integer() == 0) relocate(*target, p[2].number(), p[3].number());
      else if (p[1].integer() == 1) relocate(*target, variable(p[2].integer()).number(), variable(p[3].integer()).number());
      else if (auto* other = routeCharacter(p[2].integer(), context)) {
        const int oldX = target->x, oldY = target->y;
        relocate(*target, other->x, other->y);
        relocate(*other, oldX, oldY);
      }
      if (p[4].integer() > 0) {
        if (!target->directionFix) target->direction = p[4].integer();
        target->stopCount = 0;
      }
      return true;
    }
    case 204:
      if (!battle_.active) {
        mapState_.scrollDirection = p[0].integer(); mapState_.scrollRest = p[1].number(); mapState_.scrollSpeed = p[2].integer();
        if (!savedCamera_) savedCamera_ = std::array{mapState_.lastDisplayX, mapState_.lastDisplayY};
      }
      return true;
    case 214:
      if (context.mapId == mapId_ && context.eventId > 0) {
        for (auto& event : events_) if (event.id == context.eventId) {
          event.erased = true; event.page = -1; event.trigger = 0; event.parallel = {};
          event.character.characterName.clear(); event.character.characterIndex = 0;
          event.character.tileId = 0; event.character.through = true;
        }
      }
      return true;
    case 217:
      if (!battle_.active) { followersGathering_ = true; context.waitingGather = true; }
      return true;
    case 216:
      followersVisible_ = p[0].integer() == 0;
      updatePlayerGraphic();
      return true;
    case 281: mapState_.nameDisplay = p[0].integer() == 0; return true;
    case 282:
      if (database_["tilesets"][p[0].integer()].null()) return true;
      mapState_.tilesetId = p[0].integer(); refreshNeeded_ = true;
      return true;
    case 283:
      mapState_.battleback1Name = p[0]; mapState_.battleback2Name = p[1];
      return true;
    case 284:
      mapState_.parallaxName = p[0].text();
      mapState_.parallaxZero = !mapState_.parallaxName.empty() && mapState_.parallaxName.front() == '!';
      if (mapState_.parallaxLoopX && !p[1].boolean()) mapState_.parallaxX = 0;
      if (mapState_.parallaxLoopY && !p[2].boolean()) mapState_.parallaxY = 0;
      mapState_.parallaxLoopX = p[1].boolean(); mapState_.parallaxLoopY = p[2].boolean();
      mapState_.parallaxSx = p[3].number(); mapState_.parallaxSy = p[4].number();
      return true;
    case 285: {
      const int x = p[2].integer() ? variable(p[3].integer()).integer() : p[3].integer();
      const int y = p[2].integer() ? variable(p[4].integer()).integer() : p[4].integer();
      const int width = map()["width"].integer(), height = map()["height"].integer();
      const bool valid = x >= 0 && y >= 0 && x < width && y < height;
      const auto tile = [&](int layer) { return valid ? map()["data"][(layer * height + y) * width + x].integer() : 0; };
      int value = 0;
      switch (p[1].integer()) {
        case 0:
          if (valid) for (int layer = 3; layer >= 0; --layer) {
            const int tag = database_["tilesets"][mapState_.tilesetId]["flags"][tile(layer)].integer() >> 12;
            if (tag > 0) { value = tag; break; }
          }
          break;
        case 1:
          for (const auto& event : events_) if (event.character.x == x && event.character.y == y) { value = event.id; break; }
          break;
        case 2: case 3: case 4: case 5: value = tile(p[1].integer() - 2); break;
        default: value = tile(5); break;
      }
      operateVariable(p[0].integer(), 0, value);
      return true;
    }
    default: return false;
  }
}

void Session::setupMapState() {
  const auto& data = map();
  mapState_ = {};
  mapState_.tilesetId = data["tilesetId"].integer();
  if (data["specifyBattleback"].boolean()) {
    mapState_.battleback1Name = data["battleback1Name"]; mapState_.battleback2Name = data["battleback2Name"];
  }
  mapState_.parallaxName = data["parallaxName"].text();
  mapState_.parallaxZero = !mapState_.parallaxName.empty() && mapState_.parallaxName.front() == '!';
  mapState_.parallaxLoopX = data["parallaxLoopX"].boolean(); mapState_.parallaxLoopY = data["parallaxLoopY"].boolean();
  mapState_.parallaxSx = data["parallaxSx"].number(); mapState_.parallaxSy = data["parallaxSy"].number();
  const double width = screenWidth_ / 48.0;
  const double height = screenHeight_ / 48.0;
  const double endX = data["width"].number() - width, endY = data["height"].number() - height;
  mapState_.lastDisplayX = loopHorizontal() ? std::fmod(std::fmod(player_.realX - (width - 1) / 2, data["width"].number()) + data["width"].number(), data["width"].number()) : endX < 0 ? endX / 2 : std::clamp(player_.realX - (width - 1) / 2, 0.0, endX);
  mapState_.lastDisplayY = loopVertical() ? std::fmod(std::fmod(player_.realY - (height - 1) / 2, data["height"].number()) + data["height"].number(), data["height"].number()) : endY < 0 ? endY / 2 : std::clamp(player_.realY - (height - 1) / 2, 0.0, endY);
  mapState_.parallaxX = mapState_.lastDisplayX; mapState_.parallaxY = mapState_.lastDisplayY;
  savedCamera_.reset();
}

void Session::updateMapState() {
  const double width = screenWidth_ / 48.0;
  const double height = screenHeight_ / 48.0;
  const double endX = map()["width"].number() - width, endY = map()["height"].number() - height;
  if (mapState_.scrollRest > 0) {
    if (!savedCamera_) savedCamera_ = std::array{mapState_.lastDisplayX, mapState_.lastDisplayY};
    const auto before = *savedCamera_;
    const double distance = std::pow(2.0, mapState_.scrollSpeed) / 256;
    switch (mapState_.scrollDirection) {
      case 2: if (loopVertical()) (*savedCamera_)[1] = std::fmod((*savedCamera_)[1] + distance, map()["height"].number()); else if (endY >= 0) (*savedCamera_)[1] = std::min((*savedCamera_)[1] + distance, endY); break;
      case 4: if (loopHorizontal()) (*savedCamera_)[0] = std::fmod((*savedCamera_)[0] - distance + map()["width"].number(), map()["width"].number()); else if (endX >= 0) (*savedCamera_)[0] = std::max((*savedCamera_)[0] - distance, 0.0); break;
      case 6: if (loopHorizontal()) (*savedCamera_)[0] = std::fmod((*savedCamera_)[0] + distance, map()["width"].number()); else if (endX >= 0) (*savedCamera_)[0] = std::min((*savedCamera_)[0] + distance, endX); break;
      case 8: if (loopVertical()) (*savedCamera_)[1] = std::fmod((*savedCamera_)[1] - distance + map()["height"].number(), map()["height"].number()); else if (endY >= 0) (*savedCamera_)[1] = std::max((*savedCamera_)[1] - distance, 0.0); break;
    }
    mapState_.scrollRest = *savedCamera_ == before ? 0 : mapState_.scrollRest - distance;
  }
  const double displayX = savedCamera_ ? (*savedCamera_)[0] : endX < 0 ? endX / 2 : std::clamp(player_.realX - (width - 1) / 2, 0.0, endX);
  const double displayY = savedCamera_ ? (*savedCamera_)[1] : endY < 0 ? endY / 2 : std::clamp(player_.realY - (height - 1) / 2, 0.0, endY);
  if (!loopHorizontal() || mapState_.parallaxLoopX) mapState_.parallaxX += deltaMapX(displayX, mapState_.lastDisplayX);
  if (!loopVertical() || mapState_.parallaxLoopY) mapState_.parallaxY += deltaMapY(displayY, mapState_.lastDisplayY);
  mapState_.lastDisplayX = displayX; mapState_.lastDisplayY = displayY;
  if (mapState_.parallaxLoopX) mapState_.parallaxX += mapState_.parallaxSx / 96;
  if (mapState_.parallaxLoopY) mapState_.parallaxY += mapState_.parallaxSy / 96;
}

void Session::updateSelfMovement(Event& event) {
  auto& character = event.character;
  if (event.prelockDirection != 0 || character.stopCount <= 30 * (5 - character.moveFrequency)) return;
  const double width = screenWidth_, height = screenHeight_;
  const double endX = map()["width"].number() - width / 48, endY = map()["height"].number() - height / 48;
  const double displayX = savedCamera_ ? (*savedCamera_)[0] : endX < 0 ? endX / 2 : std::clamp(player_.realX - (width / 48 - 1) / 2, 0.0, endX);
  const double displayY = savedCamera_ ? (*savedCamera_)[1] : endY < 0 ? endY / 2 : std::clamp(player_.realY - (height / 48 - 1) / 2, 0.0, endY);
  const double px = deltaMapX(character.realX, displayX) * 48 + 24 - width / 2;
  const double py = deltaMapY(character.realY, displayY) * 48 + 24 - height / 2;
  if (px < -width || px > width || py < -height || py > height) return;
  const auto moveRandom = [&] {
    const int direction = 2 + randomInt(4) * 2;
    if (passable(character.x, character.y, direction, character)) move(character, direction);
  };
  const auto moveTowardPlayer = [&] {
    const int sx = static_cast<int>(deltaMapX(character.x, player_.x)), sy = static_cast<int>(deltaMapY(character.y, player_.y));
    if (std::abs(sx) > std::abs(sy)) {
      if (!move(character, sx > 0 ? 4 : 6) && sy != 0) move(character, sy > 0 ? 8 : 2);
    } else if (sy != 0) {
      if (!move(character, sy > 0 ? 8 : 2) && sx != 0) move(character, sx > 0 ? 4 : 6);
    }
  };
  switch (event.moveType) {
    case 1:
      switch (randomInt(6)) {
        case 0: case 1: moveRandom(); break;
        case 2: case 3: case 4: move(character, character.direction); break;
        case 5: character.stopCount = 0; break;
      }
      break;
    case 2:
      if (std::abs(deltaMapX(character.x, player_.x)) + std::abs(deltaMapY(character.y, player_.y)) < 20) {
        switch (randomInt(6)) {
          case 0: case 1: case 2: case 3: moveTowardPlayer(); break;
          case 4: moveRandom(); break;
          case 5: move(character, character.direction); break;
        }
      } else moveRandom();
      break;
    case 3: updateRoute(character); break;
  }
}

}  // namespace pmjs::mv
