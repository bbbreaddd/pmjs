#include "mv_engine.hpp"
#include "mv_battle_extra.hpp"
#include "mv_managers.hpp"

#include <algorithm>
#include <cmath>
#include <numeric>
#include <limits>
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
  Battler value; value.id = id; value.level = source["initialLevel"].integer(1); value.classId = source["classId"].integer();
  value.name = source["name"].text(); value.nickname = source["nickname"].text(); value.profile = source["profile"].text();
  value.characterName = source["characterName"].text(); value.characterIndex = source["characterIndex"].integer();
  value.faceName = source["faceName"].text(); value.faceIndex = source["faceIndex"].integer(); value.battlerName = source["battlerName"].text();
  for (const auto& item : source["equips"].array()) value.equips.push_back(item.integer());
  const auto equipTypes = database_["system"]["equipTypes"].array().size();
  value.equips.resize(equipTypes > 1 ? equipTypes - 1 : 5);
  value.equipKinds.assign(value.equips.size(), 2);
  if (!value.equipKinds.empty()) value.equipKinds[0] = 1;
  for (std::size_t slot = 0; slot < value.equips.size(); ++slot) value.equipKinds[slot] = equipSlotType(value, static_cast<int>(slot)) == 1 ? 1 : 2;
  actors_[id] = value;
  auto& result = actors_.at(id);
  releaseEquipment(result, true);
  result.exp[result.classId] = actorExpForLevel(result, result.level);
  const auto& klass = database_["classes"][result.classId];
  for (const auto& learning : klass["learnings"].array()) if (learning["level"].integer() <= result.level) result.skills.insert(learning["skillId"].integer());
  recover(result);
}
std::vector<const Value*> Session::traitObjects(const Battler& battler) const {
  std::vector<const Value*> result;
  if (battler.enemy) result.push_back(&database_["enemies"][battler.id]);
  else {
    const auto& source = database_["actors"][battler.id];
    result.push_back(&source); result.push_back(&database_["classes"][battler.classId]);
    for (std::size_t i = 0; i < battler.equips.size(); ++i) if (battler.equips[i]) result.push_back(&database_[battler.equipKinds[i] == 1 ? "weapons" : "armors"][battler.equips[i]]);
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
    base = database_["classes"][battler.classId]["params"][id][battler.level].number();
    for (std::size_t i = 0; i < battler.equips.size(); ++i) if (battler.equips[i]) base += database_[battler.equipKinds[i] == 1 ? "weapons" : "armors"][battler.equips[i]]["params"][id].number();
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
  battler.states.clear(); battler.stateTurns.clear(); battler.stateSteps.clear();
  battler.hp = static_cast<int>(parameter(battler, 0)); battler.mp = static_cast<int>(parameter(battler, 1));
}
void Session::refreshBattler(Battler& battler) {
  if (!battler.enemy) releaseEquipment(battler);
  std::vector<int> resisted;
  for (const auto* object : traitObjects(battler)) for (const auto& entry : (*object)["traits"].array())
    if (entry["code"].integer() == 14) resisted.push_back(entry["dataId"].integer());
  for (int state : resisted) {
    battler.states.erase(std::remove(battler.states.begin(), battler.states.end(), state), battler.states.end()); battler.stateTurns.erase(state);
  }
  battler.hp = std::clamp(battler.hp, 0, static_cast<int>(parameter(battler, 0)));
  battler.mp = std::clamp(battler.mp, 0, static_cast<int>(parameter(battler, 1)));
  battler.tp = std::clamp(battler.tp, 0, 100);
  if (!battler.hp && !contains(battler.states, 1)) addState(battler, 1);
  else if (battler.hp > 0 && contains(battler.states, 1)) removeState(battler, 1);
}
void Session::removeState(Battler& battler, int state) {
  if (!contains(battler.states, state)) return;
  if (state == 1) battler.hp = std::max(1, battler.hp);
  battler.states.erase(std::remove(battler.states.begin(), battler.states.end(), state), battler.states.end());
  battler.stateTurns.erase(state); battler.stateSteps.erase(state);
  if (!contains(battler.result.removedStates, state)) battler.result.removedStates.push_back(state);
  refreshBattler(battler);
}
void Session::addState(Battler& battler, int state) {
  if (state <= 0 || database_["states"][state].null() || battler.hidden || (battler.hp <= 0 && state != 1)) return;
  for (const auto* object : traitObjects(battler)) for (const auto& entry : (*object)["traits"].array()) if (entry["code"].integer() == 14 && entry["dataId"].integer() == state) return;
  if (contains(battler.result.removedStates, state)) return;
  const auto& source = database_["states"][state];
  if (restriction(battler) > 0 && source["removeByRestriction"].boolean()) return;
  if (!contains(battler.states, state)) {
    if (state == 1) {
      battler.hp = 0; battler.states.clear(); battler.stateTurns.clear(); battler.stateSteps.clear(); battler.buffs.fill(0); battler.buffTurns.fill(0);
    }
    const int oldRestriction = restriction(battler);
    battler.states.push_back(state);
    if (restriction(battler) > oldRestriction) {
      if (battle_.active) {
        const int index = battler.enemy ? static_cast<int>(&battler - battle_.enemies.data()) : static_cast<int>(std::find(party_.begin(), party_.end(), battler.id) - party_.begin());
        battle_.actions.erase(std::remove_if(battle_.actions.begin(), battle_.actions.end(), [&](const Action& action) { return action.enemy == battler.enemy && action.subject == index; }), battle_.actions.end());
        if (!battler.enemy && index < static_cast<int>(battle_.remainingActions.size())) battle_.remainingActions[index] = 0;
      }
      const auto states = battler.states;
      for (int existing : states) if (database_["states"][existing]["removeByRestriction"].boolean()) removeState(battler, existing);
    }
  }
  std::stable_sort(battler.states.begin(), battler.states.end(), [&](int a, int b) { const auto pa = database_["states"][a]["priority"].integer(), pb = database_["states"][b]["priority"].integer(); return pa != pb ? pa > pb : a < b; });
  battler.stateTurns[state] = source["minTurns"].integer() + randomInt(1 + source["maxTurns"].integer() - source["minTurns"].integer());
  if (!battler.enemy) battler.stateSteps[state] = source["stepsToRemove"].integer();
  if (!contains(battler.result.addedStates, state)) battler.result.addedStates.push_back(state);
  refreshBattler(battler);
}
bool Session::canUse(const Battler& battler, const Value& item) const {
  if (item.null() || battler.hp <= 0 || battler.hidden || restriction(battler) >= 4) return false;
  const int occasion = item["occasion"].integer();
  if (occasion == 3 || (occasion == 1 && !battle_.active) || (occasion == 2 && battle_.active)) return false;
  if (!item["stypeId"].null()) {
    if (!battler.enemy) {
      const int first = item["requiredWtypeId1"].integer(), second = item["requiredWtypeId2"].integer();
      bool equipped = !first && !second;
      for (std::size_t slot = 0; slot < battler.equips.size(); ++slot) if (equipSlotType(battler, static_cast<int>(slot)) == 1 && battler.equips[slot]) {
        const int type = database_["weapons"][battler.equips[slot]]["wtypeId"].integer(); equipped = equipped || type == first || type == second;
      }
      if (!equipped) return false;
    }
    if (battler.mp < static_cast<int>(std::floor(item["mpCost"].number() * trait(battler, 23, 4, true))) || battler.tp < item["tpCost"].integer()) return false;
    for (const auto* object : traitObjects(battler)) for (const auto& entry : (*object)["traits"].array()) {
      if (entry["code"].integer() == 42 && entry["dataId"].integer() == item["stypeId"].integer()) return false;
      if (entry["code"].integer() == 44 && entry["dataId"].integer() == item["id"].integer()) return false;
    }
  }
  return true;
}

void Session::apply(Battler& subject, Battler& target, const Value& item, Battler* drainTarget) {
  subject.result = {}; target.result = {};
  auto& result = target.result;
  result.used = canApply(target, item);
  if (!result.used) { (void)random(); return; }
  if (target.hidden || target.escaped) return;
  const int scope = item["scope"].integer();
  if ((scope == 9 || scope == 10) != (target.hp == 0)) return;
  result.physical = item["hitType"].integer() == 1;
  result.drain = item["damage"]["type"].integer() == 5 || item["damage"]["type"].integer() == 6;
  const int hitType = item["hitType"].integer();
  const double success = item["successRate"].number(100) / 100 * (hitType == 1 ? trait(subject, 22, 0, false) : 1);
  if (random() >= success) { result.missed = true; battle_.log.push_back("Miss!"); return; }
  const double evasion = hitType == 1 ? trait(target, 22, 1, false) : hitType == 2 ? trait(target, 22, 4, false) : 0;
  if (random() < evasion) { result.evaded = true; if (hitType == 2) SoundManager::playMagicEvasion(*this); else SoundManager::playEvasion(*this); battle_.log.push_back("Evaded!"); return; }
  const auto& damage = item["damage"];
  if (damage["type"].integer()) {
    const bool critical = random() < (damage["critical"].boolean() ? trait(subject, 22, 2, false) * (1 - trait(target, 22, 3, false)) : 0);
    result.critical = critical;
    const int type = damage["type"].integer();
    const int amount = damageValue(subject, target, item, critical);
    if (type == 1 || type == 3 || type == 5) {
      const int actual = type == 5 ? std::min(amount, target.hp) : amount;
      result.hpAffected = true; result.hpDamage = actual;
      target.hp -= actual;
      refreshBattler(target);
      if (actual > 0) {
        auto states = target.states;
        for (int state : states) { const auto& source = database_["states"][state]; if (source["removeByDamage"].boolean() && random() < source["chanceByDamage"].number() / 100) removeState(target, state); }
        target.tp += static_cast<int>(std::clamp(std::floor(50.0 * actual / parameter(target, 0) * trait(target, 23, 5, true)), -100.0, 100.0));
      }
      if (type == 5) { auto& receiver = drainTarget ? *drainTarget : subject; receiver.hp += actual; refreshBattler(receiver); }
    } else {
      const int actual = type == 6 || amount > 0 ? std::min(amount, target.mp) : amount;
      result.mpDamage = actual;
      target.mp -= actual; if (type == 6) { auto& receiver = drainTarget ? *drainTarget : subject; receiver.mp += actual; refreshBattler(receiver); }
    }
    result.success = true;
    battle_.log.push_back(std::to_string(amount));
    refreshBattler(target); refreshBattler(subject);
  }
  for (const auto& effect : item["effects"].array()) applyItemEffect(subject, target, item, effect);
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
    enemy.originalName = database_["enemies"][enemy.id]["name"].text(); enemy.name = enemy.originalName;
    recover(enemy); battle_.enemies.push_back(enemy);
  }
  BattleMechanics::makeUniqueNames(battle_.enemies, battle_.nameCounts, database_["system"]["locale"].text().starts_with("ja") || database_["system"]["locale"].text().starts_with("zh") || database_["system"]["locale"].text().starts_with("ko"));
  if (!event) { battle_.preemptive = random() < BattleMechanics::ratePreemptive(*this); battle_.surprise = random() < BattleMechanics::rateSurprise(*this) && !battle_.preemptive; }
  double actorsAgi = 0, enemiesAgi = 0;
  for (std::size_t index = 0; index < battleMemberCount(); ++index) { auto& value = actors_.at(party_[index]); if (!hasSpecialFlag(value, 3)) value.tp = randomInt(25); value.escaped = false; actorsAgi += parameter(value, 6); }
  for (auto& value : battle_.enemies) { value.tp = randomInt(25); enemiesAgi += parameter(value, 6); }
  actorsAgi /= std::max<std::size_t>(1, battleMemberCount()); enemiesAgi /= std::max<std::size_t>(1, battle_.enemies.size());
  battle_.escapeRatio = 0.5 * actorsAgi / std::max(1.0, enemiesAgi);
  ui_ = {}; ui_.scene = Scene::battle;
  battle_.mapBgm = savedBgm_; battle_.mapBgs = savedBgs_;
  audio("battle-save", {});
  audio("bgs", Value::Object{{"name", ""}});
  const auto battleBgm = system_.battleBgm.null() ? database_["system"]["battleBgm"] : system_.battleBgm;
  if (battleTest_) audio("bgm", battleBgm);
  else {
    if (savedBgm_.null() || savedBgm_["name"].text() != battleBgm["name"].text()) audio("bgm", Value::Object{{"name", ""}});
    audio("me", Value::Object{{"name", ""}});
    SoundManager::playBattleStart(*this);
    battle_.encounterEffect = 60;
  }
  battle_.opening = true; ui_.category = 4;
  if (battleTest_) buildBattleIntro();
}
void Session::buildBattleIntro() {
  message_ = {}; messageAge_ = 0;
  std::set<std::string> names;
  for (const auto& enemy : battle_.enemies) if (!enemy.hidden) {
    const auto name = database_["enemies"][enemy.id]["name"].text();
    if (names.insert(name).second) message_.lines.emplace_back(battleMessage("emerge", {name}));
  }
  if (battle_.preemptive) message_.lines.emplace_back(battleMessage("preemptive", {partyName()}));
  else if (battle_.surprise) message_.lines.emplace_back(battleMessage("surprise", {partyName()}));
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
  } else for (std::size_t i = 0; i < battleMemberCount(); ++i) {
    const auto& actor = actors_.at(party_[i]);
    if (!actor.escaped && (actor.hp <= 0) == (scope == 9 || scope == 10)) targets.push_back(static_cast<int>(i));
  }
  return targets;
}
std::set<int> Session::battlerSkills(const Battler& actor) const {
  auto skills = actor.skills;
  for (const auto* object : traitObjects(actor)) for (const auto& entry : (*object)["traits"].array())
    if (entry["code"].integer() == 43) skills.insert(entry["dataId"].integer());
  return skills;
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
  battle_.remainingActions.assign(battleMemberCount(), 0);
  for (auto& [id, actor] : actors_) { (void)id; actor.guarding = false; }
  for (std::size_t index = 0; index < battle_.enemies.size(); ++index) {
    auto& enemy = battle_.enemies[index]; enemy.guarding = false;
    const int count = battle_.preemptive ? 0 : battleActionCount(enemy);
    if (!count) endBattlerActions(enemy);
    for (int action = 0; action < count; ++action) {
      const int skill = selectEnemySkill(enemy);
      if (skill) battle_.actions.push_back({true, false, static_cast<int>(index), skill, -1, 0});
    }
  }
  for (std::size_t index = 0; index < battleMemberCount(); ++index) {
    auto& actor = actors_.at(party_[index]); const int count = battle_.surprise ? 0 : battleActionCount(actor);
    if (!count) endBattlerActions(actor);
    const bool automatic = hasSpecialFlag(actor, 0) || restriction(actor) > 0;
    if (!automatic) battle_.remainingActions[index] = count;
    else for (int action = 0; action < count; ++action) {
      int skill = 1, target = -1;
      if (!restriction(actor)) {
        double best = std::numeric_limits<double>::lowest();
        auto skills = battlerSkills(actor); skills.insert(1);
        for (int id : skills) if (canUse(actor, database_["skills"][id])) {
          int candidateTarget = -1;
          const double score = evaluateAutoAction(actor, database_["skills"][id], candidateTarget);
          if (score > best) { best = score; skill = id; target = candidateTarget; }
        }
      }
      battle_.actions.push_back({false, false, static_cast<int>(index), skill, target, 0});
    }
  }
  while (battle_.actorIndex < static_cast<int>(battleMemberCount()) && !battle_.remainingActions[battle_.actorIndex]) ++battle_.actorIndex;
  if (battle_.actorIndex == static_cast<int>(battleMemberCount())) beginTurn();
}
void Session::chooseAction(int actorIndex, int id, int target, bool item) {
  if (!battle_.active || battle_.opening || message_.busy || battle_.wait || battle_.interpreter.running || battle_.forcedExecuting || !battle_.forcedActions.empty() || actorIndex != battle_.actorIndex || actorIndex < 0 || actorIndex >= static_cast<int>(battleMemberCount())) throw std::invalid_argument("battle is not accepting this action");
  auto& subject = actors_.at(party_[actorIndex]);
  const auto& source = database_[item ? "items" : "skills"][id];
  if (source.null() || !canUse(subject, source) || (item && inventory_[id] <= 0)) throw std::invalid_argument("unavailable action");
  if (!item && id != 1 && id != 2 && !battlerSkills(subject).contains(id)) throw std::invalid_argument("unlearned skill");
  battle_.actions.push_back({false, item, actorIndex, id, target, 0});
  if (--battle_.remainingActions[actorIndex] > 0) return;
  battle_.actorIndex = actorIndex + 1;
  while (battle_.actorIndex < static_cast<int>(battleMemberCount()) && !battle_.remainingActions[battle_.actorIndex]) ++battle_.actorIndex;
  if (battle_.actorIndex < static_cast<int>(battleMemberCount())) return;
  beginTurn();
}
void Session::beginTurn() {
  ++battle_.turn;
  const auto& pages = database_["troops"][battle_.troopId]["pages"].array();
  for (std::size_t index = 0; index < pages.size(); ++index) if (pages[index]["span"].integer() == 1) battle_.eventFlags.erase(static_cast<int>(index));
  std::stable_sort(battle_.actions.begin(), battle_.actions.end(), [](const Action& a, const Action& b) { return a.enemy != b.enemy ? !a.enemy : a.subject < b.subject; });
  for (auto& action : battle_.actions) {
    auto& battler = action.enemy ? battle_.enemies[action.subject] : actors_.at(party_[action.subject]);
    const auto& skill = database_[action.item ? "items" : "skills"][action.id];
    action.speed = static_cast<int>(parameter(battler, 6)) + randomInt(static_cast<int>(std::floor(5 + parameter(battler, 6) / 4))) + skill["speed"].integer() + ((!action.item && action.id == 1) ? static_cast<int>(trait(battler, 33, 0, false)) : 0);
  }
  std::map<std::pair<bool,int>,int> speeds;
  for (const auto& action : battle_.actions) {
    const auto key = std::make_pair(action.enemy, action.subject);
    const auto found = speeds.find(key);
    if (found == speeds.end()) speeds[key] = action.speed;
    else found->second = std::min(found->second, action.speed);
  }
  for (auto& action : battle_.actions) action.speed = speeds.at({action.enemy, action.subject});
  std::stable_sort(battle_.actions.begin(), battle_.actions.end(), [](const Action& a, const Action& b) { return a.speed > b.speed; });
  battle_.wait = 1;
}
void Session::executeAction(const Action& selectedAction) {
  Action action = selectedAction;
  auto& subject = action.enemy ? battle_.enemies[action.subject] : actors_.at(party_[action.subject]);
  if (subject.hp <= 0 || subject.hidden || subject.escaped || (!action.forced && restriction(subject) >= 4)) return;
  if (!action.forced && restriction(subject) > 0) { action.id = 1; action.item = false; action.target = -1; }
  const auto& item = database_[action.item ? "items" : "skills"][action.id];
  if (!action.forced && !canUse(subject, item)) return;
  if (action.item) { if (inventory_[action.id] <= 0) return; if (item["consumable"].boolean()) --inventory_[action.id]; }
  else { subject.mp -= static_cast<int>(std::floor(item["mpCost"].number() * trait(subject, 23, 4, true))); subject.tp -= item["tpCost"].integer(); }
  const std::string name = subject.name;
  auto message = item["message1"].text();
  for (std::size_t at = message.find("%1"); at != std::string::npos; at = message.find("%1", at + item["name"].text().size())) message.replace(at, 2, item["name"].text());
  battle_.log.clear(); battle_.log.push_back(name + (message.empty() ? " uses " + item["name"].text() : message));
  const auto targets = actionTargets(action, subject, item);
  if (!targets.empty()) {
    if (targets.back()->enemy) subject.lastTargetIndex = static_cast<int>(targets.back() - battle_.enemies.data());
    else subject.lastTargetIndex = static_cast<int>(std::find(party_.begin(), party_.end(), targets.back()->id) - party_.begin());
  }
  if (!action.item && action.id == 2) subject.guarding = true;
  applyGlobalEffects(item);
  const int movement = action.enemy ? 0 : 12;
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
  const int repeats = std::max(0, item["repeats"].integer(1) + ((!action.item && action.id == 1) ? static_cast<int>(std::max(0.0, trait(subject, 34, 0, false))) : 0));
  for (auto& entry : visual.targets) {
    auto& target = entry.enemy ? battle_.enemies[entry.index] : actors_.at(party_[entry.index]);
    for (int repeat = 0; repeat < repeats; ++repeat) {
      const bool physical = item["hitType"].integer() == 1, magical = item["hitType"].integer() == 2;
      if (random() < (physical && target.hp > 0 && restriction(target) < 4 ? trait(target, 22, 6, false) : 0)) {
        int animation = database_["skills"][1]["animationId"].integer();
        if (animation < 0 && !target.enemy) for (std::size_t slot = 0; slot < target.equips.size(); ++slot)
          if (target.equipKinds[slot] == 1 && target.equips[slot]) { animation = database_["weapons"][target.equips[slot]]["animationId"].integer(); break; }
        if (animation > 0) requestAnimation(subject.enemy ? 2 : 1, subject.enemy ? action.subject : subject.id, animation);
        apply(target, subject, database_["skills"][1]);
      }
      else if (random() < (magical ? trait(target, 22, 5, false) : 0)) {
        SoundManager::playReflection(*this); apply(subject, subject, item, &target);
      }
      else {
        Battler* receiver = &target;
        if (target.hp < parameter(target, 0) / 4 && item["hitType"].integer() != 0) {
          if (target.enemy) {
            for (auto& member : battle_.enemies) if (!member.hidden && BattleMechanics::canSubstitute(*this, member, target)) { receiver = &member; break; }
          } else for (std::size_t index = 0; index < battleMemberCount(); ++index) {
            auto& member = actors_.at(party_[index]);
            if (BattleMechanics::canSubstitute(*this, member, target)) { receiver = &member; break; }
          }
        }
        if (receiver != &target) battle_.log.push_back(battleMessage("substitute", {receiver->name, target.name}));
        apply(subject, *receiver, item);
      }
    }
    entry.result = target.result;
  }
  visual.impact = ticks_;
}

