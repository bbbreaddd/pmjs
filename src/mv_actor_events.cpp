#include "mv_engine.hpp"
#include "mv_core_types.hpp"
#include "mv_windows.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace pmjs::mv {
namespace {
int boundedInt(double value, int minimum, int maximum) {
  if (std::isnan(value)) return 0;
  return static_cast<int>(std::clamp(value, static_cast<double>(minimum), static_cast<double>(maximum)));
}
}

double Session::actorExpForLevel(const Battler& actor, int level) const {
  const auto& p = database_["classes"][actor.classId]["expParams"];
  const double basis = p[0].number(), extra = p[1].number(), acceleration = p[2].number(), denominator = p[3].number();
  return std::floor(basis * std::pow(level - 1, 0.9 + acceleration / 250) * level * (level + 1) /
    (6 + std::pow(level, 2) / 50 / denominator) + (level - 1) * extra + 0.5);
}

void Session::changeActorExp(Battler& actor, double exp, bool show) {
  actor.exp[actor.classId] = std::max(exp, 0.0);
  const int lastLevel = actor.level;
  const auto lastSkills = actor.skills;
  const int maximum = database_["actors"][actor.id]["maxLevel"].integer(99);
  while (actor.level < maximum && actor.exp[actor.classId] >= actorExpForLevel(actor, actor.level + 1)) {
    ++actor.level;
    for (const auto& learning : database_["classes"][actor.classId]["learnings"].array())
      if (learning["level"].integer() == actor.level) actor.skills.insert(learning["skillId"].integer());
  }
  while (actor.level > 1 && actor.exp[actor.classId] < actorExpForLevel(actor, actor.level)) --actor.level;
  if (show && actor.level > lastLevel) {
    if (!message_.lines.empty()) message_.pageBreaks.insert(static_cast<int>(message_.lines.size()));
    message_.lines.emplace_back(battleMessage("levelUp", {actor.name, database_["system"]["terms"]["basic"][0].text(), std::to_string(actor.level)}));
    for (int skill : actor.skills) if (!lastSkills.contains(skill))
      message_.lines.emplace_back(battleMessage("obtainSkill", {database_["skills"][skill]["name"].text()}));
    message_.busy = true; messageAge_ = 0;
  }
  releaseEquipment(actor);
  refreshBattler(actor);
}

bool Session::actorEventCommand(const Value& entry) {
  const int code = entry["code"].integer();
  if (code == 319 || code == 320 || code == 321 || code == 322 || code == 324 || code == 325) {
    const auto& p = entry["parameters"];
    const int id = p[0].integer();
    if (database_["actors"][id].null()) return true;
    if (!actors_.contains(id)) initializeActor(id);
    auto& actor = actors_.at(id);
    if (code == 319) {
      const int slot = p[1].integer() - 1, item = p[2].integer();
      if (slot < 0 || slot >= static_cast<int>(actor.equips.size())) return true;
      const int kind = equipSlotType(actor, slot) == 1 ? 1 : 2;
      const auto& data = database_[kind == 1 ? "weapons" : "armors"][item];
      if (item && (data.null() || inventory_[item + kind * 100000] <= 0)) return true;
      if (item && data["etypeId"].integer() != equipSlotType(actor, slot)) return true;
      gainItem(actor.equipKinds[slot], actor.equips[slot], 1, false); gainItem(kind, item, -1, false);
      actor.equips[slot] = item; actor.equipKinds[slot] = kind;
      changeActorExp(actor, actor.exp[actor.classId], false);
    }
    else if (code == 321) {
      const int klass = p[1].integer();
      if (database_["classes"][klass].null()) return true;
      if (p[2].boolean()) actor.exp[klass] = actor.exp[actor.classId];
      actor.classId = klass; changeActorExp(actor, actor.exp[klass], false);
    }
    else if (code == 320) actor.name = p[1].text();
    else if (code == 324) actor.nickname = p[1].text();
    else if (code == 325) actor.profile = p[1].text();
    else {
      actor.characterName = p[1].text(); actor.characterIndex = p[2].integer();
      actor.faceName = p[3].text(); actor.faceIndex = p[4].integer(); actor.battlerName = p[5].text();
      updatePlayerGraphic();
    }
    return true;
  }
  if (code != 311 && code != 312 && code != 313 && code != 315 && code != 316 && code != 317 && code != 326) return false;
  const auto& p = entry["parameters"];
  const int actorId = p[0].integer() ? variable(p[1].integer()).integer() : p[1].integer();
  std::vector<int> selected;
  if (!actorId) selected = partyMembers();
  else if (!database_["actors"][actorId].null()) {
    if (!actors_.contains(actorId)) initializeActor(actorId);
    selected.push_back(actorId);
  }
  double amount = 0;
  if (code != 313) {
    const int offset = code == 317 ? 3 : 2;
    const auto& value = p[offset + 1].integer() ? variable(p[offset + 2].integer()) : p[offset + 2];
    const double numeric = core::numberValue(value);
    amount = (std::isnan(numeric) ? 0.0 : numeric) * (p[offset].integer() ? -1 : 1);
  }
  for (int id : selected) {
    auto& actor = actors_.at(id);
    switch (code) {
      case 311:
        if (actor.isAlive()) {
          double change = amount;
          if (!p[5].boolean() && actor.hp <= -change) change = 1 - actor.hp;
          actor.result.hpAffected = true;
          actor.result.hpDamage = boundedInt(-change, std::numeric_limits<int>::min(), std::numeric_limits<int>::max());
          actor.hp = boundedInt(actor.hp + change, 0, static_cast<int>(parameter(actor, 0)));
          refreshBattler(actor);
          if (actor.isDead() && battle_.active && battleLog_) {
            battleLog_->performCollapse(*this, actor);
          }
        }
        break;
      case 312:
        actor.result.mpDamage = boundedInt(-amount, std::numeric_limits<int>::min(), std::numeric_limits<int>::max());
        actor.mp = boundedInt(actor.mp + amount, 0, static_cast<int>(parameter(actor, 1)));
        refreshBattler(actor);
        break;
      case 326:
        actor.result.tpDamage = boundedInt(-amount, std::numeric_limits<int>::min(), std::numeric_limits<int>::max());
        actor.tp = boundedInt(actor.tp + amount, 0, 100);
        refreshBattler(actor);
        break;
      case 313: {
        const bool alreadyDead = actor.isDead();
        if (!p[2].integer()) addState(actor, p[3].integer());
        else {
          removeState(actor, p[3].integer());
          refreshBattler(actor);
        }
        if (!alreadyDead && actor.isDead() && battle_.active && battleLog_) {
          battleLog_->performCollapse(*this, actor);
        }
        actor.result = {};
        break;
      }
      case 315: changeActorExp(actor, actor.exp[actor.classId] + amount, p[5].boolean()); break;
      case 316: {
        const int maximum = database_["actors"][actor.id]["maxLevel"].integer(99);
        changeActorExp(actor, actorExpForLevel(actor, boundedInt(actor.level + amount, 1, maximum)), p[5].boolean());
        break;
      }
      case 317: {
        const int parameterId = p[2].integer();
        if (parameterId < 0 || parameterId >= static_cast<int>(actor.paramPlus.size())) throw std::invalid_argument("invalid actor parameter");
        actor.paramPlus[parameterId] = boundedInt(actor.paramPlus[parameterId] + amount, std::numeric_limits<int>::min(), std::numeric_limits<int>::max());
        refreshBattler(actor);
        break;
      }
    }
  }
  return true;
}
}  // namespace pmjs::mv
