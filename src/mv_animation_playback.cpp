#include "mv_engine.hpp"
#include "mv_sprites.hpp"
#include <algorithm>

namespace pmjs::mv {
int Session::requestAnimation(int targetType,int targetId,int animationId,bool mirror,bool balloon,int delayFrames) {
  if(animationId<=0)return 0;
  const auto& animation=database_["animations"][animationId];
  if(!balloon&&animation.null())return 0;
  VisualEffect effect;
  if(targetType==0 && targetId<0)targetId=-1;
  effect.serial=++nextVisualEffect_;effect.targetType=targetType;effect.targetId=targetId;effect.animationId=animationId;
  const bool screen=!balloon&&animation["position"].integer()==3;
  if(screen&&targetType!=0)delayFrames=0;
  effect.started=ticks_+static_cast<std::uint64_t>(std::max(0,delayFrames));effect.mirror=mirror;effect.balloon=balloon;
  effect.duplicated=screen&&std::any_of(visualEffects_.begin(),visualEffects_.end(),[&](const VisualEffect& existing){
    return !existing.balloon&&existing.animationId==animationId&&existing.started==effect.started;
  });
  effect.duration=balloon?Sprite_Balloon::durationFrames:Sprite_Animation::durationFor(animation);
  visualEffects_.push_back(effect);return effect.serial;
}
void Session::updateVisualEffects() {
  for(auto& effect:visualEffects_) {
    if(ticks_<effect.started)continue;
    if(effect.balloon)continue;
    const auto& animation=database_["animations"][effect.animationId];
    const int frame=Sprite_Animation::frameAtAge(animation,ticks_-effect.started);
    if(frame!=effect.lastTimingFrame) {
      effect.lastTimingFrame=frame;
      for(const auto& timing:Sprite_Animation::timings(animation,frame)) {
        if(timing.se&&!effect.duplicated)audio("se",*timing.se);
        if(timing.flashScope==1) { effect.flash=timing.flashColor; effect.flashDuration=timing.flashDuration; }
        else if(timing.flashScope==3)effect.hideDuration=timing.flashDuration;
        else if(timing.flashScope==2&&!effect.duplicated) {
          effect.screenFlash=timing.flashColor;
          effect.screenFlashDuration=timing.flashDuration;
        }
      }
    }
    Sprite_Animation::updateFlash(effect.flash,effect.flashDuration);
    Sprite_Animation::updateFlash(effect.screenFlash,effect.screenFlashDuration);
    if(effect.hideDuration>0)--effect.hideDuration;
  }
  std::erase_if(visualEffects_,[&](const VisualEffect& effect){return ticks_>=effect.started&&ticks_-effect.started>=static_cast<std::uint64_t>(effect.duration);});
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
