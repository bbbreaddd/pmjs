#include "mv_engine.hpp"
#include <algorithm>
#include <stdexcept>

namespace pmjs::mv {
std::shared_ptr<RuntimeAction> Session::createRuntimeAction(const std::shared_ptr<RuntimeActor>& subject, bool forced) {
  auto action = std::make_shared<RuntimeAction>();
  action->value.id = 0; action->value.target = -1; action->value.forced = forced;
  setRuntimeActionSubject(action, subject); runtimeActions_[action->identity] = action;
  return action;
}
void Session::setRuntimeActionSubject(const std::shared_ptr<RuntimeAction>& action, const std::shared_ptr<RuntimeActor>& subject) {
  action->subject = subject;
  if (!subject) { action->value.actorId = 0; action->value.subject = -1; return; }
  action->value.enemy = subject->value().enemy;
  if (action->value.enemy) {
    const auto found = std::find_if(battle_.enemies.begin(), battle_.enemies.end(), [&](const Battler& value) { return &value == &subject->value(); });
    action->value.subject = found == battle_.enemies.end() ? -1 : static_cast<int>(found - battle_.enemies.begin()); action->value.actorId = 0;
  } else {
    action->value.actorId = subject->value().id;
    const auto found = std::find(party_.begin(), party_.end(), action->value.actorId);
    action->value.subject = found == party_.end() ? -1 : static_cast<int>(found - party_.begin());
  }
  synchronizeRuntimeAction(action);
}
std::shared_ptr<RuntimeActor> Session::runtimeActionSubject(const std::shared_ptr<RuntimeAction>& action) {
  refreshRuntimeAction(action);
  if (const auto subject = action->subject.lock()) return subject;
  const int actorId = action->value.actorId ? action->value.actorId : action->value.subject >= 0 && action->value.subject < static_cast<int>(party_.size()) ? party_[action->value.subject] : 0;
  const auto subject = action->value.enemy ? runtimeEnemy(action->value.subject) : runtimeActor(actorId);
  action->subject = subject; return subject;
}
void Session::refreshRuntimeAction(const std::shared_ptr<RuntimeAction>& action) {
  const Action* current = battle_.pendingAction ? &*battle_.pendingAction : battle_.actionStage && battle_.currentVisual >= 0 ? &battle_.visuals.at(battle_.currentVisual).action : nullptr;
  if (current && current->identity == action->identity) {
    if (current->enemy != action->value.enemy || current->subject != action->value.subject || current->actorId != action->value.actorId) action->subject.reset();
    action->value = *current;
  }
}
void Session::synchronizeRuntimeAction(const std::shared_ptr<RuntimeAction>& action) {
  const auto update = [&](Action& value) { if (value.identity == action->identity) { const double speed = value.speed; value = action->value; value.speed = speed; } };
  for (auto& value : battle_.actions) update(value);
  for (auto& value : battle_.forcedActions) update(value);
  if (battle_.pendingAction) update(*battle_.pendingAction);
  for (auto& visual : battle_.visuals) update(visual.action);
}
Value Session::runtimeActionField(const std::shared_ptr<RuntimeAction>& action, const std::string& field, const std::optional<Value>& value) {
  refreshRuntimeAction(action); auto& data = action->value;
  Value result;
  if (field == "id") { if (value) data.id = value->integer(); result = data.id; }
  else if (field == "item") { if (value) data.item = value->boolean(); result = data.item; }
  else if (field == "target") { if (value) data.target = value->integer(); result = data.target; }
  else if (field == "forced") { if (value) data.forced = value->boolean(); result = data.forced; }
  else throw std::invalid_argument("action field is not bound: " + field);
  if (value) synchronizeRuntimeAction(action);
  return result;
}
std::shared_ptr<RuntimeAction> Session::currentRuntimeAction() {
  Action* current = battle_.pendingAction ? &*battle_.pendingAction : battle_.actionStage && battle_.currentVisual >= 0 ? &battle_.visuals.at(battle_.currentVisual).action : nullptr;
  if (!current) return {};
  if (const auto found = runtimeActions_.find(current->identity); found != runtimeActions_.end()) if (const auto action = found->second.lock()) { refreshRuntimeAction(action); battle_.runtimeAction = action; return action; }
  auto action = std::make_shared<RuntimeAction>(); const auto identity = action->identity;
  action->value = *current; action->value.identity = identity; current->identity = identity;
  runtimeActions_[identity] = action; battle_.runtimeAction = action; return action;
}
void Session::replaceBattlerActions(const std::shared_ptr<RuntimeActor>& owner, std::vector<std::shared_ptr<RuntimeAction>> actions) {
  auto& battler = owner->value(); const auto old = battler.actions;
  for (const auto& action : actions) { if (!action) throw std::invalid_argument("battler actions require action objects"); runtimeActions_[action->identity] = action; }
  battler.actions = std::move(actions);
  if (!owner->attached) return;
  const auto belongs = [&](const Action& action) { return std::any_of(old.begin(), old.end(), [&](const auto& entry) { return entry->identity == action.identity; }); };
  const auto first = std::find_if(battle_.actions.begin(), battle_.actions.end(), belongs);
  const auto position = static_cast<std::size_t>(first - battle_.actions.begin());
  const bool scheduled = first != battle_.actions.end();
  battle_.actions.erase(std::remove_if(battle_.actions.begin(), battle_.actions.end(), belongs), battle_.actions.end());
  if (scheduled) {
    std::vector<Action> replacement; for (const auto& entry : battler.actions) replacement.push_back(entry->value);
    battle_.actions.insert(battle_.actions.begin() + std::min(position, battle_.actions.size()), replacement.begin(), replacement.end());
  }
  if (!battler.enemy && battle_.phase == "input") {
    const auto found = std::find(party_.begin(), party_.end(), battler.id); const auto index = found - party_.begin();
    if (index < static_cast<std::ptrdiff_t>(battle_.remainingActions.size())) battle_.remainingActions[index] = static_cast<int>(battler.actions.size());
  }
}
void Session::makeBattlerActionsBase(const std::shared_ptr<RuntimeActor>& owner, bool basic) {
  std::vector<std::shared_ptr<RuntimeAction>> actions;
  const int count = battleActionCount(owner->value());
  for (int index = 0; index < count; ++index) actions.push_back(createRuntimeAction(owner));
  replaceBattlerActions(owner, std::move(actions));
  if (!basic) {
    fillBattlerActions(owner);
    auto& battler = owner->value();
    battler.actionState = battler.enemy || hasSpecialFlag(battler, 0) || restriction(battler) > 0 || battler.actions.empty() ? "waiting" : "undecided";
    battler.motionRefresh = true;
  }
}
void Session::fillBattlerActions(const std::shared_ptr<RuntimeActor>& owner) {
  auto& battler = owner->value();
  for (const auto& action : battler.actions) {
    if (battler.enemy) action->value.id = selectEnemySkill(battler);
    else if (hasSpecialFlag(battler, 0) || restriction(battler) > 0) {
      action->value.id = 1;
      if (hasSpecialFlag(battler, 0)) {
        double best = -1; auto skills = battlerSkills(battler); skills.insert(1);
        for (int id : skills) if (canUse(battler, database_["skills"][id])) {
          int target = -1; const double score = evaluateAutoAction(battler, database_["skills"][id], target);
          if (score > best) { best = score; action->value.id = id; action->value.target = target; }
        }
      }
    }
    synchronizeRuntimeAction(action);
  }
}

void Session::removeBattlerAction(std::uint64_t identity) {
  const auto remove = [&](Battler& battler) { std::erase_if(battler.actions, [&](const auto& action) { return action->identity == identity; }); };
  for (auto& [id, battler] : actors_) { (void)id; remove(battler); }
  for (auto& battler : battle_.enemies) remove(battler);
}
}  // namespace pmjs::mv
