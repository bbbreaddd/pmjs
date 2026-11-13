#include "mv_presentation.hpp"
#include "mv_windows.hpp"
#include "mv_managers.hpp"
#include "mv_battle_extra.hpp"
#include "mv_core_utils.hpp"
#include <cctype>
#include <cstdlib>
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace pmjs::mv {
Presentation::Presentation(RuntimeCore& core, Session& session, Value settings)
    : core_(core), session_(session), settings_(std::move(settings)) {
  core::bindRuntime(core_);
  const int screenWidth = settings_["width"].null() ? core_.width() : settings_["width"].integer();
  const int screenHeight = settings_["height"].null() ? core_.height() : settings_["height"].integer();
  const std::string renderingMode = settings_["renderingMode"].text().empty() ? "auto" : settings_["renderingMode"].text();
  if (screenWidth <= 0 || screenHeight <= 0 || screenWidth > 16384 || screenHeight > 16384)
    throw std::invalid_argument("invalid screen dimensions");
  core::Graphics::initialize(screenWidth, screenHeight, renderingMode);
  if (!settings_["width"].null() || session_.database_["sceneContract"]["width"].null())
    session_.setScreenSize(screenWidth, screenHeight);
  core::Graphics::loadFont("GameFont",settings_["fontFile"].text());
  fonts_ = core::Graphics::fonts("GameFont");
  if (fonts_.empty()) {
    const auto font = core_.vfs().resolve(settings_["fontFile"].text());
    if (!font) throw std::runtime_error("game font unavailable");
    fonts_.push_back(*font);
  }
  core::PixelBitmap::setImageLoader([this](const std::string& url)->std::optional<ImageInfo>{return image(url);});
  Decrypter::readEncryptionkey(session_.database_["system"]);
  core::WebAudio::setEncryptionKey(Decrypter::hasEncryptedAudio ? session_.database_["system"]["encryptionKey"].text() : "");
  core::Graphics::setLoadingCallbacks([this]{session_.resourcesStopped_=true;},[this]{session_.resourcesStopped_=false;});
  core::Graphics::setVideoCallbacks([this](const std::string& url){
    auto file=std::filesystem::path(url).filename();file.replace_extension();session_.movieName_=file.string();session_.moviePlaying_=!session_.movieName_.empty();
  },[this]{return session_.moviePlaying_;},[this](double volume){if(movieAudio_)core_.media().setParameters(movieAudio_,volume,1,0);});
  imageCache_ = std::make_unique<ImageCache>();
  session_.setEnemyBitmapHeightResolver([this](const Battler& enemy) {
    const auto& data = session_.database_["enemies"][enemy.id];
    const auto name = data["battlerName"].text();
    if (name.empty()) return 0;
    return image(std::string(session_.database_["system"]["optSideView"].boolean() ? "img/sv_enemies/" : "img/enemies/") + name + ".png", data["battlerHue"].integer()).height;
  });
  const auto budget = settings_["imageCacheBytes"].number();
  if (budget > 0) {
    imageCache_->limit = static_cast<std::size_t>(budget);
    ImageManager::imageCache().limit = imageCache_->limit;
  }
  const auto skinSource = core_.vfs().resolve("img/system/Window.png");
  if (!skinSource) throw std::runtime_error("window skin unavailable");
  const auto loaded = core_.images().loadPng(*skinSource, true);
  if (!loaded) throw std::runtime_error("cannot decode window skin");
  const auto skin = *loaded;
  const auto* pixels = core_.images().readPixels(skin.handle);
  if (!pixels || skin.width < 192 || skin.height < 192) { core_.images().release(skin.handle); throw std::runtime_error("invalid window skin"); }
  for (int i = 0; i < 32; ++i) {
    const std::size_t offset = ((150 + i / 8 * 12) * skin.width + 102 + i % 8 * 12) * 4;
    colors_[i] = static_cast<std::uint32_t>(pixels->rgba[offset]) << 24 | static_cast<std::uint32_t>(pixels->rgba[offset + 1]) << 16 | static_cast<std::uint32_t>(pixels->rgba[offset + 2]) << 8 | 255;
  }
  core_.images().release(skin.handle);
  const auto canvas = core_.canvases().create(core_.width(), core_.height());
  if (!canvas) throw std::runtime_error("cannot create UI text surface");
  globalTextCanvas_ = textCanvas_ = canvas->handle;
}
Presentation::~Presentation() {
  session_.setEnemyBitmapHeightResolver({});
  clearNameContents();
  clearMapOverlays();
  clearMovie();
  clearMapGeometry();
  clearTiledGeometry();
  clearBattleContents();
  if (imageCache_) imageCache_->clear();
  for (auto handle : deferredImageReleases_) core_.images().release(handle);
  deferredImageReleases_.clear();
  coreWindows_.clear(); coreWindowskin_.reset();
  sounds_.clear();
  musicEffect_.reset();
  audio_.clear();
  coreWeather_.reset();
  if (timerCanvas_) core_.canvases().release(timerCanvas_);
  clearUiContents();
  core_.canvases().release(globalTextCanvas_);
  core::unbindRuntime(core_);
}
ImageInfo Presentation::image(const std::string& file, int hue) {
  const auto key = hue ? file + "#hue=" + std::to_string(hue) : file;
  if (imageCache_->get(key)) {
    const auto found = images_.find(key);
    if (found != images_.end()) return found->second;
  }
  ImageInfo result;
  if (hue) {
    const auto source = image(file);
    const auto surface = core_.canvases().create(source.width, source.height);
    if (!surface) throw std::runtime_error("cannot create hue surface");
    core_.canvases().drawImage(surface->handle, source.handle, 0, 0, source.width, source.height, 0, 0, source.width, source.height, 1);
    core_.canvases().rotateHue(surface->handle, hue);
    const auto handle = core_.canvases().prepareImage(surface->handle);
    if (!handle || !core_.images().retain(*handle)) { core_.canvases().release(surface->handle); throw std::runtime_error("cannot realize hue surface"); }
    result = source; result.handle = *handle; core_.canvases().release(surface->handle);
  } else {
    const bool encrypted = session_.database_["system"]["hasEncryptedImages"].boolean() && !Decrypter::checkImgIgnore(file);
    const auto path = core_.vfs().resolve(encrypted ? Decrypter::extToEncryptExt(file) : file);
    if (!path) throw std::runtime_error("image unavailable: " + file);
    if (encrypted) {
      const auto source = ImageStore::openFile(*path, Decrypter::encryptionKey);
      if (!source) throw std::runtime_error("cannot open encrypted image: " + file);
      auto loaded = core_.images().acquireCached(*source);
      if (!loaded) {
        auto pixels = ImageStore::decodeFile(*source);
        if (pixels) loaded = core_.images().installDecoded(*source, std::move(*pixels), true);
      }
      if (!loaded) throw std::runtime_error("cannot decode encrypted image: " + file);
      result = *loaded;
    } else {
      const auto loaded = core_.images().loadPng(*path, true);
      if (!loaded) throw std::runtime_error("cannot decode image: " + file);
      result = *loaded;
    }
  }
  images_[key] = result;
  imageCache_->add(key, static_cast<std::size_t>(result.width) * result.height, [this, key, handle = result.handle]() {
    const auto found = images_.find(key);
    if (found != images_.end() && found->second.handle == handle) images_.erase(found);
    deferredImageReleases_.push_back(handle);
  });
  return result;
}
void Presentation::quad(ImageHandle handle, float sx, float sy, float sw, float sh, float x, float y, float width, float height, float alpha) {
  if (sw <= 0 || sh <= 0 || width <= 0 || height <= 0) return;
  const auto source = core_.images().inspect(handle);
  if (!source || !core::Sprite::queueFrame(core_.renderer(), *source, {sx,sy,sw,sh}, {width/sw,0,0,height/sh,x,y}, alpha)) throw std::runtime_error("cannot queue image");
}
void Presentation::tile(int id,int x,int y,std::vector<TileLayerTile>& geometry) {
  const auto& tileset=session_.database_["tilesets"][session_.mapState_.tilesetId];
  stockTilemap_.appendTileGeometry(geometry,id,x,y,[&](int sheet){const auto name=tileset["tilesetNames"][sheet].text();return name.empty()?ImageInfo{}:image("img/tilesets/"+name+".png");});
}
void Presentation::character(const Character& value, double cameraX, double cameraY) {
  int characterId = &value == &session_.player_ ? -1 : 0;
  for (const auto& event : session_.events_) if (&event.character == &value) characterId = event.id;
  const auto flash = session_.effectColor(0, characterId);
  if (session_.effectHidden(0, characterId)) return;
  if (value.transparent || value.opacity <= 0 || (value.tileId <= 0 && value.characterName.empty())) return;
  const auto& tiled = session_.database_["tiledMaps"][std::to_string(session_.mapId_)];
  const int tw = tiled["tilewidth"].integer(48), th = tiled["tileheight"].integer(48);
  const bool tileImage = value.tileId > 0;
  Sprite_Character sprite;
  sprite.setCharacter(&value);
  const bool object = tileImage || ImageManager::isObjectCharacter(value.characterName);
  ImageInfo source;
  if (tileImage) {
    const auto& tileset = session_.database_["tilesets"][session_.mapState_.tilesetId];
    const auto name = tileset["tilesetNames"][5 + value.tileId / 256].text();
    if (name.empty()) return;
    source = image("img/tilesets/" + name + ".png");
  } else {
    source = image("img/characters/" + value.characterName + ".png");
  }
  const auto frame = sprite.sourceFrame(source.width, source.height, tw, th);
  const double frameX = frame.x, frameY = frame.y, frameWidth = frame.width, frameHeight = frame.height;
  const double jumpHeight = value.jumpCount > 0 ? (value.jumpPeak * value.jumpPeak - std::pow(std::abs(value.jumpCount - value.jumpPeak), 2)) / 2.0 : 0;
  const float x = std::floor(scrolledMapX(value.realX, cameraX, tw) * tw + tw / 2.0 + 0.5) + value.spriteOffsetX;
  const float y = std::floor(scrolledMapY(value.realY, cameraY, th) * th + th - (object ? 0 : 6) - jumpHeight + 0.5) + value.spriteOffsetY;
  const float alpha = std::clamp(value.opacity / 255.0F, 0.0F, 1.0F);
  const auto draw = [&](double sx, double sy, double width, double height, float baseline, float opacity, BlendMode blend) {
    std::array<double,4> blendColor{}; for(int i=0;i<4;++i)blendColor[i]=flash[i]*255;
    if(!core::Sprite::queueFrame(core_.renderer(),source,{sx,sy,width,height},{1,0,0,1,x,baseline},opacity,blend,{.5,1},{},blendColor))
      throw std::runtime_error("cannot queue character");
  };
  if (!tileImage && value.bushDepth > 0) {
    const double depth = value.bushDepth;
    const auto blend = static_cast<BlendMode>(value.blendMode);
    draw(frameX, frameY, frameWidth, frameHeight - depth, y - depth, alpha, blend);
    draw(frameX, frameY + frameHeight - depth, frameWidth, depth, y, alpha * 128.0F / 255, blend);
  } else draw(frameX, frameY, frameWidth, frameHeight, y, alpha, static_cast<BlendMode>(value.blendMode));
}

void Presentation::mapPictures() {
  const auto& tiled=session_.database_["tiledMaps"][std::to_string(session_.mapId_)];
  const int tw=tiled["tilewidth"].integer(48),th=tiled["tileheight"].integer(48);
  for(std::size_t index = 0; index < session_.pictures_.size(); ++index) {
    if (index < 1 || index > 200 || (index > 100) != session_.battle_.active) continue;
    const auto& picture = session_.pictures_[index];
    Sprite_Picture sprite(static_cast<int>(index));
    sprite.syncFromPicture(picture);
    if(!sprite.visible||sprite.opacity<=0)continue;
    const auto source=image("img/pictures/"+sprite.pictureName+".png");
    const auto& frame=picture["_frameData"]["frames"][picture["_frameData"]["frameIndex"].integer()];
    const int sx=frame["x"].integer(),sy=frame["y"].integer(),sw=frame["width"].integer(source.width),sh=frame["height"].integer(source.height);
    float x=sprite.position.x,y=sprite.position.y;
    if(picture["_pinnedToMap"].boolean()){x-=cameraX_*tw;y-=cameraY_*th;}
    const float a = std::cos(sprite.rotation) * sprite.scale.x, b = std::sin(sprite.rotation) * sprite.scale.x;
    const float c = -std::sin(sprite.rotation) * sprite.scale.y, d = std::cos(sprite.rotation) * sprite.scale.y;
    x-=a*sw*sprite.anchor.x+c*sh*sprite.anchor.y;
    y-=b*sw*sprite.anchor.x+d*sh*sprite.anchor.y;
    std::array<float, 4> tone{};
    for (std::size_t component = 0; component < 4; ++component) tone[component] = picture["_tone"][component].number() / 255;
    if(!core_.renderer().queueImage(source.handle,{a,b,c,d,x,y},
      {float(sx),float(sy),float(sw),float(sh)},sprite.opacity,0xffffff,static_cast<BlendMode>(sprite.blendMode),tone))throw std::runtime_error("cannot queue picture");
  }
}
void Presentation::mapAmbience() {
  const auto name=session_.ambience_["name"].text();if(name.empty())return;
  const auto& tiled=session_.database_["tiledMaps"][std::to_string(session_.mapId_)];
  const int tw=tiled["tilewidth"].integer(48),th=tiled["tileheight"].integer(48);
  const auto& player=session_.player_;const bool object=player.characterName.find('!')<2;
  const float x=session_.ambience_["useCustomPosition"].boolean() ? session_.ambience_["x"].number() : std::floor((player.realX-cameraX_)*tw+tw/2.0+0.5);
  const float y=session_.ambience_["useCustomPosition"].boolean() ? session_.ambience_["y"].number() : std::floor((player.realY-cameraY_)*th+th-(object?0:6)+0.5)-10;
  const float alpha=session_.ambience_["opacity"].number(255)/255;
  const auto source=image("img/pictures/"+name+".png");
  quad(source.handle,0,0,source.width,source.height,x-source.width/2.0F,y-source.height/2.0F,source.width,source.height,alpha);
  const float w=core_.width(),h=core_.height();
  core_.renderer().queueQuad(x-w/2,y+(y>=h/2?-h:h/2),w,h/2,{0,0,0,alpha});
  core_.renderer().queueQuad(x+(x>=w/2?-w:w/2),y-h,w/2,h*2,{0,0,0,alpha});
}

void Presentation::mapParallax(int tileWidth, int tileHeight) {
  const auto& parallax = session_.mapState_;
  if (parallax.parallaxName.empty()) return;
  const auto source = image("img/parallaxes/" + parallax.parallaxName + ".png");
  const double ox = parallax.parallaxZero ? parallax.parallaxX * tileWidth : parallax.parallaxLoopX ? parallax.parallaxX * tileWidth / 2 : 0;
  const double oy = parallax.parallaxZero ? parallax.parallaxY * tileHeight : parallax.parallaxLoopY ? parallax.parallaxY * tileHeight / 2 : 0;
  const float width = static_cast<float>(core_.width()), height = static_cast<float>(core_.height());
  if (!core_.renderer().queueTilingFrame(source.handle, {1,0,0,1,0,0},
      {0,0,float(source.width),float(source.height)},{width,height},{float(-std::floor(-ox+.5)),float(-std::floor(-oy+.5))},1,BlendMode::normal)) throw std::runtime_error("cannot queue map parallax");
}
void Presentation::map() {
  const auto& tiled=session_.database_["tiledMaps"][std::to_string(session_.mapId_)];
  if(!tiled.null()) {
    mapParallax(tiled["tilewidth"].integer(48), tiled["tileheight"].integer(48));
    tiledMap(tiled);mapDestination();mapAmbience();return;
  }
  const auto& mapData = session_.map();
  const int width = mapData["width"].integer(), height = mapData["height"].integer();
  const double screenX = core_.width() / 48.0, screenY = core_.height() / 48.0;
  cameraX_ = session_.savedCamera_ ? (*session_.savedCamera_)[0] : width < screenX ? (width - screenX) / 2 : std::clamp(session_.player_.realX - (screenX - 1) / 2, 0.0, width - screenX);
  cameraY_ = session_.savedCamera_ ? (*session_.savedCamera_)[1] : height < screenY ? (height - screenY) / 2 : std::clamp(session_.player_.realY - (screenY - 1) / 2, 0.0, height - screenY);
  const int originX = static_cast<int>(std::floor(cameraX_ * 48)), originY = static_cast<int>(std::floor(cameraY_ * 48));
  mapParallax(48, 48);
  const int firstX = static_cast<int>(std::floor(originX / 48.0)), firstY = static_cast<int>(std::floor(originY / 48.0));
  prepareMapGeometry(session_.loopHorizontal() ? firstX : std::max(0, firstX), session_.loopVertical() ? firstY : std::max(0, firstY),
    session_.loopHorizontal() ? (originX + core_.width()) / 48 + 1 : std::min(width, (originX + core_.width()) / 48 + 1),
    session_.loopVertical() ? (originY + core_.height()) / 48 + 1 : std::min(height, (originY + core_.height()) / 48 + 1));
  queueMapGeometry(false, originX, originY);
  struct Sprite { const Character* value; int priority; }; std::vector<Sprite> characters;
  for (const auto& event : session_.events_) if (event.page >= 0) characters.push_back({&event.character, event.priority});
  for (const auto& vehicle : session_.vehicles_) if (vehicle.mapId == session_.mapId_) characters.push_back({&vehicle.character, vehicle.type == 2 ? vehicle.altitude > 0 ? 2 : 0 : 1});
  for (auto follower = session_.followers_.rbegin(); follower != session_.followers_.rend(); ++follower) characters.push_back({&*follower, 1});
  characters.push_back({&session_.player_, 1});
  std::stable_sort(characters.begin(), characters.end(), [&](const Sprite& a, const Sprite& b) { return a.priority != b.priority ? a.priority < b.priority : scrolledMapY(a.value->realY, cameraY_, 48) < scrolledMapY(b.value->realY, cameraY_, 48); });
  for (const auto& sprite : characters) if (sprite.priority < 2) character(*sprite.value, cameraX_, cameraY_);
  queueMapGeometry(true, originX, originY);
  for (const auto& sprite : characters) if (sprite.priority >= 2) character(*sprite.value, cameraX_, cameraY_);
  mapShadow();
  mapDestination();
}
void Presentation::hitTarget(int x, int y, int width, int height, int index, int action) {
  session_.uiHitTargets_.push_back({x,y,width,height,index,session_.ui_.category,action,session_.ui_.scene});
}
void Presentation::window(int x,int y,int width,int height,int selected,int rows,int openness,std::shared_ptr<core::PixelBitmap> contents,std::optional<core::Rectangle> cursor) {
  if(openness<=0)return;
  if(selected>=0&&rows>0&&openness>=255){const int base=session_.ui_.cursor-selected;for(int row=0;row<rows;++row)hitTarget(x+18,y+18+row*36,width-36,36,base+row);}
  if(!coreWindowskin_) {
    const auto skin=image("img/system/Window.png");
    coreWindowskin_=std::make_shared<core::PixelBitmap>(core_,skin.width,skin.height);
    if(!core_.canvases().drawImage(coreWindowskin_->nativeCanvas(),skin.handle,0,0,skin.width,skin.height,0,0,skin.width,skin.height,1))throw std::runtime_error("cannot prepare windowskin");
  }
  const WindowKey key{x,y,width,height,uiWindowOrdinal_};
  auto& window=coreWindows_[key];if(!window)window=std::make_shared<core::Window>();
  window->windowskin=coreWindowskin_;window->move(x,y,width,height);window->openness=std::clamp(openness,0,255);
  window->contents=std::move(contents);
  window->active=selected>=0;window->synchronize(session_.ticks_);window->animationCount=session_.ticks_;
  const auto& tone=session_.system_.windowTone.null()?session_.database_["system"]["windowTone"]:session_.system_.windowTone;
  window->setTone(tone[0].number(),tone[1].number(),tone[2].number());
  if(cursor)window->setCursorRect(cursor->x,cursor->y,cursor->width,cursor->height);
  else if(selected>=0&&rows>0)window->setCursorRect(0,selected%rows*36,std::max(0,width-36),36);else window->setCursorRect(0,0,0,0);
  streamUiWindow(*window);
}
void Presentation::streamUiWindow(core::Window& window) {
  flushUiText();
  if(!uiLayerState_) {
    uiLayer_.move(0,0,core_.width(),core_.height());
    uiLayerState_=uiLayer_.begin(core_.renderer());
  }
  uiLayer_.renderWindow(core_.renderer(),*uiLayerState_,window);
  const WindowKey key{int(window.position.x),int(window.position.y),int(window.width),int(window.height),uiWindowOrdinal_++};
  auto& canvas=uiTextCanvases_[key];
  if(canvas) {
    const auto previous=core_.canvases().info(canvas);
    if(previous&&(previous->width!=core_.width()||previous->height!=core_.height())) {
      core_.canvases().release(canvas);canvas=0;
    }
  }
  if(!canvas) {
    const auto created=core_.canvases().create(core_.width(),core_.height());
    if(!created)throw std::runtime_error("cannot create window text contents");
    canvas=created->handle;
  }
  textCanvas_=canvas;core_.canvases().clear(textCanvas_);
  uiTextClip_=std::array<int,4>{static_cast<int>(window.position.x+window.padding),static_cast<int>(window.position.y+window.padding),static_cast<int>(window.position.x+window.width-window.padding),static_cast<int>(window.position.y+window.height-window.padding)};
  if(window.openness<255)(*uiTextClip_)[2]=(*uiTextClip_)[0];
}
void Presentation::flushUiText() {
  if(!uiTextDirty_)return;
  const auto texture=core_.canvases().prepareImage(textCanvas_);
  if(!texture)throw std::runtime_error("cannot prepare window text contents");
  const auto first=core_.renderer().queuedCommandCount();
  quad(*texture,0,0,core_.width(),core_.height(),0,0,core_.width(),core_.height());
  if(uiTextClip_)core_.renderer().clipQueuedCommands(first,*uiTextClip_);
  uiTextDirty_=false;
}
void Presentation::finishUiLayer() {
  flushUiText();
  if(uiLayerState_)uiLayer_.end(core_.renderer(),*uiLayerState_);
  uiLayerState_.reset();uiTextClip_.reset();textCanvas_=globalTextCanvas_;
}
void Presentation::clearUiContents() {
  goldWindow_.reset();
  for(const auto& [key,canvas]:uiTextCanvases_){(void)key;core_.canvases().release(canvas);}
  uiTextCanvases_.clear();
  uiLayerState_.reset();uiTextClip_.reset();uiTextDirty_=false;textCanvas_=globalTextCanvas_;
}
void Presentation::goldWindow(int x, int y) {
  const auto toColor = [](std::uint32_t value) { return Color{std::uint8_t(value>>24),std::uint8_t(value>>16),std::uint8_t(value>>8),std::uint8_t(value)}; };
  const auto valueColor = toColor(colors_[0]), unitColor = toColor(colors_[16]);
  const auto unit = session_.database_["system"]["currencyUnit"].text();
  const bool created = !goldWindow_;
  if (created) goldWindow_ = std::make_shared<Window_Gold>(x,y);
  auto& model = *goldWindow_;
  if (created || model.value != session_.gold_ || model.currencyUnit != unit || model.valueColor.rgba() != valueColor.rgba() || model.unitColor.rgba() != unitColor.rgba()) {
    model.valueColor = valueColor; model.unitColor = unitColor; model.refresh(session_);
  }
  window(x,y,model.rect.width,model.rect.height,-1,0,255,std::shared_ptr<core::PixelBitmap>(goldWindow_,&model.contents));
}
void Presentation::text(const std::string& value, double x, double y, int width, int color, int size, bool right, float opacity) {
  if (value.empty()) return;
  const double measured = core_.canvases().measureText(fonts_, value, size).value_or(0);
  const double destinationX = right ? x + width - measured : x;
  core_.canvases().drawText(textCanvas_, fonts_, value, destinationX, y + (36 + size * 0.7F) / 2, size, 128, 4);
  core_.canvases().drawText(textCanvas_, fonts_, value, destinationX, y + (36 + size * 0.7F) / 2, size, (colors_[std::clamp(color, 0, 31)] & 0xffffff00U) | static_cast<std::uint32_t>(255 * opacity));
  uiTextDirty_=true;
}
double Presentation::textEx(const std::string& source, double x, double y, int /*width*/, int size, bool prepared, bool measureOnly) {
  const auto value = prepared ? source : Window_Base::processEscapeCodes(source,session_);
  const double initialX = x;
  const auto resizeFont = [](int fontSize, char code) {
    if (code == '{' && fontSize <= 96) return fontSize + 12;
    if (code == '}' && fontSize >= 24) return fontSize - 12;
    return fontSize;
  };
  const auto lineHeight = [&](std::size_t start, int fontSize) {
    int largest = fontSize;
    for (std::size_t at = start; at < value.size() && value[at] != '\n'; ++at) {
      if (value[at] != '\x1b' || at + 1 >= value.size()) continue;
      const char code = value[++at];
      fontSize = resizeFont(fontSize,code);
      largest = std::max(largest,fontSize);
    }
    return largest + 8;
  };
  int height = lineHeight(0,size);
  int color = 0;
  for (std::size_t index = 0; index < value.size();) {
    if (value[index] == '\n') { x = initialX; y += height; ++index; height = lineHeight(index,size); continue; }
    if (value[index] == '\f') { ++index; continue; }
    if (value[index] == '\x1b' && index+1 < value.size()) {
      const char code = std::toupper(static_cast<unsigned char>(value[index+1]));
      if (code == '{' || code == '}') {
        size = resizeFont(size,code);
        index += 2; continue;
      }
      if ((code == 'C' || code == 'I') && index+2 < value.size() && value[index+2]=='[') {
        const auto end = value.find(']',index+3);
        if (end != std::string::npos) {
          const int argument = std::atoi(value.substr(index+3,end-index-3).c_str());
          if (code == 'C') color = argument;
          else { if (!measureOnly) { const auto icon = image("img/system/IconSet.png"); quad(icon.handle,argument%16*32,argument/16*32,32,32,x+2,y+2,32,32); } x += 36; }
          index = end+1; continue;
        }
      }
      if (code == '.' || code == '|' || code == '!' || code == '>' || code == '<' || code == '^' || code == '$') { index += 2; continue; }
    }
    std::size_t length = 1;
    const auto lead = static_cast<unsigned char>(value[index]);
    if ((lead&0xe0)==0xc0) length = 2; else if ((lead&0xf0)==0xe0) length = 3; else if ((lead&0xf8)==0xf0) length = 4;
    length = std::min(length,value.size()-index);
    const auto glyph = value.substr(index,length);
    const double measured = core_.canvases().measureText(fonts_,glyph,size).value_or(size/2.0);
    if (!measureOnly) text(glyph,x,y,measured,color,size);
    x += measured; index += length;
  }
  return x - initialX;
}
void Presentation::face(int actorId, int x, int y, float opacity) {
  const auto& actor = session_.actors_.at(actorId);
  if (actor.faceName.empty()) return;
  const auto source = image("img/faces/" + actor.faceName + ".png");
  const int index = actor.faceIndex;
  quad(source.handle, index % 4 * 144, index / 4 * 144, 144, 144, x, y, 144, 144,opacity);
}
void Presentation::simpleActorStatus(int actorId,int x,int y,int width) {
  const auto& actor = session_.actors_.at(actorId);
  text(actor.name,x,y,168);
  text(session_.database_["classes"][actor.classId]["name"].text(),x+180,y,168);
  text(TextManager::levelA(session_),x,y+36,48,16);
  text(std::to_string(actor.level),x+84,y+36,36,0,28,true);
  stateIcons(actor,x,y+72,144);
  gauge(actor,0,x+180,y+36,std::min(200,width-186));
  gauge(actor,1,x+180,y+72,std::min(200,width-186));
}
void Presentation::menuStatus(const Rect& bounds,int topRow,int selected,bool active,bool all,bool fixed) {
  const int count = static_cast<int>(session_.party_.size());
  topRow = all ? 0 : Window_Selectable::clampTopRow(topRow,count,1,4);
  std::optional<core::Rectangle> cursor;
  if (active && count > 0 && (all || (selected >= topRow && selected < topRow+4))) {
    const auto row = Window_MenuStatus::rowRect(selected,bounds.width,bounds.height,topRow);
    cursor = all ? core::Rectangle{0,0,double(bounds.width-36),double(count*Window_MenuStatus::rowHeight(bounds.height))} :
      core::Rectangle{double(row.x),double(row.y),double(row.width),double(row.height)};
  }
  window(bounds.x,bounds.y,bounds.width,bounds.height,active ? selected : -1,0,255,{},cursor);
  for (int index = topRow; index < std::min(count,topRow+4); ++index) {
    const auto row = Window_MenuStatus::rowRect(index,bounds.width,bounds.height,topRow);
    const auto layout = Window_MenuStatus::rowLayout(row);
    if (active && ((!all && !fixed) || index == selected))
      hitTarget(bounds.x+18+row.x,bounds.y+18+row.y,row.width,row.height,index);
    const int actorId = session_.party_[index];
    const auto& actor = session_.actors_.at(actorId);
    const bool battleMember = index < static_cast<int>(session_.battleMemberCount()) && !actor.hidden && !actor.escaped;
    face(actorId,bounds.x+18+layout.face.x,bounds.y+18+layout.face.y,battleMember ? 1 : 160.0F/255);
    const int x = bounds.x+18+static_cast<int>(layout.status.x), y = bounds.y+18+static_cast<int>(layout.status.y);
    simpleActorStatus(actorId,x,y,static_cast<int>(layout.status.width));
  }
}
void Presentation::gauge(const Battler& actor, int stat, int x, int y, int width) {
  if (width <= 0) return;
  const int maximum = stat == 2 ? 100 : static_cast<int>(session_.parameter(actor, stat));
  const int amount = stat == 0 ? actor.hp : stat == 1 ? actor.mp : actor.tp;
  const int filled = maximum > 0 ? std::clamp(static_cast<int>(std::floor(width * static_cast<double>(amount) / maximum)), 0, width) : 0;
  const int palette = stat == 2 ? 28 : 20 + stat * 2;
  std::vector<std::uint8_t> pixels(static_cast<std::size_t>(width) * 6 * 4);
  for (int column = 0; column < width; ++column) for (int channel = 0; channel < 4; ++channel) {
    const int shift = (3 - channel) * 8;
    const double first = (colors_[palette] >> shift) & 255, last = (colors_[palette + 1] >> shift) & 255;
    const auto color = column < filled ? static_cast<std::uint8_t>(std::floor(first + (last - first) * (column + 0.5) / filled + 0.5)) : static_cast<std::uint8_t>((colors_[19] >> shift) & 255);
    for (int row = 0; row < 6; ++row) pixels[(row * width + column) * 4 + channel] = color;
  }
  const std::vector<std::uint8_t> clip(static_cast<std::size_t>(width) * 6, 255);
  if (!core_.canvases().compositePixels(textCanvas_, x, y + 28, width, 6, pixels, clip, CanvasComposite::sourceOver, 1)) throw std::runtime_error("cannot draw status gauge");
  uiTextDirty_=true;
  text(session_.database_["system"]["terms"]["basic"][3 + stat * 2].text(), x, y, 44, 16);
  if (stat == 2) { text(std::to_string(amount), x + width - 64, y, 64, 0, 28, true); return; }
  const int valueWidth = static_cast<int>(std::ceil(core_.canvases().measureText(fonts_, "0000", 28).value_or(0)));
  const int slashWidth = static_cast<int>(std::ceil(core_.canvases().measureText(fonts_, "/", 28).value_or(0)));
  const int labelWidth = static_cast<int>(std::ceil(core_.canvases().measureText(fonts_, "HP", 28).value_or(0)));
  const int currentColor = stat == 0 ? actor.hp <= 0 ? 18 : actor.hp < maximum / 4.0 ? 17 : 0 : 0;
  if (width - valueWidth * 2 - slashWidth >= labelWidth) {
    text(std::to_string(amount), x + width - valueWidth * 2 - slashWidth, y, valueWidth, currentColor, 28, true);
    text("/", x + width - valueWidth - slashWidth, y, slashWidth, 0, 28, true);
    text(std::to_string(maximum), x + width - valueWidth, y, valueWidth, 0, 28, true);
  } else text(std::to_string(amount), x + width - valueWidth, y, valueWidth, currentColor, 28, true);
}
namespace {
void drawDimmerBackground(Renderer& renderer, int x, int y, int width, int height, int margin, float opacity) {
  if (width <= 0 || height <= 0 || opacity <= 0) return;
  const int m = std::clamp(margin, 0, height / 2);
  constexpr int kSteps = 6;
  for (int i = 0; i < kSteps; ++i) {
    const int top = y + m * i / kSteps, bottom = y + m * (i + 1) / kSteps;
    const float a = 0.6F * opacity * ((i + 0.5F) / kSteps);
    if (bottom > top) renderer.queueQuad(x, top, width, bottom - top, {0, 0, 0, a});
    const int bTop = y + height - m + m * i / kSteps, bBottom = y + height - m + m * (i + 1) / kSteps;
    const float ba = 0.6F * opacity * (1.0F - (i + 0.5F) / kSteps);
    if (bBottom > bTop) renderer.queueQuad(x, bTop, width, bBottom - bTop, {0, 0, 0, ba});
  }
  if (height > m * 2) renderer.queueQuad(x, y + m, width, height - m * 2, {0, 0, 0, 0.6F * opacity});
}
}
void Presentation::actorStatus(int actorId, int x, int y, int width, bool portrait) {
  const auto& actor = session_.actors_.at(actorId);
  if (portrait) { face(actorId, x, y); x += 162; width -= 162; }
  text(actor.name, x, y, width);
  text(session_.database_["classes"][actor.classId]["name"].text(), x + 180, y, width - 180);
  text(TextManager::levelA(session_), x, y + 36, 48, 16); text(std::to_string(actor.level), x + 48, y + 36);
  stateIcons(actor,x+84,y+36,std::max(0,width-84));
  for (int i = 0; i < 2; ++i) gauge(actor, i, x, y + 72 + i * 36, std::min(186, width));
}
void Presentation::messageBody() {
  const auto& message = session_.message_;
  if (!message.busy && !message.closing) return;
  if (message.scrolling) {
    core::Window window;window.move(0,0,core_.width(),core_.height());window.opacity=0;
    streamUiWindow(window);
    for (std::size_t line = 0; line < message.lines.size(); ++line)
      textEx(message.lines[line].text(), 24, static_cast<int>(19 + line*36 - message.scrollY), core_.width()-48);
    return;
  }
  if (message.openness <= 0) return;
  const auto& style = settings_["messageStyle"];
  const int lineHeight = style["lineHeight"].integer(36), padding = style["padding"].integer(18);
  const int inset = style["inset"].integer(), width = core_.width() - inset * 2;
  const int height = lineHeight * 4 + padding * 2;
  const int y = message.position * (core_.height() - height) / 2 + (message.position == 2 ? -style["bottomInset"].integer() : message.position == 0 ? style["bottomInset"].integer() : 0);
  if (message.background == 0) window(inset, y, width, height, -1, 0, message.openness);
  else {
    core::Window window;window.move(inset,y,width,height);window.opacity=0;window.padding=padding;window.openness=message.openness;
    streamUiWindow(window);
    if (message.background == 1) drawDimmerBackground(core_.renderer(), inset, y, width, height, padding, message.openness / 255.0F);
  }
  if (message.openness < 255) return;
  int x = inset + padding + style["textInset"].integer();
  if (!message.faceName.empty()) { const auto bitmap = image("img/faces/" + message.faceName + ".png"); quad(bitmap.handle, message.faceIndex % 4 * 144, message.faceIndex / 4 * 144, 144, 144, 18, y + 18, 144, 144); x = 186; }
  std::string visible;
  for (int index = message.firstLine; index < message.pageEnd(); ++index) {
    if (index >= static_cast<int>(message.expandedLines.size()) || index >= static_cast<int>(message.revealLengths.size())) break;
    if (index != message.firstLine) visible += '\n';
    visible += message.expandedLines[index].substr(0,message.revealLengths[index]);
  }
  textEx(visible,x,y+padding+style["textOffsetY"].integer(),width-x-padding,style["fontSize"].integer(28),true);
  if (message.goldWindow) goldWindow(core_.width()-240,message.position == 0 ? core_.height()-72 : 0);
  if (message.textPaused) {
    if (!style["pauseImage"].text().empty()) {
      const auto cursor = image(style["pauseImage"].text());
      const float anchor = 0.5F + std::sin(session_.ui_.age * 0.1F) * 0.1F;
      quad(cursor.handle,0,0,cursor.width,cursor.height,inset+width-40-cursor.width*anchor,y+height-10-cursor.height,cursor.width,cursor.height);
    } else {
      const auto skin = image("img/system/Window.png"); const int frame = static_cast<int>(session_.ticks_/16)%4;
      quad(skin.handle,144+frame%2*24,96+frame/2*24,24,24,core_.width()/2-12,y+height-24,24,24);
    }
  }
}
void Presentation::messageInputs() {
  const auto& message = session_.message_;
  const auto& style = settings_["messageStyle"];
  const int lineHeight = style["lineHeight"].integer(36), padding = style["padding"].integer(18);
  const int inset = style["inset"].integer(), width = core_.width()-inset*2;
  const int height = lineHeight*4+padding*2;
  const int y = message.position*(core_.height()-height)/2+(message.position == 2 ? -style["bottomInset"].integer() : message.position == 0 ? style["bottomInset"].integer() : 0);
  const Rect parent{inset,y,width,height};
  if (session_.choiceWindow_) {
    auto& model = *session_.choiceWindow_;
    if (model.active) {
      int choiceWidth = 96;
      for (const auto& command : model.commands) choiceWidth = std::max(choiceWidth,static_cast<int>(std::ceil(textEx(command.name,0,0,0,28,false,true)+12)));
      const int oldRows = model.maxPageRows();
      model.rect = Window_ChoiceList::placement(model.maxItems(),choiceWidth,model.positionType,parent,core_.width(),core_.height());
      if (oldRows != model.maxPageRows()) model.ensureCursorVisible();
      else model.setTopRow(model.topRow);
    }
    if (model.openness > 0) {
      const auto& rect = model.rect;
      const auto selected = model.itemRect(model.index);
      const core::Rectangle cursor{double(selected.x),double(selected.y),model.index >= model.topRow && model.index < model.topRow+model.maxPageRows() ? double(selected.width) : 0,36};
      if (model.background == 0) window(rect.x,rect.y,rect.width,rect.height,model.active ? model.index : -1,0,model.openness,{},cursor);
      else {
        core::Window node; node.move(rect.x,rect.y,rect.width,rect.height); node.opacity=0; node.openness=model.openness; node.active=model.active; node.cursorRect=cursor;
        streamUiWindow(node);
        if (model.background == 1) drawDimmerBackground(core_.renderer(), rect.x, rect.y, rect.width, rect.height, 18, model.openness / 255.0F);
      }
      if (model.openness == 255) for (int index = model.topIndex(); index < std::min(model.topIndex()+model.maxPageItems(),model.maxItems()); ++index) {
        const auto item = model.itemRect(index);
        if (model.active) hitTarget(rect.x+18+item.x,rect.y+18+item.y,item.width,item.height,index);
        textEx(model.commands[index].name,rect.x+24+item.x,rect.y+18+item.y,rect.width-48);
      }
    }
  }
  if (session_.numberWindow_) {
    auto& model = *session_.numberWindow_;
    if (model.active) {
      const auto next = Window_NumberInput::placement(model.maxDigits,parent,core_.width(),core_.height());
      if (model.rect.width != next.width || model.rect.height != next.height) model.contentsDirty = true;
      model.rect = next;
      model.buttonsAbove = parent.y >= core_.height()/2;
    }
    if (model.openness > 0) {
      const auto normal = colors_[0];
      const Color color{std::uint8_t(normal>>24),std::uint8_t(normal>>16),std::uint8_t(normal>>8),std::uint8_t(normal)};
      if (model.textColor.rgba() != color.rgba()) { model.textColor=color; model.contentsDirty=true; }
      if (model.contentsDirty) model.refresh();
      const auto& rect = model.rect;
      const core::Rectangle cursor{double(model.index*32),0,32,36};
      window(rect.x,rect.y,rect.width,rect.height,model.active ? model.index : -1,0,model.openness,std::shared_ptr<core::PixelBitmap>(session_.numberWindow_,&model.contents),cursor);
      if (model.openness == 255 && model.active) for (int digit = 0; digit < model.maxDigits; ++digit) hitTarget(rect.x+18+digit*32,rect.y+18,32,36,digit);
      if (model.buttonsVisible) {
        const auto sheet = image("img/system/ButtonSet.png");
        const auto buttons = Window_NumberInput::buttonBounds(rect,model.buttonsAbove);
        for (int index = 0; index < 3; ++index) {
          Sprite_Button button;
          const auto cold = Window_NumberInput::buttonFrame(index,false), hot = Window_NumberInput::buttonFrame(index,true);
          button.setColdFrame(cold.x,cold.y,cold.width,cold.height); button.setHotFrame(hot.x,hot.y,hot.width,hot.height);
          button.touching = model.buttonFrameIndex == index; button.updateFrame();
          const auto& frame = button.frame;
          quad(sheet.handle,frame.x,frame.y,frame.width,frame.height,buttons[index].x,buttons[index].y,buttons[index].width,buttons[index].height);
          if (model.active && model.openness == 255) hitTarget(buttons[index].x,buttons[index].y,buttons[index].width,buttons[index].height,index,8+index);
        }
      }
    }
  }
  if (session_.eventItemWindow_) {
    auto& model = *session_.eventItemWindow_;
    if (model.active) model.rect = Window_EventItem::placement(parent,core_.width(),core_.height());
    if (model.openness > 0) {
      const auto& rect = model.rect;
      const auto selected = model.itemRect(model.index);
      const core::Rectangle cursor{double(selected.x),double(selected.y),model.index >= model.topIndex() && model.index < model.topIndex()+model.maxPageItems() ? double(selected.width) : 0,36};
      window(rect.x,rect.y,rect.width,rect.height,model.active ? model.index : -1,0,model.openness,{},cursor);
      if (model.openness == 255) for (int index = model.topIndex(); index < std::min(model.topIndex()+model.maxPageItems(),model.maxItems()); ++index) {
        const auto cell = model.itemRect(index); const int id = model.data[index];
        if (model.active) hitTarget(rect.x+18+cell.x,rect.y+18+cell.y,cell.width,cell.height,index);
        const auto& item = session_.database_["items"][id]; const int icon = item["iconIndex"].integer();
        const auto icons = image("img/system/IconSet.png");
        quad(icons.handle,icon%16*32,icon/16*32,32,32,rect.x+20+cell.x,rect.y+20+cell.y,32,32);
        text(item["name"].text(),rect.x+60+cell.x,rect.y+18+cell.y,cell.width-108);
        const auto count = session_.inventory_.find(id);
        text(":"+std::to_string(count == session_.inventory_.end() ? 0 : count->second),rect.x+cell.width-66+cell.x,rect.y+18+cell.y,60,0,28,true);
      }
    }
  }
}
void Presentation::message() { messageBody(); messageInputs(); }
void Presentation::clearNameContents() {
  nameGrid_.reset(); nameEdit_.reset(); nameFace_.reset(); nameFaceFile_.clear();
  nameFaceIndex_ = nameActor_ = -1; nameFaceReady_ = false;
}
void Presentation::menu() {
  const auto& ui = session_.ui_; const int width = core_.width(), height = core_.height();
  if (ui.scene == Scene::name) {
    bool editRedraw = false, gridRedraw = false;
    if (!nameEdit_ || nameActor_ != ui.nameActorId || nameEdit_->maxLength != std::max(1,ui.nameMaxLength)) {
      clearNameContents();
      nameActor_ = ui.nameActorId;
      nameEdit_ = std::make_shared<Window_NameEdit>(ui.nameActorId,ui.nameMaxLength,ui.nameInput);
      editRedraw = true;
    }
    if (!nameGrid_) { nameGrid_ = std::make_shared<Window_NameInput>(); gridRedraw = true; }
    const auto& actor = session_.actors_.at(ui.nameActorId);
    const auto locale = session_.database_["system"]["locale"].text();
    const bool japanese = locale.starts_with("ja");
    if (nameGrid_->locale != locale) { nameGrid_->locale = locale; editRedraw = gridRedraw = true; }
    if (nameGrid_->page != ui.namePage) { nameGrid_->page = ui.namePage; gridRedraw = true; }
    nameGrid_->index = ui.cursor;
    if (nameEdit_->name != ui.nameInput) {
      nameEdit_->name = ui.nameInput;
      nameEdit_->index = static_cast<int>(core::utf16Length(ui.nameInput));
      editRedraw = true;
    }
    const std::string file = actor.faceName.empty() ? "" : "img/faces/"+actor.faceName+".png";
    if (file != nameFaceFile_) {
      nameFaceFile_ = file;
      nameFace_ = file.empty() ? nullptr : core::PixelBitmap::load(file);
      editRedraw = true;
    }
    const bool faceReady = !nameFace_ || nameFace_->isReady();
    if (nameFaceReady_ != faceReady || nameFaceIndex_ != actor.faceIndex) {
      nameFaceReady_ = faceReady; nameFaceIndex_ = actor.faceIndex; editRedraw = true;
    }
    const auto color = colors_[0];
    const auto normalColor = core::Utils::rgbToCssColor((color>>24)&255,(color>>16)&255,(color>>8)&255);
    nameEdit_->contents.textColor = nameGrid_->contents.textColor = normalColor;
    if (editRedraw) nameEdit_->refresh(nameFace_.get(),actor.faceIndex,japanese);
    if (gridRedraw) nameGrid_->refresh();
    const auto edit = Window_NameEdit::placement(width,height);
    const int px = edit.x, editY = edit.y, inputY = editY+edit.height+8;
    nameEdit_->rect = edit; nameGrid_->rect = {px,inputY,480,360};
    window(px,editY,480,180,-1,0,255,
      std::shared_ptr<core::PixelBitmap>(nameEdit_,&nameEdit_->contents),nameEdit_->itemRect(nameEdit_->index,japanese));
    const auto cursor = Window_NameInput::cellRect(ui.cursor);
    window(px,inputY,480,360,ui.cursor,0,255,
      std::shared_ptr<core::PixelBitmap>(nameGrid_,&nameGrid_->contents),
      core::Rectangle{double(cursor.x),double(cursor.y),double(cursor.width),double(cursor.height)});
    for (int cell = 0; cell < 90; ++cell) {
      const auto rect = Window_NameInput::cellRect(cell);
      hitTarget(px+18+rect.x,inputY+18+rect.y,rect.width,rect.height,cell);
    }
    return;
  }
  if (ui.scene == Scene::shop) {
    const bool statusVisible = ui.category == 1 || ui.category == 3;
    std::optional<ShopGood> selected;
    if (ui.category == 3) selected = ShopGood{ui.shopKind,ui.shopId,ui.shopPrice};
    else if (ui.category == 1) {
      const auto goods = session_.shopItems(false);
      if (ui.cursor >= 0 && ui.cursor < static_cast<int>(goods.size())) selected = goods[ui.cursor];
    }
    const auto drawStatus = [&] {
      if (!statusVisible) return;
      window(456,180,width-456,height-180);
      if (selected) {
        text(TextManager::possession(session_),480,198,width-564,16);
        text(std::to_string(Window_ShopStatus::possession(session_,selected->kind,selected->id)),width-84,198,60,0,28,true);
        const auto rows = Window_ShopStatus::equipInfo(session_,selected->kind,selected->id,ui.shopStatusPage);
        for (std::size_t index = 0; index < rows.size(); ++index) {
          const auto& row = rows[index]; const int y = 270+static_cast<int>(36*(index*2.4));
          const float opacity = row.enabled ? 1 : 160.0F/255;
          text(session_.actor(row.actorId).name,480,y,168,0,28,false,opacity);
          if (row.enabled) text((row.paramChange > 0 ? "+" : "")+std::to_string(row.paramChange),width-108,y,84,row.paramChange > 0 ? 24 : row.paramChange < 0 ? 25 : 0,28,true);
          if (row.equippedItem) {
            const auto& item = session_.database_[row.equippedItem/100000 == 1 ? "weapons" : "armors"][row.equippedItem%100000];
            const auto icons = image("img/system/IconSet.png"); const int icon = item["iconIndex"].integer();
            quad(icons.handle,icon%16*32,icon/16*32,32,32,482,y+38,32,32,opacity);
            text(item["name"].text(),516,y+36,width-540,0,28,false,opacity);
          }
        }
      }
    };
    window(0,0,width,108);
    if (selected) textEx(session_.database_[selected->kind == 0 ? "items" : selected->kind == 1 ? "weapons" : "armors"][selected->id]["description"].text(),24,18,width-48);
    const auto commands = Window_ShopCommand::makeCommands(session_,ui.shopPurchaseOnly);
    std::optional<core::Rectangle> commandCursor;
    if (ui.category == 0 && !commands.empty()) {
      const auto rect = Window_Selectable::itemRectFor(std::clamp(ui.cursor,0,static_cast<int>(commands.size())-1),width-276,3,36,12,0);
      commandCursor = core::Rectangle{double(rect.x),double(rect.y),double(rect.width),double(rect.height)};
    }
    window(0,108,width-240,72,ui.category == 0 ? ui.cursor : -1,0,255,{},commandCursor);
    for (std::size_t i = 0; i < commands.size(); ++i) {
      const auto rect = Window_Selectable::itemRectFor(static_cast<int>(i),width-276,3,36,12,0);
      if (ui.category == 0) hitTarget(18+rect.x,126,rect.width,36,static_cast<int>(i));
      const int tw = static_cast<int>(std::ceil(core_.canvases().measureText(fonts_, commands[i].name, 28).value_or(0)));
      const int tx = 24 + rect.x + std::max(0, (rect.width - 12 - tw) / 2);
      text(commands[i].name,tx,126,rect.width-12,0,28,false,commands[i].enabled ? 1 : 160.0F/255);
    }
    goldWindow(width-240,108);
    if (ui.category == 3) {
      window(0,180,statusVisible ? 456 : width,height-180);
      const auto& item = session_.database_[ui.shopKind == 0 ? "items" : ui.shopKind == 1 ? "weapons" : "armors"][ui.shopId];
      const int icon = item["iconIndex"].integer();
      if (icon > 0) { const auto icons = image("img/system/IconSet.png"); quad(icons.handle,icon%16*32,icon/16*32,32,32,26,218,32,32); }
      text(item["name"].text(),60,216,372); text("×",24,288,200,16);
      text(std::to_string(ui.shopItemCount),240,288,120,0,28,true);
      const auto unit = session_.database_["system"]["currencyUnit"].text();
      const int unitW = static_cast<int>(std::min(80.0, std::ceil(core_.canvases().measureText(fonts_, unit, 28).value_or(0))));
      text(std::to_string(static_cast<std::int64_t>(ui.shopItemCount)*ui.shopPrice),24,360,402-unitW,0,28,true);
      text(unit,432-unitW,360,unitW,16,28,true);
      const std::array<std::string,5> buttons{"-10","-1","+1","+10","OK"};
      const std::array<int,5> actions{7,5,4,6,1};
      for (int button = 0; button < 5; ++button) { const int bx = 24+button*84; hitTarget(bx,432,72,48,0,actions[button]); text(buttons[button],bx,438,72); }
      drawStatus();
      return;
    }
    if (ui.category == 0) { window(0,180,width,height-180); return; }
    const bool selling = ui.category == 2 || ui.category == 4;
    if (selling) {
      const std::array<std::string,4> categories{TextManager::item(session_),TextManager::weapon(session_),TextManager::armor(session_),TextManager::keyItem(session_)};
      std::optional<core::Rectangle> catCursor;
      if (ui.category == 4) {
        const auto rect = Window_Selectable::itemRectFor(std::clamp(ui.cursor,0,3),width-36,4,36,12,0);
        catCursor = core::Rectangle{double(rect.x),double(rect.y),double(rect.width),double(rect.height)};
      }
      window(0,180,width,72,ui.category == 4 ? ui.cursor : -1,0,255,{},catCursor);
      for (int index = 0; index < 4; ++index) {
        const auto rect = Window_Selectable::itemRectFor(index,width-36,4,36,12,0);
        if (ui.category == 4) hitTarget(18+rect.x,198,rect.width,36,index);
        const int tw = static_cast<int>(std::ceil(core_.canvases().measureText(fonts_, categories[index], 28).value_or(0)));
        text(categories[index],24+rect.x+std::max(0,(rect.width-12-tw)/2),198,rect.width-12);
      }
    }
    const auto goods = session_.shopItems(selling);
    const int columns = selling ? 2 : 1, baseY = selling ? 270 : 198, listY = selling ? 252 : 180, listW = statusVisible ? 456 : width;
    const int rows = std::max(1,(height-baseY-18)/36);
    session_.ui_.listPageRows = rows;
    session_.ui_.listTopRow = Window_Selectable::clampTopRow(ui.listTopRow,static_cast<int>(goods.size()),columns,rows);
    std::optional<core::Rectangle> listCursor;
    if (ui.category != 4 && !goods.empty()) {
      const auto rect = Window_Selectable::itemRectFor(std::clamp(ui.cursor,0,static_cast<int>(goods.size())-1),listW-36,columns,36,12,ui.listTopRow);
      listCursor = core::Rectangle{double(rect.x),double(rect.y),double(rect.width),double(rect.height)};
    }
    window(0,listY,listW,height-listY,ui.category != 4 ? ui.cursor : -1,0,255,{},listCursor);
    const int first = ui.listTopRow*columns;
    for (int index = first; index < std::min(first+rows*columns,static_cast<int>(goods.size())); ++index) {
      const auto rect = Window_Selectable::itemRectFor(index,listW-36,columns,36,12,ui.listTopRow);
      const int x = 18+rect.x, y = baseY+rect.y;
      if (ui.category != 4) hitTarget(x,y,rect.width,36,index);
      const auto& good = goods[index]; const auto& item = session_.database_[good.kind == 0 ? "items" : good.kind == 1 ? "weapons" : "armors"][good.id];
      const float opacity = session_.shopMaximum(good,selling,session_.gold_) > 0 ? 1 : 160.0F/255;
      const int icon = item["iconIndex"].integer();
      if (icon > 0) { const auto icons = image("img/system/IconSet.png"); quad(icons.handle,icon%16*32,icon/16*32,32,32,x+2,y+2,32,32,opacity); }
      text(item["name"].text(),x+38,y,std::max(0,rect.width-136),0,28,false,opacity);
      const int value = selling ? session_.inventory_.at(good.kind*100000+good.id) : good.price;
      text((selling ? ":" : "")+std::to_string(value),x+rect.width-86,y,80,0,28,true,opacity);
    }
    drawStatus();
    return;
  }
  if (ui.scene == Scene::menu) {
    const auto commands = Window_MenuCommand::makeCommands(session_);
    const int selected = ui.category == 2 ? ui.pendingId : ui.category == 1 ? ui.commandCursor : ui.cursor;
    window(0, 0, 240, 36 + static_cast<int>(commands.size()) * 36, selected, static_cast<int>(commands.size()));
    for (std::size_t i = 0; i < commands.size(); ++i) text(commands[i].name, 24, 18 + static_cast<int>(i) * 36, 192, 0, 28, false, commands[i].enabled ? 1 : 160.0F / 255);
    goldWindow(0,height-72);
    menuStatus(Window_MenuStatus::placement(width,height),ui.menuStatusTopRow,ui.cursor,ui.category == 2);
    if (ui.category == 1) {
      const auto endCommands = Window_GameEnd::makeCommands(session_);
      window(width / 2 - 120, height / 2 - 54, 240, 108, ui.cursor, static_cast<int>(endCommands.size()));
      for (std::size_t i = 0; i < endCommands.size(); ++i) text(endCommands[i].name, width / 2 - 96, height / 2 - 36 + static_cast<int>(i) * 36, 192, 0, 28, false, endCommands[i].enabled ? 1 : 160.0F / 255);
    }
    return;
  }
  if (ui.scene == Scene::save || ui.scene == Scene::load) {
    const bool loading = ui.scene == Scene::load;
    window(0,0,width,72); text(loading ? TextManager::loadMessage(session_) : TextManager::saveMessage(session_),18,18);
    const int rows = Window_SavefileList::visibleItems(), count = Window_SavefileList::fileCount();
    if (!ui.listMemoryApplied) { session_.ui_.listTopRow = Window_Selectable::visibleTopRow(ui.cursor,ui.listTopRow,count,1,rows); session_.ui_.listMemoryApplied = true; }
    session_.ui_.listTopRow = Window_Selectable::clampTopRow(ui.listTopRow,count,1,rows);
    const int rowHeight = Window_SavefileList::rowHeight(height-72);
    window(0,72,width,height-72,-1);
    for (int index = ui.listTopRow; index < std::min(count,ui.listTopRow+rows); ++index) {
      const auto rect = Window_Selectable::itemRectFor(index,width-36,1,rowHeight,12,ui.listTopRow);
      const int x = 18+rect.x, y = 90+rect.y, id = index+1;
      const bool valid = Window_SavefileList::isEnabled(session_,id,true);
      hitTarget(x,y,rect.width,rect.height,index);
      if (index == ui.cursor) core_.renderer().queueQuad(x,y,rect.width,rect.height,{0.4F,0.5F,0.8F,0.4F});
      text(Window_SavefileList::fileLabel(session_,id),x+6,y,180,0,28,false,!loading || valid ? 1 : 160.0F/255);
      const auto& info = Window_SavefileList::metadata(session_,id);
      if (info.null()) continue;
      const float opacity = valid ? 1 : 160.0F/255;
      if (rect.width-12 >= 420) {
        text(info["title"].text(),x+198,y,rect.width-204,0,28,false,opacity);
        if (valid) {
          int offset = 0;
          for (const auto& entry : info["characters"].array()) {
            if (!entry[0].text().empty()) {
              const auto source = image("img/characters/"+entry[0].text()+".png");
              Character character; character.characterName = entry[0].text(); character.characterIndex = entry[1].integer();
              Sprite_Character sprite; sprite.setCharacter(&character);
              const auto frame = sprite.sourceFrame(source.width,source.height,48,48);
              quad(source.handle,frame.x,frame.y,frame.width,frame.height,x+226+offset*48-frame.width/2,y+rect.height-4-frame.height,frame.width,frame.height);
            }
            ++offset;
          }
        }
      }
      if (rect.y+rect.height-36 >= 36) text(info["playtime"].text(),x+6,y+rect.height-36,rect.width-12,0,28,true,opacity);
    }
    return;
  }
  if (ui.scene == Scene::options) {
    const auto commands = Window_Options::makeCommands(session_);
    const auto configuration = session_.configuration();
    const int x = width / 2 - 200, y = height / 2 - 126; window(x, y, 400, 36 + static_cast<int>(commands.size()) * 36, ui.cursor, static_cast<int>(commands.size()));
    for (std::size_t i = 0; i < commands.size(); ++i) {
      const auto& command = commands[i];
      const auto& value = configuration[command.symbol];
      const bool volume = command.symbol.find("Volume") != std::string::npos;
      text(command.name, x + 24, y + 18 + static_cast<int>(i) * 36, 232);
      text(volume ? std::to_string(value.integer()) + "%" : value.boolean() ? "ON" : "OFF", x + 256, y + 18 + static_cast<int>(i) * 36, 120, 0, 28, true);
    }
    return;
  }
  if (ui.scene == Scene::formation) {
    menuStatus({0, 0, width, height}, ui.menuStatusTopRow, ui.cursor, true);
    if (ui.target >= 0) {
      const int topRow = Window_Selectable::clampTopRow(ui.menuStatusTopRow, static_cast<int>(session_.party_.size()), 1, 4);
      if (ui.target >= topRow && ui.target < topRow + 4) {
        const auto row = Window_MenuStatus::rowRect(ui.target, width, height, topRow);
        core_.renderer().queueQuad(18 + row.x, 18 + row.y, row.width, row.height, {0.4F, 0.5F, 0.8F, 0.4F});
      }
    }
    return;
  }
  if (ui.scene == Scene::debug) {
    const int count = Window_DebugRange::itemCount(session_), selected = ui.category == 0 ? ui.cursor : ui.listCursor;
    const int rows = std::max(1,(height-36)/36);
    session_.ui_.listPageRows = rows;
    session_.ui_.listTopRow = Window_Selectable::clampTopRow(ui.listTopRow,count,1,rows);
    window(0,0,246,height,-1);
    for (int index = ui.listTopRow; index < std::min(count,ui.listTopRow+rows); ++index) {
      const auto rect = Window_Selectable::itemRectFor(index,210,1,36,12,ui.listTopRow);
      if (ui.category == 0) hitTarget(18,18+rect.y,210,36,index);
      if (ui.category == 0 && index == selected) core_.renderer().queueQuad(18,18+rect.y,210,36,{0.4F,0.5F,0.8F,0.4F});
      text(Window_DebugRange::labelFor(session_,index),24,18+rect.y,198);
    }
    window(246,0,width-246,396,ui.category == 1 ? ui.cursor : -1,10);
    const auto mode = Window_DebugRange::modeFor(session_,selected);
    const int top = Window_DebugRange::topIdFor(session_,selected);
    for (int row = 0; row < 10; ++row) {
      const int id = top+row, y = 18+row*36;
      if (ui.category == 1) hitTarget(264,y,width-282,36,row);
      text(core::numberPadZero(id,4)+": "+Window_DebugEdit::itemName(session_,mode,id),264,y,width-444);
      text(Window_DebugEdit::itemStatus(session_,mode,id),width-162,y,126,0,28,true);
    }
    text(mode == "switch" ? "Enter: ON / OFF" : "Left: -1   Right: +1   Pageup: -10   Pagedown: +10",264,432,width-282);
    return;
  }
  if (session_.party_.empty()) return;
  const int actorId = session_.party_[ui.actor];
  if (ui.scene != Scene::item && ui.scene != Scene::skill) window(0, 0, width, height);
  if (ui.scene == Scene::status) {
    const auto& actor = session_.actors_.at(actorId);
    const int lh = 36;
    const auto drawHorzLine = [&](int lineRow) {
      core_.renderer().queueQuad(18, 18 + lineRow * lh + lh / 2 - 1, std::max(0, width - 36), 2, {1, 1, 1, 48.0F / 255});
    };
    text(actor.name, 24, 18, 180);
    text(session_.database_["classes"][actor.classId]["name"].text(), 210, 18, 220);
    text(actor.nickname, 450, 18, std::max(0, width - 468));
    drawHorzLine(1);
    face(actorId, 30, 18 + lh * 2);
    text(TextManager::levelA(session_), 222, 18 + lh * 2, 48, 16);
    text(std::to_string(actor.level), 270, 18 + lh * 2, 72, 0, 28, true);
    stateIcons(actor, 222, 18 + lh * 3, 144);
    gauge(actor, 0, 222, 18 + lh * 4, 186);
    gauge(actor, 1, 222, 18 + lh * 5, 186);
    const int maxLevel = session_.database_["actors"][actorId]["maxLevel"].integer(99);
    const int curExp = actor.exp.contains(actor.classId) ? static_cast<int>(actor.exp.at(actor.classId)) : 0;
    const int nextExp = actor.level >= maxLevel ? 0 : std::max(0, BattleMechanics::expForLevel(session_, actor, actor.level + 1) - curExp);
    const std::string expText = actor.level >= maxLevel ? "-------" : std::to_string(curExp);
    const std::string nextText = actor.level >= maxLevel ? "-------" : std::to_string(nextExp);
    if (width >= 760) {
      text(TextManager::format(TextManager::expTotal(session_), {TextManager::exp(session_)}), 474, 18 + lh * 2, 270, 16);
      text(expText, 474, 18 + lh * 3, 270, 0, 28, true);
      text(TextManager::format(TextManager::expNext(session_), {TextManager::level(session_)}), 474, 18 + lh * 4, 270, 16);
      text(nextText, 474, 18 + lh * 5, 270, 0, 28, true);
    }
    drawHorzLine(6);
    for (int i = 0; i < 6; ++i) {
      const int y = 18 + (7 + i) * lh;
      text(TextManager::param(session_, i + 2), 66, y, 160, 16);
      text(std::to_string(static_cast<int>(session_.parameter(actor, i + 2))), 226, y, 60, 0, 28, true);
    }
    if (width >= 760) {
      for (std::size_t slot = 0; slot < std::min<std::size_t>(actor.equips.size(), 6); ++slot) {
        if (!actor.equips[slot]) continue;
        const auto& eq = session_.database_[actor.equipKinds[slot] == 1 ? "weapons" : "armors"][actor.equips[slot]];
        if (eq.null()) continue;
        const int y = 18 + (7 + static_cast<int>(slot)) * lh, icon = eq["iconIndex"].integer();
        if (icon > 0) { const auto icons = image("img/system/IconSet.png"); quad(icons.handle, icon % 16 * 32, icon / 16 * 32, 32, 32, 452, y + 2, 32, 32); }
        text(eq["name"].text(), 486, y, std::max(0, width - 504));
      }
    }
    drawHorzLine(13);
    textEx(actor.profile, 24, height >= 576 ? 18 + lh * 14 : height - 90, width - 48);
    return;
  }
  if (ui.scene == Scene::equip) {
    const auto& actor = session_.actor(actorId);
    const auto commands = Window_EquipCommand::makeCommands(session_);
    const int selectedSlot = ui.category == 1 ? ui.cursor : std::max(0,ui.slot);
    const auto choices = ui.category == 1 || ui.category == 2 ? Window_EquipItem::makeItemList(session_,actor.id,selectedSlot) : std::vector<int>{};
    window(0,0,width,108);
    if (!choices.empty()) {
      const int encoded = ui.category == 2 ? choices[std::clamp(ui.cursor,0,static_cast<int>(choices.size())-1)] :
        actor.equips[selectedSlot]+actor.equipKinds[selectedSlot]*100000;
      if (encoded%100000) textEx(session_.database_[encoded/100000 == 1 ? "weapons" : "armors"][encoded%100000]["description"].text(),24,18,width-48);
    }
    window(0,108,312,288);
    text(actor.name,24,126,264);
    const bool previewing = ui.category == 2 && ui.equipPreview.has_value();
    const auto differences = previewing ? Window_EquipStatus::parameterDifferences(session_,actor,*ui.equipPreview) : std::array<int,6>{};
    for (int parameter = 0; parameter < 6; ++parameter) {
      const int y = 162+parameter*36;
      const int value = static_cast<int>(session_.parameter(actor,parameter+2));
      text(TextManager::param(session_,parameter+2),24,y,120,16);
      text(std::to_string(value),150,y,54,0,28,true);
      if (previewing) {
        text("→",210,y,32,16);
        text(std::to_string(value+differences[parameter]),246,y,48,differences[parameter] > 0 ? 24 : differences[parameter] < 0 ? 25 : 0,28,true);
      }
    }
    window(312,108,width-312,72);
    for (std::size_t index = 0; index < commands.size(); ++index) {
      const auto rect = Window_Selectable::itemRectFor(static_cast<int>(index),width-348,3,36,12,0);
      if (ui.category == 0) {
        hitTarget(330+rect.x,126,rect.width,36,static_cast<int>(index));
        if (ui.cursor == static_cast<int>(index)) core_.renderer().queueQuad(330+rect.x,126,rect.width,36,{0.4F,0.5F,0.8F,0.4F});
      }
      text(commands[index].name,336+rect.x,126,rect.width-12);
    }
    window(312,180,width-312,216);
    const int slotTop = Window_Selectable::visibleTopRow(selectedSlot,0,static_cast<int>(actor.equips.size()),1,5);
    for (int index = slotTop; index < std::min(slotTop+5,static_cast<int>(actor.equips.size())); ++index) {
      const int y = 198+(index-slotTop)*36;
      if (ui.category == 1) {
        hitTarget(330,y,width-348,36,index);
        if (ui.cursor == index) core_.renderer().queueQuad(330,y,width-348,36,{0.4F,0.5F,0.8F,0.4F});
      }
      const float opacity = session_.canChangeEquip(actor,index) ? 1 : 160.0F/255;
      text(session_.database_["system"]["equipTypes"][session_.equipSlotType(actor,index)].text(),336,y,126,16,28,false,opacity);
      if (actor.equips[index]) {
        const auto& eq = session_.database_[actor.equipKinds[index] == 1 ? "weapons" : "armors"][actor.equips[index]];
        const int icon = eq["iconIndex"].integer();
        if (icon > 0) { const auto icons = image("img/system/IconSet.png"); quad(icons.handle,icon%16*32,icon/16*32,32,32,470,y+2,32,32,opacity); }
        text(eq["name"].text(),506,y,std::max(0,width-524),0,28,false,opacity);
      }
    }
    window(0,396,width,height-396);
    if (ui.category == 1 || ui.category == 2) {
      const int rows = std::max(1,(height-432)/36);
      session_.ui_.listPageRows = rows;
      session_.ui_.listTopRow = Window_Selectable::clampTopRow(ui.listTopRow,static_cast<int>(choices.size()),2,rows);
      const int first = ui.listTopRow*2;
      for (int index = first; index < std::min(first+rows*2,static_cast<int>(choices.size())); ++index) {
        const auto rect = Window_Selectable::itemRectFor(index,width-36,2,36,12,ui.listTopRow);
        const int x = 18+rect.x, y = 414+rect.y, encoded = choices[index];
        if (ui.category == 2) {
          hitTarget(x,y,rect.width,36,index);
          if (ui.cursor == index) core_.renderer().queueQuad(x,y,rect.width,36,{0.4F,0.5F,0.8F,0.4F});
        }
        if (!encoded) continue;
        const auto& item = session_.database_[encoded/100000 == 1 ? "weapons" : "armors"][encoded%100000];
        const auto icons = image("img/system/IconSet.png"); const int icon = item["iconIndex"].integer();
        quad(icons.handle,icon%16*32,icon/16*32,32,32,x+2,y+2,32,32);
        text(item["name"].text(),x+38,y,rect.width-98);
        text(std::to_string(session_.inventory_.at(encoded)),x+rect.width-54,y,48,0,28,true);
      }
    }
    return;
  }
  const bool skill = ui.scene == Scene::skill;
  const auto help = Window_Help::placement(width);
  const auto status = Window_SkillStatus::placement(width);
  const int listY = skill ? status.y+status.height : help.height+72;
  const auto types = skill ? Window_SkillType::makeCommands(session_,actorId) : std::vector<CommandItem>{};
  const auto categories = skill ? std::vector<CommandItem>{} : Window_ItemCategory::makeCommands(session_);
  const int selectedType = types.empty() ? -1 : std::clamp(ui.category == 0 ? ui.cursor : ui.commandCursor,0,static_cast<int>(types.size())-1);
  const int type = selectedType < 0 ? 0 : types[selectedType].ext;
  const auto entries = skill ? Window_SkillList::makeSkillList(session_,actorId,type) :
    Window_ItemList::makeItemList(session_,categories[std::clamp(ui.slot,0,static_cast<int>(categories.size())-1)].symbol);
  const int selectedItem = ui.targeting ? ui.listCursor : ui.cursor;
  window(help.x,help.y,help.width,help.height);
  if (ui.category != 0 && selectedItem >= 0 && selectedItem < static_cast<int>(entries.size())) {
    const int encoded = entries[selectedItem];
    const auto& item = session_.database_[skill ? "skills" : encoded/100000 == 0 ? "items" : encoded/100000 == 1 ? "weapons" : "armors"][encoded%100000];
    textEx(Window_Help::itemDescription(item),24,18,width-48);
  }
  if (skill) {
    session_.ui_.skillTypeTopRow = Window_Selectable::clampTopRow(ui.skillTypeTopRow,static_cast<int>(types.size()),1,4);
    std::optional<core::Rectangle> cursor;
    if (ui.category == 0 && !ui.targeting && selectedType >= 0) {
      const auto rect = Window_Selectable::itemRectFor(selectedType,204,1,36,12,ui.skillTypeTopRow);
      cursor = core::Rectangle{double(rect.x),double(rect.y),double(rect.width),double(rect.height)};
    }
    window(0,help.height,status.x,status.height,-1,0,255,{},cursor);
    for (int index = ui.skillTypeTopRow; index < std::min(ui.skillTypeTopRow+4,static_cast<int>(types.size())); ++index) {
      const auto rect = Window_Selectable::itemRectFor(index,204,1,36,12,ui.skillTypeTopRow);
      if (ui.category == 0 && !ui.targeting) hitTarget(18+rect.x,help.height+18+rect.y,rect.width,36,index);
      text(types[index].name,24+rect.x,help.height+18+rect.y,rect.width-12);
    }
    window(status.x,status.y,status.width,status.height);
    face(actorId,status.x+18,status.y+18);
    simpleActorStatus(actorId,status.x+180,status.y+36,status.width-204);
  } else {
    std::optional<core::Rectangle> cursor;
    if (ui.category == 0 && !ui.targeting) {
      const auto rect = Window_Selectable::itemRectFor(ui.cursor,width-36,4,36,12,0);
      cursor = core::Rectangle{double(rect.x),double(rect.y),double(rect.width),double(rect.height)};
    }
    window(0,help.height,width,72,-1,0,255,{},cursor);
    for (int index = 0; index < static_cast<int>(categories.size()); ++index) {
      const auto rect = Window_Selectable::itemRectFor(index,width-36,4,36,12,0);
      if (ui.category == 0 && !ui.targeting) hitTarget(18+rect.x,help.height+18+rect.y,rect.width,36,index);
      text(categories[index].name,24+rect.x,help.height+18+rect.y,rect.width-12);
    }
  }
  const int rows = std::max(1,(height-listY-36)/36);
  session_.ui_.listPageRows = rows;
  session_.ui_.listTopRow = Window_Selectable::clampTopRow(ui.listTopRow,static_cast<int>(entries.size()),2,rows);
  std::optional<core::Rectangle> cursor;
  if (ui.category != 0 && !ui.targeting && !entries.empty()) {
    const auto rect = Window_Selectable::itemRectFor(ui.cursor,width-36,2,36,12,ui.listTopRow);
    cursor = core::Rectangle{double(rect.x),double(rect.y),double(rect.width),double(rect.height)};
  }
  window(0,listY,width,std::max(0,height-listY),-1,0,255,{},cursor);
  const int first = ui.listTopRow*2;
  for (int index = first; index < std::min(first+rows*2,static_cast<int>(entries.size())); ++index) {
    const int encoded = entries[index], kind = encoded/100000, id = encoded%100000;
    const auto rect = Window_Selectable::itemRectFor(index,width-36,2,36,12,ui.listTopRow);
    const int x = 18+rect.x, y = listY+18+rect.y;
    if (!ui.targeting && ui.category != 0) hitTarget(x,y,rect.width,rect.height,index);
    const auto& item = session_.database_[skill ? "skills" : kind == 0 ? "items" : kind == 1 ? "weapons" : "armors"][id];
    const bool enabled = skill ? Window_SkillList::isEnabled(session_,actorId,id) : Window_ItemList::isEnabled(session_,encoded);
    const float opacity = enabled ? 1 : 160.0F/255;
    const auto icons = image("img/system/IconSet.png"); const int icon = item["iconIndex"].integer();
    quad(icons.handle,icon%16*32,icon/16*32,32,32,x+2,y+2,32,32,opacity);
    text(item["name"].text(),x+38,y,std::max(0,rect.width-98),0,28,false,opacity);
    if (skill) {
      const auto cost = Window_SkillList::displayedCost(session_,actorId,id);
      if (cost.first > 0) text(std::to_string(cost.first),x+rect.width-54,y,48,cost.second,28,true,opacity);
    } else {
      const auto found = session_.inventory_.find(encoded);
      text(":"+std::to_string(found == session_.inventory_.end() ? 0 : found->second),x+rect.width-54,y,48,0,28,true,opacity);
    }
  }
  if (ui.targeting) {
    const auto& item = session_.database_[ui.itemAction ? "items" : "skills"][ui.pendingId];
    const auto selection = Window_MenuActor::selection(session_,item,ui.actor);
    menuStatus(Window_MenuActor::placement(width,height,ui.listCursor),ui.menuActorTopRow,
      selection.fixed || selection.all ? selection.index : ui.cursor,true,selection.all,selection.fixed);
  }
}
void Presentation::clearBattleContents() {
  battlerDisplays_.clear();
  for (auto& contents : battleContents_) {
    if (contents.canvas) core_.canvases().release(contents.canvas);
    contents = {};
  }
}
void Presentation::retainBattleContents(BattleWindow part, std::vector<std::string> key, const std::function<void()>& draw) {
  flushUiText();
  auto& contents = battleContents_[static_cast<std::size_t>(part)];
  if (!contents.canvas) {
    // Preserve logical coordinates and the canvas-area-dependent text blending contract.
    const auto canvas = core_.canvases().create(core_.width(), core_.height());
    if (!canvas) throw std::runtime_error("cannot create battle window contents");
    contents.canvas = canvas->handle;
  }
  if (!contents.valid || contents.key != key) {
    const auto previous = textCanvas_;
    textCanvas_ = contents.canvas;
    try { core_.canvases().clear(textCanvas_); draw(); }
    catch (...) { textCanvas_ = previous; uiTextDirty_=false; throw; }
    textCanvas_ = previous; uiTextDirty_=false;
    contents.key = std::move(key); contents.valid = true;
  }
  const auto texture=core_.canvases().prepareImage(contents.canvas);
  if(!texture)throw std::runtime_error("cannot prepare battle window contents");
  const auto first=core_.renderer().queuedCommandCount();
  quad(*texture,0,0,core_.width(),core_.height(),0,0,core_.width(),core_.height());
  if(uiTextClip_)core_.renderer().clipQueuedCommands(first,*uiTextClip_);
}
void Presentation::battle() {
  const auto first = core_.renderer().queuedCommandCount();
  const int width = core_.width(), height = core_.height(); const auto& ui = session_.ui_;
  for (int layer = 0; layer < 2; ++layer) {
    const auto name = (layer == 0 ? session_.mapState_.battleback1Name : session_.mapState_.battleback2Name).text();
    const auto fallback = session_.database_["system"][layer == 0 ? "battleback1Name" : "battleback2Name"].text();
    if (name.empty() && fallback.empty()) continue;
    const auto source = image(std::string("img/battlebacks") + (layer == 0 ? "1/" : "2/") + (name.empty() ? fallback : name) + ".png");
    float x = std::fmod((width - source.width) / 2.0F, source.width);
    float y = session_.database_["system"]["optSideView"].boolean() ? std::fmod(static_cast<float>(height - source.height), source.height) : 0;
    if (x > 0) x -= source.width;
    if (y > 0) y -= source.height;
    if (!core_.renderer().queueTiled(source.handle, {1, 0, 0, 1, x, y}, {0, 0, width - x, height - y},
        {width - x, height - y}, 1, 0xffffff, BlendMode::normal)) throw std::runtime_error("cannot queue battle background");
  }
  battleSprites();
  battleEffects(); visualEffects();
  screenTone(); mapPictures(); finishScreen(first);
  const bool input = !session_.battle_.opening && !session_.message_.busy && !session_.battle_.wait && !session_.battle_.actionStage && (!session_.battleLog_ || !session_.battleLog_->isBusy()) && session_.battle_.active;
  if (input) {
    const bool party = ui.category == 4;
    std::vector<CommandItem> commands;
    if (party) commands = Window_PartyCommand::makeCommands(session_, session_.battle_.canEscape);
    else if (session_.battle_.actorIndex < static_cast<int>(session_.battleMemberCount())) {
      commands = Window_ActorCommand::makeCommands(session_, session_.party_[session_.battle_.actorIndex]);
    }
    const int topCommand = ui.cursor >= 4 && ui.category == 0 ? ui.cursor - 3 : 0;
    window(0, height - 180, 192, 180, ui.category == 0 || party ? ui.cursor - topCommand : -1, 4);
    std::vector<std::string> commandKey{std::to_string(topCommand)};
    for (int i = topCommand; i < std::min(topCommand + 4, static_cast<int>(commands.size())); ++i) {
      commandKey.push_back(commands[i].name); commandKey.push_back(commands[i].enabled ? "1" : "0");
    }
    retainBattleContents(BattleWindow::commands, std::move(commandKey), [&] {
      for (int i = topCommand; i < std::min(topCommand + 4, static_cast<int>(commands.size())); ++i)
        text(commands[i].name, 24, height - 162 + (i - topCommand) * 36, 144, 0, 28, false, commands[i].enabled ? 1 : 160.0F / 255);
    });
  }
  window(192, height - 180, width - 192, 180);
  std::vector<std::string> statusKey{session_.database_["system"]["optDisplayTp"].boolean() ? "1" : "0"};
  for (int id : session_.party_) {
    const auto& actor = session_.actors_.at(id);
    statusKey.insert(statusKey.end(), {std::to_string(id), session_.actors_.at(id).name,
      std::to_string(actor.hp), std::to_string(actor.mp),
      std::to_string(static_cast<int>(session_.parameter(actor, 0))), std::to_string(static_cast<int>(session_.parameter(actor, 1)))});
    for (int icon : battlerIcons(actor)) statusKey.push_back(std::to_string(icon));
    if (session_.database_["system"]["optDisplayTp"].boolean()) statusKey.push_back(std::to_string(actor.tp));
  }
  retainBattleContents(BattleWindow::status, std::move(statusKey), [&] {
    for (std::size_t i = 0; i < session_.battleMemberCount(); ++i) {
      const int y = height - 162 + static_cast<int>(i) * 36; const int id = session_.party_[i]; const auto& actor = session_.actors_.at(id);
      text(session_.actors_.at(id).name, 216, y, 150, actor.hp <= 0 ? 18 : actor.hp < session_.parameter(actor, 0) / 4 ? 17 : 0);
      const int x = width - 354;
      stateIcons(actor, 216 + 156, y + 2, std::max(0, x - 372 - 15));
      if (session_.database_["system"]["optDisplayTp"].boolean()) {
        gauge(actor, 0, x, y, 108); gauge(actor, 1, x + 123, y, 96); gauge(actor, 2, x + 234, y, 96);
      } else { gauge(actor, 0, x, y, 201); gauge(actor, 1, x + 216, y, 114); }
    }
  });
  if (!session_.battle_.log.empty()) {
    const auto count = std::min<std::size_t>(Window_BattleLog::maxLines(), session_.battle_.log.size());
    core::Window logWindow; logWindow.move(0, 0, width, 36 + static_cast<int>(count) * 36); logWindow.opacity = 0;
    streamUiWindow(logWindow);
    core_.renderer().queueQuad(0, 18, width, static_cast<int>(count) * 36, {0, 0, 0, 64.0F / 255});
    for (std::size_t i = 0; i < count; ++i) textEx(session_.battle_.log[i], 24, 18 + static_cast<int>(i) * 36, width - 48);
  }
  if (ui.category == 1 || ui.category == 2) {
    const int actorId = session_.party_[session_.battle_.actorIndex];
    std::vector<int> entries;
    if (ui.category == 1) {
      entries = Window_SkillList::makeSkillList(session_, actorId, ui.skillType);
    }
    else entries = Window_BattleItem::makeItemList(session_);
    window(0, 0, width, 108);
    if (!entries.empty() && ui.cursor >= 0 && ui.cursor < static_cast<int>(entries.size())) {
      const auto& selected = session_.database_[ui.category == 1 ? "skills" : "items"][entries[ui.cursor]];
      textEx(Window_Help::itemDescription(selected), 24, 18, width - 48);
    }
    const int rows = std::max(1, (height - 324) / 36);
    session_.ui_.listPageRows = rows;
    session_.ui_.listTopRow = Window_Selectable::clampTopRow(ui.listTopRow, static_cast<int>(entries.size()), 2, rows);
    std::optional<core::Rectangle> listCursor;
    if (!entries.empty() && ui.cursor >= 0 && ui.cursor < static_cast<int>(entries.size())) {
      const auto rect = Window_Selectable::itemRectFor(ui.cursor, width - 36, 2, 36, 12, ui.listTopRow);
      listCursor = core::Rectangle{double(rect.x), double(rect.y), double(rect.width), double(rect.height)};
    }
    window(0, 108, width, height - 288, ui.cursor, 0, 255, {}, listCursor);
    const int firstItem = ui.listTopRow * 2, end = std::min(static_cast<int>(entries.size()), firstItem + rows * 2);
    std::vector<std::string> selectionKey{std::to_string(ui.category), std::to_string(firstItem), std::to_string(actorId)};
    for (int index = firstItem; index < end; ++index) {
      const auto rect = Window_Selectable::itemRectFor(index, width - 36, 2, 36, 12, ui.listTopRow);
      hitTarget(18 + rect.x, 126 + rect.y, rect.width, rect.height, index);
      const int id = entries[index];
      const auto& entry = session_.database_[ui.category == 1 ? "skills" : "items"][id];
      const bool enabled = ui.category == 1 ? Window_SkillList::isEnabled(session_, actorId, id) : Window_ItemList::isEnabled(session_, id);
      selectionKey.push_back(entry["name"].text());
      selectionKey.push_back(std::to_string(entry["iconIndex"].integer()));
      selectionKey.push_back(enabled ? "1" : "0");
      if (ui.category == 1) {
        const auto cost = Window_SkillList::displayedCost(session_, actorId, id);
        selectionKey.push_back(std::to_string(cost.first)); selectionKey.push_back(std::to_string(cost.second));
      } else {
        const auto found = session_.inventory_.find(id);
        selectionKey.push_back(std::to_string(found == session_.inventory_.end() ? 0 : found->second));
      }
      const int icon = entry["iconIndex"].integer();
      if (icon > 0) {
        const auto icons = image("img/system/IconSet.png");
        quad(icons.handle, icon % 16 * 32, icon / 16 * 32, 32, 32, 20 + rect.x, 128 + rect.y, 32, 32, enabled ? 1 : 160.0F / 255);
      }
    }
    retainBattleContents(BattleWindow::selection, selectionKey, [&] {
      for (int index = firstItem; index < end; ++index) {
        const auto rect = Window_Selectable::itemRectFor(index, width - 36, 2, 36, 12, ui.listTopRow);
        const int id = entries[index], x = 18 + rect.x, y = 126 + rect.y;
        const auto& entry = session_.database_[ui.category == 1 ? "skills" : "items"][id];
        const bool enabled = ui.category == 1 ? Window_SkillList::isEnabled(session_, actorId, id) : Window_ItemList::isEnabled(session_, id);
        const float opacity = enabled ? 1 : 160.0F / 255;
        text(entry["name"].text(), x + 38, y, std::max(0, rect.width - 98), 0, 28, false, opacity);
        if (ui.category == 1) {
          const auto cost = Window_SkillList::displayedCost(session_, actorId, id);
          if (cost.first > 0) text(std::to_string(cost.first), x + rect.width - 54, y, 48, cost.second, 28, true, opacity);
        } else {
          const auto found = session_.inventory_.find(id);
          text(":" + std::to_string(found == session_.inventory_.end() ? 0 : found->second), x + rect.width - 54, y, 48, 0, 28, true, opacity);
        }
      }
    });
  } else if (ui.category == 3) {
    const auto& skill = session_.database_[ui.itemAction ? "items" : "skills"][ui.pendingId];
    const bool enemies = skill["scope"].integer() >= 1 && skill["scope"].integer() <= 6;
    const auto targets = session_.battleSelectableTargets(skill);
    const int columns = enemies ? Window_BattleEnemy::columns() : Window_BattleActor::columns();
    const int rows = enemies ? Window_BattleEnemy::visibleRows() : Window_BattleActor::visibleRows();
    const auto box = enemies ? Window_BattleEnemy::placement(width,height) : Window_BattleActor::placement(width,height);
    session_.ui_.targetTopRow = Window_Selectable::clampTopRow(ui.targetTopRow,static_cast<int>(targets.size()),columns,rows);
    const int firstTarget = ui.targetTopRow*columns, last = std::min(firstTarget+rows*columns,static_cast<int>(targets.size()));
    std::optional<core::Rectangle> targetCursor;
    if (!targets.empty() && ui.cursor >= 0 && ui.cursor < static_cast<int>(targets.size())) {
      const auto rect = Window_Selectable::itemRectFor(ui.cursor, box.width - 36, columns, 36, 12, ui.targetTopRow);
      targetCursor = core::Rectangle{double(rect.x), double(rect.y), double(rect.width), double(rect.height)};
    }
    window(box.x,box.y,box.width,box.height,ui.cursor,0,255,{},targetCursor);
    std::vector<std::string> selectionKey{"3",enemies ? "enemy" : "actor",std::to_string(firstTarget),std::to_string(box.x),std::to_string(box.y),std::to_string(box.width),session_.database_["system"]["optDisplayTp"].boolean() ? "1" : "0"};
    for (int index = firstTarget; index < last; ++index) {
      const auto rect = Window_Selectable::itemRectFor(index,box.width-36,columns,36,12,ui.targetTopRow);
      hitTarget(box.x+18+rect.x,box.y+18+rect.y,rect.width,rect.height,index);
      selectionKey.push_back(enemies ? Window_BattleEnemy::nameFor(session_,targets[index]) : Window_BattleActor::nameFor(session_,targets[index]));
      if (!enemies) {
        const auto& actor = session_.actors_.at(session_.party_[targets[index]]);
        selectionKey.insert(selectionKey.end(),{std::to_string(actor.hp),std::to_string(actor.mp),std::to_string(actor.tp),std::to_string(session_.parameter(actor,0)),std::to_string(session_.parameter(actor,1))});
        for (int icon : battlerIcons(actor)) selectionKey.push_back(std::to_string(icon));
      }
    }
    retainBattleContents(BattleWindow::selection,selectionKey,[&] {
      for (int index = first; index < last; ++index) {
        const auto rect = Window_Selectable::itemRectFor(index,box.width-36,columns,36,12,ui.targetTopRow);
        const int x = box.x+24+rect.x, y = box.y+18+rect.y;
        if (enemies) text(Window_BattleEnemy::nameFor(session_,targets[index]),x,y,rect.width-12);
        else {
          const auto& actor = session_.actors_.at(session_.party_[targets[index]]);
          text(Window_BattleActor::nameFor(session_,targets[index]),x,y,150,actor.hp <= 0 ? 18 : actor.hp < session_.parameter(actor,0)/4 ? 17 : 0);
          const int gaugeX = box.x+box.width-354;
          stateIcons(actor,x+156,y+2,std::max(0,gaugeX-x-156));
          if (session_.database_["system"]["optDisplayTp"].boolean()) {
            gauge(actor,0,gaugeX,y,108); gauge(actor,1,gaugeX+123,y,96); gauge(actor,2,gaugeX+234,y,96);
          } else { gauge(actor,0,gaugeX,y,201); gauge(actor,1,gaugeX+216,y,114); }
        }
      }
    });
  }
}
void Presentation::battleEffects() {
  for (const auto& visual : session_.battle_.visuals) {
    for (const auto& target : visual.targets) {
      if (!target.impact || target.impact > session_.ticks_) continue;
      const auto age = session_.ticks_ - target.impact;
      if (age >= 90) continue;
      const bool enemy = target.enemy;
      const int index = target.index;
      float x, y;
      if (enemy) {
        const auto& member = session_.database_["troops"][session_.battle_.troopId]["members"][index];
        x = member["x"].number(); y = member["y"].number() - 8;
      } else {
        if (!session_.database_["system"]["optSideView"].boolean()) continue;
        if (index < 0 || index >= static_cast<int>(session_.party_.size())) continue;
        x = 600 + index * 32 - 32; y = 280 + index * 48;
      }
      if (!target.result.hpAffected && !target.result.mpDamage && !target.result.missed && !target.result.evaded) continue;
      const auto source = image("img/system/Damage.png");
      for (const auto& digit : Sprite_Damage::popup(target.result, age, source.width, source.height, target.aliveAtImpact)) {
        std::array<float,4> flash{};
        std::copy(digit.blendColor.begin(), digit.blendColor.end(), flash.begin());
        core_.renderer().queueImage(source.handle,
          {1,0,0,1,float(x + digit.x),float(y + digit.y)},
          {float(digit.source.x),float(digit.source.y),float(digit.source.width),float(digit.source.height)},
          digit.opacity,0xffffff,BlendMode::normal,{},flash);
      }
    }
  }
}
namespace {
int audioChannelIndex(const std::string& kind) {
  return kind == "bgm" ? 0 : kind == "bgs" ? 1 : kind == "me" ? 2 : 3;
}
void applyAudioParameters(core::WebAudio& voice, const Value& sound, int channelVolume) {
  voice.setVolume(sound["volume"].number(90) * channelVolume / 10000.0);
  voice.setPitch(sound["pitch"].number(100) / 100.0);
  voice.setPan(sound["pan"].number() / 100.0);
}
std::unique_ptr<core::WebAudio> loadAudioVoice(RuntimeCore& core, const std::string& kind, const std::string& name) {
  const std::string stem = "audio/" + kind + "/" + name;
  std::string url;
  if (Decrypter::hasEncryptedAudio) {
    if (core.vfs().resolve(stem + ".rpgmvo")) url = stem + ".ogg";
    else if (core.vfs().resolve(stem + ".rpgmvm")) url = stem + ".m4a";
  }
  if (url.empty()) {
    if (core.vfs().resolve(stem + ".ogg")) url = stem + ".ogg";
    else if (core.vfs().resolve(stem + ".m4a")) url = stem + ".m4a";
    else if (core.vfs().resolve(stem + ".rpgmvo")) url = stem + ".ogg";
    else if (core.vfs().resolve(stem + ".rpgmvm")) url = stem + ".m4a";
  }
  if (url.empty()) throw std::runtime_error("audio unavailable: " + name);
  auto voice = std::make_unique<core::WebAudio>(url, false, false);
  if (!voice->isReady()) throw std::runtime_error("audio unavailable: " + name);
  return voice;
}
}  // namespace

void Presentation::processAudio() {
  if (musicEffect_ && !musicEffect_->isPlaying()) {
    musicEffect_.reset();
    if (audio_["bgm"].second && audio_["bgm"].second->nativeHandle()) {
      core_.media().setSuspended(audio_["bgm"].second->nativeHandle(), false);
    }
  }
  for (const auto& command : session_.audioCommands_) {
    auto kind = command["kind"].text();
    if (kind == "battle-save") {
      session_.battle_.mapBgm = audioState("bgm"); session_.battle_.mapBgs = audioState("bgs"); continue;
    }
    if (kind == "save-bgm") { session_.system_.storedBgm = audioState("bgm"); continue; }
    if (kind == "stop-se") {
      sounds_.clear(); continue;
    }
    if (kind == "fade-bgm" || kind == "fade-bgs") {
      const auto channel = kind == "fade-bgm" ? "bgm" : "bgs";
      auto& active = audio_[channel];
      if (active.second && !active.first.empty()) {
        if (active.second->nativeHandle()) {
          core_.media().fade(active.second->nativeHandle(), -1.0F, 0.0F, command["sound"].number(), true);
        }
        active.first.clear();
        audioSettings_[channel] = Value::Object{{"name", ""}, {"volume", 0}, {"pitch", 0}, {"pan", 0}, {"pos", 0}};
      }
      continue;
    }
    if (kind == "fade-in-bgm" || kind == "fade-in-bgs") {
      const auto channel = kind == "fade-in-bgm" ? "bgm" : "bgs";
      auto& active = audio_[channel];
      if (active.second && !active.first.empty()) active.second->fadeIn(command["sound"].number());
      continue;
    }
    if (kind == "fade-me") {
      if (musicEffect_ && musicEffect_->nativeHandle()) {
        core_.media().fade(musicEffect_->nativeHandle(), -1.0F, 0.0F, command["sound"].number(), true);
      }
      continue;
    }
    const bool replay = kind == "replay-bgm";
    if (replay && session_.system_.storedBgm.null()) continue;
    if (replay) kind = "bgm";
    const bool restore = kind == "battle-restore-bgm" || kind == "battle-restore-bgs";
    if (restore) kind = kind == "battle-restore-bgm" ? "bgm" : "bgs";
    const auto sound = replay ? session_.system_.storedBgm : restore ? kind == "bgm" ? session_.battle_.mapBgm : session_.battle_.mapBgs : command["sound"];
    const auto name = sound["name"].text();
    if (restore || replay) (kind == "bgm" ? session_.savedBgm_ : session_.savedBgs_) = sound;
    if (kind == "me" && musicEffect_) {
      musicEffect_.reset();
      if (audio_["bgm"].second && audio_["bgm"].second->nativeHandle()) {
        core_.media().setSuspended(audio_["bgm"].second->nativeHandle(), false);
      }
    }
    if (kind == "bgm" || kind == "bgs") {
      audioSettings_[kind] = sound;
      auto& active = audio_[kind];
      const bool changed = active.first != name;
      if ((active.first != name || name.empty()) && active.second) { active.second.reset(); active.first.clear(); }
      if (name.empty()) continue;
      if (active.first != name) {
        active.second = loadAudioVoice(core_, kind, name);
        active.first = name;
        applyAudioParameters(*active.second, sound, session_.volumes_[audioChannelIndex(kind)]);
        active.second->play(true, 0);
      }
      if (((restore || replay) && changed) || command["restart"].boolean()) {
        active.second->play(true, sound["pos"].number());
      }
      if (replay && changed) active.second->fadeIn(0.5);
    } else if (!name.empty()) {
      auto voice = loadAudioVoice(core_, kind, name);
      applyAudioParameters(*voice, sound, session_.volumes_[audioChannelIndex(kind)]);
      voice->play(false, 0);
      if (kind == "me") {
        musicEffect_ = std::move(voice);
      } else {
        sounds_.push_back(std::move(voice));
      }
    }
  }
  session_.audioCommands_.clear();
  for (auto& [kind, active] : audio_) if (active.second) {
    const auto& sound = audioSettings_[kind];
    if (sound["name"].text().empty()) {
      if (!active.second->isPlaying()) active.second.reset();
      continue;
    }
    applyAudioParameters(*active.second, sound, session_.volumes_[kind == "bgm" ? 0 : 1]);
    if (kind == "bgm" && musicEffect_ && active.second->nativeHandle()) {
      core_.media().setSuspended(active.second->nativeHandle(), true);
    }
  }
  for (auto it = sounds_.begin(); it != sounds_.end();) {
    if (!(*it)->isPlaying()) it = sounds_.erase(it);
    else ++it;
  }
}
Value Presentation::audioState(const std::string& kind) {
  auto sound = audioSettings_[kind];
  if (sound.null()) sound = Value::Object{{"name", ""}, {"volume", 0}, {"pitch", 100}, {"pan", 0}};
  std::get<Value::Object>(sound.data)["pos"] = !sound["name"].text().empty() && audio_[kind].second ? audio_[kind].second->playbackPosition() : 0;
  return sound;
}
void Presentation::captureAudioState() {
  processAudio();
  session_.savedBgm_ = audioState("bgm"); session_.savedBgs_ = audioState("bgs");
}
void Presentation::render() {
  core::Graphics::tickStart();core::updateServices();core::Graphics::updateLoading();
  session_.uiHitTargets_.clear();
  const int sceneId = static_cast<int>(session_.ui_.scene);
  if (sceneId != lastScene_ || session_.mapId_ != lastMap_ || session_.presentationRevision_ != lastPresentationRevision_) {
    coreWeather_.reset();
    clearMapGeometry();
    clearTiledGeometry();
    clearBattleContents();
    clearNameContents();
    clearUiContents();
    sceneTickOrigin_ = session_.ticks_;
    imageCache_->clear();
    images_.clear();
    coreWindows_.clear(); coreWindowskin_.reset(); lastScene_ = sceneId; lastMap_ = session_.mapId_;
    lastPresentationRevision_ = session_.presentationRevision_;
  }
  for (auto handle : deferredImageReleases_) core_.images().release(handle);
  deferredImageReleases_.clear();
  processAudio();
  const auto globalCanvas=core_.canvases().info(globalTextCanvas_);
  if(globalCanvas&&(globalCanvas->width!=core_.width()||globalCanvas->height!=core_.height())) {
    core_.canvases().release(globalTextCanvas_);
    const auto created=core_.canvases().create(core_.width(),core_.height());
    if(!created)throw std::runtime_error("cannot resize global text contents");
    globalTextCanvas_=created->handle;
  }
  uiWindowOrdinal_=0;uiLayerState_.reset();uiTextClip_.reset();uiTextDirty_=false;
  textCanvas_=globalTextCanvas_;core_.canvases().clear(textCanvas_);
  const auto scene = session_.ui_.scene; const int width = core_.width(), height = core_.height();
  if (scene == Scene::title) {
    for (int layer = 1; layer <= 2; ++layer) { const auto name = session_.database_["system"][layer == 1 ? "title1Name" : "title2Name"].text(); if (name.empty()) continue; const auto source = image("img/titles" + std::to_string(layer) + "/" + name + ".png"); const float scale = std::max(static_cast<float>(width) / source.width, static_cast<float>(height) / source.height); quad(source.handle, 0, 0, source.width, source.height, (width - source.width * scale) / 2, (height - source.height * scale) / 2, source.width * scale, source.height * scale); }
    if (session_.database_["system"]["optDrawTitle"].boolean()) {
      const auto title = session_.database_["system"]["gameTitle"].text();
      const float measured = core_.canvases().measureText(fonts_, title, 72).value_or(0);
      const float x = (width - measured) / 2, y = height / 4 + (48 + 72 * 0.7F) / 2;
      core_.canvases().drawText(textCanvas_, fonts_, title, x, y, 72, 0x000000ff, 8);
      core_.canvases().drawText(textCanvas_, fonts_, title, x, y, 72, 0xffffffff);
      uiTextDirty_=true;
    }
    const int openness = session_.newGamePending_ ? session_.titleWindowOpenness_ : std::clamp((session_.ui_.age - 24) * 32, 0, 255);
    const int x = width / 2 - 120, y = height - 240; window(x, y, 240, 144, session_.ui_.cursor, 3, openness);
    const auto commands = Window_TitleCommand::makeCommands(session_);
    for (std::size_t i = 0; i < commands.size() && openness == 255; ++i) {
      text(commands[i].name, x + 24, y + 18 + static_cast<int>(i) * 36, 192, 0, 28, false, commands[i].enabled ? 1 : 160.0F / 255);
    }
  } else if (scene == Scene::gameOver) {
    const auto source = image("img/system/GameOver.png"); quad(source.handle, 0, 0, source.width, source.height, 0, 0, width, height);
  } else if (scene == Scene::battle) { battle(); message(); }
  else {
    const auto first = core_.renderer().queuedCommandCount();
    if (session_.mapId_ > 0) map();
    if (scene == Scene::map) { visualEffects(); screenTone(); weather(); mapPictures(); finishScreen(first); mapName(); message(); }
    else menu();
  }
  finishUiLayer();
  if (scene == Scene::title && session_.ui_.age < 24) core_.renderer().queueQuad(0, 0, width, height, {0, 0, 0, std::floor(255 * (1 - session_.ui_.age / 24.0F)) / 255});
  if (session_.sceneFadeOpacity_ > 0) core_.renderer().queueQuad(0, 0, width, height, {0, 0, 0, static_cast<float>(session_.sceneFadeOpacity_ / 255)});
  movie();
  if(movieAudio_)core_.media().setParameters(movieAudio_,core::Graphics::videoVolume,1,0);
  core::Graphics::presentOverlay();core::Graphics::tickEnd();++core::Graphics::frameCount;
}
}  // namespace pmjs::mv
