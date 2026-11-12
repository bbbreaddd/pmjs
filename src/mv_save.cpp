#include "mv_engine.hpp"
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
Value character(const Character& value, const char* type) {
  Value result = instance(type, {{"_x", value.x}, {"_y", value.y}, {"_realX", value.realX}, {"_realY", value.realY},
    {"_moveSpeed", value.moveSpeed}, {"_moveFrequency", 6}, {"_opacity", value.opacity}, {"_blendMode", value.blendMode}, {"_direction", value.direction},
    {"_pattern", value.pattern}, {"_priorityType", 1}, {"_tileId", value.tileId}, {"_characterName", value.characterName},
    {"_characterIndex", value.characterIndex}, {"_isObjectCharacter", value.characterName.find('!') < 2}, {"_walkAnime", value.walkAnime},
    {"_stepAnime", value.stepAnime}, {"_directionFix", value.directionFix}, {"_through", value.through}, {"_transparent", value.transparent},
    {"_bushDepth", value.bushDepth}, {"_animationId", 0}, {"_balloonId", 0}, {"_animationPlaying", false}, {"_balloonPlaying", false},
    {"_animationCount", value.animationCount}, {"_stopCount", value.stopCount}, {"_jumpCount", 0}, {"_jumpPeak", 0}, {"_movementSuccess", true},
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
    {"_waitMode", context.waitingRoute ? "route" : ""}, {"_character", reference},
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
    if (target["@"].text() == "Game_Player") result.waitingRoute = -1;
    else if (target["@"].text() == "Game_Event") result.waitingRoute = target["_eventId"].integer();
    else throw std::invalid_argument("unsupported saved movement-route target");
  } else if (!value["_waitMode"].text().empty()) throw std::invalid_argument("unsupported saved interpreter wait");
  return result;
}
Character readCharacter(const Value& value) {
  Character result;
  result.x = value["_x"].integer(); result.y = value["_y"].integer(); result.realX = value["_realX"].number(result.x); result.realY = value["_realY"].number(result.y);
  result.direction = value["_direction"].integer(2); result.pattern = value["_pattern"].integer(1); result.moveSpeed = value["_moveSpeed"].integer(4);
  result.tileId = value["_tileId"].integer(); result.characterName = value["_characterName"].text(); result.characterIndex = value["_characterIndex"].integer();
  result.through = value["_through"].boolean(); result.transparent = value["_transparent"].boolean(); result.walkAnime = value["_walkAnime"].boolean(); result.stepAnime = value["_stepAnime"].boolean(); result.directionFix = value["_directionFix"].boolean();
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
    const auto& source = database_["actors"][id];
    Array equips; for (std::size_t slot = 0; slot < actor.equips.size(); ++slot) equips.emplace_back(item(actor.equips[slot], slot == 0 ? "weapon" : "armor"));
    actors[id] = instance("Game_Actor", {{"_actorId", id}, {"_name", source["name"]}, {"_nickname", source["nickname"]}, {"_profile", source["profile"]}, {"_classId", source["classId"]}, {"_level", actor.level},
      {"_characterName", source["characterName"]}, {"_characterIndex", source["characterIndex"]}, {"_faceName", source["faceName"]}, {"_faceIndex", source["faceIndex"]}, {"_battlerName", source["battlerName"]},
      {"_hp", actor.hp}, {"_mp", actor.mp}, {"_tp", actor.tp}, {"_hidden", actor.hidden}, {"_paramPlus", numbers(actor.paramPlus)}, {"_states", numbers(actor.states)}, {"_stateTurns", entries(actor.stateTurns)},
      {"_buffs", numbers(actor.buffs)}, {"_buffTurns", numbers(actor.buffTurns)}, {"_skills", numbers(actor.skills)}, {"_equips", equips}, {"_exp", Object{{std::to_string(source["classId"].integer()), 0}}},
      {"_actions", Array{}}, {"_speed", 0}, {"_result", instance("Game_ActionResult", {{"used", false}, {"missed", false}, {"evaded", false}, {"physical", false}, {"drain", false}, {"critical", false}, {"success", false}, {"hpAffected", false}, {"hpDamage", 0}, {"mpDamage", 0}, {"tpDamage", 0}, {"addedStates", Array{}}, {"removedStates", Array{}}, {"addedBuffs", Array{}}, {"addedDebuffs", Array{}}, {"removedBuffs", Array{}}})},
      {"_actionState", ""}, {"_lastTargetIndex", 0}, {"_animations", Array{}}, {"_damagePopup", false}, {"_effectType", Value{}}, {"_motionType", Value{}}, {"_weaponImageId", 0}, {"_motionRefresh", false}, {"_selected", false},
      {"_actionInputIndex", 0}, {"_lastMenuSkill", item()}, {"_lastBattleSkill", item()}, {"_lastCommandSymbol", ""}});
  }
  Value player = character(player_, "Game_Player");
  auto& p = object(player);
  p["_vehicleType"] = "walk"; p["_vehicleGettingOn"] = false; p["_vehicleGettingOff"] = false; p["_dashing"] = playerDashing_; p["_needsMapReload"] = false; p["_transferring"] = false;
  p["_newMapId"] = 0; p["_newX"] = 0; p["_newY"] = 0; p["_newDirection"] = 0; p["_fadeType"] = 0; p["_encounterCount"] = encounterCount_;
  Array followers;
  for (int i = 1; i < 4; ++i) { auto follower = character(followers_[i - 1], "Game_Follower"); auto& f = object(follower); f["_memberIndex"] = i; f["_through"] = true; followers.emplace_back(follower); }
  p["_followers"] = instance("Game_Followers", {{"_visible", database_["system"]["optFollowers"]}, {"_gathering", false}, {"_data", followers}});
  Array events(database_["maps"][std::to_string(mapId_)]["events"].array().size());
  for (const auto& event : events_) {
    auto value = character(event.character, "Game_Event"); auto& e = object(value);
    e["_mapId"] = mapId_; e["_eventId"] = event.id; e["_moveType"] = 0; e["_trigger"] = event.trigger; e["_starting"] = event.starting; e["_erased"] = event.erased; e["_pageIndex"] = event.page;
    e["_originalPattern"] = event.originalPattern; e["_originalDirection"] = event.originalDirection; e["_prelockDirection"] = event.prelockDirection; e["_locked"] = event.prelockDirection != 0; e["_priorityType"] = event.priority; e["_interpreter"] = event.trigger == 4 ? writeInterpreter(event.parallel) : Value{};
    events[event.id] = value;
  }
  const auto interpreter = writeInterpreter(interpreter_);
  Array vehicles;
  for (const auto* type : {"boat", "ship", "airship"}) { auto value = character(Character{}, "Game_Vehicle"); auto& v = object(value); const auto& source = database_["system"][type]; v["_type"] = type; v["_mapId"] = source["startMapId"]; v["_x"] = source["startX"]; v["_y"] = source["startY"]; v["_realX"] = source["startX"]; v["_realY"] = source["startY"]; v["_altitude"] = 0; v["_driving"] = false; v["_bgm"] = source["bgm"]; v["_characterName"] = source["characterName"]; v["_characterIndex"] = source["characterIndex"]; vehicles.emplace_back(value); }
  const double displayX = std::clamp(player_.realX - 8.0, 0.0, std::max(0.0, map()["width"].number() - 17));
  const double displayY = std::clamp(player_.realY - 6.0, 0.0, std::max(0.0, map()["height"].number() - 13));
  return Object{
    {"system", instance("Game_System", {{"_saveEnabled", system_.saveEnabled}, {"_menuEnabled", system_.menuEnabled}, {"_encounterEnabled", system_.encounterEnabled}, {"_formationEnabled", system_.formationEnabled}, {"_battleCount", system_.battleCount}, {"_winCount", system_.winCount}, {"_escapeCount", system_.escapeCount}, {"_saveCount", system_.saveCount}, {"_versionId", database_["system"]["versionId"]}, {"_framesOnSave", static_cast<double>(ticks_)}, {"_bgmOnSave", savedBgm_.null() ? map()["bgm"] : savedBgm_}, {"_bgsOnSave", savedBgs_.null() ? map()["bgs"] : savedBgs_}, {"_windowTone", Value{}}, {"_battleBgm", Value{}}, {"_victoryMe", Value{}}, {"_defeatMe", Value{}}, {"_savedBgm", Value{}}, {"_walkingBgm", Value{}}})},
    {"screen", instance("Game_Screen", {{"_brightness", brightness_}, {"_fadeOutDuration", fadeOut_}, {"_fadeInDuration", 0}, {"_tone", Array{0,0,0,0}}, {"_toneTarget", Array{0,0,0,0}}, {"_toneDuration", 0}, {"_flashColor", Array{0,0,0,0}}, {"_flashDuration", 0}, {"_shakePower", 0}, {"_shakeSpeed", 0}, {"_shakeDuration", 0}, {"_shakeDirection", 1}, {"_shake", 0}, {"_zoomX", 0}, {"_zoomY", 0}, {"_zoomScale", 1}, {"_zoomScaleTarget", 1}, {"_zoomDuration", 0}, {"_weatherType", "none"}, {"_weatherPower", 0}, {"_weatherPowerTarget", 0}, {"_weatherDuration", 0}, {"_pictures", pictures_}})},
    {"timer", instance("Game_Timer", {{"_frames", 0}, {"_working", false}})}, {"switches", instance("Game_Switches", {{"_data", switches}})}, {"variables", instance("Game_Variables", {{"_data", variables}})}, {"selfSwitches", instance("Game_SelfSwitches", {{"_data", selfSwitches}})}, {"actors", instance("Game_Actors", {{"_data", actors}})},
    {"party", instance("Game_Party", {{"_inBattle", false}, {"_gold", gold_}, {"_steps", steps_}, {"_lastItem", item()}, {"_menuActorId", party_.empty() ? 0 : party_[0]}, {"_targetActorId", 0}, {"_actors", numbers(party_)}, {"_items", items}, {"_weapons", weapons}, {"_armors", armors}})},
    {"map", instance("Game_Map", {{"_interpreter", interpreter}, {"_mapId", mapId_}, {"_tilesetId", map()["tilesetId"]}, {"_events", events}, {"_commonEvents", Array{}}, {"_vehicles", vehicles}, {"_displayX", displayX}, {"_displayY", displayY}, {"_nameDisplay", true}, {"_scrollDirection", 2}, {"_scrollRest", 0}, {"_scrollSpeed", 4}, {"_parallaxName", map()["parallaxName"]}, {"_parallaxZero", false}, {"_parallaxLoopX", false}, {"_parallaxLoopY", false}, {"_parallaxSx", 0}, {"_parallaxSy", 0}, {"_parallaxX", displayX}, {"_parallaxY", displayY}, {"_battleback1Name", map()["specifyBattleback"].boolean() ? map()["battleback1Name"] : Value{}}, {"_battleback2Name", map()["specifyBattleback"].boolean() ? map()["battleback2Name"] : Value{}}, {"_needsRefresh", false}})}, {"player", player}};
}

