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
  const auto& state = session_.screenEffects_;
  const auto type = state["_weatherType"].text();
  const float power = std::max(0.0, state["_weatherPower"].number());
  if (type == "none" || type.empty() || power <= 0) { weatherParticles_.clear(); weatherTick_ = session_.ticks_; return; }
  const int kind = type == "storm" ? 1 : type == "snow" ? 2 : 0;
  const int width = kind == 1 ? 2 : kind == 2 ? 9 : 1, height = kind == 1 ? 100 : kind == 2 ? 9 : 60;
  if (!weatherSurfaces_[kind]) {
    const auto surface = core_.canvases().create(width, height);
    if (!surface) throw std::runtime_error("cannot create weather sprite");
    weatherSurfaces_[kind] = surface->handle;
    if (kind == 2) {
      CanvasCirclePaint circle; circle.x = 4; circle.y = 4; circle.radius = 4; circle.paint.color = 0xffffffff;
      core_.canvases().paintCircle(surface->handle, circle);
    } else core_.canvases().fillRect(surface->handle, 0, 0, width, height, 0xffffffff);
  }
  weatherParticles_.resize(static_cast<std::size_t>(std::floor(power*10)));
  const double angle = 3.14159265358979323846/(kind == 1 ? 8 : 16);
  const float sine = std::sin(angle), cosine = std::cos(angle), speed = kind == 1 ? 8 : kind == 2 ? 3 : 6;
  const auto& tiled = session_.database_["tiledMaps"][std::to_string(session_.mapId_)];
  const float originX = cameraX_*tiled["tilewidth"].integer(48), originY = cameraY_*tiled["tileheight"].integer(48);
  const auto random = [&](int limit) { return std::uniform_int_distribution<int>(0, limit-1)(weatherRandom_); };
  const std::uint64_t steps = session_.ticks_ >= weatherTick_ ? session_.ticks_-weatherTick_ : 1;
  for (std::uint64_t tick = 0; tick < steps; ++tick) for (auto& particle : weatherParticles_) {
    particle.x -= speed*sine; particle.y += speed*cosine; particle.opacity -= speed;
    if (particle.opacity < 40) {
      particle.x = random(core_.width()+100)-100+originX; particle.y = random(core_.height()+200)-200+originY;
      particle.opacity = 160+random(60);
    }
  }
  weatherTick_ = session_.ticks_;
  core_.renderer().queueQuad(0, 0, core_.width(), core_.height(), {80.0F/255,80.0F/255,80.0F/255,std::floor(power*6)/255});
  const auto texture = core_.canvases().prepareImage(weatherSurfaces_[kind]);
  if (!texture) return;
  for (const auto& particle : weatherParticles_) core_.renderer().queueImage(*texture,
    {cosine,sine,-sine,cosine,particle.x-originX,particle.y-originY}, {0,0,float(width),float(height)}, particle.opacity/255, 0xffffff, BlendMode::normal);
}
}  // namespace pmjs::mv
