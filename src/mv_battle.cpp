#include "mv_engine.hpp"
#include "mv_battle_extra.hpp"
#include "mv_core_utils.hpp"
#include "mv_managers.hpp"
#include "mv_windows.hpp"

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
int Session::randomInt(int maximum) { return static_cast<int>(std::floor(random() * maximum)); }

void Session::initializeActor(int id) {
  const auto& source = database_["actors"][id];
  if (source.null()) throw std::invalid_argument("unknown actor " + std::to_string(id));
  Battler value; value.id = id; value.level = source["initialLevel"].integer(1); value.classId = source["classId"].integer();
  value.name = source["name"].text(); value.nickname = source["nickname"].text(); value.profile = source["profile"].text();
  value.characterName = source["characterName"].text(); value.characterIndex = source["characterIndex"].integer();
  value.faceName = source["faceName"].text(); value.faceIndex = source["faceIndex"].integer(); value.battlerName = source["battlerName"].text();
  const auto equipTypes = database_["system"]["equipTypes"].array().size();
  const std::size_t slotCount = equipTypes > 0 ? equipTypes - 1 : 0;
  value.equipKinds.assign(slotCount, 2);
  if (!value.equipKinds.empty()) value.equipKinds[0] = 1;
  for (std::size_t slot = 0; slot < slotCount; ++slot) value.equipKinds[slot] = equipSlotType(value, static_cast<int>(slot)) == 1 ? 1 : 2;
  for (const auto& item : source["equips"].array()) value.equips.push_back(item.integer());
  value.equips.resize(slotCount);
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
  for (int id : battler.states) result.push_back(&database_["states"][id]);
  if (battler.enemy) result.push_back(&database_["enemies"][battler.id]);
  else {
    const auto& source = database_["actors"][battler.id];
    result.push_back(&source); result.push_back(&database_["classes"][battler.classId]);
    for (std::size_t i = 0; i < battler.equips.size(); ++i) if (battler.equips[i]) result.push_back(&database_[battler.equipKinds[i] == 1 ? "weapons" : "armors"][battler.equips[i]]);
  }
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
  return jsRound(std::clamp(value, id == 1 ? 0.0 : 1.0, id == 0 && battler.enemy ? 999999.0 : id < 2 ? 9999.0 : 999.0));
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
    battler.states.erase(std::remove(battler.states.begin(), battler.states.end(), state), battler.states.end()); battler.stateTurns.erase(state); battler.stateSteps.erase(state);
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
  refreshBattler(battler);
  if (!contains(battler.result.removedStates, state)) battler.result.removedStates.push_back(state);
}
void Session::addState(Battler& battler, int state) {
  if (state <= 0 || database_["states"][state].null() || battler.hidden || contains(battler.states, 1)) return;
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
    std::stable_sort(battler.states.begin(), battler.states.end(), [&](int a, int b) { const auto pa = database_["states"][a]["priority"].integer(), pb = database_["states"][b]["priority"].integer(); return pa != pb ? pa > pb : a < b; });
    const int newRestriction = restriction(battler);
    if (oldRestriction == 0 && newRestriction > 0) {
      if (battle_.active) {
        const int index = battler.enemy ? static_cast<int>(&battler - battle_.enemies.data()) : static_cast<int>(std::find(party_.begin(), party_.end(), battler.id) - party_.begin());
        battle_.actions.erase(std::remove_if(battle_.actions.begin(), battle_.actions.end(), [&](const Action& action) {
          if (action.enemy != battler.enemy) return false;
          return battler.enemy ? action.subject == index : (action.actorId ? action.actorId : party_[action.subject]) == battler.id;
        }), battle_.actions.end());
        if (!battler.enemy && index < static_cast<int>(battle_.remainingActions.size())) battle_.remainingActions[index] = 0;
      }
      const auto states = battler.states;
      for (int existing : states) if (database_["states"][existing]["removeByRestriction"].boolean()) removeState(battler, existing);
    }
    refreshBattler(battler);
  }
  battler.stateTurns[state] = source["minTurns"].integer() + randomInt(1 + std::max(0, source["maxTurns"].integer() - source["minTurns"].integer()));
  if (!battler.enemy) battler.stateSteps[state] = source["stepsToRemove"].integer();
  if (!contains(battler.result.addedStates, state)) battler.result.addedStates.push_back(state);
}
bool Session::canUse(const Battler& battler, const Value& item) const {
  if (item.null() || battler.hidden || restriction(battler) >= 4) return false;
  const int occasion = item["occasion"].integer();
  if (occasion != 0 && occasion != (battle_.active ? 1 : 2)) return false;
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
  } else if (!item["itypeId"].null() && item["id"].integer() > 0) {
    const auto it = inventory_.find(item["id"].integer());
    if (it == inventory_.end() || it->second <= 0) return false;
  } else return false;
  return true;
}

