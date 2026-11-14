#include "mv_engine.hpp"
#include <stdexcept>

namespace pmjs::mv {
Value Session::runtimeBattlerCommand(const std::shared_ptr<RuntimeActor>& actor, const std::string& method, const Value::Array& arguments) {
  auto& battler = actor->value();
  const Value values(arguments);
  const int id = values[0].integer();
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
