#include "mv_presentation.hpp"
#include <algorithm>
#include <cmath>

namespace pmjs::mv {
std::vector<int> Presentation::battlerIcons(const Battler& battler) const {
  return Sprite_StateIcon::allIcons(battler, session_);
}
void Presentation::stateIcons(const Battler& actor, float x, float y, int width) {
  const auto icons = battlerIcons(actor); if (icons.empty()) return;
  const auto source = image("img/system/IconSet.png");
  for (std::size_t index = 0; index < icons.size() && static_cast<int>(index + 1)*32 <= width; ++index)
    quad(source.handle,icons[index]%16*32,icons[index]/16*32,32,32,x+index*32,y,32,32);
}
void Presentation::battleSprites() {
  const bool sideView = session_.database_["system"]["optSideView"].boolean();
  const auto tick = session_.ticks_;
  const auto targetHit = [&](bool enemy,int index) -> std::pair<int,const ActionResult*> {
    for (auto visual = session_.battle_.visuals.rbegin(); visual != session_.battle_.visuals.rend(); ++visual) {
      for (auto target = visual->targets.rbegin(); target != visual->targets.rend(); ++target) {
        if (target->enemy == enemy && target->index == index && target->impact && target->impact <= tick)
          return {static_cast<int>(tick-target->impact),&target->result};
      }
    }
    return {-1,nullptr};
  };
  const auto selection = [&](bool enemy,int index) {
    if (session_.ui_.category != 3) return false;
    const auto& item = session_.database_[session_.ui_.itemAction ? "items" : "skills"][session_.ui_.pendingId];
    const bool enemies = item["scope"].integer() <= 6;
    if (enemies != enemy) return false;
    const auto targets = session_.battleSelectableTargets(item);
    const int cursor = session_.ui_.cursor;
    return cursor >= 0 && cursor < static_cast<int>(targets.size()) && targets[cursor] == index;
  };
  std::vector<std::size_t> enemyOrder;
  enemyOrder.reserve(session_.battle_.enemies.size());
  for (std::size_t index = 0; index < session_.battle_.enemies.size(); ++index) enemyOrder.push_back(index);
  const auto& troopMembers = session_.database_["troops"][session_.battle_.troopId]["members"];
  std::stable_sort(enemyOrder.begin(), enemyOrder.end(), [&](std::size_t a, std::size_t b) {
    const double ay = troopMembers[a]["y"].number(), by = troopMembers[b]["y"].number();
    return ay != by ? ay < by : b < a;
  });
  for (std::size_t index : enemyOrder) {
    const auto& enemy = session_.battle_.enemies[index];
    auto& display = battlerDisplays_[{true,static_cast<int>(index)}];
    display.stateIcon.setup(&enemy);
    if (!display.stateIconStarted || tick < display.stateIconTick) {
      display.stateIcon = Sprite_StateIcon{};
      display.stateIcon.setup(&enemy);
      display.stateIconStarted = true;
      display.stateIconTick = tick;
      display.stateIcon.update(session_);
    } else if (tick > display.stateIconTick) {
      display.stateIcon.advance(session_, tick - display.stateIconTick);
      display.stateIconTick = tick;
    }
    const auto* effect = session_.enemySprite(index);
    if (!effect || effect->opacity <= 0 || session_.effectHidden(2,static_cast<int>(index))) continue;
    const auto& data = session_.database_["enemies"][enemy.id];
    if (data["battlerName"].text().empty()) continue;
    const auto source = image(std::string(sideView ? "img/sv_enemies/" : "img/enemies/")+data["battlerName"].text()+".png",data["battlerHue"].integer());
    const auto& member = session_.database_["troops"][session_.battle_.troopId]["members"][index];
    float x = member["x"].number() + effect->shake, y = member["y"].number();
    const float opacity = effect->opacity;
    const int height = effect->effectType == "bossCollapse" ? effect->effectDuration : source.height;
    const BlendMode blend = effect->blendMode == 1 ? BlendMode::additive : BlendMode::normal;
    std::array<float,4> color{};
    for (std::size_t component = 0; component < color.size(); ++component) color[component] = effect->blendColor[component];
    if (selection(true,static_cast<int>(index)) && tick/15%2==0) color = {1,1,1,64.0F/255};
    const auto flash = session_.effectColor(2,static_cast<int>(index)); if (flash[3] > color[3]) color = flash;
    core_.renderer().queueImage(source.handle,{1,0,0,1,x-source.width/2.0F,y-height},
      {0,0,float(source.width),float(height)},opacity,0xffffff,blend,{},color);
    const auto& frame = display.stateIcon.frame;
    if (frame.width > 0) {
      const auto sheet = image("img/system/IconSet.png");
      const float iconY = std::max(20.0F, y - static_cast<float>(core::round((source.height + 40) * 0.9)));
      quad(sheet.handle,frame.x,frame.y,frame.width,frame.height,x-16,iconY-16,32,32,opacity);
    }
  }
  if (!sideView) return;
  for (std::size_t index = 0; index < session_.battleMemberCount(); ++index) {
    const auto& actor = session_.actors_.at(session_.party_[index]);
    auto& display = battlerDisplays_[{false, static_cast<int>(index)}];
    if (!display.actorSpritesStarted || tick < display.actorSpriteTick) {
      display.stateOverlay = Sprite_StateOverlay{};
      display.weapon = Sprite_Weapon{};
      display.actorSprite = Sprite_Actor{};
      display.weaponStarted = 0;
      display.actorSpritesStarted = true;
      display.actorSpriteTick = tick;
      display.stateOverlay.setup(&actor);
      display.stateOverlay.update(session_);
    } else {
      display.stateOverlay.setup(&actor);
      if (tick > display.actorSpriteTick) {
        const auto elapsed = tick - display.actorSpriteTick;
        display.stateOverlay.advance(session_, elapsed);
        display.weapon.advance(elapsed);
        display.actorSpriteTick = tick;
      }
    }
    if (actor.hidden || actor.escaped || actor.battlerName.empty() || session_.effectHidden(1,actor.id)) continue;
    float x = 600+index*32, y = 280+index*48;
    const bool inputting = session_.battle_.active && !session_.battle_.opening && !session_.battle_.wait && session_.ui_.category != 4 && session_.battle_.actorIndex == static_cast<int>(index);
    const int stateMotion = actor.states.empty() ? 0 : session_.database_["states"][actor.states.front()]["motion"].integer();
    const bool chanting = !inputting && (session_.battle_.actionStage > 0 || session_.battle_.turnEnding) &&
      std::any_of(session_.battle_.actions.begin(), session_.battle_.actions.end(), [&](const Action& pending) {
        return !pending.enemy && pending.subject == static_cast<int>(index) && !pending.item &&
          session_.database_["skills"][pending.id]["hitType"].integer() == 2;
      });
    int motion = 1;
    if (session_.battle_.result == 0 && actor.hp > 0) motion = 13;
    else if (session_.battle_.result == 1 && actor.hp > 0) motion = 12;
    else if (inputting) motion = 0;
    else if (stateMotion == 3 || actor.hp <= 0) motion = 17;
    else if (stateMotion == 2) motion = 16;
    else if (chanting) motion = 2;
    else if (actor.guarding) motion = 3;
    else if (stateMotion == 1) motion = 15;
    else if (actor.hp < session_.parameter(actor,0)/4) motion = 14;
    const auto fallbackMotion = static_cast<BattlerMotion>(motion);
    const BattleVisual* action = nullptr;
    for (auto visual = session_.battle_.visuals.rbegin(); visual != session_.battle_.visuals.rend(); ++visual)
      if (visual->actionVisual && !visual->action.enemy && visual->action.subject == static_cast<int>(index) && visual->movementStarted <= tick && (!visual->returned || tick-visual->returned < 12)) { action = &*visual; break; }
    int weaponImage = 0; std::uint64_t motionAge = tick, weaponStarted = 0;
    if (action) {
      const auto movementAge = tick-action->movementStarted;
      x -= action->returned ? 48*std::max(0.0,1-double(tick-action->returned)/12) : 48*std::min(1.0,double(movementAge)/12);
      if (tick >= action->started) {
        motionAge = tick-action->started;
        weaponStarted = action->started;
        if (action->action.item) motion = 11;
        else if (action->action.id == 1) {
          int weapon = 0; for (std::size_t slot = 0; slot < actor.equips.size(); ++slot) if (actor.equips[slot] && actor.equipKinds[slot] == 1) { weapon = actor.equips[slot]; break; }
          const int type = session_.database_["weapons"][weapon]["wtypeId"].integer();
          const auto& attack = session_.database_["system"]["attackMotions"][type]; motion = 6+attack["type"].integer(); weaponImage = attack["weaponImageId"].integer();
        } else motion = session_.database_["skills"][action->action.id]["stypeId"].integer() == 1 ? 10 : 9;
      }
    }
    const auto [damageAge,result] = targetHit(false,static_cast<int>(index));
    if (result && damageAge >= 0 && damageAge < 36 && actor.hp > 0) {
      if (result->evaded) { motion = 5; motionAge = damageAge; }
      else if (result->hpAffected && result->hpDamage > 0) { motion = 4; motionAge = damageAge; }
    }
    if (actor.hp > 0 && actor.requestedMotion >= 0 && actor.motionRequestedAt <= tick && tick - actor.motionRequestedAt < 36) {
      motion = actor.requestedMotion;
      motionAge = tick - actor.motionRequestedAt;
      if (actor.requestedWeapon > 0) { weaponImage = actor.requestedWeapon; weaponStarted = actor.motionRequestedAt; }
    }
    const auto shadow = image("img/system/Shadow2.png"); quad(shadow.handle,0,0,shadow.width,shadow.height,x-shadow.width/2.0F,y-2-shadow.height/2.0F,shadow.width,shadow.height,1);
    const auto source = image("img/sv_actors/"+actor.battlerName+".png");
    display.actorSprite.setBattler(&actor);
    display.actorSprite.synchronizeMotion(static_cast<BattlerMotion>(motion), tick - motionAge, tick, fallbackMotion);
    const auto actorFrame = display.actorSprite.sourceFrame(source.width, source.height);
    const float w = actorFrame.width, h = actorFrame.height;
    std::array<float,4> color{}; if (selection(false,static_cast<int>(index)) && tick/15%2==0) color = {1,1,1,64.0F/255};
    const auto flash = session_.effectColor(1,actor.id); if (flash[3] > color[3]) color = flash;
    core_.renderer().queueImage(source.handle,{1,0,0,1,x-w/2.0F,y-h},
      {float(actorFrame.x),float(actorFrame.y),w,h},1,0xffffff,BlendMode::normal,{},color);
    if (weaponImage > 0 && display.weaponStarted != weaponStarted) {
      display.weapon.setup(weaponImage);
      display.weapon.advance(tick - weaponStarted);
      display.weaponStarted = weaponStarted;
    }
    if (display.weapon.isPlaying()) {
      const auto sheet = image("img/system/Weapons"+std::to_string(display.weapon.pageId())+".png");
      const auto& frame = display.weapon.frame;
      quad(sheet.handle,frame.x,frame.y,frame.width,frame.height,x-64,y-64,96,64);
    }
    const auto& overlayFrame = display.stateOverlay.frame;
    if (overlayFrame.width > 0) { const auto sheet = image("img/system/States.png"); quad(sheet.handle,overlayFrame.x,overlayFrame.y,overlayFrame.width,overlayFrame.height,x-48,y-96,96,96); }
  }
}
}  // namespace pmjs::mv
