#include "mv_engine.hpp"

#include <algorithm>
#include <cmath>
#include <cctype>
#include <cstdlib>
#include <limits>
#include <stdexcept>

namespace pmjs::mv {
namespace {
const Value empty;
const Value::Array emptyArray;
int dx(int direction) { return direction == 6 ? 1 : direction == 4 ? -1 : 0; }
int dy(int direction) { return direction == 2 ? 1 : direction == 8 ? -1 : 0; }
std::string selfKey(int map, int event, const std::string& letter) {
  return std::to_string(map) + "," + std::to_string(event) + "," + letter;
}
template<class Map> auto lookup(const Map& map, const typename Map::key_type& key) {
  const auto it = map.find(key);
  return it == map.end() ? typename Map::mapped_type{} : it->second;
}

double variableNumber(const Value& value) {
  if (value.null()) return 0;
  if (const auto* number = std::get_if<double>(&value.data)) return *number;
  if (const auto* boolean = std::get_if<bool>(&value.data)) return *boolean ? 1 : 0;
  if (const auto* text = std::get_if<std::string>(&value.data)) {
    const char* begin = text->c_str(); char* end = nullptr;
    const double number = std::strtod(begin, &end);
    if (begin == end) return std::all_of(text->begin(), text->end(), [](unsigned char c) { return std::isspace(c); }) ? 0 : std::numeric_limits<double>::quiet_NaN();
    while (*end && std::isspace(static_cast<unsigned char>(*end))) ++end;
    if (!*end) return number;
  }
  return std::numeric_limits<double>::quiet_NaN();
}
std::string variableText(const Value& value) {
  if (const auto* text = std::get_if<std::string>(&value.data)) return *text;
  if (value.null()) return "0";
  if (const auto* boolean = std::get_if<bool>(&value.data)) return *boolean ? "true" : "false";
  if (const auto* number = std::get_if<double>(&value.data)) {
    auto text = std::to_string(*number);
    if (text.find('.') != std::string::npos) { while (text.back() == '0') text.pop_back(); if (text.back() == '.') text.pop_back(); }
    return text;
  }
  throw std::runtime_error("unsupported variable string conversion");
}

bool strictEqual(const Value& left, const Value& right) {
  if (left.data.index() != right.data.index()) return false;
  if (const auto* number = std::get_if<double>(&left.data)) return *number == right.number();
  if (const auto* text = std::get_if<std::string>(&left.data)) return *text == right.text();
  if (const auto* boolean = std::get_if<bool>(&left.data)) return *boolean == right.boolean();
  return left.null() || &left == &right;
}

std::u16string utf16(const std::string& text) {
  std::u16string result;
  for (std::size_t i = 0; i < text.size();) {
    const auto first = static_cast<unsigned char>(text[i++]);
    const int extra = first < 0x80 ? 0 : first < 0xe0 ? 1 : first < 0xf0 ? 2 : 3;
    std::uint32_t point = first & (extra ? (1 << (6 - extra)) - 1 : 0x7f);
    for (int j = 0; j < extra; ++j) {
      if (i == text.size() || (static_cast<unsigned char>(text[i]) & 0xc0) != 0x80) throw std::invalid_argument("invalid UTF-8 variable value");
      point = (point << 6) | (static_cast<unsigned char>(text[i++]) & 0x3f);
    }
    if (point > 0xffff) {
      point -= 0x10000; result.push_back(static_cast<char16_t>(0xd800 + (point >> 10)));
      result.push_back(static_cast<char16_t>(0xdc00 + (point & 0x3ff)));
    } else result.push_back(static_cast<char16_t>(point));
  }
  return result;
}


}

const Value& Value::operator[](const std::string& key) const {
  const auto* object = std::get_if<Object>(&data);
  if (!object) return empty;
  const auto it = object->find(key);
  return it == object->end() ? empty : it->second;
}
const Value& Value::operator[](std::size_t index) const {
  const auto* items = std::get_if<Array>(&data);
  return items && index < items->size() ? (*items)[index] : empty;
}
const Value::Array& Value::array() const {
  const auto* items = std::get_if<Array>(&data); return items ? *items : emptyArray;
}
double Value::number(double fallback) const { const auto* v = std::get_if<double>(&data); return v ? *v : fallback; }
int Value::integer(int fallback) const {
  const auto v = number(fallback);
  if (!std::isfinite(v) || v < std::numeric_limits<int>::min() || v > std::numeric_limits<int>::max()) throw std::invalid_argument("integer outside supported range");
  return static_cast<int>(v);
}
bool Value::boolean() const {
  if (auto v = std::get_if<bool>(&data)) return *v;
  if (auto v = std::get_if<double>(&data)) return *v != 0 && !std::isnan(*v);
  if (auto v = std::get_if<std::string>(&data)) return !v->empty();
  return !null();
}
std::string Value::text() const { const auto* v = std::get_if<std::string>(&data); return v ? *v : ""; }

Session::Session(Value database) : database_(std::move(database)) {
  const auto kind = database_["sceneContract"]["kind"].text();
  if (!kind.empty() && kind != "map") throw std::invalid_argument("unsupported scene contract");
  if (mapSceneOnly()) return;
  std::map<std::string, double> fields;
  for (const auto* side : {"a", "b"}) for (const auto* stat : {"mhp", "mmp", "atk", "def", "mat", "mdf", "agi", "luk"}) fields[std::string(side) + "." + stat] = 1;
  for (const auto* collection : {"skills", "items"}) for (const auto& item : database_[collection].array()) {
    if (item["damage"]["type"].integer() != 0) {
      try { formula(item["damage"]["formula"].text(), fields, [](const auto&, const auto&) { return 0.0; }); }
      catch (const std::exception& error) { throw std::invalid_argument(std::string(collection) + "[" + std::to_string(item["id"].integer()) + "].damage.formula: " + error.what()); }
    }
  }
}
const Value& Session::map() const { return database_["maps"][std::to_string(mapId_)]; }

void Session::newGame() {
  ++presentationRevision_; battleTest_ = false;
  switches_.clear(); variables_.clear(); selfSwitches_.clear(); inventory_.clear();
  visualEffects_.clear(); nextVisualEffect_ = 0;
  moviePlaying_ = false; movieName_.clear();
  reservedCommonEvent_ = 0;
  sceneStack_.clear(); messageOwnerSerial_ = 0; nextInterpreterSerial_ = 0;
  party_.clear(); events_.clear(); interpreter_ = {}; message_ = {}; player_ = {};
  actors_.clear(); battle_ = {}; ui_ = {}; system_ = {}; gold_ = 0; steps_ = 0; brightness_ = 255; fadeOut_ = 0;
  pictures_.clear(); ambience_ = {}; savedCamera_.reset();
  audioCommands_.clear(); previousCancel_ = false; directionAge_ = 0; previousDirection_ = 0;
  screenEffects_ = {};
  savedBgm_ = {}; savedBgs_ = {}; saveRequested_ = false; loadRequested_ = false;
  timerFrames_ = 0; timerWorking_ = false;
  ticks_ = 0; previousOk_ = false; finished_ = false;
  playerDashing_ = false;
  followersVisible_ = database_["system"]["optFollowers"].boolean();
  followersGathering_ = false; destination_.reset(); mapTouchCount_ = 0; setupVehicles();
  pendingTransfer_.reset();
  interpreter_.waitingRoute.reset();
  const auto& system = database_["system"];
  for (const auto& id : system["partyMembers"].array()) { party_.push_back(id.integer()); initializeActor(id.integer()); }
  if (!party_.empty()) {
    const auto& actor = actors_.at(party_[0]);
    player_.characterName = actor.characterName;
    player_.characterIndex = actor.characterIndex;
  }
  player_.transparent = system["optTransparent"].boolean();
  transfer(system["startMapId"].integer(), system["startX"].integer(), system["startY"].integer(), 2);
}

void Session::transfer(int id, int x, int y, int direction) {
  const auto& target = database_["maps"][std::to_string(id)];
  if (target.null()) throw std::invalid_argument("map not loaded: " + std::to_string(id));
  if (x < 0 || y < 0 || x >= target["width"].integer() || y >= target["height"].integer()) throw std::invalid_argument("transfer outside map");
  ++presentationRevision_;
  std::erase_if(visualEffects_, [](const VisualEffect& effect) { return effect.targetType == 0; });
  destination_.reset(); mapTouchCount_ = 0;
  mapId_ = id; player_.x = x; player_.y = y; player_.realX = x; player_.realY = y;
  setupMapState(); commonInterpreters_.clear();
  if (direction) player_.direction = direction;
  if (vehicleType_ >= 0 && vehicles_[vehicleType_].driving) {
    auto& vehicle = vehicles_[vehicleType_]; vehicle.mapId = mapId_;
    vehicle.character.x = player_.x; vehicle.character.y = player_.y; vehicle.character.realX = player_.realX; vehicle.character.realY = player_.realY;
    vehicle.character.direction = player_.direction;
  }
  for (auto& follower : followers_) { follower = player_; follower.through = true; }
  events_.clear();
  for (const auto& data : map()["events"].array()) {
    if (data.null()) continue;
    Event event; event.id = data["id"].integer();
    event.character.x = data["x"].integer(); event.character.y = data["y"].integer();
    event.character.realX = event.character.x; event.character.realY = event.character.y;
    events_.push_back(event);
  }
  refreshNeeded_ = true; refreshIfNeeded();
  encounterCount_ = randomInt(map()["encounterStep"].integer(30)) + randomInt(map()["encounterStep"].integer(30)) + 1;
  if (map()["autoplayBgm"].boolean()) audio("bgm", map()["bgm"]);
  if (map()["autoplayBgs"].boolean()) audio("bgs", map()["bgs"]);
}

bool Session::pageEligible(const Value& page, int eventId) const {
  const auto& c = page["conditions"];
  if (c["switch1Valid"].boolean() && !lookup(switches_, c["switch1Id"].integer())) return false;
  if (c["switch2Valid"].boolean() && !lookup(switches_, c["switch2Id"].integer())) return false;
  if (c["variableValid"].boolean() && variableNumber(lookup(variables_, c["variableId"].integer())) < c["variableValue"].number()) return false;
  if (c["selfSwitchValid"].boolean() && !lookup(selfSwitches_, selfKey(mapId_, eventId, c["selfSwitchCh"].text()))) return false;
  if (c["itemValid"].boolean() && lookup(inventory_, c["itemId"].integer()) <= 0) return false;
  return !c["actorValid"].boolean() || std::find(party_.begin(), party_.end(), c["actorId"].integer()) != party_.end();
}

void Session::refreshIfNeeded() { if (refreshNeeded_) { refreshNeeded_ = false; refresh(); } }
void Session::refresh() {
  for (auto& event : events_) {
    const auto& pages = map()["events"][event.id]["pages"].array();
    int selected = -1;
    if (!event.erased) for (int i = static_cast<int>(pages.size()) - 1; i >= 0; --i) if (pageEligible(pages[i], event.id)) { selected = i; break; }
    if (selected == event.page) continue;
    event.page = selected; event.parallel = {};
    if (selected < 0) { event.character.transparent = true; event.character.through = true; continue; }
    const auto& p = pages[selected]; const auto& image = p["image"];
    event.moveType = p["moveType"].integer();
    event.trigger = p["trigger"].integer(); event.priority = p["priorityType"].integer();
    event.character.transparent = false; event.character.through = p["through"].boolean();
    event.character.directionFix = p["directionFix"].boolean();
    event.character.walkAnime = p["walkAnime"].boolean(); event.character.stepAnime = p["stepAnime"].boolean();
    event.character.moveSpeed = p["moveSpeed"].integer(3);
    event.character.moveFrequency = p["moveFrequency"].integer(3);
    event.character.characterName = image["characterName"].text(); event.character.characterIndex = image["characterIndex"].integer();
    event.character.tileId = image["tileId"].integer();
    event.character.route = p["moveRoute"]["list"].array(); event.character.routeIndex = 0;
    event.character.routeRepeat = p["moveRoute"]["repeat"].boolean(); event.character.routeSkippable = p["moveRoute"]["skippable"].boolean();
    event.character.routeForcing = false; event.character.routeWait = 0;
    const int direction = image["direction"].integer(2), pattern = image["pattern"].integer(1);
    if (event.originalDirection != direction) {
      event.originalDirection = direction; event.character.direction = direction; event.prelockDirection = 0;
    }
    if (event.originalPattern != pattern) {
      event.originalPattern = pattern; event.character.pattern = pattern;
    }
  }
  refreshCommonEvents();
}

bool Session::tilePassage(int x, int y, int bit) const {
  x = roundMapX(x); y = roundMapY(y);
  const auto& tiled = database_["tiledMaps"][std::to_string(mapId_)];
  if (!tiled.null()) {
    const int width = tiled["width"].integer(), height = tiled["height"].integer();
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    if (tiled["passage"].array().size() != static_cast<std::size_t>(width * height))
      throw std::runtime_error("tile collision data is unavailable");
    return !(tiled["passage"][y * width + x].integer() & bit);
  }
  const int width = map()["width"].integer(), height = map()["height"].integer();
  const auto& flags = database_["tilesets"][mapState_.tilesetId]["flags"];
  for (auto it = events_.rbegin(); it != events_.rend(); ++it) {
    const auto& c = it->character;
    if (it->page >= 0 && c.tileId > 0 && it->priority == 0 && !c.through && c.x == x && c.y == y) {
      const int flag = flags[c.tileId].integer();
      if (!(flag & 16)) return (flag & bit) == 0;
    }
  }
  for (int z = 3; z >= 0; --z) {
    const int tile = map()["data"][(z * height + y) * width + x].integer();
    const int flag = flags[tile].integer();
    if (flag & 16) continue;
    if (!(flag & bit)) return true;
    if ((flag & bit) == bit) return false;
  }
  return false;
}

bool Session::passable(int x, int y, int direction, const Character& character) const {
  const int nx = roundMapX(x + dx(direction)), ny = roundMapY(y + dy(direction));
  if (nx < 0 || ny < 0 || nx >= map()["width"].integer() || ny >= map()["height"].integer()) return false;
  if (character.through) return true;
  const int bit = 1 << (direction / 2 - 1), reverse = 1 << ((10 - direction) / 2 - 1);
  if (&character == &player_ && vehicleType_ >= 0) {
    if (vehicleType_ < 2 && !tilePassage(nx, ny, vehicleType_ == 0 ? 512 : 1024)) return false;
  } else if (!tilePassage(x, y, bit) || !tilePassage(nx, ny, reverse)) return false;
  for (int index = 0; index < 2; ++index) {
    const auto& vehicle = vehicles_[index];
    if (vehicle.mapId == mapId_ && !vehicle.character.through && &vehicle.character != &character &&
        !(&character == &player_ && vehicleType_ == index) && vehicle.character.x == nx && vehicle.character.y == ny) return false;
  }
  for (const auto& event : events_) if (event.page >= 0 && &event.character != &character && !event.character.through && event.priority == 1 && event.character.x == nx && event.character.y == ny) return false;
  for (const auto& event : events_) if (&event.character == &character && event.priority == 1) {
    if (!player_.through && player_.x == nx && player_.y == ny) return false;
    if (followersVisible_) for (std::size_t i = 0; i < followers_.size() && i + 1 < party_.size(); ++i)
      if (followers_[i].x == nx && followers_[i].y == ny) return false;
  }
  return true;
}
bool Session::tileFlag(int x, int y, int flag) const {
  x = roundMapX(x); y = roundMapY(y);
  const auto& flags = database_["tilesets"][mapState_.tilesetId]["flags"];
  const int width = map()["width"].integer(), height = map()["height"].integer();
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  for (int z = 0; z < 4; ++z) if (flags[map()["data"][(z * height + y) * width + x].integer()].integer() & flag) return true;
  return false;
}

bool Session::move(Character& character, int direction) {
  if (direction != 2 && direction != 4 && direction != 6 && direction != 8) return false;
  if (!character.directionFix) character.direction = direction;
  character.stopCount = 0;
  character.movementSuccess = passable(character.x, character.y, direction, character);
  if (!character.movementSuccess) {
    for (auto& event : events_) if (&event.character == &character) checkEventTouch(event, roundMapX(character.x + dx(direction)), roundMapY(character.y + dy(direction)));
    return false;
  }
  if (&character == &player_) for (int index = static_cast<int>(followers_.size()) - 1; index >= 0; --index)
    chaseCharacter(followers_[index], index == 0 ? player_ : followers_[index - 1]);
  character.x = roundMapX(character.x + dx(direction)); character.y = roundMapY(character.y + dy(direction));
  character.realX = character.x - dx(direction); character.realY = character.y - dy(direction); character.stopCount = 0;
  if (tileFlag(character.x, character.y, 32) && !character.directionFix) character.direction = 8;
  return true;
}
void Session::updateCharacter(Character& c, bool dash, int idlePattern) {
  if (!c.moving() && c.jumpCount <= 0) {
    ++c.stopCount;
    if (c.routeForcing) updateRoute(c);
    else for (auto& event : events_) if (&event.character == &c && event.page >= 0) { updateSelfMovement(event); break; }
  }
  if (c.jumpCount > 0) {
    --c.jumpCount;
    c.realX = (c.realX * c.jumpCount + c.x) / (c.jumpCount + 1.0);
    c.realY = (c.realY * c.jumpCount + c.y) / (c.jumpCount + 1.0);
    if (c.jumpCount == 0) { c.x = roundMapX(c.x); c.y = roundMapY(c.y); c.realX = c.x; c.realY = c.y; }
  } else if (c.moving()) {
    const double scale = database_["tiledMaps"][std::to_string(mapId_)]["movementScale"].number(1);
    const double distance = std::pow(2.0, c.moveSpeed + (dash ? 1 : 0)) / 256 * scale;
    c.realX = c.realX < c.x ? std::min(c.realX + distance, static_cast<double>(c.x)) : std::max(c.realX - distance, static_cast<double>(c.x));
    c.realY = c.realY < c.y ? std::min(c.realY + distance, static_cast<double>(c.y)) : std::max(c.realY - distance, static_cast<double>(c.y));
  }
  if (!c.moving() && c.jumpCount <= 0) {
    bool normal = &c == &player_;
    for (const auto& event : events_) if (&event.character == &c) normal = event.priority == 1;
    c.bushDepth = normal && c.characterName.find('!') >= 2 && tileFlag(c.x, c.y, 64) ? 12 : 0;
  }
  if (c.moving() && c.walkAnime) c.animationCount += 1.5;
  else if (c.stepAnime || c.pattern != idlePattern) ++c.animationCount;
  if (c.animationCount >= (9 - c.moveSpeed - (dash ? 1 : 0)) * 3) {
    c.pattern = !c.stepAnime && c.stopCount > 0 ? idlePattern : (c.pattern + 1) % 4; c.animationCount = 0;
  }
}

Character* Session::routeCharacter(int id, const Interpreter& context) {
  if (id < 0) return &player_;
  if (context.mapId != mapId_) return nullptr;
  if (!id) id = context.eventId;
  for (auto& event : events_) if (event.id == id) return &event.character;
  return nullptr;
}
void Session::updateRoute(Character& c) {
  if (c.routeWait > 0) { --c.routeWait; return; }
  if (c.routeIndex >= static_cast<int>(c.route.size())) {
    if (c.routeForcing) throw std::runtime_error("movement route missing terminator");
    return;
  }
  const auto& instruction = c.route[c.routeIndex];
  const int code = instruction["code"].integer();
  const auto& parameters = instruction["parameters"];
  const auto setDirection = [&](int direction) {
    if (!c.directionFix) c.direction = direction;
    c.stopCount = 0;
  };
  const auto turn = [&](bool right) {
    const int clockwise = c.direction == 2 ? 4 : c.direction == 4 ? 8 : c.direction == 8 ? 6 : 2;
    setDirection(right ? clockwise : 10 - clockwise);
  };
  c.movementSuccess = true;
  switch (code) {
    case 1: case 2: case 3: case 4: move(c, code * 2); break;
    case 5: case 6: case 7: case 8: {
      const int horizontal = code == 5 || code == 7 ? 4 : 6;
      const int vertical = code <= 6 ? 2 : 8;
      const bool pass = (passable(c.x, c.y, vertical, c) && passable(c.x, roundMapY(c.y + dy(vertical)), horizontal, c)) ||
        (passable(c.x, c.y, horizontal, c) && passable(roundMapX(c.x + dx(horizontal)), c.y, vertical, c));
      c.movementSuccess = pass;
      if (pass) { c.x = roundMapX(c.x + dx(horizontal)); c.y = roundMapY(c.y + dy(vertical));
        c.realX = c.x - dx(horizontal); c.realY = c.y - dy(vertical); c.stopCount = 0; }
      if (c.direction == 10 - horizontal) setDirection(horizontal);
      if (c.direction == 10 - vertical) setDirection(vertical);
      break;
    }
    case 9: {
      const int direction = 2 + randomInt(4) * 2;
      if (passable(c.x, c.y, direction, c)) move(c, direction);
      break;
    }
    case 10: case 11: {
      const int sx = static_cast<int>(deltaMapX(c.x,player_.x)), sy = static_cast<int>(deltaMapY(c.y,player_.y));
      const int horizontal = code == 10 ? (sx > 0 ? 4 : 6) : (sx > 0 ? 6 : 4);
      const int vertical = code == 10 ? (sy > 0 ? 8 : 2) : (sy > 0 ? 2 : 8);
      if (std::abs(sx) > std::abs(sy)) { if (!move(c, horizontal) && sy) move(c, vertical); }
      else if (sy) { if (!move(c, vertical) && sx) move(c, horizontal); }
      break;
    }
    case 12: move(c, c.direction); break;
    case 13: {
      const bool fixed = c.directionFix; c.directionFix = true;
      move(c, 10 - c.direction); c.directionFix = fixed; break;
    }
    case 14: {
      const int x = parameters[0].integer(), y = parameters[1].integer();
      if (std::abs(x) > std::abs(y)) { if (x) setDirection(x < 0 ? 4 : 6); }
      else if (y) setDirection(y < 0 ? 8 : 2);
      c.x += x; c.y += y;
      c.jumpPeak = 10 + static_cast<int>(std::floor(std::hypot(x, y) + 0.5)) - c.moveSpeed;
      c.jumpCount = c.jumpPeak * 2; c.stopCount = 0; c.animationCount = 0;
      if (c.walkAnime || c.stepAnime) c.pattern = 1;
      break;
    }
    case 0:
      if (c.routeRepeat) c.routeIndex = -1;
      else if (c.routeForcing) {
        c.routeForcing = false;
        c.route = c.originalRoute["list"].array(); c.routeIndex = c.originalRouteIndex;
        c.routeRepeat = c.originalRoute["repeat"].boolean(); c.routeSkippable = c.originalRoute["skippable"].boolean(); c.originalRoute = {};
        return;
      }
      break;
    case 15: c.routeWait = instruction["parameters"][0].integer() - 1; break;
    case 16: case 17: case 18: case 19: setDirection((code - 15) * 2); break;
    case 20: turn(true); break;
    case 21: turn(false); break;
    case 22: setDirection(10 - c.direction); break;
    case 23: turn(randomInt(2) == 0); break;
    case 24: setDirection(2 + randomInt(4) * 2); break;
    case 25: case 26: {
      const int sx = static_cast<int>(deltaMapX(c.x,player_.x)), sy = static_cast<int>(deltaMapY(c.y,player_.y));
      int direction = 0;
      if (std::abs(sx) > std::abs(sy)) direction = sx > 0 ? 4 : 6;
      else if (sy) direction = sy > 0 ? 8 : 2;
      if (direction) setDirection(code == 25 ? direction : 10 - direction);
      break;
    }
    case 27: case 28: {
      const int id = parameters[0].integer();
      if (id > 0 && id < static_cast<int>(database_["system"]["switches"].array().size())) {
        switches_[id] = code == 27; refreshNeeded_ = true;
      }
      break;
    }
    case 29: c.moveSpeed = parameters[0].integer(); break;
    case 30: c.moveFrequency = parameters[0].integer(); break;
    case 31: case 32: c.walkAnime = code == 31; break;
    case 33: case 34: c.stepAnime = code == 33; break;
    case 35: case 36: c.directionFix = code == 35; break;
    case 37: case 38: c.through = code == 37; break;
    case 39: case 40: c.transparent = code == 39; break;
    case 41:
      c.characterName = parameters[0].text(); c.characterIndex = parameters[1].integer(); c.tileId = 0;
      break;
    case 42: c.opacity = parameters[0].integer(); break;
    case 43: c.blendMode = parameters[0].integer(); break;
    case 44: audio("se", parameters[0]); break;
    case 45: {
      Interpreter context; context.mapId = mapId_;
      for (const auto& event : events_) if (&event.character == &c) context.eventId = event.id;
      context.scriptCharacter = &c == &player_ ? -1 : context.eventId;
      executeNativeScript(parameters[0].text(), context); break;
    }
    default: throw std::runtime_error("unsupported movement route command");
  }
  if (!c.movementSuccess && !c.routeSkippable) return;
  ++c.routeIndex;
  if (c.routeRepeat && c.routeIndex >= static_cast<int>(c.route.size()) - 1) c.routeIndex = 0;
}

void Session::startEvent(int x, int y, bool action) {
  if (vehicleType_ == 2) return;
  x = roundMapX(x); y = roundMapY(y);
  for (auto& e : events_) {
    if (e.page >= 0 && e.character.x == x && e.character.y == y &&
        ((action && e.trigger == 0) || (!action && (e.trigger == 1 || e.trigger == 2)))) {
      const bool samePosition = x == player_.x && y == player_.y;
      if (samePosition == (e.priority == 1)) continue;
      if (map()["events"][e.id]["pages"][e.page]["list"].array().size() <= 1) continue;
      if (!e.prelockDirection && e.trigger <= 2) {
        e.prelockDirection = e.character.direction;
        if (!e.character.directionFix) {
          const int horizontal = static_cast<int>(deltaMapX(player_.x, e.character.x)), vertical = static_cast<int>(deltaMapY(player_.y, e.character.y));
          if (std::abs(horizontal) > std::abs(vertical)) e.character.direction = horizontal > 0 ? 6 : 4;
          else if (vertical) e.character.direction = vertical > 0 ? 2 : 8;
        }
      }
      e.starting = true;
    }
  }
}
void Session::startInterpreter(const Event& event) {
  interpreter_ = {}; interpreter_.mapId = mapId_; interpreter_.eventId = event.id;
  interpreter_.list = map()["events"][event.id]["pages"][event.page]["list"].array(); interpreter_.running = true;
  for (const auto& entry : interpreter_.list) if (entry["code"].integer() == 129) {
    const int actor = entry["parameters"][0].integer();
    if (!actors_.count(actor)) initializeActor(actor);
  }
}
void Session::skipBranch(int indent, Interpreter& context) {
  while (context.index + 1 < static_cast<int>(context.list.size()) && context.list[context.index + 1]["indent"].integer() > indent) ++context.index;
}
const Value& Session::variable(int id) const {
  static const Value zero(0);
  const auto it = variables_.find(id);
  return it != variables_.end() && it->second.boolean() ? it->second : zero;
}

void Session::operateVariable(int id, int operation, const Value& operand) {
  if (id <= 0 || (!database_["system"]["variables"].null() && id >= static_cast<int>(database_["system"]["variables"].array().size()))) return;
  Value result;
  const auto& old = variable(id);
  if (operation == 0) result = operand;
  else if (operation == 1 && (std::holds_alternative<std::string>(old.data) || std::holds_alternative<std::string>(operand.data))) {
    try { result = variableText(old) + variableText(operand); }
    catch (const std::runtime_error&) { result = 0; }
  } else {
    const double left = variableNumber(old), right = variableNumber(operand);
    switch (operation) {
      case 1: result = left + right; break;
      case 2: result = left - right; break;
      case 3: result = left * right; break;
      case 4: result = left / right; break;
      case 5: result = std::fmod(left, right); break;
      default: throw std::runtime_error("unsupported variable operation");
    }
  }
  if (const auto* number = std::get_if<double>(&result.data)) result = std::floor(*number);
  variables_[id] = std::move(result);
  refreshNeeded_ = true;
}

void Session::gainItem(int kind, int id, double amount, bool includeEquipped) {
  if (database_[kind == 0 ? "items" : kind == 1 ? "weapons" : "armors"][id].null()) return;
  if (std::isnan(amount)) throw std::runtime_error("non-numeric inventory operand is unsupported");
  const int key = id + kind * 100000;
  const double count = lookup(inventory_, key) + amount;
  const int stored = static_cast<int>(std::clamp(count, 0.0, 99.0));
  if (stored) inventory_[key] = stored; else inventory_.erase(key);
  if (kind && includeEquipped && count < 0) {
    double remaining = -count;
    for (int actorId : party_) {
      auto& actor = actors_.at(actorId);
      for (std::size_t slot = 0; slot < actor.equips.size() && remaining > 0; ++slot) {
        if ((slot < actor.equipKinds.size() ? actor.equipKinds[slot] : slot == 0 ? 1 : 2) == kind && actor.equips[slot] == id) {
          actor.equips[slot] = 0; --remaining;
        }
      }
    }
  }
  refreshNeeded_ = true;
}

Value Session::gameDataOperand(int type, int first, int second, const Interpreter& context) {
  if (type >= 0 && type <= 2) {
    if (database_[type == 0 ? "items" : type == 1 ? "weapons" : "armors"][first].null()) return 0;
    return lookup(inventory_, first + type * 100000);
  }
  if (type == 3 || type == 4) {
    const Battler* battler = nullptr;
    if (type == 3 && !database_["actors"][first].null()) {
      if (!actors_.contains(first)) initializeActor(first);
      battler = &actors_.at(first);
      if (second == 0) return battler->level;
      if (second == 1) {
        const auto it = battler->exp.find(battler->classId);
        return it == battler->exp.end() ? 0.0 : it->second;
      }
    } else if (type == 4 && first >= 0 && first < static_cast<int>(battle_.enemies.size())) battler = &battle_.enemies[first];
    if (!battler) return 0;
    const int offset = type == 3 ? 2 : 0;
    if (second == offset) return battler->hp;
    if (second == offset + 1) return battler->mp;
    if (second >= offset + 2 && second <= offset + 9) return parameter(*battler, second - offset - 2);
    return 0;
  }
  if (type == 5) {
    if (battle_.active || (first >= 0 && context.mapId != mapId_)) return 0;
    const auto* character = routeCharacter(first, context);
    if (!character) return 0;
    if (second == 0) return character->x;
    if (second == 1) return character->y;
    if (second == 2) return character->direction;
    if (second == 3) return static_cast<int>(std::round(character->realX * 48 + 24));
    if (second == 4) return static_cast<int>(std::round(character->realY * 48 + 48));
    return 0;
  }
  if (type == 6) return first >= 0 && first < static_cast<int>(party_.size()) ? party_[first] : 0;
  if (type == 7) {
    switch (first) {
      case 0: return mapId_;
      case 1: return static_cast<int>(party_.size());
      case 2: return gold_;
      case 3: return steps_;
      case 4: return static_cast<double>((ticks_ ? ticks_ - 1 : 0) / 60);
      case 5: return std::floor(timerFrames_ / 60.0);
      case 6: return system_.saveCount;
      case 7: return system_.battleCount;
      case 8: return system_.winCount;
      case 9: return system_.escapeCount;
    }
  }
  throw std::runtime_error("unsupported game-data operand");
}

bool Session::condition(const Value& p, const Interpreter& context) {
  if (p[0].integer() == 0) return lookup(switches_, p[1].integer()) == (p[2].integer() == 0);
  if (p[0].integer() == 1) {
    const auto& left = variable(p[1].integer());
    const auto& right = p[2].integer() ? variable(p[3].integer()) : p[3];
    const int operation = p[4].integer();
    if (operation == 0 || operation == 5) return strictEqual(left, right) == (operation == 0);
    if (std::holds_alternative<std::string>(left.data) && std::holds_alternative<std::string>(right.data)) {
      const auto a = utf16(left.text()), b = utf16(right.text());
      switch (operation) { case 1: return a >= b; case 2: return a <= b; case 3: return a > b; case 4: return a < b; }
    } else {
      const double a = variableNumber(left), b = variableNumber(right);
      switch (operation) { case 1: return a >= b; case 2: return a <= b; case 3: return a > b; case 4: return a < b; }
    }
  }
  if (p[0].integer() == 2) return context.eventId > 0 && lookup(selfSwitches_, selfKey(context.mapId, context.eventId, p[1].text())) == (p[2].integer() == 0);
  if (p[0].integer() == 3) return timerWorking_ && (p[2].integer() == 0 ? std::floor(timerFrames_ / 60.0) >= p[1].number() : std::floor(timerFrames_ / 60.0) <= p[1].number());
  if (p[0].integer() == 4) {
    const int id = p[1].integer(), argument = p[3].integer();
    if (database_["actors"][id].null()) return false;
    if (!actors_.contains(id)) initializeActor(id);
    const auto& actor = actors_.at(id);
    switch (p[2].integer()) {
      case 0: return std::find(party_.begin(), party_.end(), id) != party_.end();
      case 1: return actor.name == p[3].text();
      case 2: return actor.classId == argument;
      case 3: return battlerSkills(actor).contains(argument);
      case 4: case 5: {
        const int kind=p[2].integer()==4?1:2;
        if(database_[kind==1?"weapons":"armors"][argument].null())return false;
        for(std::size_t slot=0;slot<actor.equips.size();++slot)
          if(actor.equips[slot]==argument && (slot<actor.equipKinds.size()?actor.equipKinds[slot]:slot==0?1:2)==kind)return true;
        return false;
      }
      case 6: return std::find(actor.states.begin(), actor.states.end(), argument) != actor.states.end();
    }
  }
  if (p[0].integer() == 5) {
    const int index = p[1].integer();
    if (index < 0 || index >= static_cast<int>(battle_.enemies.size())) return false;
    const auto& enemy = battle_.enemies[index];
    if (p[2].integer() == 0) return !enemy.hidden && std::find(enemy.states.begin(), enemy.states.end(), 1) == enemy.states.end();
    if (p[2].integer() == 1) return std::find(enemy.states.begin(), enemy.states.end(), p[3].integer()) != enemy.states.end();
  }
  if (p[0].integer() == 6) {
    if (battle_.active || (p[1].integer() >= 0 && context.mapId != mapId_)) return false;
    const auto* character = routeCharacter(p[1].integer(), context);
    return character && character->direction == p[2].integer();
  }
  if (p[0].integer() == 7) {
    switch (p[2].integer()) { case 0: return gold_ >= p[1].number(); case 1: return gold_ <= p[1].number(); case 2: return gold_ < p[1].number(); }
  }
  if (p[0].integer() >= 8 && p[0].integer() <= 10) {
    const int kind = p[0].integer() - 8, id = p[1].integer();
    if (database_[kind == 0 ? "items" : kind == 1 ? "weapons" : "armors"][id].null()) return false;
    if (lookup(inventory_, id + kind * 100000) > 0) return true;
    if (kind && p[2].boolean()) for (int actorId : party_) {
      const auto& actor = actors_.at(actorId); const auto& equips = actor.equips;
      for (std::size_t slot = 0; slot < equips.size(); ++slot) if ((slot < actor.equipKinds.size() ? actor.equipKinds[slot] : slot == 0 ? 1 : 2) == kind && equips[slot] == id) return true;
    }
    return false;
  }
  if (p[0].integer() == 11) {
    const auto name = p[1].text();
    if (currentInput_.pressed.contains(name)) return true;
    if (name == "ok") return currentInput_.ok;
    if (name == "cancel" || name == "escape" || name == "menu") return currentInput_.cancel;
    if (name == "shift") return currentInput_.dash;
    return currentInput_.direction == (name == "down" ? 2 : name == "left" ? 4 : name == "right" ? 6 : name == "up" ? 8 : 0) && currentInput_.direction != 0;
  }
  if (p[0].integer() == 12) { const double value = evaluateExpression(p[1].text()); return value != 0 && !std::isnan(value); }
  if (p[0].integer() == 13) return vehicleType_ == p[1].integer(); // in vehicle check
  throw std::runtime_error("unsupported conditional branch");
}

bool Session::command(const Value& entry, Interpreter& context) {
  const int code = entry["code"].integer(), indent = entry["indent"].integer();
  if (!context.serial) context.serial = ++nextInterpreterSerial_;
  if (code == 101 || code == 102 || code == 103 || code == 104 || code == 105) messageOwnerSerial_ = context.serial;
  const auto& p = entry["parameters"];
  switch (code) {
    case 0: case 108: case 408: case 118: return true;
    case 112: return true;
    case 113: {
      int depth = 0;
      while (context.index + 1 < static_cast<int>(context.list.size())) {
        const int next = context.list[++context.index]["code"].integer();
        if (next == 112) ++depth;
        if (next == 413) { if (depth > 0) --depth; else break; }
      }
      return true;
    }
    case 115: context.index = static_cast<int>(context.list.size()); return true;
    case 117: {
      const auto& source = database_["commonEvents"][p[0].integer()]["list"];
      if (source.null()) return true;
      if (context.depth >= 99) throw std::runtime_error("common event nesting limit exceeded");
      Interpreter child; child.mapId = mapId_; child.eventId = context.mapId == mapId_ ? context.eventId : 0;
      child.depth = context.depth + 1; child.battleEvent = context.battleEvent;
      child.list = source.array(); child.running = true; context.children.push_back(std::move(child));
      return true;
    }
    case 119:
      for (int index = 0; index < static_cast<int>(context.list.size()); ++index) {
        if (context.list[index]["code"].integer() != 118 || !strictEqual(context.list[index]["parameters"][0], p[0])) continue;
        int branchIndent = indent;
        for (int i = std::min(index, context.index); i <= std::max(index, context.index); ++i) {
          const int nextIndent = context.list[i]["indent"].integer();
          if (nextIndent != branchIndent) { context.branches.erase(branchIndent); branchIndent = nextIndent; }
        }
        context.index = index;
        return false;
      }
      return true;
    case 9000:
      if (p[0].text() == "message" || p[0].text() == "unsupported") {
        message_ = {}; message_.busy = true; messageAge_ = 0; ui_.cursor = 0;
        message_.lines = p[1]["lines"].array(); message_.position = p[1]["position"].integer(2);
        message_.background = p[1]["background"].integer();
        for (const auto& pause : p[1]["pauses"].array()) message_.pauses.push_back(pause.integer());
        if (p[0].text() == "unsupported") unsupportedAction_ = p[2];
        return true;
      }
      if (p[0].text() != "eventMovement" || !std::holds_alternative<bool>(p[1].data))
        throw std::runtime_error("unsupported native event operation");
      eventMovementAllowed_ = p[1].boolean(); return true;
    case 101:
      message_ = {}; message_.busy = true;
      messageAge_ = 0; ui_.cursor = 0;
      message_.faceName = p[0].text(); message_.faceIndex = p[1].integer();
      message_.background = p[2].integer(); message_.position = p[3].integer();
      while (context.index + 1 < static_cast<int>(context.list.size()) && context.list[context.index + 1]["code"].integer() == 401) {
        ++context.index; message_.lines.push_back(context.list[context.index]["parameters"][0]);
      }
      if (context.index + 1 < static_cast<int>(context.list.size()) && context.list[context.index + 1]["code"].integer() == 102) {
        ++context.index;
        const auto& choices = context.list[context.index]["parameters"];
        message_.choices = choices[0].array(); message_.cancelChoice = choices[1].integer();
        message_.choicePosition = choices[3].integer(2); message_.choiceBackground = choices[4].integer();
        message_.defaultChoice = choices[2].integer(); message_.choiceIndent = context.list[context.index]["indent"].integer();
        ui_.cursor = message_.defaultChoice;
      } else if (context.index + 1 < static_cast<int>(context.list.size()) &&
                 (context.list[context.index + 1]["code"].integer() == 103 || context.list[context.index + 1]["code"].integer() == 104)) {
        ++context.index; dialogEventCommand(context.list[context.index], context);
      }
      return true;
    case 102: message_ = {}; message_.busy = true; messageAge_ = 0; ui_.cursor = p[2].integer(); message_.choices = p[0].array(); message_.cancelChoice = p[1].integer(); message_.defaultChoice = p[2].integer(); message_.choiceIndent = indent; message_.choicePosition = p[3].integer(2); message_.choiceBackground = p[4].integer(); return true;
    case 111: context.branches[indent] = condition(p, context); if (!context.branches[indent]) skipBranch(indent, context); return true;
    case 121: for (int id = p[0].integer(); id <= p[1].integer(); ++id) switches_[id] = p[2].integer() == 0; refreshNeeded_ = true; return true;
    case 122: {
      if (p[3].integer() == 2) {
        const double range = p[5].number() - p[4].number() + 1;
        for (int id = p[0].integer(); id <= p[1].integer(); ++id)
          operateVariable(id, p[2].integer(), p[4].number() + std::floor(random() * range));
        return true;
      }
      Value operand;
      switch (p[3].integer()) {
        case 0: operand = p[4]; break;
        case 1: operand = variable(p[4].integer()); break;
        case 4: operand = evaluateExpression(p[4].text()); break;
        case 3: operand = gameDataOperand(p[4].integer(), p[5].integer(), p[6].integer(), context); break;
        default: throw std::runtime_error("unsupported variable operand");
      }
      for (int id = p[0].integer(); id <= p[1].integer(); ++id) operateVariable(id, p[2].integer(), operand);
      return true;
    }
    case 123: {
      if (context.eventId <= 0) return true;
      const auto key = selfKey(context.mapId, context.eventId, p[0].text());
      if (p[1].integer() == 0) selfSwitches_[key] = true; else selfSwitches_.erase(key);
      refreshNeeded_ = true; return true;
    }
    case 124:
      if (p[0].integer() == 0) { timerFrames_ = p[1].integer() * 60; timerWorking_ = true; }
      else timerWorking_ = false;
      return true;
    case 125: {
      const double amount = p[1].integer() ? variableNumber(variable(p[2].integer())) : p[2].number();
      if (std::isnan(amount)) throw std::runtime_error("non-numeric gold operand is unsupported");
      gold_ = static_cast<int>(std::clamp(gold_ + (p[0].integer() ? -amount : amount), 0.0, 99999999.0));
      return true;
    }
    case 126: case 127: case 128: {
      const double amount = p[2].integer() ? variableNumber(variable(p[3].integer())) : p[3].number();
      gainItem(code - 126, p[0].integer(), p[1].integer() ? -amount : amount, p[4].boolean());
      return true;
    }
    case 129: {
      const int actor = p[0].integer(); const auto it = std::find(party_.begin(), party_.end(), actor);
      if (p[1].integer() == 0 && it == party_.end()) { if (!actors_.contains(actor) || p[2].boolean()) initializeActor(actor); party_.push_back(actor); }
      else if (p[1].integer() != 0 && it != party_.end()) party_.erase(it);
      updatePlayerGraphic();
      refreshNeeded_ = true; return true;
    }
    case 201: {
      const bool indirect = p[0].integer() != 0;
      pendingTransfer_ = std::array<int, 4>{indirect ? variable(p[1].integer()).integer() : p[1].integer(),
        indirect ? variable(p[2].integer()).integer() : p[2].integer(), indirect ? variable(p[3].integer()).integer() : p[3].integer(), p[4].integer()};
      ++context.index; return false;
    }
    case 204:
      if (!battle_.active && mapState_.scrollRest > 0) { context.waitingScroll = true; return false; }
      return characterEventCommand(entry, context);
    case 205: {
      refreshIfNeeded();
      if (auto* target = routeCharacter(p[0].integer(), context)) {
        const auto& route = p[1];
        if (!target->routeForcing) {
          target->originalRoute = Value::Object{{"list", target->route}, {"repeat", target->routeRepeat}, {"skippable", target->routeSkippable}, {"wait", false}};
          target->originalRouteIndex = target->routeIndex;
        }
        target->route = route["list"].array(); target->routeIndex = 0; target->routeWait = 0;
        target->routeForcing = true; target->routeRepeat = route["repeat"].boolean(); target->routeSkippable = route["skippable"].boolean();
        if (route["wait"].boolean()) context.waitingRoute = p[0].integer();
      }
      return true;
    }
    case 505: return true;
    case 211: player_.transparent = p[0].integer() == 0; return true;
    case 250: audio("se", p[0]); return true;
    case 301: {
      if (battle_.active) return true;
      const int designation = p[0].integer();
      const int troop = designation == 0 ? p[1].integer() : designation == 1 ? static_cast<int>(variableNumber(variable(p[1].integer()))) : makeEncounterTroopId();
      if (!database_["troops"][troop].null()) {
        startBattle(troop,p[2].boolean(),p[3].boolean(),true);
        const int step=map()["encounterStep"].integer(30); encounterCount_=randomInt(step)+randomInt(step)+1;
      }
      return true;
    }
    case 314: case 318: {
      const int actorId = p[0].integer() ? static_cast<int>(variableNumber(lookup(variables_, p[1].integer()))) : p[1].integer();
      if (actorId && !actors_.count(actorId)) initializeActor(actorId);
      const auto selected = actorId ? std::vector<int>{actorId} : party_;
      for (int id : selected) {
        if (code == 314) recover(actors_.at(id));
        else if (p[2].integer() == 0) actors_.at(id).skills.insert(p[3].integer());
        else actors_.at(id).skills.erase(p[3].integer());
      }
      return true;
    }
    case 339:
      enemyEventCommand(entry); context.waitingAction = battle_.forcedExecuting || !battle_.forcedActions.empty(); return true;
    case 353: openGameOver(); return true;
    case 354: openTitle(); return true;
    case 402: if (!context.branches.contains(indent) || context.branches.at(indent) != p[0].integer()) skipBranch(indent, context); return true;
    case 403: if (!context.branches.contains(indent) || context.branches.at(indent) != -2) skipBranch(indent, context); return true;
    case 404: context.branches.erase(indent); return true;
    case 411: if (!context.branches.contains(indent) || context.branches.at(indent)) skipBranch(indent, context); return true;
    case 412: context.branches.erase(indent); return true;
    case 413:
      do {
        if (context.index <= 0) throw std::runtime_error("unmatched loop end");
        --context.index;
      } while (context.list[context.index]["indent"].integer() != indent);
      return true;
    case 601: case 602: case 603: if (lookup(context.branches, indent) != code - 601) skipBranch(indent, context); return true;
    case 604: context.branches.erase(indent); return true;
    case 230: context.wait = p[0].integer(); return true;
    case 355: {
      std::string source = p[0].text();
      while (context.index + 1 < static_cast<int>(context.list.size()) && context.list[context.index + 1]["code"].integer() == 655) {
        ++context.index; source += "\n" + context.list[context.index]["parameters"][0].text();
      }
      executeNativeScript(source, context); return true;
    }
    case 655: return true;
    case 356: return true;
    default:
      if ((code >= 221 && code <= 225) || (code >= 231 && code <= 236)) return screenEventCommand(entry, context);
      if (dialogEventCommand(entry, context) || shopEventCommand(entry, context)) return true;
      if (vehicleEventCommand(entry, context) || animationEventCommand(entry, context)) return true;
      if (actorEventCommand(entry) || enemyEventCommand(entry) || systemEventCommand(entry) || characterEventCommand(entry, context)) return true;
      throw std::runtime_error("unimplemented event command " + std::to_string(code) + " at map " + std::to_string(context.mapId) + " event " + std::to_string(context.eventId) + " index " + std::to_string(context.index));
  }
}
void Session::advanceInterpreter(Interpreter& context) {
  if (!context.running || (battle_.active && !context.battleEvent) || message_.busy) return;
  for (int budget = 0; budget <= 100000; ++budget) {
    if (!context.children.empty()) {
      advanceInterpreter(context.children.front());
      if (context.children.front().running) return;
      context.children.clear();
    }
    if (context.wait > 0) { --context.wait; return; }
    if (context.waitingEffect) {
      if (std::any_of(visualEffects_.begin(),visualEffects_.end(),[&](const VisualEffect& effect){return effect.serial==context.waitingEffect;})) return;
      context.waitingEffect = 0;
    }
    if (context.waitingVideo) {
      if (moviePlaying_) return;
      context.waitingVideo = false;
    }
    if (context.waitingGather) {
      if (followersGathering_) return;
      context.waitingGather = false;
    }
    if (context.waitingAction) {
      if (battle_.forcedExecuting || !battle_.forcedActions.empty()) return;
      context.waitingAction = false;
    }
    if (context.waitingScroll) {
      if (mapState_.scrollRest > 0) return;
      context.waitingScroll = false;
    }
    if (context.waitingRoute) {
      const int id = *context.waitingRoute == 0 ? context.eventId : *context.waitingRoute;
      const auto* target = routeCharacter(id, context);
      if (target && target->routeForcing) return;
      context.waitingRoute.reset();
    }
    if (context.index >= static_cast<int>(context.list.size())) { context.running = false; return; }
    if (!command(context.list[context.index], context)) return;
    ++context.index;
    if (message_.busy || finished_ || (context.battleEvent ? ui_.scene != Scene::battle : ui_.scene != Scene::map)) return;
  }
}
void Session::updateInterpreter() {
  if (battle_.active || message_.busy) return;
  for (int budget = 0; budget < 10000; ++budget) {
    refreshIfNeeded();
    if (!interpreter_.running && reservedCommonEvent_ > 0) {
      const auto& source = database_["commonEvents"][reservedCommonEvent_]; reservedCommonEvent_ = 0;
      if (!source.null()) { interpreter_ = {}; interpreter_.mapId = mapId_; interpreter_.list = source["list"].array(); interpreter_.running = true; }
    }
    if (!interpreter_.running) {
      const auto it = std::find_if(events_.begin(), events_.end(), [&](const Event& event) {
        return event.page >= 0 && (event.starting || event.trigger == 3) &&
          map()["events"][event.id]["pages"][event.page]["list"].array().size() > 1;
      });
      if (it != events_.end()) {
        it->starting = false; startInterpreter(*it);
      } else {
        const Value* automatic = nullptr;
        for (const auto& event : database_["commonEvents"].array()) {
          if (event.null() || event["trigger"].integer() != 1) continue;
          const auto enabled = switches_.find(event["switchId"].integer());
          if (enabled != switches_.end() && enabled->second) { automatic = &event; break; }
        }
        if (!automatic) return;
        interpreter_ = {}; interpreter_.mapId = mapId_;
        interpreter_.list = (*automatic)["list"].array(); interpreter_.running = true;
      }
    }
    advanceInterpreter(interpreter_);
    if (interpreter_.running || message_.busy || battle_.active || finished_ || ui_.scene != Scene::map) return;
    for (auto& event : events_) if (event.id == interpreter_.eventId && event.prelockDirection) {
      if (!event.character.directionFix) event.character.direction = event.prelockDirection;
      event.prelockDirection = 0;
    }
    interpreter_ = {};
  }
}

int Message::pageEnd() const {
  int end = std::min(firstLine + 4, static_cast<int>(lines.size()));
  for (int boundary : pageBreaks) if (boundary > firstLine) { end = std::min(end, boundary); break; }
  return end;
}
void Session::acknowledge(int choice) {
  if (!message_.busy) return;
  if (message_.pageEnd() < static_cast<int>(message_.lines.size())) {
    message_.firstLine = message_.pageEnd(); messageAge_ = 0; return;
  }
  if (!message_.choices.empty()) {
    if (choice == -2 && message_.cancelChoice >= 0) choice = message_.cancelChoice;
    if (choice < 0 && !(choice == -2 && message_.cancelChoice == -2)) throw std::invalid_argument("invalid choice");
    if (choice >= static_cast<int>(message_.choices.size())) throw std::invalid_argument("choice outside list");
    const auto findOwner = [&](auto&& self, Interpreter& root) -> Interpreter* {
      if (root.serial == messageOwnerSerial_) return &root;
      for (auto& child : root.children) if (auto* found = self(self, child)) return found;
      return nullptr;
    };
    Interpreter* owner = findOwner(findOwner, interpreter_);
    if (!owner) owner = findOwner(findOwner, battle_.interpreter);
    for (auto& event : events_) if (!owner) owner = findOwner(findOwner, event.parallel);
    for (auto& [id, common] : commonInterpreters_) { (void)id; if (!owner && common) owner = findOwner(findOwner, *common); }
    if (owner) owner->branches[message_.choiceIndent] = choice;
  }
  message_ = {}; messageOwnerSerial_ = 0;
}
void Session::updateTimer() {
  if (timerWorking_ && timerFrames_ > 0 && --timerFrames_ == 0 && battle_.active) finishBattle(1);
}

void Session::step(const Input& input) {
  if (mapSceneOnly() && !database_["sceneContract"]["interactiveInput"].boolean() && (input.direction || input.ok || input.cancel || input.dash || input.touchTriggered || input.destinationX || input.destinationY))
    throw std::runtime_error("map-scene session does not support interactive input");
  if (finished_) return;
  currentInput_ = input;
  ++ticks_;
  const bool ok = input.okTriggered.value_or(input.ok && !previousOk_); previousOk_ = input.ok;
  const bool cancel = input.cancelTriggered.value_or(input.cancel && !previousCancel_); previousCancel_ = input.cancel;
  if (input.direction != previousDirection_) { previousDirection_ = input.direction; directionAge_ = 0; } else ++directionAge_;
  const int repeatedDirection = input.repeatedDirection.value_or(directionAge_ == 0 || (directionAge_ >= 24 && directionAge_ % 6 == 0) ? input.direction : 0);
  if (ui_.scene == Scene::map || ui_.scene == Scene::battle) updateVisualEffects();
  ++ui_.age;
  if (ui_.scene != Scene::map) {
    destination_.reset(); mapTouchCount_ = 0;
    updateUi(input, ok, cancel, repeatedDirection); updateBattle();
    if (ui_.scene == Scene::battle) { updateTimer(); updateScreenState(); }
    if (ui_.scene == Scene::battle) for (auto& visual : battle_.visuals) {
      const auto& item = database_[visual.action.item ? "items" : "skills"][visual.action.id];
      const auto& animation = database_["animations"][item["animationId"].integer()];
      for (std::size_t i = 0; i < visual.targets.size(); ++i) {
        if (animation["position"].integer() == 3 && i > 0) continue;
        const int age = static_cast<int>(ticks_) - static_cast<int>(visual.started) - 8 - static_cast<int>(i) * 12;
        if (age < 0 || age / 4 == visual.lastAudioFrames[i]) continue;
        visual.lastAudioFrames[i] = age / 4;
        for (const auto& timing : animation["timings"].array()) if (timing["frame"].integer() == age / 4) audio("se", timing["se"]);
      }
    }
    return;
  }
  const bool hadMessage = message_.busy;
  if (message_.busy || cancel) updateUi(input, ok, cancel, repeatedDirection);
  if (ui_.scene != Scene::map) return;
  if (hadMessage && !message_.busy) return;
  updateInterpreter();
  updateMapTouch(input);
  if (!player_.moving()) playerDashing_ = ((input.dash != alwaysDash_) || destination_.has_value()) && !map()["disableDashing"].boolean() && !player_.routeForcing && vehicleType_ < 0;
  if (!interpreter_.running && !message_.busy && !player_.moving() && player_.jumpCount == 0 && !player_.routeForcing && !followersGathering_ && !vehicleGettingOn_ && !vehicleGettingOff_ && (vehicleType_ != 2 || vehicles_[2].altitude >= 48)) {
    const int direction = input.direction ? input.direction : destination_ ? findDirectionTo(player_, (*destination_)[0], (*destination_)[1]) : 0;
    if (direction) {
      if (!move(player_, direction)) startEvent(roundMapX(player_.x + dx(direction)), roundMapY(player_.y + dy(direction)), false);
    } else if (ok && !toggleVehicle()) {
      startEvent(player_.x, player_.y, true);
      startEvent(player_.x + dx(player_.direction), player_.y + dy(player_.direction), true);
      if (tileFlag(player_.x + dx(player_.direction), player_.y + dy(player_.direction), 128) && std::none_of(events_.begin(), events_.end(), [](const Event& event) { return event.starting; })) startEvent(player_.x + dx(player_.direction) * 2, player_.y + dy(player_.direction) * 2, true);
    }
  }
  const double previousX = player_.realX, previousY = player_.realY;
  const bool wasMoving = player_.moving();
  updateCharacter(player_, playerDashing_);
  if (savedCamera_) {
    const auto& tiled = database_["tiledMaps"][std::to_string(mapId_)];
    const double visibleX = database_["sceneContract"]["width"].number(816) / tiled["tilewidth"].number(48);
    const double visibleY = database_["sceneContract"]["height"].number(624) / tiled["tileheight"].number(48);
    const std::array<double, 2> old{previousX, previousY}, now{player_.realX, player_.realY};
    const std::array<double, 2> visible{visibleX, visibleY}, extent{map()["width"].number(), map()["height"].number()};
    for (int axis = 0; axis < 2; ++axis) {
      auto& display = (*savedCamera_)[axis]; const double center = (visible[axis] - 1) / 2;
      const bool loop = axis == 0 ? loopHorizontal() : loopVertical();
      const double movement = axis == 0 ? deltaMapX(now[axis], old[axis]) : deltaMapY(now[axis], old[axis]);
      const double before = loop ? axis == 0 ? deltaMapX(old[axis], display) : deltaMapY(old[axis], display) : old[axis] - display;
      const double after = before + movement;
      if ((movement > 0 && after > center) || (movement < 0 && after < center)) {
        if (loop) display = std::fmod(display + movement + extent[axis], extent[axis]);
        else display = extent[axis] < visible[axis] ? (extent[axis] - visible[axis]) / 2 : std::clamp(display + movement, 0.0, extent[axis] - visible[axis]);
      }
    }
  }
  if (!player_.moving() && destination_) { triggerDestinationAction(); if (!wasMoving) destination_.reset(); }
  updateFollowers();
  updateVehicles();
  for (auto& event : events_) {
    updateCharacter(event.character, false, event.originalPattern);
    if (event.page < 0 || event.trigger != 4) continue;
    if (!event.parallel.running) {
      event.parallel = {}; event.parallel.mapId = mapId_; event.parallel.eventId = event.id;
      event.parallel.list = map()["events"][event.id]["pages"][event.page]["list"].array();
      event.parallel.running = true;
    }
    advanceInterpreter(event.parallel);
  }
  if (wasMoving && !player_.moving()) {
    if (vehicleType_ < 0 && !player_.routeForcing) ++steps_;
    if (!interpreter_.running) {
      for (int id : party_) actorWalk(actors_.at(id));
      startEvent(player_.x, player_.y, false);
      const auto event = std::find_if(events_.begin(), events_.end(), [](const Event& value) { return value.starting; });
      if (event != events_.end()) { event->starting = false; startInterpreter(*event); }
      else if (!message_.busy) advanceEncounter();
    }
  }
  if (!player_.moving()) player_.bushDepth = tileFlag(player_.x, player_.y, 64) && player_.characterName.find('!') >= 2 ? 12 : 0;
  updateCommonEvents();
  updateMapState();
  updateTimer();
  if (pendingTransfer_) {
    const auto target = *pendingTransfer_; pendingTransfer_.reset();
    transfer(target[0], target[1], target[2], target[3]);
  }
  updateScreenState();
}
Value Session::snapshot() const {
  Value::Object switches, variables, selfSwitches, inventory;
  for (const auto& [id, value] : switches_) switches[std::to_string(id)] = value;
  for (const auto& [id, value] : variables_) variables[std::to_string(id)] = value;
  for (const auto& [id, value] : selfSwitches_) selfSwitches[id] = value;
  for (const auto& [id, value] : inventory_) inventory[std::to_string(id)] = value;
  Value::Array party; for (int id : party_) party.emplace_back(id);
  Value::Array events;
  for (const auto& event : events_) events.emplace_back(Value::Object{{"id", event.id}, {"page", event.page}, {"x", event.character.x}, {"y", event.character.y}, {"realX", event.character.realX}, {"realY", event.character.realY}, {"direction", event.character.direction}, {"through", event.character.through}, {"routeForcing", event.character.routeForcing}});
  Value::Array enemies;
  for (const auto& enemy : battle_.enemies) enemies.emplace_back(Value::Object{{"id", enemy.id}, {"hp", enemy.hp}, {"mp", enemy.mp}, {"states", [&] { Value::Array result; for (int state : enemy.states) result.emplace_back(state); return result; }()}});
  Value::Object actors;
  for (const auto& [id, actor] : actors_) {
    Value::Array parameters, states, skills;
    for (int i = 0; i < 8; ++i) parameters.emplace_back(parameter(actor, i));
    for (int state : actor.states) states.emplace_back(state);
    for (int skill : actor.skills) skills.emplace_back(skill);
    actors[std::to_string(id)] = Value::Object{{"hp", actor.hp}, {"mp", actor.mp}, {"tp", actor.tp}, {"level", actor.level}, {"parameters", parameters}, {"states", states}, {"skills", skills}};
  }
  return Value::Object{{"unsupportedAction", unsupportedAction_}, {"camera", savedCamera_ ? Value(Value::Array{(*savedCamera_)[0], (*savedCamera_)[1]}) : Value{}}, {"randomCalls", static_cast<double>(randomCalls_)}, {"battle", Value::Object{{"active", battle_.active}, {"turn", battle_.turn}, {"actorIndex", battle_.actorIndex}, {"wait", battle_.wait}, {"pending", static_cast<int>(battle_.actions.size())}, {"actionStage", battle_.actionStage}, {"enemies", enemies}}}, {"actors", actors}, {"scene", static_cast<int>(ui_.scene)}, {"ui", Value::Object{{"category", ui_.category}, {"cursor", ui_.cursor}, {"skillType", ui_.skillType}}}, {"storage", Value::Object{{"save", saveRequested_}, {"load", loadRequested_}, {"slot", ui_.cursor + 1}}}, {"ticks", static_cast<double>(ticks_)}, {"mapId", mapId_}, {"player", Value::Object{{"x", player_.x}, {"y", player_.y}, {"realX", player_.realX}, {"realY", player_.realY}, {"direction", player_.direction}, {"transparent", player_.transparent}}}, {"events", events}, {"switches", switches}, {"variables", variables}, {"selfSwitches", selfSwitches}, {"inventory", inventory}, {"party", party}, {"interpreter", Value::Object{{"mapId", interpreter_.mapId}, {"eventId", interpreter_.eventId}, {"index", interpreter_.index}, {"wait", interpreter_.wait}, {"running", interpreter_.running}}}, {"message", Value::Object{{"busy", message_.busy}, {"pauseIndex", static_cast<int>(message_.pauseIndex)}, {"age", messageAge_}, {"firstLine", message_.firstLine}, {"pageEnd", message_.pageEnd()}, {"lines", message_.lines}, {"choices", message_.choices}}}};
}
}  // namespace pmjs::mv
