#include "mv_engine.hpp"
#include "mv_managers.hpp"
#include <stdexcept>
#include <cmath>
#include <limits>
#include <type_traits>

namespace pmjs::mv {
Value Session::runtimeBattlerCommand(const std::shared_ptr<RuntimeActor>& actor, const std::string& method, const Value::Array& arguments) {
  auto& battler = actor->value();
  const Value values(arguments);
  const int id = values[0].integer();
  const auto dot = method.find('.');
  if (dot != std::string::npos) {
    const auto field = method.substr(0, dot), operation = method.substr(dot + 1);
    const auto access = [&](auto& data) -> Value {
      using Map = std::remove_reference_t<decltype(data)>;
      using Number = typename Map::mapped_type;
      const auto number = [&](const Value& value) -> Number {
        if (!std::holds_alternative<double>(value.data)) throw std::invalid_argument("battler dictionary values must be numbers");
        const double result = value.number();
        if constexpr (std::is_integral_v<Number>)
          if (!std::isfinite(result) || result < std::numeric_limits<Number>::min() || result > std::numeric_limits<Number>::max() || result != std::floor(result)) throw std::invalid_argument("battler turn counts require integers");
        return static_cast<Number>(result);
      };
      if (operation == "read") { Value::Object result; for (const auto& [key, value] : data) result[std::to_string(key)] = value; return result; }
      if (operation == "replace") {
        if (!std::holds_alternative<Value::Object>(values[0].data)) throw std::invalid_argument("battler dictionary requires an object");
        Map replacement;
        for (const auto& [key, value] : std::get<Value::Object>(values[0].data)) {
          std::size_t end = 0; const int index = std::stoi(key, &end);
          if (index < 0 || end != key.size() || std::to_string(index) != key) throw std::invalid_argument("battler dictionary keys require nonnegative integers");
          replacement[index] = number(value);
        }
        data = std::move(replacement); return Value::undefined();
      }
      if (id < 0) throw std::invalid_argument("battler dictionary keys require nonnegative integers");
      if (operation == "value") { const auto found = data.find(id); return found == data.end() ? Value::undefined() : Value(found->second); }
      if (operation == "set") { data[id] = number(values[1]); return Value::undefined(); }
      if (operation == "delete") { data.erase(id); return Value::undefined(); }
      throw std::invalid_argument("unknown battler dictionary operation");
    };
    if (field == "exp") return access(battler.exp);
    if (field == "stateTurns") return access(battler.stateTurns);
    if (field == "stateSteps") return access(battler.stateSteps);
  }
  if (method == "attackMotion") {
    int weapon = 0;
    for (std::size_t slot = 0; slot < battler.equips.size(); ++slot) if (battler.equips[slot] && battler.equipKinds[slot] == 1) { weapon = battler.equips[slot]; break; }
    return database_["system"]["attackMotions"][database_["weapons"][weapon]["wtypeId"].integer()];
  }
  if (method == "startWeaponAnimation") { battler.requestedWeapon = id; return Value::undefined(); }
  if (method == "collapseType") {
    int type = 0;
    for (const auto* object : traitObjects(battler)) for (const auto& trait : (*object)["traits"].array()) if (trait["code"].integer() == 63) type = std::max(type, trait["dataId"].integer());
    return type;
  }
  if (method == "collapseSound") {
    const int type = id;
    if (type == 0) SoundManager::playEnemyCollapse(*this); else if (type == 1) SoundManager::playBossCollapse1(*this);
    return Value::undefined();
  }
  if (method == "performBase" || method == "performDerived") {
    performBattlerPresentation(battler, values[0].text(), method == "performBase"); return Value::undefined();
  }
  if (method == "requestMotion") { battler.requestedMotion = id; battler.motionRequestedAt = ticks_; return Value::undefined(); }
  if (method == "motionType") return battler.requestedMotion;
  if (method == "clearMotion") { battler.requestedMotion = -1; return Value::undefined(); }
  if (method == "requestEffect") {
    if (battler.enemy) for (std::size_t index = 0; index < battle_.enemies.size(); ++index) if (&battle_.enemies[index] == &battler) { requestEnemyEffect(index, values[0].text()); break; }
    return Value::undefined();
  }
  if (method == "regenerateHp" || method == "regenerateMp" || method == "regenerateTp") {
    regenerateBattlerPart(battler, method == "regenerateHp" ? 0 : method == "regenerateMp" ? 1 : 2, actor); return Value::undefined();
  }
  if (method == "maxSlipDamage") return database_["system"]["optSlipDeath"].boolean() ? battler.hp : std::max(battler.hp - 1, 0);
  if (method == "removeStatesAuto") { removeStatesAuto(battler, id, actor); return Value::undefined(); }
  if (method == "removeBattleStates") {
    const auto states = battler.states;
    for (int state : states) if (database_["states"][state]["removeAtBattleEnd"].boolean() && !dispatchActorMethod(battler, "removeState", {state}, actor)) removeState(battler, state);
    return Value::undefined();
  }
  if (method == "levelUp") {
    ++battler.level;
    for (const auto& learning : database_["classes"][battler.classId]["learnings"].array())
      if (learning["level"].integer() == battler.level && !dispatchActorMethod(battler, "learnSkill", {learning["skillId"]}, actor)) battler.skills.insert(learning["skillId"].integer());
    return Value::undefined();
  }
  if (method == "currentExp") { const auto found = battler.exp.find(battler.classId); return found == battler.exp.end() ? Value::undefined() : Value(found->second); }
  if (method == "changeExp") { changeActorExpBase(battler, values[0].number(), values[1].boolean(), actor); return Value::undefined(); }
  if (method == "actorRefresh") { releaseEquipment(battler); refreshBattler(battler); return Value::undefined(); }
  if (method == "initImages") {
    const auto& source = database_["actors"][battler.id];
    battler.characterName = source["characterName"].text(); battler.characterIndex = source["characterIndex"].integer();
    battler.faceName = source["faceName"].text(); battler.faceIndex = source["faceIndex"].integer();
    battler.battlerName = source["battlerName"].text(); return Value::undefined();
  }
  if (method == "restriction") return restriction(battler);
  if (method == "refresh") refreshBattler(battler);
  else if (method == "recoverAll") recover(battler);
  else if (method == "addState") addState(battler, id);
  else if (method == "removeState") removeState(battler, id);
  else if (method == "resetStateCounts") {
    const auto& state = database_["states"][id];
    battler.stateTurns[id] = state["minTurns"].integer() + randomInt(1 + std::max(0, state["maxTurns"].integer() - state["minTurns"].integer()));
    if (!battler.enemy) battler.stateSteps[id] = state["stepsToRemove"].integer();
  } else if (method == "eraseState") {
    battler.states.erase(std::remove(battler.states.begin(), battler.states.end(), id), battler.states.end());
    battler.stateTurns.erase(id); battler.stateSteps.erase(id);
  } else throw std::invalid_argument("battler operation is not bound: " + method);
  return {};
}
}
