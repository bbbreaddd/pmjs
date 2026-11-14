#include "mv_engine.hpp"
#include "mv_core_utils.hpp"
#include "mv_managers.hpp"
#include <algorithm>
#include <cctype>
#include <cmath>
#include <regex>
#include <stdexcept>

namespace pmjs::mv {
bool Session::dispatchManager(const std::string& manager, const std::string& method, const Value::Array& arguments) {
  if (!runtimeHooks_ || !runtimeHooks_->manager) return false;
  const auto key = std::make_pair(manager, method);
  if (!managerCalls_.insert(key).second) return false;
  try {
    const bool handled = runtimeHooks_->manager(manager, method, arguments);
    managerCalls_.erase(key); return handled;
  } catch (...) { managerCalls_.erase(key); throw; }
}

void Session::dispatchGameDataMutation(const std::string& kind, const std::string& method, const Value::Array& arguments) {
  if (!runtimeHooks_ || !runtimeHooks_->gameDataMutation || !runtimeHooks_->gameDataMutation(kind, method, arguments))
    invokeGameDataBase(kind, method, arguments);
}
Value Session::invokeGameDataBase(const std::string& kind, const std::string& method, const Value::Array& arguments) {
  if (kind=="timer") {
    if (method=="frames") { if (!arguments.empty()) timerFrames_=arguments[0].integer(); return timerFrames_; }
    if (method=="working") { if (!arguments.empty()) timerWorking_=arguments[0].boolean(); return timerWorking_; }
    if (method=="seconds") return static_cast<int>(std::floor(timerFrames_/60.0));
    if (method=="isWorking") return timerWorking_;
    if (method=="initialize") { timerFrames_=0; timerWorking_=false; }
    else if (method=="start") { timerFrames_=arguments.at(0).integer(); timerWorking_=true; }
    else if (method=="stop") timerWorking_=false;
    else if (method=="update") { if ((arguments.empty() || arguments[0].boolean()) && timerWorking_ && timerFrames_>0 && --timerFrames_==0) dispatchGameDataMutation("timer","onExpire",{}); }
    else if (method=="onExpire") { if (battle_.active) { battle_.aborting=true; if (!battle_.interpreter.running && !message_.busy) abortBattle(); } }
    else throw std::invalid_argument("timer operation is not bound: "+method);
    return Value::undefined();
  }
  if (kind == "actors" && method == "ids") {
    Value::Array result; for (const auto& [id, actor] : actors_) { (void)actor; result.emplace_back(id); } return result;
  }
  if (kind == "screen") return invokeScreenBase(method, arguments);
  if (kind == "map" && method == "invalidateTileFunctions") { if(!arguments.empty())runtimeTileFunctions_=arguments[0].boolean();if(arguments.size()>1)runtimeTileDrawing_=arguments[1].boolean();++presentationRevision_;return Value::undefined(); }
  if (kind == "map" && method == "invalidateTileShadows") { if (!arguments.empty()) runtimeTileShadows_ = arguments[0].boolean(); ++presentationRevision_; return Value::undefined(); }
  if (kind == "map" && method == "cameraNormal") {
    if (!arguments.empty()) {
      if (arguments[0].boolean()) { cameraTarget_.reset(); savedCamera_.reset(); centerPlayer(); }
      else if (!cameraTarget_) setCameraTarget(runtimeCharacter(-1), 800);
    }
    return !cameraTarget_;
  }
  if (kind == "map") {
    if (method == "initialize") { initializeMap(); return Value::undefined(); }
    if (method == "setDisplayPos") { setDisplayPosition(arguments.at(0).number(), arguments.at(1).number()); return Value::undefined(); }
    if (method == "updateParallax") { updateMapParallax(); return Value::undefined(); }
    if (method == "scrollDown" || method == "scrollLeft" || method == "scrollRight" || method == "scrollUp") {
      scrollMapDirection(method == "scrollDown" ? 2 : method == "scrollLeft" ? 4 : method == "scrollRight" ? 6 : 8, arguments.at(0).number());
      return Value::undefined();
    }
    if (method == "setupScroll") {
      mapState_.scrollDirection = 2; mapState_.scrollRest = 0; mapState_.scrollSpeed = 4;
      return Value::undefined();
    }
    if (method == "autoplay") { autoplayMap(); return Value::undefined(); }
    if (method == "setup") { setupMap(arguments.at(0).integer()); return Value::undefined(); }
    if (method == "adjustX") return runtimeMapAdjustedPosition(arguments.at(0).number(), 0)[0];
    if (method == "adjustY") return runtimeMapAdjustedPosition(0, arguments.at(0).number())[1];
    if (method == "tileWidth") return tileWidth();
    if (method == "tileHeight") return tileHeight();
    if (method == "tilesetId") return mapState_.tilesetId;
    if (method == "width" || method == "height" || method == "displayName" || method == "encounterStep") return map()[method];
    if (method == "isLoopHorizontal") return loopHorizontal();
    if (method == "isLoopVertical") return loopVertical();
    if (method == "isEventRunning") return interpreter_.running;
    if (method == "eventIds") { Value::Array ids; for (const auto& event : events_) ids.emplace_back(event.id); return ids; }
    if (method == "displayX" || method == "displayY") {
      const int axis = method == "displayX" ? 0 : 1;
      double& coordinate = axis == 0 ? mapState_.lastDisplayX : mapState_.lastDisplayY;
      if (!arguments.empty()) {
        const double value = arguments[0].number();
        if (!std::isfinite(value)) throw std::invalid_argument("map display coordinate must be finite");
        coordinate = value;
        if (savedCamera_) (*savedCamera_)[axis] = value;
      }
      return coordinate;
    }
    if (method == "refreshIfNeeded") { refreshIfNeeded(); return Value::undefined(); }
    throw std::invalid_argument("map operation is not bound: " + method);
  }
  if (kind == "system") {
    if (method == "windowTone") return system_.windowTone.null() ? database_["system"]["windowTone"] : system_.windowTone;
    if (method == "setWindowTone") { system_.windowTone = arguments.at(0); return Value::undefined(); }
    if (method == "isSideView") return database_["system"]["optSideView"].boolean();
    if (method == "initialize") { system_ = {}; return Value::undefined(); }
    if (method == "playtime") return static_cast<int>(ticks_ / 60);
    bool* flag = nullptr; int* count = nullptr;
    if (method == "saveEnabled") flag = &system_.saveEnabled;
    else if (method == "menuEnabled") flag = &system_.menuEnabled;
    else if (method == "encounterEnabled") flag = &system_.encounterEnabled;
    else if (method == "formationEnabled") flag = &system_.formationEnabled;
    else if (method == "battleCount") count = &system_.battleCount;
    else if (method == "winCount") count = &system_.winCount;
    else if (method == "escapeCount") count = &system_.escapeCount;
    else if (method == "saveCount") count = &system_.saveCount;
    else if (method == "versionId") count = &system_.versionId;
    if (flag) { if (!arguments.empty()) *flag = arguments[0].boolean(); return *flag; }
    if (count) { if (!arguments.empty()) *count = arguments[0].integer(); return *count; }
    throw std::invalid_argument("system operation is not bound: " + method);
  }
  if (kind == "temp") {
    if (method == "initialize") { reservedCommonEvent_ = 0; destination_.reset(); return Value::undefined(); }
    if (method == "reserveCommonEvent") { reservedCommonEvent_ = arguments.at(0).integer(); return Value::undefined(); }
    if (method == "clearCommonEvent") { reservedCommonEvent_ = 0; return Value::undefined(); }
    if (method == "commonEventId") return reservedCommonEvent_;
    if (method == "isCommonEventReserved") return reservedCommonEvent_ > 0;
    if (method == "setDestination") { destination_ = {arguments.at(0).integer(), arguments.at(1).integer()}; return Value::undefined(); }
    if (method == "clearDestination") { destination_.reset(); return Value::undefined(); }
    if (method == "isDestinationValid") return destination_.has_value();
    if (method == "destinationX") return destination_ ? Value((*destination_)[0]) : Value();
    if (method == "destinationY") return destination_ ? Value((*destination_)[1]) : Value();
    throw std::invalid_argument("temporary data operation is not bound: " + method);
  }
  if (kind == "battle" && method == "isInputting") {
    return battle_.active && !battle_.opening && !battle_.turnEnding && !battle_.aborting &&
      battle_.wait == 0 && battle_.actionStage == 0 && !battle_.forcedExecuting &&
      battle_.actorIndex < static_cast<int>(battleMemberCount());
  }
  if (kind == "battle") {
    if (method == "updateBattleEnd") { leaveBattle(); return Value::undefined(); }
    if (method == "nextSubject") {
      if(battle_.actions.empty())return {};
      const auto& action=battle_.actions.front(); return Value::Object{{"actorId",action.enemy?0:action.actorId?action.actorId:party_.at(action.subject)},{"enemyIndex",action.enemy?action.subject:-1}};
    }
    if (method == "processTurn") {
  if (battle_.actions.empty()) { endTurn(); return Value::undefined(); }
  const auto action = battle_.actions.front(); battle_.actions.erase(battle_.actions.begin()); executeAction(action);
  if (!battle_.actionStage &&
      std::none_of(battle_.actions.begin(), battle_.actions.end(), [&](const Action& next) { return next.enemy == action.enemy && next.subject == action.subject && next.actorId == action.actorId; })) {
    auto& subject = action.enemy ? battle_.enemies[action.subject] : actors_.at(action.actorId ? action.actorId : party_[action.subject]);
    endBattlerActions(subject);
  }
  if (!battle_.wait) battle_.wait = 1;
      return Value::undefined();
    }

    if (method == "playVictoryMe" || method == "playDefeatMe") {
      const auto& sound=method=="playVictoryMe" ? system_.victoryMe : system_.defeatMe;
      AudioManager::playMe(*this,sound.null()?database_["system"][method=="playVictoryMe"?"victoryMe":"defeatMe"]:sound); return Value::undefined();
    }
    if (method == "playBattleBgm") { AudioManager::playBgm(*this,system_.battleBgm.null()?database_["system"]["battleBgm"]:system_.battleBgm);AudioManager::stopBgs(*this);return Value::undefined(); }
    if (method == "replayBgmAndBgs") { AudioManager::replayBgm(*this,battle_.mapBgm);AudioManager::replayBgs(*this,battle_.mapBgs);return Value::undefined(); }

    if (method == "rewards") {
      int gold=0, exp=0; Value::Array items;
      for (const auto& enemy : battle_.enemies) if(enemy.isDead()) {
        const auto& source=database_["enemies"][enemy.id]; gold+=source["gold"].integer(); exp+=source["exp"].integer();
        for(const auto& drop:source["dropItems"].array()) if(drop["kind"].integer()>0 && random()*drop["denominator"].number()<(hasPartyAbility(5)?2:1)) items.emplace_back(Value::Object{{"kind",drop["kind"]},{"id",drop["dataId"]}});
      }
      return Value::Object{{"gold",gold*(hasPartyAbility(4)?2:1)},{"exp",exp},{"items",items}};
    }
    if (method == "gainExp") {
      const double exp=arguments[0].number();
      for (std::size_t index=0;index<party_.size();++index) { auto& actor=actors_.at(party_[index]); const double gain=std::floor(exp*trait(actor,23,9,true)*((index<4 && !actor.hidden)||database_["system"]["optExtraExp"].boolean()?1:0)+0.5); changeActorExp(actor,actor.exp[actor.classId]+gain,true); }
      return Value::undefined();
    }

    if (method == "processEscape") {
      SoundManager::playEscape(*this);
      const bool success = battle_.preemptive || random() < battle_.escapeRatio;
      if (success) finishBattle(1);
      else {
        battle_.escapeRatio += 0.1;
        battle_.actions.erase(std::remove_if(battle_.actions.begin(), battle_.actions.end(), [](const Action& action) { return !action.enemy; }), battle_.actions.end());
        battle_.actorIndex = static_cast<int>(battleMemberCount());
        std::fill(battle_.remainingActions.begin(),battle_.remainingActions.end(),0);
        battle_.log.clear();
        message_ = {}; message_.busy = true; messageAge_ = 0;
        message_.lines = {battleMessage("escapeStart", {partyName()}), battleMessage("escapeFailure")};
        beginTurn();
      }
      return success;
    }
    if (method == "endBattle") { const int result=arguments[0].integer(); battle_.result=result; battle_.active=false; battle_.phase="battleEnd"; setBattleEventResult(result); return Value::undefined(); }

    if (method == "action") {
      Action* action = battle_.pendingAction ? &*battle_.pendingAction : battle_.actionStage && battle_.currentVisual >= 0 ? &battle_.visuals.at(battle_.currentVisual).action : nullptr;
      if (!action) return {};
      if (arguments.size() > 1) {
        if (arguments.size() < 3 || arguments[2].number() != static_cast<double>(battle_.actionSerial)) throw std::invalid_argument("battle action is no longer current");
        const auto field = arguments[0].text(); const auto& value = arguments[1];
        if (field == "id") action->id = value.integer();
        else if (field == "item") action->item = value.boolean();
        else if (field == "target") action->target = value.integer();
        else if (field == "forced") action->forced = value.boolean();
        else throw std::invalid_argument("battle action field is not bound: " + field);
      }
      const int actorId = action->enemy ? 0 : action->actorId ? action->actorId : party_.at(action->subject);
      return Value::Object{{"serial",static_cast<double>(battle_.actionSerial)}, {"id", action->id}, {"item",action->item}, {"target",action->target}, {"forced",action->forced}, {"actorId",actorId}, {"enemyIndex",action->enemy ? action->subject : -1}};
    }
    if (method == "subject") {
      Action* action = battle_.pendingAction ? &*battle_.pendingAction : battle_.actionStage && battle_.currentVisual >= 0 ? &battle_.visuals.at(battle_.currentVisual).action : nullptr;
      if (action && arguments.size() == 2) {
        action->enemy = arguments[1].integer() >= 0;
        action->actorId = arguments[0].integer();
        if (action->enemy) action->subject = arguments[1].integer();
        else { const auto found = std::find(party_.begin(), party_.end(), action->actorId); if (found == party_.end()) throw std::invalid_argument("battle subject is not in the party"); action->subject = static_cast<int>(found-party_.begin()); }
      }
      return Value::undefined();
    }
    if (method == "targets") {
      if (!battle_.actionStage || battle_.currentVisual < 0) return Value::Array{};
      auto& visual = battle_.visuals.at(battle_.currentVisual);
      if (!arguments.empty()) {
        visual.targets.resize(battle_.targetIndex);
        for (const auto& value : arguments[0].array()) {
          BattleTarget target; target.enemy = value["enemyIndex"].integer(-1) >= 0;
          target.actorId = value["actorId"].integer();
          if (target.enemy) { target.index=value["enemyIndex"].integer(); if(target.index<0 || target.index>=static_cast<int>(battle_.enemies.size())) throw std::invalid_argument("unknown battle target"); }
          else { const auto found=std::find(party_.begin(),party_.end(),target.actorId); if(found==party_.end())throw std::invalid_argument("battle target is not in the party"); target.index=static_cast<int>(found-party_.begin()); }
          visual.targets.push_back(target);
        }
        visual.invocationCount = visual.targets.size(); visual.animationTargets = visual.targets;
      }
      Value::Array result;
      for (std::size_t index = battle_.targetIndex; index < visual.invocationCount; ++index) { const auto& target=visual.targets[index]; result.emplace_back(Value::Object{{"actorId",target.enemy ? 0 : target.actorId ? target.actorId : party_.at(target.index)}, {"enemyIndex",target.enemy ? target.index : -1}}); }
      return result;
    }
    if (method == "makeActionOrders") { makeBattleActionOrders(); return Value::undefined(); }
    if (method == "orders") {
      const auto key = [&](const Action& action) { return action.enemy ? -action.subject-1 : action.actorId ? action.actorId : party_.at(action.subject); };
      if (!arguments.empty()) {
        std::vector<Action> reordered;
        for (const auto& value : arguments[0].array()) {
          const int id = value["enemyIndex"].integer(-1) >= 0 ? -value["enemyIndex"].integer()-1 : value["actorId"].integer();
          for (const auto& action : battle_.actions) if (key(action)==id) reordered.push_back(action);
        }
        battle_.actions = std::move(reordered);
      }
      Value::Array result; std::set<int> seen;
      for (const auto& action : battle_.actions) if (seen.insert(key(action)).second) result.emplace_back(Value::Object{{"actorId",action.enemy ? 0 : key(action)}, {"enemyIndex",action.enemy ? action.subject : -1}});
      return result;
    }
    if (method == "startAction") { if (battle_.pendingAction) executeAction(*battle_.pendingAction); return Value::undefined(); }
    if (method == "invokeAction") { resolveAction(); return Value::undefined(); }
    if (method == "endAction") { endBattleAction(); return Value::undefined(); }

    if (method == "setup") { startBattle(arguments[0].integer(), arguments[1].boolean(), arguments[2].boolean(), arguments.size()<4 || arguments[3].boolean()); return Value::undefined(); }
    if (method == "field") {
      const auto field = arguments[0].text(); const bool write = arguments.size() > 1;
      const auto& value = arguments.size() > 1 ? arguments[1] : arguments[0];
      if (field == "_phase") {
        if (write) { battle_.phase = value.text(); if(battle_.phase=="aborting")battle_.aborting=true; if(battle_.phase=="battleEnd")battle_.active=false; }
        return battle_.phase.empty() ? Value{} : Value(battle_.phase);
      }
      if (field == "_battleTest") { if(write)battleTest_=value.boolean();return battleTest_; }
      if (field == "_actorIndex") { if (write) battle_.actorIndex = value.integer(); return battle_.actorIndex; }
      if (field == "_escapeRatio") { if (write) battle_.escapeRatio = value.number(); return battle_.escapeRatio; }
      if (field == "_preemptive") { if (write) battle_.preemptive = value.boolean(); return battle_.preemptive; }
      if (field == "_surprise") { if (write) battle_.surprise = value.boolean(); return battle_.surprise; }
      if (field == "_canEscape") { if (write) battle_.canEscape = value.boolean(); return battle_.canEscape; }
      if (field == "_canLose") { if (write) battle_.canLose = value.boolean(); return battle_.canLose; }
      if (field == "_turnForced") { if (write) battle_.forcedTurn = value.boolean(); return battle_.forcedTurn; }
      if (field == "_mapBgm") { if (write) battle_.mapBgm = value; return battle_.mapBgm; }
      if (field == "_mapBgs") { if (write) battle_.mapBgs = value; return battle_.mapBgs; }
      throw std::invalid_argument("battle field is not bound: " + field);
    }
    if (method == "update") { updateBattle(); return Value::undefined(); }
    if (method == "startInput") { makeEnemyActions(); return Value::undefined(); }
    if (method == "startTurn") { beginTurn(); return Value::undefined(); }
    if (method == "endTurn") { endTurn(); return Value::undefined(); }
    if (method == "processVictory") { finishBattle(0); return Value::undefined(); }
    if (method == "processDefeat") { finishBattle(2); return Value::undefined(); }
    if (method == "processAbort") { abortBattle(); return Value::undefined(); }
    if (method == "setupTroop") { setupTroopBase(arguments.at(0).integer()); return Value::undefined(); }
    if (method == "increaseTurn") { increaseTroopTurnBase(); return Value::undefined(); }
    if (method == "setupBattleEvent") { setupTroopEvents(); return Value::undefined(); }
    if (method == "updateInterpreter") { advanceInterpreter(battle_.interpreter); return Value::undefined(); }
    if (method == "enemyCount") return static_cast<int>(battle_.enemies.size());
    if (method == "troopId") return battle_.troopId;
    if (method == "turnCount") return battle_.turn;
    if (method == "isEventRunning") return battle_.interpreter.running;
    if (method == "canEscape") return battle_.canEscape;
    if (method == "canLose") return battle_.canLose;
    if (method == "isAborting") return battle_.aborting;
    if (method == "isTurnEnd") return battle_.turnEnding;
    if (method == "actorId") return battle_.active && battle_.actorIndex >= 0 && battle_.actorIndex < static_cast<int>(battleMemberCount()) ? party_[battle_.actorIndex] : 0;
    throw std::invalid_argument("battle operation is not bound: " + method);
  }
  if (kind == "party") {
    if (method == "initialize") { inventory_.clear(); party_.clear(); gold_ = 0; steps_ = 0; lastItemKind_ = 0; lastItemId_ = 0; return Value::undefined(); }
    if (method == "lastItem") {
      if (!arguments.empty()) {
        const int kind = arguments.at(0).integer(), id = arguments.at(1).integer();
        if (kind < 0 || kind > 4 || id < 0) throw std::invalid_argument("invalid remembered item");
        lastItemKind_ = kind; lastItemId_ = id;
      }
      return Value::Array{lastItemKind_, lastItemId_};
    }
    if (method == "members") { Value::Array ids; for (int id : partyMembers()) ids.emplace_back(id); return ids; }
    if (method == "gold") return gold_;
    if (method == "inBattle") return battle_.active;
    if (method == "allMembers") { Value::Array ids; for (int id : party_) ids.emplace_back(id); return ids; }
    if (method == "steps") return steps_;
    if (method == "increaseSteps") { ++steps_; return Value::undefined(); }
    if (method == "goldValue") { if (!arguments.empty()) gold_ = arguments[0].integer(); return gold_; }
    if (method == "menuActorId" || method == "targetActorId") {
      auto& id = method == "menuActorId" ? menuActorId_ : targetActorId_;
      if (!arguments.empty()) id = arguments[0].integer();
      return id;
    }
    if (method == "addActor" || method == "removeActor") {
      const int id = arguments.at(0).integer();
      const auto found = std::find(party_.begin(), party_.end(), id);
      if (method == "addActor" && found == party_.end() && !database_["actors"][id].null()) {
        runtimeActor(id); party_.push_back(id);
      } else if (method == "removeActor" && found != party_.end()) party_.erase(found);
      updatePlayerGraphic(); refreshNeeded_ = true; return Value::undefined();
    }
    if (method == "swapOrder") {
      const int first = arguments.at(0).integer(), second = arguments.at(1).integer();
      if (first < 0 || second < 0 || first >= static_cast<int>(party_.size()) || second >= static_cast<int>(party_.size()))
        throw std::invalid_argument("party index is out of bounds");
      std::swap(party_[first], party_[second]); updatePlayerGraphic(); return Value::undefined();
    }
    throw std::invalid_argument("party operation is not bound: " + method);
  }
  if (kind == "inventory") {
    if (arguments.empty()) throw std::invalid_argument("inventory category is required");
    const int category = arguments[0].integer();
    if (category < 0 || category > 2) throw std::invalid_argument("invalid inventory category");
    const int offset = category * 100000;
    const auto id = [&]() {
      if (arguments.size() < 2 || arguments[1].integer() <= 0 || arguments[1].integer() >= 100000)
        throw std::invalid_argument("invalid inventory item ID");
      return arguments[1].integer() + offset;
    };
    if (method == "read") {
      Value::Object result;
      for (const auto& [key, count] : inventory_) if (key / 100000 == category) result[std::to_string(key % 100000)] = count;
      return result;
    }
    if (method == "value") { const auto found = inventory_.find(id()); return found == inventory_.end() ? Value::undefined() : Value(found->second); }
    if (method == "set") {
      if (arguments.size() != 3 || !std::holds_alternative<double>(arguments[2].data) || !std::isfinite(arguments[2].number()) || arguments[2].number() < 0 || arguments[2].number() > 2147483647.0 || arguments[2].number() != arguments[2].integer())
        throw std::invalid_argument("inventory count must be a nonnegative integer");
      inventory_[id()] = arguments[2].integer(); refreshNeeded_ = true; return Value::undefined();
    }
    if (method == "delete") { inventory_.erase(id()); refreshNeeded_ = true; return Value::undefined(); }
    if (method == "replace") {
      if (arguments.size() != 2 || !std::holds_alternative<Value::Object>(arguments[1].data)) throw std::invalid_argument("inventory replacement must be a dictionary");
      std::map<int, int> replacement;
      for (const auto& [key, value] : std::get<Value::Object>(arguments[1].data)) {
        std::size_t consumed = 0; const int item = std::stoi(key, &consumed);
        if (consumed != key.size() || std::to_string(item) != key || item <= 0 || item >= 100000 || !std::holds_alternative<double>(value.data) || !std::isfinite(value.number()) || value.number() < 0 || value.number() > 2147483647.0 || value.number() != value.integer())
          throw std::invalid_argument("invalid inventory dictionary entry");
        replacement[item + offset] = value.integer();
      }
      std::erase_if(inventory_, [&](const auto& entry) { return entry.first / 100000 == category; });
      inventory_.insert(replacement.begin(), replacement.end()); refreshNeeded_ = true; return Value::undefined();
    }
    throw std::invalid_argument("inventory operation is not bound: " + method);
  }
  if (kind == "selfSwitches") {
    if (method == "clear") { selfSwitches_.clear(); return Value::undefined(); }
    if (method == "onChange") { refreshNeeded_ = true; return Value::undefined(); }
    if (arguments.empty() || arguments[0].array().size() != 3) throw std::invalid_argument("self switch key requires map, event and letter");
    const auto key = selfKey(arguments[0][0].integer(), arguments[0][1].integer(), arguments[0][2].text());
    if (method == "value") { const auto found = selfSwitches_.find(key); return found != selfSwitches_.end() && found->second; }
    if (method != "setValue" || arguments.size() != 2) throw std::invalid_argument("self switch operation is not bound: " + method);
    if (arguments[1].boolean()) selfSwitches_[key] = true; else selfSwitches_.erase(key);
    dispatchGameDataMutation(kind, "onChange", {}); return Value::undefined();
  }
  if (kind != "variables" && kind != "switches") throw std::invalid_argument("game data store is not bound: " + kind);
  auto& dataLength = kind == "variables" ? variableDataLength_ : switchDataLength_;
  const auto length = [&]() { return std::max(dataLength, kind == "variables" ? (variables_.empty() ? 0 : variables_.rbegin()->first + 1) : (switches_.empty() ? 0 : switches_.rbegin()->first + 1)); };
  if (method == "dataLength") {
    if (!arguments.empty()) {
      const auto& value = arguments[0];
      if (!std::holds_alternative<double>(value.data) || value.number() < 0 || value.number() > 2147483647.0 || value.number() != value.integer()) throw std::invalid_argument("invalid game data array length");
      dataLength = value.integer();
      if (kind == "variables") std::erase_if(variables_, [&](const auto& entry) { return entry.first >= dataLength; });
      else std::erase_if(switches_, [&](const auto& entry) { return entry.first >= dataLength; });
    }
    return length();
  }
  if (method == "dataKeys") {
    Value::Array keys;
    if (kind == "variables") for (const auto& [id,value] : variables_) { (void)value; keys.emplace_back(std::to_string(id)); }
    else for (const auto& [id,value] : switches_) { (void)value; keys.emplace_back(std::to_string(id)); }
    return keys;
  }
  if (method == "replaceData") {
    const double size = arguments.at(0).number();
    if (!std::isfinite(size) || size < 0 || size > 2147483647.0 || std::floor(size) != size) throw std::invalid_argument("invalid game data array length");
    const int count = static_cast<int>(size);
    const auto& entries = arguments.at(1);
    if (!std::holds_alternative<Value::Object>(entries.data)) throw std::invalid_argument("game data entries must be an object");
    std::map<int,Value> replacement;
    for (const auto& [key,value] : std::get<Value::Object>(entries.data)) {
      std::size_t consumed; const int id = std::stoi(key,&consumed);
      if (consumed != key.size() || std::to_string(id) != key || id < 0 || id >= count) throw std::invalid_argument("invalid game data array index");
      if (std::holds_alternative<Value::Array>(value.data) || std::holds_alternative<Value::Object>(value.data)) throw std::invalid_argument("object variable assignment is not bound");
      replacement.emplace(id,value);
    }
    if (kind == "variables") variables_ = std::move(replacement);
    else { switches_.clear(); for (const auto& [id,value] : replacement) switches_[id] = value.boolean(); }
    dataLength = count; return Value::undefined();
  }
  if (method == "rawValue" || method == "rawHas" || method == "rawSet" || method == "rawDelete") {
    const int id = arguments.at(0).integer();
    if (id < 0 || id >= 2147483647) throw std::invalid_argument("invalid game data array index");
    const bool exists = kind == "variables" ? variables_.contains(id) : switches_.contains(id);
    if (method == "rawHas") return exists;
    if (method == "rawDelete") {
      dataLength = length();
      if (kind == "variables") variables_.erase(id); else switches_.erase(id);
      return Value::undefined();
    }
    if (method == "rawSet") {
      const auto& value = arguments.at(1);
      if (std::holds_alternative<Value::Array>(value.data) || std::holds_alternative<Value::Object>(value.data)) throw std::invalid_argument("object variable assignment is not bound");
      if (kind == "variables") variables_[id] = value; else switches_[id] = value.boolean();
      dataLength = std::max(dataLength,id + 1); return Value::undefined();
    }
    if (!exists) return Value::undefined();
    const Value value = kind == "variables" ? variables_.at(id) : Value(switches_.at(id));
    if (std::holds_alternative<Value::Array>(value.data) || std::holds_alternative<Value::Object>(value.data)) throw std::invalid_argument("object variable views are not bound");
    return value;
  }
  if (method == "clear") { if (kind == "variables") variables_.clear(); else switches_.clear(); dataLength = 0; return Value::undefined(); }
  if (method == "onChange") { refreshNeeded_ = true; return Value::undefined(); }
  if (arguments.empty()) throw std::invalid_argument("game data access requires an ID");
  const int id = arguments[0].integer();
  if (method == "value") {
    if (kind == "switches") { const auto found = switches_.find(id); return found != switches_.end() && found->second; }
    const auto& value = variable(id);
    if (std::holds_alternative<Value::Array>(value.data) || std::holds_alternative<Value::Object>(value.data))
      throw std::runtime_error("object variable views are not bound");
    return value;
  }
  if (method != "setValue" || arguments.size() != 2) throw std::invalid_argument("game data operation is not bound: " + method);
  const auto& names = database_["system"][kind];
  if (id <= 0 || (!names.null() && id >= static_cast<int>(names.array().size()))) return Value::undefined();
  auto value = arguments[1];
  if (kind == "variables") {
    if (const auto* number = std::get_if<double>(&value.data)) value = std::floor(*number);
    variables_[id] = std::move(value);
  } else switches_[id] = value.boolean();
  dispatchGameDataMutation(kind, "onChange", {});
  return Value::undefined();
}
Value Session::imageRequests(const RuntimeCommandList& list) {
  Value::Array requests;
  const auto request = [&](const char* method, const Value& name, const Value& hue = Value(0)) {
    requests.emplace_back(Value::Object{{"method", method}, {"arguments", Value::Array{name, hue}}});
  };
  for (const auto& command : list.root.array()) {
    const auto& p = command["parameters"];
    switch (command["code"].integer()) {
      case 101: request("requestFace", p[0]); break;
      case 117: if (!database_["commonEvents"][p[0].integer()].null()) requests.emplace_back(Value::Object{{"commonEvent", p[0]}}); break;
      case 129:
        if (!database_["actors"][p[0].integer()].null()) {
          if (!actors_.contains(p[0].integer())) initializeActor(p[0].integer());
          if (!p[1].integer()) request("requestCharacter", actors_.at(p[0].integer()).characterName);
        }
        break;
      case 205:
        for (const auto& route : p[1]["list"].array()) if (route["code"].integer() == 41) request("requestCharacter", route["parameters"][0]);
        break;
      case 212: case 337:
        if (p[1].integer()) {
          const auto& animation = database_["animations"][p[1].integer()];
          request("requestAnimation", animation["animation1Name"], animation["animation1Hue"]);
          request("requestAnimation", animation["animation2Name"], animation["animation2Hue"]);
        }
        break;
      case 216: if (!p[0].integer()) for (const auto& follower : followers_) request("requestCharacter", follower.characterName); break;
      case 231: request("requestPicture", p[1]); break;
      case 282: for (const auto& name : database_["tilesets"][p[0].integer()]["tilesetNames"].array()) request("requestTileset", name); break;
      case 283: if (battle_.active) { request("requestBattleback1", p[0]); request("requestBattleback2", p[1]); } break;
      case 284: if (!battle_.active) request("requestParallax", p[0]); break;
      case 322: request("requestCharacter", p[1]); request("requestFace", p[3]); request("requestSvActor", p[5]); break;
      case 323: if (p[0].integer() >= 0 && p[0].integer() < 3) request("requestCharacter", p[1]); break;
      case 336: {
        const auto& enemy = database_["enemies"][p[1].integer()];
        request(database_["system"]["optSideView"].boolean() ? "requestSvEnemy" : "requestEnemy", enemy["battlerName"], enemy["battlerHue"]);
        break;
      }
    }
  }
  return requests;
}
Value& RuntimeCommandList::resolve(const std::vector<std::string>& path) {
  Value* value = &root;
  for (const auto& key : path) {
    if (auto* array = std::get_if<Value::Array>(&value->data)) value = &array->at(std::stoul(key));
    else value = &std::get<Value::Object>(value->data).at(key);
  }
  return *value;
}
std::shared_ptr<RuntimeCommandView> RuntimeCommandList::view(const std::vector<std::string>& path) {
  auto& cached = views[path];
  if (auto value = cached.lock()) return value;
  auto value = std::make_shared<RuntimeCommandView>();
  value->list = shared_from_this(); value->path = path;
  cached = value;
  return value;
}
namespace {
std::string trim(std::string text) {
  const auto first=text.find_first_not_of(" \t\r\n"),last=text.find_last_not_of(" \t\r\n");
  return first==std::string::npos?std::string{}:text.substr(first,last-first+1);
}
std::vector<std::string> split(const std::string& text,char delimiter) {
  std::vector<std::string> result; std::size_t start=0; int depth=0; char quote=0; bool escape=false;
  for(std::size_t i=0;i<text.size();++i) {
    const char c=text[i];
    if(quote) { if(escape)escape=false;else if(c=='\\')escape=true;else if(c==quote)quote=0; continue; }
    if(c=='\''||c=='"'){quote=c;continue;}
    if(c=='('||c=='['||c=='{')++depth;
    else if(c==')'||c==']'||c=='}')--depth;
    else if(c==delimiter&&depth==0) { result.push_back(trim(text.substr(start,i-start)));start=i+1; }
  }
  if(quote||depth)throw std::invalid_argument("unbalanced native script expression");
  if(start<text.size())result.push_back(trim(text.substr(start)));
  return result;
}
}
void Session::executeNativeScript(const std::string& source,Interpreter& context) {
  if (runtimeHooks_ && runtimeHooks_->script) { runtimeHooks_->script(context.runtime, source); return; }
  for(auto statement:split(source,';')) {
    statement=trim(statement); if(statement.empty())continue;
    const auto open=statement.find('('),close=statement.rfind(')');
    if(open==std::string::npos||close==std::string::npos||!trim(statement.substr(close+1)).empty()) {
      evaluateExpression(statement);continue;
    }
    std::smatch actorCall;
    static const std::regex actorPattern(R"(^\$gameActors\.actor\((.+)\)\.([A-Za-z]+)\((.*)\)$)");
    if(std::regex_match(statement,actorCall,actorPattern)) {
      const int id=static_cast<int>(evaluateExpression(actorCall[1].str()));
      if(database_["actors"][id].null())continue;
      if(!actors_.contains(id))initializeActor(id);
      auto& actor=actors_.at(id); const auto args=split(actorCall[3].str(),',');
      const auto number=[&](std::size_t i){return i<args.size()?evaluateExpression(args[i]):0;};
      const auto method=actorCall[2].str();
      if(method=="setHp")actor.hp=static_cast<int>(number(0));
      else if(method=="setMp")actor.mp=static_cast<int>(number(0));
      else if(method=="setTp")actor.tp=static_cast<int>(number(0));
      else if(method=="gainHp") {const int delta=static_cast<int>(number(0)); actor.result.hpAffected=true; actor.result.hpDamage=-delta; actor.hp+=delta;}
      else if(method=="gainMp") {const int delta=static_cast<int>(number(0)); actor.result.mpDamage=-delta; actor.mp+=delta;}
      else if(method=="gainTp") {const int delta=static_cast<int>(number(0)); actor.result.tpDamage=-delta; actor.tp+=delta;}
      else if(method=="recoverAll")recover(actor);
      else if(method=="addState")addState(actor,static_cast<int>(number(0)));
      else if(method=="removeState")removeState(actor,static_cast<int>(number(0)));
      else if(method=="learnSkill")actor.skills.insert(static_cast<int>(number(0)));
      else if(method=="forgetSkill")actor.skills.erase(static_cast<int>(number(0)));
      else if(method=="changeExp")changeActorExp(actor,number(0),number(1)!=0);
      else throw std::invalid_argument("unsupported native actor script call: "+method);
      refreshBattler(actor); continue;
    }
    const auto name=trim(statement.substr(0,open)); const auto args=split(statement.substr(open+1,close-open-1),',');
    const auto number=[&](std::size_t i){return i<args.size()?evaluateExpression(args[i]):0;};
    const auto value=[&](std::size_t i)->Value {
      if(i>=args.size())return {};
      const auto& text=args[i];
      if(text.size()>=2&&(text.front()=='\''||text.front()=='"')&&text.back()==text.front())return text.substr(1,text.size()-2);
      if(text=="true")return true;if(text=="false")return false;
      if(text=="null")return {};if(text=="undefined")return Value::undefined();
      return evaluateExpression(text);
    };
    if(context.scriptCharacter && name.starts_with("this.")) {
      auto* character=routeCharacter(*context.scriptCharacter,context); if(!character)continue;
      const auto method=name.substr(5);
      if(method=="setDirection") {const int direction=static_cast<int>(number(0));if(!character->directionFix&&direction)character->direction=direction;character->stopCount=0;}
      else if(method=="setMoveSpeed")character->moveSpeed=static_cast<int>(number(0));
      else if(method=="setMoveFrequency")character->moveFrequency=static_cast<int>(number(0));
      else if(method=="setPattern")character->pattern=static_cast<int>(number(0));
      else if(method=="setOpacity")character->opacity=static_cast<int>(number(0));
      else if(method=="setBlendMode")character->blendMode=static_cast<int>(number(0));
      else if(method=="setThrough")character->through=value(0).boolean();
      else if(method=="setTransparent")character->transparent=value(0).boolean();
      else if(method=="setWalkAnime")character->walkAnime=value(0).boolean();
      else if(method=="setStepAnime")character->stepAnime=value(0).boolean();
      else if(method=="setDirectionFix")character->directionFix=value(0).boolean();
      else if(method=="setImage"){character->characterName=value(0).text();character->characterIndex=static_cast<int>(number(1));character->tileId=0;}
      else if(method=="moveStraight")move(*character,static_cast<int>(number(0)));
      else if(method=="moveForward")move(*character,character->direction);
      else if(method=="moveBackward") {const bool fixed=character->directionFix;character->directionFix=true;move(*character,10-character->direction);character->directionFix=fixed;}
      else if(method=="turn180"){if(!character->directionFix)character->direction=10-character->direction;character->stopCount=0;}
      else if(method=="locate") {
        if(character==&player_)locatePlayer(number(0),number(1));
        else locateCharacter(*character,number(0),number(1));
      }
      else if(method=="setPosition") {
        character->realX=number(0);character->realY=number(1);
        character->x=Value(std::floor(character->realX+0.5)).integer();
        character->y=Value(std::floor(character->realY+0.5)).integer();
      }
      else throw std::invalid_argument("unsupported native character script call: "+method);
      continue;
    }
    if(name=="$gameVariables.setValue")operateVariable(static_cast<int>(number(0)),0,value(1));
    else if(name=="$gameSwitches.setValue") { const int switchId=static_cast<int>(number(0)); if(switchId>0) { switches_[switchId]=value(1).boolean();refreshNeeded_=true; } }
    else if(name=="$gameTemp.reserveCommonEvent")reservedCommonEvent_=static_cast<int>(number(0));
    else if(name=="$gameParty.gainGold"||name=="$gameParty.loseGold")gold_=static_cast<int>(std::clamp(gold_+(name.ends_with("loseGold")?-1:1)*number(0),0.0,99999999.0));
    else if(name=="$gameTimer.start") {timerFrames_=static_cast<int>(number(0));timerWorking_=true;}
    else if(name=="$gameTimer.stop")timerWorking_=false;
    else if(name=="this.wait")context.wait=static_cast<int>(number(0));
    else if(name=="this.setWaitMode") {
      const auto mode=value(0).text();
      if(mode=="scroll")context.waitingScroll=true;else if(mode=="gather")context.waitingGather=true;
      else if(mode=="action")context.waitingAction=true;else if(!mode.empty())throw std::invalid_argument("unsupported native script wait: "+mode);
    }
    else if(name=="$gameScreen.startFadeOut") {fadeOut_=static_cast<int>(number(0));}
    else if(name=="$gameScreen.showPicture") {
      Value::Array p{static_cast<int>(number(0)),value(1),static_cast<int>(number(2)),0,value(3),value(4),value(5),value(6),value(7),value(8)};
      screenEventCommand({231, 0, p},context);
    }
    else if(name=="$gameScreen.erasePicture")screenEventCommand({235, 0, Value::Array{value(0)}},context);
    else if(name=="SceneManager.goto"||name=="SceneManager.push") {
      if(args.empty())throw std::invalid_argument("missing native scene");
      const bool push = name == "SceneManager.push";
      if(args[0]=="Scene_Title")openTitle();
      else if(args[0]=="Scene_Gameover")openGameOver();
      else {
        Scene target = Scene::map;
        if(args[0]=="Scene_Map")target=Scene::map;
        else if(args[0]=="Scene_Menu")target=Scene::menu;
        else if(args[0]=="Scene_Item")target=Scene::item;
        else if(args[0]=="Scene_Skill")target=Scene::skill;
        else if(args[0]=="Scene_Equip")target=Scene::equip;
        else if(args[0]=="Scene_Status")target=Scene::status;
        else if(args[0]=="Scene_Options")target=Scene::options;
        else if(args[0]=="Scene_Save")target=Scene::save;
        else if(args[0]=="Scene_Load")target=Scene::load;
        else if(args[0]=="Scene_GameEnd")target=Scene::menu;
        else if(args[0]=="Scene_Name")target=Scene::name;
        else if(args[0]=="Scene_Shop")target=Scene::shop;
        else if(args[0]=="Scene_Debug")target=Scene::debug;
        else throw std::invalid_argument("unsupported native script scene: "+args[0]);
        if(push)SceneManager::pushScene(*this,target);else SceneManager::gotoScene(*this,target);
      }
    }
    else if(name=="SceneManager.pop")SceneManager::popScene(*this);
    else if(name=="SceneManager.exit")SceneManager::exit(*this);
    else evaluateExpression(statement);
  }
}
}
