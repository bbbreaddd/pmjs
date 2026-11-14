#pragma once
#include "mv_core_display.hpp"
#include "mv_sprites.hpp"

namespace pmjs::mv {
class BoundSpriteContext : public core::Sprite {
 public:
  virtual Session& modelSession() const = 0;
  virtual std::shared_ptr<core::PixelBitmap> modelBitmap(const std::string& method,const Value::Array& arguments) = 0;
};
class StateIconSprite : public BoundSpriteContext {
 public:
  Sprite_StateIcon state;
  std::shared_ptr<RuntimeActor> battler;
  explicit StateIconSprite(bool = false) {}
  virtual void initialize() { initMembers(); loadBitmap(); }
  virtual void initMembers() { state=Sprite_StateIcon{}; battler.reset(); anchor={0.5,0.5}; }
  virtual void loadBitmap() { setBitmap(modelBitmap("loadSystem",{"IconSet"})); setFrame(0,0,0,0); }
  virtual void setup(std::shared_ptr<RuntimeActor> actor) { battler=std::move(actor); state.setup(battler ? &battler->value() : nullptr); }
  virtual int animationWait() const { return 40; }
  virtual void updateIcon() { state.setup(battler ? &battler->value() : nullptr); state.updateIcon(modelSession()); }
  virtual void updateFrame() { state.updateFrame(); const auto& f=state.frame; setFrame(f.x,f.y,f.width,f.height); }
  void update() override { core::Sprite::update(); if (state.advanceCount(1,animationWait())) { updateIcon(); updateFrame(); } }
};
}
