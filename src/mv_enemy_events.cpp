#include "mv_engine.hpp"
#include "mv_core_types.hpp"
#include "mv_battle_extra.hpp"
#include "mv_managers.hpp"
#include "mv_windows.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace pmjs::mv {
namespace {
int enemyEventInt(double value, int minimum, int maximum) {
  if (std::isnan(value)) return 0;
  return static_cast<int>(std::clamp(value, static_cast<double>(minimum), static_cast<double>(maximum)));
}
}

bool Session::enemyEventCommand(const EventCommand& entry) {
  const int code = entry.code;
  if (code == 340) {
    if (battle_.active) battle_.aborting = true;
    return true;
  }
  if (code == 339) {
    const auto& p = entry.parameters;
    if (p[0].integer() == 0) {
      if (p[1].integer() < 0) for (std::size_t index = 0; index < battle_.enemies.size(); ++index)
        forceBattleAction(true, static_cast<int>(index), p[2].integer(), p[3].integer());
      else forceBattleAction(true, p[1].integer(), p[2].integer(), p[3].integer());
    } else if (p[1].integer() == 0) {
      for (int actorId : partyMembers()) forceActorAction(actorId, p[2].integer(), p[3].integer());
    } else {
      forceActorAction(p[1].integer(), p[2].integer(), p[3].integer());
    }
    return true;
  }
  if (code != 331 && code != 332 && code != 333 && code != 334 && code != 335 && code != 336 && code != 342) return false;
  const auto& p = entry.parameters;
  double amount = 0;
  if (code == 331 || code == 332 || code == 342) {
    const auto& operand = p[2].integer() ? variable(p[3].integer()) : p[3];
    const double numeric = core::numberValue(operand);
    amount = (std::isnan(numeric) ? 0.0 : numeric) * (p[1].integer() ? -1 : 1);
  }
  for (std::size_t index = 0; index < battle_.enemies.size(); ++index) {
    if (p[0].integer() >= 0 && p[0].integer() != static_cast<int>(index)) continue;
    auto& enemy = battle_.enemies[index];
    switch (code) {
      case 331:
        if (enemy.isAlive()) {
          double change = amount;
          if (!p[4].boolean() && enemy.hp <= -change) change = 1 - enemy.hp;
          enemy.result.hpAffected = true;
          enemy.result.hpDamage = enemyEventInt(-change, std::numeric_limits<int>::min(), std::numeric_limits<int>::max());
          enemy.hp = enemyEventInt(enemy.hp + change, 0, static_cast<int>(parameter(enemy, 0)));
          refreshBattler(enemy);
          if (enemy.isDead() && battleLog_) battleLog_->performCollapse(*this, enemy);
        }
        break;
      case 332:
        enemy.result.mpDamage = enemyEventInt(-amount, std::numeric_limits<int>::min(), std::numeric_limits<int>::max());
        enemy.mp = enemyEventInt(enemy.mp + amount, 0, static_cast<int>(parameter(enemy, 1)));
        refreshBattler(enemy); break;
      case 342:
        enemy.result.tpDamage = enemyEventInt(-amount, std::numeric_limits<int>::min(), std::numeric_limits<int>::max());
        enemy.tp = enemyEventInt(enemy.tp + amount, 0, 100); refreshBattler(enemy); break;
      case 333: {
        const bool alreadyDead = enemy.isDead();
        if (!p[1].integer()) { if (!enemy.hidden) addState(enemy, p[2].integer()); }
        else { removeState(enemy, p[2].integer()); refreshBattler(enemy); }
        if (!alreadyDead && enemy.isDead() && battleLog_) battleLog_->performCollapse(*this, enemy);
        enemy.result = {}; break;
      }
      case 334: recover(enemy); break;
      case 335: enemy.hidden = false; BattleMechanics::makeUniqueNames(battle_.enemies, battle_.nameCounts, database_["system"]["locale"].text().starts_with("ja") || database_["system"]["locale"].text().starts_with("zh") || database_["system"]["locale"].text().starts_with("ko")); break;
      case 336: {
        if (database_["enemies"][p[1].integer()].null()) break;
        enemy.id = p[1].integer();
        if (enemy.originalName != database_["enemies"][enemy.id]["name"].text()) { enemy.letter.clear(); enemy.plural = false; }
        enemy.originalName = database_["enemies"][enemy.id]["name"].text(); refreshBattler(enemy);
        const auto belongsToEnemy = [&](const Action& action) { return action.enemy && action.subject == static_cast<int>(index); };
        const auto first = std::find_if(battle_.actions.begin(), battle_.actions.end(), [&](const Action& action) {
          return belongsToEnemy(action) && !std::isinf(action.speed);
        });
        if (first != battle_.actions.end()) {
          const auto position = first - battle_.actions.begin();
          const double speed = first->speed;
          std::erase_if(battle_.actions, belongsToEnemy);
          std::vector<Action> replacement;
          const int count = battleActionCount(enemy);
          for (int action = 0; action < count; ++action)
            replacement.push_back({true, false, static_cast<int>(index), selectEnemySkill(enemy), -1, speed});
          if (replacement.empty()) replacement.push_back({true, false, static_cast<int>(index), 0, -1, std::numeric_limits<double>::infinity()});
          battle_.actions.insert(battle_.actions.begin() + position, replacement.begin(), replacement.end());
        }
        BattleMechanics::makeUniqueNames(battle_.enemies, battle_.nameCounts, database_["system"]["locale"].text().starts_with("ja") || database_["system"]["locale"].text().starts_with("zh") || database_["system"]["locale"].text().starts_with("ko")); break;
      }
    }
  }
  return true;
}
}  // namespace pmjs::mv
