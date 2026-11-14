#include "mv_core_display.hpp"
#include <cmath>

namespace pmjs::mv::core {
Weather::Weather(bool initializeNow) { if (initializeNow) initialize(); }
void Weather::initialize() {
  width=Graphics::width; height=Graphics::height;
  removeChildren(); sprites.clear(); dimmerSprite.reset();
  createBitmaps(); createDimmer(); type="none"; power=0; origin={};
}
void Weather::createBitmaps() { for (int kind=0;kind<3;++kind) { bitmaps_[kind].reset(); bitmap(kind); } }
void Weather::createDimmer() {
  dimmerSprite=std::make_shared<ScreenSprite>(); dimmerSprite->setColor(80,80,80); addChild(dimmerSprite);
}
void Weather::updateDimmer() { if (dimmerSprite) dimmerSprite->setOpacity(std::floor(power*6)); }
void Weather::addSprite() {
  auto sprite=std::make_shared<Sprite>(); sprite->setOpacity(0); addChild(sprite); sprites.push_back(sprite);
}
void Weather::removeSprite() {
  if (sprites.empty()) return;
  auto sprite=sprites.back();sprites.pop_back();if(sprite&&sprite->parent==this)removeChild(sprite.get());
}
int Weather::randomInt(int maximum){if(maximum<=0)return 0;return random?int(std::floor(random()*maximum)):std::uniform_int_distribution<int>(0,maximum-1)(randomEngine_);}
std::shared_ptr<PixelBitmap> Weather::bitmap(int kind) {
  auto& result=bitmaps_[kind];if(result)return result;
  const int w=kind==1?2:kind==2?9:1,h=kind==1?100:kind==2?9:60;
  result=std::make_shared<PixelBitmap>(w,h);if(kind==2)result->drawCircle(4,4,4,"white");else result->fillAll("white");return result;
}
void Weather::update() {
  updateDimmer(); updateAllSprites();
}
void Weather::updateAllSprites() {
  const auto count=std::size_t(std::max(0.0,std::floor(power*10)));
  while(sprites.size()<count) addSprite();
  while(sprites.size()>count) removeSprite();
  const int kind=type=="rain"?0:type=="storm"?1:type=="snow"?2:-1;
  for(const auto& node:sprites) {
    const auto particle=std::dynamic_pointer_cast<Sprite>(node);if(!particle)continue;
    auto& sprite=*particle;
    if(kind>=0){sprite.setBitmap(bitmap(kind));sprite.rotation=3.14159265358979323846/(kind==1?8:16);const double speed=kind==1?8:kind==2?3:6;
      sprite.ax-=speed*std::sin(sprite.rotation);sprite.ay+=speed*std::cos(sprite.rotation);sprite.setOpacity(sprite.opacity()-speed);}
    if(sprite.opacity()<40){sprite.ax=randomInt(Graphics::width+100)-100+origin.x;sprite.ay=randomInt(Graphics::height+200)-200+origin.y;sprite.setOpacity(160+randomInt(60));}
    sprite.position={sprite.ax-origin.x,sprite.ay-origin.y};
  }
}
void Weather::synchronize(std::uint64_t frame){const auto steps=lastFrame_&&frame>=*lastFrame_?frame-*lastFrame_:1;lastFrame_=frame;for(std::uint64_t i=0;i<steps;++i)update();}
}