void Session::endBattlerActions(Battler& battler) {
  battler.result = {};
  const auto states = battler.states;
  for (int state : states) if (database_["states"][state]["autoRemovalTiming"].integer() == 1 && battler.stateTurns[state] == 0) removeState(battler, state);
  for (int parameter = 0; parameter < 8; ++parameter) if (battler.buffs[parameter] && battler.buffTurns[parameter] == 0) {
    battler.buffs[parameter] = 0; battler.result.removedBuffs.push_back(parameter);
  }
  refreshBattler(battler);
}
void Session::endBattlerTurn(Battler& battler) {
    battler.result = {};
    if (battler.hp > 0 && !battler.hidden) {
      const int hpChange = static_cast<int>(std::floor(parameter(battler, 0) * trait(battler, 22, 7, false)));
      const int hpValue = std::max(hpChange, -(battler.hp - (database_["system"]["optSlipDeath"].boolean() ? 0 : 1)));
      battler.result.hpDamage = -hpValue; battler.result.hpAffected = hpValue != 0; battler.hp += hpValue;
      const int mpValue = static_cast<int>(std::floor(parameter(battler, 1) * trait(battler, 22, 8, false)));
      battler.result.mpDamage = -mpValue; battler.mp += mpValue;
      battler.tp += static_cast<int>(std::floor(100 * trait(battler, 22, 9, false)));
    }
    auto states = battler.states;
    for (int state : states) {
      if (battler.stateTurns[state] > 0) --battler.stateTurns[state];
      if (database_["states"][state]["autoRemovalTiming"].integer() == 2 && battler.stateTurns[state] == 0) removeState(battler, state);
    }
    for (int i = 0; i < 8; ++i) if (battler.buffTurns[i] > 0) --battler.buffTurns[i];
    refreshBattler(battler);
}
void Session::endTurn() {
  for (std::size_t index = 0; index < battleMemberCount(); ++index) endBattlerTurn(actors_.at(party_[index]));
  for (auto& battler : battle_.enemies) endBattlerTurn(battler);
  battle_.preemptive = false; battle_.surprise = false;
  battle_.turnEnding = true;
  battle_.wait = 0;
}
std::string Session::battleMessage(const std::string& key, const std::vector<std::string>& arguments) const {
  return TextManager::format(TextManager::message(*this, key), arguments);
}
std::string Session::partyName() const {
  if (party_.empty()) return {};
  const auto leader = actors_.at(party_.front()).name;
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
  int totalExp = 0;
  if (result == 0) ++system_.winCount;
  if (result == 1) ++system_.escapeCount;
  if (result == 0) {
    for (const auto& enemy : battle_.enemies) if (enemy.hp <= 0 && !enemy.hidden) {
      const auto& source = database_["enemies"][enemy.id];
      gold += source["gold"].integer();
      totalExp += source["exp"].integer();
      for (const auto& drop : source["dropItems"].array()) {
        const int kind = drop["kind"].integer();
        if (kind > 0 && random() * drop["denominator"].number() < (hasPartyAbility(5) ? 2 : 1)) {
          const int key = drop["dataId"].integer() + (kind - 1) * 100000;
          inventory_[key] = std::min(99, inventory_[key] + 1);
          drops.emplace_back(kind == 1 ? "items" : kind == 2 ? "weapons" : "armors", drop["dataId"].integer());
        }
      }
    }
  }
  if (hasPartyAbility(4)) gold *= 2;
  gold_ = std::clamp(gold_ + gold, 0, 99999999);
  if (totalExp > 0) {
    message_.lines.emplace_back(battleMessage("obtainExp", {std::to_string(totalExp), TextManager::exp(*this)}));
    for (int id : party_) {
      auto& actor = actors_.at(id);
      {
        const auto position = std::find(party_.begin(), party_.end(), id);
        const double gained = std::floor(totalExp * trait(actor, 23, 9, true) * (position - party_.begin() < 4 || database_["system"]["optExtraExp"].boolean() ? 1 : 0) + 0.5);
        changeActorExp(actor, actor.exp[actor.classId] + gained, true);
      }
    }
  }
  if (gold > 0) message_.lines.emplace_back(battleMessage("obtainGold", {std::to_string(gold)}));
  if (!drops.empty()) {
    message_.pageBreaks.insert(static_cast<int>(message_.lines.size()));
    for (const auto& [kind, id] : drops) message_.lines.emplace_back(battleMessage("obtainItem", {database_[kind][id]["name"].text()}));
  }
  if (result == 0) audio("me", (system_.victoryMe.null() ? database_["system"]["victoryMe"] : system_.victoryMe));
  if (result == 2) audio("me", (system_.defeatMe.null() ? database_["system"]["defeatMe"] : system_.defeatMe));
  if (result != 2 || battle_.canLose) {
    savedBgm_ = battle_.mapBgm; savedBgs_ = battle_.mapBgs;
    audio("battle-restore-bgm", {}); audio("battle-restore-bgs", {});
  } else audio("bgm", Value::Object{{"name", ""}});
  if (battle_.event) interpreter_.branches[interpreter_.list[std::max(0, interpreter_.index - 1)]["indent"].integer()] = result;
}
void Session::leaveBattle() {
  if (battleTest_) { audio("bgm", Value::Object{{"name", ""}}); finished_ = true; return; }
  const int result = battle_.result;
  for (int id : party_) {
    auto& value = actors_.at(id); value.guarding = false; value.escaped = false; value.hidden = false;
    if (result == 2 && battle_.canLose && value.hp == 0) { value.hp = 1; removeState(value, 1); }
    auto states = value.states; for (int state : states) if (database_["states"][state]["removeAtBattleEnd"].boolean()) removeState(value, state);
    value.buffs.fill(0); value.buffTurns.fill(0); if (!hasSpecialFlag(value, 3)) value.tp = 0;
  }
  if (result == 2 && !battle_.canLose) { openGameOver(); return; }
  ui_ = {}; ui_.scene = Scene::map;
  encounterCount_ = randomInt(map()["encounterStep"].integer(30)) + randomInt(map()["encounterStep"].integer(30)) + 1;
}
void Session::updateBattle() {
  if (ui_.scene != Scene::battle || message_.busy) return;
  if (!battle_.active) { if (battle_.result >= 0) leaveBattle(); return; }
  const bool processingTurn = battle_.wait > 0;
  if (battle_.actionStage) {
    if (battle_.wait > 0 && --battle_.wait > 0) return;
    if (battle_.actionStage == 1) { resolveAction(); battle_.actionStage = 2; battle_.wait = 36; return; }
    auto& visual = battle_.visuals.at(battle_.currentVisual); const auto& action = visual.action;
    auto& subject = action.enemy ? battle_.enemies[action.subject] : actors_.at(party_[action.subject]);
    if (std::none_of(battle_.actions.begin(), battle_.actions.end(), [&](const Action& next) { return next.enemy == action.enemy && next.subject == action.subject; })) {
      endBattlerActions(subject);
    }
    visual.returned = ticks_; battle_.actionStage = 0;
    if (battle_.forcedExecuting) { battle_.forcedExecuting = false; battle_.wait = battle_.forcedResumeWait; }
  }
  if (!battle_.forcedActions.empty()) {
    const auto forced = battle_.forcedActions.front(); battle_.forcedActions.erase(battle_.forcedActions.begin());
    battle_.forcedResumeWait = battle_.wait; battle_.forcedExecuting = true;
    executeAction(forced);
    if (!battle_.actionStage) { battle_.forcedExecuting = false; battle_.wait = battle_.forcedResumeWait; }
    return;
  }
  if (updateTroopEvents()) return;
  if (!battle_.active || message_.busy) return;
  if (std::none_of(party_.begin(), party_.begin() + static_cast<std::ptrdiff_t>(battleMemberCount()), [&](int id) { const auto& member = actors_.at(id); return !member.hidden && !member.escaped; })) { enemyEventCommand(Value::Object{{"code", 340}}); return; }
  const bool defeated = std::none_of(party_.begin(), party_.begin() + static_cast<std::ptrdiff_t>(battleMemberCount()), [&](int id) { return actors_.at(id).hp > 0 && !actors_.at(id).escaped; });
  const bool victorious = std::none_of(battle_.enemies.begin(), battle_.enemies.end(), [](const Battler& battler) { return battler.hp > 0 && !battler.hidden && !battler.escaped; });
  if (defeated || victorious) { finishBattle(defeated ? 2 : 0); return; }
  if (battle_.opening) { battle_.opening = false; makeEnemyActions(); return; }
  if (battle_.turnEnding) { battle_.turnEnding = false; makeEnemyActions(); return; }
  if (!processingTurn && battle_.wait <= 0) {
    while (battle_.actorIndex < static_cast<int>(battleMemberCount()) &&
        (battle_.remainingActions[battle_.actorIndex] <= 0 || actors_.at(party_[battle_.actorIndex]).hp <= 0 || restriction(actors_.at(party_[battle_.actorIndex])) > 0)) {
      battle_.remainingActions[battle_.actorIndex] = 0; ++battle_.actorIndex;
    }
    if (battle_.actorIndex >= static_cast<int>(battleMemberCount())) beginTurn();
    return;
  }
  if (battle_.wait > 0 && --battle_.wait > 0) return;
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
  if (item["damage"]["type"].integer() == 3 && target.hp < parameter(target, 0)) return true;
  if (item["damage"]["type"].integer() == 4 && target.mp < parameter(target, 1)) return true;
  for (const auto& effect : item["effects"].array()) {
    const int code = effect["code"].integer();
    if (code == 11 && (target.hp < parameter(target, 0) || effect["value1"].number() < 0 || effect["value2"].number() < 0)) return true;
    if (code == 12 && (target.mp < parameter(target, 1) || effect["value1"].number() < 0 || effect["value2"].number() < 0)) return true;
    if (code == 13 && target.tp < 100) return true;
    if (code == 21 && !contains(target.states, effect["dataId"].integer())) return true;
    if (code == 22 && contains(target.states, effect["dataId"].integer())) return true;
    if (code == 41 || code == 42 || code == 44) return true;
    if (code == 43 && !target.enemy && !target.skills.contains(effect["dataId"].integer())) return true;
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
  const int repeats = std::max(0, item["repeats"].integer(1) + ((skill && id == 1) ? static_cast<int>(std::max(0.0, trait(subject, 34, 0, false))) : 0));
  if (all) { for (int actorId : party_) for (int repeat = 0; repeat < repeats; ++repeat) apply(subject, actors_.at(actorId), item); }
  else for (int repeat = 0; repeat < repeats; ++repeat) apply(subject, item["scope"].integer() == 11 ? subject : actors_.at(party_[target]), item);
  applyGlobalEffects(item);
  if (skill) SoundManager::playUseSkill(*this);
  else SoundManager::playUseItem(*this);
  return true;
}
bool Session::canChangeEquip(const Battler& actor, int slot) const {
  if (slot < 0 || slot >= static_cast<int>(actor.equips.size())) return false;
  const int type = equipSlotType(actor, slot);
  for (const auto* object : traitObjects(actor)) for (const auto& entry : (*object)["traits"].array())
    if ((entry["code"].integer() == 53 || entry["code"].integer() == 54) && entry["dataId"].integer() == type) return false;
  return true;
}
void Session::releaseEquipment(Battler& actor, bool forcing) {
  bool changed;
  do {
    changed = false;
    for (std::size_t slot = 0; slot < actor.equips.size(); ++slot) {
      const int id = actor.equips[slot];
      if (id && !canEquip(actor, database_[actor.equipKinds[slot] == 1 ? "weapons" : "armors"][id], static_cast<int>(slot))) {
        if (!forcing) gainItem(actor.equipKinds[slot], id, 1, false);
        actor.equips[slot] = 0; changed = true;
      }
    }
  } while (changed);
}
bool Session::canEquip(const Battler& actor, const Value& item, int slot) const {
  if (item.null() || item["etypeId"].integer() != equipSlotType(actor, slot)) return false;
  bool permitted = false;
  for (const auto* object : traitObjects(actor)) for (const auto& entry : (*object)["traits"].array()) {
    if (entry["code"].integer() == 54 && entry["dataId"].integer() == equipSlotType(actor, slot)) return false;
    if (entry["code"].integer() == (equipSlotType(actor, slot) == 1 ? 51 : 52) && entry["dataId"].integer() == item[equipSlotType(actor, slot) == 1 ? "wtypeId" : "atypeId"].integer()) permitted = true;
  }
  return permitted;
}
void Session::changeEquipment(int actorId, int slot, int itemId) {
  auto& value = actors_.at(actorId);
  if (!canChangeEquip(value, slot)) return;
  const bool weapon = equipSlotType(value, slot) == 1;
  const std::string kind = weapon ? "weapons" : "armors";
  const int key = itemId + (weapon ? 100000 : 200000);
  if (itemId && inventory_[key] <= 0) return;
  if (itemId) {
    const auto& item = database_[kind][itemId];
    if (!canEquip(value, item, slot)) return;
  }
  const int old = value.equips[slot];
  if (old) ++inventory_[old + (weapon ? 100000 : 200000)];
  if (itemId) --inventory_[key];
  value.equips[slot] = itemId; value.equipKinds[slot] = weapon ? 1 : 2; refreshBattler(value);
  SoundManager::playEquip(*this);
}
}  // namespace pmjs::mv
