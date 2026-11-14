#pragma once
#include "mv_core_display.hpp"
#include "mv_sprites.hpp"
#include "mv_core_utils.hpp"

namespace pmjs::mv {
class BoundSpriteContext : public core::Sprite {
 public:
  virtual Session& modelSession() const = 0;
  virtual std::shared_ptr<core::PixelBitmap> modelBitmap(const std::string& method,const Value::Array& arguments,const std::string& slot = "") = 0;
};
class TimerSprite : public BoundSpriteContext {
 public:
  Sprite_Timer state;
  explicit TimerSprite(bool=false) {}
  virtual void initialize() { state.totalSeconds=-1; createBitmap(); update(); }
  virtual void createBitmap() { setBitmap(modelBitmap("createBitmap",{96,48})); bitmap()->fontSize=32; }
  virtual std::string timerText() const { Sprite_Timer text; text.update(state.totalSeconds*60); return text.text; }
  virtual void redraw() { const auto image=bitmap(); if (!image) return; image->clear(); image->drawText(timerText(),0,0,image->width,image->height,"center"); }
  virtual void updateBitmap() { const auto seconds=modelSession().invokeGameDataBase("timer","seconds",{}).integer(); if (state.totalSeconds!=seconds) { state.totalSeconds=seconds; redraw(); } }
  virtual void updatePosition() { position={double(modelSession().screenWidth()-(bitmap() ? bitmap()->width : 0)),0}; }
  virtual void updateVisibility() { visible=modelSession().invokeGameDataBase("timer","isWorking",{}).boolean(); }
  void update() override { core::Sprite::update(); updateBitmap(); updatePosition(); updateVisibility(); }
};
class WeaponSprite : public BoundSpriteContext {
 public:
  Sprite_Weapon state;
  explicit WeaponSprite(bool=false) {}
  virtual void initialize() { initMembers(); }
  virtual void initMembers() { state=Sprite_Weapon{}; anchor={0.5,1}; position.x=-16; }
  virtual void loadBitmap() { setBitmap(modelBitmap("loadSystem",{"Weapons"+std::to_string(state.pageId())})); }
  virtual void updateFrame() { const auto& f=state.frame; setFrame(f.x,f.y,f.width,f.height); }
  virtual void setup(int id) { state.setup(id); loadBitmap(); updateFrame(); }
  virtual bool isPlaying() const { return state.isPlaying(); }
  virtual int animationWait() const { return 12; }
  void update() override { core::Sprite::update(); state.update(); updateFrame(); }
};
class DamageSprite : public BoundSpriteContext {
 public:
  Sprite_Damage state;
  ActionResult result;
  std::shared_ptr<core::PixelBitmap> damageBitmap;
  std::vector<std::shared_ptr<core::Sprite>> digits;
  explicit DamageSprite(bool=false) {}
  virtual void initialize() { state=Sprite_Damage{}; damageBitmap=modelBitmap("loadSystem",{"Damage"}); }
  virtual void setup(std::shared_ptr<RuntimeActor> actor) { if (!actor) return; result=actor->value().result; state.setup(result); rebuild(); }
  virtual int digitWidth() const { return damageBitmap ? damageBitmap->width/10 : 0; }
  virtual int digitHeight() const { return damageBitmap ? damageBitmap->height/5 : 0; }
  virtual void createMiss() { result.missed=true; rebuild(); }
  virtual void createDigits(int row,int value) { result=ActionResult{}; result.hpAffected=row==0; if (result.hpAffected) result.hpDamage=value; else result.mpDamage=value; rebuild(); }
  virtual void setupCriticalEffect() { result.critical=true; state.isCritical=true; state.flashDuration=60; }
  virtual bool isPlaying() const { return state.isPlaying(); }
  void rebuild() {
    for (const auto& digit:digits) removeChild(digit.get()); digits.clear();
    if (!damageBitmap) return;
    for (const auto& cell:Sprite_Damage::popup(result,0,damageBitmap->width,damageBitmap->height)) {
      auto digit=std::make_shared<core::Sprite>(); digit->setBitmap(damageBitmap); digit->setFrame(cell.source.x,cell.source.y,cell.source.width,cell.source.height); addChild(digit); digits.push_back(digit);
    }
  }
  void update() override {
    core::Sprite::update(); state.update();
    if (!damageBitmap) return;
    const auto cells=Sprite_Damage::popup(result,std::clamp(90-state.duration,0,90),damageBitmap->width,damageBitmap->height);
    for (std::size_t i=0;i<digits.size();++i) {
      digits[i]->visible=i<cells.size(); if (i>=cells.size()) continue;
      digits[i]->position={cells[i].x,cells[i].y}; digits[i]->alpha=cells[i].opacity; digits[i]->setBlendColor(cells[i].blendColor);
    }
  }
};
class StateOverlaySprite : public BoundSpriteContext {
 public:
  Sprite_StateOverlay state;
  std::shared_ptr<RuntimeActor> battler;
  explicit StateOverlaySprite(bool=false) {}
  virtual void initialize() { initMembers(); loadBitmap(); }
  virtual void initMembers() { state=Sprite_StateOverlay{}; battler.reset(); anchor={0.5,1}; }
  virtual void loadBitmap() { setBitmap(modelBitmap("loadSystem",{"States"})); }
  virtual void setup(std::shared_ptr<RuntimeActor> actor) { battler=std::move(actor); state.setup(battler ? &battler->value() : nullptr); }
  virtual int animationWait() const { return 8; }
  virtual void updatePattern() { state.advance(modelSession(),8); }
  virtual void updateFrame() { const auto& f=state.frame; setFrame(f.x,f.y,f.width,f.height); }
  void update() override { core::Sprite::update(); state.update(modelSession()); updateFrame(); }
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
class CharacterSprite : public BoundSpriteContext {
 public:
  Sprite_Character state;
  std::shared_ptr<RuntimeCharacter> character;
  std::shared_ptr<core::Sprite> upperBody,lowerBody;
  int tilesetId=0,tileId=0,loadedIndex=0;
  std::string loadedName;
  bool hiding=false;
  explicit CharacterSprite(bool=false) {}
  virtual void initializeCharacter(std::shared_ptr<RuntimeCharacter> value) { initMembers(); setCharacter(std::move(value)); }
  virtual void initMembers() { anchor={0.5,1}; hiding=false; tilesetId=tileId=loadedIndex=0; loadedName.clear(); state=Sprite_Character{}; }
  virtual void setCharacter(std::shared_ptr<RuntimeCharacter> value) { character=std::move(value); state.setCharacter(character ? &character->value() : nullptr); }
  virtual bool isTile() const { return tileId>0; }
  virtual bool isObjectCharacter() const { return character && (character->value().tileId>0 || ImageManager::isObjectCharacter(character->value().characterName)); }
  virtual bool isImageChanged() const {
    return character && (tilesetId!=modelSession().mapState().tilesetId || tileId!=character->value().tileId || loadedName!=character->value().characterName || loadedIndex!=character->value().characterIndex);
  }
  virtual void setCharacterBitmap() { setBitmap(modelBitmap("loadCharacter",{loadedName})); }
  virtual void setTileBitmap() { setBitmap(modelBitmap("loadTileset",{modelSession().database()["tilesets"][tilesetId]["tilesetNames"][5+tileId/256].text()})); }
  virtual void updateBitmap() {
    if (!isImageChanged()) return;
    tilesetId=modelSession().mapState().tilesetId; tileId=character->value().tileId; loadedName=character->value().characterName; loadedIndex=character->value().characterIndex;
    if (isTile()) setTileBitmap(); else setCharacterBitmap();
  }
  virtual void updateHalfBodySprites() {
    if (state.bushDepth>0) {
      if (!upperBody) { upperBody=std::make_shared<core::Sprite>(); upperBody->anchor={0.5,1}; addChild(upperBody); }
      if (!lowerBody) { lowerBody=std::make_shared<core::Sprite>(); lowerBody->anchor={0.5,1}; lowerBody->setOpacity(128); addChild(lowerBody); }
      upperBody->visible=lowerBody->visible=true; upperBody->setBitmap(bitmap()); lowerBody->setBitmap(bitmap());
      upperBody->position.y=-state.bushDepth;
    } else { if (upperBody) upperBody->visible=false; if (lowerBody) lowerBody->visible=false; }
  }
  virtual void updateCharacterFrame() {
    const auto image=bitmap(); if (!image) return;
    const auto frame=state.sourceFrame(image->width,image->height,modelSession().tileWidth(),modelSession().tileHeight());
    updateHalfBodySprites();
    if (state.bushDepth>0) {
      const double depth=std::min<double>(state.bushDepth,frame.height);
      upperBody->setFrame(frame.x,frame.y,frame.width,frame.height-depth);
      lowerBody->setFrame(frame.x,frame.y+frame.height-depth,frame.width,depth);
      setFrame(frame.x,frame.y,0,frame.height);
    } else setFrame(frame.x,frame.y,frame.width,frame.height);
  }
  virtual void updateTileFrame() { updateCharacterFrame(); }
  virtual void updateFrame() { if (isTile()) updateTileFrame(); else updateCharacterFrame(); }
  virtual void updatePosition() { const auto point=modelSession().runtimeCharacterScreenPosition(character); position={point[0]+character->value().spriteOffsetX,point[1]+character->value().spriteOffsetY}; z=character->value().tileId ? 1 : 3; }
  virtual void updateOther() { setOpacity(character->value().opacity); blendMode=static_cast<BlendMode>(std::clamp(character->value().blendMode,0,3)); updateVisibility(); }
  virtual void updateVisibility() { visible=character && !hiding && !character->value().transparent; }
  virtual void hide() { hiding=true; updateVisibility(); }
  virtual void show() { hiding=false; updateVisibility(); }
  void update() override { core::Sprite::update(); if (!character) return; state.setCharacter(&character->value()); updateBitmap(); updateFrame(); updatePosition(); updateOther(); }
};
class NativeSpriteset : public BoundSpriteContext {
 public:
  std::shared_ptr<Spriteset_Base> model=std::make_shared<Spriteset_Base>();
  std::shared_ptr<core::Sprite> baseSprite,pictureContainer,timerSprite;
  std::shared_ptr<core::ScreenSprite> blackScreen;
  explicit NativeSpriteset(bool=false) {}
  virtual void initialize() { createLowerLayer(); createUpperLayer(); update(); }
  virtual void createLowerLayer() { createBaseSprite(); createToneChanger(); }
  virtual void createUpperLayer() { createPictures(); createTimer(); createScreenSprites(); }
  virtual void createBaseSprite() { baseSprite=std::make_shared<core::Sprite>(); addChild(baseSprite); blackScreen=std::make_shared<core::ScreenSprite>(); blackScreen->setBlack(); baseSprite->addChild(blackScreen); }
  virtual void createToneChanger() { baseSprite->addChild(model->toneSprite); }
  virtual void createPictures() { pictureContainer=std::make_shared<core::Sprite>(); addChild(pictureContainer); }
  virtual void createTimer() { timerSprite=std::make_shared<core::Sprite>(); addChild(timerSprite); }
  virtual void createScreenSprites() { model->fadeSprite->setBlack(); addChild(model->flashSprite); addChild(model->fadeSprite); }
  virtual void updateToneChanger() { model->updateTone(modelSession()); }
  virtual void updateScreenSprites() { model->updateScreen(modelSession()); }
  virtual void updatePosition() { const auto transform=modelSession().screenTransform(); scale={transform[0],transform[3]}; position={transform[4],transform[5]}; }
  void update() override { core::Sprite::update(); updateToneChanger(); updateScreenSprites(); updatePosition(); }
};
class NativeMapSpriteset : public NativeSpriteset {
 public:
  explicit NativeMapSpriteset(bool=false) { model=std::make_shared<Spriteset_Map>(); }
};
class NativeBattleSpriteset : public NativeSpriteset {
 public:
  std::shared_ptr<core::Sprite> battleField,back1Sprite,back2Sprite;
  explicit NativeBattleSpriteset(bool=false) { model=std::make_shared<Spriteset_Battle>(); }
  virtual void createBattleField() { battleField=std::make_shared<core::Sprite>(); baseSprite->addChild(battleField); }
  virtual void createBattleback() {
    back1Sprite=std::make_shared<core::Sprite>(); back2Sprite=std::make_shared<core::Sprite>();
    battleField->addChild(back1Sprite); battleField->addChild(back2Sprite);
    back1Sprite->setBitmap(modelBitmap("loadBattleback1",{modelSession().mapState().battleback1Name.text()},"_back1Sprite"));
    back2Sprite->setBitmap(modelBitmap("loadBattleback2",{modelSession().mapState().battleback2Name.text()},"_back2Sprite"));
    locateBattleback();
  }
  virtual void locateBattleback() {
    for (const auto& sprite:{back1Sprite,back2Sprite}) if (sprite && sprite->bitmap()) {
      sprite->position={double(modelSession().screenWidth()-sprite->bitmap()->width)/2,double(modelSession().screenHeight()-sprite->bitmap()->height)};
    }
  }
  virtual void updateBattleback() { locateBattleback(); }
  void createLowerLayer() override { NativeSpriteset::createLowerLayer(); createBattleField(); createBattleback(); }
};
}
