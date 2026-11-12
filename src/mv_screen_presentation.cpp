#include "mv_presentation.hpp"
#include "mv_sprites.hpp"
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace pmjs::mv {
void Presentation::screenTone() {
  const auto& tone=session_.screenEffects_["_tone"];
  if(tone[0].number()==0&&tone[1].number()==0&&tone[2].number()==0&&tone[3].number()==0)return;
  core::ToneFilter filter;filter.adjustTone(tone[0].number(),tone[1].number(),tone[2].number());filter.adjustSaturation(-tone[3].number());filter.apply(core_.renderer());
}
void Presentation::finishScreen(std::size_t first) {
  const int width = core_.width(), height = core_.height();
  const auto& screen = session_.screenEffects_;
  if (session_.timerWorking_) {
    Sprite_Timer timer; timer.update(session_.timerFrames_);
    if (!timerCanvas_) { const auto surface = core_.canvases().create(96,48); if (surface) timerCanvas_ = surface->handle; }
    if (timerCanvas_) {
      core_.canvases().clear(timerCanvas_);
      core_.canvases().drawText(timerCanvas_,fonts_,timer.text,0,36,32,0x000000ff,4);
      core_.canvases().drawText(timerCanvas_,fonts_,timer.text,0,36,32,0xffffffff);
      if (const auto image = core_.canvases().prepareImage(timerCanvas_)) quad(*image,0,0,96,48,width-96,0,96,48);
    }
  }
  const auto& flash = screen["_flashColor"];
  if (flash[3].number() > 0) core_.renderer().queueQuad(0, 0, width, height,
    {float(flash[0].number()/255),float(flash[1].number()/255),float(flash[2].number()/255),float(flash[3].number()/255)});
  if (session_.brightness_ < 255) core_.renderer().queueQuad(0, 0, width, height, {0,0,0,float(1-session_.brightness_/255)});
  const float scale = screen["_zoomScale"].number(1);
  const float x = std::floor(-screen["_zoomX"].number()*(scale-1)+0.5) + std::floor(screen["_shake"].number()+0.5);
  const float y = std::floor(-screen["_zoomY"].number()*(scale-1)+0.5);
  core_.renderer().transformQueuedCommands(first, {scale,0,0,scale,x,y});
}
void Presentation::weather() {
  if(!coreWeather_)coreWeather_=std::make_unique<core::Weather>();
  coreWeather_->type=session_.screenEffects_["_weatherType"].text();
  coreWeather_->power=session_.screenEffects_["_weatherPower"].number();coreWeather_->width=core_.width();coreWeather_->height=core_.height();
  const auto& tiled=session_.database_["tiledMaps"][std::to_string(session_.mapId_)];
  coreWeather_->origin={cameraX_*tiled["tilewidth"].integer(48),cameraY_*tiled["tileheight"].integer(48)};
  coreWeather_->synchronize(session_.ticks_);coreWeather_->render(core_.renderer());
}
}  // namespace pmjs::mv
