#include "mv_presentation.hpp"
#include "mv_windows.hpp"
#include "mv_managers.hpp"
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
  core::Graphics::initialize(core_.width(),core_.height());
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
  if (budget > 0) imageCache_->limit = static_cast<std::size_t>(budget);
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
  textCanvas_ = canvas->handle;
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
  core_.canvases().release(textCanvas_);
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
    draw(frameX, frameY, frameWidth, frameHeight - depth, y - depth, alpha, BlendMode::normal);
    draw(frameX, frameY + frameHeight - depth, frameWidth, depth, y, alpha * 128.0F / 255, BlendMode::normal);
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
  auto& window=coreWindows_[{x,y,width,height}];if(!window)window=std::make_shared<core::Window>();
  window->windowskin=coreWindowskin_;window->move(x,y,width,height);window->openness=std::clamp(openness,0,255);
  window->contents=std::move(contents);
  window->active=selected>=0;window->synchronize(session_.ticks_);window->animationCount=session_.ticks_;
  const auto& tone=session_.system_.windowTone.null()?session_.database_["system"]["windowTone"]:session_.system_.windowTone;
  window->setTone(tone[0].number(),tone[1].number(),tone[2].number());
  if(cursor)window->setCursorRect(cursor->x,cursor->y,cursor->width,cursor->height);
  else if(selected>=0&&rows>0)window->setCursorRect(0,selected%rows*36,std::max(0,width-36),36);else window->setCursorRect(0,0,0,0);
  window->render(core_.renderer());
}
void Presentation::text(const std::string& value, int x, int y, int width, int color, int size, bool right, float opacity) {
  if (value.empty()) return;
  const double measured = core_.canvases().measureText(fonts_, value, size).value_or(0);
  const int destinationX = right ? x + width - static_cast<int>(std::ceil(measured)) : x;
  core_.canvases().drawText(textCanvas_, fonts_, value, destinationX, y + (36 + size * 0.7F) / 2, size, 128, 4);
  core_.canvases().drawText(textCanvas_, fonts_, value, destinationX, y + (36 + size * 0.7F) / 2, size, (colors_[std::clamp(color, 0, 31)] & 0xffffff00U) | static_cast<std::uint32_t>(255 * opacity));
}
void Presentation::textEx(const std::string& source, int x, int y, int width, int size, bool prepared) {
  const auto value = prepared ? source : Window_Base::processEscapeCodes(source,session_);
  const int initialX = x, initialSize = size;
  int color = 0;
  for (std::size_t index = 0; index < value.size();) {
    if (value[index] == '\n') { x = initialX; y += std::max(36,size+8); ++index; continue; }
    if (value[index] == '\x1b' && index+1 < value.size()) {
      const char code = std::toupper(static_cast<unsigned char>(value[index+1]));
      if (code == '{' || code == '}') { size = std::clamp(size+(code == '{' ? 12 : -12),12,96); index += 2; continue; }
      if ((code == 'C' || code == 'I') && index+2 < value.size() && value[index+2]=='[') {
        const auto end = value.find(']',index+3);
        if (end != std::string::npos) {
          const int argument = std::atoi(value.substr(index+3,end-index-3).c_str());
          if (code == 'C') color = argument;
          else { const auto icon = image("img/system/IconSet.png"); quad(icon.handle,argument%16*32,argument/16*32,32,32,x+2,y+2,32,32); x += 36; }
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
    const int measured = static_cast<int>(std::ceil(core_.canvases().measureText(fonts_,glyph,size).value_or(size/2)));
    if (width > 0 && x-initialX+measured > width) { x = initialX; y += std::max(36,initialSize+8); }
    text(glyph,x,y,measured,color,size); x += measured; index += length;
  }
}
void Presentation::face(int actorId, int x, int y) {
  const auto& actor = session_.actors_.at(actorId);
  if (actor.faceName.empty()) return;
  const auto source = image("img/faces/" + actor.faceName + ".png");
  const int index = actor.faceIndex;
  quad(source.handle, index % 4 * 144, index / 4 * 144, 144, 144, x, y, 144, 144);
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
void Presentation::actorStatus(int actorId, int x, int y, int width, bool portrait) {
  const auto& actor = session_.actors_.at(actorId);
  if (portrait) { face(actorId, x, y); x += 162; width -= 162; }
  text(actor.name, x, y, width);
  text(session_.database_["classes"][actor.classId]["name"].text(), x + 180, y, width - 180);
  text("Lv", x, y + 36, 48, 16); text(std::to_string(actor.level), x + 48, y + 36);
  stateIcons(actor,x+84,y+36,std::max(0,width-84));
  for (int i = 0; i < 2; ++i) gauge(actor, i, x, y + 72 + i * 36, std::min(186, width));
}
void Presentation::message() {
  const auto& message = session_.message_;
  if (!message.busy) return;
  if (message.scrolling) {
    for (std::size_t line = 0; line < message.lines.size(); ++line)
      textEx(message.lines[line].text(), 18, static_cast<int>(line*36-message.scrollY), core_.width()-36);
    return;
  }
  const auto& style = settings_["messageStyle"];
  const int lineHeight = style["lineHeight"].integer(36), padding = style["padding"].integer(18);
  const int inset = style["inset"].integer(), width = core_.width() - inset * 2;
  const int height = lineHeight * 4 + padding * 2;
  const int y = message.position * (core_.height() - height) / 2 + (message.position == 2 ? -style["bottomInset"].integer() : message.position == 0 ? style["bottomInset"].integer() : 0);
  if (message.background == 0) window(inset, y, width, height);
  else if (message.background == 1) core_.renderer().queueQuad(inset, y, width, height, {0, 0, 0, 0.6F});
  int x = inset + padding + style["textInset"].integer();
  if (!message.faceName.empty()) { const auto bitmap = image("img/faces/" + message.faceName + ".png"); quad(bitmap.handle, message.faceIndex % 4 * 144, message.faceIndex / 4 * 144, 144, 144, 18, y + 18, 144, 144); x = 186; }
  const int remaining = message.revealFinished || message.textPaused ? 1 : 0;
  std::string visible;
  for (int index = message.firstLine; index < message.pageEnd(); ++index) {
    if (index >= static_cast<int>(message.expandedLines.size()) || index >= static_cast<int>(message.revealLengths.size())) break;
    if (index != message.firstLine) visible += '\n';
    visible += message.expandedLines[index].substr(0,message.revealLengths[index]);
  }
  textEx(visible,x,y+padding+style["textOffsetY"].integer(),width-x-padding,style["fontSize"].integer(28),true);
  if (message.goldWindow) { const int gx = core_.width()-240, gy = message.position == 0 ? core_.height()-72 : 0; window(gx,gy,240,72); text(std::to_string(session_.gold_),gx+18,gy+18,180,0,28,true); }
  if (!message.revealFinished) {
    if (message.textPaused) { const auto skin = image("img/system/Window.png"); const int frame = static_cast<int>(session_.ticks_/16)%4; quad(skin.handle,144+frame%2*24,96+frame/2*24,24,24,core_.width()/2-12,y+height-24,24,24); }
    return;
  }
  if (session_.ui_.maxDigits > 0) {
    const auto& ui = session_.ui_; const int digitWidth = 32, popupWidth = ui.maxDigits*digitWidth+36;
    const bool bottom = y >= core_.height()/2;
    const int px = (core_.width()-popupWidth)/2, py = bottom ? y-80 : y+height+8;
    window(px,py,popupWidth,72);
    core_.renderer().queueQuad(px+18+ui.digitIndex*digitWidth,py+18,digitWidth,36,{0.4F,0.5F,0.8F,0.4F});
    auto digits = std::to_string(ui.numberInput); digits.insert(0,std::max(0,ui.maxDigits-static_cast<int>(digits.size())),'0');
    for (int digit = 0; digit < ui.maxDigits; ++digit) {
      const int dx = px+18+digit*digitWidth;
      const auto value = digits.substr(digit,1);
      const double measured = core_.canvases().measureText(fonts_,value,28).value_or(0);
      hitTarget(dx,py+18,digitWidth,36,digit);
      text(value,dx+static_cast<int>((digitWidth-measured)/2),py+18,digitWidth);
    }
    if (ui.numberButtonsVisible) {
      const auto sheet = image("img/system/ButtonSet.png");
      const auto bounds = Window_NumberInput::buttonBounds({px,py,popupWidth,72},bottom);
      for (int index = 0; index < 3; ++index) {
        Sprite_Button button;
        const auto cold = Window_NumberInput::buttonFrame(index,false), hot = Window_NumberInput::buttonFrame(index,true);
        button.setColdFrame(cold.x,cold.y,cold.width,cold.height);
        button.setHotFrame(hot.x,hot.y,hot.width,hot.height);
        button.touching = ui.numberButtonFrame == index;
        button.updateFrame();
        const auto& frame = button.frame;
        quad(sheet.handle,frame.x,frame.y,frame.width,frame.height,bounds[index].x,bounds[index].y,bounds[index].width,bounds[index].height);
        hitTarget(bounds[index].x,bounds[index].y,bounds[index].width,bounds[index].height,index,8+index);
      }
    }
    return;
  }
  if (session_.ui_.variableId > 0 && session_.ui_.category > 0) {
    const auto items = Window_EventItem::makeItemList(session_, session_.ui_.category);
    const int py = message.position == 0 ? core_.height()-180 : 0;
    session_.ui_.listTopRow = Window_Selectable::clampTopRow(session_.ui_.listTopRow, static_cast<int>(items.size()), 2, 4);
    const int first = session_.ui_.listTopRow * 2;
    window(0,py,core_.width(),180);
    for (int index = first; index < std::min(first + 8, static_cast<int>(items.size())); ++index) {
      const auto rect = Window_Selectable::itemRectFor(index, core_.width()-36, 2, 36, 12, session_.ui_.listTopRow);
      hitTarget(18+rect.x,py+18+rect.y,rect.width,rect.height,index);
      if (index == session_.ui_.cursor) core_.renderer().queueQuad(18+rect.x,py+18+rect.y,rect.width,rect.height,{0.4F,0.5F,0.8F,0.4F});
      const int id = items[index]; text(session_.database_["items"][id]["name"].text(),24+rect.x,py+18+rect.y,rect.width-78);
      text(std::to_string(session_.inventory_[id]),18+rect.x+rect.width-66,py+18+rect.y,60,0,28,true);
    }
    return;
  }
  if (remaining > 0 || message.lines.empty() || (message.pauseIndex < message.pauses.size() && session_.messageAge_ >= message.pauses[message.pauseIndex] + 8)) {
    if (message.choices.empty() || message.pageEnd() < static_cast<int>(message.lines.size())) {
      if (!style["pauseImage"].text().empty()) {
        const auto cursor = image(style["pauseImage"].text());
        const float anchor = 0.5F + std::sin(session_.ui_.age * 0.1F) * 0.1F;
        quad(cursor.handle, 0, 0, cursor.width, cursor.height, inset + width - 40 - cursor.width * anchor,
          y + height - 10 - cursor.height, cursor.width, cursor.height);
      } else {
        const auto skin = image("img/system/Window.png"); const int frame = static_cast<int>(session_.ticks_ / 16) % 4;
        quad(skin.handle, 144 + frame % 2 * 24, 96 + frame / 2 * 24, 24, 24, core_.width() / 2 - 12, y + height - 24, 24, 24);
      }
    } else {
      int width = 96;
      for (const auto& choice : message.choices) width = std::max(width, static_cast<int>(std::ceil(core_.canvases().measureText(fonts_, choice.text(), 28).value_or(0))) + 48);
      const int h = static_cast<int>(message.choices.size()) * 36 + 36, cy = message.position == 2 ? y - h : y + height;
      const int cx = message.choicePosition == 0 ? 0 : message.choicePosition == 1 ? (core_.width()-width)/2 : core_.width()-width;
      if (message.choiceBackground == 0) window(cx,cy,width,h,session_.ui_.cursor,static_cast<int>(message.choices.size()));
      else if (message.choiceBackground == 1) core_.renderer().queueQuad(cx,cy,width,h,{0,0,0,0.6F});
      for (std::size_t i = 0; i < message.choices.size(); ++i) { hitTarget(cx+18,cy+18+static_cast<int>(i)*36,width-36,36,static_cast<int>(i)); textEx(message.choices[i].text(),cx+24,cy+18+static_cast<int>(i)*36,width-48); }
    }
  }
}
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
    window(0,0,width,108);
    if (selected) textEx(session_.database_[selected->kind == 0 ? "items" : selected->kind == 1 ? "weapons" : "armors"][selected->id]["description"].text(),24,18,width-48);
    window(0,108,width-240,72); window(width-240,108,240,72);
    const auto commands = Window_ShopCommand::makeCommands(session_,ui.shopPurchaseOnly);
    for (std::size_t i = 0; i < commands.size(); ++i) {
      const auto rect = Window_Selectable::itemRectFor(static_cast<int>(i),width-276,3,36,12,0);
      if (ui.category == 0) {
        hitTarget(18+rect.x,126,rect.width,36,static_cast<int>(i));
        if (ui.cursor == static_cast<int>(i)) core_.renderer().queueQuad(18+rect.x,126,rect.width,36,{0.4F,0.5F,0.8F,0.4F});
      }
      text(commands[i].name,24+rect.x,126,rect.width-12,0,28,false,commands[i].enabled ? 1 : 160.0F/255);
    }
    text(std::to_string(session_.gold_),width-222,126,180,0,28,true);
    window(0,180,statusVisible ? 456 : width,height-180);
    if (statusVisible) {
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
    }
    if (ui.category == 3) {
      const auto& item = session_.database_[ui.shopKind == 0 ? "items" : ui.shopKind == 1 ? "weapons" : "armors"][ui.shopId];
      text(item["name"].text(),24,216,408); text("×",24,288,200,16);
      text(std::to_string(ui.shopItemCount),240,288,120,0,28,true);
      text(std::to_string(static_cast<std::int64_t>(ui.shopItemCount)*ui.shopPrice),252,360,180,0,28,true);
      const std::array<std::string,5> buttons{"-10","-1","+1","+10","OK"};
      const std::array<int,5> actions{7,5,4,6,1};
      for (int button = 0; button < 5; ++button) { const int bx = 24+button*84; hitTarget(bx,432,72,48,0,actions[button]); text(buttons[button],bx,438,72); }
      return;
    }
    if (ui.category == 0) return;
    const bool selling = ui.category == 2 || ui.category == 4;
    if (selling) {
      window(0,180,width,72);
      const std::array<std::string,4> categories{TextManager::item(session_),TextManager::weapon(session_),TextManager::armor(session_),TextManager::keyItem(session_)};
      for (int index = 0; index < 4; ++index) {
        const auto rect = Window_Selectable::itemRectFor(index,width-36,4,36,12,0);
        if (ui.category == 4) {
          hitTarget(18+rect.x,198,rect.width,36,index);
          if (ui.cursor == index) core_.renderer().queueQuad(18+rect.x,198,rect.width,36,{0.4F,0.5F,0.8F,0.4F});
        }
        text(categories[index],24+rect.x,198,rect.width-12);
      }
    }
    const auto goods = session_.shopItems(selling);
    const int columns = selling ? 2 : 1, baseY = selling ? 270 : 198;
    const int rows = std::max(1,(height-baseY-18)/36);
    session_.ui_.listPageRows = rows;
    session_.ui_.listTopRow = Window_Selectable::clampTopRow(ui.listTopRow,static_cast<int>(goods.size()),columns,rows);
    const int first = ui.listTopRow*columns;
    for (int index = first; index < std::min(first+rows*columns,static_cast<int>(goods.size())); ++index) {
      const auto rect = Window_Selectable::itemRectFor(index,(selling ? width : 456)-36,columns,36,12,ui.listTopRow);
      const int x = 18+rect.x, y = baseY+rect.y;
      if (ui.category != 4) {
        hitTarget(x,y,rect.width,36,index);
        if (ui.cursor == index) core_.renderer().queueQuad(x,y,rect.width,36,{0.4F,0.5F,0.8F,0.4F});
      }
      const auto& good = goods[index]; const auto& item = session_.database_[good.kind == 0 ? "items" : good.kind == 1 ? "weapons" : "armors"][good.id];
      const float opacity = session_.shopMaximum(good,selling,session_.gold_) > 0 ? 1 : 160.0F/255;
      text(item["name"].text(),x+6,y,rect.width-108,0,28,false,opacity);
      const int value = selling ? session_.inventory_.at(good.kind*100000+good.id) : good.price;
      text(std::to_string(value),x+rect.width-86,y,80,0,28,true,opacity);
    }
    return;
  }
  if (ui.scene == Scene::menu) {
    const auto commands = Window_MenuCommand::makeCommands(session_);
    const int selected = ui.category == 2 ? ui.pendingId : ui.category == 1 ? ui.commandCursor : ui.cursor;
    window(0, 0, 240, 36 + static_cast<int>(commands.size()) * 36, selected, static_cast<int>(commands.size()));
    for (std::size_t i = 0; i < commands.size(); ++i) text(commands[i].name, 24, 18 + static_cast<int>(i) * 36, 192, 0, 28, false, commands[i].enabled ? 1 : 160.0F / 255);
    window(0, height - 72, 240, 72); text(std::to_string(session_.gold_), 24, height - 54, 150, 0, 28, true); text(session_.database_["system"]["currencyUnit"].text(), 192, height - 54);
    window(240, 0, width - 240, height);
    for (std::size_t i = 0; i < session_.party_.size(); ++i) {
      if (ui.category == 2) hitTarget(258,18+static_cast<int>(i)*147,width-276,147,static_cast<int>(i));
      if (ui.category == 2 && static_cast<int>(i) == ui.cursor) core_.renderer().queueQuad(258, 18 + static_cast<int>(i) * 147, width - 276, 147, {0.4F,0.5F,0.8F,0.4F});
      actorStatus(session_.party_[i], 258, 18 + static_cast<int>(i) * 147, width - 276, true);
    }
    if (ui.category == 1) {
      const auto endCommands = Window_GameEnd::makeCommands(session_);
      window(width / 2 - 120, height / 2 - 54, 240, 108, ui.cursor, static_cast<int>(endCommands.size()));
      for (std::size_t i = 0; i < endCommands.size(); ++i) text(endCommands[i].name, width / 2 - 96, height / 2 - 36 + static_cast<int>(i) * 36);
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
      text(command.name, x + 24, y + 18 + static_cast<int>(i) * 36);
      text(volume ? std::to_string(value.integer()) + "%" : value.boolean() ? "ON" : "OFF", x + 300, y + 18 + static_cast<int>(i) * 36);
    }
    return;
  }
  if (ui.scene == Scene::formation) {
    window(0, 0, width, height);
    for (std::size_t i = 0; i < session_.party_.size(); ++i) { const int y = 18 + static_cast<int>(i) * 180; hitTarget(18,y,width-36,172,static_cast<int>(i)); if (static_cast<int>(i) == ui.cursor) core_.renderer().queueQuad(18, y, width - 36, 172, {0.4F, 0.5F, 0.8F, 0.4F}); actorStatus(session_.party_[i], 24, y, width - 48, true); }
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
  window(0, 0, width, height);
  if (ui.scene == Scene::status) {
    actorStatus(actorId, 24, 18, width - 48, true);
    const std::array<std::string, 6> labels{"Attack", "Defense", "M.Attack", "M.Defense", "Agility", "Luck"};
    for (int i = 0; i < 6; ++i) { text(labels[i], 24, 216 + i * 36, 180, 16); text(std::to_string(static_cast<int>(session_.parameter(session_.actors_.at(actorId), i + 2))), 210, 216 + i * 36, 100, 0, 28, true); }
    textEx(session_.actors_.at(actorId).profile, 24, height - 90, width - 48);
    return;
  }
  if (ui.scene == Scene::equip) {
    const auto& actor = session_.actor(actorId);
    const auto commands = Window_EquipCommand::makeCommands(session_);
    window(0,0,width,108); window(0,108,312,288);
    window(312,108,width-312,72); window(312,180,width-312,216);
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
    for (std::size_t index = 0; index < commands.size(); ++index) {
      const auto rect = Window_Selectable::itemRectFor(static_cast<int>(index),width-348,3,36,12,0);
      if (ui.category == 0) {
        hitTarget(330+rect.x,126,rect.width,36,static_cast<int>(index));
        if (ui.cursor == static_cast<int>(index)) core_.renderer().queueQuad(330+rect.x,126,rect.width,36,{0.4F,0.5F,0.8F,0.4F});
      }
      text(commands[index].name,336+rect.x,126,rect.width-12);
    }
    const int selectedSlot = ui.category == 1 ? ui.cursor : std::max(0,ui.slot);
    const int slotTop = Window_Selectable::visibleTopRow(selectedSlot,0,static_cast<int>(actor.equips.size()),1,5);
    for (int index = slotTop; index < std::min(slotTop+5,static_cast<int>(actor.equips.size())); ++index) {
      const int y = 198+(index-slotTop)*36;
      if (ui.category == 1) {
        hitTarget(330,y,width-348,36,index);
        if (ui.cursor == index) core_.renderer().queueQuad(330,y,width-348,36,{0.4F,0.5F,0.8F,0.4F});
      }
      const float opacity = session_.canChangeEquip(actor,index) ? 1 : 160.0F/255;
      text(session_.database_["system"]["equipTypes"][session_.equipSlotType(actor,index)].text(),336,y,126,16,28,false,opacity);
      text(session_.database_[actor.equipKinds[index] == 1 ? "weapons" : "armors"][actor.equips[index]]["name"].text(),480,y,width-510,0,28,false,opacity);
    }
    window(0,396,width,height-396);
    if (ui.category == 1 || ui.category == 2) {
      const auto choices = Window_EquipItem::makeItemList(session_,actor.id,selectedSlot);
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
      const int encoded = ui.category == 2 ? choices[std::clamp(ui.cursor,0,static_cast<int>(choices.size())-1)] :
        actor.equips[selectedSlot]+actor.equipKinds[selectedSlot]*100000;
      if (encoded%100000) textEx(session_.database_[encoded/100000 == 1 ? "weapons" : "armors"][encoded%100000]["description"].text(),24,18,width-48);
    }
    return;
  }
  const bool skill = ui.scene == Scene::skill;
  std::vector<int> entries;
  if (skill) {
    const auto types = Window_SkillType::makeCommands(session_,actorId);
    for (std::size_t i = 0; i < types.size(); ++i) {
      const int columnWidth = std::max(120,width/std::max(1,static_cast<int>(types.size())));
      if (ui.category == 0 && static_cast<int>(i)==ui.cursor) core_.renderer().queueQuad(18+i*columnWidth,18,columnWidth-12,36,{0.4F,0.5F,0.8F,0.4F});
      if (ui.category == 0) hitTarget(18+i*columnWidth,18,columnWidth-12,36,static_cast<int>(i));
      text(types[i].name,24+i*columnWidth,18,columnWidth-24);
    }
    entries = Window_SkillList::makeSkillList(session_, actorId, ui.skillType);
  } else {
    const auto categories = Window_ItemCategory::makeCommands(session_);
    for (int i = 0; i < 4; ++i) {
      if (ui.category == 0 && ui.cursor == i) core_.renderer().queueQuad(18+i*(width/4),18,width/4-24,36,{0.4F,0.5F,0.8F,0.4F});
      if (ui.category == 0) hitTarget(18+i*(width/4),18,width/4-24,36,i);
      text(categories[i].name,24+i*(width/4),18,width/4-36);
    }
    entries = Window_ItemList::makeItemList(session_, categories[std::clamp(ui.slot,0,3)].symbol);
  }
  const int rows = std::max(1,(height-108)/36);
  session_.ui_.listPageRows = rows;
  session_.ui_.listTopRow = Window_Selectable::clampTopRow(ui.listTopRow, static_cast<int>(entries.size()), 2, rows);
  const int first = ui.listTopRow * 2;
  for (int index = first; index < std::min(first + rows * 2, static_cast<int>(entries.size())); ++index) {
    const int encoded = entries[index], kind = encoded/100000, id = encoded%100000;
    const auto rect = Window_Selectable::itemRectFor(index, width-36, 2, 36, 12, ui.listTopRow);
    const int x = 18 + rect.x, y = 90 + rect.y;
    if (!ui.targeting && ui.category != 0) hitTarget(x,y,rect.width,rect.height,index);
    if (index == ui.cursor && !ui.targeting && ui.category != 0) core_.renderer().queueQuad(x,y,rect.width,rect.height,{0.4F,0.5F,0.8F,0.4F});
    const auto& entry = session_.database_[skill ? "skills" : kind == 0 ? "items" : kind == 1 ? "weapons" : "armors"][id];
    text(entry["name"].text(),x+6,y,std::max(0,rect.width-108));
    text(std::to_string(skill ? entry["mpCost"].integer() : session_.inventory_[encoded]),x+rect.width-86,y,80,0,28,true);
  }
  if (ui.targeting) {
    const auto& item = session_.database_[ui.itemAction ? "items" : "skills"][ui.pendingId];
    const auto selection = Window_MenuActor::selection(session_,item,ui.actor);
    window(width / 2, 72, width / 2, height - 72);
    for (std::size_t i = 0; i < session_.party_.size(); ++i) {
      const int y = 90 + static_cast<int>(i) * 180;
      hitTarget(width / 2 + 18,y,width / 2 - 36,172,static_cast<int>(i));
      if (selection.all || static_cast<int>(i) == (selection.fixed ? selection.index : ui.cursor))
        core_.renderer().queueQuad(width / 2 + 18,y,width / 2 - 36,172,{0.4F,0.5F,0.8F,0.4F});
      actorStatus(session_.party_[i], width / 2 + 24, y, width / 2 - 48, true);
    }
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
    catch (...) { textCanvas_ = previous; throw; }
    textCanvas_ = previous;
    contents.key = std::move(key); contents.valid = true;
  }
  contents.visible = true;
}
void Presentation::battle() {
  const auto first = core_.renderer().queuedCommandCount();
  const int width = core_.width(), height = core_.height(); const auto& ui = session_.ui_;
  for (auto& contents : battleContents_) contents.visible = false;
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
    const int first = ui.cursor >= 4 && ui.category == 0 ? ui.cursor - 3 : 0;
    window(0, height - 180, 192, 180, ui.category == 0 || party ? ui.cursor - first : -1, 4);
    std::vector<std::string> commandKey{std::to_string(first)};
    for (int i = first; i < std::min(first + 4, static_cast<int>(commands.size())); ++i) {
      commandKey.push_back(commands[i].name); commandKey.push_back(commands[i].enabled ? "1" : "0");
    }
    retainBattleContents(BattleWindow::commands, std::move(commandKey), [&] {
      for (int i = first; i < std::min(first + 4, static_cast<int>(commands.size())); ++i)
        text(commands[i].name, 24, height - 162 + (i - first) * 36, 144, 0, 28, false, commands[i].enabled ? 1 : 160.0F / 255);
    });
  }
  window(192, height - 180, width - 192, 180);
  std::vector<std::string> statusKey{session_.database_["system"]["optDisplayTp"].boolean() ? "1" : "0"};
  for (int id : session_.party_) {
    const auto& actor = session_.actors_.at(id);
    statusKey.insert(statusKey.end(), {std::to_string(id), session_.actors_.at(id).name,
      std::to_string(actor.hp), std::to_string(actor.mp),
      std::to_string(static_cast<int>(session_.parameter(actor, 0))), std::to_string(static_cast<int>(session_.parameter(actor, 1)))});
    if (session_.database_["system"]["optDisplayTp"].boolean()) statusKey.push_back(std::to_string(actor.tp));
  }
  retainBattleContents(BattleWindow::status, std::move(statusKey), [&] {
    for (std::size_t i = 0; i < session_.battleMemberCount(); ++i) {
      const int y = height - 162 + static_cast<int>(i) * 36; const int id = session_.party_[i]; const auto& actor = session_.actors_.at(id);
      text(session_.actors_.at(id).name, 216, y, 150, actor.hp <= 0 ? 18 : actor.hp < session_.parameter(actor, 0) / 4 ? 17 : 0);
      const int x = width - 354;
      if (session_.database_["system"]["optDisplayTp"].boolean()) {
        gauge(actor, 0, x, y, 108); gauge(actor, 1, x + 123, y, 96); gauge(actor, 2, x + 234, y, 96);
      } else { gauge(actor, 0, x, y, 201); gauge(actor, 1, x + 216, y, 114); }
    }
  });
  if (!session_.battle_.log.empty()) {
    const auto count = std::min<std::size_t>(Window_BattleLog::maxLines(), session_.battle_.log.size());
    window(0, 0, width, 36 + static_cast<int>(count) * 36);
    std::vector<std::string> lines(session_.battle_.log.begin(), session_.battle_.log.begin() + count);
    retainBattleContents(BattleWindow::log, lines, [&] {
      for (std::size_t i = 0; i < lines.size(); ++i) text(lines[i], 18, 18 + static_cast<int>(i) * 36);
    });
  }
  if (ui.category == 1 || ui.category == 2) {
    window(0, 108, width, height - 288); std::vector<int> entries;
    if (ui.category == 1) {
      entries = Window_SkillList::makeSkillList(session_, session_.party_[session_.battle_.actorIndex], ui.skillType);
    }
    else entries = Window_BattleItem::makeItemList(session_);
    const int rows = std::max(1, (height - 324) / 36);
    session_.ui_.listPageRows = rows;
    session_.ui_.listTopRow = Window_Selectable::clampTopRow(ui.listTopRow, static_cast<int>(entries.size()), 2, rows);
    const int first = ui.listTopRow * 2, end = std::min(static_cast<int>(entries.size()), first + rows * 2);
    std::vector<std::string> selectionKey{std::to_string(ui.category), std::to_string(first)};
    for (int index = first; index < end; ++index) {
      const auto rect = Window_Selectable::itemRectFor(index, width - 36, 2, 36, 12, ui.listTopRow);
      hitTarget(18 + rect.x, 126 + rect.y, rect.width, rect.height, index);
      if (index == ui.cursor) core_.renderer().queueQuad(18 + rect.x, 126 + rect.y, rect.width, rect.height, {0.4F,0.5F,0.8F,0.4F});
      selectionKey.push_back(session_.database_[ui.category == 1 ? "skills" : "items"][entries[index]]["name"].text());
    }
    retainBattleContents(BattleWindow::selection, selectionKey, [&] {
      for (int index = first; index < end; ++index) {
        const auto rect = Window_Selectable::itemRectFor(index, width - 36, 2, 36, 12, ui.listTopRow);
        text(selectionKey[2 + index - first], 24 + rect.x, 126 + rect.y, rect.width - 12);
      }
    });
  } else if (ui.category == 3) {
    window(0, 108, width, 180, ui.cursor, 4); const auto& skill = session_.database_[ui.itemAction ? "items" : "skills"][ui.pendingId];
    const auto targets = session_.battleSelectableTargets(skill);
    std::vector<std::string> selectionKey{"3"};
    for (int index : targets) selectionKey.push_back(skill["scope"].integer() <= 6 ? session_.database_["enemies"][session_.battle_.enemies[index].id]["name"].text() : session_.actors_.at(session_.party_[index]).name);
    retainBattleContents(BattleWindow::selection, selectionKey, [&] {
      for (std::size_t i = 1; i < selectionKey.size(); ++i) text(selectionKey[i], 24, 126 + static_cast<int>(i - 1) * 36);
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
    sceneTickOrigin_ = session_.ticks_;
    imageCache_->clear();
    images_.clear();
    coreWindows_.clear(); coreWindowskin_.reset(); lastScene_ = sceneId; lastMap_ = session_.mapId_;
    lastPresentationRevision_ = session_.presentationRevision_;
  }
  for (auto handle : deferredImageReleases_) core_.images().release(handle);
  deferredImageReleases_.clear();
  processAudio();
  if (session_.ui_.scene != Scene::battle) core_.canvases().clear(textCanvas_);
  const auto scene = session_.ui_.scene; const int width = core_.width(), height = core_.height();
  if (scene == Scene::title) {
    for (int layer = 1; layer <= 2; ++layer) { const auto name = session_.database_["system"][layer == 1 ? "title1Name" : "title2Name"].text(); if (name.empty()) continue; const auto source = image("img/titles" + std::to_string(layer) + "/" + name + ".png"); const float scale = std::max(static_cast<float>(width) / source.width, static_cast<float>(height) / source.height); quad(source.handle, 0, 0, source.width, source.height, (width - source.width * scale) / 2, (height - source.height * scale) / 2, source.width * scale, source.height * scale); }
    if (session_.database_["system"]["optDrawTitle"].boolean()) {
      const auto title = session_.database_["system"]["gameTitle"].text();
      const float measured = core_.canvases().measureText(fonts_, title, 72).value_or(0);
      const float x = (width - measured) / 2, y = height / 4 + (48 + 72 * 0.7F) / 2;
      core_.canvases().drawText(textCanvas_, fonts_, title, x, y, 72, 0x000000ff, 8);
      core_.canvases().drawText(textCanvas_, fonts_, title, x, y, 72, 0xffffffff);
    }
    const int openness = std::clamp((session_.ui_.age - 24) * 32, 0, 255);
    const int x = width / 2 - 120, y = height - 240; window(x, y, 240, 144, session_.ui_.cursor, 3, openness);
    const auto commands = Window_TitleCommand::makeCommands(session_);
    for (std::size_t i = 0; i < commands.size() && openness == 255; ++i) {
      text(commands[i].name, x + 24, y + 18 + static_cast<int>(i) * 36, 192, 0, 28, false, commands[i].enabled ? 1 : 160.0F / 255);
    }
  } else if (scene == Scene::gameOver) {
    const auto source = image("img/system/GameOver.png"); quad(source.handle, 0, 0, source.width, source.height, 0, 0, width, height);
  } else if (scene == Scene::battle) battle();
  else {
    const auto first = core_.renderer().queuedCommandCount();
    if (session_.mapId_ > 0) map();
    if (scene == Scene::map) { visualEffects(); screenTone(); weather(); mapPictures(); finishScreen(first); mapName(); message(); }
    else menu();
  }
  if (scene == Scene::battle) {
    for (const auto& contents : battleContents_) if (contents.visible) {
      if (const auto texture = core_.canvases().prepareImage(contents.canvas)) quad(*texture, 0, 0, width, height, 0, 0, width, height);
    }
  } else if (const auto texture = core_.canvases().prepareImage(textCanvas_)) quad(*texture, 0, 0, width, height, 0, 0, width, height);
  if (scene == Scene::title && session_.ui_.age < 24) core_.renderer().queueQuad(0, 0, width, height, {0, 0, 0, std::floor(255 * (1 - session_.ui_.age / 24.0F)) / 255});
  movie();
  if(movieAudio_)core_.media().setParameters(movieAudio_,core::Graphics::videoVolume,1,0);
  core::Graphics::presentOverlay();core::Graphics::tickEnd();++core::Graphics::frameCount;
}
}  // namespace pmjs::mv
