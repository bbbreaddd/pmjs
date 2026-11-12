#include "mv_engine.hpp"
#include <cmath>
#include <iostream>
#include <stdexcept>

using pmjs::mv::Value;
using pmjs::mv::Session;
using Array = Value::Array;
using Object = Value::Object;

void require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }
Value command(int code, Array parameters = {}, int indent = 0) {
  return Object{{"code", code}, {"parameters", parameters}, {"indent", indent}};
}
Value page(Array commands, int trigger = 0, Value conditions = Object{}) {
  return Object{{"conditions", conditions}, {"image", Object{{"direction", 2}, {"pattern", 1}}}, {"list", commands}, {"trigger", trigger}, {"priorityType", 1}, {"moveSpeed", 3}, {"walkAnime", true}};
}
Value database() {
  Array tiles(5 * 5 * 6, 0);
  return Object{{"system", Object{{"startMapId", 1}, {"startX", 1}, {"startY", 1}, {"partyMembers", Array{1}}}}, {"actors", Array{Value{}, Object{{"characterName", "Actor"}, {"characterIndex", 0}}}}, {"tilesets", Array{Value{}, Object{{"flags", Array{0, 15}}}}}, {"maps", Object{{"1", Object{{"width", 5}, {"height", 5}, {"tilesetId", 1}, {"data", tiles}, {"events", Array{Value{}, Object{{"id", 1}, {"x", 3}, {"y", 1}, {"pages", Array{page({command(121, {1, 1, 0}), command(0)})}}}}}}}}}};
}

