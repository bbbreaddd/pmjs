#include "mv_engine.hpp"
#include "mv_sprites.hpp"
#include "mv_battle_extra.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <unordered_map>

namespace pmjs::mv {
void Session::requestActorMotion(int actorId, int motion, int weaponImageId) {
  auto& actor = actors_.at(actorId);
  actor.requestedMotion = motion; actor.requestedWeapon = weaponImageId;
  actor.motionRequestedAt = ticks_;
}
void Session::setupBattleTest() {
  newGame();
  battleTest_ = true; party_.clear(); actors_.clear(); inventory_.clear();
  for (const auto& battler : database_["system"]["testBattlers"].array()) {
    const int id = battler["actorId"].integer();
    if (database_["actors"][id].null()) continue;
    if (!actors_.contains(id)) initializeActor(id);
    auto& actor = actors_.at(id);
    const int maximum = database_["actors"][id]["maxLevel"].integer(99);
    changeActorExp(actor, actorExpForLevel(actor, std::clamp(battler["level"].integer(), 1, maximum)), false);
    std::fill(actor.equips.begin(), actor.equips.end(), 0);
    for (std::size_t slot = 0; slot < actor.equips.size(); ++slot) {
      actor.equipKinds[slot] = equipSlotType(actor, static_cast<int>(slot)) == 1 ? 1 : 2;
      actor.equips[slot] = battler["equips"][static_cast<int>(slot)].integer();
    }
    releaseEquipment(actor, true); recover(actor);
    if (std::find(party_.begin(), party_.end(), id) == party_.end()) party_.push_back(id);
  }
  for (const auto& item : database_["items"].array()) if (!item.null() && !item["name"].text().empty()) gainItem(0, item["id"].integer(), 99, false);
  updatePlayerGraphic();
  startBattle(database_["system"]["testTroopId"].integer(), true, false, true);
  battle_.event = false;
}

bool Session::hasSpecialFlag(const Battler& battler, int flag) const {
  for (const auto* object : traitObjects(battler)) for (const auto& entry : (*object)["traits"].array())
    if (entry["code"].integer() == 62 && entry["dataId"].integer() == flag) return true;
  return false;
}
bool Session::hasPartyAbility(int ability) const {
  for (std::size_t index = 0; index < battleMemberCount(); ++index) for (const auto* object : traitObjects(actors_.at(party_[index]))) for (const auto& entry : (*object)["traits"].array())
    if (entry["code"].integer() == 64 && entry["dataId"].integer() == ability) return true;
  return false;
}
int Session::battleActionCount(const Battler& battler) {
  if (battler.hp <= 0 || battler.hidden || restriction(battler) >= 4) return 0;
  int count = 1;
  for (const auto* object : traitObjects(battler)) for (const auto& entry : (*object)["traits"].array())
    if (entry["code"].integer() == 61 && random() < entry["value"].number()) ++count;
  return count;
}
int Session::selectEnemySkill(const Battler& enemy) {
  if (restriction(enemy) > 0) return 1;
  std::vector<const Value*> choices;
  int maximum = 0;
  for (const auto& entry : database_["enemies"][enemy.id]["actions"].array()) {
    const int type = entry["conditionType"].integer();
    const double a = entry["conditionParam1"].number(), b = entry["conditionParam2"].number();
    bool valid = type == 0;
    if (type == 1) valid = b == 0 ? battle_.turn == a : battle_.turn > 0 && battle_.turn >= a && std::fmod(battle_.turn, b) == std::fmod(a, b);
    if (type == 2) valid = enemy.hp / parameter(enemy, 0) >= a && enemy.hp / parameter(enemy, 0) <= b;
    if (type == 3) valid = enemy.mp / parameter(enemy, 1) >= a && enemy.mp / parameter(enemy, 1) <= b;
    if (type == 4) valid = std::find(enemy.states.begin(), enemy.states.end(), static_cast<int>(a)) != enemy.states.end();
    if (type == 5) { valid = false; for (std::size_t index = 0; index < battleMemberCount(); ++index) valid = valid || actors_.at(party_[index]).level >= a; }
    if (type == 6) { const auto it = switches_.find(static_cast<int>(a)); valid = it != switches_.end() && it->second; }
    if (valid && canUse(enemy, database_["skills"][entry["skillId"].integer()])) {
      choices.push_back(&entry); maximum = std::max(maximum, entry["rating"].integer());
    }
  }
  int total = 0;
  for (const auto* choice : choices) total += std::max(0, (*choice)["rating"].integer() - maximum + 3);
  if (!total) return 0;
  int value = randomInt(total);
  for (const auto* choice : choices) {
    value -= std::max(0, (*choice)["rating"].integer() - maximum + 3);
    if (value < 0) return (*choice)["skillId"].integer();
  }
  return 0;
}
std::vector<Battler*> Session::actionTargets(const Action& action, Battler& subject, const Value& item) {
  const int scope = item["scope"].integer();
  bool opponent = scope >= 1 && scope <= 6;
  const int confusion = action.forced ? 0 : restriction(subject);
  const bool confused = confusion > 0 && confusion < 4;
  if (confused) opponent = confusion == 1 || (confusion == 2 && randomInt(2) == 0);
  const bool enemies = opponent != action.enemy;
  const bool dead = !confused && (scope == 9 || scope == 10);
  std::vector<Battler*> candidates;
  if (enemies) {
    for (auto& enemy : battle_.enemies) if (!enemy.hidden && !enemy.escaped && (enemy.hp <= 0) == dead) candidates.push_back(&enemy);
  } else for (std::size_t index = 0; index < battleMemberCount(); ++index) {
    auto& actor = actors_.at(party_[index]);
    if (!actor.hidden && !actor.escaped && (actor.hp <= 0) == dead) candidates.push_back(&actor);
  }
  const auto weighted = [&]() -> Battler* {
    double sum = 0;
    for (const auto* candidate : candidates) sum += trait(*candidate, 23, 0, true);
    double choice = random() * sum;
    Battler* selected = nullptr;
    for (auto* candidate : candidates) {
      choice -= trait(*candidate, 23, 0, true);
      if (choice <= 0 && !selected) selected = candidate;
    }
    return selected;
  };
  std::vector<Battler*> targets;
  if (!confused && !scope) return targets;
  if (!confused && scope == 11) targets.push_back(&subject);
  else if (!confused && (scope == 2 || scope == 8 || scope == 10)) targets = candidates;
  else if (!confused && scope >= 3 && scope <= 6) {
    for (int i = 0; i < scope - 2; ++i) if (auto* candidate = weighted()) targets.push_back(candidate);
  } else if (!candidates.empty()) {
    Battler* selected = nullptr;
    if (!confused && action.target >= 0) {
      if (enemies && action.target < static_cast<int>(battle_.enemies.size())) selected = &battle_.enemies[action.target];
      if (!enemies && action.target < static_cast<int>(battleMemberCount())) selected = &actors_.at(party_[action.target]);
      if (std::find(candidates.begin(), candidates.end(), selected) == candidates.end()) selected = candidates.front();
    } else if (dead) selected = candidates[randomInt(static_cast<int>(candidates.size()))];
    else selected = weighted();
    if (selected) targets.push_back(selected);
  }
  return targets;
}

int Session::damageValue(Battler& subject, Battler& target, const Value& item, bool critical) {
  const auto& damage = item["damage"];
  const int hitType = item["hitType"].integer();
  double value = 0;
  try { value = std::max(0.0, evaluateExpression(damage["formula"].text(), &subject, &target)); }
  catch (const std::exception&) { return 0; }
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
  if (!std::isfinite(value)) return 0;
  const int amplitude = static_cast<int>(std::floor(std::clamp(std::abs(value) * damage["variance"].number() / 100, 0.0, 999999999.0)));
  const int variation = randomInt(amplitude + 1) + randomInt(amplitude + 1) - amplitude;
  value += value >= 0 ? variation : -variation;
  const bool guarding = hasSpecialFlag(target, 1);
  if (value > 0 && guarding && restriction(target) < 4) value /= 2 * trait(target, 23, 1, true);
  if (!std::isfinite(value)) return 0;
  return static_cast<int>(std::floor(std::clamp(value, -999999999.0, 999999999.0) + 0.5));
}

double Session::evaluateAutoAction(Battler& subject, const Value& item, int& targetIndex) {
  const int scope = item["scope"].integer(), type = item["damage"]["type"].integer();
  if (!scope || (type != 1 && type != 3 && type != 5)) return 0;
  const bool opponent = scope >= 1 && scope <= 6;
  const bool dead = scope == 9 || scope == 10;
  std::vector<Battler*> candidates;
  if (scope == 11) candidates.push_back(&subject);
  else if (opponent) {
    for (auto& enemy : battle_.enemies) if (enemy.hp > 0 && !enemy.hidden && !enemy.escaped) candidates.push_back(&enemy);
  } else for (std::size_t index = 0; index < battleMemberCount(); ++index) {
    auto& actor = actors_.at(party_[index]); if ((actor.hp <= 0) == dead && !actor.escaped) candidates.push_back(&actor);
  }
  double score = 0;
  for (auto* target : candidates) {
    const int damage = damageValue(subject, *target, item, false);
    const double value = opponent ? damage / static_cast<double>(std::max(target->hp, 1)) : std::min(-damage, static_cast<int>(parameter(*target, 0)) - target->hp) / parameter(*target, 0);
    if (scope == 2 || scope == 8 || scope == 10) score += value;
    else if (value > score) {
      score = value;
      targetIndex = target->enemy ? static_cast<int>(target - battle_.enemies.data()) : static_cast<int>(std::find(party_.begin(), party_.end(), target->id) - party_.begin());
    }
  }
  score *= item["repeats"].integer(1) + (item["id"].integer() == 1 ? std::max(0.0, trait(subject, 34, 0, false)) : 0);
  return score > 0 ? score + random() : score;
}

void Session::applyItemEffect(Battler& subject, Battler& target, const Value& item, const Value& effect) {
  const int code = effect["code"].integer(), id = effect["dataId"].integer();
  auto& result = target.result;
  const double luck = std::max(1 + (parameter(subject, 7) - parameter(target, 7)) * 0.001, 0.0);
  const bool skill = !item["stypeId"].null();
  if (code == 11 || code == 12) {
    const int parameterId = code == 11 ? 0 : 1;
    const int value = static_cast<int>(std::floor((parameter(target, parameterId) * effect["value1"].number() + effect["value2"].number()) * trait(target, 23, 2, true) * (skill ? 1 : trait(subject, 23, 3, true))));
    if (value) {
      if (code == 11) { result.hpAffected = true; result.hpDamage = -value; target.hp += value; }
      else { result.mpDamage = -value; target.mp += value; }
      result.success = true;
    }
  } else if (code == 13) {
    const int value = static_cast<int>(std::floor(effect["value1"].number()));
    if (value) {
      result.tpDamage = -value; target.tp += value; result.success = true;

    }
  } else if (code == 21) {
    std::set<int> states;
    if (id) states.insert(id);
    else for (const auto* object : traitObjects(subject)) for (const auto& entry : (*object)["traits"].array()) if (entry["code"].integer() == 32) states.insert(entry["dataId"].integer());
    for (int state : states) {
      double chance = effect["value1"].number();
      if (!id || item["hitType"].integer() != 0) chance *= trait(target, 13, state, true) * luck;
      if (!id) chance *= trait(subject, 32, state, false);
      if (random() < chance) { addState(target, state); result.success = true; }
    }
  } else if (code == 22) {
    if (random() < effect["value1"].number()) { removeState(target, id); result.success = true; }
  } else if (code >= 31 && code <= 34) {
    if (id < 0 || id > 7) throw std::invalid_argument("invalid buff parameter");
    if (code == 31 || (code == 32 && random() < trait(target, 12, id, true) * luck)) {
      if (target.hp > 0) {
        target.buffs[id] = std::clamp(target.buffs[id] + (code == 31 ? 1 : -1), -2, 2);
        if (target.buffs[id]) target.buffTurns[id] = std::max(target.buffTurns[id], effect["value1"].integer());
        else target.buffTurns[id] = 0;
        (code == 31 ? result.addedBuffs : result.addedDebuffs).push_back(id);
      }
      result.success = true;
    } else if ((code == 33 && target.buffs[id] > 0) || (code == 34 && target.buffs[id] < 0)) {
      target.buffs[id] = 0; target.buffTurns[id] = 0; result.removedBuffs.push_back(id); result.success = true;
    }
  } else if (code == 41) {
    if (id == 0) { target.escaped = true; target.hidden = true; target.states.clear(); target.stateTurns.clear(); target.buffs.fill(0); target.buffTurns.fill(0); result.success = true; }
  } else if (code == 42) {
    if (id < 0 || id > 7) throw std::invalid_argument("invalid growth parameter");
    target.paramPlus[id] += static_cast<int>(std::floor(effect["value1"].number())); result.success = true;
  } else if (code == 43) {
    if (!target.enemy) { target.skills.insert(id); result.success = true; }
  } else if (code != 44) throw std::runtime_error("unsupported item effect " + std::to_string(code));
  refreshBattler(target);
}
void Session::actorWalk(Battler& actor) {
  actor.result = {};
  const auto flashDamage = [&]() {
    Interpreter context;
    screenEventCommand(Value::Object{{"code", 224}, {"parameters", Value::Array{Value::Array{255, 0, 0, 128}, 8, false}}}, context);
  };
  if (vehicleType_ != 2 && tileFlag(player_.x, player_.y, 256)) {
    const int maximum = database_["system"]["optFloorDeath"].boolean() ? actor.hp : std::max(actor.hp - 1, 0);
    const int damage = std::min(static_cast<int>(std::floor(10 * trait(actor, 23, 8, true))), maximum);
    actor.hp -= damage; actor.result.hpAffected = true; actor.result.hpDamage = damage; refreshBattler(actor);
    if (damage > 0) flashDamage();
  }
  if (vehicleType_ >= 0) return;
  if (steps_ % 20 == 0) { endBattlerTurn(actor); if (actor.result.hpDamage > 0) flashDamage(); }
  const auto states = actor.states;
  for (int state : states) if (database_["states"][state]["removeByWalking"].boolean() && actor.stateSteps[state] > 0) {
    if (--actor.stateSteps[state] == 0) removeState(actor, state);
  }
}

void Session::applyGlobalEffects(const Value& item) {
  for (const auto& effect : item["effects"].array()) if (effect["code"].integer() == 44) reservedCommonEvent_ = effect["dataId"].integer();
}

bool Session::updateTroopEvents() {
  if (battle_.interpreter.running) {
    advanceInterpreter(battle_.interpreter);
    if (battle_.interpreter.running) return true;
  }
  if (reservedCommonEvent_ > 0) {
    const int id = reservedCommonEvent_; reservedCommonEvent_ = 0;
    battle_.interpreter = {}; battle_.interpreter.battleEvent = true; battle_.interpreter.mapId = mapId_;
    battle_.interpreter.list = database_["commonEvents"][id]["list"].array(); battle_.interpreter.running = true;
    return true;
  }
  const auto& pages = database_["troops"][battle_.troopId]["pages"].array();
  for (std::size_t index = 0; index < pages.size(); ++index) {
    const auto& page = pages[index]; const auto& c = page["conditions"];
    if (battle_.eventFlags.contains(static_cast<int>(index))) continue;
    if (!c["turnEnding"].boolean() && !c["turnValid"].boolean() && !c["enemyValid"].boolean() && !c["actorValid"].boolean() && !c["switchValid"].boolean()) continue;
    if (c["turnEnding"].boolean() && !battle_.turnEnding) continue;
    if (c["turnValid"].boolean()) {
      const int a = c["turnA"].integer(), b = c["turnB"].integer();
      if (b == 0 ? battle_.turn != a : battle_.turn < 1 || battle_.turn < a || battle_.turn % b != a % b) continue;
    }
    if (c["enemyValid"].boolean()) {
      const int id = c["enemyIndex"].integer();
      if (id < 0 || id >= static_cast<int>(battle_.enemies.size()) || battle_.enemies[id].hp / parameter(battle_.enemies[id], 0) * 100 > c["enemyHp"].number()) continue;
    }
    if (c["actorValid"].boolean()) {
      const int id = c["actorId"].integer();
      if (!actors_.contains(id)) { if (database_["actors"][id].null()) continue; initializeActor(id); }
      if (actors_.at(id).hp / parameter(actors_.at(id), 0) * 100 > c["actorHp"].number()) continue;
    }
    if (c["switchValid"].boolean() && !switches_[c["switchId"].integer()]) continue;
    battle_.interpreter = {}; battle_.interpreter.battleEvent = true; battle_.interpreter.mapId = mapId_;
    battle_.interpreter.list = page["list"].array(); battle_.interpreter.running = true;
    if (page["span"].integer() <= 1) battle_.eventFlags.insert(static_cast<int>(index));
    return true;
  }
  return false;
}
void Session::forceBattleAction(bool enemy, int subject, int skill, int target) {
  if (!battle_.active || database_["skills"][skill].null()) return;
  if (enemy ? subject < 0 || subject >= static_cast<int>(battle_.enemies.size()) : subject < 0 || subject >= static_cast<int>(battleMemberCount())) return;
  auto& battler = enemy ? battle_.enemies[subject] : actors_.at(party_[subject]);
  if (std::find(battler.states.begin(), battler.states.end(), 1) != battler.states.end()) return;
  if (target == -2) target = battler.lastTargetIndex;
  else if (target == -1) {
    const auto& item = database_["skills"][skill];
    const int scope = item["scope"].integer();
    const bool opponent = scope >= 1 && scope <= 6, dead = scope == 9 || scope == 10;
    const bool targetsEnemies = opponent != enemy;
    std::vector<std::pair<int,Battler*>> candidates;
    if (targetsEnemies) {
      for (std::size_t index = 0; index < battle_.enemies.size(); ++index) {
        auto& member = battle_.enemies[index];
        if (!member.hidden && !member.escaped && (member.hp <= 0) == dead) candidates.push_back({static_cast<int>(index), &member});
      }
    } else for (std::size_t index = 0; index < battleMemberCount(); ++index) {
      auto& member = actors_.at(party_[index]);
      if (!member.hidden && !member.escaped && (member.hp <= 0) == dead) candidates.push_back({static_cast<int>(index), &member});
    }
    if (candidates.empty()) return;
    if (dead) target = candidates[randomInt(static_cast<int>(candidates.size()))].first;
    else {
      double total = 0;
      for (const auto& entry : candidates) total += trait(*entry.second, 23, 0, true);
      double choice = random() * total;
      for (const auto& entry : candidates) { choice -= trait(*entry.second, 23, 0, true); if (choice <= 0) { target = entry.first; break; } }
      if (target < 0) return;
    }
  }
  battle_.actions.erase(std::remove_if(battle_.actions.begin(), battle_.actions.end(), [&](const Action& action) { return action.enemy == enemy && action.subject == subject; }), battle_.actions.end());
  battle_.forcedActions.push_back({enemy, false, subject, skill, target, 0, true});
}

bool BattleMechanics::hasEncounterHalf(const Session& session) { return session.hasPartyAbility(0); }
bool BattleMechanics::hasEncounterNone(const Session& session) { return session.hasPartyAbility(1); }
bool BattleMechanics::hasCancelSurprise(const Session& session) { return session.hasPartyAbility(2); }
bool BattleMechanics::hasRaisePreemptive(const Session& session) { return session.hasPartyAbility(3); }
bool BattleMechanics::hasGoldDouble(const Session& session) { return session.hasPartyAbility(4); }
bool BattleMechanics::hasDropItemDouble(const Session& session) { return session.hasPartyAbility(5); }

double BattleMechanics::ratePreemptive(const Session& session) {
  const auto& party = session.party();
  const auto& enemies = session.battle().enemies;
  if (party.empty() || enemies.empty()) return 0.0;
  double partyAgi = 0.0;
  for (std::size_t index = 0; index < session.battleMemberCount(); ++index) partyAgi += session.parameter(session.actors().at(party[index]), 6);
  partyAgi /= static_cast<double>(session.battleMemberCount());
  double enemyAgi = 0.0;
  for (const auto& enemy : enemies) enemyAgi += session.parameter(enemy, 6);
  enemyAgi /= static_cast<double>(enemies.size());
  double rate = partyAgi >= enemyAgi ? 0.05 : 0.03;
  if (hasRaisePreemptive(session)) rate *= 4.0;
  return rate;
}

double BattleMechanics::rateSurprise(const Session& session) {
  if (hasCancelSurprise(session)) return 0.0;
  const auto& party = session.party();
  const auto& enemies = session.battle().enemies;
  if (party.empty() || enemies.empty()) return 0.0;
  double partyAgi = 0.0;
  for (std::size_t index = 0; index < session.battleMemberCount(); ++index) partyAgi += session.parameter(session.actors().at(party[index]), 6);
  partyAgi /= static_cast<double>(session.battleMemberCount());
  double enemyAgi = 0.0;
  for (const auto& enemy : enemies) enemyAgi += session.parameter(enemy, 6);
  enemyAgi /= static_cast<double>(enemies.size());
  return partyAgi >= enemyAgi ? 0.03 : 0.05;
}

void BattleMechanics::makeUniqueNames(std::vector<Battler>& enemies, std::map<std::string,int>& counts, bool cjk) {
  const std::array<const char*,26> full{"Ａ","Ｂ","Ｃ","Ｄ","Ｅ","Ｆ","Ｇ","Ｈ","Ｉ","Ｊ","Ｋ","Ｌ","Ｍ","Ｎ","Ｏ","Ｐ","Ｑ","Ｒ","Ｓ","Ｔ","Ｕ","Ｖ","Ｗ","Ｘ","Ｙ","Ｚ"};
  for (auto& enemy : enemies) if (!enemy.hidden && enemy.hp > 0 && enemy.letter.empty()) {
    const int index = counts[enemy.originalName]++ % 26;
    enemy.letter = cjk ? full[index] : " " + std::string(1, static_cast<char>('A' + index));
  }
  for (auto& enemy : enemies) {
    if (counts[enemy.originalName] >= 2) enemy.plural = true;
    enemy.name = enemy.originalName + (enemy.plural ? enemy.letter : "");
  }
}

bool BattleMechanics::isDualWield(const Session& session, const Battler& actor) {
  for (const auto* object : session.traitObjects(actor)) {
    for (const auto& entry : (*object)["traits"].array()) {
      if (entry["code"].integer() == 55 && entry["dataId"].integer() == 1) return true;
    }
  }
  return false;
}

std::vector<int> BattleMechanics::equipSlots(const Session& session, const Battler& actor) {
  const auto size = session.database()["system"]["equipTypes"].array().size();
  std::vector<int> slots(size > 1 ? size - 1 : 5);
  for (std::size_t index = 0; index < slots.size(); ++index) slots[index] = static_cast<int>(index) + 1;
  if (slots.size() >= 2 && isDualWield(session, actor)) slots[1] = 1;
  return slots;
}
int Session::equipSlotType(const Battler& actor, int slot) const {
  if (slot == 1 && BattleMechanics::isDualWield(*this, actor)) return 1;
  return slot + 1;
}

double BattleMechanics::counterRate(const Session& session, const Battler& target) {
  double sum = 0.0;
  for (const auto* object : session.traitObjects(target)) {
    for (const auto& entry : (*object)["traits"].array()) {
      if (entry["code"].integer() == 22 && entry["dataId"].integer() == 6) {
        sum += entry["value"].number();
      }
    }
  }
  return sum;
}

double BattleMechanics::magicReflectionRate(const Session& session, const Battler& target) {
  double sum = 0.0;
  for (const auto* object : session.traitObjects(target)) {
    for (const auto& entry : (*object)["traits"].array()) {
      if (entry["code"].integer() == 22 && entry["dataId"].integer() == 5) {
        sum += entry["value"].number();
      }
    }
  }
  return sum;
}

bool BattleMechanics::canSubstitute(const Session& session, const Battler& candidate, const Battler& target) {
  if (&candidate == &target || candidate.hp <= 0 || session.restriction(candidate) > 0) return false;
  if (!session.hasSpecialFlag(candidate, 2)) return false;
  const double maxHp = session.parameter(target, 0);
  return maxHp > 0 && target.hp < maxHp * 0.25;
}

int BattleMechanics::expForLevel(const Session& session, const Battler& actor, int level) {
  const Value& cls = session.database()["classes"][actor.classId];
  const auto& expParams = cls["expParams"].array();
  const double basis = expParams.size() > 0 ? expParams[0].number(30.0) : 30.0;
  const double extra = expParams.size() > 1 ? expParams[1].number(20.0) : 20.0;
  const double accA = expParams.size() > 2 ? expParams[2].number(30.0) : 30.0;
  const double accB = expParams.size() > 3 ? expParams[3].number(30.0) : 30.0;
  const double lv = static_cast<double>(level);
  const double val = basis * std::pow(std::max(0.0, lv - 1.0), 0.9 + accA / 250.0) * lv *
                         (lv + 1.0) / (6.0 + std::pow(lv, 2.0) / 50.0 / std::max(1.0, accB)) +
                     (lv - 1.0) * extra;
  return static_cast<int>(std::llround(val));
}

int BattleMechanics::calcEquipItemPerformance(const Value& item) {
  int sum = 0;
  for (const auto& p : item["params"].array()) {
    sum += p.integer(0);
  }
  return sum;
}

bool BattleMechanics::isSkillWtypeOk(const Session& session, const Battler& actor, const Value& skill) {
  const int w1 = skill["requiredWtypeId1"].integer(0);
  const int w2 = skill["requiredWtypeId2"].integer(0);
  if (w1 == 0 && w2 == 0) return true;
  for (std::size_t i = 0; i < actor.equips.size(); ++i) {
    const int kind = i < actor.equipKinds.size() ? actor.equipKinds[i] : 0;
    const int id = actor.equips[i];
    if (kind == 1 && id > 0) {
      const int wtype = session.database()["weapons"][id]["wtypeId"].integer(0);
      if ((w1 > 0 && wtype == w1) || (w2 > 0 && wtype == w2)) return true;
    }
  }
  return false;
}

void BattleMechanics::clearEquipments(Session& session, Battler& actor) {
  for (std::size_t slot = 0; slot < actor.equips.size(); ++slot) {
    if (session.canChangeEquip(actor,static_cast<int>(slot))) session.changeEquipment(actor.id,static_cast<int>(slot),0);
  }
}

void BattleMechanics::optimizeEquipments(Session& session, Battler& actor) {
  clearEquipments(session,actor);
  for (std::size_t slot = 0; slot < actor.equips.size(); ++slot) {
    if (!session.canChangeEquip(actor,static_cast<int>(slot))) continue;
    const int kind = session.equipSlotType(actor,static_cast<int>(slot)) == 1 ? 1 : 2;
    const auto& table = session.database()[kind == 1 ? "weapons" : "armors"];
    int bestId = 0, bestPerformance = -1000;
    for (std::size_t id = 1; id < table.array().size(); ++id) {
      const auto found = session.inventory_.find(static_cast<int>(id)+kind*100000);
      const auto& item = table[static_cast<int>(id)];
      if (found == session.inventory_.end() || found->second <= 0 || !session.canEquip(actor,item,static_cast<int>(slot))) continue;
      const int performance = calcEquipItemPerformance(item);
      if (performance > bestPerformance) { bestPerformance = performance; bestId = static_cast<int>(id); }
    }
    session.changeEquipment(actor.id,static_cast<int>(slot),bestId);
  }
}

std::vector<int> BattleMechanics::makeActionOrderSpeeds(const std::vector<int>& speeds) {
  std::vector<int> indices(speeds.size());
  for (std::size_t i = 0; i < speeds.size(); ++i) indices[i] = static_cast<int>(i);
  std::stable_sort(indices.begin(), indices.end(), [&](int a, int b) {
    return speeds[static_cast<std::size_t>(a)] > speeds[static_cast<std::size_t>(b)];
  });
  return indices;
}

void Session::setEnemyBitmapHeightResolver(std::function<int(const Battler&)> resolver) {
  enemyBitmapHeightResolver_ = std::move(resolver);
}

const Sprite_Enemy* Session::enemySprite(std::size_t index) const {
  return index < enemySprites_.size() ? enemySprites_[index].get() : nullptr;
}

bool Session::isBattleEffecting() const {
  return std::any_of(enemySprites_.begin(), enemySprites_.end(), [](const auto& sprite) {
    return sprite && (sprite->isEffecting() || (sprite->appeared && !sprite->requestedEffect.empty()));
  });
}

void Session::requestEnemyEffect(std::size_t index, const std::string& effect) {
  if (index >= battle_.enemies.size()) return;
  if (enemySprites_.size() <= index) enemySprites_.resize(index + 1);
  auto& sprite = enemySprites_[index];
  if (!sprite) sprite = std::make_shared<Sprite_Enemy>();
  sprite->requestedEffect = effect;
  if (effect == "collapse" || effect == "bossCollapse")
    audio("se", database_["system"]["sounds"][effect == "bossCollapse" ? 12 : 11]);
}

void Session::resetEnemySprites() {
  enemySprites_.clear();
}

void Session::updateEnemySprites() {
  enemySprites_.resize(battle_.enemies.size());
  for (std::size_t index = 0; index < battle_.enemies.size(); ++index) {
    auto& enemy = battle_.enemies[index];
    auto& owner = enemySprites_[index];
    if (!owner) owner = std::make_shared<Sprite_Enemy>();
    auto& sprite = *owner;
    if (sprite.initialized && sprite.lastUpdateTick == ticks_) continue;
    sprite.lastUpdateTick = ticks_;
    sprite.setBattler(&enemy);
    if (!sprite.initialized) {
      sprite.initialized = true;
      sprite.appeared = enemy.hp > 0 && !enemy.hidden && !enemy.escaped;
      sprite.opacity = sprite.appeared ? 1 : 0;
    }
    if (sprite.appeared && !sprite.requestedEffect.empty()) {
      if (sprite.requestedEffect == "bossCollapse") {
        sprite.bitmapHeight = enemyBitmapHeightResolver_ ? std::max(0, enemyBitmapHeightResolver_(enemy)) : 0;
      }
      const auto request = std::move(sprite.requestedEffect);
      sprite.requestedEffect.clear();
      sprite.startEffect(request);
    }
    if (!sprite.appeared && enemy.hp > 0 && !enemy.hidden && !enemy.escaped) {
      sprite.startEffect("appear");
    } else if (sprite.appeared && (enemy.hidden || enemy.escaped)) {
      sprite.startEffect("disappear");
    }
    const auto sounds = sprite.bossCollapseSounds;
    sprite.advance(1);
    for (auto played = sounds; played < sprite.bossCollapseSounds; ++played)
      audio("se", database_["system"]["sounds"][13]);
  }
}

}  // namespace pmjs::mv
