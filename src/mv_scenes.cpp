#include "mv_engine.hpp"
#include "mv_core_utils.hpp"
#include "mv_managers.hpp"
#include "mv_windows.hpp"
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
  SceneManager::clearStack(*this);
  SceneManager::gotoScene(*this, Scene::title);
  finished_ = false;
  const bool saved = DataManager::isAnySavefileExists(*this);
  ui_.cursor = lastTitleCommand_ >= 0 ? lastTitleCommand_ : saved ? 1 : 0;
  AudioManager::playBgm(*this, database_["system"]["titleBgm"]);
  AudioManager::stopBgs(*this);
  AudioManager::stopMe(*this);
}
void Session::openGameOver() {
  SceneManager::gotoScene(*this, Scene::gameOver);
  AudioManager::stopBgm(*this);
  AudioManager::stopBgs(*this);
  AudioManager::playMe(*this, database_["system"]["gameoverMe"]);
}
void Session::updatePlayerGraphic() {
  if (party_.empty()) { player_.characterName.clear(); return; }
  const auto& source = actors_.at(party_.front());
  player_.characterName = source.characterName; player_.characterIndex = source.characterIndex;
}
void Session::completeStorage(bool success) {
  const bool loading = loadRequested_;
  saveRequested_ = false; loadRequested_ = false;
  if (!success) SoundManager::playBuzzer(*this);
  else if (loading) SoundManager::playLoad(*this);
  else SoundManager::playSave(*this);
  if (success) {
    lastAccessedSavefileId_ = ui_.cursor + 1;
    if (loading) { SceneManager::clearStack(*this); SceneManager::gotoScene(*this,Scene::map); }
    else if (SceneManager::hasPrevious(*this)) SceneManager::popScene(*this);
    else SceneManager::gotoScene(*this,Scene::menu);
  }
}
void Session::advanceEncounter() {
  if (party_.empty() || !system_.encounterEnabled || vehicleType_ == 2 || player_.routeForcing) return;
  const auto partyAbility = [&](int id) {
    for (std::size_t index = 0; index < party_.size() && index < 4; ++index) {
      const auto& actor = actors_.at(party_[index]);
      for (const auto* object : traitObjects(actor)) for (const auto& effect : (*object)["traits"].array())
        if (effect["code"].integer() == 64 && effect["dataId"].integer() == id) return true;
    }
    return false;
  };
  if (partyAbility(1)) return;
  double progress = tileFlag(player_.x, player_.y, 64) ? 2 : 1;
  if (partyAbility(0)) progress *= 0.5;
  if (vehicleType_ == 1) progress *= 0.5;
  encounterCount_ -= progress;
  if (encounterCount_ > 0) return;
  encounterCount_ = randomInt(map()["encounterStep"].integer(30)) + randomInt(map()["encounterStep"].integer(30)) + 1;
  const int troop = makeEncounterTroopId();
  if (!database_["troops"][troop].null()) startBattle(troop, true, false);
}
void Session::advanceEncounterEffect() {
  ensureScreenEffects();
  auto& state = std::get<Value::Object>(screenEffects_.data);
  const int speed = 60, duration = --battle_.encounterEffect, n = speed - duration;
  const double p = static_cast<double>(n) / speed;
  const double q = ((p - 1) * 20 * p + 5) * p + 1;
  const double screenTilesX = database_["sceneContract"]["width"].number(816) / 48.0;
  const double screenTilesY = database_["sceneContract"]["height"].number(624) / 48.0;
  const double width = map()["width"].number(), height = map()["height"].number();
  const double cameraX = savedCamera_ ? (*savedCamera_)[0] : width < screenTilesX ? (width - screenTilesX) / 2 : std::clamp(player_.realX - (screenTilesX - 1) / 2, 0.0, width - screenTilesX);
  const double cameraY = savedCamera_ ? (*savedCamera_)[1] : height < screenTilesY ? (height - screenTilesY) / 2 : std::clamp(player_.realY - (screenTilesY - 1) / 2, 0.0, height - screenTilesY);
  const double jumpHeight = player_.jumpCount > 0 ? (player_.jumpPeak * player_.jumpPeak - std::pow(std::abs(player_.jumpCount - player_.jumpPeak), 2)) / 2.0 : 0;
  const double zoomX = std::floor(deltaMapX(player_.realX, cameraX) * 48 + 24 + 0.5);
  const double zoomY = std::floor((deltaMapY(player_.realY, cameraY) * 48 + 18 - jumpHeight) + 0.5);
  if (n == 2) {
    state["_zoomX"] = zoomX; state["_zoomY"] = zoomY; state["_zoomScale"] = 1.0;
    state["_flashColor"] = Value::Array{255.0, 255.0, 255.0, 255.0}; state["_flashDuration"] = speed / 2;
  }
  state["_zoomX"] = zoomX; state["_zoomY"] = zoomY; state["_zoomScale"] = q;
  if (n == speed / 6) { state["_flashColor"] = Value::Array{255.0, 255.0, 255.0, 255.0}; state["_flashDuration"] = speed / 2; }
  if (n == speed / 2) {
    audio("bgm", system_.battleBgm.null() ? database_["system"]["battleBgm"] : system_.battleBgm);
    fadeOut_ = 24;
  }
}
bool Session::useItemUntargeted(int id, bool skill) {
  const int user = skill ? ui_.actor : menuItemUser(); if (user < 0) return false;
  auto& subject = actors_.at(party_[user]); const auto& item = database_[skill ? "skills" : "items"][id];
  if (!canUse(subject, item) || (!skill && inventory_[id] <= 0)) return false;
  if (skill) { subject.mp -= static_cast<int>(std::floor(item["mpCost"].number() * trait(subject, 23, 4, true))); subject.tp -= item["tpCost"].integer(); }
  else if (item["consumable"].boolean()) --inventory_[id];
  audio("se", database_["system"]["sounds"][skill ? 24 : 23]);
  applyGlobalEffects(item);
  return true;
}
void Session::updateUi(const Input& inputState, bool ok, bool cancel, int direction) {
  const bool debugTriggered = inputState.pressed.contains("debug") && !previousDebug_;
  previousDebug_ = inputState.pressed.contains("debug");
  const bool pageUp = inputState.pressed.contains("pageup") && !previousUiButtons_.contains("pageup");
  const bool pageDown = inputState.pressed.contains("pagedown") && !previousUiButtons_.contains("pagedown");
  previousUiButtons_ = inputState.pressed;
  auto sound = [&](int id) { SoundManager::playSystemSound(*this,id); };
  cancel = cancel || inputState.touchCancelled;
  if ((inputState.touchTriggered || inputState.touchPressed) && inputState.touchX && inputState.touchY) {
    const int x = static_cast<int>(*inputState.touchX), y = static_cast<int>(*inputState.touchY);
    bool hit = false;
    for (auto target = uiHitTargets_.rbegin(); target != uiHitTargets_.rend(); ++target) {
      if (target->scene != ui_.scene || target->category != ui_.category || x < target->x || y < target->y || x >= target->x+target->width || y >= target->y+target->height) continue;
      if (target->action && inputState.touchTriggered) {
        if (target->action == 1) ok = true;
        else if (target->action == 2 || target->action == 3) { ui_.digitIndex = target->index; direction = target->action == 2 ? 8 : 2; }
        else direction = target->action == 4 ? 6 : target->action == 5 ? 4 : target->action == 6 ? 8 : 2;
      } else if (message_.busy && ui_.maxDigits > 0) ui_.digitIndex = target->index;
      else { const bool same = ui_.cursor == target->index; ui_.cursor = target->index; if (!same) sound(0); if (same && inputState.touchTriggered) ok = true; }
      hit = true; break;
    }
    if (!hit && message_.busy && message_.choices.empty() && ui_.maxDigits == 0 && ui_.variableId == 0 && inputState.touchTriggered) ok = true;
  }
  touchHoldFrames_ = inputState.touchPressed ? touchHoldFrames_+1 : 0;
  if (touchHoldFrames_ >= 10 && touchHoldFrames_%6 == 0 && inputState.touchX && inputState.touchY && ui_.category != 0 &&
      (ui_.scene == Scene::item || ui_.scene == Scene::skill || ui_.scene == Scene::shop || ui_.scene == Scene::debug)) {
    int left = 100000, top = 100000, right = 0, bottom = 0;
    for (const auto& target : uiHitTargets_) if (!target.action && target.scene == ui_.scene && target.category == ui_.category) {
      left = std::min(left,target.x); top = std::min(top,target.y); right = std::max(right,target.x+target.width); bottom = std::max(bottom,target.y+target.height);
    }
    if (*inputState.touchX >= left && *inputState.touchX < right) {
      if (*inputState.touchY < top) direction = 8; else if (*inputState.touchY >= bottom) direction = 2;
    }
  }
  auto cursor = [&](int count) {
    if (count <= 0) { ui_.cursor = 0; return; }
    if (direction == 2 || direction == 6) { ui_.cursor = (ui_.cursor + 1) % count; sound(0); }
    if (direction == 8 || direction == 4) { ui_.cursor = (ui_.cursor + count - 1) % count; sound(0); }
  };
  auto enter = [&](Scene scene) { SceneManager::gotoScene(*this, scene); sound(1); };
  auto leaveEventScene = [&] { if (SceneManager::hasPrevious(*this)) SceneManager::popScene(*this); else SceneManager::gotoScene(*this, Scene::map); };
  if (message_.busy) {
    if (message_.scrolling) {
      message_.scrollY += message_.scrollSpeed * (!message_.scrollNoFast && (inputState.ok || inputState.cancel || inputState.touchPressed) ? 3 : 1);
      if (message_.scrollY >= static_cast<double>(message_.lines.size()*36)) { message_ = {}; messageAge_ = 0; }
      return;
    }
    if (updateMessageText(ok,cancel)) return;
    if (ui_.maxDigits > 0) {
      if (direction == 6 || direction == 4) { ui_.digitIndex = (ui_.digitIndex + ui_.maxDigits + (direction == 6 ? 1 : -1)) % ui_.maxDigits; sound(0); }
      if (direction == 8 || direction == 2) {
        const int place = static_cast<int>(std::pow(10, ui_.maxDigits-1-ui_.digitIndex));
        const int digit = ui_.numberInput/place%10;
        ui_.numberInput += ((digit+(direction == 8 ? 1 : 9))%10-digit)*place; sound(0);
      }
      if (ok) { operateVariable(ui_.variableId, 0, ui_.numberInput); ui_.maxDigits = 0; message_.busy = false; message_ = {}; sound(1); }
      return;
    }
    if (ui_.variableId > 0 && ui_.category > 0) {
      std::vector<int> items;
      for (const auto& [itemId, count] : inventory_) {
        if (itemId < 100000 && count > 0) {
          const auto& data = database_["items"][itemId];
          if (!data.null() && data["itypeId"].integer(1) == ui_.category) items.push_back(itemId);
        }
      }
      cursor(static_cast<int>(items.size()));
      if (ok && !items.empty()) {
        operateVariable(ui_.variableId, 0, items[ui_.cursor]);
        ui_.variableId = 0; ui_.category = 0; message_.busy = false; message_ = {}; sound(1);
      } else if (cancel || (ok && items.empty())) {
        operateVariable(ui_.variableId, 0, 0);
        ui_.variableId = 0; ui_.category = 0; message_.busy = false; message_ = {}; sound(2);
      }
      return;
    }
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
      if (!DataManager::isAnySavefileExists(*this)) sound(3);
      else { enter(Scene::load); ui_.cursor = std::max(0, DataManager::latestSavefileId(*this) - 1); }
    }
    else { enter(Scene::options); ui_.slot = 1; }
    return;
  }
  if (ui_.scene == Scene::gameOver) { if (ok || cancel) openTitle(); return; }
  if (ui_.scene == Scene::map) {
    if (debugTriggered && !interpreter_.running) { SceneManager::pushScene(*this,Scene::debug); return; }
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
    if (cancel) { if (SceneManager::hasPrevious(*this)) { SceneManager::popScene(*this); sound(2); } else if (ui_.scene == Scene::load) openTitle(); else enter(Scene::menu); }
    else if (ok) {
      const int slot = ui_.cursor+1;
      if (ui_.scene == Scene::load && (slot >= static_cast<int>(saveMetadata_.size()) || saveMetadata_[slot].null())) sound(3);
      else { saveRequested_ = ui_.scene == Scene::save; loadRequested_ = ui_.scene == Scene::load; }
    }
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
        enter(command == 1 ? Scene::skill : command == 2 ? Scene::equip : Scene::status); ui_.actor = actor; menuActorId_ = party_[actor];
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
    if (selected >= 1 && selected <= 3 && party_.empty()) { sound(3); return; }
    if (selected >= 1 && selected <= 3) {
      ui_.pendingId = selected; ui_.category = 2;
      const auto found = std::find(party_.begin(),party_.end(),menuActorId_); ui_.cursor = found == party_.end() ? 0 : static_cast<int>(found-party_.begin());
      sound(1); return;
    }
    if ((selected == 4 && !system_.formationEnabled) || (selected == 6 && !system_.saveEnabled)) { sound(3); return; }
    const std::array<Scene, 7> scenes{Scene::item, Scene::skill, Scene::equip, Scene::status, Scene::formation, Scene::options, Scene::save};
    if (selected < 7) { enter(scenes[selected]); if (ui_.scene == Scene::save) ui_.cursor = std::max(0, DataManager::lastAccessedSavefileId(*this) - 1); } else { ui_.category = 1; ui_.cursor = 0; }
    return;
  }
  if ((pageUp || pageDown) && !party_.empty() && (ui_.scene == Scene::skill || ui_.scene == Scene::equip)) {
    ui_.actor = (ui_.actor+static_cast<int>(party_.size())+(pageDown ? 1 : -1))%static_cast<int>(party_.size());
    menuActorId_ = party_[ui_.actor]; ui_.category = 0; ui_.cursor = 0; ui_.targeting = false; ui_.listMemoryApplied = false; sound(0); return;
  }
  if (ui_.scene == Scene::status) {
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
  if (inBattle && (battle_.opening || battle_.wait || !battle_.active || battle_.interpreter.running || battle_.forcedExecuting || !battle_.forcedActions.empty())) return;
  if (inBattle && ui_.category == 4) {
    cursor(2);
    if (!ok) return;
    if (ui_.cursor == 0) { ui_.category = 0; ui_.cursor = 0; ui_.actor = battle_.actorIndex; ui_.commandActor = -1; sound(1); }
    else if (!battle_.canEscape) sound(3);
    else {
      SoundManager::playEscape(*this);
      if (battle_.preemptive || random() < battle_.escapeRatio) finishBattle(1);
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
    }
    return;
  }
  if (inBattle && ui_.category == 0) {
    if (battle_.actorIndex >= static_cast<int>(battleMemberCount())) return;
    if (cancel) {
      int previous = battle_.actorIndex - 1;
      while (previous >= 0 && (actors_.at(party_[previous]).hp <= 0 || restriction(actors_.at(party_[previous])) > 0)) --previous;
      if (previous < 0) { ui_.category = 4; ui_.cursor = 0; }
      else { battle_.actorIndex = previous; ui_.actor = previous; ui_.cursor = 0; }
      sound(2); return;
    }
    const auto types = battleSkillTypes(battle_.actorIndex);
    const int guard = static_cast<int>(types.size()) + 1;
    auto& inputActor = actors_.at(party_[battle_.actorIndex]);
    if (ui_.commandActor != inputActor.id) {
      ui_.commandActor = inputActor.id; ui_.cursor = 0;
      if (commandRemember_) {
        if (inputActor.lastCommandSymbol == "guard") ui_.cursor = guard;
        else if (inputActor.lastCommandSymbol == "item") ui_.cursor = guard+1;
        else if (inputActor.lastCommandSymbol == "skill") {
          const int type = database_["skills"][inputActor.lastBattleSkill]["stypeId"].integer();
          const auto found = std::find(types.begin(),types.end(),type); if (found != types.end()) ui_.cursor = static_cast<int>(found-types.begin())+1;
        }
      }
    }
    cursor(guard + 2);
    if (!ok) return;
    ui_.actor = battle_.actorIndex;
    inputActor.lastCommandSymbol = ui_.cursor == 0 ? "attack" : ui_.cursor == guard ? "guard" : ui_.cursor < guard ? "skill" : "item";
    if (ui_.cursor == 0 || ui_.cursor == guard) {
      const int skillId = ui_.cursor == 0 ? 1 : 2;
      if (!canUse(actors_.at(party_[battle_.actorIndex]), database_["skills"][skillId])) { sound(3); return; }
      sound(1);
      if (skillId == 2) { chooseAction(battle_.actorIndex, 2, battle_.actorIndex); ui_.cursor = 0; ui_.commandActor = -1; }
      else { ui_.pendingId = 1; ui_.targeting = true; ui_.category = 3; ui_.cursor = 0; ui_.itemAction = false; ui_.target = 0; }
    } else {
      sound(1); ui_.commandCursor = ui_.cursor;
      if (ui_.cursor < guard) { ui_.skillType = types[ui_.cursor - 1]; ui_.category = 1; }
      else ui_.category = 2;
      ui_.cursor = 0; ui_.listMemoryApplied = false;
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
          const auto& entries = database_[equipSlotType(value,static_cast<int>(i)) == 1 ? "weapons" : "armors"].array(); int best = value.equips[i]; double score = -1000000;
          for (const auto& candidate : entries) if (canEquip(value, candidate, static_cast<int>(i))) {
            const int id = candidate["id"].integer(); if (id != value.equips[i] && inventory_[id + (equipSlotType(value,static_cast<int>(i)) == 1 ? 100000 : 200000)] <= 0) continue;
            double sum = 0; for (const auto& parameterValue : candidate["params"].array()) sum += parameterValue.number();
            if (sum > score) { score = sum; best = id; }
          }
          if (best != value.equips[i]) changeEquipment(value.id, static_cast<int>(i), best);
        }
      }
    } else if (ui_.category == 1) {
      cursor(static_cast<int>(value.equips.size()));
      if (cancel) { ui_.category = 0; ui_.cursor = 0; }
      else if (ok) { if (!canChangeEquip(value,ui_.cursor)) sound(3); else { ui_.slot = ui_.cursor; ui_.category = 2; ui_.cursor = 0; } }
    } else {
      std::vector<int> choices{0}; const auto& entries = database_[equipSlotType(value,ui_.slot) == 1 ? "weapons" : "armors"].array();
      for (const auto& entry : entries) if (canEquip(value, entry, ui_.slot) && inventory_[entry["id"].integer() + (equipSlotType(value,ui_.slot) == 1 ? 100000 : 200000)] > 0) choices.push_back(entry["id"].integer());
      cursor(static_cast<int>(choices.size()));
      if (cancel) { ui_.category = 1; ui_.cursor = ui_.slot; }
      else if (ok) { changeEquipment(value.id, ui_.slot, choices[ui_.cursor]); ui_.category = 1; ui_.cursor = ui_.slot; }
    }
    return;
  }
  if (ui_.scene == Scene::item && !ui_.targeting && ui_.category == 0) {
    cursor(4);
    if (cancel) enter(Scene::menu);
    else if (ok) { ui_.slot = ui_.cursor; ui_.category = 1; ui_.cursor = 0; ui_.listMemoryApplied = false; sound(1); }
    return;
  }
  if (ui_.scene == Scene::skill && !ui_.targeting && ui_.category == 0) {
    const auto types = battleSkillTypes(ui_.actor); cursor(static_cast<int>(types.size()));
    if (cancel) enter(Scene::menu);
    else if (ok && !types.empty()) { ui_.skillType = types[ui_.cursor]; ui_.commandCursor = ui_.cursor; ui_.category = 1; ui_.cursor = 0; ui_.listMemoryApplied = false; sound(1); }
    return;
  }
  const bool skill = ui_.scene == Scene::skill || (inBattle && ui_.category == 1);
  const bool itemScene = ui_.scene == Scene::item || (inBattle && ui_.category == 2);
  if (ui_.targeting || (inBattle && ui_.category == 3)) {
    const auto& entry = database_[ui_.itemAction ? "items" : "skills"][ui_.pendingId];
    const auto targets = inBattle ? battleSelectableTargets(entry) : std::vector<int>{};
    cursor(inBattle ? static_cast<int>(targets.size()) : static_cast<int>(party_.size()));
    if (cancel) { ui_.targeting = false; ui_.category = inBattle ? ui_.target : ui_.category; ui_.cursor = !inBattle || ui_.target != 0 ? ui_.listCursor : 0; }
    else if (ok) {
      if (inBattle) {
        if (targets.empty()) { sound(3); return; }
        chooseAction(battle_.actorIndex, ui_.pendingId, targets[ui_.cursor], ui_.itemAction); ui_.commandActor = -1;
      }
      else if (!useItem(ui_.pendingId, ui_.cursor, !ui_.itemAction)) { sound(3); return; }
      else if (!inBattle) {
        if (reservedCommonEvent_ > 0) { SceneManager::clearStack(*this); SceneManager::gotoScene(*this, Scene::map); return; }
        if (!party_.empty() && std::all_of(party_.begin(), party_.end(), [&](int id) { return actors_.at(id).hp <= 0; })) { openGameOver(); return; }
      }
      ui_.targeting = false; if (inBattle) ui_.category = 0; ui_.cursor = 0;
    }
    return;
  }
  if (skill || itemScene) {
    std::vector<int> entries;
    if (skill && !party_.empty()) {
      Window_SkillList list(0,0,816,624); list.actorId = party_[ui_.actor]; list.skillType = ui_.skillType; list.refresh(*this); entries = list.data;
    }
    else {
      Window_ItemList list(0,0,816,624);
      static const std::array<std::string,4> categories{"item","weapon","armor","keyItem"};
      list.category = inBattle ? "item" : categories[std::clamp(ui_.slot,0,3)]; list.refresh(*this);
      for (int id : list.data) if (!inBattle || database_["items"][id]["occasion"].integer() <= 1) entries.push_back(id);
    }
    if (!ui_.listMemoryApplied) {
      const int remembered = skill ? (inBattle ? actors_.at(party_[ui_.actor]).lastBattleSkill : actors_.at(party_[ui_.actor]).lastMenuSkill) : lastItemId_;
      const auto found = std::find(entries.begin(),entries.end(),remembered);
      ui_.cursor = found == entries.end() ? 0 : static_cast<int>(found-entries.begin()); ui_.listMemoryApplied = true;
    }
    cursor(static_cast<int>(entries.size()));
    if (cancel) { if (inBattle) { ui_.category = 0; ui_.cursor = ui_.commandCursor; } else if (ui_.scene == Scene::item) { ui_.category = 0; ui_.cursor = ui_.slot; sound(2); } else if (ui_.scene == Scene::skill) { ui_.category = 0; ui_.cursor = ui_.commandCursor; sound(2); } else enter(Scene::menu); }
    else if (ok && !entries.empty()) {
      if (!skill && entries[ui_.cursor] >= 100000) { sound(3); return; }
      const auto& entry = database_[skill ? "skills" : "items"][entries[ui_.cursor]];
      const int user = !inBattle && !skill ? menuItemUser() : ui_.actor;
      if (user < 0 || !canUse(actors_.at(party_[user]), entry)) { sound(3); return; }
      ui_.target = inBattle ? ui_.category : -1; ui_.listCursor = ui_.cursor;
      ui_.pendingId = entries[ui_.cursor]; ui_.itemAction = !skill;
      if (skill) { auto& actor = actors_.at(party_[ui_.actor]); (inBattle ? actor.lastBattleSkill : actor.lastMenuSkill) = ui_.pendingId; }
      else lastItemId_ = ui_.pendingId;
      const int scope = entry["scope"].integer();
      if (!inBattle && scope <= 6) {
        if (!useItemUntargeted(ui_.pendingId, !ui_.itemAction)) { sound(3); return; }
        ui_.cursor = 0;
        if (reservedCommonEvent_ > 0) { SceneManager::clearStack(*this); SceneManager::gotoScene(*this, Scene::map); return; }
        if (!party_.empty() && std::all_of(party_.begin(), party_.end(), [&](int id) { return actors_.at(id).hp <= 0; })) { openGameOver(); return; }
      } else if (inBattle && scope != 1 && scope != 7 && scope != 9) {
        chooseAction(battle_.actorIndex, ui_.pendingId, scope == 11 ? battle_.actorIndex : -1, ui_.itemAction); ui_.commandActor = -1;
        ui_.category = 0; ui_.cursor = 0;
      } else { ui_.targeting = true; ui_.cursor = 0; if (inBattle) ui_.category = 3; }
    }
  }
  if (ui_.scene == Scene::shop) {
    if (ui_.category == 0) {
      cursor(3);
      if (cancel) { leaveEventScene(); sound(2); }
      else if (ok) {
        if (ui_.cursor == 0) { ui_.category = 1; ui_.cursor = 0; sound(1); }
        else if (ui_.cursor == 1) { if (ui_.shopPurchaseOnly) sound(3); else { ui_.category = 2; ui_.cursor = 0; sound(1); } }
        else { leaveEventScene(); sound(2); }
      }
      return;
    }
    if (ui_.category == 3) {
      if (direction) { const int change = direction == 6 ? 1 : direction == 4 ? -1 : direction == 8 ? 10 : -10;
        ui_.shopItemCount = std::clamp(ui_.shopItemCount+change,1,ui_.shopMaxNumber); sound(0); }
      if (cancel) { ui_.category = ui_.shopSelling ? 2 : 1; ui_.cursor = ui_.listCursor; sound(2); }
      else if (ok) {
        const int count = ui_.shopItemCount;
        gold_ = std::clamp(gold_ + (ui_.shopSelling ? 1 : -1)*count*ui_.shopPrice,0,99999999);
        gainItem(ui_.shopKind,ui_.shopId,ui_.shopSelling ? -count : count,false);
        ui_.category = ui_.shopSelling ? 2 : 1; ui_.cursor = ui_.listCursor; sound(21);
      }
      return;
    }
    std::vector<ShopGood> choices;
    if (ui_.category == 1) choices = ui_.shopGoods;
    else for (const auto& [key,count] : inventory_) if (count > 0) {
      const int kind = key/100000, id = key%100000;
      const auto& item = database_[kind == 0 ? "items" : kind == 1 ? "weapons" : "armors"][id];
      if (!item.null() && (kind != 0 || item["itypeId"].integer(1) <= 2)) choices.push_back({kind,id,item["price"].integer()/2});
    }
    cursor(static_cast<int>(choices.size()));
    if (cancel) { const bool selling = ui_.category == 2; ui_.category = 0; ui_.cursor = selling ? 1 : 0; sound(2); }
    else if (ok && !choices.empty()) {
      const auto& good = choices[ui_.cursor];
      const int count = inventory_[good.id+good.kind*100000];
      const bool selling = ui_.category == 2;
      const int maximum = selling ? count : std::min(99-count,good.price > 0 ? gold_/good.price : 99);
      if (maximum <= 0 || (selling && good.price <= 0)) { sound(3); return; }
      ui_.shopSelling = selling; ui_.shopKind = good.kind; ui_.shopId = good.id; ui_.shopPrice = good.price;
      ui_.shopMaxNumber = maximum; ui_.shopItemCount = 1; ui_.listCursor = ui_.cursor; ui_.category = 3; sound(1);
    }
    return;
  }
  if (ui_.scene == Scene::name) {
    if (direction == 2) ui_.cursor = (ui_.cursor+10)%90;
    if (direction == 8) ui_.cursor = (ui_.cursor+80)%90;
    if (direction == 6) ui_.cursor = ui_.cursor/10*10+(ui_.cursor+1)%10;
    if (direction == 4) ui_.cursor = ui_.cursor/10*10+(ui_.cursor+9)%10;
    if (direction) sound(0);
    if (cancel) {
      if (!ui_.nameInput.empty()) { std::size_t index = ui_.nameInput.size()-1; while (index && (static_cast<unsigned char>(ui_.nameInput[index])&0xc0)==0x80) --index; ui_.nameInput.erase(index); sound(2); }
      else sound(3);
    } else if (ok) {
      if (ui_.cursor == 88) { ui_.namePage = (ui_.namePage+1)%nameInputPageCount(database_["system"]["locale"].text()); sound(1); }
      else if (ui_.cursor == 89) {
        if (ui_.nameInput.empty()) { ui_.nameInput = actors_.at(ui_.nameActorId).name; sound(ui_.nameInput.empty() ? 3 : 1); }
        else { actors_.at(ui_.nameActorId).name = ui_.nameInput; leaveEventScene(); sound(1); }
      } else {
        std::size_t count = 0; for (unsigned char ch : ui_.nameInput) if ((ch&0xc0)!=0x80) ++count;
        if (count < static_cast<std::size_t>(ui_.nameMaxLength)) { ui_.nameInput += nameInputTable(ui_.namePage,database_["system"]["locale"].text())[ui_.cursor]; sound(1); } else sound(3);
      }
    }
    return;
  }
  if (ui_.scene == Scene::debug) {
    const int switchCount = std::max(0,static_cast<int>(database_["system"]["switches"].array().size())-1);
    const int varCount = std::max(0,static_cast<int>(database_["system"]["variables"].array().size())-1);
    const int switchBlocks = (switchCount+9)/10, totalBlocks = switchBlocks+(varCount+9)/10;
    if (ui_.category == 0) {
      if (direction == 2 || direction == 8) cursor(totalBlocks);
      if (cancel || debugTriggered) { leaveEventScene(); sound(2); }
      else if ((ok || direction == 6) && totalBlocks > 0) { ui_.listCursor = ui_.cursor; ui_.category = 1; ui_.cursor = 0; sound(1); }
      return;
    }
    const bool isSwitch = ui_.listCursor < switchBlocks;
    const int top = (isSwitch ? ui_.listCursor : ui_.listCursor-switchBlocks)*10+1;
    const int count = std::min(10,(isSwitch ? switchCount : varCount)-top+1);
    if (direction == 2 || direction == 8) cursor(count);
    if (cancel || debugTriggered) { ui_.category = 0; ui_.cursor = ui_.listCursor; sound(2); return; }
    const int id = top+ui_.cursor;
    if (isSwitch && ok) { switches_[id] = !switches_[id]; refreshNeeded_ = true; sound(0); }
    else if (!isSwitch && (direction == 4 || direction == 6 || pageUp || pageDown)) {
      const int amount = direction == 6 ? 1 : direction == 4 ? -1 : pageDown ? 10 : -10;
      operateVariable(id,0,variable(id).number()+amount); sound(0);
    }
    return;
  }
}
}  // namespace pmjs::mv
