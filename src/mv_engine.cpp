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

class Formula {
 public:
  Formula(const std::string& source, const std::map<std::string, double>& fields)
      : source_(source), fields_(fields) {}
  double evaluate() {
    const auto result = expression();
    whitespace();
    if (offset_ != source_.size()) fail();
    return result;
  }
 private:
  [[noreturn]] void fail() const { throw std::invalid_argument("unsupported damage formula at " + std::to_string(offset_)); }
  void whitespace() { while (offset_ < source_.size() && std::isspace(static_cast<unsigned char>(source_[offset_]))) ++offset_; }
  bool take(char token) {
    whitespace();
    if (offset_ == source_.size() || source_[offset_] != token) return false;
    ++offset_; return true;
  }
  double expression() {
    double value = product();
    for (;;) {
      if (take('+')) value += product();
      else if (take('-')) value -= product();
      else return value;
    }
  }
  double product() {
    double value = atom();
    for (;;) {
      if (take('*')) value *= atom();
      else if (take('/')) value /= atom();
      else return value;
    }
  }
  double atom() {
    if (++depth_ > 64) fail();
    const double result = primary();
    --depth_; return result;
  }
  double primary() {
    whitespace();
    if (take('+')) return atom();
    if (take('-')) return -atom();
    if (take('(')) { const double result = expression(); if (!take(')')) fail(); return result; }
    const auto start = offset_;
    if (offset_ < source_.size() && (std::isdigit(static_cast<unsigned char>(source_[offset_])) || source_[offset_] == '.')) {
      bool digit = false;
      while (offset_ < source_.size() && std::isdigit(static_cast<unsigned char>(source_[offset_]))) { digit = true; ++offset_; }
      if (offset_ < source_.size() && source_[offset_] == '.') {
        ++offset_;
        while (offset_ < source_.size() && std::isdigit(static_cast<unsigned char>(source_[offset_]))) { digit = true; ++offset_; }
      }
      if (!digit) fail();
      return std::stod(source_.substr(start, offset_ - start));
    }
    while (offset_ < source_.size() && (std::isalnum(static_cast<unsigned char>(source_[offset_])) || source_[offset_] == '.')) ++offset_;
    const auto it = fields_.find(source_.substr(start, offset_ - start));
    if (it == fields_.end()) fail();
    return it->second;
  }
  const std::string& source_;
  const std::map<std::string, double>& fields_;
  std::size_t offset_ = 0;
  int depth_ = 0;
};
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
double formula(const std::string& expression, const std::map<std::string, double>& fields) { return Formula(expression, fields).evaluate(); }

Session::Session(Value database) : database_(std::move(database)) {
  const auto kind = database_["sceneContract"]["kind"].text();
  if (!kind.empty() && kind != "map") throw std::invalid_argument("unsupported scene contract");
  if (mapSceneOnly()) return;
  std::map<std::string, double> fields;
  for (const auto* side : {"a", "b"}) for (const auto* stat : {"mhp", "mmp", "atk", "def", "mat", "mdf", "agi", "luk"}) fields[std::string(side) + "." + stat] = 1;
  for (const auto* collection : {"skills", "items"}) for (const auto& item : database_[collection].array()) {
    if (item["damage"]["type"].integer() != 0) {
      try { formula(item["damage"]["formula"].text(), fields); }
      catch (const std::exception& error) { throw std::invalid_argument(std::string(collection) + "[" + std::to_string(item["id"].integer()) + "].damage.formula: " + error.what()); }
    }
  }
}
const Value& Session::map() const { return database_["maps"][std::to_string(mapId_)]; }