int main() {
  try {
    require(pmjs::mv::formula("a.atk * 4 * .8 - b.def * 2", {{"a.atk", 10}, {"b.def", 3}}) == 26, "formula arithmetic");
    require(pmjs::mv::formula("-(2 + 3) * 4 / 2", {}) == -10, "formula precedence");
    bool rejected = false;
    try { pmjs::mv::formula("a.atk; process.exit()", {{"a.atk", 1}}); } catch (const std::invalid_argument&) { rejected = true; }
    require(rejected, "formula must reject executable text");
    auto data = database();
    Session game(data); game.newGame();
    game.step({6});
    require(game.player().x == 2 && game.player().realX == 1.0625, "movement interpolation");
    for (int i = 0; i < 15; ++i) game.step({});
    require(game.player().realX == 2, "movement completes in sixteen updates");
    game.step({6}); require(game.player().x == 2, "normal event collision");
    game.step({0, true}); game.step({});
    require(game.snapshot()["switches"]["1"].boolean(), "action event executes switch command");
    game.newGame(); require(!game.snapshot()["switches"]["1"].boolean(), "new game resets session state");
    require(data["maps"]["1"]["events"][1]["pages"][0]["list"][0]["parameters"][0].integer() == 1, "session retains caller data");
    auto& root = std::get<Object>(data.data);
    auto& maps = std::get<Object>(root["maps"].data);
    auto& map = std::get<Object>(maps["1"].data);
    auto& events = std::get<Array>(map["events"].data);
    auto& event = std::get<Object>(events[1].data);
    event["pages"] = Array{page({command(101), command(401, {"hello"}), command(102, {Array{"yes", "no"}, -2, 0}), command(402, {0}, 0), command(121, {2, 2, 0}, 1), command(402, {1}, 0), command(121, {3, 3, 0}, 1), command(404), command(123, {"A", 0}), command(0)}, 3), page({command(0)}, 0, Object{{"selfSwitchValid", true}, {"selfSwitchCh", "A"}})};
    Session messages(data); messages.newGame(); messages.step({});
    require(messages.message().busy && messages.message().lines.size() == 1, "message pauses interpreter");
    const auto index = messages.snapshot()["interpreter"]["index"].integer();
    messages.step({}); require(messages.snapshot()["interpreter"]["index"].integer() == index, "busy message does not advance");
    require(messages.message().choices.size() == 2, "choices accompany preceding message");
    messages.acknowledge(1); messages.step({});
    require(!messages.snapshot()["switches"]["2"].boolean() && messages.snapshot()["switches"]["3"].boolean(), "choice executes selected branch only");
    require(messages.events()[0].page == 1, "self-switch refresh changes active page");
    auto battleData = database();
    auto& battleRoot = std::get<Object>(battleData.data);
    std::get<Object>(battleRoot["system"].data)["partyMembers"] = Array{1, 2};
    std::get<Object>(battleRoot["system"].data)["skillTypes"] = Array{"", "Magic"};
    battleRoot["actors"] = Array{Value{}, Object{{"classId", 1}, {"initialLevel", 1}}, Object{{"classId", 1}, {"initialLevel", 1}}};
    Array params; for (int i = 0; i < 8; ++i) params.emplace_back(Array{0, 100});
    battleRoot["classes"] = Array{Value{}, Object{{"params", params}, {"traits", Array{Object{{"code", 41}, {"dataId", 1}, {"value", 1}}}}}};
    battleRoot["skills"] = Array{Value{}, Object{{"occasion", 1}, {"scope", 1}}, Object{{"occasion", 1}, {"scope", 11}}};
    battleRoot["enemies"] = Array{Value{}, Object{{"params", Array{100, 0, 1, 1, 1, 1, 1, 1}}, {"actions", Array{}}}};
    battleRoot["troops"] = Array{Value{}, Object{{"members", Array{Object{{"enemyId", 1}}}}}};
    Session battle(battleData); battle.newGame(); battle.startBattle(1, false, false);
    require(!battle.message().busy && battle.battle().encounterEffect == 60, "encounter effect defers the battle opening");
    for (int i = 0; i < 60; ++i) battle.step({});
    require(battle.message().busy, "battle opening waits for enemy introduction");
    battle.acknowledge(); battle.step({});
    auto press = [&](pmjs::mv::Input input) { battle.step(input); battle.step({}); };
    require(battle.ui().category == 4, "battle starts at party commands");
    press({2}); press({0, true});
    require(battle.ui().category == 4 && battle.battle().wait == 0, "disabled escape does not start a turn");
    press({8}); press({0, true});
    require(battle.ui().category == 0 && battle.battle().actorIndex == 0, "fight selects first actor");
    press({2}); press({0, true});
    require(battle.ui().category == 1 && battle.ui().skillType == 1, "skill command carries trait skill type");
    press({0, false, true});
    require(battle.ui().category == 0 && battle.ui().cursor == 1, "skill cancel returns to the selected command");
    press({2}); press({0, true});
    require(battle.battle().actorIndex == 1 && battle.battle().actions.size() == 1, "guard advances to next actor");
    press({0, false, true});
    require(battle.battle().actorIndex == 0 && battle.ui().category == 0, "cancel revisits previous actor");
    press({0, false, true});
    require(battle.ui().category == 4, "cancel from first actor returns to party commands");
    press({0, true}); press({2}); press({2}); press({0, true});
    require(battle.battle().actorIndex == 1 && battle.battle().actions.size() == 1, "revising an actor replaces its earlier action");
    auto& battleSystem = std::get<Object>(battleRoot["system"].data);
    battleSystem["partyMembers"] = Array{1};
    battleSystem["terms"] = Object{{"messages", Object{{"victory", "%1 won!"}, {"obtainItem", "Found %1!"}}}};
    std::get<Object>(std::get<Array>(battleRoot["actors"].data)[1].data)["name"] = "Hero";
    auto& attack = std::get<Object>(std::get<Array>(battleRoot["skills"].data)[1].data);
    attack["successRate"] = 100; attack["hitType"] = 0;
    attack["damage"] = Object{{"type", 1}, {"formula", "100"}, {"variance", 0}};
    std::get<Object>(std::get<Array>(battleRoot["enemies"].data)[1].data)["dropItems"] = Array{Object{{"kind", 1}, {"dataId", 1}, {"denominator", 1}}};
    battleRoot["items"] = Array{Value{}, Object{{"name", "Potion"}}};
    Session victory(battleData); victory.newGame(); victory.startBattle(1, true, false); victory.acknowledge(); victory.step({});
    victory.chooseAction(0, 1, 0);
    for (int tick = 0; tick < 1000 && victory.battle().active; ++tick) victory.step({});
    require(!victory.battle().active && victory.ui().scene == pmjs::mv::Scene::battle, "victory keeps battle visible until messages finish");
    require(victory.message().lines[0].text() == "Hero won!" && victory.message().pageEnd() == 1, "victory text precedes a separate reward page");
    victory.acknowledge(); victory.step({});
    require(victory.message().busy && victory.message().firstLine == 1 && victory.message().lines[1].text() == "Found Potion!", "acknowledgement advances to reward page");
    require(victory.ui().scene == pmjs::mv::Scene::battle, "map cannot resume under reward page");
    victory.acknowledge(); victory.step({});
    require(victory.ui().scene == pmjs::mv::Scene::map && victory.save()["party"]["_items"]["1"].integer() == 1, "final acknowledgement resumes map with rewards");
    Session coreButtons(database()); coreButtons.newGame(); coreButtons.openTitle();
    for (int tick = 0; tick < 40; ++tick) coreButtons.step({});
    pmjs::mv::Input held; held.ok = true; held.okTriggered = false;
    coreButtons.step(held);
    require(coreButtons.ui().scene == pmjs::mv::Scene::title, "held state must not override native core trigger timing");
    held.okTriggered = true; coreButtons.step(held);
    require(coreButtons.ui().scene == pmjs::mv::Scene::map, "native core trigger must reach the scene even while held state stays true");
    std::cout << "native MV simulation checks passed\n";
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
