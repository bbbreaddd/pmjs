#include "mv_engine.hpp"

namespace pmjs::mv {
void Session::refreshCommonEvents() {
  for (const auto& event : database_["commonEvents"].array()) {
    if (event.null() || event["trigger"].integer() != 2) continue;
    const int id = event["id"].integer(), switchId = event["switchId"].integer();
    const auto enabled = switches_.find(switchId);
    if (enabled != switches_.end() && enabled->second) {
      if (!commonInterpreters_.contains(id)) commonInterpreters_[id] = std::make_shared<Interpreter>();
    }
    else commonInterpreters_.erase(id);
  }
}

void Session::updateCommonEvents() {
  std::vector<int> ids;
  for (const auto& event : database_["commonEvents"].array())
    if (!event.null() && event["trigger"].integer() == 2) ids.push_back(event["id"].integer());
  for (int id : ids) {
    const auto found = commonInterpreters_.find(id);
    if (found == commonInterpreters_.end()) continue;
    const auto context = found->second;
    if (!context->running) {
      setupInterpreter(*context, database_["commonEvents"][id]["list"].array());
    }
    advanceInterpreter(*context);
  }
}
}  // namespace pmjs::mv
