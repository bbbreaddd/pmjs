#include "mv_map_extra.hpp"

#include <algorithm>
#include <cmath>
#include <unordered_map>
#include <vector>

namespace pmjs::mv {

namespace {
int getTileId(const Session& session, int x, int y, int z) {
  const auto& map = session.map();
  const int width = map["width"].integer();
  const int height = map["height"].integer();
  if (session.map()["scrollType"].integer() == 2 || session.map()["scrollType"].integer() == 3) x = (x % width + width) % width;
  if (session.map()["scrollType"].integer() == 1 || session.map()["scrollType"].integer() == 3) y = (y % height + height) % height;
  if (x < 0 || y < 0 || x >= width || y >= height) return 0;
  return map["data"][(z * height + y) * width + x].integer();
}
}  // namespace

int MapMechanics::tileId(const Session& session, int x, int y, int z) {
  return getTileId(session, x, y, z);
}

std::vector<int> MapMechanics::layeredTiles(const Session& session, int x, int y) {
  std::vector<int> tiles;
  tiles.reserve(4);
  for (int i = 0; i < 4; ++i) {
    tiles.push_back(getTileId(session, x, y, 3 - i));
  }
  return tiles;
}

int MapMechanics::autotileType(const Session& session, int x, int y, int z) {
  const int tid = getTileId(session, x, y, z);
  return tid >= 2048 ? (tid - 2048) / 48 : -1;
}

bool MapMechanics::isPassable(const Session& session, int x, int y, int d) {
  return session.tilePassage(x, y, (1 << (d / 2 - 1)) & 0x0f);
}

std::vector<int> MapMechanics::eventsXy(const Session& session, int x, int y) {
  std::vector<int> out;
  for (const auto& ev : session.events()) {
    if (ev.character.x == x && ev.character.y == y) {
      out.push_back(ev.id);
    }
  }
  return out;
}

std::vector<int> MapMechanics::eventsXyNt(const Session& session, int x, int y) {
  std::vector<int> out;
  for (const auto& ev : session.events()) {
    if (!ev.erased && !ev.character.through && ev.character.x == x && ev.character.y == y) {
      out.push_back(ev.id);
    }
  }
  return out;
}

bool MapMechanics::isBoatPassable(const Session& session, int x, int y) {
  return session.tilePassage(x, y, 0x0200);
}

bool MapMechanics::isShipPassable(const Session& session, int x, int y) {
  return session.tilePassage(x, y, 0x0400);
}

bool MapMechanics::isAirshipLandOk(const Session& session, int x, int y) {
  return session.tilePassage(x, y, 0x0800) && session.tilePassage(x, y, 0x0f);
}

bool MapMechanics::isDamageFloor(const Session& session, int x, int y) {
  // Tile flag 0x0100 indicates damage floor
  return session.tileFlag(x, y, 0x0100);
}

bool MapMechanics::isLadder(const Session& session, int x, int y) {
  return session.tileFlag(x, y, 0x0020);
}

bool MapMechanics::isBush(const Session& session, int x, int y) {
  return session.tileFlag(x, y, 0x0040);
}

bool MapMechanics::isCounter(const Session& session, int x, int y) {
  return session.tileFlag(x, y, 0x0080);
}

bool MapMechanics::checkLayeredTilesFlags(const Session& session, int x, int y, int bit) {
  return session.tileFlag(x, y, bit);
}

int MapMechanics::terrainTag(const Session& session, int x, int y) {
  if (x < 0 || y < 0 || x >= session.map()["width"].integer() || y >= session.map()["height"].integer()) return 0;
  const auto& flags = session.database()["tilesets"][session.mapState_.tilesetId]["flags"];
  for (int z = 3; z >= 0; --z) {
    const int tileId = getTileId(session, x, y, z);
    if (tileId >= 0 && tileId < static_cast<int>(flags.array().size())) {
      const int tag = flags[tileId].integer() >> 12;
      if (tag > 0) return tag;
    }
  }
  return 0;
}

int MapMechanics::regionId(const Session& session, int x, int y) {
  if (x < 0 || y < 0 || x >= session.map()["width"].integer() || y >= session.map()["height"].integer()) return 0;
  // Region layer is layer 5 in map data
  return getTileId(session, x, y, 5);
}

int MapMechanics::eventIdAt(const Session& session, int x, int y) {
  for (const auto& ev : session.events()) {
    if (ev.character.x == x && ev.character.y == y) return ev.id;
  }
  return 0;
}

bool Session::loopHorizontal() const { return map()["scrollType"].integer() == 2 || map()["scrollType"].integer() == 3; }
bool Session::loopVertical() const { return map()["scrollType"].integer() == 1 || map()["scrollType"].integer() == 3; }
int Session::roundMapX(int x) const {
  const int width = map()["width"].integer();
  return loopHorizontal() ? (x % width + width) % width : x;
}
int Session::roundMapY(int y) const {
  const int height = map()["height"].integer();
  return loopVertical() ? (y % height + height) % height : y;
}
double Session::deltaMapX(double x1, double x2) const {
  double delta = x1 - x2; const double width = map()["width"].number();
  if (loopHorizontal() && std::abs(delta) > width / 2) delta += delta < 0 ? width : -width;
  return delta;
}
double Session::deltaMapY(double y1, double y2) const {
  double delta = y1 - y2; const double height = map()["height"].number();
  if (loopVertical() && std::abs(delta) > height / 2) delta += delta < 0 ? height : -height;
  return delta;
}
void Session::chaseCharacter(Character& follower, const Character& leader) {
  const int sx = static_cast<int>(deltaMapX(leader.x, follower.x));
  const int sy = static_cast<int>(deltaMapY(leader.y, follower.y));
  if (sx && sy) {
    const int horizontal = sx > 0 ? 6 : 4, vertical = sy > 0 ? 2 : 8;
    follower.x = roundMapX(follower.x + (sx > 0 ? 1 : -1));
    follower.y = roundMapY(follower.y + (sy > 0 ? 1 : -1));
    follower.realX = follower.x - (sx > 0 ? 1 : -1);
    follower.realY = follower.y - (sy > 0 ? 1 : -1);
    if (!follower.directionFix) {
      if (follower.direction == 10 - horizontal) follower.direction = horizontal;
      if (follower.direction == 10 - vertical) follower.direction = vertical;
    }
    follower.stopCount = 0;
  } else if (sx || sy) move(follower, sy ? sy > 0 ? 2 : 8 : sx > 0 ? 6 : 4);
  follower.moveSpeed = player_.moveSpeed + (playerDashing_ ? 1 : 0);
}
void Session::synchronizeFollowers() {
  for (auto& follower : followers_) {
    locateCharacter(follower, player_.realX, player_.realY);
    if (!follower.directionFix) follower.direction = player_.direction;
    follower.stopCount = 0;
  }
}
void Session::updateFollowers() {
  std::vector<int> battleMembers;
  battleMembers.reserve(4);
  for (std::size_t index = 0; index < party_.size() && index < 4; ++index) {
    if (!actors_.at(party_[index]).hidden) battleMembers.push_back(party_[index]);
  }
  const std::size_t visibleCount = followersVisible_ ? std::min(followers_.size(), battleMembers.empty() ? std::size_t(0) : battleMembers.size() - 1) : 0;
  if (followersGathering_) {
    bool moving = false;
    for (std::size_t index = 0; index < visibleCount; ++index) moving = moving || followers_[index].moving();
    if (!moving) for (int index = static_cast<int>(followers_.size()) - 1; index >= 0; --index)
      chaseCharacter(followers_[index], index == 0 ? player_ : followers_[index - 1]);
    bool gathered = true;
    for (std::size_t index = 0; index < visibleCount; ++index)
      gathered = gathered && !followers_[index].moving() && followers_[index].x == player_.x && followers_[index].y == player_.y;
    if (gathered) followersGathering_ = false;
  }
  for (std::size_t index = 0; index < followers_.size(); ++index) {
    auto& follower = followers_[index]; follower.moveSpeed = player_.moveSpeed + (playerDashing_ ? 1 : 0);
    follower.transparent = player_.transparent || index >= visibleCount;
    follower.opacity = player_.opacity; follower.blendMode = player_.blendMode;
    follower.walkAnime = player_.walkAnime; follower.stepAnime = player_.stepAnime; follower.directionFix = player_.directionFix;
    if (index + 1 < battleMembers.size()) {
      const auto& actor = actors_.at(battleMembers[index + 1]); follower.characterName = actor.characterName; follower.characterIndex = actor.characterIndex;
    } else { follower.characterName.clear(); follower.characterIndex = 0; }
    updateCharacter(follower, false);
  }
}
void Session::checkEventTouch(Event& event, int x, int y) {
  if (interpreter_.running || event.page < 0 || event.trigger != 2 || event.priority != 1 || event.character.jumpCount > 0) return;
  if (player_.x != x || player_.y != y || map()["events"][event.id]["pages"][event.page]["list"].array().size() <= 1) return;
  if (!event.prelockDirection) {
    event.prelockDirection = event.character.direction;
    const int sx = static_cast<int>(deltaMapX(player_.x, event.character.x)), sy = static_cast<int>(deltaMapY(player_.y, event.character.y));
    if (!event.character.directionFix) {
      if (std::abs(sx) > std::abs(sy)) event.character.direction = sx > 0 ? 6 : 4;
      else if (sy) event.character.direction = sy > 0 ? 2 : 8;
    }
  }
  event.starting = true;
}

int MapMechanics::canvasToMapX(const Session& session, double x) {
  const int tileWidth = 48;
  const int originX = static_cast<int>(std::floor((session.mapState_.lastDisplayX * tileWidth + x) / tileWidth));
  return session.roundMapX(originX);
}

int MapMechanics::canvasToMapY(const Session& session, double y) {
  const int tileHeight = 48;
  const int originY = static_cast<int>(std::floor((session.mapState_.lastDisplayY * tileHeight + y) / tileHeight));
  return session.roundMapY(originY);
}

bool MapMechanics::isTileA1(int tileId) { return tileId >= 2048 && tileId < 2816; }
bool MapMechanics::isTileA2(int tileId) { return tileId >= 2816 && tileId < 4352; }
bool MapMechanics::isTileA3(int tileId) { return tileId >= 4352 && tileId < 5888; }
bool MapMechanics::isTileA4(int tileId) { return tileId >= 5888 && tileId < 8192; }
bool MapMechanics::isTileA5(int tileId) { return tileId >= 1536 && tileId < 1792; }

bool MapMechanics::isWaterTile(int tileId) {
  if (isTileA1(tileId)) {
    return !(tileId >= 2048 + 96 && tileId < 2048 + 192);
  }
  return false;
}

bool MapMechanics::isWaterfallTile(int tileId) {
  if (tileId >= 2048 + 192 && tileId < 2816) {
    return getAutotileKind(tileId) % 2 == 1;
  }
  return false;
}

bool MapMechanics::isShadowingTile(int tileId) {
  return isTileA3(tileId) || isTileA4(tileId);
}

int MapMechanics::getAutotileKind(int tileId) {
  return (tileId - 2048) / 48;
}

int MapMechanics::getAutotileShape(int tileId) {
  return (tileId - 2048) % 48;
}

void Session::performMapDamage() {
  if (!tileFlag(player_.x, player_.y, 256)) return;
  const bool optFloorDeath = database_["system"]["optFloorDeath"].boolean();
  for (int id : party_) {
    auto it = actors_.find(id);
    if (it == actors_.end()) continue;
    auto& actor = it->second;
    if (actor.hp > 0) {
      const double fdr = trait(actor, 23, 8, true);
      const int maxDamage = std::max(0, actor.hp - (optFloorDeath ? 0 : 1));
      const int damage = std::min(static_cast<int>(std::floor(10.0 * fdr)), maxDamage);
      if (damage > 0) {
        actor.hp -= damage;
        refreshBattler(actor);
      }
    }
  }
}

int Session::findDirectionTo(const Character& c, int goalX, int goalY) const {
  const int searchLimit = 12;
  const int mapWidth = map()["width"].integer();
  if (mapWidth <= 0) return 0;
  if (c.x == goalX && c.y == goalY) return 0;

  struct Node {
    int parent = -1;
    int x = 0;
    int y = 0;
    int g = 0;
    int f = 0;
  };

  auto key = [mapWidth](int x, int y) { return y * mapWidth + x; };

  std::vector<Node> nodes;
  std::vector<int> openList;
  std::unordered_map<int, int> nodeMap;

  Node start;
  start.x = c.x;
  start.y = c.y;
  start.g = 0;
  start.f = static_cast<int>(std::abs(deltaMapX(goalX, c.x)) + std::abs(deltaMapY(goalY, c.y)));
  nodes.push_back(start);
  openList.push_back(0);
  nodeMap[key(start.x, start.y)] = 0;

  int best = 0;
  constexpr int dirs[4] = {2, 4, 6, 8};
  constexpr int dx[4] = {0, -1, 1, 0};
  constexpr int dy[4] = {1, 0, 0, -1};

  while (!openList.empty()) {
    auto bestIt = openList.begin();
    for (auto it = openList.begin(); it != openList.end(); ++it) {
      if (nodes[*it].f < nodes[*bestIt].f) bestIt = it;
    }
    const int currentIdx = *bestIt;
    openList.erase(bestIt);

    const Node current = nodes[currentIdx];
    if (current.x == goalX && current.y == goalY) {
      best = currentIdx;
      break;
    }
    if (current.g >= searchLimit) continue;

    for (int i = 0; i < 4; ++i) {
      const int d = dirs[i];
      const int nx = roundMapX(current.x + dx[i]);
      const int ny = roundMapY(current.y + dy[i]);
      if (!passable(current.x, current.y, d, c)) continue;

      const int k = key(nx, ny);
      const int g2 = current.g + 1;
      const int h2 = static_cast<int>(std::abs(deltaMapX(goalX, nx)) + std::abs(deltaMapY(goalY, ny)));
      const int f2 = g2 + h2;

      auto found = nodeMap.find(k);
      if (found == nodeMap.end()) {
        Node next;
        next.parent = currentIdx;
        next.x = nx;
        next.y = ny;
        next.g = g2;
        next.f = f2;
        const int nextIdx = static_cast<int>(nodes.size());
        nodes.push_back(next);
        openList.push_back(nextIdx);
        nodeMap[k] = nextIdx;
        if (h2 < nodes[best].f - nodes[best].g) best = nextIdx;
      } else if (g2 < nodes[found->second].g) {
        nodes[found->second].parent = currentIdx;
        nodes[found->second].g = g2;
        nodes[found->second].f = f2;
        if (std::find(openList.begin(), openList.end(), found->second) == openList.end()) {
          openList.push_back(found->second);
        }
      }
    }
  }

  int trace = best;
  while (nodes[trace].parent != -1 && nodes[trace].parent != 0) {
    trace = nodes[trace].parent;
  }

  const int sx = static_cast<int>(deltaMapX(nodes[trace].x, c.x));
  const int sy = static_cast<int>(deltaMapY(nodes[trace].y, c.y));
  if (sy > 0) return 2;
  if (sx < 0) return 4;
  if (sx > 0) return 6;
  if (sy < 0) return 8;
  const int fallbackX = static_cast<int>(deltaMapX(c.x, goalX)), fallbackY = static_cast<int>(deltaMapY(c.y, goalY));
  if (std::abs(fallbackX) > std::abs(fallbackY)) return fallbackX > 0 ? 4 : 6;
  if (fallbackY) return fallbackY > 0 ? 8 : 2;
  return 0;
}

void Session::updateMapTouch(const Input& input) {
  const bool allowed = !interpreter_.running && !message_.busy && !player_.routeForcing && !followersGathering_ && !vehicleGettingOn_ && !vehicleGettingOff_ && (vehicleType_ != 2 || vehicles_[2].altitude >= 48);
  if (!allowed || input.touchCancelled || input.direction) { destination_.reset(); mapTouchCount_ = 0; return; }
  if (input.destinationX && input.destinationY) destination_ = std::array{roundMapX(*input.destinationX), roundMapY(*input.destinationY)};
  if (input.touchTriggered || mapTouchCount_ > 0) {
    if ((input.touchPressed || input.touchTriggered) && input.touchX && input.touchY) {
      if (mapTouchCount_ == 0 || mapTouchCount_ >= 15) {
        const auto& tiled = database_["tiledMaps"][std::to_string(mapId_)];
        const int tw = tiled["tilewidth"].integer(48), th = tiled["tileheight"].integer(48);
        destination_ = std::array{roundMapX(static_cast<int>(std::floor(mapState_.lastDisplayX + *input.touchX / tw))),
          roundMapY(static_cast<int>(std::floor(mapState_.lastDisplayY + *input.touchY / th)))};
      }
      ++mapTouchCount_;
    } else mapTouchCount_ = 0;
  }
}

bool Session::triggerDestinationAction() {
  if (!destination_ || interpreter_.running || message_.busy || vehicleGettingOn_ || vehicleGettingOff_) return false;
  const int x = (*destination_)[0], y = (*destination_)[1];
  const int dx = player_.direction == 6 ? 1 : player_.direction == 4 ? -1 : 0;
  const int dy = player_.direction == 2 ? 1 : player_.direction == 8 ? -1 : 0;
  const int frontX = roundMapX(player_.x + dx), frontY = roundMapY(player_.y + dy);
  const auto hasStarting = [&] {
    return std::any_of(events_.begin(), events_.end(), [](const Event& event) { return event.starting; });
  };
  const auto checkThere = [&] {
    startEvent(frontX, frontY, true); startEvent(frontX, frontY, false);
    if (!hasStarting() && tileFlag(frontX, frontY, 128)) {
      const int farX = roundMapX(frontX + dx), farY = roundMapY(frontY + dy);
      startEvent(farX, farY, true); startEvent(farX, farY, false);
    }
  };
  if (x == player_.x && y == player_.y) {
    const auto& airship = vehicles_[2];
    if (airship.mapId == mapId_ && airship.character.x == x && airship.character.y == y &&
        currentInput_.touchTriggered && toggleVehicle()) { destination_.reset(); return true; }
    startEvent(x, y, true);
  } else if (x == frontX && y == frontY) {
    const bool waterVehicleAhead = std::any_of(vehicles_.begin(), vehicles_.begin() + 2, [&](const Vehicle& vehicle) {
      return vehicle.mapId == mapId_ && vehicle.character.x == x && vehicle.character.y == y;
    });
    if ((waterVehicleAhead || vehicleType_ == 0 || vehicleType_ == 1) &&
        currentInput_.touchTriggered && toggleVehicle()) { destination_.reset(); return true; }
    checkThere();
  } else if (tileFlag(frontX, frontY, 128) && x == roundMapX(frontX + dx) && y == roundMapY(frontY + dy)) {
    checkThere();
  }
  const bool started = hasStarting();
  if (started) destination_.reset();
  return started;
}

int Session::makeEncounterTroopId() {
  const int region = MapMechanics::regionId(*this, player_.x, player_.y);
  const auto eligible = [&](const Value& entry) {
    const auto& regions = entry["regionSet"].array();
    return regions.empty() || std::any_of(regions.begin(), regions.end(), [&](const Value& value) { return value.integer() == region; });
  };
  int total = 0;
  for (const auto& entry : map()["encounterList"].array()) if (eligible(entry)) total += entry["weight"].integer();
  if (total <= 0) return 0;
  int selected = randomInt(total);
  for (const auto& entry : map()["encounterList"].array()) if (eligible(entry)) {
    selected -= entry["weight"].integer();
    if (selected < 0) return entry["troopId"].integer();
  }
  return 0;
}

}  // namespace pmjs::mv

