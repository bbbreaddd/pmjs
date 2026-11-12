#include "mv_engine.hpp"
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace pmjs::mv {
void Session::configure(const Value& configuration) {
  auto volumes = volumes_;
  const std::array<const char*, 4> keys{"bgmVolume", "bgsVolume", "meVolume", "seVolume"};
  for (int i = 0; i < 4; ++i) if (!configuration[keys[i]].null()) {
    volumes[i] = configuration[keys[i]].integer();
    if (volumes[i] < 0 || volumes[i] > 100) throw std::invalid_argument("volume must be between zero and one hundred");
  }
  volumes_ = volumes;
  if (!configuration["alwaysDash"].null()) alwaysDash_ = configuration["alwaysDash"].boolean();
  if (!configuration["commandRemember"].null()) commandRemember_ = configuration["commandRemember"].boolean();
  ++configurationRevision_;
}
Value Session::configuration() const { return Value::Object{{"alwaysDash", alwaysDash_}, {"commandRemember", commandRemember_}, {"bgmVolume", volumes_[0]}, {"bgsVolume", volumes_[1]}, {"meVolume", volumes_[2]}, {"seVolume", volumes_[3]}}; }
void Session::audio(const std::string& kind, const Value& sound, bool restart) {
  if (kind == "bgm") savedBgm_ = sound;
  if (kind == "bgs") savedBgs_ = sound;
  audioCommands_.emplace_back(Value::Object{{"kind", kind}, {"sound", sound}, {"restart", restart}});
}
void Session::openTitle() {
  ui_ = {}; ui_.scene = Scene::title; finished_ = false;
  const bool saved = std::any_of(saveMetadata_.begin(), saveMetadata_.end(), [&](const Value& value) { return value["title"].text() == database_["system"]["gameTitle"].text(); });
  ui_.cursor = lastTitleCommand_ >= 0 ? lastTitleCommand_ : saved ? 1 : 0;
  audio("bgm", database_["system"]["titleBgm"]); audio("bgs", Value::Object{{"name", ""}});
  audio("me", Value::Object{{"name", ""}});
}
void Session::openGameOver() {
  ui_ = {}; ui_.scene = Scene::gameOver;
  audio("bgm", Value::Object{{"name", ""}}); audio("bgs", Value::Object{{"name", ""}});
  audio("me", database_["system"]["gameoverMe"]);
}
void Session::updatePlayerGraphic() {
  if (party_.empty()) { player_.characterName.clear(); return; }
  const auto& source = database_["actors"][party_.front()];
  player_.characterName = source["characterName"].text(); player_.characterIndex = source["characterIndex"].integer();
}
void Session::completeStorage(bool success) {
  const bool loading = loadRequested_;
  saveRequested_ = false; loadRequested_ = false;
  audio("se", database_["system"]["sounds"][success ? loading ? 6 : 5 : 3]);
  if (success) { ui_ = {}; ui_.scene = loading ? Scene::map : Scene::menu; }
}
void Session::advanceEncounter() {
  if (map()["encounterList"].array().empty() || party_.empty() || !system_.encounterEnabled) return;
  const int width = map()["width"].integer(), height = map()["height"].integer();
  const int region = map()["data"][(5 * height + player_.y) * width + player_.x].integer();
  int total = 0;
  for (const auto& entry : map()["encounterList"].array()) {
    const auto& regions = entry["regionSet"].array();
    if (regions.empty() || std::any_of(regions.begin(), regions.end(), [&](const Value& value) { return value.integer() == region; })) total += entry["weight"].integer();
  }
  encounterCount_ -= tileFlag(player_.x, player_.y, 64) ? 2 : 1;
  if (encounterCount_ > 0 || total <= 0) return;
  int selected = randomInt(total);
  for (const auto& entry : map()["encounterList"].array()) {
    const auto& regions = entry["regionSet"].array();
    if (!regions.empty() && std::none_of(regions.begin(), regions.end(), [&](const Value& value) { return value.integer() == region; })) continue;
    selected -= entry["weight"].integer();
    if (selected < 0) { startBattle(entry["troopId"].integer(), true, false); return; }
  }
}
void Session::updateUi(const Input&, bool ok, bool cancel, int direction) {
  auto sound = [&](int id) { audio("se", database_["system"]["sounds"][id]); };
  auto cursor = [&](int count) {
    if (count <= 0) { ui_.cursor = 0; return; }
    if (direction == 2 || direction == 6) { ui_.cursor = (ui_.cursor + 1) % count; sound(0); }
    if (direction == 8 || direction == 4) { ui_.cursor = (ui_.cursor + count - 1) % count; sound(0); }
  };
  auto enter = [&](Scene scene) { ui_ = {}; ui_.scene = scene; sound(1); };
  if (message_.busy) {
    ++messageAge_;
    std::size_t length = 0;
    for (int line = message_.firstLine; line < message_.pageEnd(); ++line) length += message_.lines[line].text().size();
    if (message_.pauseIndex < message_.pauses.size()) {
      const int stop = message_.pauses[message_.pauseIndex] + 8;
      messageAge_ = std::min(messageAge_, stop);
      if (messageAge_ < stop) { if (ok) messageAge_ = stop; return; }
      if (ok || cancel) ++message_.pauseIndex;
      return;
    }
    if (ok && messageAge_ < static_cast<int>(length) + 8) { messageAge_ = static_cast<int>(length) + 8; return; }
    if (messageAge_ < static_cast<int>(length) + 8) return;
    if (message_.choices.empty() || message_.pageEnd() < static_cast<int>(message_.lines.size())) { if (ok || cancel) acknowledge(); }
    else {
      cursor(static_cast<int>(message_.choices.size()));
      if (ok) { acknowledge(ui_.cursor); sound(1); ui_.cursor = 0; }
      else if (cancel && message_.cancelChoice != -1) { acknowledge(-2); sound(2); ui_.cursor = 0; }
    }
    return;
  }
  if (ui_.scene == Scene::title) {
    if (ui_.age < 32) return;
    cursor(3);
    if (!ok) return;
    const int selected = ui_.cursor;
    lastTitleCommand_ = selected;
    if (selected == 0) { sound(1); newGame(); }
    else if (selected == 1) {
      if (std::none_of(saveMetadata_.begin(), saveMetadata_.end(), [&](const Value& value) { return value["title"].text() == database_["system"]["gameTitle"].text(); })) sound(3);
      else enter(Scene::load);
    }
    else { enter(Scene::options); ui_.slot = 1; }
    return;
  }
  if (ui_.scene == Scene::gameOver) { if (ok || cancel) openTitle(); return; }
  if (ui_.scene == Scene::map) {
    if (cancel && system_.menuEnabled && !interpreter_.running && !player_.moving()) {
      if (mapSceneOnly()) {
        message_ = {}; message_.busy = true; messageAge_ = 0;
        message_.lines = database_["sceneContract"]["menuNotice"].array();
        if (message_.lines.empty()) throw std::runtime_error("menus are outside the map-scene contract");
      } else enter(Scene::menu);
    }
    return;
  }
  if (ui_.scene == Scene::save || ui_.scene == Scene::load) {
    cursor(20);
    if (cancel) { if (ui_.scene == Scene::load) openTitle(); else enter(Scene::menu); }
    else if (ok) { saveRequested_ = ui_.scene == Scene::save; loadRequested_ = ui_.scene == Scene::load; }
    return;
  }
  if (ui_.scene == Scene::options) {
    if (direction == 2 || direction == 8) cursor(6);
    if (ok || direction == 4 || direction == 6) {
      if (ui_.cursor < 2) {
        auto& value = ui_.cursor == 0 ? alwaysDash_ : commandRemember_;
        value = ok ? !value : direction == 6;
      } else {
        auto& volume = volumes_[ui_.cursor - 2];
        volume = ok ? (volume + 20 > 100 ? 0 : volume + 20) : std::clamp(volume + (direction == 6 ? 20 : -20), 0, 100);
      }
      ++configurationRevision_; sound(1);
    }
    if (cancel) { const bool title = ui_.slot == 1; if (title) openTitle(); else enter(Scene::menu); }
    return;
  }
  if (ui_.scene == Scene::menu) {
    if (ui_.category == 2) {
      cursor(static_cast<int>(party_.size()));
      if (cancel) { ui_.cursor = ui_.pendingId; ui_.category = 0; sound(2); }
      else if (ok && !party_.empty()) {
        const int actor = ui_.cursor, command = ui_.pendingId;
        enter(command == 1 ? Scene::skill : command == 2 ? Scene::equip : Scene::status); ui_.actor = actor;
      }
      return;
    }
    if (ui_.category == 1) {
      cursor(2); if (cancel || (ok && ui_.cursor == 1)) { ui_.category = 0; ui_.cursor = 7; }
      else if (ok) openTitle();
      return;
    }
    cursor(8);
    if (cancel) { enter(Scene::map); return; }
    if (!ok) return;
    const int selected = ui_.cursor;
    if (selected >= 1 && selected <= 3) { ui_.pendingId = selected; ui_.category = 2; ui_.cursor = 0; sound(1); return; }
    if ((selected == 4 && !system_.formationEnabled) || (selected == 6 && !system_.saveEnabled)) { sound(3); return; }
    const std::array<Scene, 7> scenes{Scene::item, Scene::skill, Scene::equip, Scene::status, Scene::formation, Scene::options, Scene::save};
    if (selected < 7) enter(scenes[selected]); else { ui_.category = 1; ui_.cursor = 0; }
    return;
  }
  if (ui_.scene == Scene::status) {
    if (direction == 4 || direction == 6) ui_.actor = (ui_.actor + static_cast<int>(party_.size()) + (direction == 6 ? 1 : -1)) % std::max(1, static_cast<int>(party_.size()));
    if (cancel || ok) enter(Scene::menu);
    return;
  }
  if (ui_.scene == Scene::formation) {
    cursor(static_cast<int>(party_.size()));
    if (cancel) { if (ui_.target >= 0) ui_.target = -1; else enter(Scene::menu); }
    else if (ok) {
      if (ui_.target < 0) ui_.target = ui_.cursor;
      else { std::swap(party_[ui_.target], party_[ui_.cursor]); ui_.target = -1; updatePlayerGraphic(); }
    }
    return;
  }
  const bool inBattle = ui_.scene == Scene::battle;
  if (inBattle && (battle_.opening || battle_.wait || !battle_.active)) return;
  if (inBattle && ui_.category == 4) {
    cursor(2);
    if (!ok) return;
    if (ui_.cursor == 0) { ui_.category = 0; ui_.cursor = 0; ui_.actor = battle_.actorIndex; sound(1); }
    else if (!battle_.canEscape) sound(3);
    else {
      sound(7);
      if (random() < battle_.escapeRatio) finishBattle(1);
      else {
        battle_.escapeRatio += 0.1;
        battle_.actions.erase(std::remove_if(battle_.actions.begin(), battle_.actions.end(), [](const Action& action) { return !action.enemy; }), battle_.actions.end());
        battle_.actorIndex = static_cast<int>(party_.size());
        battle_.log.clear();
        message_ = {}; message_.busy = true; messageAge_ = 0;
        message_.lines = {battleMessage("escapeStart", {partyName()}), battleMessage("escapeFailure")};
        beginTurn();
      }
    }
    return;
  }
  if (inBattle && ui_.category == 0) {
    if (battle_.actorIndex >= static_cast<int>(party_.size())) return;
    if (cancel) {
      int previous = battle_.actorIndex - 1;
      while (previous >= 0 && (actors_.at(party_[previous]).hp <= 0 || restriction(actors_.at(party_[previous])) > 0)) --previous;
      if (previous < 0) { ui_.category = 4; ui_.cursor = 0; }
      else { battle_.actorIndex = previous; ui_.actor = previous; ui_.cursor = 0; }
      sound(2); return;
    }
    const auto types = battleSkillTypes(battle_.actorIndex);
    const int guard = static_cast<int>(types.size()) + 1;
    cursor(guard + 2);
    if (!ok) return;
    ui_.actor = battle_.actorIndex;
    if (ui_.cursor == 0 || ui_.cursor == guard) {
      const int skillId = ui_.cursor == 0 ? 1 : 2;
      if (!canUse(actors_.at(party_[battle_.actorIndex]), database_["skills"][skillId])) { sound(3); return; }
      sound(1);
      if (skillId == 2) { chooseAction(battle_.actorIndex, 2, battle_.actorIndex); ui_.cursor = 0; }
      else { ui_.pendingId = 1; ui_.targeting = true; ui_.category = 3; ui_.cursor = 0; ui_.itemAction = false; ui_.target = 0; }
    } else {
      sound(1); ui_.commandCursor = ui_.cursor;
      if (ui_.cursor < guard) { ui_.skillType = types[ui_.cursor - 1]; ui_.category = 1; }
      else ui_.category = 2;
      ui_.cursor = 0;
    }
    return;
  }
  if (ui_.scene == Scene::equip) {
    if (party_.empty()) return;
    auto& value = actors_.at(party_[ui_.actor]);
    if (ui_.category == 0) {
      cursor(3);
      if (cancel) enter(Scene::menu);
      else if (ok && ui_.cursor == 0) { ui_.category = 1; ui_.cursor = 0; }
      else if (ok && ui_.cursor == 2) { for (std::size_t i = 0; i < value.equips.size(); ++i) changeEquipment(value.id, static_cast<int>(i), 0); }
      else if (ok) {
        for (std::size_t i = 0; i < value.equips.size(); ++i) {
          const auto& entries = database_[i == 0 ? "weapons" : "armors"].array(); int best = value.equips[i]; double score = -1000000;
          for (const auto& candidate : entries) if (canEquip(value, candidate, static_cast<int>(i))) {
            const int id = candidate["id"].integer(); if (id != value.equips[i] && inventory_[id + (i == 0 ? 100000 : 200000)] <= 0) continue;
            double sum = 0; for (const auto& parameterValue : candidate["params"].array()) sum += parameterValue.number();
            if (sum > score) { score = sum; best = id; }
          }
          if (best != value.equips[i]) changeEquipment(value.id, static_cast<int>(i), best);
        }
      }
    } else if (ui_.category == 1) {
      cursor(static_cast<int>(value.equips.size()));
      if (cancel) { ui_.category = 0; ui_.cursor = 0; }
      else if (ok) { ui_.slot = ui_.cursor; ui_.category = 2; ui_.cursor = 0; }
    } else {
      std::vector<int> choices{0}; const auto& entries = database_[ui_.slot == 0 ? "weapons" : "armors"].array();
      for (const auto& entry : entries) if (canEquip(value, entry, ui_.slot) && inventory_[entry["id"].integer() + (ui_.slot == 0 ? 100000 : 200000)] > 0) choices.push_back(entry["id"].integer());
      cursor(static_cast<int>(choices.size()));
      if (cancel) { ui_.category = 1; ui_.cursor = ui_.slot; }
      else if (ok) { changeEquipment(value.id, ui_.slot, choices[ui_.cursor]); ui_.category = 1; ui_.cursor = ui_.slot; }
    }
    return;
  }
  const bool skill = ui_.scene == Scene::skill || (inBattle && ui_.category == 1);
  const bool itemScene = ui_.scene == Scene::item || (inBattle && ui_.category == 2);
  if (ui_.targeting || (inBattle && ui_.category == 3)) {
    const auto& entry = database_[ui_.itemAction ? "items" : "skills"][ui_.pendingId];
    const auto targets = inBattle ? battleSelectableTargets(entry) : std::vector<int>{};
    cursor(inBattle ? static_cast<int>(targets.size()) : static_cast<int>(party_.size()));
    if (cancel) { ui_.targeting = false; ui_.category = inBattle ? ui_.target : ui_.category; ui_.cursor = inBattle && ui_.target != 0 ? ui_.listCursor : 0; }
    else if (ok) {
      if (inBattle) {
        if (targets.empty()) { sound(3); return; }
        chooseAction(battle_.actorIndex, ui_.pendingId, targets[ui_.cursor], ui_.itemAction);
      }
      else if (!useItem(ui_.pendingId, ui_.cursor, !ui_.itemAction)) { sound(3); return; }
      ui_.targeting = false; if (inBattle) ui_.category = 0; ui_.cursor = 0;
    }
    return;
  }
  if (skill || itemScene) {
    std::vector<int> entries;
    if (skill && !party_.empty()) {
      for (int id : actors_.at(party_[ui_.actor]).skills) if (!inBattle || database_["skills"][id]["stypeId"].integer() == ui_.skillType) entries.push_back(id);
    }
    else for (const auto& [id, count] : inventory_) if (id < 100000 && count > 0 && (!inBattle || database_["items"][id]["occasion"].integer() <= 1)) entries.push_back(id);
    cursor(static_cast<int>(entries.size()));
    if (cancel) { if (inBattle) { ui_.category = 0; ui_.cursor = ui_.commandCursor; } else enter(Scene::menu); }
    else if (ok && !entries.empty()) {
      const auto& entry = database_[skill ? "skills" : "items"][entries[ui_.cursor]];
      const int user = !inBattle && !skill ? menuItemUser() : ui_.actor;
      if (user < 0 || !canUse(actors_.at(party_[user]), entry) || (!inBattle && entry["scope"].integer() <= 6)) { sound(3); return; }
      ui_.target = inBattle ? ui_.category : -1; ui_.listCursor = ui_.cursor;
      ui_.pendingId = entries[ui_.cursor]; ui_.itemAction = !skill;
      const int scope = entry["scope"].integer();
      if (inBattle && scope != 1 && scope != 7 && scope != 9) {
        chooseAction(battle_.actorIndex, ui_.pendingId, scope == 11 ? battle_.actorIndex : -1, ui_.itemAction);
        ui_.category = 0; ui_.cursor = 0;
      } else { ui_.targeting = true; ui_.cursor = 0; if (inBattle) ui_.category = 3; }
    }
  }
}
}  // namespace pmjs::mv