void Session::apply(Battler& subject, Battler& target, const Value& item, Battler* drainTarget) {
  subject.result = {}; target.result = {};
  auto& result = target.result;
  result.used = canApply(target, item);
  result.physical = item["hitType"].integer() == 1;
  result.drain = item["damage"]["type"].integer() == 5 || item["damage"]["type"].integer() == 6;
  const int hitType = item["hitType"].integer();
  const double success = item["successRate"].number(100) / 100 * (hitType == 1 ? trait(subject, 22, 0, false) : 1);
  const bool missed = result.used && random() >= success;
  result.missed = missed;
  const double evasion = hitType == 1 ? trait(target, 22, 1, false) : hitType == 2 ? trait(target, 22, 4, false) : 0;
  const bool evaded = !missed && random() < evasion;
  result.evaded = evaded;
  if (!result.used || missed || evaded) return;
  const auto& damage = item["damage"];
  if (damage["type"].integer() > 0) {
    const bool critical = random() < (damage["critical"].boolean() ? trait(subject, 22, 2, false) * (1 - trait(target, 22, 3, false)) : 0);
    result.critical = critical;
    const int type = damage["type"].integer();
    const int amount = damageValue(subject, target, item, critical);
    if (amount == 0) result.critical = false;
    if (type == 1 || type == 3 || type == 5) {
      const int actual = type == 5 ? std::min(amount, target.hp) : amount;
      result.hpAffected = true; result.hpDamage = actual;
      target.hp -= actual;
      refreshBattler(target);
      if (actual > 0) {
        auto states = target.states;
        for (int state : states) { const auto& source = database_["states"][state]; if (source["removeByDamage"].boolean() && randomInt(100) < source["chanceByDamage"].number()) removeState(target, state); }
        target.tp += static_cast<int>(std::clamp(std::floor(50.0 * actual / parameter(target, 0) * trait(target, 23, 5, true)), -100.0, 100.0));
        refreshBattler(target);
      }
      if (type == 5) { auto& receiver = drainTarget ? *drainTarget : subject; receiver.hp += actual; receiver.result.hpAffected = true; receiver.result.hpDamage = -actual; refreshBattler(receiver); }
    } else {
      const int actual = type == 6 || amount > 0 ? std::min(amount, target.mp) : amount;
      if (actual != 0) result.success = true;
      result.mpDamage = actual;
      target.mp -= actual; refreshBattler(target);
      if (type == 6) { auto& receiver = drainTarget ? *drainTarget : subject; receiver.mp += actual; receiver.result.mpDamage = -actual; refreshBattler(receiver); }
    }
    if (type == 1 || type == 3 || type == 5) result.success = true;
  }
  for (const auto& effect : item["effects"].array()) applyItemEffect(subject, target, item, effect);
  subject.tp += static_cast<int>(std::floor(item["tpGain"].number() * trait(subject, 23, 5, true)));
  refreshBattler(subject);
}

