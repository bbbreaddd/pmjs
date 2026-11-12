#include "mv_presentation.hpp"
#include "mv_core_utils.hpp"
#include <cmath>
#include <algorithm>

namespace pmjs::mv {
void Presentation::animationCells(const Value& animation,int frame,float baseX,float baseY,bool mirror) {
  for (const auto& cell : Sprite_Animation::cells(animation, frame, mirror)) {
    if (cell.name.empty()) continue;
    const auto source = image("img/animations/" + cell.name + ".png", cell.hue);
    auto transform = cell.transform;
    transform[4] += baseX; transform[5] += baseY;
    core_.renderer().queueImage(source.handle, transform,
      {float(cell.source.x), float(cell.source.y), float(cell.source.width), float(cell.source.height)},
      cell.opacity, 0xffffff, static_cast<BlendMode>(std::clamp(cell.blendMode, 0, 3)));
  }
}
void Presentation::visualEffects() {
  const auto& tiled=session_.database_["tiledMaps"][std::to_string(session_.mapId_)];
  const int tw=tiled["tilewidth"].integer(48),th=tiled["tileheight"].integer(48);
  for(const auto& effect:session_.visualEffects_) {
    if(session_.ticks_<effect.started||effect.duplicated)continue;
    float x=0,y=0,height=th;
    if(effect.targetType==0) {
      if(session_.battle_.active)continue;
      Interpreter context;context.mapId=session_.mapId_;context.eventId=effect.targetId;
      const auto* character=session_.routeCharacter(effect.targetId,context);if(!character)continue;
      x=std::floor(scrolledMapX(character->realX,cameraX_,tw)*tw+tw/2.0+0.5)+character->spriteOffsetX;
      const double jump=character->jumpCount>0?(character->jumpPeak*character->jumpPeak-std::pow(std::abs(character->jumpCount-character->jumpPeak),2))/2.0:0;
      const bool object=character->tileId>0||ImageManager::isObjectCharacter(character->characterName);
      y=std::floor(scrolledMapY(character->realY,cameraY_,th)*th+th-(object?0:6)-jump+0.5)+character->spriteOffsetY;
      if(!character->characterName.empty()) {
        const auto bitmap=image("img/characters/"+character->characterName+".png");
        Sprite_Character sprite;sprite.setCharacter(character);
        height=sprite.sourceFrame(bitmap.width,bitmap.height,tw,th).height;
      }
    } else if(effect.targetType==2) {
      if(!session_.battle_.active||effect.targetId>=static_cast<int>(session_.battle_.enemies.size()))continue;
      const auto& enemy=session_.battle_.enemies[effect.targetId];
      const auto& member=session_.database_["troops"][session_.battle_.troopId]["members"][effect.targetId];
      x=member["x"].number();y=member["y"].number();
      if(const auto* sprite=session_.enemySprite(effect.targetId))x+=sprite->shake;
      const auto name=session_.database_["enemies"][enemy.id]["battlerName"].text();
      if(!name.empty())height=image(std::string("img/")+(session_.database_["system"]["optSideView"].boolean()?"sv_enemies/":"enemies/")+name+".png").height;
    } else {
      if (!session_.battle_.active) continue;
      if (!session_.database_["system"]["optSideView"].boolean()) continue;
      const auto it=std::find(session_.party_.begin(),session_.party_.end(),effect.targetId);if(it==session_.party_.end())continue;
      const int index=static_cast<int>(it-session_.party_.begin());x=600+index*32;y=280+index*48;
      const auto& actor=session_.actors_.at(*it);
      height=actor.battlerName.empty()?0:image("img/sv_actors/"+actor.battlerName+".png").height/6.0;
    }
    const int age=static_cast<int>(session_.ticks_-effect.started);
    if(effect.balloon) {
      const auto source=image("img/system/Balloon.png");
      const auto frame=Sprite_Balloon::sourceFrame(age,effect.animationId);
      if(frame.width>0)quad(source.handle,frame.x,frame.y,frame.width,frame.height,x-24,y-height-48,frame.width,frame.height);
    } else {
      const auto& animation=session_.database_["animations"][effect.animationId];const int position=animation["position"].integer();
      if(position==0)y-=height;else if(position==1)y-=height/2;
      else if(position==3){x=core_.width()/2.0;y=core_.height()/2.0;}
      animationCells(animation,Sprite_Animation::frameAtAge(animation,age),x,y,effect.mirror);
      if(effect.screenFlashDuration>0&&effect.screenFlash[3]>0)
        core_.renderer().queueQuad(0,0,core_.width(),core_.height(),effect.screenFlash);
    }
  }
}
}
