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
  core::PixelBitmap::setImageLoader([this](const std::string& url)->std::optional<ImageInfo>{return image(url);});
  core::WebAudio::setEncryptionKey(session_.database_["system"]["encryptionKey"].text());
  core::Graphics::setLoadingCallbacks([this]{session_.resourcesStopped_=true;core_.media().suspendContext(true);},[this]{session_.resourcesStopped_=false;core_.media().suspendContext(false);});
  core::Graphics::setVideoCallbacks([this](const std::string& url){
    auto file=std::filesystem::path(url).filename();file.replace_extension();session_.movieName_=file.string();session_.moviePlaying_=!session_.movieName_.empty();
  },[this]{return session_.moviePlaying_;},[this](double volume){if(movieAudio_)core_.media().setParameters(movieAudio_,volume,1,0);});
  imageCache_ = std::make_unique<ImageCache>();
  const auto budget = settings_["imageCacheBytes"].number();
  if (budget > 0) imageCache_->limit = static_cast<std::size_t>(budget);
  Decrypter::readEncryptionkey(session_.database_["system"]);
  const auto font = core_.vfs().resolve(settings_["fontFile"].text());
  if (!font) throw std::runtime_error("game font unavailable");
  fonts_.push_back(*font);
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
  clearMapOverlays();
  clearMovie();
  clearMapGeometry();
  clearTiledGeometry();
  clearBattleContents();
  for (auto handle : deferredImageReleases_) core_.images().release(handle);
  for (auto& [key, value] : images_) { (void)key; core_.images().release(value.handle); }
  coreWindows_.clear(); coreWindowskin_.reset();
  for (auto handle : sounds_) { core_.media().stop(handle); core_.media().release(handle); }
  if (musicEffect_) { core_.media().stop(musicEffect_); core_.media().release(musicEffect_); }
  for (auto& [key, value] : audio_) { (void)key; core_.media().stop(value.second); core_.media().release(value.second); }
  for (auto surface : weatherSurfaces_) if (surface) core_.canvases().release(surface);
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
      const auto source = ImageStore::openFile(*path, imageEncryptionKey(session_.database_["system"]["encryptionKey"].text()));
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
void Presentation::tile(int id, int x, int y, std::vector<TileLayerTile>& geometry) {
  if (id <= 0) return;
  const bool tableEdge = id >= 10000;
  if (tableEdge) id -= 10000;
  const auto& tileset = session_.database_["tilesets"][session_.mapState_.tilesetId];
  auto source = [&](int set) {
    const auto name = tileset["tilesetNames"][set].text();
    if (name.empty()) throw std::runtime_error("tile refers to an absent tileset image");
    return image("img/tilesets/" + name + ".png");
  };
  if (id < 2048) {
    const auto bitmap = source(id >= 1536 ? 4 : 5 + id / 256);
    geometry.push_back({bitmap.handle, {static_cast<float>((id / 128 % 2 * 8 + id % 8) * 48), static_cast<float>(id % 256 / 8 * 48), 48, 48}, {static_cast<float>(x), static_cast<float>(y)}, {0, 0}});
    return;
  }
  const int kind = (id - 2048) / 48, shape = (id - 2048) % 48, column = kind % 8, row = kind / 8;
  std::array<float, 2> animationOffset{};
  int set = 0, baseX = 0, baseY = 0;
  std::string table = "floor";
  if (id < 2816) {
    if (kind < 4) { baseX = kind < 2 ? 0 : 6; baseY = kind % 2 * 3; }
    else {
      baseX = column / 4 * 8; baseY = row * 6 + column / 2 % 2 * 3;
      if (kind % 2) { baseX += 6; table = "waterfall"; }
    }
  } else if (id < 4352) { set = 1; baseX = column * 2; baseY = (row - 2) * 3; }
  else if (id < 5888) { set = 2; baseX = column * 2; baseY = (row - 6) * 2; table = "wall"; }
  else { set = 3; baseX = column * 2; baseY = static_cast<int>(std::floor((row - 10) * 2.5 + (row % 2 ? 0.5 : 0))); if (row % 2) table = "wall"; }
  if (id < 2816) {
    if (kind < 2 || (kind >= 4 && kind % 2 == 0)) animationOffset[0] = 96;
    else if (kind >= 4 && kind % 2) animationOffset[1] = 48;
  }
  const auto bitmap = source(set);
  const auto& quarters = session_.database_["tileTables"][table][shape].array();
  if (quarters.size() != 4) throw std::runtime_error("invalid autotile shape");
  const bool tableTile = id >= 2816 && id < 4352 && (tileset["flags"][id].integer() & 128);
  const auto append = [&](int sx,int sy,int width,int height,int px,int py) {
    geometry.push_back({bitmap.handle,{float(sx),float(sy),float(width),float(height)}, {float(px),float(py)},animationOffset});
  };
  if (tableEdge) {
    for (int i=0;i<2;++i) append((baseX*2+quarters[i+2][0].integer())*24,
      (baseY*2+quarters[i+2][1].integer())*24+12,24,12,x+i*24,y);
  } else for (int i=0;i<4;++i) {
    const int qsx=quarters[i][0].integer(),qsy=quarters[i][1].integer();
    const int sx=(baseX*2+qsx)*24,sy=(baseY*2+qsy)*24,px=x+i%2*24,py=y+i/2*24;
    if (tableTile && (qsy==1 || qsy==5)) {
      constexpr std::array<int,4> alternate{0,3,2,1};
      append((baseX*2+(qsy==1?alternate[qsx]:qsx))*24,(baseY*2+3)*24,24,24,px,py);
      append(sx,sy,24,12,px,py+12);
    } else append(sx,sy,24,24,px,py);
  }
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
  bool big = false, object = tileImage;
  for (char sign : value.characterName) {
    if (sign != '!' && sign != '$') break;
    big = big || sign == '$'; object = object || sign == '!';
  }
  ImageInfo source;
  double frameX = 0, frameY = 0, frameWidth = tw, frameHeight = th;
  if (tileImage) {
    const auto& tileset = session_.database_["tilesets"][session_.mapState_.tilesetId];
    const auto name = tileset["tilesetNames"][5 + value.tileId / 256].text();
    if (name.empty()) return;
    source = image("img/tilesets/" + name + ".png");
    frameX = (value.tileId / 128 % 2 * 8 + value.tileId % 8) * tw;
    frameY = (value.tileId % 256 / 8 % 16) * th;
  } else {
    source = image("img/characters/" + value.characterName + ".png");
    frameWidth = value.customFrameWidth > 0 ? value.customFrameWidth : value.singleFrame ? source.width : source.width / (big ? 3.0 : 12.0);
    frameHeight = value.customFrameHeight > 0 ? value.customFrameHeight : value.singleFrame ? source.height : source.height / (big ? 4.0 : 8.0);
    const int pattern = value.pattern < 3 ? value.pattern : 1;
    const int column = value.customFrameX >= 0 ? value.customFrameX : value.singleFrame ? 0 : (big ? 0 : value.characterIndex % 4 * 3) + pattern;
    const int row = value.customFrameY >= 0 ? value.customFrameY : value.singleFrame ? 0 : (big ? 0 : value.characterIndex / 4 * 4) + (value.direction - 2) / 2;
    frameX = column * frameWidth; frameY = row * frameHeight;
  }
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
    const auto name=picture["_name"].text();const double opacity=picture["_opacity"].number();
    if(name.empty()||opacity<=0)continue;
    const auto source=image("img/pictures/"+name+".png");
    const auto& frame=picture["_frameData"]["frames"][picture["_frameData"]["frameIndex"].integer()];
    const int sx=frame["x"].integer(),sy=frame["y"].integer(),sw=frame["width"].integer(source.width),sh=frame["height"].integer(source.height);
    const float width=sw*picture["_scaleX"].number(100)/100,height=sh*picture["_scaleY"].number(100)/100;
    float x=picture["_x"].number(),y=picture["_y"].number();
    if(picture["_pinnedToMap"].boolean()){x-=cameraX_*tw;y-=cameraY_*th;}
    const double radians = picture["_angle"].number() * 3.14159265358979323846 / 180;
    const float a = std::cos(radians) * width / sw, b = std::sin(radians) * width / sw;
    const float c = -std::sin(radians) * height / sh, d = std::cos(radians) * height / sh;
    if(picture["_origin"].integer()==1){x-=(a*sw+c*sh)/2;y-=(b*sw+d*sh)/2;}
    std::array<float, 4> tone{};
    for (std::size_t component = 0; component < 4; ++component) tone[component] = picture["_tone"][component].number() / 255;
    if(!core_.renderer().queueImage(source.handle,{a,b,c,d,x,y},
      {float(sx),float(sy),float(sw),float(sh)},opacity/255,0xffffff,static_cast<BlendMode>(picture["_blendMode"].integer()),tone))throw std::runtime_error("cannot queue picture");
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
  if (!core_.renderer().queueTiled(source.handle, {1, 0, 0, 1, 0, 0},
      {static_cast<float>(ox), static_cast<float>(oy), width, height}, {width, height},
      1, 0xffffff, BlendMode::normal)) throw std::runtime_error("cannot queue map parallax");
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
void Presentation::window(int x,int y,int width,int height,int selected,int rows,int openness) {
  if(openness<=0)return;
  if(selected>=0&&rows>0&&openness>=255){const int base=session_.ui_.cursor-selected;for(int row=0;row<rows;++row)hitTarget(x+18,y+18+row*36,width-36,36,base+row);}
  if(!coreWindowskin_) {
    const auto skin=image("img/system/Window.png");
    coreWindowskin_=std::make_shared<core::PixelBitmap>(core_,skin.width,skin.height);
    if(!core_.canvases().drawImage(coreWindowskin_->nativeCanvas(),skin.handle,0,0,skin.width,skin.height,0,0,skin.width,skin.height,1))throw std::runtime_error("cannot prepare windowskin");
  }
  auto& window=coreWindows_[{x,y,width,height}];if(!window)window=std::make_shared<core::Window>();
  window->windowskin=coreWindowskin_;window->move(x,y,width,height);window->openness=std::clamp(openness,0,255);
  window->animationCount=session_.ticks_;window->active=selected>=0;
  const auto& tone=session_.system_.windowTone.null()?session_.database_["system"]["windowTone"]:session_.system_.windowTone;
  window->setTone(tone[0].number(),tone[1].number(),tone[2].number());
  if(selected>=0&&rows>0)window->setCursorRect(0,selected%rows*36,std::max(0,width-36),36);else window->setCursorRect(0,0,0,0);
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
    const auto& ui = session_.ui_; const int digitWidth = 28, popupWidth = ui.maxDigits*digitWidth+108;
    const int px = (core_.width()-popupWidth)/2, py = message.position == 2 ? y-144 : y+height;
    window(px,py,popupWidth,144);
    core_.renderer().queueQuad(px+18+ui.digitIndex*digitWidth,py+54,digitWidth,36,{0.4F,0.5F,0.8F,0.4F});
    auto digits = std::to_string(ui.numberInput); digits.insert(0,std::max(0,ui.maxDigits-static_cast<int>(digits.size())),'0');
    for (int digit = 0; digit < ui.maxDigits; ++digit) {
      const int dx = px+18+digit*digitWidth;
      hitTarget(dx,py+54,digitWidth,36,digit); text(digits.substr(digit,1),dx,py+54,digitWidth);
      hitTarget(dx,py+18,digitWidth,36,digit,2); text("+",dx,py+18,digitWidth);
      hitTarget(dx,py+90,digitWidth,36,digit,3); text("-",dx,py+90,digitWidth);
    }
    hitTarget(px+popupWidth-72,py+54,54,36,0,1); text("OK",px+popupWidth-72,py+54,54);
    return;
  }
  if (session_.ui_.variableId > 0 && session_.ui_.category > 0) {
    std::vector<int> items;
    for (const auto& [id,count] : session_.inventory_) if (id < 100000 && count > 0 && session_.database_["items"][id]["itypeId"].integer(1)==session_.ui_.category) items.push_back(id);
    const int rows = std::max(1,std::min(4,static_cast<int>(items.size()))), py = message.position == 0 ? core_.height()-(rows*36+36) : 0;
    const int first = std::max(0,session_.ui_.cursor-rows+1);
    window(0,py,core_.width(),rows*36+36,session_.ui_.cursor-first,rows);
    for (int row = 0; row < rows && first+row < static_cast<int>(items.size()); ++row) {
      const int id = items[first+row]; text(session_.database_["items"][id]["name"].text(),18,py+18+row*36,core_.width()-120);
      text(std::to_string(session_.inventory_[id]),core_.width()-90,py+18+row*36,60,0,28,true);
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
void Presentation::menu() {
  const auto& ui = session_.ui_; const int width = core_.width(), height = core_.height();
  if (ui.scene == Scene::name) {
    const int panelWidth = std::min(width,720), px = (width-panelWidth)/2;
    window(px,0,panelWidth,180); face(ui.nameActorId,px+18,18);
    text(ui.nameInput,px+180,72,panelWidth-198);
    const int top = 180, cellWidth = (panelWidth-36)/10;
    window(px,top,panelWidth,360);
    const auto& table = nameInputTable(ui.namePage,session_.database_["system"]["locale"].text());
    core_.renderer().queueQuad(px+18+(ui.cursor%10)*cellWidth,top+18+(ui.cursor/10)*36,cellWidth,36,{0.4F,0.5F,0.8F,0.4F});
    for (int cell = 0; cell < 90; ++cell) {
      hitTarget(px+18+(cell%10)*cellWidth,top+18+(cell/10)*36,cellWidth,36,cell);
      text(table[cell],px+18+(cell%10)*cellWidth,top+18+(cell/10)*36,cellWidth,0,24);
    }
    return;
  }
  if (ui.scene == Scene::shop) {
    window(0,0,width-240,72,ui.category == 0 ? ui.cursor : -1,1); window(width-240,0,240,72);
    const std::vector<std::string> commands{"Buy","Sell","Cancel"};
    for (std::size_t i = 0; i < commands.size(); ++i) {
      if (ui.category == 0) hitTarget(18+static_cast<int>(i)*150,18,144,36,static_cast<int>(i));
      text(commands[i],18+static_cast<int>(i)*150,18,144,0,28,false,ui.shopPurchaseOnly && i == 1 ? 160.0F/255 : 1);
    }
    text(std::to_string(session_.gold_),width-222,18,180,0,28,true);
    window(0,72,width,height-72);
    if (ui.category == 3) {
      const auto& item = session_.database_[ui.shopKind == 0 ? "items" : ui.shopKind == 1 ? "weapons" : "armors"][ui.shopId];
      text(item["name"].text(),24,108,width-48); text("Quantity",24,180,200,16);
      text(std::to_string(ui.shopItemCount),240,180,120,0,28,true);
      text(std::to_string(ui.shopItemCount*ui.shopPrice),width-240,252,180,0,28,true);
      const std::array<std::string,5> buttons{"-10","-1","+1","+10","OK"};
      const std::array<int,5> actions{7,5,4,6,1};
      for (int button = 0; button < 5; ++button) { const int bx = 24+button*120; hitTarget(bx,324,108,48,0,actions[button]); text(buttons[button],bx,330,108); }
      return;
    }
    std::vector<ShopGood> goods;
    if (ui.category != 2) goods = ui.shopGoods;
    else for (const auto& [key,count] : session_.inventory_) if (count > 0) {
      const int kind = key/100000,id = key%100000; const auto& item = session_.database_[kind == 0 ? "items" : kind == 1 ? "weapons" : "armors"][id];
      if (!item.null() && (kind || item["itypeId"].integer(1)<=2)) goods.push_back({kind,id,item["price"].integer()/2});
    }
    const int rows = std::max(1,(height-108)/36), first = std::max(0,ui.cursor-rows+1);
    if (ui.category) core_.renderer().queueQuad(18,90+(ui.cursor-first)*36,width-36,36,{0.4F,0.5F,0.8F,0.4F});
    for (int row = 0; row < rows && row+first < static_cast<int>(goods.size()); ++row) {
      if (ui.category == 1 || ui.category == 2) hitTarget(18,90+row*36,width-36,36,first+row);
      const auto& good = goods[row+first]; const auto& item = session_.database_[good.kind == 0 ? "items" : good.kind == 1 ? "weapons" : "armors"][good.id];
      text(item["name"].text(),24,90+row*36,width-240);
      text(std::to_string(good.price),width-210,90+row*36,180,0,28,true);
    }
    return;
  }
  if (ui.scene == Scene::menu) {
    std::array<std::string,8> labels{"Item","Skill","Equip","Status","Formation","Options","Save","Game End"};
    const std::array<int,8> terms{4,5,6,7,8,11,9,10};
    for (std::size_t i = 0; i < labels.size(); ++i) { const auto label = TextManager::term(session_,"commands",terms[i]); if (!label.empty()) labels[i] = label; }
    window(0, 0, 240, 324, ui.category == 2 ? ui.pendingId : ui.cursor, 8);
    for (int i = 0; i < 8; ++i) text(labels[i], 24, 18 + i * 36);
    window(0, height - 72, 240, 72); text(std::to_string(session_.gold_), 24, height - 54, 150, 0, 28, true); text(session_.database_["system"]["currencyUnit"].text(), 192, height - 54);
    window(240, 0, width - 240, height);
    for (std::size_t i = 0; i < session_.party_.size(); ++i) {
      if (ui.category == 2) hitTarget(258,18+static_cast<int>(i)*147,width-276,147,static_cast<int>(i));
      if (ui.category == 2 && static_cast<int>(i) == ui.cursor) core_.renderer().queueQuad(258, 18 + static_cast<int>(i) * 147, width - 276, 147, {0.4F,0.5F,0.8F,0.4F});
      actorStatus(session_.party_[i], 258, 18 + static_cast<int>(i) * 147, width - 276, true);
    }
    if (ui.category == 1) { window(width / 2 - 120, height / 2 - 54, 240, 108, ui.cursor, 2); text("To Title", width / 2 - 96, height / 2 - 36); text("Cancel", width / 2 - 96, height / 2); }
    return;
  }
  if (ui.scene == Scene::save || ui.scene == Scene::load) {
    window(0, 0, width, 72); text(ui.scene == Scene::save ? "Save to which file?" : "Load which file?", 18, 18);
    const int first = ui.cursor / 4 * 4;
    window(0, 72, width, height - 72, -1);
    for (int i = first; i < first + 4; ++i) {
      const int y = 90+(i-first)*132;
      hitTarget(18,y,width-36,128,i);
      if (i == ui.cursor) core_.renderer().queueQuad(18,y,width-36,128,{0.4F,0.5F,0.8F,0.4F});
      text("File "+std::to_string(i+1),24,y);
      if (i+1 >= static_cast<int>(session_.saveMetadata_.size())) continue;
      const auto& slot = session_.saveMetadata_[i+1];
      if (slot.null()) continue;
      text(slot["title"].text(),192,y,width-216); text(slot["playtime"].text(),width-210,y+72,180,0,28,true);
      int offset = 0;
      for (const auto& entry : slot["characters"].array()) {
        if (entry[0].text().empty()) continue;
        const auto source = image("img/characters/"+entry[0].text()+".png");
        const bool big = entry[0].text().find('$')<2;
        const int cw = source.width/(big ? 3 : 12), ch = source.height/(big ? 4 : 8), index = entry[1].integer();
        quad(source.handle,(big ? 1 : index%4*3+1)*cw,(big ? 0 : index/4*4)*ch,cw,ch,192+offset*48,y+72-ch,cw,ch); ++offset;
      }
    }
    return;
  }
  if (ui.scene == Scene::options) {
    const int x = width / 2 - 200, y = height / 2 - 126; window(x, y, 400, 252, ui.cursor, 6);
    const std::array<std::string, 6> labels{"Always Dash", "Command Remember", "BGM Volume", "BGS Volume", "ME Volume", "SE Volume"};
    for (int i = 0; i < 6; ++i) { text(labels[i], x + 24, y + 18 + i * 36); text(i < 2 ? (i == 0 ? session_.alwaysDash_ : session_.commandRemember_) ? "ON" : "OFF" : std::to_string(session_.volumes_[i - 2]) + "%", x + 300, y + 18 + i * 36); }
    return;
  }
  if (ui.scene == Scene::formation) {
    window(0, 0, width, height);
    for (std::size_t i = 0; i < session_.party_.size(); ++i) { const int y = 18 + static_cast<int>(i) * 180; hitTarget(18,y,width-36,172,static_cast<int>(i)); if (static_cast<int>(i) == ui.cursor) core_.renderer().queueQuad(18, y, width - 36, 172, {0.4F, 0.5F, 0.8F, 0.4F}); actorStatus(session_.party_[i], 24, y, width - 48, true); }
    return;
  }
  if (ui.scene == Scene::debug) {
    const int switches = std::max(0,static_cast<int>(session_.database_["system"]["switches"].array().size())-1);
    const int variables = std::max(0,static_cast<int>(session_.database_["system"]["variables"].array().size())-1);
    const int switchBlocks = (switches+9)/10, variableBlocks = (variables+9)/10;
    const int selected = ui.category == 0 ? ui.cursor : ui.listCursor;
    const int rows = std::max(1,(height-36)/36), first = std::max(0,selected-rows+1);
    window(0,0,246,height,ui.category == 0 ? selected-first : -1,rows);
    for (int row = 0; row < rows && first+row < switchBlocks+variableBlocks; ++row) {
      const int index = first+row; const bool sw = index < switchBlocks;
      const int id = (sw ? index : index-switchBlocks)*10+1;
      text(std::string(sw ? "S" : "V")+" ["+std::to_string(id)+"-"+std::to_string(id+9)+"]",18,18+row*36,210);
    }
    window(246,0,width-246,396,ui.category == 1 ? ui.cursor : -1,10);
    const bool sw = selected < switchBlocks; const int top = (sw ? selected : selected-switchBlocks)*10+1;
    for (int row = 0; row < 10; ++row) {
      const int id = top+row;
      const auto& table = session_.database_["system"][sw ? "switches" : "variables"];
      if (id >= static_cast<int>(table.array().size())) continue;
      text(std::to_string(id)+": "+table[id].text(),264,18+row*36,width-444);
      std::string label;
      if (sw) { const auto it = session_.switches_.find(id); label = it != session_.switches_.end() && it->second ? "ON" : "OFF"; }
      else { const auto& value = session_.variable(id); if (std::holds_alternative<std::string>(value.data)) label = value.text(); else label = std::to_string(value.number()); }
      text(label,width-162,18+row*36,126,0,28,true);
    }
    text(sw ? "OK: toggle switch" : "Left/Right: -1/+1   Shift: x10",264,432,width-282);
    return;
  }
  if (session_.party_.empty()) return;
  const int actorId = session_.party_[ui.actor];
  window(0, 0, width, height);
  if (ui.scene == Scene::status) {
    actorStatus(actorId, 24, 18, width - 48, true);
    const std::array<std::string, 6> labels{"Attack", "Defense", "M.Attack", "M.Defense", "Agility", "Luck"};
    for (int i = 0; i < 6; ++i) { text(labels[i], 24, 216 + i * 36, 180, 16); text(std::to_string(static_cast<int>(session_.parameter(session_.actors_.at(actorId), i + 2))), 210, 216 + i * 36, 100, 0, 28, true); }
    text(session_.actors_.at(actorId).profile, 24, height - 90);
    return;
  }
  if (ui.scene == Scene::equip) {
    actorStatus(actorId, 24, 18, width - 48, true);
    const std::array<std::string, 3> commands{"Change", "Optimize", "Clear"};
    for (int i = 0; i < 3; ++i) { if (ui.category == 0 && ui.cursor == i) core_.renderer().queueQuad(330 + i * 140, 18, 130, 36, {0.4F, 0.5F, 0.8F, 0.4F}); text(commands[i], 336 + i * 140, 18); }
    const auto& actor = session_.actors_.at(actorId);
    for (std::size_t i = 0; i < actor.equips.size(); ++i) { const int y = 216 + static_cast<int>(i) * 36; if (ui.category == 1 && static_cast<int>(i) == ui.cursor) core_.renderer().queueQuad(18, y, width - 36, 36, {0.4F, 0.5F, 0.8F, 0.4F}); text(session_.database_["system"]["equipTypes"][session_.equipSlotType(actor,static_cast<int>(i))].text(), 24, y, 180, 16); text(session_.database_[i < actor.equipKinds.size() && actor.equipKinds[i] == 1 ? "weapons" : "armors"][actor.equips[i]]["name"].text(), 240, y); }
    if (ui.category == 2) {
      window(300, 72, width - 300, height - 72, ui.cursor, 12); text("None", 324, 90); int row = 1;
      for (const auto& entry : session_.database_[session_.equipSlotType(actor,ui.slot) == 1 ? "weapons" : "armors"].array()) if (session_.canEquip(session_.actors_.at(actorId), entry, ui.slot) && session_.inventory_[entry["id"].integer() + (session_.equipSlotType(actor,ui.slot) == 1 ? 100000 : 200000)] > 0) text(entry["name"].text(), 324, 90 + row++ * 36);
    }
    return;
  }
  const bool skill = ui.scene == Scene::skill;
  std::vector<int> entries;
  if (skill) {
    const auto types = session_.battleSkillTypes(ui.actor);
    for (std::size_t i = 0; i < types.size(); ++i) {
      const int columnWidth = std::max(120,width/std::max(1,static_cast<int>(types.size())));
      if (ui.category == 0 && static_cast<int>(i)==ui.cursor) core_.renderer().queueQuad(18+i*columnWidth,18,columnWidth-12,36,{0.4F,0.5F,0.8F,0.4F});
      if (ui.category == 0) hitTarget(18+i*columnWidth,18,columnWidth-12,36,static_cast<int>(i));
      text(session_.database_["system"]["skillTypes"][types[i]].text(),24+i*columnWidth,18,columnWidth-24);
    }
    Window_SkillList list(0,0,width,height); list.actorId = actorId; list.skillType = ui.skillType; list.refresh(session_); entries = list.data;
  } else {
    static const std::array<std::string,4> categories{"item","weapon","armor","keyItem"};
    const std::array<std::string,4> labels{"Items","Weapons","Armors","Key Items"};
    for (int i = 0; i < 4; ++i) {
      if (ui.category == 0 && ui.cursor == i) core_.renderer().queueQuad(18+i*(width/4),18,width/4-24,36,{0.4F,0.5F,0.8F,0.4F});
      if (ui.category == 0) hitTarget(18+i*(width/4),18,width/4-24,36,i);
      text(labels[i],24+i*(width/4),18,width/4-36);
    }
    Window_ItemList list(0,0,width,height); list.category = categories[std::clamp(ui.slot,0,3)]; list.refresh(session_); entries = list.data;
  }
  const int rows = std::max(1,(height-126)/36), first = std::max(0,ui.cursor-rows+1);
  for (int row = 0; row < rows && first+row < static_cast<int>(entries.size()); ++row) {
    const int encoded = entries[first+row], kind = encoded/100000, id = encoded%100000;
    const int y = 90+row*36;
    if (!ui.targeting && ui.category != 0) hitTarget(18,y,width-36,36,first+row);
    if (first+row == ui.cursor && !ui.targeting && ui.category != 0) core_.renderer().queueQuad(18,y,width-36,36,{0.4F,0.5F,0.8F,0.4F});
    const auto& entry = session_.database_[skill ? "skills" : kind == 0 ? "items" : kind == 1 ? "weapons" : "armors"][id];
    text(entry["name"].text(),24,y,width-180);
    text(std::to_string(skill ? entry["mpCost"].integer() : session_.inventory_[encoded]),width-120,y,80,0,28,true);
  }
  if (ui.targeting) { window(width / 2, 72, width / 2, height - 72); for (std::size_t i = 0; i < session_.party_.size(); ++i) { const int y = 90 + static_cast<int>(i) * 180; if (static_cast<int>(i) == ui.cursor) core_.renderer().queueQuad(width / 2 + 18, y, width / 2 - 36, 172, {0.4F, 0.5F, 0.8F, 0.4F}); actorStatus(session_.party_[i], width / 2 + 24, y, width / 2 - 48, true); } }
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
  const bool input = !session_.battle_.opening && !session_.message_.busy && !session_.battle_.wait && session_.battle_.active;
  if (input) {
    const bool party = ui.category == 4;
    std::vector<std::string> commands;
    std::vector<bool> enabled;
    if (party) { commands = {"Fight", "Escape"}; enabled = {true, session_.battle_.canEscape}; }
    else if (session_.battle_.actorIndex < static_cast<int>(session_.battleMemberCount())) {
      const auto& actor = session_.actors_.at(session_.party_[session_.battle_.actorIndex]);
      commands.push_back("Attack"); enabled.push_back(session_.canUse(actor, session_.database_["skills"][1]));
      for (int type : session_.battleSkillTypes(session_.battle_.actorIndex)) { commands.push_back(session_.database_["system"]["skillTypes"][type].text()); enabled.push_back(true); }
      commands.push_back("Guard"); enabled.push_back(session_.canUse(actor, session_.database_["skills"][2]));
      commands.push_back("Item"); enabled.push_back(true);
    }
    const int first = ui.cursor >= 4 && ui.category == 0 ? ui.cursor - 3 : 0;
    window(0, height - 180, 192, 180, ui.category == 0 || party ? ui.cursor - first : -1, 4);
    std::vector<std::string> commandKey{std::to_string(first)};
    for (int i = first; i < std::min(first + 4, static_cast<int>(commands.size())); ++i) {
      commandKey.push_back(commands[i]); commandKey.push_back(enabled[i] ? "1" : "0");
    }
    retainBattleContents(BattleWindow::commands, std::move(commandKey), [&] {
      for (int i = first; i < std::min(first + 4, static_cast<int>(commands.size())); ++i)
        text(commands[i], 24, height - 162 + (i - first) * 36, 144, 0, 28, false, enabled[i] ? 1 : 160.0F / 255);
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
    window(0, 0, width, 108);
    std::vector<std::string> lines(session_.battle_.log.begin(), session_.battle_.log.begin() + std::min<std::size_t>(2, session_.battle_.log.size()));
    retainBattleContents(BattleWindow::log, lines, [&] {
      for (std::size_t i = 0; i < lines.size(); ++i) text(lines[i], 18, 18 + static_cast<int>(i) * 36);
    });
  }
  if (ui.category == 1 || ui.category == 2) {
    window(0, 108, width, height - 288, ui.cursor, 8); std::vector<int> entries;
    if (ui.category == 1) {
      for (int id : session_.battlerSkills(session_.actors_.at(session_.party_[session_.battle_.actorIndex]))) if (session_.database_["skills"][id]["stypeId"].integer() == ui.skillType) entries.push_back(id);
    }
    else for (const auto& [id, count] : session_.inventory_) if (id < 100000 && count > 0 && session_.database_["items"][id]["occasion"].integer() <= 1) entries.push_back(id);
    std::vector<std::string> selectionKey{std::to_string(ui.category)};
    for (int id : entries) selectionKey.push_back(session_.database_[ui.category == 1 ? "skills" : "items"][id]["name"].text());
    retainBattleContents(BattleWindow::selection, selectionKey, [&] {
      for (std::size_t i = 1; i < selectionKey.size(); ++i) text(selectionKey[i], 24, 126 + static_cast<int>(i - 1) * 36);
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
    const auto& item = session_.database_[visual.action.item ? "items" : "skills"][visual.action.id];
    const auto& animation = session_.database_["animations"][item["animationId"].integer()];
    const int animationAge = static_cast<int>(session_.ticks_) - static_cast<int>(visual.started);
    const bool screen = animation["position"].integer() == 3;
    for (std::size_t i = 0; i < visual.targets.size(); ++i) {
      const int age = animationAge - static_cast<int>(i) * 12, frameIndex = (age - 8) / 4;
      const auto& target = visual.targets[i]; const bool enemy = target.enemy; const int index = target.index;
      float targetX, targetY, targetHeight;
      if (enemy) {
        const auto& member = session_.database_["troops"][session_.battle_.troopId]["members"][index];
        const auto& data = session_.database_["enemies"][session_.battle_.enemies[index].id];
        targetX = member["x"].number(); targetY = member["y"].number();
        targetHeight = data["battlerName"].text().empty() ? 0 : image(std::string(session_.database_["system"]["optSideView"].boolean() ? "img/sv_enemies/" : "img/enemies/") + data["battlerName"].text() + ".png").height;
      } else {
        if (index >= static_cast<int>(session_.party_.size())) continue;
        const auto& data = session_.actors_.at(session_.party_[index]);
        targetX = 600 + index * 32; targetY = 280 + index * 48;
        targetHeight = data.battlerName.empty() ? 0 : image("img/sv_actors/" + data.battlerName + ".png").height / 6;
      }
      if (age >= 8 && frameIndex < static_cast<int>(animation["frames"].array().size()) && (!screen || i == 0)) {
        const int position = animation["position"].integer();
        const float baseX = screen ? core_.width() / 2.0F : targetX;
        const float baseY = screen ? core_.height() / 2.0F : targetY - (position == 0 ? targetHeight : position == 1 ? targetHeight / 2 : 0);
        animationCells(animation,frameIndex,baseX,baseY,!enemy);
      }
      const int damageAge = visual.impact ? static_cast<int>(session_.ticks_ - visual.impact) : -1;
      if (damageAge >= 0 && damageAge < 90 && (target.result.hpAffected || target.result.mpDamage || target.result.missed || target.result.evaded)) {
        const auto source = image("img/system/Damage.png"); const int w = source.width / 10, h = source.height / 5;
        const int amount = target.result.hpAffected ? target.result.hpDamage : target.result.mpDamage;
        const bool missed = target.result.missed || target.result.evaded;
        const auto digits = std::to_string(std::abs(amount));
        const std::array<float,4> flash = target.result.critical && damageAge < 60 ? std::array<float,4>{1,0,0,160.0F/255*(60-damageAge)/60} : std::array<float,4>{};
        const auto popup = [&](float sx,float sy,float sourceWidth,float sourceHeight,float x,float y,float width,float height,float opacity) {
          core_.renderer().queueImage(source.handle,{width/sourceWidth,0,0,height/sourceHeight,x,y},{sx,sy,sourceWidth,sourceHeight},opacity,0xffffff,BlendMode::normal,{},flash);
        };
        if (missed) { popup( 0, h * 4, w * 4, h, targetX - (enemy ? 0 : 32) - w * 2, targetY - (enemy ? 8 : 0) - 40 - h, w * 4, h, std::min(1.0F, (90 - damageAge) / 10.0F)); continue; }
        for (std::size_t digit = 0; digit < digits.size(); ++digit) {
          double y = -40, dy = -static_cast<int>(digit);
          for (int tick = 0; tick <= damageAge; ++tick) { dy += 0.5; y += dy; if (y >= 0) { y = 0; dy *= -0.6; } }
          popup( (digits[digit] - '0') * w, ((target.result.hpAffected ? 0 : 2) + (amount < 0 ? 1 : 0)) * h, w, h, targetX - (enemy ? 0 : 32) + (static_cast<float>(digit) - (digits.size() - 1) / 2.0F) * w - w / 2, targetY - (enemy ? 8 : 0) + static_cast<int>(std::floor(y + 0.5)) - h, w, h, std::min(1.0F, (90 - damageAge) / 10.0F));
        }
      }
    }
  }
}
void Presentation::processAudio() {
  if (musicEffect_ && !core_.media().isPlaying(musicEffect_)) {
    core_.media().release(musicEffect_); musicEffect_ = 0;
    if (audio_["bgm"].second) core_.media().setSuspended(audio_["bgm"].second, false);
  }
  for (const auto& command : session_.audioCommands_) {
    auto kind = command["kind"].text();
    if (kind == "battle-save") {
      session_.battle_.mapBgm = audioState("bgm"); session_.battle_.mapBgs = audioState("bgs"); continue;
    }
    if (kind == "save-bgm") { session_.system_.storedBgm = audioState("bgm"); continue; }
    if (kind == "stop-se") {
      for (auto handle : sounds_) { core_.media().stop(handle); core_.media().release(handle); }
      sounds_.clear(); continue;
    }
    if (kind == "fade-bgm" || kind == "fade-bgs") {
      const auto channel = kind == "fade-bgm" ? "bgm" : "bgs";
      auto& active = audio_[channel];
      if (active.second && !active.first.empty()) {
        core_.media().fade(active.second, 1, 0, command["sound"].number(), true);
        active.first.clear();
        audioSettings_[channel] = Value::Object{{"name", ""}, {"volume", 0}, {"pitch", 0}, {"pan", 0}, {"pos", 0}};
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
      core_.media().stop(musicEffect_); core_.media().release(musicEffect_); musicEffect_ = 0;
      if (audio_["bgm"].second) core_.media().setSuspended(audio_["bgm"].second, false);
    }
    if (kind == "bgm" || kind == "bgs") {
      audioSettings_[kind] = sound;
      auto& active = audio_[kind];
      const bool changed = active.first != name;
      if ((active.first != name || name.empty()) && active.second) { core_.media().stop(active.second); core_.media().release(active.second); active = {}; }
      if (name.empty()) continue;
      if (active.first != name) {
        const auto source = core_.vfs().resolve("audio/" + kind + "/" + name + ".ogg");
        if (!source) throw std::runtime_error("audio unavailable: " + name);
        std::string error; active.second = core_.media().loadAudio(source->string(), &error); if (!active.second) throw std::runtime_error(error);
        active.first = name; core_.media().setParameters(active.second, sound["volume"].number(90) * session_.volumes_[kind == "bgm" ? 0 : kind == "bgs" ? 1 : kind == "me" ? 2 : 3] / 10000, sound["pitch"].number(100) / 100, sound["pan"].number() / 100); core_.media().play(active.second, true, 0);
      }
      if (((restore || replay) && changed) || command["restart"].boolean()) core_.media().play(active.second, true, sound["pos"].number());
      if (replay && changed) core_.media().fade(active.second, 0, 1, 0.5, false);
    } else if (!name.empty()) {
      const auto source = core_.vfs().resolve("audio/" + kind + "/" + name + ".ogg");
      if (!source) throw std::runtime_error("audio unavailable: " + name);
      std::string error; const auto handle = core_.media().loadAudio(source->string(), &error); if (!handle) throw std::runtime_error(error);
      core_.media().setParameters(handle, sound["volume"].number(90) * session_.volumes_[kind == "bgm" ? 0 : kind == "bgs" ? 1 : kind == "me" ? 2 : 3] / 10000, sound["pitch"].number(100) / 100, sound["pan"].number() / 100); core_.media().play(handle, false, 0);
      if (kind == "me") {
        if (musicEffect_) { core_.media().stop(musicEffect_); core_.media().release(musicEffect_); }
        musicEffect_ = handle;
      } else sounds_.push_back(handle);
    }
  }
  session_.audioCommands_.clear();
  for (const auto& [kind, active] : audio_) if (active.second) {
    const auto& sound = audioSettings_[kind];
    if (sound["name"].text().empty()) continue;
    core_.media().setParameters(active.second, sound["volume"].number(90) * session_.volumes_[kind == "bgm" ? 0 : 1] / 10000, sound["pitch"].number(100) / 100, sound["pan"].number() / 100);
    if (kind == "bgm" && musicEffect_) core_.media().setSuspended(active.second, true);
  }
  for (auto it = sounds_.begin(); it != sounds_.end();) { if (!core_.media().isPlaying(*it)) { core_.media().release(*it); it = sounds_.erase(it); } else ++it; }
}
Value Presentation::audioState(const std::string& kind) {
  auto sound = audioSettings_[kind];
  if (sound.null()) sound = Value::Object{{"name", ""}, {"volume", 0}, {"pitch", 100}, {"pan", 0}};
  std::get<Value::Object>(sound.data)["pos"] = !sound["name"].text().empty() && audio_[kind].second ? core_.media().position(audio_[kind].second) : 0;
  return sound;
}
void Presentation::captureAudioState() {
  processAudio();
  session_.savedBgm_ = audioState("bgm"); session_.savedBgs_ = audioState("bgs");
}
void Presentation::render() {
  core::Graphics::tickStart();core::updateServices();core::Graphics::updateLoading();
  for (auto handle : deferredImageReleases_) core_.images().release(handle);
  deferredImageReleases_.clear();
  session_.uiHitTargets_.clear();
  const int sceneId = static_cast<int>(session_.ui_.scene);
  if (sceneId != lastScene_ || session_.mapId_ != lastMap_ || session_.presentationRevision_ != lastPresentationRevision_) {
    clearMapGeometry();
    clearTiledGeometry();
    clearBattleContents();
    sceneTickOrigin_ = session_.ticks_;
    for (const auto& [key, value] : images_) { (void)key; core_.images().release(value.handle); }
    images_.clear();
    coreWindows_.clear(); coreWindowskin_.reset(); lastScene_ = sceneId; lastMap_ = session_.mapId_;
    lastPresentationRevision_ = session_.presentationRevision_;
  }
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
    const std::array<std::string, 3> labels{"New Game", "Continue", "Options"}; for (int i = 0; i < 3 && openness == 255; ++i) {
      const bool enabled = i != 1 || std::any_of(session_.saveMetadata_.begin(), session_.saveMetadata_.end(), [&](const Value& slot) { return slot["title"].text() == session_.database_["system"]["gameTitle"].text(); });
      text(labels[i], x + 24, y + 18 + i * 36, 192, 0, 28, false, enabled ? 1 : 160.0F / 255);
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
