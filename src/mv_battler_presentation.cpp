#include "mv_presentation.hpp"
#include <algorithm>
#include <cmath>

namespace pmjs::mv {
std::vector<int> Presentation::battlerIcons(const Battler& battler) const {
  std::vector<int> icons;
  for (int state : battler.states) { const int icon = session_.database_["states"][state]["iconIndex"].integer(); if (icon > 0) icons.push_back(icon); }
  for (std::size_t parameter = 0; parameter < battler.buffs.size(); ++parameter) {
    const int level = battler.buffs[parameter];
    if (level) icons.push_back((level > 0 ? 32 : 48)+(std::abs(level)-1)*8+static_cast<int>(parameter));
  }
  return icons;
}
void Presentation::stateIcons(const Battler& actor, float x, float y, int width) {
  const auto icons = battlerIcons(actor); if (icons.empty()) return;
  const auto source = image("img/system/IconSet.png");
  for (std::size_t index = 0; index < icons.size() && static_cast<int>(index)*32 < width; ++index)
    quad(source.handle,icons[index]%16*32,icons[index]/16*32,32,32,x+index*32,y,32,32);
}
void Presentation::battleSprites() {
  const bool sideView = session_.database_["system"]["optSideView"].boolean();
  const auto tick = session_.ticks_;
  const auto targetHit = [&](bool enemy,int index) -> std::pair<int,const ActionResult*> {
    for (auto visual = session_.battle_.visuals.rbegin(); visual != session_.battle_.visuals.rend(); ++visual) {
      if (!visual->impact || visual->impact > tick) continue;
      for (const auto& target : visual->targets) if (target.enemy == enemy && target.index == index)
        return {static_cast<int>(tick-visual->impact),&target.result};
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
  for (std::size_t index = 0; index < session_.battle_.enemies.size(); ++index) {
    const auto& enemy = session_.battle_.enemies[index];
    auto& display = battlerDisplays_[{true,static_cast<int>(index)}];
    if (!display.initialized) { display.initialized = true; display.hp = enemy.hp; display.hidden = enemy.hidden; display.escaped = enemy.escaped; }
    if (display.hp > 0 && enemy.hp <= 0) { display.death = tick; display.collapseSoundPlayed = false; }
    if (enemy.hp > 0) display.death = 0;
    if (display.hidden && !enemy.hidden) { display.appeared = tick; display.disappeared = 0; }
    if ((!display.hidden && enemy.hidden) || (!display.escaped && enemy.escaped)) display.disappeared = tick;
    display.hp = enemy.hp; display.hidden = enemy.hidden; display.escaped = enemy.escaped;
    if (((enemy.hidden || enemy.escaped) && (!display.disappeared || tick-display.disappeared >= 32)) || session_.effectHidden(2,static_cast<int>(index))) continue;
    const auto& data = session_.database_["enemies"][enemy.id];
    if (data["battlerName"].text().empty()) continue;
    const auto source = image(std::string(sideView ? "img/sv_enemies/" : "img/enemies/")+data["battlerName"].text()+".png",data["battlerHue"].integer());
    const auto& member = session_.database_["troops"][session_.battle_.troopId]["members"][index];
    float x = member["x"].number(), y = member["y"].number(), opacity = 1;
    int height = source.height;
    BlendMode blend = BlendMode::normal; std::array<float,4> color{};
    if (enemy.hp <= 0) {
      if (!display.death) continue;
      const int age = static_cast<int>(tick-display.death);
      int collapse = 0;
      for (const auto* object : session_.traitObjects(enemy)) for (const auto& value : (*object)["traits"].array())
        if (value["code"].integer() == 63) collapse = std::max(collapse,value["dataId"].integer());
      const int duration = collapse == 1 ? source.height : collapse == 2 ? 0 : 32;
      if (!display.collapseSoundPlayed) {
        if (collapse != 2) session_.audio("se",session_.database_["system"]["sounds"][collapse == 1 ? 12 : 11]);
        display.collapseSoundPlayed = true;
      }
      if (collapse == 1 && (duration-age)%20 == 19 && display.lastBossSound != tick) {
        session_.audio("se",session_.database_["system"]["sounds"][13]); display.lastBossSound = tick;
      }
      if (age >= duration) continue;
      opacity = float(duration-age)/duration; blend = BlendMode::additive;
      if (collapse == 1) { height = std::max(0,source.height-age); x += (duration-age)%2*4-2; color = {1,1,1,1-opacity}; }
      else color = {1,128.0F/255,128.0F/255,128.0F/255};
    } else {
      const auto [age,result] = targetHit(true,static_cast<int>(index));
      if (result && age < 20 && age >= 0 && result->hpAffected && result->hpDamage > 0) opacity = (20-age)%10 < 5 ? 1 : 0;
      if (display.appeared && tick-display.appeared < 16) opacity *= float(tick-display.appeared)/16;
      for (auto visual = session_.battle_.visuals.rbegin(); visual != session_.battle_.visuals.rend(); ++visual) {
        if (visual->action.enemy && visual->action.subject == static_cast<int>(index) && visual->started <= tick && tick-visual->started < 16) {
          color = {1,1,1,128.0F/255*(16-float(tick-visual->started))/16}; break;
        }
      }
      if (selection(true,static_cast<int>(index)) && tick/15%2==0) color = {1,1,1,64.0F/255};
    }
    if (enemy.hidden || enemy.escaped) opacity *= std::clamp((256-float(tick-display.disappeared)*10)/255,0.0F,1.0F);
    const auto flash = session_.effectColor(2,static_cast<int>(index)); if (flash[3] > color[3]) color = flash;
    core_.renderer().queueImage(source.handle,{1,0,0,1,x-source.width/2.0F,y-height},
      {0,0,float(source.width),float(height)},opacity,0xffffff,blend,{},color);
    if (enemy.hp > 0) {
      const auto icons = battlerIcons(enemy);
      if (!icons.empty()) { const int icon = icons[(tick/40)%icons.size()]; const auto sheet = image("img/system/IconSet.png"); quad(sheet.handle,icon%16*32,icon/16*32,32,32,x-16,y-source.height-40,32,32); }
    }
  }
  if (!sideView) return;
  for (std::size_t index = 0; index < session_.battleMemberCount(); ++index) {
    const auto& actor = session_.actors_.at(session_.party_[index]);
    if (actor.hidden || actor.escaped || actor.battlerName.empty() || session_.effectHidden(1,actor.id)) continue;
    float x = 600+index*32, y = 280+index*48;
    const bool inputting = session_.battle_.active && !session_.battle_.opening && !session_.battle_.wait && session_.ui_.category != 4 && session_.battle_.actorIndex == static_cast<int>(index);
    int motion = actor.hp <= 0 ? 17 : session_.battle_.result == 0 ? 13 : session_.battle_.result == 1 ? 12 : actor.guarding ? 3 : inputting ? 0 : actor.hp < session_.parameter(actor,0)/4 ? 14 : 1;
    int overlay = 0;
    for (int state : actor.states) {
      const auto& value = session_.database_["states"][state];
      if (!overlay) overlay = value["overlay"].integer();
      if (actor.hp > 0 && !inputting && !actor.guarding && value["motion"].integer()) motion = value["motion"].integer() == 1 ? 15 : value["motion"].integer() == 2 ? 16 : 17;
    }
    const BattleVisual* action = nullptr;
    for (auto visual = session_.battle_.visuals.rbegin(); visual != session_.battle_.visuals.rend(); ++visual)
      if (!visual->action.enemy && visual->action.subject == static_cast<int>(index) && visual->movementStarted <= tick && (!visual->returned || tick-visual->returned < 12)) { action = &*visual; break; }
    int weaponImage = 0; std::uint64_t motionAge = tick;
    if (action) {
      const auto movementAge = tick-action->movementStarted;
      x -= action->returned ? 48*std::max(0.0,1-double(tick-action->returned)/12) : 48*std::min(1.0,double(movementAge)/12);
      if (tick >= action->started) {
        motionAge = tick-action->started;
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
    const auto shadow = image("img/system/Shadow2.png"); quad(shadow.handle,0,0,shadow.width,shadow.height,x-shadow.width/2.0F,y-2-shadow.height/2.0F,shadow.width,shadow.height,1);
    const auto source = image("img/sv_actors/"+actor.battlerName+".png"); const int w = source.width/9,h = source.height/6;
    const bool looping = motion == 0 || motion == 1 || motion == 2 || motion == 3 || motion >= 12;
    const int raw = static_cast<int>(motionAge/12), pattern = looping ? raw%4 == 3 ? 1 : raw%4 : std::min(2,raw);
    std::array<float,4> color{}; if (selection(false,static_cast<int>(index)) && tick/15%2==0) color = {1,1,1,64.0F/255};
    const auto flash = session_.effectColor(1,actor.id); if (flash[3] > color[3]) color = flash;
    core_.renderer().queueImage(source.handle,{1,0,0,1,x-w/2.0F,y-h},
      {float((motion/6*3+pattern)*w),float(motion%6*h),float(w),float(h)},1,0xffffff,BlendMode::normal,{},color);
    if (weaponImage > 0 && motionAge < 36) {
      const int page = (weaponImage-1)/12+1, weapon = (weaponImage-1)%12;
      const auto sheet = image("img/system/Weapons"+std::to_string(page)+".png");
      quad(sheet.handle,(weapon/6*3+motionAge/12)*96,weapon%6*64,96,64,x-64,y-64,96,64);
    }
    if (overlay > 0) { const auto sheet = image("img/system/States.png"); quad(sheet.handle,tick/8%8*96,(overlay-1)*96,96,96,x-48,y-96,96,96); }
  }
}
}  // namespace pmjs::mv