void Session::startBattle(int troop, bool canEscape, bool canLose, bool event) {
  if (mapSceneOnly()) throw std::runtime_error("battle is outside the map-scene contract");
  if (database_["troops"][troop].null()) throw std::invalid_argument("unknown troop");
  ++system_.battleCount;
  battle_ = {}; resetEnemySprites(); battle_.active = true; battle_.troopId = troop; battle_.canEscape = canEscape; battle_.canLose = canLose; battle_.event = event;
  battleLog_ = std::make_shared<Window_BattleLog>(0,0,0,0);
  battleLog_->bindLines(battle_.log);
  for (const auto& member : database_["troops"][troop]["members"].array()) {
    Battler enemy; enemy.enemy = true; enemy.id = member["enemyId"].integer(); enemy.hidden = member["hidden"].boolean();
    enemy.originalName = database_["enemies"][enemy.id]["name"].text(); enemy.name = enemy.originalName;
    recover(enemy); battle_.enemies.push_back(enemy);
  }
  BattleMechanics::makeUniqueNames(battle_.enemies, battle_.nameCounts, database_["system"]["locale"].text().starts_with("ja") || database_["system"]["locale"].text().starts_with("zh") || database_["system"]["locale"].text().starts_with("ko"));
  if (!event) { battle_.preemptive = random() < BattleMechanics::ratePreemptive(*this); battle_.surprise = random() < BattleMechanics::rateSurprise(*this) && !battle_.preemptive; }
  double actorsAgi = 0, enemiesAgi = 0;
  for (int id : party_) {
    auto& value = actors_.at(id);
    if (!hasSpecialFlag(value, 3)) value.tp = randomInt(25);
    value.escaped = false; value.requestedMotion = -1; value.requestedWeapon = 0;
  }
  for (std::size_t index = 0; index < battleMemberCount(); ++index) actorsAgi += parameter(actors_.at(party_[index]), 6);
  for (auto& value : battle_.enemies) { if (!hasSpecialFlag(value, 3)) value.tp = randomInt(25); enemiesAgi += parameter(value, 6); }
  actorsAgi /= std::max<std::size_t>(1, battleMemberCount()); enemiesAgi /= std::max<std::size_t>(1, battle_.enemies.size());
  battle_.escapeRatio = 0.5 * actorsAgi / std::max(1.0, enemiesAgi);
  ui_ = {}; ui_.scene = Scene::battle;
  battle_.mapBgm = savedBgm_; battle_.mapBgs = savedBgs_;
  audio("battle-save", {});
  AudioManager::stopBgs(*this);
  const auto battleBgm = system_.battleBgm.null() ? database_["system"]["battleBgm"] : system_.battleBgm;
  AudioManager::playBgm(*this, battleBgm);
  battle_.opening = true; ui_.category = 4;
  buildBattleIntro();
  updateEnemySprites();
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
  const int scope = item["scope"].integer();
  return scope >= 1 && scope <= 6 ? Window_BattleEnemy::makeTargets(*this) : Window_BattleActor::makeTargets(*this);
}
std::set<int> Session::battlerSkills(const Battler& actor) const {
  auto skills = actor.skills;
  for (const auto* object : traitObjects(actor)) for (const auto& entry : (*object)["traits"].array())
    if (entry["code"].integer() == 43) skills.insert(entry["dataId"].integer());
  return skills;
}
std::vector<int> Session::battleSkillTypes(int actorIndex) const {
  return Window_ActorCommand::skillTypes(*this, party_.at(actorIndex));
}
void Session::makeEnemyActions() {
  battle_.actions.clear(); battle_.actorIndex = 0; ui_.category = 4; ui_.cursor = 0;
  battle_.remainingActions.assign(battleMemberCount(), 0);
  for (auto& [id, actor] : actors_) { (void)id; actor.guarding = false; }
  for (std::size_t index = 0; index < battleMemberCount(); ++index) {
    auto& actor = actors_.at(party_[index]); const int count = battleActionCount(actor);
    const bool autoBattle = hasSpecialFlag(actor, 0);
    const bool automatic = autoBattle || restriction(actor) > 0;
    if (!automatic) battle_.remainingActions[index] = battle_.surprise ? 0 : count;
    else for (int action = 0; action < count; ++action) {
      int skill = autoBattle ? 0 : 1, target = -1;
      if (autoBattle) {
        double best = std::numeric_limits<double>::min();
        std::vector<int> skills{1};
        skills.insert(skills.end(), actor.skills.begin(), actor.skills.end());
        for (const auto* object : traitObjects(actor)) for (const auto& entry : (*object)["traits"].array()) {
          const int id = entry["dataId"].integer();
          if (entry["code"].integer() == 43 && std::find(skills.begin() + 1, skills.end(), id) == skills.end()) skills.push_back(id);
        }
        for (int id : skills) if (canUse(actor, database_["skills"][id])) {
          int candidateTarget = -1;
          const double score = evaluateAutoAction(actor, database_["skills"][id], candidateTarget);
          if (score > best) { best = score; skill = id; target = candidateTarget; }
        }
      }
      battle_.actions.push_back({false, false, static_cast<int>(index), skill, target, 0});
    }
  }
  for (std::size_t index = 0; index < battle_.enemies.size(); ++index) {
    auto& enemy = battle_.enemies[index]; enemy.guarding = false;
    const int count = battleActionCount(enemy);
    for (int action = 0; action < count; ++action) {
      const int skill = selectEnemySkill(enemy);
      battle_.actions.push_back({true, false, static_cast<int>(index), skill, -1, 0});
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
  battle_.actions.erase(std::remove_if(battle_.actions.begin(), battle_.actions.end(), [&](const Action& action) {
    return action.enemy ? battle_.preemptive : battle_.surprise;
  }), battle_.actions.end());
  const auto& pages = database_["troops"][battle_.troopId]["pages"].array();
  for (std::size_t index = 0; index < pages.size(); ++index) if (pages[index]["span"].integer() == 1) battle_.eventFlags.erase(static_cast<int>(index));
  const auto includeEmptySubject = [&](bool enemy, int index, const Battler& battler) {
    if (!battler.isAlive() || battler.escaped) return;
    if (std::none_of(battle_.actions.begin(), battle_.actions.end(), [&](const Action& action) { return action.enemy == enemy && action.subject == index; }))
      battle_.actions.push_back({enemy, false, index, 0, -1, std::numeric_limits<double>::infinity()});
  };
  if (!battle_.surprise) for (std::size_t index = 0; index < battleMemberCount(); ++index)
    includeEmptySubject(false, static_cast<int>(index), actors_.at(party_[index]));
  if (!battle_.preemptive) for (std::size_t index = 0; index < battle_.enemies.size(); ++index)
    includeEmptySubject(true, static_cast<int>(index), battle_.enemies[index]);
  std::stable_sort(battle_.actions.begin(), battle_.actions.end(), [](const Action& a, const Action& b) { return a.enemy != b.enemy ? !a.enemy : a.subject < b.subject; });
  for (auto& action : battle_.actions) {
    if (std::isinf(action.speed)) continue;
    auto& battler = action.enemy ? battle_.enemies[action.subject] : actors_.at(party_[action.subject]);
    const auto& skill = database_[action.item ? "items" : "skills"][action.id];
    double attackSpeed = 0;
    if (!action.item && action.id == 1) for (const auto* object : traitObjects(battler)) for (const auto& entry : (*object)["traits"].array())
      if (entry["code"].integer() == 33) attackSpeed += entry["value"].number();
    action.speed = parameter(battler, 6) + randomInt(static_cast<int>(std::floor(5 + parameter(battler, 6) / 4))) + skill["speed"].number() + attackSpeed;
  }
  std::map<std::pair<bool,int>,double> speeds;
  for (const auto& action : battle_.actions) {
    const auto key = std::make_pair(action.enemy, action.subject);
    const auto found = speeds.find(key);
    if (found == speeds.end()) speeds[key] = action.speed;
    else found->second = std::min(found->second, action.speed);
  }
  for (auto& action : battle_.actions) action.speed = speeds.at({action.enemy, action.subject});
  std::stable_sort(battle_.actions.begin(), battle_.actions.end(), [](const Action& a, const Action& b) { return a.speed > b.speed; });
  battle_.wait = 1;
  battleLog_->push({"wait"});
}
void Session::executeAction(const Action& selectedAction) {
  if (std::isinf(selectedAction.speed)) return;
  Action action = selectedAction;
  auto& subject = action.enemy ? battle_.enemies[action.subject] : actors_.at(action.actorId ? action.actorId : party_[action.subject]);
  if (!action.forced && (!subject.isAlive() || subject.escaped || restriction(subject) >= 4)) return;
  if (!action.forced && restriction(subject) > 0) { action.id = 1; action.item = false; action.target = -1; }
  const auto& item = database_[action.item ? "items" : "skills"][action.id];
  if (!action.forced && !canUse(subject, item)) return;
  if (action.item) { if (inventory_[action.id] <= 0) return; if (item["consumable"].boolean()) --inventory_[action.id]; }
  else { subject.mp -= static_cast<int>(std::floor(item["mpCost"].number() * trait(subject, 23, 4, true))); subject.tp -= item["tpCost"].integer(); }
  const auto targets = actionTargets(action, subject, item);
  if (!action.item && action.id == 2) subject.guarding = true;
  applyGlobalEffects(item);
  BattleVisual visual; visual.action = action;
  visual.movementStarted = visual.started = std::numeric_limits<std::uint64_t>::max();
  const int repeats = std::max(0, item["repeats"].integer(1) + ((!action.item && action.id == 1) ? static_cast<int>(std::max(0.0, trait(subject, 34, 0, false))) : 0));
  for (auto* target : targets) {
    BattleTarget visualTarget; visualTarget.enemy = target->enemy;
    if (target->enemy) visualTarget.index = static_cast<int>(target - battle_.enemies.data());
    else {
      const auto position = std::find(party_.begin(), party_.end(), target->id);
      visualTarget.index = position == party_.end() ? -1 : static_cast<int>(position - party_.begin());
      visualTarget.actorId = target->id;
    }
    for (int repeat = 0; repeat < repeats; ++repeat) visual.targets.push_back(visualTarget);
  }
  visual.animationTargets = visual.targets;
  visual.invocationCount = visual.targets.size();
  battle_.wait = 0;
  battle_.visuals.push_back(std::move(visual));
  if (battle_.visuals.size() > 32) battle_.visuals.erase(battle_.visuals.begin());
  battle_.currentVisual = static_cast<int>(battle_.visuals.size()) - 1; battle_.actionStage = 1; battle_.targetIndex = 0;
  const int targetId = action.enemy ? -action.subject-1 : subject.id;
  battleLog_->push({"clear"});
  battleLog_->push({"performActionStart",0,targetId,battle_.currentVisual});
  battleLog_->push({"waitForMovement"});
  battleLog_->push({"performAction",0,targetId,battle_.currentVisual});
  battleLog_->push({"showAnimation",0,0,battle_.currentVisual});
  battleLog_->displayAction(*this,subject,item);
}
void Session::resolveAction() {
  auto& visual = battle_.visuals.at(battle_.currentVisual); const auto& action = visual.action;
  auto& subject = action.enemy ? battle_.enemies[action.subject] : actors_.at(action.actorId ? action.actorId : party_[action.subject]);
  const auto& item = database_[action.item ? "items" : "skills"][action.id];
  if (battle_.targetIndex < static_cast<int>(visual.invocationCount)) {
    auto& entry = visual.targets[battle_.targetIndex++];
    auto& target = entry.enemy ? battle_.enemies[entry.index] : actors_.at(entry.actorId ? entry.actorId : party_[entry.index]);
    Battler* receiver = &target;
    Battler* resultSubject = &subject;
    const bool physical = item["hitType"].integer() == 1, magical = item["hitType"].integer() == 2;
    if (random() < (physical && !target.hidden && restriction(target) < 4 ? trait(target, 22, 6, false) : 0)) {
      battleLog_->displayCounter(*this,target);
      apply(target, subject, database_["skills"][1]);
      receiver = &subject;
      resultSubject = &target;
    }
    else if (random() < (magical ? trait(target, 22, 5, false) : 0)) {
      battleLog_->displayReflection(*this,target);
      apply(subject, subject, item, &target); receiver = &subject;
      resultSubject = &target;
    }
    else {
      if (target.isAlive() && target.hp < parameter(target, 0) / 4.0 && item["hitType"].integer() != 0) {
        if (target.enemy) {
          for (auto& member : battle_.enemies) if (!member.hidden && BattleMechanics::canSubstitute(*this, member, target)) { receiver = &member; break; }
        } else for (std::size_t index = 0; index < battleMemberCount(); ++index) {
          auto& member = actors_.at(party_[index]);
          if (BattleMechanics::canSubstitute(*this, member, target)) { receiver = &member; break; }
        }
      }
      if (receiver != &target) battleLog_->displaySubstitute(*this,*receiver,target);
      apply(subject, *receiver, item);
    }
    subject.lastTargetIndex = entry.index;
    entry.result = receiver->result;
    entry.enemy = receiver->enemy;
    if (receiver->enemy) { entry.index = static_cast<int>(receiver - battle_.enemies.data()); entry.actorId = 0; }
    else {
      const auto position = std::find(party_.begin(), party_.end(), receiver->id);
      entry.index = position == party_.end() ? -1 : static_cast<int>(position - party_.begin());
      entry.actorId = receiver->id;
    }
    entry.aliveAtImpact = receiver->isAlive();
    battleLog_->displayActionResults(*this,*resultSubject,*receiver);
  }
}

void Session::endBattlerActions(Battler& battler) {
  battler.result = {};
  const auto states = battler.states;
  for (int state : states) {
    const auto turns=battler.stateTurns.find(state);
    if (database_["states"][state]["autoRemovalTiming"].integer() == 1 && turns!=battler.stateTurns.end() && turns->second == 0) removeState(battler, state);
  }
  for (int parameter = 0; parameter < 8; ++parameter) if (battler.isAlive() && battler.buffs[parameter] && battler.buffTurns[parameter] == 0) {
    battler.buffs[parameter] = 0; battler.result.removedBuffs.push_back(parameter);
    refreshBattler(battler);
  }
  battleLog_->displayAutoAffectedStatus(*this,battler);
  battleLog_->displayCurrentState(*this,battler);
  battleLog_->displayRegeneration(*this,battler);
}
void Session::endBattlerTurn(Battler& battler) {
    battler.result = {};
    if (battler.isAlive()) {
      const int hpChange = static_cast<int>(std::floor(parameter(battler, 0) * trait(battler, 22, 7, false)));
      const int hpValue = std::max(hpChange, -(battler.hp - (database_["system"]["optSlipDeath"].boolean() ? 0 : 1)));
      battler.result.hpDamage = -hpValue; battler.result.hpAffected = hpValue != 0; battler.hp += hpValue;
      if (hpValue != 0) refreshBattler(battler);
      const int mpValue = static_cast<int>(std::floor(parameter(battler, 1) * trait(battler, 22, 8, false)));
      battler.result.mpDamage = -mpValue; battler.mp += mpValue;
      if (mpValue != 0) refreshBattler(battler);
      battler.tp += static_cast<int>(std::floor(100 * trait(battler, 22, 9, false)));
      refreshBattler(battler);
    }
    auto states = battler.states;
    if (!battle_.forcedTurn) for (int state : states) {
      const auto turns=battler.stateTurns.find(state);
      if (turns!=battler.stateTurns.end() && turns->second > 0) --turns->second;
    }
    if (!battle_.forcedTurn) for (int i = 0; i < 8; ++i) if (battler.buffTurns[i] > 0) --battler.buffTurns[i];
    for (int state : states) {
      const auto turns=battler.stateTurns.find(state);
      if (database_["states"][state]["autoRemovalTiming"].integer() == 2 && turns!=battler.stateTurns.end() && turns->second == 0) removeState(battler, state);
    }
}
void Session::endTurn() {
  const auto finish = [&](Battler& battler) {
    endBattlerTurn(battler);
    battleLog_->displayAutoAffectedStatus(*this,battler);
    battleLog_->displayRegeneration(*this,battler);
  };
  for (std::size_t index = 0; index < battleMemberCount(); ++index) finish(actors_.at(party_[index]));
  for (auto& battler : battle_.enemies) finish(battler);
  battle_.forcedTurn = false;
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
  if (result != 2) for (std::size_t index = 0; index < battleMemberCount(); ++index) {
    auto& actor = actors_.at(party_[index]);
    if (actor.hidden) continue;
    const auto states = actor.states;
    for (int state : states) if (database_["states"][state]["removeAtBattleEnd"].boolean()) removeState(actor, state);
  }
  std::vector<std::pair<std::string, int>> drops;
  int gold = 0;
  int totalExp = 0;
  if (result == 0) ++system_.winCount;
  if (result == 1) ++system_.escapeCount;
  if (result == 0) {
    for (const auto& enemy : battle_.enemies) if (enemy.isDead()) {
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
    message_.lines.emplace_back("\\." + battleMessage("obtainExp", {std::to_string(totalExp), TextManager::exp(*this)}));
  }
  if (gold > 0) message_.lines.emplace_back("\\." + battleMessage("obtainGold", {std::to_string(gold)}));
  if (!drops.empty()) {
    message_.pageBreaks.insert(static_cast<int>(message_.lines.size()));
    for (const auto& [kind, id] : drops) message_.lines.emplace_back(battleMessage("obtainItem", {database_[kind][id]["name"].text()}));
  }
  if (totalExp > 0) {
    for (int id : party_) {
      auto& actor = actors_.at(id);
      {
        const auto position = std::find(party_.begin(), party_.end(), id);
        const double gained = std::floor(totalExp * trait(actor, 23, 9, true) * ((position - party_.begin() < 4 && !actor.hidden) || database_["system"]["optExtraExp"].boolean() ? 1 : 0) + 0.5);
        changeActorExp(actor, actor.exp[actor.classId] + gained, true);
      }
    }
  }
  if (result == 0) AudioManager::playMe(*this, (system_.victoryMe.null() ? database_["system"]["victoryMe"] : system_.victoryMe));
  if (result == 2) AudioManager::playMe(*this, (system_.defeatMe.null() ? database_["system"]["defeatMe"] : system_.defeatMe));
  if (result != 2 || battle_.canLose) {
    savedBgm_ = battle_.mapBgm; savedBgs_ = battle_.mapBgs;
    audio("battle-restore-bgm", {}); audio("battle-restore-bgs", {});
  } else AudioManager::stopBgm(*this);
  setBattleEventResult(result);
}
void Session::abortBattle() {
  if (!battle_.active) return;
  SoundManager::playEscape(*this);
  battle_.aborting = false;
  battle_.result = 1; battle_.active = false; battle_.wait = 0;
  battle_.actions.clear(); battle_.log.clear(); message_ = {};
  ++system_.escapeCount;
  savedBgm_ = battle_.mapBgm; savedBgs_ = battle_.mapBgs;
  audio("battle-restore-bgm", {}); audio("battle-restore-bgs", {});
  setBattleEventResult(1);
  leaveBattle();
}
void Session::leaveBattle() {
  if (battleTest_) { AudioManager::stopBgm(*this); finished_ = true; return; }
  const int result = battle_.result;
  for (std::size_t index = 0; index < party_.size(); ++index) {
    auto& value = actors_.at(party_[index]);
    if (result == 2 && battle_.canLose && index < 4 && value.isDead()) { value.hp = 1; removeState(value, 1); }
    value.result = {};
    auto states = value.states; for (int state : states) if (database_["states"][state]["removeAtBattleEnd"].boolean()) removeState(value, state);
    if (value.isAlive()) { value.buffs.fill(0); value.buffTurns.fill(0); }
    if (!hasSpecialFlag(value, 3)) value.tp = 0;
    refreshBattler(value);
    value.guarding = false; value.escaped = false; value.hidden = false;
  }
  if (result == 2 && !battle_.canLose) { openGameOver(); return; }
  ui_ = {}; ui_.scene = Scene::map;
  encounterCount_ = randomInt(map()["encounterStep"].integer(30)) + randomInt(map()["encounterStep"].integer(30)) + 1;
}
void Session::updateBattle() {
  updateEnemySprites();
  if (ui_.scene != Scene::battle) return;
  if (!battle_.active) { if (battle_.result >= 0 && !message_.busy) leaveBattle(); return; }
  const bool moving = std::any_of(battle_.visuals.begin(), battle_.visuals.end(), [&](const BattleVisual& visual) {
    return visual.actionVisual && !visual.action.enemy && visual.action.subject >= 0 && visual.action.subject < static_cast<int>(battleMemberCount()) && ((visual.returned && ticks_ - visual.returned < 12) ||
      (!visual.returned && ticks_ >= visual.movementStarted && ticks_ - visual.movementStarted < 12));
  });
  const bool effecting = isBattleEffecting();
  battleLog_->tick(*this,currentInput_.okLongPressed || currentInput_.dash || currentInput_.touchLongPressed,effecting,moving);
  if (message_.busy) return;
  if (std::any_of(visualEffects_.begin(), visualEffects_.end(), [&](const VisualEffect& effect) {
    return effect.targetType > 0 && !effect.balloon && (ticks_ < effect.started || ticks_ - effect.started < static_cast<std::uint64_t>(effect.duration));
  })) return;
  bool processingTurn = battle_.wait > 0 || battle_.actionStage != 0;
  if (battle_.actionStage) {
    if (battle_.wait > 0 && --battle_.wait > 0) return;
    if (battleLog_->isBusy()) return;
    if (battle_.actionStage == 1 && battle_.targetIndex < static_cast<int>(battle_.visuals.at(battle_.currentVisual).invocationCount)) {
      battleLog_->push({"pushBaseLine"});
      resolveAction();
      battleLog_->push({"popBaseLine"});
      battle_.actionStage = 2;
      return;
    }
    if (battle_.actionStage == 1) battle_.actionStage = 2;
    if (battle_.actionStage == 2) {
      if (battle_.targetIndex < static_cast<int>(battle_.visuals.at(battle_.currentVisual).invocationCount)) {
        battle_.actionStage = 1;
        return;
      }
      auto& visual = battle_.visuals.at(battle_.currentVisual);
      visual.returned = ticks_;
      battleLog_->push({"waitForNewLine"});
      battleLog_->push({"clear"});
      battleLog_->push({"waitForMovement"});
      battle_.actionStage = 3;
      battle_.wait = visual.action.enemy || visual.action.subject < 0 || visual.action.subject >= static_cast<int>(battleMemberCount()) ? 0 : 12;
      return;
    }
    auto& visual = battle_.visuals.at(battle_.currentVisual); const auto& action = visual.action;
    auto& subject = action.enemy ? battle_.enemies[action.subject] : actors_.at(action.actorId ? action.actorId : party_[action.subject]);
    if (std::none_of(battle_.actions.begin(), battle_.actions.end(), [&](const Action& next) { return next.enemy == action.enemy && next.subject == action.subject && next.actorId == action.actorId; })) {
      endBattlerActions(subject);
    }
    battle_.actionStage = 0;
    if (battle_.forcedExecuting) {
      battle_.forcedExecuting = false; battle_.wait = battle_.forcedResumeWait;
      processingTurn = battle_.wait > 0;
    }
  }
  if (battleLog_->isBusy()) return;
  if (!battle_.forcedActions.empty()) {
    const auto forced = battle_.forcedActions.front(); battle_.forcedActions.erase(battle_.forcedActions.begin());
    battle_.forcedResumeWait = battle_.wait; battle_.forcedExecuting = true; battle_.forcedTurn = true;
    executeAction(forced);
    if (!battle_.actionStage) { battle_.forcedExecuting = false; battle_.wait = battle_.forcedResumeWait; }
    return;
  }
  if (updateTroopEvents()) return;
  if (!battle_.active || message_.busy) return;
  if (battle_.aborting || std::none_of(party_.begin(), party_.begin() + static_cast<std::ptrdiff_t>(battleMemberCount()), [&](int id) { const auto& member = actors_.at(id); return !member.hidden && !member.escaped; })) { abortBattle(); return; }
  const bool defeated = std::none_of(party_.begin(), party_.begin() + static_cast<std::ptrdiff_t>(battleMemberCount()), [&](int id) { return actors_.at(id).isAlive() && !actors_.at(id).escaped; });
  const bool victorious = std::none_of(battle_.enemies.begin(), battle_.enemies.end(), [](const Battler& battler) { return battler.isAlive() && !battler.escaped; });
  if (defeated || victorious) { finishBattle(defeated ? 2 : 0); return; }
  if (battle_.opening) { battle_.opening = false; makeEnemyActions(); return; }
  if (battle_.turnEnding) { battle_.turnEnding = false; makeEnemyActions(); return; }
  if (!processingTurn && battle_.wait <= 0) {
    while (battle_.actorIndex < static_cast<int>(battleMemberCount()) &&
        (battle_.remainingActions[battle_.actorIndex] <= 0 || actors_.at(party_[battle_.actorIndex]).hidden || restriction(actors_.at(party_[battle_.actorIndex])) > 0)) {
      battle_.remainingActions[battle_.actorIndex] = 0; ++battle_.actorIndex;
    }
    if (battle_.actorIndex >= static_cast<int>(battleMemberCount())) beginTurn();
    return;
  }
  if (battle_.wait > 0 && --battle_.wait > 0) return;
  if (battle_.actions.empty()) { endTurn(); return; }
  const auto action = battle_.actions.front(); battle_.actions.erase(battle_.actions.begin()); executeAction(action);
  if (!battle_.actionStage &&
      std::none_of(battle_.actions.begin(), battle_.actions.end(), [&](const Action& next) { return next.enemy == action.enemy && next.subject == action.subject && next.actorId == action.actorId; })) {
    auto& subject = action.enemy ? battle_.enemies[action.subject] : actors_.at(action.actorId ? action.actorId : party_[action.subject]);
    endBattlerActions(subject);
  }
  if (!battle_.wait) battle_.wait = 1;
}
int Session::menuItemUser() const {
  int selected = -1; double maximum = -1;
  for (std::size_t i = 0; i < party_.size(); ++i) {
    const auto& actor = actors_.at(party_[i]); const double value = trait(actor, 23, 3, true);
    if (!actor.hidden && restriction(actor) < 4 && value > maximum) { maximum = value; selected = static_cast<int>(i); }
  }
  return selected;
}
bool Session::canApply(const Battler& target, const Value& item) const {
  const int scope = item["scope"].integer();
  if ((scope == 9 || scope == 10) != target.isDead()) return false;
  if (battle_.active || (scope >= 1 && scope <= 6)) return true;
  if (item["damage"]["type"].integer() == 3 && target.hp < parameter(target, 0)) return true;
  if (item["damage"]["type"].integer() == 4 && target.mp < parameter(target, 1)) return true;
  for (const auto& effect : item["effects"].array()) {
    const int code = effect["code"].integer();
    if (code == 11 && (target.hp < parameter(target, 0) || effect["value1"].number() < 0 || effect["value2"].number() < 0)) return true;
    if (code == 12 && (target.mp < parameter(target, 1) || effect["value1"].number() < 0 || effect["value2"].number() < 0)) return true;
    if (code == 13) return true;
    if (code == 21 && !contains(target.states, effect["dataId"].integer())) return true;
    if (code == 22 && contains(target.states, effect["dataId"].integer())) return true;
    if (code == 31 && target.buffs[effect["dataId"].integer()] < 2) return true;
    if (code == 32 && target.buffs[effect["dataId"].integer()] > -2) return true;
    if (code == 33 && target.buffs[effect["dataId"].integer()] > 0) return true;
    if (code == 34 && target.buffs[effect["dataId"].integer()] < 0) return true;
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
  else for (int repeat = 0; repeat < repeats; ++repeat) apply(subject, actors_.at(party_[target]), item);
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
  const auto removed = stripEquipment(actor);
  if (!forcing) for (const auto& [kind,id] : removed) gainItem(kind,id,1,false);
}
std::vector<std::pair<int,int>> Session::stripEquipment(Battler& actor) const {
  std::vector<std::pair<int,int>> removed;
  bool changed;
  do {
    changed = false;
    for (std::size_t slot = 0; slot < actor.equips.size(); ++slot) {
      const int id = actor.equips[slot];
      if (id && !canEquip(actor, database_[actor.equipKinds[slot] == 1 ? "weapons" : "armors"][id], static_cast<int>(slot))) {
        removed.emplace_back(actor.equipKinds[slot],id);
        actor.equips[slot] = 0; changed = true;
      }
    }
  } while (changed);
  return removed;
}
Battler Session::previewEquipment(const Battler& actor, int slot, int item) const {
  Battler preview = actor;
  if (slot < 0 || slot >= static_cast<int>(preview.equips.size())) return preview;
  const int kind = equipSlotType(actor,slot) == 1 ? 1 : 2;
  preview.equips[slot] = item;
  preview.equipKinds[slot] = kind;
  stripEquipment(preview);
  std::vector<int> resisted;
  for (const auto* object : traitObjects(preview)) for (const auto& value : (*object)["traits"].array())
    if (value["code"].integer() == 14) resisted.push_back(value["dataId"].integer());
  for (int state : resisted) {
    std::erase(preview.states,state); preview.stateTurns.erase(state); preview.stateSteps.erase(state);
  }
  preview.hp = std::clamp(preview.hp,0,static_cast<int>(parameter(preview,0)));
  preview.mp = std::clamp(preview.mp,0,static_cast<int>(parameter(preview,1)));
  preview.tp = std::clamp(preview.tp,0,100);
  return preview;
}
bool Session::canEquip(const Battler& actor, const Value& item, int slot) const {
  if (item.null() || item["etypeId"].integer() != equipSlotType(actor, slot)) return false;
  return canEquipItem(actor,item);
}
bool Session::canEquipItem(const Battler& actor, const Value& item) const {
  if (item.null()) return false;
  const bool weapon = !item["wtypeId"].null();
  if (!weapon && item["atypeId"].null()) return false;
  const int etype = item["etypeId"].integer();
  bool permitted = false;
  for (const auto* object : traitObjects(actor)) for (const auto& entry : (*object)["traits"].array()) {
    if (entry["code"].integer() == 54 && entry["dataId"].integer() == etype) return false;
    if (entry["code"].integer() == (weapon ? 51 : 52) && entry["dataId"].integer() == item[weapon ? "wtypeId" : "atypeId"].integer()) permitted = true;
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
  const int kindIndex = weapon ? 1 : 2;
  if (old) gainItem(kindIndex, old, 1, false);
  if (itemId) gainItem(kindIndex, itemId, -1, false);
  value.equips[slot] = itemId; value.equipKinds[slot] = kindIndex; refreshBattler(value);
}
}  // namespace pmjs::mv
