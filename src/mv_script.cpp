#include "mv_engine.hpp"
#include "mv_managers.hpp"
#include <algorithm>
#include <cctype>
#include <cmath>
#include <regex>
#include <stdexcept>

namespace pmjs::mv {
void Session::dispatchGameDataMutation(const std::string& kind, const std::string& method, const Value::Array& arguments) {
  if (!runtimeHooks_ || !runtimeHooks_->gameDataMutation || !runtimeHooks_->gameDataMutation(kind, method, arguments))
    invokeGameDataBase(kind, method, arguments);
}
Value Session::invokeGameDataBase(const std::string& kind, const std::string& method, const Value::Array& arguments) {
  if (kind == "screen") return invokeScreenBase(method, arguments);
  if (kind == "map" && method == "invalidateTileShadows") { if (!arguments.empty()) runtimeTileShadows_ = arguments[0].boolean(); ++presentationRevision_; return Value::undefined(); }
  if (kind == "map" && method == "cameraNormal") {
    if (!arguments.empty()) {
      if (arguments[0].boolean()) { cameraTarget_.reset(); savedCamera_.reset(); centerPlayer(); }
      else if (!cameraTarget_) setCameraTarget(runtimeCharacter(-1), 800);
    }
    return !cameraTarget_;
  }
  if (kind == "system") {
    if (method == "initialize") { system_ = {}; return Value::undefined(); }
    bool* flag = nullptr; int* count = nullptr;
    if (method == "saveEnabled") flag = &system_.saveEnabled;
    else if (method == "menuEnabled") flag = &system_.menuEnabled;
    else if (method == "encounterEnabled") flag = &system_.encounterEnabled;
    else if (method == "formationEnabled") flag = &system_.formationEnabled;
    else if (method == "battleCount") count = &system_.battleCount;
    else if (method == "winCount") count = &system_.winCount;
    else if (method == "escapeCount") count = &system_.escapeCount;
    else if (method == "saveCount") count = &system_.saveCount;
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
  if (kind == "party") {
    if (method == "initialize") { inventory_.clear(); party_.clear(); gold_ = 0; steps_ = 0; return Value::undefined(); }
    if (method == "members") { Value::Array ids; for (int id : partyMembers()) ids.emplace_back(id); return ids; }
    if (method == "gold") return gold_;
    if (method == "inBattle") return battle_.active;
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
  if (method == "clear") { if (kind == "variables") variables_.clear(); else switches_.clear(); return Value::undefined(); }
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
