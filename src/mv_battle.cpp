#include "mv_engine.hpp"

#include <algorithm>
#include <cmath>
#include <numeric>
#include <stdexcept>

namespace pmjs::mv {
namespace {
bool contains(const std::vector<int>& values, int id) { return std::find(values.begin(), values.end(), id) != values.end(); }
int jsRound(double value) { return static_cast<int>(std::floor(value + 0.5)); }
}

void Session::setRandomStream(std::vector<double> values) {
  if (std::any_of(values.begin(), values.end(), [](double x) { return !std::isfinite(x) || x < 0 || x >= 1; })) throw std::invalid_argument("random values must be in [0,1)");
  randomStream_ = std::move(values); randomOffset_ = 0; randomCalls_ = 0;
}
double Session::random() {
  ++randomCalls_;
  if (!randomStream_.empty()) {
    if (randomOffset_ == randomStream_.size()) throw std::runtime_error("recorded random stream exhausted");
    return randomStream_[randomOffset_++];
  }
  return std::generate_canonical<double, 53>(randomGenerator_);
}
int Session::randomInt(int maximum) { return maximum > 0 ? static_cast<int>(std::floor(random() * maximum)) : 0; }

void Session::initializeActor(int id) {
  const auto& source = database_["actors"][id];
  if (source.null()) throw std::invalid_argument("unknown actor " + std::to_string(id));
  Battler value; value.id = id; value.level = source["initialLevel"].integer(1);
  for (const auto& item : source["equips"].array()) value.equips.push_back(item.integer());
  value.equips.resize(5);
  actors_[id] = value;
  auto& result = actors_.at(id);
  for (std::size_t slot = 0; slot < result.equips.size(); ++slot) if (result.equips[slot] && !canEquip(result, database_[slot == 0 ? "weapons" : "armors"][result.equips[slot]], static_cast<int>(slot))) result.equips[slot] = 0;
  const auto& klass = database_["classes"][source["classId"].integer()];
  for (const auto& learning : klass["learnings"].array()) if (learning["level"].integer() <= result.level) result.skills.insert(learning["skillId"].integer());
  recover(result);
}
std::vector<const Value*> Session::traitObjects(const Battler& battler) const {
  std::vector<const Value*> result;
  if (battler.enemy) result.push_back(&database_["enemies"][battler.id]);
  else {
    const auto& source = database_["actors"][battler.id];
    result.push_back(&source); result.push_back(&database_["classes"][source["classId"].integer()]);
    for (std::size_t i = 0; i < battler.equips.size(); ++i) if (battler.equips[i]) result.push_back(&database_[i == 0 ? "weapons" : "armors"][battler.equips[i]]);
  }
  for (int id : battler.states) result.push_back(&database_["states"][id]);
  return result;
}
double Session::trait(const Battler& battler, int code, int id, bool product) const {
  double result = product ? 1 : 0;
  for (const auto* object : traitObjects(battler)) for (const auto& entry : (*object)["traits"].array()) {
    if (entry["code"].integer() == code && entry["dataId"].integer() == id) {
      if (product) result *= entry["value"].number(); else result += entry["value"].number();
    }
  }
  return result;
}
double Session::parameter(const Battler& battler, int id) const {
  if (id < 0 || id > 7) throw std::invalid_argument("invalid battler parameter");
  double base;
  if (battler.enemy) base = database_["enemies"][battler.id]["params"][id].number();
  else {
    const auto& source = database_["actors"][battler.id];
    base = database_["classes"][source["classId"].integer()]["params"][id][battler.level].number();
    for (std::size_t i = 0; i < battler.equips.size(); ++i) if (battler.equips[i]) base += database_[i == 0 ? "weapons" : "armors"][battler.equips[i]]["params"][id].number();
  }
  base += battler.paramPlus[id];
  const double value = base * trait(battler, 21, id, true) * (1 + battler.buffs[id] * 0.25);
  return jsRound(std::clamp(value, id == 0 ? 1.0 : 0.0, id == 0 && battler.enemy ? 999999.0 : id < 2 ? 9999.0 : 999.0));
}
int Session::restriction(const Battler& battler) const {
  int result = 0;
  for (int id : battler.states) result = std::max(result, database_["states"][id]["restriction"].integer());
  return result;
}
void Session::recover(Battler& battler) {
  battler.states.clear(); battler.stateTurns.clear(); battler.buffs.fill(0); battler.buffTurns.fill(0);
  battler.hp = static_cast<int>(parameter(battler, 0)); battler.mp = static_cast<int>(parameter(battler, 1));
}
void Session::refreshBattler(Battler& battler) {
  battler.hp = std::clamp(battler.hp, 0, static_cast<int>(parameter(battler, 0)));
  battler.mp = std::clamp(battler.mp, 0, static_cast<int>(parameter(battler, 1)));
  battler.tp = std::clamp(battler.tp, 0, 100);
  if (!battler.hp && !contains(battler.states, 1)) {
    battler.states.clear(); battler.stateTurns.clear(); battler.buffs.fill(0); battler.buffTurns.fill(0); battler.states.push_back(1);
    const auto& state = database_["states"][1];
    battler.stateTurns[1] = state["minTurns"].integer(1) + randomInt(1 + state["maxTurns"].integer(1) - state["minTurns"].integer(1));
  } else if (battler.hp > 0) removeState(battler, 1);
}
void Session::removeState(Battler& battler, int state) {
  if (state == 1 && contains(battler.states, 1)) battler.hp = std::max(1, battler.hp);
  battler.states.erase(std::remove(battler.states.begin(), battler.states.end(), state), battler.states.end());
  battler.stateTurns.erase(state);
}
void Session::addState(Battler& battler, int state) {
  if (state <= 0 || database_["states"][state].null()) return;
  if (battler.hp <= 0) return;
  for (const auto* object : traitObjects(battler)) for (const auto& entry : (*object)["traits"].array()) if (entry["code"].integer() == 14 && entry["dataId"].integer() == state) return;
  if (!contains(battler.states, state)) {
    if (state == 1) { battler.states.clear(); battler.stateTurns.clear(); battler.buffs.fill(0); battler.buffTurns.fill(0); }
    battler.states.push_back(state);
  }
  std::stable_sort(battler.states.begin(), battler.states.end(), [&](int a, int b) { const auto pa = database_["states"][a]["priority"].integer(), pb = database_["states"][b]["priority"].integer(); return pa != pb ? pa > pb : a < b; });
  const auto& source = database_["states"][state];
  battler.stateTurns[state] = source["minTurns"].integer() + randomInt(1 + source["maxTurns"].integer() - source["minTurns"].integer());
  if (state == 1) battler.hp = 0;
  refreshBattler(battler);
}
bool Session::canUse(const Battler& battler, const Value& item) const {
  if (battler.hp <= 0 || restriction(battler) >= 4) return false;
  const int occasion = item["occasion"].integer();
  if (occasion == 3 || (occasion == 1 && !battle_.active) || (occasion == 2 && battle_.active)) return false;
  if (!item["stypeId"].null()) {
    if (battler.mp < static_cast<int>(std::floor(item["mpCost"].number() * trait(battler, 23, 4, true))) || battler.tp < item["tpCost"].integer()) return false;
    for (const auto* object : traitObjects(battler)) for (const auto& entry : (*object)["traits"].array()) {
      if (entry["code"].integer() == 42 && entry["dataId"].integer() == item["stypeId"].integer()) return false;
      if (entry["code"].integer() == 44 && entry["dataId"].integer() == item["id"].integer()) return false;
    }
  }
  return true;
}

void Session::apply(Battler& subject, Battler& target, const Value& item) {
  subject.result = {}; target.result = {};
  auto& result = target.result;
  result.used = canApply(target, item);
  if (!result.used) { (void)random(); return; }
  if (target.hidden || target.escaped) return;
  const int scope = item["scope"].integer();
  if ((scope == 9 || scope == 10) != (target.hp == 0)) return;
  const int hitType = item["hitType"].integer();
  const double success = item["successRate"].number(100) / 100 * (hitType == 1 ? trait(subject, 22, 0, false) : 1);
  if (random() >= success) { result.missed = true; battle_.log.push_back("Miss!"); return; }
  const double evasion = hitType == 1 ? trait(target, 22, 1, false) : hitType == 2 ? trait(target, 22, 4, false) : 0;
  if (random() < evasion) { result.evaded = true; battle_.log.push_back("Evaded!"); return; }
  const auto& damage = item["damage"];
  if (damage["type"].integer()) {
    const bool critical = random() < (damage["critical"].boolean() ? trait(subject, 22, 2, false) * (1 - trait(target, 22, 3, false)) : 0);
    result.critical = critical;
    std::map<std::string, double> fields;
    const std::array<const char*, 8> names{"mhp", "mmp", "atk", "def", "mat", "mdf", "agi", "luk"};
    for (int i = 0; i < 8; ++i) { fields[std::string("a.") + names[i]] = parameter(subject, i); fields[std::string("b.") + names[i]] = parameter(target, i); }
    double value = std::max(0.0, formula(damage["formula"].text(), fields));
    const int type = damage["type"].integer();
    if (type == 3 || type == 4) value = -value;
    double elementRate = 1;
    if (damage["elementId"].integer() >= 0) elementRate = trait(target, 11, damage["elementId"].integer(), true);
    else {
      std::vector<int> elements;
      for (const auto* object : traitObjects(subject)) for (const auto& entry : (*object)["traits"].array()) if (entry["code"].integer() == 31) elements.push_back(entry["dataId"].integer());
      if (!elements.empty()) { elementRate = 0; for (int id : elements) elementRate = std::max(elementRate, trait(target, 11, id, true)); }
    }
    value *= elementRate;
    if (hitType == 1) value *= trait(target, 23, 6, true);
    if (hitType == 2) value *= trait(target, 23, 7, true);
    if (value < 0) value *= trait(target, 23, 2, true);
    if (critical) value *= 3;
    const int amplitude = static_cast<int>(std::floor(std::abs(value) * damage["variance"].number() / 100));
    const int variation = randomInt(amplitude + 1) + randomInt(amplitude + 1) - amplitude;
    value += value >= 0 ? variation : -variation;
    bool guarding = false;
    for (const auto* object : traitObjects(target)) for (const auto& entry : (*object)["traits"].array()) if (entry["code"].integer() == 62 && entry["dataId"].integer() == 1) guarding = true;
    if (value > 0 && guarding && restriction(target) < 4) value /= 2 * trait(target, 23, 1, true);
    const int amount = jsRound(value);
    if (type == 1 || type == 3 || type == 5) {
      const int actual = type == 5 ? std::min(amount, target.hp) : amount;
      result.hpAffected = true; result.hpDamage = actual;
      target.hp -= actual;
      refreshBattler(target);
      if (actual > 0) {
        auto states = target.states;
        for (int state : states) { const auto& source = database_["states"][state]; if (source["removeByDamage"].boolean() && random() < source["chanceByDamage"].number() / 100) removeState(target, state); }
        target.tp += static_cast<int>(std::floor(50.0 * actual / parameter(target, 0) * trait(target, 23, 5, true)));
      }
      if (type == 5) subject.hp += actual;
    } else {
      const int actual = std::min(amount, target.mp);
      result.mpDamage = actual;
      target.mp -= actual; if (type == 6) subject.mp += actual;
    }
    battle_.log.push_back(std::to_string(amount));
    refreshBattler(target); refreshBattler(subject);
  }
  for (const auto& effect : item["effects"].array()) {
    const int code = effect["code"].integer(), id = effect["dataId"].integer();
    const double rec = trait(target, 23, 2, true), pha = item["stypeId"].null() ? trait(subject, 23, 3, true) : 1;
    if (code == 11) {
      const int value = static_cast<int>(std::floor((parameter(target, 0) * effect["value1"].number() + effect["value2"].number()) * rec * pha));
      if (value) { result.hpAffected = true; result.hpDamage = -value; target.hp += value; }
    } else if (code == 12) {
      const int value = static_cast<int>(std::floor((parameter(target, 1) * effect["value1"].number() + effect["value2"].number()) * rec * pha));
      result.mpDamage = -value; target.mp += value;
    }
    else if (code == 21) {
      std::vector<int> states;
      if (id) states.push_back(id);
      else for (const auto* object : traitObjects(subject)) for (const auto& entry : (*object)["traits"].array()) if (entry["code"].integer() == 32) states.push_back(entry["dataId"].integer());
      for (int state : states) {
        double chance = effect["value1"].number();
        if (!id || hitType != 0) chance *= trait(target, 13, state, true) * std::max(1 + (parameter(subject, 7) - parameter(target, 7)) * 0.001, 0.0);
        if (!id) chance *= trait(subject, 32, state, false);
        if (random() < chance) addState(target, state);
      }
    } else if (code == 41) { target.escaped = true; target.states.clear(); target.stateTurns.clear(); }
    else throw std::runtime_error("unsupported item effect " + std::to_string(code));
    refreshBattler(target);
  }
  subject.tp += static_cast<int>(std::floor(item["tpGain"].number() * trait(subject, 23, 5, true)));
  refreshBattler(subject);
}

void Session::startBattle(int troop, bool canEscape, bool canLose, bool event) {
  if (mapSceneOnly()) throw std::runtime_error("battle is outside the map-scene contract");
  if (database_["troops"][troop].null()) throw std::invalid_argument("unknown troop");
  ++system_.battleCount;
  battle_ = {}; battle_.active = true; battle_.troopId = troop; battle_.canEscape = canEscape; battle_.canLose = canLose; battle_.event = event;
  for (const auto& member : database_["troops"][troop]["members"].array()) {
    Battler enemy; enemy.enemy = true; enemy.id = member["enemyId"].integer(); enemy.hidden = member["hidden"].boolean();
    recover(enemy); battle_.enemies.push_back(enemy);
  }
  double actorsAgi = 0, enemiesAgi = 0;
  for (int id : party_) { auto& value = actors_.at(id); value.tp = randomInt(25); value.escaped = false; actorsAgi += parameter(value, 6); }
  for (auto& value : battle_.enemies) { value.tp = randomInt(25); enemiesAgi += parameter(value, 6); }
  actorsAgi /= std::max<std::size_t>(1, party_.size()); enemiesAgi /= std::max<std::size_t>(1, battle_.enemies.size());
  battle_.escapeRatio = 0.5 * actorsAgi / std::max(1.0, enemiesAgi);
  ui_ = {}; ui_.scene = Scene::battle;
  battle_.mapBgm = savedBgm_; battle_.mapBgs = savedBgs_;
  audio("battle-save", {});
  audio("bgs", Value::Object{{"name", ""}});
  audio("bgm", database_["system"]["battleBgm"]);
  battle_.opening = true; ui_.category = 4;
  message_ = {}; messageAge_ = 0;
  std::set<std::string> names;
  for (const auto& enemy : battle_.enemies) if (!enemy.hidden) {
    const auto name = database_["enemies"][enemy.id]["name"].text();
    if (names.insert(name).second) message_.lines.emplace_back(battleMessage("emerge", {name}));
  }
  message_.busy = !message_.lines.empty();
}
std::vector<int> Session::battleSelectableTargets(const Value& item) const {
  std::vector<int> targets;
  const int scope = item["scope"].integer();
  if (scope >= 1 && scope <= 6) {
    for (std::size_t i = 0; i < battle_.enemies.size(); ++i) {
      const auto& enemy = battle_.enemies[i];
      if (enemy.hp > 0 && !enemy.hidden && !enemy.escaped) targets.push_back(static_cast<int>(i));
    }
  } else for (std::size_t i = 0; i < party_.size(); ++i) {
    const auto& actor = actors_.at(party_[i]);
    if (!actor.escaped && (actor.hp <= 0) == (scope == 9 || scope == 10)) targets.push_back(static_cast<int>(i));
  }
  return targets;
}
std::vector<int> Session::battleSkillTypes(int actorIndex) const {
  std::set<int> types;
  for (const auto* object : traitObjects(actors_.at(party_.at(actorIndex))))
    for (const auto& entry : (*object)["traits"].array())
      if (entry["code"].integer() == 41) types.insert(entry["dataId"].integer());
  return {types.begin(), types.end()};
}
void Session::makeEnemyActions() {
  battle_.actions.clear(); battle_.actorIndex = 0; ui_.category = 4; ui_.cursor = 0;
  for (auto& [id, value] : actors_) { (void)id; value.guarding = false; }
  for (std::size_t index = 0; index < battle_.enemies.size(); ++index) {
    auto& enemy = battle_.enemies[index]; enemy.guarding = false;
    if (enemy.hp <= 0 || enemy.hidden || enemy.escaped || restriction(enemy) >= 4) continue;
    if (restriction(enemy) > 0) { battle_.actions.push_back({true, false, static_cast<int>(index), 1, -1, 0}); continue; }
    std::vector<const Value*> eligible;
    int maximum = 0;
    for (const auto& entry : database_["enemies"][enemy.id]["actions"].array()) {
      const int type = entry["conditionType"].integer(); const double a = entry["conditionParam1"].number(), b = entry["conditionParam2"].number();
      bool valid = type == 0;
      if (type == 1) valid = b == 0 ? battle_.turn == a : battle_.turn > 0 && battle_.turn >= a && std::fmod(battle_.turn, b) == std::fmod(a, b);
      if (type == 2) valid = enemy.hp / parameter(enemy, 0) >= a && enemy.hp / parameter(enemy, 0) <= b;
      if (type == 3) valid = enemy.mp / std::max(1.0, parameter(enemy, 1)) >= a && enemy.mp / std::max(1.0, parameter(enemy, 1)) <= b;
      if (type == 4) valid = contains(enemy.states, static_cast<int>(a));
      if (type == 5) { valid = false; for (int id : party_) valid = valid || actors_.at(id).level >= a; }
      if (type == 6) { const auto it = switches_.find(static_cast<int>(a)); valid = it != switches_.end() && it->second; }
      if (valid && canUse(enemy, database_["skills"][entry["skillId"].integer()])) { eligible.push_back(&entry); maximum = std::max(maximum, entry["rating"].integer()); }
    }
    int total = 0;
    for (auto* entry : eligible) total += std::max(0, (*entry)["rating"].integer() - (maximum - 3));
    int selection = randomInt(total);
    for (auto* entry : eligible) {
      selection -= std::max(0, (*entry)["rating"].integer() - (maximum - 3));
      if (selection < 0) { battle_.actions.push_back({true, false, static_cast<int>(index), (*entry)["skillId"].integer(), -1, 0}); break; }
    }
  }
  for (std::size_t index = 0; index < party_.size(); ++index) {
    const auto& actor = actors_.at(party_[index]);
    if (actor.hp > 0 && restriction(actor) > 0 && restriction(actor) < 4) battle_.actions.push_back({false, false, static_cast<int>(index), 1, -1, 0});
  }
  while (battle_.actorIndex < static_cast<int>(party_.size()) && (actors_.at(party_[battle_.actorIndex]).hp <= 0 || restriction(actors_.at(party_[battle_.actorIndex])) > 0)) ++battle_.actorIndex;
  if (battle_.actorIndex == static_cast<int>(party_.size())) beginTurn();
}
void Session::chooseAction(int actorIndex, int id, int target, bool item) {
  if (!battle_.active || battle_.opening || message_.busy || battle_.wait || actorIndex != battle_.actorIndex || actorIndex < 0 || actorIndex >= static_cast<int>(party_.size())) throw std::invalid_argument("battle is not accepting this action");
  auto& subject = actors_.at(party_[actorIndex]);
  const auto& source = database_[item ? "items" : "skills"][id];
  if (source.null() || !canUse(subject, source) || (item && inventory_[id] <= 0)) throw std::invalid_argument("unavailable action");
  if (!item && id != 1 && id != 2 && !subject.skills.contains(id)) throw std::invalid_argument("unlearned skill");
  battle_.actions.erase(std::remove_if(battle_.actions.begin(), battle_.actions.end(), [&](const Action& action) { return !action.enemy && action.subject == actorIndex; }), battle_.actions.end());
  battle_.actions.push_back({false, item, actorIndex, id, target, 0});
  battle_.actorIndex = actorIndex + 1;
  while (battle_.actorIndex < static_cast<int>(party_.size()) && (actors_.at(party_[battle_.actorIndex]).hp <= 0 || restriction(actors_.at(party_[battle_.actorIndex])) > 0)) ++battle_.actorIndex;
  if (battle_.actorIndex < static_cast<int>(party_.size())) return;
  beginTurn();
}
void Session::beginTurn() {
  std::stable_sort(battle_.actions.begin(), battle_.actions.end(), [](const Action& a, const Action& b) { return a.enemy != b.enemy ? !a.enemy : a.subject < b.subject; });
  for (auto& action : battle_.actions) {
    auto& battler = action.enemy ? battle_.enemies[action.subject] : actors_.at(party_[action.subject]);
    const auto& skill = database_[action.item ? "items" : "skills"][action.id];
    action.speed = static_cast<int>(parameter(battler, 6)) + randomInt(static_cast<int>(std::floor(5 + parameter(battler, 6) / 4))) + skill["speed"].integer();
    if (action.id == 2 && !action.item) battler.guarding = true;
  }
  std::stable_sort(battle_.actions.begin(), battle_.actions.end(), [](const Action& a, const Action& b) { return a.speed > b.speed; });
  battle_.wait = 1;
}
void Session::executeAction(const Action& selectedAction) {
  Action action = selectedAction;
  auto& subject = action.enemy ? battle_.enemies[action.subject] : actors_.at(party_[action.subject]);
  if (subject.hp <= 0 || subject.hidden || subject.escaped || restriction(subject) >= 4) return;
  if (restriction(subject) > 0) { action.id = 1; action.item = false; action.target = -1; }
  const auto& item = database_[action.item ? "items" : "skills"][action.id];
  if (!canUse(subject, item)) return;
  if (action.item) { if (inventory_[action.id] <= 0) return; if (item["consumable"].boolean()) --inventory_[action.id]; }
  else { subject.mp -= static_cast<int>(std::floor(item["mpCost"].number() * trait(subject, 23, 4, true))); subject.tp -= item["tpCost"].integer(); }
  const std::string name = database_[subject.enemy ? "enemies" : "actors"][subject.id]["name"].text();
  auto message = item["message1"].text();
  for (std::size_t at = message.find("%1"); at != std::string::npos; at = message.find("%1", at + item["name"].text().size())) message.replace(at, 2, item["name"].text());
  battle_.log.clear(); battle_.log.push_back(name + (message.empty() ? " uses " + item["name"].text() : message));
  const int scope = item["scope"].integer();
  std::vector<Battler*> candidates;
  bool opponent = scope >= 1 && scope <= 6;
  const int confusion = restriction(subject);
  if (confusion > 0 && confusion < 4) opponent = confusion == 1 || (confusion == 2 && randomInt(2) == 0);
  if (opponent == !action.enemy) {
    for (auto& value : battle_.enemies) if (!value.hidden && !value.escaped && (value.hp > 0 || scope == 9 || scope == 10)) candidates.push_back(&value);
  } else for (int id : party_) {
    auto& value = actors_.at(id); if (!value.escaped && ((scope == 9 || scope == 10) == (value.hp <= 0))) candidates.push_back(&value);
  }
  std::vector<Battler*> targets;
  if (scope == 11) targets.push_back(&subject);
  else if (scope == 2 || scope == 8 || scope == 10) targets = candidates;
  else if (scope >= 3 && scope <= 6) {
    for (int i = 0; i < scope - 2 && !candidates.empty(); ++i) targets.push_back(candidates[randomInt(static_cast<int>(candidates.size()))]);
  } else if (scope && !candidates.empty()) {
    if (action.target >= 0) {
      Battler* requested = nullptr;
      if (opponent == !action.enemy && action.target < static_cast<int>(battle_.enemies.size())) requested = &battle_.enemies[action.target];
      else if (opponent != !action.enemy && action.target < static_cast<int>(party_.size())) requested = &actors_.at(party_[action.target]);
      targets.push_back(std::find(candidates.begin(), candidates.end(), requested) != candidates.end() ? requested : candidates.front());
    } else {
      double total = 0; for (auto* target : candidates) total += trait(*target, 23, 0, true);
      double selected = random() * total; Battler* target = candidates.back();
      for (auto* entry : candidates) { selected -= trait(*entry, 23, 0, true); if (selected <= 0) { target = entry; break; } }
      targets.push_back(target);
    }
  }
  const int movement = !action.enemy && (action.id != 2 || action.item) ? 12 : 0;
  BattleVisual visual; visual.action = action; visual.movementStarted = ticks_; visual.started = ticks_ + movement;
  for (auto* target : targets) {
    BattleTarget visualTarget; visualTarget.enemy = target->enemy;
    if (target->enemy) visualTarget.index = static_cast<int>(target - battle_.enemies.data());
    else { const auto position = std::find(party_.begin(), party_.end(), target->id); visualTarget.index = static_cast<int>(position - party_.begin()); }
    visual.targets.push_back(visualTarget);
  }
  visual.lastAudioFrames.resize(visual.targets.size(), -1);
  const int frames = static_cast<int>(database_["animations"][item["animationId"].integer()]["frames"].array().size());
  battle_.wait = std::max(16, movement + (frames ? frames * 4 + 9 + std::max(0, static_cast<int>(targets.size()) - 1) * 12 : 0));
  battle_.visuals.push_back(std::move(visual));
  if (battle_.visuals.size() > 32) battle_.visuals.erase(battle_.visuals.begin());
  battle_.currentVisual = static_cast<int>(battle_.visuals.size()) - 1; battle_.actionStage = 1;
}
void Session::resolveAction() {
  auto& visual = battle_.visuals.at(battle_.currentVisual); const auto& action = visual.action;
  auto& subject = action.enemy ? battle_.enemies[action.subject] : actors_.at(party_[action.subject]);
  const auto& item = database_[action.item ? "items" : "skills"][action.id];
  for (auto& entry : visual.targets) {
    auto& target = entry.enemy ? battle_.enemies[entry.index] : actors_.at(party_[entry.index]);
    for (int repeat = 0; repeat < std::max(1, item["repeats"].integer(1)); ++repeat) {
      const bool physical = item["hitType"].integer() == 1, magical = item["hitType"].integer() == 2;
      if (random() < (physical && restriction(target) < 4 ? trait(target, 22, 6, false) : 0)) apply(target, subject, database_["skills"][1]);
      else if (random() < (magical ? trait(target, 22, 5, false) : 0)) apply(subject, subject, item);
      else apply(subject, target, item);
    }
    entry.result = target.result;
  }
  visual.impact = ticks_;
}

void Session::endBattlerTurn(Battler& battler) {
    if (battler.hp > 0) {
      const int hpChange = static_cast<int>(std::floor(parameter(battler, 0) * trait(battler, 22, 7, false)));
      battler.hp += std::max(hpChange, -(battler.hp - (database_["system"]["optSlipDeath"].boolean() ? 0 : 1)));
      battler.mp += static_cast<int>(std::floor(parameter(battler, 1) * trait(battler, 22, 8, false)));
      battler.tp += static_cast<int>(std::floor(100 * trait(battler, 22, 9, false)));
    }
    auto states = battler.states;
    for (int state : states) {
      if (battler.stateTurns[state] > 0) --battler.stateTurns[state];
      if (database_["states"][state]["autoRemovalTiming"].integer() == 2 && battler.stateTurns[state] == 0) removeState(battler, state);
    }
    for (int i = 0; i < 8; ++i) if (battler.buffTurns[i] > 0 && --battler.buffTurns[i] == 0) battler.buffs[i] = 0;
    refreshBattler(battler);
}
void Session::endTurn() {
  for (int id : party_) endBattlerTurn(actors_.at(id));
  for (auto& value : battle_.enemies) endBattlerTurn(value);
  ++battle_.turn; makeEnemyActions();
}
std::string Session::battleMessage(const std::string& key, const std::vector<std::string>& arguments) const {
  auto text = database_["system"]["terms"]["messages"][key].text();
  for (std::size_t i = 0; i < arguments.size(); ++i) {
    const auto token = "%" + std::to_string(i + 1);
    std::size_t at = 0;
    while ((at = text.find(token, at)) != std::string::npos) { text.replace(at, token.size(), arguments[i]); at += arguments[i].size(); }
  }
  return text;
}
std::string Session::partyName() const {
  if (party_.empty()) return {};
  const auto leader = database_["actors"][party_.front()]["name"].text();
  return party_.size() == 1 ? leader : battleMessage("partyName", {leader});
}
void Session::finishBattle(int result) {
  battle_.result = result; battle_.active = false; battle_.wait = 0; battle_.log.clear();
  message_ = {}; message_.busy = true; messageAge_ = 0;
  message_.lines.emplace_back(battleMessage(result == 0 ? "victory" : result == 1 ? "escapeStart" : "defeat", {partyName()}));
  if (result != 2) for (int id : party_) {
    auto& actor = actors_.at(id); const auto states = actor.states;
    for (int state : states) if (database_["states"][state]["removeAtBattleEnd"].boolean()) removeState(actor, state);
  }
  std::vector<std::pair<std::string, int>> drops;
  int gold = 0;
  if (result == 0) ++system_.winCount;
  if (result == 1) ++system_.escapeCount;
  if (result == 0) {
    for (const auto& enemy : battle_.enemies) if (enemy.hp <= 0 && !enemy.hidden) {
      const auto& source = database_["enemies"][enemy.id]; gold += source["gold"].integer();
      for (const auto& drop : source["dropItems"].array()) {
        const int kind = drop["kind"].integer();
        if (kind > 0 && random() * drop["denominator"].number() < 1) {
          const int key = drop["dataId"].integer() + (kind - 1) * 100000;
          inventory_[key] = std::min(99, inventory_[key] + 1);
          drops.emplace_back(kind == 1 ? "items" : kind == 2 ? "weapons" : "armors", drop["dataId"].integer());
        }
      }
    }
  }
  gold_ = std::clamp(gold_ + gold, 0, 99999999);
  if (gold > 0) message_.lines.emplace_back(battleMessage("obtainGold", {std::to_string(gold)}));
  if (!drops.empty()) {
    message_.pageBreaks.insert(static_cast<int>(message_.lines.size()));
    for (const auto& [kind, id] : drops) message_.lines.emplace_back(battleMessage("obtainItem", {database_[kind][id]["name"].text()}));
  }
  if (result == 0) audio("me", database_["system"]["victoryMe"]);
  if (result == 2) audio("me", database_["system"]["defeatMe"]);
  if (result != 2 || battle_.canLose) {
    savedBgm_ = battle_.mapBgm; savedBgs_ = battle_.mapBgs;
    audio("battle-restore-bgm", {}); audio("battle-restore-bgs", {});
  } else audio("bgm", Value::Object{{"name", ""}});
  if (battle_.event) interpreter_.branches[interpreter_.list[std::max(0, interpreter_.index - 1)]["indent"].integer()] = result;
}
void Session::leaveBattle() {
  const int result = battle_.result;
  for (int id : party_) {
    auto& value = actors_.at(id); value.guarding = false; value.escaped = false;
    if (result == 2 && battle_.canLose && value.hp == 0) { value.hp = 1; removeState(value, 1); }
    auto states = value.states; for (int state : states) if (database_["states"][state]["removeAtBattleEnd"].boolean()) removeState(value, state);
    value.buffs.fill(0); value.buffTurns.fill(0); value.tp = 0;
  }
  if (result == 2 && !battle_.canLose) { openGameOver(); return; }
  ui_ = {}; ui_.scene = Scene::map;
  encounterCount_ = randomInt(map()["encounterStep"].integer(30)) + randomInt(map()["encounterStep"].integer(30)) + 1;
}
void Session::updateBattle() {
  if (ui_.scene != Scene::battle || message_.busy) return;
  if (!battle_.active) { if (battle_.result >= 0) leaveBattle(); return; }
  if (battle_.opening) { battle_.opening = false; makeEnemyActions(); return; }
  const bool processingTurn = battle_.wait > 0;
  if (processingTurn) {
    if (--battle_.wait > 0) return;
    if (battle_.actionStage == 1) { resolveAction(); battle_.actionStage = 2; battle_.wait = 36; return; }
    if (battle_.actionStage == 2) {
      auto& visual = battle_.visuals.at(battle_.currentVisual); const auto& action = visual.action;
      auto& subject = action.enemy ? battle_.enemies[action.subject] : actors_.at(party_[action.subject]);
      const auto states = subject.states;
      for (int state : states) if (database_["states"][state]["autoRemovalTiming"].integer() == 1 && subject.stateTurns[state] == 0) removeState(subject, state);
      visual.returned = ticks_; battle_.actionStage = 0;
    }
  }
  const bool defeated = std::none_of(party_.begin(), party_.end(), [&](int id) { return actors_.at(id).hp > 0 && !actors_.at(id).escaped; });
  const bool victorious = std::none_of(battle_.enemies.begin(), battle_.enemies.end(), [](const Battler& value) { return value.hp > 0 && !value.hidden && !value.escaped; });
  if (defeated || victorious) { finishBattle(defeated ? 2 : 0); return; }
  if (!processingTurn) return;
  if (battle_.actions.empty()) { endTurn(); return; }
  const auto action = battle_.actions.front(); battle_.actions.erase(battle_.actions.begin()); executeAction(action);
  if (!battle_.wait) battle_.wait = 1;
}
int Session::menuItemUser() const {
  int selected = -1; double maximum = -1;
  for (std::size_t i = 0; i < party_.size(); ++i) {
    const auto& actor = actors_.at(party_[i]); const double value = trait(actor, 23, 3, true);
    if (actor.hp > 0 && restriction(actor) < 4 && value > maximum) { maximum = value; selected = static_cast<int>(i); }
  }
  return selected;
}
bool Session::canApply(const Battler& target, const Value& item) const {
  const int scope = item["scope"].integer();
  if ((scope == 9 || scope == 10) != (target.hp <= 0)) return false;
  if (battle_.active || (scope >= 1 && scope <= 6)) return true;
  for (const auto& effect : item["effects"].array()) {
    const int code = effect["code"].integer();
    if (code == 11 && (target.hp < parameter(target, 0) || effect["value1"].number() < 0 || effect["value2"].number() < 0)) return true;
    if (code == 12 && (target.mp < parameter(target, 1) || effect["value1"].number() < 0 || effect["value2"].number() < 0)) return true;
    if (code == 21 && !contains(target.states, effect["dataId"].integer())) return true;
    if (code == 41) return true;
  }
  return false;
}
bool Session::useItem(int id, int target, bool skill) {
  if (target < 0 || target >= static_cast<int>(party_.size())) return false;
  const int user = skill ? ui_.actor : menuItemUser(); if (user < 0) return false;
  auto& subject = actors_.at(party_[user]); const auto& item = database_[skill ? "skills" : "items"][id];
  if (!canUse(subject, item) || (!skill && inventory_[id] <= 0)) return false;
  const bool all = item["scope"].integer() == 8 || item["scope"].integer() == 10;
  if (all ? std::none_of(party_.begin(), party_.end(), [&](int actorId) { return canApply(actors_.at(actorId), item); }) : !canApply(actors_.at(party_[target]), item)) return false;
  if (skill) { subject.mp -= static_cast<int>(std::floor(item["mpCost"].number() * trait(subject, 23, 4, true))); subject.tp -= item["tpCost"].integer(); }
  else if (item["consumable"].boolean()) --inventory_[id];
  if (all) { for (int actorId : party_) apply(subject, actors_.at(actorId), item); }
  else apply(subject, item["scope"].integer() == 11 ? subject : actors_.at(party_[target]), item);
  audio("se", database_["system"]["sounds"][skill ? 24 : 23]);
  return true;
}
bool Session::canEquip(const Battler& actor, const Value& item, int slot) const {
  if (item.null() || item["etypeId"].integer() != slot + 1) return false;
  bool permitted = false;
  for (const auto* object : traitObjects(actor)) for (const auto& entry : (*object)["traits"].array()) {
    if (entry["code"].integer() == 54 && entry["dataId"].integer() == slot + 1) return false;
    if (entry["code"].integer() == (slot == 0 ? 51 : 52) && entry["dataId"].integer() == item[slot == 0 ? "wtypeId" : "atypeId"].integer()) permitted = true;
  }
  return permitted;
}
void Session::changeEquipment(int actorId, int slot, int itemId) {
  auto& value = actors_.at(actorId);
  if (slot < 0 || slot >= static_cast<int>(value.equips.size())) return;
  const std::string kind = slot == 0 ? "weapons" : "armors";
  const int key = itemId + (slot == 0 ? 100000 : 200000);
  if (itemId && inventory_[key] <= 0) return;
  if (itemId) {
    const auto& item = database_[kind][itemId];
    if (!canEquip(value, item, slot)) return;
  }
  const int old = value.equips[slot];
  if (old) ++inventory_[old + (slot == 0 ? 100000 : 200000)];
  if (itemId) --inventory_[key];
  value.equips[slot] = itemId; refreshBattler(value);
  audio("se", database_["system"]["sounds"][4]);
}
}  // namespace pmjs::mv