void Session::load(const Value& contents) {
  for (const auto* name : {"system", "screen", "timer", "switches", "variables", "selfSwitches", "actors", "party", "map", "player"}) if (contents[name].null()) throw std::invalid_argument(std::string("save is missing ") + name);
  if (contents["party"]["_inBattle"].boolean() || contents["player"]["_vehicleType"].text() != "walk") throw std::invalid_argument("unsupported saved battle or vehicle");
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
    actor.level = value["_level"].integer(); actor.hp = value["_hp"].integer(); actor.mp = value["_mp"].integer(); actor.tp = value["_tp"].integer(); actor.hidden = value["_hidden"].boolean();
    actor.skills.clear(); for (const auto& skill : value["_skills"].array()) actor.skills.insert(skill.integer());
    actor.states.clear(); for (const auto& state : value["_states"].array()) actor.states.push_back(state.integer());
    actor.equips.clear(); for (const auto& equip : value["_equips"].array()) actor.equips.push_back(equip["_itemId"].integer());
    if (const auto* values = std::get_if<Object>(&value["_stateTurns"].data)) for (const auto& [key, turns] : *values) actor.stateTurns[std::stoi(key)] = turns.integer();
    for (int i = 0; i < 8; ++i) { actor.paramPlus[i] = value["_paramPlus"][i].integer(); actor.buffs[i] = value["_buffs"][i].integer(); actor.buffTurns[i] = value["_buffTurns"][i].integer(); }
  }
  restored.transfer(mapId, contents["player"]["_x"].integer(), contents["player"]["_y"].integer(), contents["player"]["_direction"].integer());
  restored.pictures_ = contents["screen"]["_pictures"].array();
  restored.ambience_ = contents["player"]["_ambienceData"];
  restored.savedCamera_ = std::array{contents["map"]["_displayX"].number(), contents["map"]["_displayY"].number()};
  restored.player_ = readCharacter(contents["player"]); restored.playerDashing_ = contents["player"]["_dashing"].boolean(); restored.encounterCount_ = contents["player"]["_encounterCount"].integer();
  for (int i = 0; i < 3; ++i) restored.followers_[i] = readCharacter(contents["player"]["_followers"]["_data"][i]);
  for (auto& event : restored.events_) {
    const auto& saved = contents["map"]["_events"][event.id]; if (saved.null()) throw std::invalid_argument("save is missing a map event");
    event.character = readCharacter(saved); event.page = saved["_pageIndex"].integer(); event.trigger = saved["_trigger"].integer(); event.priority = saved["_priorityType"].integer(1); event.erased = saved["_erased"].boolean(); event.starting = saved["_starting"].boolean(); event.originalDirection = saved["_originalDirection"].integer(); event.originalPattern = saved["_originalPattern"].integer(); event.prelockDirection = saved["_prelockDirection"].integer();
    if (!saved["_interpreter"].null()) event.parallel = readInterpreter(saved["_interpreter"]);
  }
  restored.interpreter_ = readInterpreter(contents["map"]["_interpreter"]);
  const auto& system = contents["system"];
  restored.system_ = {system["_saveEnabled"].boolean(), system["_menuEnabled"].boolean(), system["_encounterEnabled"].boolean(), system["_formationEnabled"].boolean(), system["_battleCount"].integer(), system["_winCount"].integer(), system["_escapeCount"].integer(), system["_saveCount"].integer()};
  restored.gold_ = contents["party"]["_gold"].integer(); restored.steps_ = contents["party"]["_steps"].integer(); restored.ticks_ = contents["system"]["_framesOnSave"].number(); restored.brightness_ = contents["screen"]["_brightness"].integer(255); restored.fadeOut_ = contents["screen"]["_fadeOutDuration"].integer();
  restored.refreshNeeded_ = true;
  restored.saveMetadata_ = saveMetadata_;
  restored.savedBgm_ = contents["system"]["_bgmOnSave"]; restored.savedBgs_ = contents["system"]["_bgsOnSave"];
  if (!restored.savedBgm_.null()) restored.audio("bgm", restored.savedBgm_, true);
  if (!restored.savedBgs_.null()) restored.audio("bgs", restored.savedBgs_, true);
  restored.lastTitleCommand_ = lastTitleCommand_;
  restored.loadRequested_ = loadRequested_; restored.saveRequested_ = saveRequested_;
  restored.alwaysDash_ = alwaysDash_; restored.commandRemember_ = commandRemember_; restored.volumes_ = volumes_; restored.configurationRevision_ = configurationRevision_;
  restored.randomGenerator_ = randomGenerator_; restored.randomStream_ = randomStream_; restored.randomOffset_ = randomOffset_; restored.randomCalls_ = randomCalls_;
  *this = std::move(restored);
}
}
