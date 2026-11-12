#include "mv_engine.hpp"
#include "mv_battle_extra.hpp"
#include "mv_managers.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace pmjs::mv {
namespace {
int enemyEventInt(double value, int minimum, int maximum) {
  if (std::isnan(value)) throw std::runtime_error("non-numeric enemy event operand");
  return static_cast<int>(std::clamp(value, static_cast<double>(minimum), static_cast<double>(maximum)));
}
}

bool Session::enemyEventCommand(const Value& entry) {
  const int code = entry["code"].integer();
  if (code == 340) {
    if (!battle_.active) return true;
    SoundManager::playEscape(*this);
    battle_.result = 1; battle_.active = false; battle_.wait = 0;
    battle_.actions.clear(); battle_.log.clear(); message_ = {};
    ++system_.escapeCount;
    savedBgm_ = battle_.mapBgm; savedBgs_ = battle_.mapBgs;
    audio("battle-restore-bgm", {}); audio("battle-restore-bgs", {});
    if (battle_.event && interpreter_.index > 0 && interpreter_.index <= static_cast<int>(interpreter_.list.size()))
      interpreter_.branches[interpreter_.list[interpreter_.index - 1]["indent"].integer()] = 1;
    leaveBattle();
    return true;
  }
  if (code == 339) {
    const auto& p = entry["parameters"];
    if (p[0].integer() == 0) {
      if (p[1].integer() < 0) for (std::size_t index = 0; index < battle_.enemies.size(); ++index)
        forceBattleAction(true, static_cast<int>(index), p[2].integer(), p[3].integer());
      else forceBattleAction(true, p[1].integer(), p[2].integer(), p[3].integer());
    } else {
      const auto actor = std::find(party_.begin(), party_.end(), p[1].integer());
      if (actor != party_.end()) forceBattleAction(false, static_cast<int>(actor - party_.begin()), p[2].integer(), p[3].integer());
    }
    return true;
  }
  if (code != 331 && code != 332 && code != 333 && code != 334 && code != 335 && code != 336 && code != 342) return false;
  const auto& p = entry["parameters"];
  double amount = 0;
  if (code == 331 || code == 332 || code == 342) {
    const auto& operand = p[2].integer() ? variable(p[3].integer()) : p[3];
    if (!std::holds_alternative<double>(operand.data)) throw std::runtime_error("non-numeric enemy event operand");
    amount = operand.number() * (p[1].integer() ? -1 : 1);
  }
  for (std::size_t index = 0; index < battle_.enemies.size(); ++index) {
    if (p[0].integer() >= 0 && p[0].integer() != static_cast<int>(index)) continue;
    auto& enemy = battle_.enemies[index];
    switch (code) {
      case 331:
        if (!enemy.hidden && std::find(enemy.states.begin(), enemy.states.end(), 1) == enemy.states.end()) {
          double change = amount;
          if (!p[4].boolean() && enemy.hp <= -change) change = 1 - enemy.hp;
          enemy.result.hpAffected = true;
          enemy.result.hpDamage = enemyEventInt(-change, std::numeric_limits<int>::min(), std::numeric_limits<int>::max());
          enemy.hp = enemyEventInt(enemy.hp + change, 0, static_cast<int>(parameter(enemy, 0)));
          refreshBattler(enemy);
        }
        break;
      case 332:
        enemy.result.mpDamage = enemyEventInt(-amount, std::numeric_limits<int>::min(), std::numeric_limits<int>::max());
        enemy.mp = enemyEventInt(enemy.mp + amount, 0, static_cast<int>(parameter(enemy, 1)));
        refreshBattler(enemy); break;
      case 342:
        enemy.tp = enemyEventInt(enemy.tp + amount, 0, 100); refreshBattler(enemy); break;
      case 333:
        if (!p[1].integer()) { if (!enemy.hidden) addState(enemy, p[2].integer()); }
        else { removeState(enemy, p[2].integer()); refreshBattler(enemy); }
        enemy.result = {}; break;
      case 334: recover(enemy); break;
      case 335: enemy.hidden = false; BattleMechanics::makeUniqueNames(battle_.enemies, battle_.nameCounts, database_["system"]["locale"].text().starts_with("ja") || database_["system"]["locale"].text().starts_with("zh") || database_["system"]["locale"].text().starts_with("ko")); break;
      case 336:
        if (database_["enemies"][p[1].integer()].null()) throw std::invalid_argument("unknown enemy transform target");
        enemy.id = p[1].integer();
        if (enemy.originalName != database_["enemies"][enemy.id]["name"].text()) { enemy.letter.clear(); enemy.plural = false; }
        enemy.originalName = database_["enemies"][enemy.id]["name"].text(); refreshBattler(enemy);
        for (auto& action : battle_.actions) if (action.enemy && action.subject == static_cast<int>(index)) action.id = selectEnemySkill(enemy);
        BattleMechanics::makeUniqueNames(battle_.enemies, battle_.nameCounts, database_["system"]["locale"].text().starts_with("ja") || database_["system"]["locale"].text().starts_with("zh") || database_["system"]["locale"].text().starts_with("ko")); break;
    }
  }
  return true;
}
}  // namespace pmjs::mv