void Session::newGame() {
  switches_.clear(); variables_.clear(); selfSwitches_.clear(); inventory_.clear();
  party_.clear(); events_.clear(); interpreter_ = {}; message_ = {}; player_ = {};
  actors_.clear(); battle_ = {}; ui_ = {}; system_ = {}; gold_ = 0; steps_ = 0; brightness_ = 255; fadeOut_ = 0;
  pictures_.clear(); ambience_ = {}; savedCamera_.reset();
  audioCommands_.clear(); previousCancel_ = false; directionAge_ = 0; previousDirection_ = 0;
  savedBgm_ = {}; savedBgs_ = {}; saveRequested_ = false; loadRequested_ = false;
  ticks_ = 0; previousOk_ = false; finished_ = false;
  playerDashing_ = false;
  pendingTransfer_.reset();
  interpreter_.waitingRoute.reset();
  const auto& system = database_["system"];
  for (const auto& id : system["partyMembers"].array()) { party_.push_back(id.integer()); initializeActor(id.integer()); }
  if (!party_.empty()) {
    const auto& actor = database_["actors"][party_[0]];
    player_.characterName = actor["characterName"].text();
    player_.characterIndex = actor["characterIndex"].integer();
  }
  player_.transparent = system["optTransparent"].boolean();
  transfer(system["startMapId"].integer(), system["startX"].integer(), system["startY"].integer(), 2);
}

void Session::transfer(int id, int x, int y, int direction) {
  const auto& target = database_["maps"][std::to_string(id)];
  if (target.null()) throw std::invalid_argument("map not loaded: " + std::to_string(id));
  if (x < 0 || y < 0 || x >= target["width"].integer() || y >= target["height"].integer()) throw std::invalid_argument("transfer outside map");
  mapId_ = id; player_.x = x; player_.y = y; player_.realX = x; player_.realY = y;
  if (direction) player_.direction = direction;
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
    event.trigger = p["trigger"].integer(); event.priority = p["priorityType"].integer();
    event.character.transparent = false; event.character.through = p["through"].boolean();
    event.character.directionFix = p["directionFix"].boolean();
    event.character.walkAnime = p["walkAnime"].boolean(); event.character.stepAnime = p["stepAnime"].boolean();
    event.character.moveSpeed = p["moveSpeed"].integer(3);
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
}

bool Session::tilePassage(int x, int y, int bit) const {
  const auto& tiled = database_["tiledMaps"][std::to_string(mapId_)];
  if (!tiled.null()) {
    const int width = tiled["width"].integer(), height = tiled["height"].integer();
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    if (tiled["passage"].array().size() != static_cast<std::size_t>(width * height))
      throw std::runtime_error("tile collision data is unavailable");
    return !(tiled["passage"][y * width + x].integer() & bit);
  }
  const int width = map()["width"].integer(), height = map()["height"].integer();
  const auto& flags = database_["tilesets"][map()["tilesetId"].integer()]["flags"];
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
  const int nx = x + dx(direction), ny = y + dy(direction);
  if (nx < 0 || ny < 0 || nx >= map()["width"].integer() || ny >= map()["height"].integer()) return false;
  if (character.through) return true;
  const int bit = 1 << (direction / 2 - 1), reverse = 1 << ((10 - direction) / 2 - 1);
  if (!tilePassage(x, y, bit) || !tilePassage(nx, ny, reverse)) return false;
  for (const auto& event : events_) if (event.page >= 0 && &event.character != &character && !event.character.through && event.priority == 1 && event.character.x == nx && event.character.y == ny) return false;
  return true;
}
bool Session::tileFlag(int x, int y, int flag) const {
  const auto& flags = database_["tilesets"][map()["tilesetId"].integer()]["flags"];
  const int width = map()["width"].integer(), height = map()["height"].integer();
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  for (int z = 0; z < 4; ++z) if (flags[map()["data"][(z * height + y) * width + x].integer()].integer() & flag) return true;
  return false;
}

