#pragma once

#include "mv_engine.hpp"

#include <vector>

namespace pmjs::mv {

class BattleMechanics {
 public:
  // Party abilities (Game_Party trait code 64)
  static bool hasEncounterHalf(const Session& session);
  static bool hasEncounterNone(const Session& session);
  static bool hasCancelSurprise(const Session& session);
  static bool hasRaisePreemptive(const Session& session);
  static bool hasGoldDouble(const Session& session);
  static bool hasDropItemDouble(const Session& session);

  // Preemptive / Surprise (BattleManager)
  static double ratePreemptive(const Session& session);
  static double rateSurprise(const Session& session);

  // Troop naming (Game_Troop::makeUniqueNames)
  static void makeUniqueNames(std::vector<Battler>& enemies, std::map<std::string,int>& counts, bool cjk);

  // Actor dual wield & equip slots (Game_Actor)
  static bool isDualWield(const Session& session, const Battler& actor);
  static std::vector<int> equipSlots(const Session& session, const Battler& actor);

  // Counter, Magic Reflection, Substitute
  static double counterRate(const Session& session, const Battler& target);
  static double magicReflectionRate(const Session& session, const Battler& target);
  static bool canSubstitute(const Session& session, const Battler& candidate, const Battler& target);

  // Game_Actor EXP, skill wtype, equip optimization
  static int expForLevel(const Session& session, const Battler& actor, int level);
  static int calcEquipItemPerformance(const Value& item);
  static bool isSkillWtypeOk(const Session& session, const Battler& actor, const Value& skill);
  static void clearEquipments(Session& session, Battler& actor);
  static void optimizeEquipments(Session& session, Battler& actor);
  static std::vector<int> makeActionOrderSpeeds(const std::vector<int>& speeds);
};

}  // namespace pmjs::mv
