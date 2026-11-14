#include "mv_engine.hpp"
#include <stdexcept>

namespace pmjs::mv {
std::shared_ptr<RuntimeCommonEvent> Session::runtimeCommonEvent(int id) {
  if (const auto found = runtimeCommonEvents_.find(id); found != runtimeCommonEvents_.end()) return found->second;
  auto event = std::make_shared<RuntimeCommonEvent>(); event->id = id; event->slot = id;
  if (const auto found = commonInterpreters_.find(id); found != commonInterpreters_.end()) {
    event->interpreter = found->second; event->interpreter->runtime->detachedRoot = event->interpreter;
  }
  runtimeCommonEvents_[id] = event;
  return event;
}
std::vector<std::shared_ptr<RuntimeCommonEvent>> Session::runtimeCommonEventObjects(bool initialize) {
  if (mapId_ <= 0) return {};
  if (!mapCommonEventsReady_) {
    mapCommonEventsReady_ = true;
    for (const auto& source : database_["commonEvents"].array()) if (!source.null() && source["trigger"].integer() == 2)
      mapCommonEvents_.push_back(runtimeCommonEvent(source["id"].integer()));
  }
  if (initialize) for (const auto& event : mapCommonEvents_) if (!event->initialized) refreshRuntimeCommonEvent(event, "initialize");
  return mapCommonEvents_;
}
void Session::setRuntimeCommonInterpreter(const std::shared_ptr<RuntimeCommonEvent>& event, const std::shared_ptr<RuntimeInterpreter>& interpreter) {
  std::shared_ptr<Interpreter> context;
  if (interpreter) {
    context = interpreter->detachedRoot.lock();
    if (!context || context->runtime != interpreter) throw std::invalid_argument("common-event interpreter must own its context");
  }
  event->interpreter = context;
  const auto found = runtimeCommonEvents_.find(event->slot);
  if (found != runtimeCommonEvents_.end() && found->second == event) {
    if (context) commonInterpreters_[event->slot] = context;
    else commonInterpreters_.erase(event->slot);
  }
}
void Session::refreshRuntimeCommonEvent(const std::shared_ptr<RuntimeCommonEvent>& event, const std::string& method) {
  event->initialized = true;
  if (runtimeHooks_ && runtimeHooks_->commonEventLifecycle && runtimeHooks_->commonEventLifecycle(event, method)) return;
  const auto& source = database_["commonEvents"][event->id];
  const auto enabled = switches_.find(source["switchId"].integer());
  if (source["trigger"].integer() == 2 && enabled != switches_.end() && enabled->second) {
    if (!event->interpreter) { event->interpreter = std::make_shared<Interpreter>(); event->interpreter->runtime->detachedRoot = event->interpreter; }
    setRuntimeCommonInterpreter(event, event->interpreter->runtime);
  } else setRuntimeCommonInterpreter(event, {});
}
void Session::refreshCommonEvents() {
  for (const auto& event : runtimeCommonEventObjects(false)) {
    refreshRuntimeCommonEvent(event, event->initialized ? "refresh" : "initialize");
  }
}
void Session::updateCommonEvents() {
  for (const auto& event : runtimeCommonEventObjects()) {
    if (runtimeHooks_ && runtimeHooks_->commonEventLifecycle && runtimeHooks_->commonEventLifecycle(event, "update")) continue;
    const auto context = event->interpreter;
    if (!context) continue;
    if (!context->running) setupInterpreter(*context, database_["commonEvents"][event->id]["list"].array());
    advanceInterpreter(*context);
  }
}
}  // namespace pmjs::mv
