#include "mv_engine.hpp"
#include "mv_core_utils.hpp"
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace pmjs::mv {
namespace {
using Object = Value::Object;
using Array = Value::Array;
Object instance(const char* type, Object fields = {}) { fields["@"] = type; return fields; }
template<class Range> Array numbers(const Range& values) { Array result; for (auto n : values) result.emplace_back(n); return result; }
template<class Map> Object entries(const Map& values) { Object result; for (const auto& [key, value] : values) result[std::to_string(key)] = value; return result; }
Value item(int id = 0, const char* type = "") { return instance("Game_Item", {{"_dataClass", type}, {"_itemId", id}}); }
Value writeResult(const ActionResult& result) {
  return instance("Game_ActionResult", {{"used", result.used}, {"missed", result.missed}, {"evaded", result.evaded}, {"physical", result.physical},
    {"drain", result.drain}, {"critical", result.critical}, {"success", result.success}, {"hpAffected", result.hpAffected},
    {"hpDamage", result.hpDamage}, {"mpDamage", result.mpDamage}, {"tpDamage", result.tpDamage}, {"addedStates", numbers(result.addedStates)},
    {"removedStates", numbers(result.removedStates)}, {"addedBuffs", numbers(result.addedBuffs)}, {"addedDebuffs", numbers(result.addedDebuffs)}, {"removedBuffs", numbers(result.removedBuffs)}});
}
ActionResult readResult(const Value& value) {
  ActionResult result;
  result.used = value["used"].boolean(); result.missed = value["missed"].boolean(); result.evaded = value["evaded"].boolean();
  result.physical = value["physical"].boolean(); result.drain = value["drain"].boolean(); result.critical = value["critical"].boolean();
  result.success = value["success"].boolean(); result.hpAffected = value["hpAffected"].boolean();
  result.hpDamage = value["hpDamage"].integer(); result.mpDamage = value["mpDamage"].integer(); result.tpDamage = value["tpDamage"].integer();
  for (const auto& entry : value["addedStates"].array()) result.addedStates.push_back(entry.integer());
  for (const auto& entry : value["removedStates"].array()) result.removedStates.push_back(entry.integer());
  for (const auto& entry : value["addedBuffs"].array()) result.addedBuffs.push_back(entry.integer());
  for (const auto& entry : value["addedDebuffs"].array()) result.addedDebuffs.push_back(entry.integer());
  for (const auto& entry : value["removedBuffs"].array()) result.removedBuffs.push_back(entry.integer());
  return result;
}
Value character(const Character& value, const char* type) {
  Value result = instance(type, {{"_x", value.x}, {"_y", value.y}, {"_realX", value.realX}, {"_realY", value.realY},
    {"_moveSpeed", value.moveSpeed}, {"_moveFrequency", value.moveFrequency}, {"_opacity", value.opacity}, {"_blendMode", value.blendMode}, {"_direction", value.direction},
    {"_pattern", value.pattern}, {"_priorityType", 1}, {"_tileId", value.tileId}, {"_characterName", value.characterName},
    {"_characterIndex", value.characterIndex}, {"_isObjectCharacter", value.characterName.find('!') < 2}, {"_walkAnime", value.walkAnime},
    {"_stepAnime", value.stepAnime}, {"_directionFix", value.directionFix}, {"_through", value.through}, {"_transparent", value.transparent},
    {"_bushDepth", value.bushDepth}, {"_animationId", 0}, {"_balloonId", 0}, {"_animationPlaying", false}, {"_balloonPlaying", false},
    {"_animationCount", value.animationCount}, {"_stopCount", value.stopCount}, {"_jumpCount", value.jumpCount}, {"_jumpPeak", value.jumpPeak}, {"_movementSuccess", value.movementSuccess},
    {"_moveRouteForcing", value.routeForcing}, {"_moveRouteIndex", value.routeIndex}, {"_waitCount", value.routeWait},
    {"_moveRoute", value.route.empty() ? Value{} : Value(Object{{"list", value.route}, {"repeat", value.routeRepeat}, {"skippable", value.routeSkippable}, {"wait", true}})},
    {"_originalMoveRoute", value.originalRoute}, {"_originalMoveRouteIndex", value.originalRouteIndex}});  auto& fields = std::get<Object>(result.data);
  if (value.singleFrame) fields["_singleFrame"] = true;
  if (value.spriteOffsetX || value.spriteOffsetY) { fields["_spriteOffsetX"] = value.spriteOffsetX; fields["_spriteOffsetY"] = value.spriteOffsetY; }
  if (value.customFrameX >= 0) fields["_customFrameX"] = value.customFrameX;
  if (value.customFrameY >= 0) fields["_customFrameY"] = value.customFrameY;
  if (value.customFrameWidth >= 0) fields["_customFrameWidth"] = value.customFrameWidth;
  if (value.customFrameHeight >= 0) fields["_customFrameHeight"] = value.customFrameHeight;
  return result;
}
Object& object(Value& value) { return std::get<Object>(value.data); }
Value writeInterpreter(const Interpreter& context, int depth = 0) {
  const int target = context.waitingRoute && *context.waitingRoute == 0 ? context.eventId : context.waitingRoute.value_or(-1);
  const Value reference = context.waitingRoute ? Value(Object{{"@r", target < 0 ? "/player" : "/map/_events/" + std::to_string(target)}}) : Value{};
  return instance("Game_Interpreter", {{"_depth", depth}, {"_mapId", context.mapId}, {"_eventId", context.eventId},
    {"_list", context.running ? Value(context.list) : Value{}}, {"_index", context.index}, {"_waitCount", context.wait},
    {"_waitMode", context.waitingRoute ? "route" : context.waitingScroll ? "scroll" : context.waitingGather ? "gather" : context.waitingVideo ? "video" : context.waitingEffect ? "animation" : context.waitingAction ? "action" : context.waitingMessage ? "message" : ""}, {"_character", reference},
    {"_childInterpreter", context.children.empty() ? Value{} : writeInterpreter(context.children.front(), depth + 1)},
    {"_comments", ""}, {"_branch", entries(context.branches)}, {"_params", Array{}}, {"_indent", 0}, {"_frameCount", 0}, {"_freezeChecker", 0}});
}
Interpreter readInterpreter(const Value& value, int depth = 0) {
  if (depth >= 100) throw std::invalid_argument("saved interpreter nesting limit exceeded");
  Interpreter result;
  result.depth = depth;
  result.mapId = value["_mapId"].integer(); result.eventId = value["_eventId"].integer();
  result.list = value["_list"].array(); result.running = !value["_list"].null();
  result.index = value["_index"].integer(); result.wait = value["_waitCount"].integer();
  if (result.index < 0 || (result.running && result.index > static_cast<int>(result.list.size()) + 1) || result.wait < 0)
    throw std::invalid_argument("invalid saved interpreter position");
  if (const auto* values = std::get_if<Object>(&value["_branch"].data)) for (const auto& [key, branch] : *values)
    if (!branch.null()) result.branches[std::stoi(key)] = std::holds_alternative<bool>(branch.data) ? int(branch.boolean()) : branch.integer();
  if (!value["_childInterpreter"].null()) result.children.push_back(readInterpreter(value["_childInterpreter"], depth + 1));
  if (value["_waitMode"].text() == "route") {
    const auto& target = value["_character"];
    if (target["@r"].text() == "/player") result.waitingRoute = -1;
    else if (target["@r"].text().starts_with("/map/_events/")) result.waitingRoute = std::stoi(target["@r"].text().substr(13));
    else if (target["@"].text() == "Game_Player") result.waitingRoute = -1;
    else if (target["@"].text() == "Game_Event") result.waitingRoute = target["_eventId"].integer();
    else throw std::invalid_argument("unsupported saved movement-route target");
  } else if (value["_waitMode"].text() == "scroll") result.waitingScroll = true;
  else if (value["_waitMode"].text() == "gather") result.waitingGather = true;
  else if (value["_waitMode"].text() == "action") result.waitingAction = true;
  else if (value["_waitMode"].text() == "message") result.waitingMessage = true;
  else if (value["_waitMode"].text() == "transfer" || value["_waitMode"].text() == "animation" || value["_waitMode"].text() == "balloon" || value["_waitMode"].text() == "video" || value["_waitMode"].text() == "image") {}
  else if (!value["_waitMode"].text().empty()) throw std::invalid_argument("unsupported saved interpreter wait");
  return result;
}
Character readCharacter(const Value& value) {
  Character result;
  result.x = value["_x"].integer(); result.y = value["_y"].integer(); result.realX = value["_realX"].number(result.x); result.realY = value["_realY"].number(result.y);
  result.direction = value["_direction"].integer(2); result.pattern = value["_pattern"].integer(1); result.moveSpeed = value["_moveSpeed"].integer(4);
  result.moveFrequency = value["_moveFrequency"].integer(6);
  result.jumpCount = value["_jumpCount"].integer(); result.jumpPeak = value["_jumpPeak"].integer();
  result.movementSuccess = value["_movementSuccess"].null() || value["_movementSuccess"].boolean();
  result.tileId = value["_tileId"].integer(); result.characterName = value["_characterName"].text(); result.characterIndex = value["_characterIndex"].integer();
  result.through = value["_through"].boolean(); result.transparent = value["_transparent"].boolean(); result.walkAnime = value["_walkAnime"].null() || value["_walkAnime"].boolean(); result.stepAnime = value["_stepAnime"].boolean(); result.directionFix = value["_directionFix"].boolean();
  result.bushDepth = value["_bushDepth"].integer();
  result.opacity = value["_opacity"].integer(255); result.blendMode = value["_blendMode"].integer();
  result.singleFrame = value["_singleFrame"].boolean();
  result.spriteOffsetX = value["_spriteOffsetX"].number(); result.spriteOffsetY = value["_spriteOffsetY"].number();
  result.customFrameX = value["_customFrameX"].integer(-1); result.customFrameY = value["_customFrameY"].integer(-1);
  result.customFrameWidth = value["_customFrameWidth"].integer(-1); result.customFrameHeight = value["_customFrameHeight"].integer(-1);
  result.animationCount = value["_animationCount"].number(); result.stopCount = value["_stopCount"].integer(); result.routeForcing = value["_moveRouteForcing"].boolean();
  result.originalRoute = value["_originalMoveRoute"]; result.originalRouteIndex = value["_originalMoveRouteIndex"].integer();
  result.route = value["_moveRoute"]["list"].array(); result.routeRepeat = value["_moveRoute"]["repeat"].boolean(); result.routeSkippable = value["_moveRoute"]["skippable"].boolean(); result.routeIndex = value["_moveRouteIndex"].integer(); result.routeWait = value["_waitCount"].integer();
  return result;
}
}

Value Session::save() {
  if (mapSceneOnly()) throw std::runtime_error("map-scene session cannot export a gameplay save");
  if (ui_.scene == Scene::battle || message_.busy || pendingTransfer_) throw std::runtime_error("cannot save during a battle, message or transfer");
  ++system_.saveCount;
  Array switches, variables;
  for (const auto& [id, value] : switches_) { if (switches.size() <= static_cast<std::size_t>(id)) switches.resize(id + 1); switches[id] = value; }
  for (const auto& [id, value] : variables_) { if (variables.size() <= static_cast<std::size_t>(id)) variables.resize(id + 1); variables[id] = value; }
  Object selfSwitches; for (const auto& [key, value] : selfSwitches_) if (value) selfSwitches[key] = value;
  Object items, weapons, armors;
  for (const auto& [key, count] : inventory_) if (count > 0) (key >= 200000 ? armors : key >= 100000 ? weapons : items)[std::to_string(key % 100000)] = count;
  Array actors(database_["actors"].array().size());
  for (const auto& [id, actor] : actors_) {
    Array equips; for (std::size_t slot = 0; slot < actor.equips.size(); ++slot) equips.emplace_back(item(actor.equips[slot], actor.equipKinds[slot] == 1 ? "weapon" : "armor"));
    actors[id] = instance("Game_Actor", {{"_actorId", id}, {"_name", actor.name}, {"_nickname", actor.nickname}, {"_profile", actor.profile}, {"_classId", actor.classId}, {"_level", actor.level},
      {"_characterName", actor.characterName}, {"_characterIndex", actor.characterIndex}, {"_faceName", actor.faceName}, {"_faceIndex", actor.faceIndex}, {"_battlerName", actor.battlerName},
      {"_hp", actor.hp}, {"_mp", actor.mp}, {"_tp", actor.tp}, {"_hidden", actor.hidden}, {"_paramPlus", numbers(actor.paramPlus)}, {"_states", numbers(actor.states)}, {"_stateTurns", entries(actor.stateTurns)}, {"_stateSteps", entries(actor.stateSteps)},
      {"_buffs", numbers(actor.buffs)}, {"_buffTurns", numbers(actor.buffTurns)}, {"_skills", numbers(actor.skills)}, {"_equips", equips}, {"_exp", entries(actor.exp)},
      {"_actions", Array{}}, {"_speed", 0}, {"_result", writeResult(actor.result)},
      {"_actionState", ""}, {"_lastTargetIndex", actor.lastTargetIndex}, {"_animations", Array{}}, {"_damagePopup", false}, {"_effectType", Value{}}, {"_motionType", Value{}}, {"_weaponImageId", 0}, {"_motionRefresh", false}, {"_selected", false},
      {"_actionInputIndex", 0}, {"_lastMenuSkill", item(actor.lastMenuSkill,"skill")}, {"_lastBattleSkill", item(actor.lastBattleSkill,"skill")}, {"_lastCommandSymbol", actor.lastCommandSymbol}});
  }
  Value player = character(player_, "Game_Player");
  auto& p = object(player);
  p["_vehicleType"] = vehicleType_ < 0 ? "walk" : vehicleType_ == 0 ? "boat" : vehicleType_ == 1 ? "ship" : "airship"; p["_vehicleGettingOn"] = vehicleGettingOn_; p["_vehicleGettingOff"] = vehicleGettingOff_; p["_dashing"] = playerDashing_; p["_needsMapReload"] = false; p["_transferring"] = false;
  p["_newMapId"] = 0; p["_newX"] = 0; p["_newY"] = 0; p["_newDirection"] = 0; p["_fadeType"] = 0; p["_encounterCount"] = encounterCount_;
  Array followers;
  for (int i = 1; i < 4; ++i) { auto follower = character(followers_[i - 1], "Game_Follower"); auto& f = object(follower); f["_memberIndex"] = i; f["_through"] = true; followers.emplace_back(follower); }
  p["_followers"] = instance("Game_Followers", {{"_visible", followersVisible_}, {"_gathering", followersGathering_}, {"_data", followers}});
  Array events(database_["maps"][std::to_string(mapId_)]["events"].array().size());
  for (const auto& event : events_) {
    auto value = character(event.character, "Game_Event"); auto& e = object(value);
    e["_mapId"] = mapId_; e["_eventId"] = event.id; e["_moveType"] = event.moveType; e["_trigger"] = event.trigger; e["_starting"] = event.starting; e["_erased"] = event.erased; e["_pageIndex"] = event.page;
    e["_originalPattern"] = event.originalPattern; e["_originalDirection"] = event.originalDirection; e["_prelockDirection"] = event.prelockDirection; e["_locked"] = event.prelockDirection != 0; e["_priorityType"] = event.priority; e["_interpreter"] = event.trigger == 4 ? writeInterpreter(event.parallel) : Value{};
    events[event.id] = value;
  }
  Array commonEvents;
  for (const auto& event : database_["commonEvents"].array()) {
    if (event.null() || event["trigger"].integer() != 2) continue;
    const int id = event["id"].integer();
    const auto context = commonInterpreters_.find(id);
    commonEvents.emplace_back(instance("Game_CommonEvent", {{"_commonEventId", id},
      {"_interpreter", context == commonInterpreters_.end() ? Value{} : writeInterpreter(*context->second)}}));
  }
  const auto interpreter = writeInterpreter(interpreter_);
  Array vehicles;
  for (const auto& vehicle : vehicles_) {
    auto value = character(vehicle.character, "Game_Vehicle"); auto& v = object(value);
    v["_type"] = vehicle.type == 0 ? "boat" : vehicle.type == 1 ? "ship" : "airship";
    v["_mapId"] = vehicle.mapId; v["_altitude"] = vehicle.altitude; v["_driving"] = vehicle.driving;
    v["_priorityType"] = vehicle.type == 2 ? vehicle.altitude > 0 ? 2 : 0 : 1;
    v["_bgm"] = system_.vehicleBgm[vehicle.type].null() ? vehicle.bgm : system_.vehicleBgm[vehicle.type];
    vehicles.push_back(std::move(value));
  }
  const double displayX = mapState_.lastDisplayX;
  const double displayY = mapState_.lastDisplayY;
  return Object{
    {"system", instance("Game_System", {{"_walkingBgm", vehicleWalkingBgm_}, {"_saveEnabled", system_.saveEnabled}, {"_menuEnabled", system_.menuEnabled}, {"_encounterEnabled", system_.encounterEnabled}, {"_formationEnabled", system_.formationEnabled}, {"_battleCount", system_.battleCount}, {"_winCount", system_.winCount}, {"_escapeCount", system_.escapeCount}, {"_saveCount", system_.saveCount}, {"_versionId", database_["system"]["versionId"]}, {"_framesOnSave", static_cast<double>(ticks_)}, {"_bgmOnSave", AudioManager::saveBgm(*this)}, {"_bgsOnSave", AudioManager::saveBgs(*this)}, {"_windowTone", system_.windowTone}, {"_battleBgm", system_.battleBgm}, {"_victoryMe", system_.victoryMe}, {"_defeatMe", system_.defeatMe}, {"_savedBgm", system_.storedBgm}})},
    {"screen", screenState()},
    {"timer", instance("Game_Timer", {{"_frames", timerFrames_}, {"_working", timerWorking_}})}, {"switches", instance("Game_Switches", {{"_data", switches}})}, {"variables", instance("Game_Variables", {{"_data", variables}})}, {"selfSwitches", instance("Game_SelfSwitches", {{"_data", selfSwitches}})}, {"actors", instance("Game_Actors", {{"_data", actors}})},
    {"party", instance("Game_Party", {{"_inBattle", false}, {"_gold", gold_}, {"_steps", steps_}, {"_lastItem", item(lastItemId_,"item")}, {"_menuActorId", menuActorId_ ? menuActorId_ : party_.empty() ? 0 : party_[0]}, {"_targetActorId", targetActorId_}, {"_actors", numbers(party_)}, {"_items", items}, {"_weapons", weapons}, {"_armors", armors}})},
    {"map", instance("Game_Map", {{"_interpreter", interpreter}, {"_mapId", mapId_}, {"_tilesetId", mapState_.tilesetId}, {"_events", events}, {"_commonEvents", commonEvents}, {"_vehicles", vehicles}, {"_displayX", displayX}, {"_displayY", displayY}, {"_nameDisplay", mapState_.nameDisplay}, {"_scrollDirection", mapState_.scrollDirection}, {"_scrollRest", mapState_.scrollRest}, {"_scrollSpeed", mapState_.scrollSpeed}, {"_parallaxName", mapState_.parallaxName}, {"_parallaxZero", mapState_.parallaxZero}, {"_parallaxLoopX", mapState_.parallaxLoopX}, {"_parallaxLoopY", mapState_.parallaxLoopY}, {"_parallaxSx", mapState_.parallaxSx}, {"_parallaxSy", mapState_.parallaxSy}, {"_parallaxX", mapState_.parallaxX}, {"_parallaxY", mapState_.parallaxY}, {"_battleback1Name", mapState_.battleback1Name}, {"_battleback2Name", mapState_.battleback2Name}, {"_needsRefresh", false}})}, {"player", player}};
}

void Session::load(const Value& contents) {
  for (const auto* name : {"system", "screen", "timer", "switches", "variables", "selfSwitches", "actors", "party", "map", "player"}) if (contents[name].null()) throw std::invalid_argument(std::string("save is missing ") + name);
  if (contents["party"]["_inBattle"].boolean()) throw std::invalid_argument("unsupported saved battle");
  const int mapId = contents["map"]["_mapId"].integer();
  if (mapSceneOnly() && database_["sceneContract"]["mapId"].integer() != mapId)
    throw std::invalid_argument("save is outside the declared map-scene scope");
  if (database_["maps"][std::to_string(mapId)].null()) throw std::invalid_argument("save refers to an unknown map");
  Session restored(database_);
  restored.switches_.clear(); restored.variables_.clear(); restored.selfSwitches_.clear(); restored.inventory_.clear(); restored.party_.clear(); restored.actors_.clear();
  const auto& switches = contents["switches"]["_data"].array();
  for (std::size_t i = 0; i < switches.size(); ++i) if (!switches[i].null()) restored.switches_[i] = switches[i].boolean();
  const auto& variables = contents["variables"]["_data"].array();
  for (std::size_t i = 0; i < variables.size(); ++i) if (!variables[i].null()) restored.variables_[i] = variables[i];
  if (const auto* values = std::get_if<Object>(&contents["selfSwitches"]["_data"].data)) for (const auto& [key, value] : *values) restored.selfSwitches_[key] = value.boolean();
  for (const auto& member : contents["party"]["_actors"].array()) { const int id = member.integer(); restored.initializeActor(id); restored.party_.push_back(id); }
  for (const auto* category : {"_items", "_weapons", "_armors"}) {
    const int offset = std::string(category) == "_weapons" ? 100000 : std::string(category) == "_armors" ? 200000 : 0;
    if (const auto* values = std::get_if<Object>(&contents["party"][category].data)) for (const auto& [key, value] : *values) restored.inventory_[std::stoi(key) + offset] = value.integer();
  }
  for (const auto& value : contents["actors"]["_data"].array()) if (!value.null()) {
    const int id = value["_actorId"].integer(); restored.initializeActor(id); auto& actor = restored.actors_.at(id);
    actor.lastMenuSkill = value["_lastMenuSkill"]["_itemId"].integer(); actor.lastBattleSkill = value["_lastBattleSkill"]["_itemId"].integer(); actor.lastCommandSymbol = value["_lastCommandSymbol"].text();
    actor.classId = value["_classId"].integer(); actor.exp.clear();
    if (const auto* values = std::get_if<Object>(&value["_exp"].data)) for (const auto& [key, exp] : *values) actor.exp[std::stoi(key)] = exp.number();
    actor.name = value["_name"].text(); actor.nickname = value["_nickname"].text(); actor.profile = value["_profile"].text();
    actor.characterName = value["_characterName"].text(); actor.characterIndex = value["_characterIndex"].integer();
    actor.faceName = value["_faceName"].text(); actor.faceIndex = value["_faceIndex"].integer(); actor.battlerName = value["_battlerName"].text();
    actor.level = value["_level"].integer(); actor.hp = value["_hp"].integer(); actor.mp = value["_mp"].integer(); actor.tp = value["_tp"].integer(); actor.hidden = value["_hidden"].boolean();
    actor.result = readResult(value["_result"]); actor.lastTargetIndex = value["_lastTargetIndex"].integer();
    actor.skills.clear(); for (const auto& skill : value["_skills"].array()) actor.skills.insert(skill.integer());
    actor.states.clear(); for (const auto& state : value["_states"].array()) actor.states.push_back(state.integer());
    actor.equips.clear(); actor.equipKinds.clear(); for (const auto& equip : value["_equips"].array()) { actor.equips.push_back(equip["_itemId"].integer()); actor.equipKinds.push_back(equip["_dataClass"].text() == "weapon" ? 1 : 2); }
    if (const auto* values = std::get_if<Object>(&value["_stateTurns"].data)) for (const auto& [key, turns] : *values) actor.stateTurns[std::stoi(key)] = turns.integer();
    actor.stateSteps.clear(); if (const auto* values = std::get_if<Object>(&value["_stateSteps"].data)) for (const auto& [key, steps] : *values) actor.stateSteps[std::stoi(key)] = steps.integer();
    for (int i = 0; i < 8; ++i) { actor.paramPlus[i] = value["_paramPlus"][i].integer(); actor.buffs[i] = value["_buffs"][i].integer(); actor.buffTurns[i] = value["_buffTurns"][i].integer(); }
  }
  const bool mapUpdated = !contents["system"]["_versionId"].null() && !database_["system"]["versionId"].null() &&
    contents["system"]["_versionId"].integer() != database_["system"]["versionId"].integer();
  restored.transfer(mapId, contents["player"]["_x"].integer(), contents["player"]["_y"].integer(), contents["player"]["_direction"].integer());
  restored.audioCommands_.clear();
  restored.pictures_ = contents["screen"]["_pictures"].array();
  restored.screenEffects_ = contents["screen"];
  std::get<Object>(restored.screenEffects_.data).erase("_pictures");
  restored.ambience_ = contents["player"]["_ambienceData"];
  const auto& savedMap = contents["map"];
  if (!mapUpdated) {
    restored.savedCamera_ = std::array{savedMap["_displayX"].number(), savedMap["_displayY"].number()};
    restored.mapState_.tilesetId = savedMap["_tilesetId"].integer();
    restored.mapState_.scrollDirection = savedMap["_scrollDirection"].integer(2); restored.mapState_.scrollSpeed = savedMap["_scrollSpeed"].integer(4); restored.mapState_.scrollRest = savedMap["_scrollRest"].number();
    restored.mapState_.nameDisplay = savedMap["_nameDisplay"].boolean();
    restored.mapState_.battleback1Name = savedMap["_battleback1Name"]; restored.mapState_.battleback2Name = savedMap["_battleback2Name"];
    restored.mapState_.parallaxName = savedMap["_parallaxName"].text(); restored.mapState_.parallaxZero = savedMap["_parallaxZero"].boolean();
    restored.mapState_.parallaxLoopX = savedMap["_parallaxLoopX"].boolean(); restored.mapState_.parallaxLoopY = savedMap["_parallaxLoopY"].boolean();
    restored.mapState_.parallaxSx = savedMap["_parallaxSx"].number(); restored.mapState_.parallaxSy = savedMap["_parallaxSy"].number();
    restored.mapState_.parallaxX = savedMap["_parallaxX"].number(); restored.mapState_.parallaxY = savedMap["_parallaxY"].number();
    restored.mapState_.lastDisplayX = savedMap["_displayX"].number(); restored.mapState_.lastDisplayY = savedMap["_displayY"].number();
  }
  restored.followersVisible_ = contents["player"]["_followers"]["_visible"].boolean();
  restored.followersGathering_ = contents["player"]["_followers"]["_gathering"].boolean();
  const auto vehicleType = contents["player"]["_vehicleType"].text();
  if (vehicleType != "walk" && vehicleType != "boat" && vehicleType != "ship" && vehicleType != "airship") throw std::invalid_argument("unknown saved vehicle type");
  restored.vehicleType_ = vehicleType == "boat" ? 0 : vehicleType == "ship" ? 1 : vehicleType == "airship" ? 2 : -1;
  restored.vehicleGettingOn_ = contents["player"]["_vehicleGettingOn"].boolean(); restored.vehicleGettingOff_ = contents["player"]["_vehicleGettingOff"].boolean();
  restored.vehicleWalkingBgm_ = contents["system"]["_walkingBgm"]; restored.vehicleWalkSpeed_ = 4;
  for (int index = 0; index < 3; ++index) {
    const auto& savedVehicle = contents["map"]["_vehicles"][index];
    auto& vehicle = restored.vehicles_[index]; vehicle.type = index;
    vehicle.mapId = savedVehicle["_mapId"].integer(); vehicle.character = readCharacter(savedVehicle);
    vehicle.altitude = savedVehicle["_altitude"].integer(); vehicle.driving = savedVehicle["_driving"].boolean(); vehicle.bgm = savedVehicle["_bgm"];
  }
  restored.player_ = readCharacter(contents["player"]); restored.playerDashing_ = contents["player"]["_dashing"].boolean(); restored.encounterCount_ = contents["player"]["_encounterCount"].number();
  for (int i = 0; i < 3; ++i) restored.followers_[i] = readCharacter(contents["player"]["_followers"]["_data"][i]);
  if (!mapUpdated) {
    for (auto& event : restored.events_) {
      const auto& saved = contents["map"]["_events"][event.id]; if (saved.null()) continue;
      event.character = readCharacter(saved); event.page = saved["_pageIndex"].integer(); event.moveType = saved["_moveType"].integer(); event.trigger = saved["_trigger"].integer(); event.priority = saved["_priorityType"].integer(1); event.erased = saved["_erased"].boolean(); event.starting = saved["_starting"].boolean(); event.originalDirection = saved["_originalDirection"].integer(); event.originalPattern = saved["_originalPattern"].integer(); event.prelockDirection = saved["_prelockDirection"].integer();
      if (!saved["_interpreter"].null()) event.parallel = readInterpreter(saved["_interpreter"]);
    }
    restored.interpreter_ = readInterpreter(contents["map"]["_interpreter"]);
  }
  restored.commonInterpreters_.clear();
  for (const auto& common : contents["map"]["_commonEvents"].array()) {
    const int id = common["_commonEventId"].integer();
    if (!common["_interpreter"].null() && restored.database_["commonEvents"][id]["trigger"].integer() == 2)
      restored.commonInterpreters_[id] = std::make_shared<Interpreter>(readInterpreter(common["_interpreter"]));
  }
  const auto& system = contents["system"];
  restored.system_.saveEnabled = system["_saveEnabled"].boolean(); restored.system_.menuEnabled = system["_menuEnabled"].boolean();
  restored.system_.encounterEnabled = system["_encounterEnabled"].boolean(); restored.system_.formationEnabled = system["_formationEnabled"].boolean();
  restored.system_.battleCount = system["_battleCount"].integer(); restored.system_.winCount = system["_winCount"].integer();
  restored.system_.escapeCount = system["_escapeCount"].integer(); restored.system_.saveCount = system["_saveCount"].integer();
  restored.system_.battleBgm = system["_battleBgm"]; restored.system_.victoryMe = system["_victoryMe"]; restored.system_.defeatMe = system["_defeatMe"]; restored.system_.windowTone = system["_windowTone"];
  for (int vehicle = 0; vehicle < 3; ++vehicle) restored.system_.vehicleBgm[vehicle] = contents["map"]["_vehicles"][vehicle]["_bgm"];
  restored.lastItemId_ = contents["party"]["_lastItem"]["_itemId"].integer(); restored.menuActorId_ = contents["party"]["_menuActorId"].integer();
  restored.targetActorId_ = contents["party"]["_targetActorId"].integer();
  restored.gold_ = contents["party"]["_gold"].integer(); restored.steps_ = contents["party"]["_steps"].integer(); restored.ticks_ = contents["system"]["_framesOnSave"].number(); restored.brightness_ = contents["screen"]["_brightness"].number(255); restored.fadeOut_ = contents["screen"]["_fadeOutDuration"].integer();
  restored.refreshNeeded_ = true;
  restored.saveMetadata_ = saveMetadata_;
  restored.timerFrames_ = contents["timer"]["_frames"].integer();
  restored.timerWorking_ = contents["timer"]["_working"].boolean();
  restored.system_.storedBgm = contents["system"]["_savedBgm"];
  const Value bgmOnSave = contents["system"]["_bgmOnSave"], bgsOnSave = contents["system"]["_bgsOnSave"];
  restored.savedBgm_ = {}; restored.savedBgs_ = {};
  if (!bgmOnSave.null()) {
    if (bgmOnSave["name"].text().empty()) AudioManager::stopBgm(restored);
    else restored.audio("bgm", bgmOnSave, true);
  }
  if (!bgsOnSave.null()) {
    if (bgsOnSave["name"].text().empty()) AudioManager::stopBgs(restored);
    else restored.audio("bgs", bgsOnSave, true);
  }
  restored.lastTitleCommand_ = lastTitleCommand_;
  restored.newGamePending_ = false; restored.titleWindowOpenness_ = 255;
  restored.loadRequested_ = loadRequested_; restored.saveRequested_ = saveRequested_;
  restored.alwaysDash_ = alwaysDash_; restored.commandRemember_ = commandRemember_; restored.volumes_ = volumes_; restored.configurationRevision_ = configurationRevision_;
  restored.randomGenerator_ = randomGenerator_; restored.randomStream_ = randomStream_; restored.randomOffset_ = randomOffset_; restored.randomCalls_ = randomCalls_;
  restored.presentationRevision_ = presentationRevision_ + 1;
  restored.enemyBitmapHeightResolver_ = enemyBitmapHeightResolver_;
  *this = std::move(restored);
}
}
