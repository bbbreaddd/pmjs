#pragma once
#include "mv_core_display.hpp"
#include "mv_sprites.hpp"
#include "mv_core_utils.hpp"
#include "mv_generated_bindings.hpp"

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
  virtual void setupCriticalEffect() { result.critical=true; state.isCritical=true; state.flashColor={255,0,0,160}; state.flashDuration=60; }
  virtual void updateFlash() { if (state.flashDuration > 0) { const int duration=state.flashDuration--; state.flashColor[3] *= (duration-1.0)/duration; } }
  virtual void updateOpacity() { if (state.duration < 10) setOpacity(255.0*state.duration/10); }
  virtual bool isPlaying() const { return state.isPlaying(); }
  void rebuild() {
    for (const auto& digit:digits) removeChild(digit.get()); digits.clear();
    if (!damageBitmap) return;
    for (const auto& cell:Sprite_Damage::popup(result,0,damageBitmap->width,damageBitmap->height)) {
      auto digit=std::make_shared<core::Sprite>(); digit->setBitmap(damageBitmap); digit->setFrame(cell.source.x,cell.source.y,cell.source.width,cell.source.height); addChild(digit); digits.push_back(digit);
    }
  }
  void update() override {
    core::Sprite::update();
    if (state.duration > 0) --state.duration;
    updateFlash(); updateOpacity();
    if (!damageBitmap) return;
    const auto cells=Sprite_Damage::popup(result,std::clamp(90-state.duration,0,90),damageBitmap->width,damageBitmap->height);
    for (std::size_t i=0;i<digits.size();++i) {
      digits[i]->visible=i<cells.size(); if (i>=cells.size()) continue;
      digits[i]->position={cells[i].x,cells[i].y}; digits[i]->alpha=1; digits[i]->setBlendColor(state.flashColor);
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
  std::shared_ptr<RuntimeBalloon> balloonSprite;
  std::shared_ptr<core::Sprite> upperBody,lowerBody;
  int tilesetId=0,tileId=0,loadedIndex=0;
  std::string loadedName;
  bool hiding=false;
  bool reflection=false;
  bool mapRenderConsumed=false;
  void render(Renderer& renderer,const core::Matrix& world={1,0,0,1,0,0},double opacity=1) override { if (!mapRenderConsumed) core::Sprite::render(renderer,world,opacity); }
  explicit CharacterSprite(bool=false) {}
  virtual void initializeCharacter(std::shared_ptr<RuntimeCharacter> value) { initMembers(); setCharacter(std::move(value)); }
  virtual void initMembers() { anchor={0.5,1}; hiding=false; tilesetId=tileId=loadedIndex=0; loadedName.clear(); state=Sprite_Character{}; }
  virtual void setCharacter(std::shared_ptr<RuntimeCharacter> value) { character=std::move(value); state.setCharacter(character ? &character->value() : nullptr); }
  virtual void setupBalloon() {
    const auto active = modelSession().runtimeCharacterBalloon(character);
    if (balloonSprite != active) {
      if (balloonSprite && balloonSprite->drawable->parent) balloonSprite->drawable->parent->removeChild(balloonSprite->drawable.get());
      balloonSprite = active;
      if (balloonSprite && parent) parent->addChild(balloonSprite->drawable);
    }
    if (balloonSprite) balloonSprite->drawable->position = {position.x, position.y - height()};
  }
  virtual void endBalloon() {
    modelSession().runtimeCharacterBalloon(character, true);
    if (balloonSprite && balloonSprite->drawable->parent) balloonSprite->drawable->parent->removeChild(balloonSprite->drawable.get());
    balloonSprite.reset();
  }
  virtual bool isTile() const { return tileId>0; }
  virtual bool isObjectCharacter() const { return character && (character->value().tileId>0 || ImageManager::isObjectCharacter(character->value().characterName)); }
  virtual int characterBlockX() const { return state.isBigCharacter ? 0 : loadedIndex % 4 * 3; }
  virtual int characterBlockY() const { return state.isBigCharacter ? 0 : loadedIndex / 4 * 4; }
  virtual int characterPatternX() const { return character ? character->value().pattern == 3 ? 1 : character->value().pattern : 0; }
  virtual int characterPatternY() const { return character ? (character->value().direction - 2) / 2 : 0; }
  virtual double patternWidth() const { return isTile() ? modelSession().tileWidth() : bitmap() ? bitmap()->width / (state.isBigCharacter ? 3.0 : 12.0) : 0; }
  virtual double patternHeight() const { return isTile() ? modelSession().tileHeight() : bitmap() ? bitmap()->height / (state.isBigCharacter ? 4.0 : 8.0) : 0; }
  virtual void updateAnimation() { setupBalloon(); }
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
    core::Rectangle frame;
    if (isTile()) frame = state.sourceFrame(image->width,image->height,modelSession().tileWidth(),modelSession().tileHeight());
    else {
      const double width = patternWidth(), height = patternHeight();
      frame = {(characterBlockX()+characterPatternX())*width, (characterBlockY()+characterPatternY())*height, width, height};
    }
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
  virtual void initializeReflection() { reflection=true;visible=false; }
  virtual void updateReflection() {
    if(!character)return;
    visible=character->reflections.arrayLength()>0;
    const auto& area=character->reflections[0];if(area.null())return;
    scale.y=core::numberValue(area["reflectionCast"])>0 ? -1 : 1;
    setOpacity(area["reflectionOpacity"].boolean() ? core::numberValue(area["reflectionOpacity"]) : 255);
  }
  virtual void updatePosition() {
    const auto area=reflection ? character->reflections[0].reference() : Value::undefined();
    const auto point=modelSession().runtimeCharacterScreenPosition(character);position={point[0],point[1]};
    z=modelSession().runtimeCharacterScreenZ(character);
    if(!area.null()) {
      const double cast=core::numberValue(area["reflectionCast"]);
      position.y+=modelSession().tileHeight()*cast;
      if(cast>0)position.y-=modelSession().tileHeight();
      position.y+=core::numberValue(area["reflectionOffset"]);
    }
  }
  virtual void updateOther() { setOpacity(character->value().opacity); blendMode=static_cast<BlendMode>(std::clamp(character->value().blendMode,0,3)); updateVisibility(); }
  virtual void updateVisibility() { visible=character && !hiding && !character->value().transparent; }
  virtual void hide() { hiding=true; updateVisibility(); }
  virtual void show() { hiding=false; updateVisibility(); }
  void update() override { core::Sprite::update(); if (!character) return; state.setCharacter(&character->value()); updateBitmap(); updateFrame(); updatePosition(); updateAnimation(); updateOther(); }
};
class NativePictureSprite : public BoundSpriteContext {
 public:
  std::shared_ptr<Sprite_Picture> state=std::make_shared<Sprite_Picture>(0);
  std::shared_ptr<RuntimePicture> currentPicture;
  bool mapRenderConsumed=false;
  explicit NativePictureSprite(bool=false) {}
  virtual void initializePicture(int id) { state=std::make_shared<Sprite_Picture>(id); isPicture=true; update(); }
  virtual void loadBitmap() { setBitmap(modelBitmap("loadPicture",{state->pictureName})); }
  virtual void updateBitmap() {
    currentPicture=modelSession().runtimePicture(state->pictureId);
    if(!currentPicture){state->pictureName.clear();setBitmap(nullptr);visible=false;return;}
    const auto previous=state->pictureName;
    state->syncFromPicture(currentPicture->state);
    if(previous!=state->pictureName)loadBitmap();
    visible=true;
  }
  virtual void updateOrigin() { anchor={state->anchor.x,state->anchor.y}; }
  virtual void updatePosition() { position={state->position.x,state->position.y}; }
  virtual void updateScale() { scale={state->scale.x,state->scale.y}; }
  virtual void updateTone() { setColorTone(currentPicture&&currentPicture->tone?currentPicture->tone->values:std::array<double,4>{}); }
  virtual void updateOther() { alpha=state->opacity;rotation=state->rotation;blendMode=static_cast<BlendMode>(std::clamp(state->blendMode,0,3)); }
  void update() override { core::Sprite::update();updateBitmap();if(visible){updateOrigin();updatePosition();updateScale();updateTone();updateOther();} }
  void render(Renderer& renderer,const core::Matrix& world={1,0,0,1,0,0},double opacity=1) override { if(!mapRenderConsumed)core::Sprite::render(renderer,world,opacity); }
};
struct NativeMapDrawEntry {
  int z=0;
  double y=0;
  std::uint64_t order=0;
  std::function<void(Renderer&,const core::Matrix&,double)> draw;
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
  virtual void createPictures() {
    pictureContainer=std::make_shared<core::Sprite>();
    pictureContainer->setFrame((core::Graphics::width-core::Graphics::boxWidth)/2.0,(core::Graphics::height-core::Graphics::boxHeight)/2.0,core::Graphics::boxWidth,core::Graphics::boxHeight);
    addChild(pictureContainer);
    const int count=modelSession().invokeGameDataBase("screen","maxPictures",{}).integer();
    for(int id=1;id<=count;++id) {
      auto object=modelSession().createGeneratedBinding("Sprite_Picture");
      auto generated=std::dynamic_pointer_cast<GeneratedRuntimeObject>(object);
      auto* native=dynamic_cast<NativePictureSprite*>(object.get());
      if(!generated||!native)throw std::runtime_error("picture binding has no native display");
      auto sprite=std::shared_ptr<NativePictureSprite>(generated->nativeLease(),native);
      sprite->initializePicture(id);pictureContainer->addChild(sprite);
    }
  }
  virtual void createTimer() { timerSprite=std::make_shared<core::Sprite>(); addChild(timerSprite); }
  virtual void createScreenSprites() { model->fadeSprite->setBlack(); addChild(model->flashSprite); addChild(model->fadeSprite); }
  virtual void updateToneChanger() { model->updateTone(modelSession()); }
  virtual void updateScreenSprites() { model->updateScreen(modelSession()); }
  virtual void updatePosition() { const auto transform=modelSession().screenTransform(); scale={transform[0],transform[3]}; position={transform[4],transform[5]}; }
  void update() override { core::Sprite::update(); updateToneChanger(); updateScreenSprites(); updatePosition(); }
};
struct NativeMapGraph {
  std::vector<std::shared_ptr<core::Container>> characters;
  std::weak_ptr<core::Container> tilemap;
  int level=0;
};
class NativeMapTilemap : public core::Tilemap {
 public:
  std::shared_ptr<NativeMapGraph> graph;
  std::function<void(const core::Matrix&,double)> callback;
  explicit NativeMapTilemap(std::shared_ptr<NativeMapGraph> state):graph(std::move(state)) { removeChildren(); }
  void render(Renderer& renderer,const core::Matrix& world={1,0,0,1,0,0},double opacity=1) override {
    std::vector<std::pair<std::shared_ptr<CharacterSprite>,bool>> previous;
    for (const auto& node:graph->characters) if (auto character=std::dynamic_pointer_cast<CharacterSprite>(node)) {
      previous.emplace_back(character,character->mapRenderConsumed); character->mapRenderConsumed=false;
    }
    std::vector<std::pair<std::shared_ptr<NativePictureSprite>,bool>> pictureState;
    for(const auto& node:children)if(auto picture=std::dynamic_pointer_cast<NativePictureSprite>(node)) {
      pictureState.emplace_back(picture,picture->mapRenderConsumed);picture->mapRenderConsumed=false;
    }
    const auto restore=[&]{for(const auto& [sprite,consumed]:previous)sprite->mapRenderConsumed=consumed;for(const auto& [sprite,consumed]:pictureState)sprite->mapRenderConsumed=consumed;};
    try { core::Container::render(renderer,world,opacity); } catch (...) { restore(); throw; }
    restore();
  }
 protected:
  void draw(Renderer&,const core::Matrix& world,double opacity) override { sortChildren();if(callback)callback(world,opacity); }
};
class NativeMapSpriteset : public NativeSpriteset {
 public:
  std::shared_ptr<NativeMapGraph> mapGraph=std::make_shared<NativeMapGraph>();
  std::shared_ptr<core::Container> tilemap;
  std::shared_ptr<core::TilingSprite> parallax;
  std::shared_ptr<core::Sprite> shadowSprite,destinationSprite;
  std::shared_ptr<core::Sprite> reflectionSurface;
  std::shared_ptr<core::Weather> weather;
  std::vector<std::shared_ptr<core::PixelBitmap>> tilesetBitmaps;
  Value tileset;
  const Value* tilesetSource=nullptr;
  std::string parallaxName;
  Sprite_Destination destinationState;
  explicit NativeMapSpriteset(bool=false) { model=std::make_shared<Spriteset_Map>(); }
  virtual void createParallax() { parallax=std::make_shared<core::TilingSprite>(); parallax->move(0,0,modelSession().screenWidth(),modelSession().screenHeight()); baseSprite->addChild(parallax); }
  virtual void createTilemap() {
    auto layer=std::make_shared<NativeMapTilemap>(mapGraph); tilemap=layer; mapGraph->tilemap=tilemap;
    layer->tileWidth=modelSession().tileWidth(); layer->tileHeight=modelSession().tileHeight();
    const auto& map=modelSession().map(); std::vector<int> data;
    for(const auto& cell:map["data"].array())data.push_back(cell.integer());
    layer->setData(map["width"].integer(),map["height"].integer(),std::move(data));
    const int scroll=map["scrollType"].integer(); layer->horizontalWrap=scroll==2||scroll==3;layer->verticalWrap=scroll==1||scroll==3;
    loadTileset(); baseSprite->addChild(tilemap);
  }
  virtual void loadTileset() {
    const auto& session=modelSession(); const auto& data=session.tiledMapData(session.mapId());
    tilesetBitmaps.clear();
    if(!data.null()) {
      tilesetSource=&data["tilesets"];
      tileset=data["tilesets"].reference();
      for(const auto& sheet:tileset.array())tilesetBitmaps.push_back(modelBitmap("loadParserTileset",{sheet["image"]}));
    } else {
      tilesetSource=&session.database()["tilesets"][session.mapState().tilesetId];
      tileset=session.database()["tilesets"][session.mapState().tilesetId].reference();
      for(const auto& name:tileset["tilesetNames"].array())tilesetBitmaps.push_back(modelBitmap("loadTileset",{name}));
    }
    if(auto layer=std::dynamic_pointer_cast<core::Tilemap>(tilemap)) {
      layer->bitmaps.fill(nullptr);layer->bitmapOwners.fill(nullptr);
      for(std::size_t i=0;i<std::min(layer->bitmaps.size(),tilesetBitmaps.size());++i) {layer->bitmapOwners[i]=tilesetBitmaps[i];layer->bitmaps[i]=tilesetBitmaps[i].get();}
      layer->flags.clear();for(const auto& flag:tileset["flags"].array())layer->flags.push_back(flag.integer());layer->refreshTileset();layer->refresh();
    }
  }
  virtual void createCharacters() {
    for(const auto& sprite:mapGraph->characters)if(sprite&&sprite->parent)sprite->parent->removeChild(sprite.get());
    mapGraph->characters.clear();
    const auto append=[&](std::shared_ptr<RuntimeCharacter> value) {
      if(!value)return;
      auto object=modelSession().createGeneratedBinding("Sprite_Character");
      auto generated=std::dynamic_pointer_cast<GeneratedRuntimeObject>(object);
      auto* native=dynamic_cast<CharacterSprite*>(object.get());
      auto sprite=generated&&native?std::shared_ptr<CharacterSprite>(generated->nativeLease(),native):nullptr;
      if(!sprite)throw std::runtime_error("character binding has no native display");
      sprite->initializeCharacter(value);mapGraph->characters.push_back(sprite);tilemap->addChild(sprite);
    };
    for(const auto& event:modelSession().events())append(modelSession().runtimeCharacter(event.id));
    for(int id:{-5,-6,-7})append(modelSession().runtimeCharacter(id));
    for(std::size_t follower=modelSession().followerCount();follower>0;--follower)append(modelSession().runtimeFollower(static_cast<int>(follower)));
    append(modelSession().runtimeCharacter(-1));
  }
  virtual void createShadow() { shadowSprite=std::make_shared<core::Sprite>();shadowSprite->setBitmap(modelBitmap("loadSystem",{"Shadow1"},"_shadowSprite"));shadowSprite->anchor={0.5,1};shadowSprite->z=6;tilemap->addChild(shadowSprite);updateShadow(); }
  virtual void createDestination() {
    destinationSprite=std::make_shared<core::Sprite>();auto bitmap=modelBitmap("createBitmap",{modelSession().tileWidth(),modelSession().tileHeight()},"_destinationSprite");bitmap->fillAll("white");destinationSprite->setBitmap(bitmap);destinationSprite->anchor={0.5,0.5};destinationSprite->blendMode=BlendMode::additive;destinationSprite->z=9;tilemap->addChild(destinationSprite);updateDestination();
  }
  virtual void createWeather() {
    auto object=modelSession().createGeneratedBinding("Weather");
    auto generated=std::dynamic_pointer_cast<GeneratedRuntimeObject>(object);
    auto* native=dynamic_cast<core::Weather*>(object.get());
    if(!generated||!native)throw std::runtime_error("weather binding has no native display");
    weather=std::shared_ptr<core::Weather>(generated->nativeLease(),native);
    generated->initializeNative(); addChild(weather);
  }
  virtual void hideCharacters() { for(const auto& node:mapGraph->characters)if(auto sprite=std::dynamic_pointer_cast<CharacterSprite>(node);sprite&&!sprite->isTile())sprite->hide(); }
  virtual void updateTileset() {
    const auto& session=modelSession();const auto& data=session.tiledMapData(session.mapId());
    const auto& current=data.null()?session.database()["tilesets"][session.mapState().tilesetId]:data["tilesets"];
    const bool same = current.reader && tileset.reader ? current.reader->sameSource(*tileset.reader) :
      !current.reader && !tileset.reader && &current == tilesetSource;
    if(!same)loadTileset();
  }
  virtual void updateParallax() {
    if(!parallax)return;const auto& state=modelSession().mapState();
    if(parallaxName!=state.parallaxName){parallaxName=state.parallaxName;parallax->setBitmap(parallaxName.empty()?nullptr:modelBitmap("loadParallax",{parallaxName},"_parallax"));}
    parallax->origin={state.parallaxZero?state.parallaxX*modelSession().tileWidth():state.parallaxLoopX?state.parallaxX*modelSession().tileWidth()/2:0,state.parallaxZero?state.parallaxY*modelSession().tileHeight():state.parallaxLoopY?state.parallaxY*modelSession().tileHeight()/2:0};
  }
  virtual void updateTilemap() { mapGraph->tilemap=tilemap;if(auto layer=std::dynamic_pointer_cast<core::Tilemap>(tilemap))layer->origin={modelSession().mapState().lastDisplayX*modelSession().tileWidth(),modelSession().mapState().lastDisplayY*modelSession().tileHeight()}; }
  virtual void updateShadow() { if(!shadowSprite)return;const auto state=modelSession().runtimeMapShadow();shadowSprite->position={state[0],state[1]};shadowSprite->setOpacity(state[2]); }
  virtual void updateWeather() {
    if(!weather)return;
    weather->type=modelSession().invokeGameDataBase("screen","weatherType",{}).text();
    weather->power=modelSession().invokeGameDataBase("screen","weatherPower",{}).number();
    weather->origin={modelSession().mapState().lastDisplayX*modelSession().tileWidth(),modelSession().mapState().lastDisplayY*modelSession().tileHeight()};
    weather->width=modelSession().screenWidth(); weather->height=modelSession().screenHeight();
  }
  virtual void setMapLevel(int level) { mapGraph->level=level; }
  virtual void updateHideOnLevel() { setMapLevel(modelSession().tiledLevel()); }
  virtual void updateReflectionSurface() {
    if(reflectionSurface)reflectionSurface->position={-modelSession().mapState().lastDisplayX*modelSession().tileWidth(),-modelSession().mapState().lastDisplayY*modelSession().tileHeight()};
  }
  virtual void createReflectionMask() {}
  void updateDestination() {
    if(!destinationSprite)return;auto& session=modelSession();
    const bool valid=session.invokeGameDataBase("temp","isDestinationValid",{}).boolean();destinationSprite->visible=valid;
    if(!valid){destinationState.reset();return;}destinationState.advance(1);
    const auto x=session.invokeGameDataBase("temp","destinationX",{}),y=session.invokeGameDataBase("temp","destinationY",{});
    destinationSprite->position={(session.invokeGameDataBase("map","adjustX",{x}).number()+0.5)*session.tileWidth(),(session.invokeGameDataBase("map","adjustY",{y}).number()+0.5)*session.tileHeight()};destinationSprite->alpha=destinationState.opacity;destinationSprite->scale={destinationState.scale.x,destinationState.scale.y};
  }
  void createLowerLayer() override { NativeSpriteset::createLowerLayer();createParallax();createTilemap();createCharacters();createShadow();createDestination();createWeather(); }
  void update() override {
    auto* bound=dynamic_cast<GeneratedRuntimeObject*>(this);
    if(!bound||!bound->dispatchValue("update",{},"Spriteset_Base"))NativeSpriteset::update();
    updateTileset();updateParallax();updateTilemap();updateShadow();updateWeather();updateDestination();
    if(modelSession().usesTiledMapPlugin()){updateHideOnLevel();updateReflectionSurface();}
  }
  auto mapLevelReader() const { auto state=mapGraph;return std::function<int()>([state]{return state->level;}); }
  auto characterRenderer() const {
    auto state=mapGraph;
    return std::function<bool(const Character&,Renderer&,const core::Matrix&,double)>([state](const Character& value,Renderer& renderer,const core::Matrix& world,double opacity) {
      bool found=false;auto parent=state->tilemap.lock();
      for(const auto& node:state->characters)if(auto sprite=std::dynamic_pointer_cast<CharacterSprite>(node);sprite&&sprite->character && &sprite->character->value()==&value) {
        found=true;sprite->mapRenderConsumed=true;if(!sprite->parent||!parent)continue;
        std::vector<core::Container*> chain;auto ancestor=sprite->parent;for(;ancestor&&ancestor!=parent.get();ancestor=ancestor->parent)chain.push_back(ancestor);if(!ancestor)continue;
        auto transform=world;double alpha=opacity;bool visible=true;for(auto i=chain.rbegin();i!=chain.rend();++i){visible=visible&&(*i)->visible&&(*i)->renderable;transform=core::multiply(transform,(*i)->localTransform());alpha*=(*i)->alpha;}
        if(visible)sprite->core::Sprite::render(renderer,transform,alpha);
      }
      return found;
    });
  }
  auto mapDrawEntries() const {
    auto state=mapGraph;
    return std::function<std::vector<NativeMapDrawEntry>()>([state] {
      std::vector<NativeMapDrawEntry> entries;const auto tilemap=state->tilemap.lock();if(!tilemap)return entries;
      for(const auto& node:tilemap->children)if(auto picture=std::dynamic_pointer_cast<NativePictureSprite>(node)) {
        entries.push_back({picture->z,picture->position.y,picture->displayId,[picture](Renderer& renderer,const core::Matrix& world,double opacity) {
          picture->mapRenderConsumed=true;picture->core::Sprite::render(renderer,world,opacity);
        }});
      }
      return entries;
    });
  }
  void bindMapLayers(std::function<void(const core::Matrix&,double)> world) {
    auto layer=std::dynamic_pointer_cast<NativeMapTilemap>(tilemap);if(!layer)throw std::invalid_argument("map tilemap is not a shared native renderer");layer->callback=std::move(world);mapGraph->tilemap=tilemap;
  }
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
