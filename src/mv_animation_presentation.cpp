#include "mv_presentation.hpp"
#include <cmath>
#include <algorithm>

namespace pmjs::mv {
void Presentation::animationCells(const Value& animation,int frame,float baseX,float baseY,bool mirror) {
  for(const auto& cell:animation["frames"][frame].array()) {
    const int pattern=cell[0].integer(-1);if(pattern<0)continue;
    const auto name=animation[pattern<100?"animation1Name":"animation2Name"].text();if(name.empty())continue;
    const auto source=image("img/animations/"+name+".png",animation[pattern<100?"animation1Hue":"animation2Hue"].integer());
    const float rotation=cell[4].number()*3.14159265358979323846/180*(mirror?-1:1);
    const float sy=cell[3].number()/100,sx=sy*(cell[5].boolean()!=mirror?-1:1);
    const float a=std::cos(rotation)*sx,b=std::sin(rotation)*sx,c=-std::sin(rotation)*sy,d=std::cos(rotation)*sy;
    const float x=baseX+cell[1].number()*(mirror?-1:1),y=baseY+cell[2].number();
    core_.renderer().queueImage(source.handle,{a,b,c,d,x-96*(a+c),y-96*(b+d)},
      {float(pattern%5*192),float(pattern%100/5*192),192,192},cell[6].number()/255,0xffffff,
      static_cast<BlendMode>(std::clamp(cell[7].integer(),0,3)));
  }
}
void Presentation::visualEffects() {
  const auto& tiled=session_.database_["tiledMaps"][std::to_string(session_.mapId_)];
  const int tw=tiled["tilewidth"].integer(48),th=tiled["tileheight"].integer(48);
  for(const auto& effect:session_.visualEffects_) {
    float x=0,y=0,height=th;
    if(effect.targetType==0) {
      if(session_.battle_.active)continue;
      Interpreter context;context.mapId=session_.mapId_;context.eventId=effect.targetId;
      const auto* character=session_.routeCharacter(effect.targetId,context);if(!character)continue;
      x=session_.deltaMapX(character->realX,cameraX_)*tw+tw/2.0;
      const double jump=character->jumpCount>0?(character->jumpPeak*character->jumpPeak-std::pow(std::abs(character->jumpCount-character->jumpPeak),2))/2.0:0;
      y=session_.deltaMapY(character->realY,cameraY_)*th+th-6-jump+character->spriteOffsetY;
      if(!character->characterName.empty()) {
        const auto bitmap=image("img/characters/"+character->characterName+".png");
        const bool big=character->characterName.find('$')<2;height=bitmap.height/(big?4.0:8.0);
      }
    } else if(effect.targetType==2) {
      if(!session_.battle_.active||effect.targetId>=static_cast<int>(session_.battle_.enemies.size()))continue;
      const auto& enemy=session_.battle_.enemies[effect.targetId];
      const auto& member=session_.database_["troops"][session_.battle_.troopId]["members"][effect.targetId];
      x=member["x"].number();y=member["y"].number();
      const auto name=session_.database_["enemies"][enemy.id]["battlerName"].text();
      if(!name.empty())height=image(std::string("img/")+(session_.database_["system"]["optSideView"].boolean()?"sv_enemies/":"enemies/")+name+".png").height;
    } else {
      if (!session_.battle_.active) continue;
      const auto it=std::find(session_.party_.begin(),session_.party_.end(),effect.targetId);if(it==session_.party_.end())continue;
      const int index=static_cast<int>(it-session_.party_.begin());x=600+index*32;y=280+index*48;height=64;
    }
    const int age=static_cast<int>(session_.ticks_-effect.started);
    if(effect.balloon) {
      const auto source=image("img/system/Balloon.png");
      quad(source.handle,std::min(age/8,7)*48,(effect.animationId-1)*48,48,48,x-24,y-height-48,48,48);
    } else {
      const auto& animation=session_.database_["animations"][effect.animationId];const int position=animation["position"].integer();
      if(position==0)y-=height;else if(position==1)y-=height/2;
      else if(position==3){x=core_.width()/2.0;y=core_.height()/2.0;}
      animationCells(animation,age/4,x,y,effect.mirror);
    }
  }
}
}