bool Session::move(Character& character, int direction) {
  if (direction != 2 && direction != 4 && direction != 6 && direction != 8) return false;
  if (!character.directionFix) character.direction = direction;
  if (!passable(character.x, character.y, direction, character)) return false;
  if (&character == &player_) {
    for (int i = 2; i >= 0; --i) {
      auto& follower = followers_[i]; const auto& leader = i == 0 ? player_ : followers_[i - 1];
      const int sx = leader.x == follower.x ? 0 : leader.x > follower.x ? 1 : -1;
      const int sy = leader.y == follower.y ? 0 : leader.y > follower.y ? 1 : -1;
      follower.x += sx; follower.y += sy;
      if (sx && sy) { if (follower.direction == (sx > 0 ? 4 : 6)) follower.direction = sx > 0 ? 6 : 4; if (follower.direction == (sy > 0 ? 8 : 2)) follower.direction = sy > 0 ? 2 : 8; }
      else if (sx || sy) follower.direction = sy ? sy > 0 ? 2 : 8 : sx > 0 ? 6 : 4;
    }
  }
  character.x += dx(direction); character.y += dy(direction); character.stopCount = 0;
  return true;
}
void Session::updateCharacter(Character& c, bool dash, int idlePattern) {
  if (!c.moving() && c.routeForcing) updateRoute(c);
  const bool wasMoving = c.moving();
  if (wasMoving) {
    const double scale = database_["tiledMaps"][std::to_string(mapId_)]["movementScale"].number(1);
    const double distance = std::pow(2.0, c.moveSpeed + (dash ? 1 : 0)) / 256 * scale;
    c.realX = c.realX < c.x ? std::min(c.realX + distance, static_cast<double>(c.x)) : std::max(c.realX - distance, static_cast<double>(c.x));
    c.realY = c.realY < c.y ? std::min(c.realY + distance, static_cast<double>(c.y)) : std::max(c.realY - distance, static_cast<double>(c.y));
  } else ++c.stopCount;
  if (wasMoving && c.walkAnime) c.animationCount += 1.5;
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
  if (c.routeIndex >= static_cast<int>(c.route.size())) throw std::runtime_error("movement route missing terminator");
  const auto& instruction = c.route[c.routeIndex];
  switch (instruction["code"].integer()) {
    case 0:
      if (c.routeRepeat) c.routeIndex = -1;
      else {
        c.routeForcing = false;
        c.route = c.originalRoute["list"].array(); c.routeIndex = c.originalRouteIndex;
        c.routeRepeat = c.originalRoute["repeat"].boolean(); c.routeSkippable = c.originalRoute["skippable"].boolean(); c.originalRoute = {};
        return;
      }
      break;
    case 15: c.routeWait = instruction["parameters"][0].integer() - 1; break;
    case 17: if (!c.directionFix) c.direction = 4; break;
    case 18: if (!c.directionFix) c.direction = 6; break;
    case 36: c.directionFix = false; break;
    default: throw std::runtime_error("unsupported movement route command");
  }
  ++c.routeIndex;
}

