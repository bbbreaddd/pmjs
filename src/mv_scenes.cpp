#include "mv_engine.hpp"
#include "mv_core_utils.hpp"
#include "mv_managers.hpp"
#include "mv_windows.hpp"
#include "mv_battle_extra.hpp"
#include "mv_sprites.hpp"
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace pmjs::mv {
void Session::startSceneFade(bool fadeOut, int duration) {
  sceneFadeOut_ = fadeOut;
  sceneFadeDuration_ = duration;
  sceneFadeOpacity_ = fadeOut ? 0 : 255;
}
void Session::updateSceneFade() {
  if (sceneFadeDuration_ <= 0) return;
  if (sceneFadeOut_) sceneFadeOpacity_ += (255 - sceneFadeOpacity_) / sceneFadeDuration_;
  else sceneFadeOpacity_ -= sceneFadeOpacity_ / sceneFadeDuration_;
  --sceneFadeDuration_;
}
void Session::configure(const Value& configuration) {
  Value merged = ConfigManager::save(*this);
  auto& data = std::get<Value::Object>(merged.data);
  const std::array<const char*, 4> keys{"bgmVolume", "bgsVolume", "meVolume", "seVolume"};
  for (int i = 0; i < 4; ++i) if (!configuration[keys[i]].null()) {
    const int volume = configuration[keys[i]].integer();
    if (volume < 0 || volume > 100) throw std::invalid_argument("volume must be between zero and one hundred");
    data[keys[i]] = Value{volume};
  }
  if (!configuration["alwaysDash"].null()) data["alwaysDash"] = Value{configuration["alwaysDash"].boolean()};
  if (!configuration["commandRemember"].null()) data["commandRemember"] = Value{configuration["commandRemember"].boolean()};
  ConfigManager::load(*this, merged);
}
Value Session::configuration() const { return ConfigManager::save(*this); }
void Session::audio(const std::string& kind, const Value& sound, bool restart) {
  if (kind == "bgm") savedBgm_ = sound;
  if (kind == "bgs") savedBgs_ = sound;
  audioCommands_.emplace_back(Value::Object{{"kind", kind}, {"sound", sound}, {"restart", restart}});
}
void Session::openTitle() {
  SceneManager::clearStack(*this);
  SceneManager::gotoScene(*this, Scene::title);
  finished_ = false;
  newGamePending_ = false; titleWindowOpenness_ = 255;
  sceneFadeOpacity_ = 0; sceneFadeDuration_ = 0;
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
    AudioManager::playBgm(*this, system_.battleBgm.null() ? database_["system"]["battleBgm"] : system_.battleBgm);
    fadeOut_ = 24;
  }
}
bool Session::useItemUntargeted(int id, bool skill) {
  const int user = skill ? ui_.actor : menuItemUser(); if (user < 0) return false;
  auto& subject = actors_.at(party_[user]); const auto& item = database_[skill ? "skills" : "items"][id];
  if (!canUse(subject, item) || (!skill && inventory_[id] <= 0)) return false;
  if (skill) { subject.mp -= static_cast<int>(std::floor(item["mpCost"].number() * trait(subject, 23, 4, true))); subject.tp -= item["tpCost"].integer(); }
  else if (item["consumable"].boolean()) --inventory_[id];
  AudioManager::playSe(*this, database_["system"]["sounds"][skill ? 24 : 23]);
  applyGlobalEffects(item);
  return true;
}
void Session::updateUi(const Input& inputState, bool ok, bool cancel, int direction) {
  const bool selectable = !message_.busy && ui_.scene != Scene::map && ui_.scene != Scene::gameOver;
  if (selectable) {
    if (ui_.scene != Scene::shop || ui_.category != 3) ok = inputState.okRepeated.value_or(ok);
    cancel = inputState.cancelRepeated.value_or(cancel);
  }
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
      if (message_.busy && ui_.maxDigits > 0 && target->action >= 8 && target->action <= 10) { hit = true; break; }
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
    const bool messageOk = inputState.okRepeated.value_or(ok) || inputState.touchRepeated;
    const bool messageCancel = inputState.cancelRepeated.value_or(cancel);
    if (updateMessageText(messageOk,messageCancel)) return;
    if (ui_.maxDigits > 0) {
      if (!ui_.numberButtonsInitialized) {
        ui_.numberButtonsVisible = inputState.touchDate > inputState.inputDate;
        ui_.numberButtonsInitialized = true;
        ui_.numberButton = -1;
      }
      ui_.numberButtonFrame = ui_.numberButton;
      if (ui_.numberButtonsVisible && inputState.touchX && inputState.touchY) {
        int touching = -1;
        for (int index = 0; index < 3; ++index) {
          const auto target = std::find_if(uiHitTargets_.rbegin(),uiHitTargets_.rend(),[&](const auto& target) {
            return target.scene == ui_.scene && target.category == ui_.category && target.action == 8+index;
          });
          if (target == uiHitTargets_.rend()) continue;
          Sprite_Button button;
          const auto cold = Window_NumberInput::buttonFrame(index,false), hot = Window_NumberInput::buttonFrame(index,true);
          button.setColdFrame(cold.x,cold.y,cold.width,cold.height);
          button.setHotFrame(hot.x,hot.y,hot.width,hot.height);
          button.position = {static_cast<float>(target->x),static_cast<float>(target->y)};
          button.touching = ui_.numberButton == index;
          const bool clicked = button.updateTouch(inputState.touchTriggered,inputState.touchReleased,*inputState.touchX,*inputState.touchY);
          if (button.touching) touching = index;
          if (clicked) {
            if (index == 2) ok = true;
            else { ui_.numberInput = Window_NumberInput::changeDigit(ui_.numberInput,ui_.maxDigits,ui_.digitIndex,index == 1); sound(0); }
          }
        }
        ui_.numberButton = touching;
      } else if (!ui_.numberButtonsVisible) ui_.numberButton = -1;
      if (ok) {
        operateVariable(ui_.variableId, 0, ui_.numberInput); ui_.maxDigits = 0;
        ui_.numberButton = ui_.numberButtonFrame = -1;
        ui_.numberButtonsVisible = ui_.numberButtonsInitialized = false;
        message_ = {}; sound(1); return;
      }
      if (direction == 6 || direction == 4) { ui_.digitIndex = (ui_.digitIndex + ui_.maxDigits + (direction == 6 ? 1 : -1)) % ui_.maxDigits; sound(0); }
      if (direction == 8 || direction == 2) {
        ui_.numberInput = Window_NumberInput::changeDigit(ui_.numberInput, ui_.maxDigits, ui_.digitIndex, direction == 8); sound(0);
      }
      return;
    }
    if (ui_.variableId > 0 && ui_.category > 0) {
      const auto items = Window_EventItem::makeItemList(*this, ui_.category);
      const int oldCursor = ui_.cursor;
      if (direction) Window_Selectable::moveCursor(ui_.cursor, ui_.listTopRow, static_cast<int>(items.size()), 2, 4, direction, directionAge_ == 0);
      ui_.listTopRow = Window_Selectable::wheelTopRow(ui_.listTopRow, static_cast<int>(items.size()), 2, 4, inputState.wheelY);
      if (oldCursor != ui_.cursor) sound(0);
      if (ok && !items.empty()) {
        operateVariable(ui_.variableId, 0, items[ui_.cursor]);
        ui_.variableId = 0; ui_.category = 0; message_.busy = false; message_ = {}; sound(1);
      } else if (cancel || (ok && items.empty())) {
        operateVariable(ui_.variableId, 0, 0);
        ui_.variableId = 0; ui_.category = 0; message_.busy = false; message_ = {}; sound(2);
      }
      return;
    }
    if (message_.choices.empty() || message_.pageEnd() < static_cast<int>(message_.lines.size())) { if (messageOk || messageCancel) acknowledge(); }
    else {
      const int count = static_cast<int>(message_.choices.size()), previous = ui_.cursor;
      if (!message_.choiceLayoutReady) {
        const int screenHeight = database_["sceneContract"]["height"].integer(624);
        const Rect bounds{0,message_.position*(screenHeight-180)/2,0,180};
        message_.choiceVisibleRows = Window_ChoiceList::visibleRows(count,bounds,screenHeight);
        message_.choiceTopRow = Window_Selectable::visibleTopRow(ui_.cursor,0,count,1,message_.choiceVisibleRows);
        message_.choiceLayoutReady = true;
      }
      if (direction) Window_Selectable::moveCursor(ui_.cursor,message_.choiceTopRow,count,1,message_.choiceVisibleRows,direction,directionAge_ == 0);
      if (pageUp || pageDown) Window_Selectable::pageCursor(ui_.cursor,message_.choiceTopRow,count,1,message_.choiceVisibleRows,pageDown);
      message_.choiceTopRow = Window_Selectable::wheelTopRow(message_.choiceTopRow,count,1,message_.choiceVisibleRows,inputState.wheelY);
      if (previous != ui_.cursor) sound(0);
      if (ok && (ui_.cursor < 0 || ui_.cursor >= count)) sound(3);
      else if (ok) { acknowledge(ui_.cursor); sound(1); ui_.cursor = 0; }
      else if ((messageCancel || inputState.touchCancelled) && message_.cancelChoice != -1) { acknowledge(-2); sound(2); ui_.cursor = 0; }
    }
    return;
  }
  if (ui_.scene == Scene::title) {
    if (newGamePending_) return;
    if (ui_.age < 32) return;
    const auto commands = Window_TitleCommand::makeCommands(*this);
    cursor(static_cast<int>(commands.size()));
    if (!ok) return;
    const int selected = ui_.cursor;
    if (selected < 0 || selected >= static_cast<int>(commands.size()) || !commands[selected].enabled) { sound(3); return; }
    lastTitleCommand_ = selected;
    if (commands[selected].symbol == "newGame") {
      sound(1);
      AudioManager::fadeOutBgm(*this,48 / 60.0);
      AudioManager::fadeOutBgs(*this,48 / 60.0);
      AudioManager::fadeOutMe(*this,48 / 60.0);
      startSceneFade(true,48); newGamePending_ = true; titleWindowOpenness_ = 255;
    }
    else if (commands[selected].symbol == "continue") {
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
    const int count = Window_SavefileList::fileCount(), rows = Window_SavefileList::visibleItems();
    ui_.cursor = std::clamp(ui_.cursor,0,count-1);
    const int previous = ui_.cursor;
    if (direction == 2 || direction == 8) Window_Selectable::moveCursor(ui_.cursor,ui_.listTopRow,count,1,rows,direction,true);
    if (pageDown || pageUp) Window_Selectable::pageCursor(ui_.cursor,ui_.listTopRow,count,1,rows,pageDown);
    ui_.listTopRow = Window_Selectable::wheelTopRow(ui_.listTopRow,count,1,rows,inputState.wheelY);
    if (previous != ui_.cursor) sound(0);
    if (cancel) { if (SceneManager::hasPrevious(*this)) { SceneManager::popScene(*this); sound(2); } else if (ui_.scene == Scene::load) openTitle(); else enter(Scene::menu); }
    else if (ok) {
      if (!Window_SavefileList::isEnabled(*this,ui_.cursor+1,ui_.scene == Scene::load)) sound(3);
      else { saveRequested_ = ui_.scene == Scene::save; loadRequested_ = ui_.scene == Scene::load; }
    }
    return;
  }
  if (ui_.scene == Scene::options) {
    const auto commands = Window_Options::makeCommands(*this);
    if (direction == 2 || direction == 8) cursor(static_cast<int>(commands.size()));
    if (ok || direction == 4 || direction == 6) {
      if (ui_.cursor >= 0 && ui_.cursor < static_cast<int>(commands.size()) && Window_Options::processInput(commands[ui_.cursor].symbol, direction, ok, *this)) sound(0);
    }
    if (cancel) { const bool title = ui_.slot == 1; if (title) openTitle(); else enter(Scene::menu); }
    return;
  }
  if (ui_.scene == Scene::menu) {
    const auto commands = Window_MenuCommand::makeCommands(*this);
    if (ui_.category == 2) {
      const int previous = ui_.cursor, count = static_cast<int>(party_.size());
      if (direction) Window_Selectable::moveCursor(ui_.cursor,ui_.menuStatusTopRow,count,1,4,direction,directionAge_ == 0);
      if (pageDown || pageUp) Window_Selectable::pageCursor(ui_.cursor,ui_.menuStatusTopRow,count,1,4,pageDown);
      ui_.menuStatusTopRow = Window_Selectable::wheelTopRow(ui_.menuStatusTopRow,count,1,4,inputState.wheelY);
      if (previous != ui_.cursor) sound(0);
      if (cancel) { ui_.cursor = ui_.pendingId; ui_.category = 0; sound(2); }
      else if (ok && !party_.empty()) {
        const int actor = ui_.cursor;
        const auto& command = commands.at(ui_.pendingId).symbol;
        enter(command == "skill" ? Scene::skill : command == "equip" ? Scene::equip : Scene::status); ui_.actor = actor; menuActorId_ = party_[actor];
      }
      return;
    }
    if (ui_.category == 1) {
      const auto endCommands = Window_GameEnd::makeCommands(*this);
      cursor(static_cast<int>(endCommands.size()));
      if (cancel || (ok && endCommands[ui_.cursor].symbol == "cancel")) { ui_.category = 0; ui_.cursor = ui_.commandCursor; }
      else if (ok) openTitle();
      return;
    }
    ui_.cursor = std::clamp(ui_.cursor, 0, static_cast<int>(commands.size()) - 1);
    cursor(static_cast<int>(commands.size()));
    if (cancel) { enter(Scene::map); return; }
    if (!ok) return;
    const auto& selected = commands[ui_.cursor];
    if (!selected.enabled) { sound(3); return; }
    if (selected.symbol == "skill" || selected.symbol == "equip" || selected.symbol == "status") {
      ui_.pendingId = ui_.cursor; ui_.category = 2;
      const auto found = std::find(party_.begin(),party_.end(),menuActorId_); ui_.cursor = found == party_.end() ? 0 : static_cast<int>(found-party_.begin());
      ui_.menuStatusTopRow = Window_Selectable::visibleTopRow(ui_.cursor,0,static_cast<int>(party_.size()),1,4);
      sound(1); return;
    }
    if (selected.symbol == "item") enter(Scene::item);
    else if (selected.symbol == "formation") enter(Scene::formation);
    else if (selected.symbol == "options") enter(Scene::options);
    else if (selected.symbol == "save") { enter(Scene::save); ui_.cursor = std::max(0, DataManager::lastAccessedSavefileId(*this) - 1); }
    else if (selected.symbol == "gameEnd") { ui_.commandCursor = ui_.cursor; ui_.category = 1; ui_.cursor = 0; }
    return;
  }
  if ((pageUp || pageDown) && !party_.empty() && ((ui_.scene == Scene::skill && ui_.category == 0 && !ui_.targeting) || (ui_.scene == Scene::equip && ui_.category != 2))) {
    ui_.actor = (ui_.actor+static_cast<int>(party_.size())+(pageDown ? 1 : -1))%static_cast<int>(party_.size());
    menuActorId_ = party_[ui_.actor]; ui_.category = 0; ui_.cursor = 0; ui_.skillTypeTopRow = 0; ui_.targeting = false; ui_.listMemoryApplied = false; sound(0); return;
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
  if (inBattle && (battle_.opening || battle_.wait || battle_.actionStage || (battleLog_ && battleLog_->isBusy()) || !battle_.active || battle_.interpreter.running || battle_.forcedExecuting || !battle_.forcedActions.empty())) return;
  if (inBattle && ui_.category == 4) {
    const auto commands = Window_PartyCommand::makeCommands(*this,battle_.canEscape);
    cursor(static_cast<int>(commands.size()));
    if (!ok) return;
    const auto& selected = commands[ui_.cursor];
    if (!selected.enabled) { sound(3); return; }
    if (selected.symbol == "fight") { ui_.category = 0; ui_.cursor = 0; ui_.actor = battle_.actorIndex; ui_.commandActor = -1; sound(1); }
    else if (selected.symbol == "escape") {
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
      auto popActorAction = [&](int actorIdx) {
        for (auto it = battle_.actions.rbegin(); it != battle_.actions.rend(); ++it) {
          if (!it->enemy && it->subject == actorIdx) {
            battle_.actions.erase(std::next(it).base());
            ++battle_.remainingActions[actorIdx];
            return true;
          }
        }
        return false;
      };
      if (!popActorAction(battle_.actorIndex)) {
        int previous = battle_.actorIndex - 1;
        while (previous >= 0) {
          const auto& prevActor = actors_.at(party_[previous]);
          if (prevActor.hp > 0 && restriction(prevActor) == 0 && !hasSpecialFlag(prevActor, 0) && popActorAction(previous)) break;
          --previous;
        }
        if (previous < 0) { ui_.category = 4; }
        else { battle_.actorIndex = previous; ui_.actor = previous; }
      }
      ui_.cursor = 0; ui_.commandActor = -1;
      sound(2); return;
    }
    auto& inputActor = actors_.at(party_[battle_.actorIndex]);
    const auto commands = Window_ActorCommand::makeCommands(*this,inputActor.id);
    if (ui_.commandActor != inputActor.id) {
      ui_.commandActor = inputActor.id; ui_.cursor = 0;
      if (commandRemember_) {
        const auto& rememberedSkill = database_["skills"][inputActor.lastBattleSkill];
        const int type = rememberedSkill["stypeId"].integer();
        const auto found = std::find_if(commands.begin(),commands.end(),[&](const CommandItem& command) {
          return command.symbol == inputActor.lastCommandSymbol && (command.symbol != "skill" || rememberedSkill.null() || command.ext == type);
        });
        if (found != commands.end()) ui_.cursor = static_cast<int>(found-commands.begin());
      }
    }
    ui_.cursor = std::clamp(ui_.cursor,0,static_cast<int>(commands.size())-1);
    cursor(static_cast<int>(commands.size()));
    if (!ok) return;
    const auto& selected = commands[ui_.cursor];
    if (!selected.enabled) { sound(3); return; }
    ui_.actor = battle_.actorIndex;
    inputActor.lastCommandSymbol = commandRemember_ ? selected.symbol : "";
    if (selected.symbol == "attack" || selected.symbol == "guard") {
      const int skillId = selected.symbol == "attack" ? 1 : 2;
      sound(1);
      if (skillId == 2) { chooseAction(battle_.actorIndex, 2, battle_.actorIndex); ui_.cursor = 0; ui_.commandActor = -1; }
      else { ui_.pendingId = 1; ui_.targeting = true; ui_.category = 3; ui_.cursor = 0; ui_.targetTopRow = 0; ui_.itemAction = false; ui_.target = 0; }
    } else {
      sound(1); ui_.commandCursor = ui_.cursor;
      if (selected.symbol == "skill") { ui_.skillType = selected.ext; ui_.category = 1; }
      else if (selected.symbol == "item") ui_.category = 2;
      ui_.cursor = 0; ui_.listMemoryApplied = false;
    }
    return;
  }
  if (ui_.scene == Scene::equip) {
    if (party_.empty()) { enter(Scene::menu); return; }
    auto& value = actors_.at(party_[ui_.actor]);
    if (ui_.category == 0) {
      const auto commands = Window_EquipCommand::makeCommands(*this);
      int topRow = 0;
      const int previous = ui_.cursor;
      Window_Selectable::moveCursor(ui_.cursor,topRow,static_cast<int>(commands.size()),3,1,direction,directionAge_ == 0);
      if (previous != ui_.cursor) sound(0);
      if (cancel) enter(Scene::menu);
      else if (ok) {
        const auto& command = commands.at(ui_.cursor).symbol;
        if (command == "equip") { ui_.commandCursor = ui_.cursor; ui_.category = 1; ui_.cursor = 0; }
        else {
          SoundManager::playEquip(*this);
          if (command == "optimize") BattleMechanics::optimizeEquipments(*this,value);
          else if (command == "clear") BattleMechanics::clearEquipments(*this,value);
        }
      }
    } else if (ui_.category == 1) {
      int topRow = 0;
      const int previous = ui_.cursor;
      Window_Selectable::moveCursor(ui_.cursor,topRow,static_cast<int>(value.equips.size()),1,5,direction,directionAge_ == 0);
      if (previous != ui_.cursor) sound(0);
      if (cancel) { ui_.category = 0; ui_.cursor = ui_.commandCursor; sound(2); }
      else if (ok) {
        if (!canChangeEquip(value,ui_.cursor)) sound(3);
        else { ui_.slot = ui_.cursor; ui_.category = 2; ui_.cursor = 0; ui_.listTopRow = 0; ui_.equipPreviewIndex = -1; sound(1); }
      }
    } else {
      const auto choices = Window_EquipItem::makeItemList(*this,value.id,ui_.slot);
      const int previous = ui_.cursor;
      ui_.cursor = std::clamp(ui_.cursor,0,static_cast<int>(choices.size())-1);
      if (direction) Window_Selectable::moveCursor(ui_.cursor,ui_.listTopRow,static_cast<int>(choices.size()),2,ui_.listPageRows,direction,directionAge_ == 0);
      if (pageDown) Window_Selectable::pageCursor(ui_.cursor,ui_.listTopRow,static_cast<int>(choices.size()),2,ui_.listPageRows,true);
      if (pageUp) Window_Selectable::pageCursor(ui_.cursor,ui_.listTopRow,static_cast<int>(choices.size()),2,ui_.listPageRows,false);
      ui_.listTopRow = Window_Selectable::wheelTopRow(ui_.listTopRow,static_cast<int>(choices.size()),2,ui_.listPageRows,inputState.wheelY);
      if (previous != ui_.cursor) sound(0);
      if (cancel) { ui_.category = 1; ui_.cursor = ui_.slot; sound(2); }
      else if (ok) {
        changeEquipment(value.id,ui_.slot,choices[ui_.cursor]%100000);
        SoundManager::playEquip(*this);
        ui_.category = 1; ui_.cursor = ui_.slot;
      }
    }
    if (ui_.scene == Scene::equip && ui_.category == 2) {
      if (ui_.equipPreviewIndex != ui_.cursor) {
        const auto choices = Window_EquipItem::makeItemList(*this,value.id,ui_.slot);
        ui_.equipPreview = previewEquipment(value,ui_.slot,choices[ui_.cursor]%100000);
        ui_.equipPreviewIndex = ui_.cursor;
      }
    } else { ui_.equipPreview.reset(); ui_.equipPreviewIndex = -1; }
    return;
  }
  if (ui_.scene == Scene::item && !ui_.targeting && ui_.category == 0) {
    const int previous = ui_.cursor, count = static_cast<int>(Window_ItemCategory::makeCommands(*this).size());
    int top = 0;
    if (direction) Window_Selectable::moveCursor(ui_.cursor,top,count,4,1,direction,directionAge_ == 0);
    if (previous != ui_.cursor) sound(0);
    ui_.slot = ui_.cursor;
    if (cancel) enter(Scene::menu);
    else if (ok) { ui_.slot = ui_.cursor; ui_.category = 1; ui_.cursor = 0; ui_.listMemoryApplied = false; sound(1); }
    return;
  }
  if (ui_.scene == Scene::skill && !ui_.targeting && ui_.category == 0) {
    const auto types = Window_SkillType::makeCommands(*this, party_[ui_.actor]);
    if (!ui_.listMemoryApplied) {
      const int remembered = database_["skills"][actors_.at(party_[ui_.actor]).lastMenuSkill]["stypeId"].integer();
      const auto found = std::find_if(types.begin(),types.end(),[&](const CommandItem& command){return command.ext == remembered;});
      ui_.cursor = found == types.end() ? 0 : static_cast<int>(found-types.begin());
      ui_.skillTypeTopRow = Window_Selectable::visibleTopRow(ui_.cursor,0,static_cast<int>(types.size()),1,4);
      ui_.listMemoryApplied = true;
    }
    const int previous = ui_.cursor;
    if (direction) Window_Selectable::moveCursor(ui_.cursor,ui_.skillTypeTopRow,static_cast<int>(types.size()),1,4,direction,directionAge_ == 0);
    ui_.skillTypeTopRow = Window_Selectable::wheelTopRow(ui_.skillTypeTopRow,static_cast<int>(types.size()),1,4,inputState.wheelY);
    if (previous != ui_.cursor) sound(0);
    if (!types.empty()) ui_.skillType = types[ui_.cursor].ext;
    if (cancel) enter(Scene::menu);
    else if (ok && !types.empty()) { ui_.skillType = types[ui_.cursor].ext; ui_.commandCursor = ui_.cursor; ui_.category = 1; ui_.cursor = 0; ui_.listMemoryApplied = false; sound(1); }
    return;
  }
  const bool skill = ui_.scene == Scene::skill || (inBattle && ui_.category == 1);
  const bool itemScene = ui_.scene == Scene::item || (inBattle && ui_.category == 2);
  if (ui_.targeting || (inBattle && ui_.category == 3)) {
    const auto& entry = database_[ui_.itemAction ? "items" : "skills"][ui_.pendingId];
    const auto targets = inBattle ? battleSelectableTargets(entry) : std::vector<int>{};
    const auto menuSelection = Window_MenuActor::selection(*this,entry,ui_.actor);
    if (inBattle) {
      const bool enemies = entry["scope"].integer() >= 1 && entry["scope"].integer() <= 6;
      const int columns = enemies ? Window_BattleEnemy::columns() : Window_BattleActor::columns();
      const int rows = enemies ? Window_BattleEnemy::visibleRows() : Window_BattleActor::visibleRows();
      const int count = static_cast<int>(targets.size()), previous = ui_.cursor;
      ui_.cursor = count ? std::clamp(ui_.cursor,0,count-1) : 0;
      if (direction) Window_Selectable::moveCursor(ui_.cursor,ui_.targetTopRow,count,columns,rows,direction,true);
      if (pageDown || pageUp) Window_Selectable::pageCursor(ui_.cursor,ui_.targetTopRow,count,columns,rows,pageDown);
      ui_.targetTopRow = Window_Selectable::wheelTopRow(ui_.targetTopRow,count,columns,rows,inputState.wheelY);
      if (previous != ui_.cursor) sound(0);
    }
    else {
      const int previous = ui_.cursor, count = static_cast<int>(party_.size());
      if (menuSelection.fixed || menuSelection.all) ui_.cursor = menuSelection.index;
      else if (direction) Window_Selectable::moveCursor(ui_.cursor,ui_.menuActorTopRow,count,1,4,direction,directionAge_ == 0);
      if (!menuSelection.fixed && !menuSelection.all && (pageDown || pageUp)) Window_Selectable::pageCursor(ui_.cursor,ui_.menuActorTopRow,count,1,4,pageDown);
      ui_.menuActorTopRow = Window_Selectable::wheelTopRow(ui_.menuActorTopRow,count,1,4,inputState.wheelY);
      if (previous != ui_.cursor) sound(0);
    }
    if (cancel) { ui_.targeting = false; ui_.category = inBattle ? ui_.target : ui_.category; ui_.cursor = !inBattle || ui_.target != 0 ? ui_.listCursor : 0; }
    else if (ok) {
      if (inBattle) {
        if (targets.empty()) { sound(3); return; }
        chooseAction(battle_.actorIndex, ui_.pendingId, targets[ui_.cursor], ui_.itemAction); ui_.commandActor = -1;
      }
      else {
        if (!menuSelection.all) Window_MenuActor::rememberTarget(*this,ui_.cursor);
        if (!useItem(ui_.pendingId, ui_.cursor, !ui_.itemAction)) { sound(3); return; }
      }
      if (!inBattle) {
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
      entries = Window_SkillList::makeSkillList(*this, party_[ui_.actor], ui_.skillType);
    }
    else {
      const auto categories = Window_ItemCategory::makeCommands(*this);
      entries = inBattle ? Window_BattleItem::makeItemList(*this) : Window_ItemList::makeItemList(*this, categories[std::clamp(ui_.slot,0,3)].symbol);
    }
    if (!ui_.listMemoryApplied) {
      const int remembered = skill ? (inBattle ? actors_.at(party_[ui_.actor]).lastBattleSkill : actors_.at(party_[ui_.actor]).lastMenuSkill) : lastItemId_;
      const auto found = std::find(entries.begin(),entries.end(),remembered);
      ui_.cursor = found == entries.end() ? 0 : static_cast<int>(found-entries.begin()); ui_.listMemoryApplied = true;
      ui_.listTopRow = Window_Selectable::visibleTopRow(ui_.cursor, 0, static_cast<int>(entries.size()), 2, ui_.listPageRows);
    }
    const int count = static_cast<int>(entries.size());
    const int previous = ui_.cursor;
    ui_.cursor = std::clamp(ui_.cursor, 0, std::max(0, count - 1));
    ui_.listTopRow = Window_Selectable::clampTopRow(ui_.listTopRow, count, 2, ui_.listPageRows);
    if (direction) Window_Selectable::moveCursor(ui_.cursor, ui_.listTopRow, count, 2, ui_.listPageRows, direction, directionAge_ == 0);
    if (pageDown) Window_Selectable::pageCursor(ui_.cursor, ui_.listTopRow, count, 2, ui_.listPageRows, true);
    if (pageUp) Window_Selectable::pageCursor(ui_.cursor, ui_.listTopRow, count, 2, ui_.listPageRows, false);
    ui_.listTopRow = Window_Selectable::wheelTopRow(ui_.listTopRow, count, 2, ui_.listPageRows, inputState.wheelY);
    if (previous != ui_.cursor) sound(0);
    if (cancel) { if (inBattle) { ui_.category = 0; ui_.cursor = ui_.commandCursor; } else if (ui_.scene == Scene::item) { ui_.category = 0; ui_.cursor = ui_.slot; sound(2); } else if (ui_.scene == Scene::skill) { ui_.category = 0; ui_.cursor = ui_.commandCursor; sound(2); } else enter(Scene::menu); }
    else if (ok && !entries.empty()) {
      if (!skill && entries[ui_.cursor] >= 100000) { sound(3); return; }
      const auto& entry = database_[skill ? "skills" : "items"][entries[ui_.cursor]];
      const bool enabled = skill ? Window_SkillList::isEnabled(*this,party_[ui_.actor],entries[ui_.cursor]) : Window_ItemList::isEnabled(*this,entries[ui_.cursor]);
      if (!enabled) { sound(3); return; }
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
      } else {
        ui_.targeting = true;
        ui_.cursor = inBattle ? 0 : Window_MenuActor::selection(*this,entry,ui_.actor).index;
        if (!inBattle) ui_.menuActorTopRow = Window_Selectable::visibleTopRow(ui_.cursor,0,static_cast<int>(party_.size()),1,4);
        if (inBattle) { ui_.category = 3; ui_.targetTopRow = 0; }
      }
    }
  }
  if (ui_.scene == Scene::shop) {
    updateShop(ok, cancel, direction);
    return;
  }
  if (ui_.scene == Scene::name) {
    const auto locale = database_["system"]["locale"].text();
    const int previous = ui_.cursor, previousPage = ui_.namePage;
    ui_.cursor = Window_NameInput::moveGridCursor(ui_.cursor,direction,inputState.directionTriggered.value_or(directionAge_ == 0));
    if (inputState.pageDownRepeated.value_or(pageDown)) ui_.namePage = Window_NameInput::changePage(ui_.namePage,true,locale);
    if (inputState.pageUpRepeated.value_or(pageUp)) ui_.namePage = Window_NameInput::changePage(ui_.namePage,false,locale);
    if (ui_.cursor != previous || ui_.namePage != previousPage) sound(0);
    if (inputState.shiftTriggered.value_or(false) && ui_.cursor != 89) { ui_.cursor = 89; sound(0); }
    if (cancel || inputState.cancelRepeated.value_or(false)) {
      if (Window_NameEdit::removeCharacter(ui_.nameInput)) sound(2);
    }
    if (ok || inputState.okRepeated.value_or(false)) {
      if (ui_.cursor == 88) { ui_.namePage = Window_NameInput::changePage(ui_.namePage,true,locale); sound(1); }
      else if (ui_.cursor == 89) {
        if (ui_.nameInput.empty()) { ui_.nameInput = Window_NameEdit::initialName(actors_.at(ui_.nameActorId).name, ui_.nameMaxLength); sound(ui_.nameInput.empty() ? 3 : 1); }
        else { actors_.at(ui_.nameActorId).name = ui_.nameInput; leaveEventScene(); sound(1); }
      } else {
        if (Window_NameEdit::addCharacter(ui_.nameInput, ui_.nameMaxLength, nameInputTable(ui_.namePage,locale)[ui_.cursor])) sound(1); else sound(3);
      }
    }
    return;
  }
  if (ui_.scene == Scene::debug) {
    const int total = Window_DebugRange::itemCount(*this);
    if (ui_.category == 0) {
      const int previous = ui_.cursor, rows = std::max(1,ui_.listPageRows);
      if (direction == 2 || direction == 8) Window_Selectable::moveCursor(ui_.cursor,ui_.listTopRow,total,1,rows,direction,true);
      if (pageDown || pageUp) Window_Selectable::pageCursor(ui_.cursor,ui_.listTopRow,total,1,rows,pageDown);
      ui_.listTopRow = Window_Selectable::wheelTopRow(ui_.listTopRow,total,1,rows,inputState.wheelY);
      if (previous != ui_.cursor) sound(0);
      if (cancel || debugTriggered) { leaveEventScene(); sound(2); }
      else if (ok && total > 0) { ui_.listCursor = ui_.cursor; ui_.category = 1; ui_.cursor = 0; sound(1); }
      return;
    }
    const auto mode = Window_DebugRange::modeFor(*this,ui_.listCursor);
    const int top = Window_DebugRange::topIdFor(*this,ui_.listCursor);
    if (direction == 2 || direction == 8) cursor(10);
    if (cancel || debugTriggered) { ui_.category = 0; ui_.cursor = ui_.listCursor; sound(2); return; }
    if (Window_DebugEdit::processInput(*this,mode,top+ui_.cursor,inputState.okRepeated.value_or(ok),direction,inputState.pageUpRepeated.value_or(pageUp),inputState.pageDownRepeated.value_or(pageDown))) sound(0);
    return;
  }
}
}  // namespace pmjs::mv
