#include "mv_core_display.hpp"
#include <cmath>

namespace pmjs::mv::core {
Weather::Weather(){width=Graphics::width;height=Graphics::height;dimmer_=std::make_shared<ScreenSprite>();dimmer_->setColor(80,80,80);addChild(dimmer_);}
int Weather::randomInt(int maximum){if(maximum<=0)return 0;return random?int(std::floor(random()*maximum)):std::uniform_int_distribution<int>(0,maximum-1)(randomEngine_);}
std::shared_ptr<PixelBitmap> Weather::bitmap(int kind) {
  auto& result=bitmaps_[kind];if(result)return result;
  const int w=kind==1?2:kind==2?9:1,h=kind==1?100:kind==2?9:60;
  result=std::make_shared<PixelBitmap>(w,h);if(kind==2)result->drawCircle(4,4,4,"white");else result->fillAll("white");return result;
}
void Weather::update() {
  dimmer_->setOpacity(std::floor(power*6));
  const auto count=std::size_t(std::max(0.0,std::floor(power*10)));
  while(particles_.size()<count){auto sprite=std::make_shared<Sprite>();sprite->setOpacity(0);addChild(sprite);particles_.push_back({sprite,0,0});}
  while(particles_.size()>count){removeChild(particles_.back().sprite.get());particles_.pop_back();}
  const int kind=type=="rain"?0:type=="storm"?1:type=="snow"?2:-1;
  for(auto& particle:particles_) {
    auto& sprite=*particle.sprite;
    if(kind>=0){sprite.setBitmap(bitmap(kind));sprite.rotation=3.14159265358979323846/(kind==1?8:16);const double speed=kind==1?8:kind==2?3:6;
      particle.ax-=speed*std::sin(sprite.rotation);particle.ay+=speed*std::cos(sprite.rotation);sprite.setOpacity(sprite.opacity()-speed);}
    if(sprite.opacity()<40){particle.ax=randomInt(Graphics::width+100)-100+origin.x;particle.ay=randomInt(Graphics::height+200)-200+origin.y;sprite.setOpacity(160+randomInt(60));}
    sprite.position={particle.ax-origin.x,particle.ay-origin.y};
  }
}
void Weather::synchronize(std::uint64_t frame){const auto steps=lastFrame_&&frame>=*lastFrame_?frame-*lastFrame_:1;lastFrame_=frame;for(std::uint64_t i=0;i<steps;++i)update();}
}
