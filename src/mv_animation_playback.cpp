#include "mv_engine.hpp"
#include <algorithm>

namespace pmjs::mv {
int Session::requestAnimation(int targetType,int targetId,int animationId,bool mirror,bool balloon) {
  if(animationId<=0)return 0;
  const auto& animation=database_["animations"][animationId];
  if(!balloon&&animation.null())return 0;
  VisualEffect effect;
  if(targetType==0 && targetId<0)targetId=-1;
  effect.serial=++nextVisualEffect_;effect.targetType=targetType;effect.targetId=targetId;effect.animationId=animationId;
  effect.started=ticks_;effect.mirror=mirror;effect.balloon=balloon;
  effect.duration=balloon?76:static_cast<int>(animation["frames"].array().size())*4+1;
  visualEffects_.push_back(effect);return effect.serial;
}
void Session::updateVisualEffects() {
  for(auto& effect:visualEffects_) {
    if(effect.flashDuration>0) { effect.flash[3]*=float(effect.flashDuration-1)/effect.flashDuration; --effect.flashDuration; }
    if(effect.hideDuration>0)--effect.hideDuration;
    if(effect.balloon)continue;
    const int frame=static_cast<int>(ticks_-effect.started)/4;
    if(frame==effect.lastTimingFrame)continue;
    effect.lastTimingFrame=frame;
    for(const auto& timing:database_["animations"][effect.animationId]["timings"].array()) if(timing["frame"].integer()==frame) {
      audio("se",timing["se"]);
      const int scope=timing["flashScope"].integer(),duration=timing["flashDuration"].integer()*4;
      if(scope==1) { for(int i=0;i<4;++i)effect.flash[i]=timing["flashColor"][i].number()/255; effect.flashDuration=duration; }
      else if(scope==3)effect.hideDuration=duration;
      if(scope==2) {
        Interpreter context;
        screenEventCommand(Value::Object{{"code",224},{"parameters",Value::Array{timing["flashColor"],timing["flashDuration"].integer()*4,false}}},context);
      }
    }
  }
  std::erase_if(visualEffects_,[&](const VisualEffect& effect){return ticks_-effect.started>=static_cast<std::uint64_t>(effect.duration);});
}
std::array<float,4> Session::effectColor(int type,int id) const {
  std::array<float,4> result{};
  for(const auto& effect:visualEffects_) if(effect.targetType==type&&effect.targetId==id&&effect.flashDuration>0&&effect.flash[3]>result[3])result=effect.flash;
  return result;
}
bool Session::effectHidden(int type,int id) const {
  return std::any_of(visualEffects_.begin(),visualEffects_.end(),[&](const VisualEffect& effect){return effect.targetType==type&&effect.targetId==id&&effect.hideDuration>0;});
}

}