void Session::startEvent(int x, int y, bool action) {
  for (auto& e : events_) {
    if (e.page >= 0 && e.character.x == x && e.character.y == y &&
        ((action && e.trigger == 0) || (!action && (e.trigger == 1 || e.trigger == 2)))) {
      const bool samePosition = x == player_.x && y == player_.y;
      if (samePosition == (e.priority == 1)) continue;
      if (map()["events"][e.id]["pages"][e.page]["list"].array().size() <= 1) continue;
      if (!e.prelockDirection && e.trigger <= 2) {
        e.prelockDirection = e.character.direction;
        if (!e.character.directionFix) {
          const int horizontal = player_.x - e.character.x, vertical = player_.y - e.character.y;
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
        if ((slot == 0 ? 1 : 2) == kind && actor.equips[slot] == id) {
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
      if (second == 1) throw std::runtime_error("actor EXP operand is unsupported");
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
    throw std::runtime_error("character screen-coordinate operand is unsupported");
  }
  if (type == 6) return first >= 0 && first < static_cast<int>(party_.size()) ? party_[first] : 0;
  if (type == 7) {
    switch (first) {
      case 0: return mapId_;
      case 1: return static_cast<int>(party_.size());
      case 2: return gold_;
      case 3: return steps_;
      case 4: return static_cast<double>((ticks_ ? ticks_ - 1 : 0) / 60);
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
  if (p[0].integer() == 4) {
    const int id = p[1].integer(), argument = p[3].integer();
    if (database_["actors"][id].null()) return false;
    if (!actors_.contains(id)) initializeActor(id);
    const auto& actor = actors_.at(id);
    switch (p[2].integer()) {
      case 0: return std::find(party_.begin(), party_.end(), id) != party_.end();
      case 3: return actor.skills.contains(argument);
      case 4: return !actor.equips.empty() && actor.equips[0] == argument && !database_["weapons"][argument].null();
      case 5: return std::find(actor.equips.begin() + std::min<std::size_t>(1, actor.equips.size()), actor.equips.end(), argument) != actor.equips.end() && !database_["armors"][argument].null();
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
      const auto& equips = actors_.at(actorId).equips;
      for (std::size_t slot = 0; slot < equips.size(); ++slot) if ((slot == 0 ? 1 : 2) == kind && equips[slot] == id) return true;
    }
    return false;
  }
  throw std::runtime_error("unsupported conditional branch");
}

bool Session::command(const Value& entry, Interpreter& context) {
  const int code = entry["code"].integer(), indent = entry["indent"].integer();
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
      child.depth = context.depth + 1;
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
        message_.defaultChoice = choices[2].integer(); message_.choiceIndent = context.list[context.index]["indent"].integer();
        ui_.cursor = message_.defaultChoice;
      }
      return true;
    case 102: message_ = {}; message_.busy = true; messageAge_ = 0; ui_.cursor = p[2].integer(); message_.choices = p[0].array(); message_.cancelChoice = p[1].integer(); message_.defaultChoice = p[2].integer(); message_.choiceIndent = indent; return true;
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
    case 221: fadeOut_ = 24; context.wait = 24; return true;
    case 250: audio("se", p[0]); return true;
    case 301:
      if (p[0].integer() != 0) throw std::runtime_error("unsupported battle designation");
      startBattle(p[1].integer(), p[2].boolean(), p[3].boolean(), true); return true;
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
    default: throw std::runtime_error("unimplemented event command " + std::to_string(code) + " at map " + std::to_string(context.mapId) + " event " + std::to_string(context.eventId) + " index " + std::to_string(context.index));
  }
}
void Session::advanceInterpreter(Interpreter& context) {
  if (!context.running || battle_.active || message_.busy) return;
  for (int budget = 0; budget <= 100000; ++budget) {
    if (!context.children.empty()) {
      advanceInterpreter(context.children.front());
      if (context.children.front().running) return;
      context.children.clear();
    }
    if (context.wait > 0) { --context.wait; return; }
    if (context.waitingRoute) {
      const int id = *context.waitingRoute == 0 ? context.eventId : *context.waitingRoute;
      const auto* target = routeCharacter(id, context);
      if (target && target->routeForcing) return;
      context.waitingRoute.reset();
    }
    if (context.index >= static_cast<int>(context.list.size())) { context.running = false; return; }
    if (!command(context.list[context.index], context)) return;
    ++context.index;
    if (message_.busy || finished_ || ui_.scene != Scene::map) return;
  }
}
void Session::updateInterpreter() {
  if (battle_.active || message_.busy) return;
  for (int budget = 0; budget < 10000; ++budget) {
    refreshIfNeeded();
    if (!interpreter_.running) {
      auto it = std::find_if(events_.begin(), events_.end(), [&](const Event& e) { return e.page >= 0 && (e.starting || e.trigger == 3) && map()["events"][e.id]["pages"][e.page]["list"].array().size() > 1; });
      if (it == events_.end()) return;
      it->starting = false; startInterpreter(*it);
    }
    advanceInterpreter(interpreter_);
    if (interpreter_.running) return;
    for (auto& event : events_) if (event.id == interpreter_.eventId && event.prelockDirection) {
      if (!event.character.directionFix) event.character.direction = event.prelockDirection;
      event.prelockDirection = 0;
    }
    interpreter_ = {};
  }
  throw std::runtime_error("event execution limit exceeded");
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
    Interpreter* owner = &interpreter_;
    while (!owner->children.empty()) owner = &owner->children.front();
    owner->branches[message_.choiceIndent] = choice;
  }
  message_ = {};
}
void Session::step(const Input& input) {
  if (mapSceneOnly() && !database_["sceneContract"]["interactiveInput"].boolean() && (input.direction || input.ok || input.cancel || input.dash))
    throw std::runtime_error("map-scene session does not support interactive input");
  if (finished_) return;
  ++ticks_;
  const bool ok = input.okTriggered.value_or(input.ok && !previousOk_); previousOk_ = input.ok;
  const bool cancel = input.cancelTriggered.value_or(input.cancel && !previousCancel_); previousCancel_ = input.cancel;
  if (input.direction != previousDirection_) { previousDirection_ = input.direction; directionAge_ = 0; } else ++directionAge_;
  const int repeatedDirection = input.repeatedDirection.value_or(directionAge_ == 0 || (directionAge_ >= 24 && directionAge_ % 6 == 0) ? input.direction : 0);
  ++ui_.age;
  if (ui_.scene != Scene::map) {
    updateUi(input, ok, cancel, repeatedDirection); updateBattle();
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
  if (!player_.moving()) playerDashing_ = (input.dash != alwaysDash_) && !map()["disableDashing"].boolean() && !player_.routeForcing;
  if (!interpreter_.running && !message_.busy && !player_.moving() && !player_.routeForcing) {
    if (input.direction) {
      if (!move(player_, input.direction)) startEvent(player_.x + dx(input.direction), player_.y + dy(input.direction), false);
    } else if (ok) {
      startEvent(player_.x, player_.y, true);
      startEvent(player_.x + dx(player_.direction), player_.y + dy(player_.direction), true);
      if (tileFlag(player_.x + dx(player_.direction), player_.y + dy(player_.direction), 128) && std::none_of(events_.begin(), events_.end(), [](const Event& event) { return event.starting; })) startEvent(player_.x + dx(player_.direction) * 2, player_.y + dy(player_.direction) * 2, true);
    }
  }
  const double previousX = player_.realX, previousY = player_.realY;
  const bool wasMoving = player_.moving();
  updateCharacter(player_, playerDashing_);
  if (savedCamera_ && database_["sceneContract"]["interactiveInput"].boolean()) {
    const auto& tiled = database_["tiledMaps"][std::to_string(mapId_)];
    const double visibleX = database_["sceneContract"]["width"].number() / tiled["tilewidth"].number(48);
    const double visibleY = database_["sceneContract"]["height"].number() / tiled["tileheight"].number(48);
    const std::array<double, 2> old{previousX, previousY}, now{player_.realX, player_.realY};
    const std::array<double, 2> visible{visibleX, visibleY}, extent{map()["width"].number(), map()["height"].number()};
    for (int axis = 0; axis < 2; ++axis) {
      auto& display = (*savedCamera_)[axis]; const double center = (visible[axis] - 1) / 2;
      const double before = old[axis] - display, after = now[axis] - display;
      if ((after > before && after > center) || (after < before && after < center))
        display = std::clamp(display + after - before, 0.0, std::max(0.0, extent[axis] - visible[axis]));
    }
  }
  for (std::size_t i = 0; i < followers_.size(); ++i) {
    auto& follower = followers_[i]; follower.moveSpeed = player_.moveSpeed;
    follower.transparent = player_.transparent || !database_["system"]["optFollowers"].boolean() || i + 1 >= party_.size();
    if (i + 1 < party_.size()) { const auto& source = database_["actors"][party_[i + 1]]; follower.characterName = source["characterName"].text(); follower.characterIndex = source["characterIndex"].integer(); }
    updateCharacter(follower, playerDashing_);
  }
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
    ++steps_;
    if (!interpreter_.running) {
      for (int id : party_) {
        auto& actor = actors_.at(id);
        if (actor.hp > 0 && tileFlag(player_.x, player_.y, 256)) {
          const int damage = std::min(static_cast<int>(std::floor(10 * trait(actor, 23, 8, true))), std::max(0, actor.hp - (database_["system"]["optFloorDeath"].boolean() ? 0 : 1)));
          actor.hp -= damage; refreshBattler(actor);
        }
        if (steps_ % 20 == 0) endBattlerTurn(actor);
      }
      startEvent(player_.x, player_.y, false);
      const auto event = std::find_if(events_.begin(), events_.end(), [](const Event& value) { return value.starting; });
      if (event != events_.end()) { event->starting = false; startInterpreter(*event); }
      else if (!message_.busy) advanceEncounter();
    }
  }
  if (!player_.moving()) player_.bushDepth = tileFlag(player_.x, player_.y, 64) && player_.characterName.find('!') >= 2 ? 12 : 0;
  if (pendingTransfer_) {
    const auto target = *pendingTransfer_; pendingTransfer_.reset();
    transfer(target[0], target[1], target[2], target[3]);
  }
  if (fadeOut_ > 0) { brightness_ = brightness_ * (fadeOut_ - 1) / fadeOut_; --fadeOut_; }
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
