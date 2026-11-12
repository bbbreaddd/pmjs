#include "mv_presentation.hpp"
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace pmjs::mv {
Presentation::Presentation(RuntimeCore& core, Session& session, Value settings)
    : core_(core), session_(session), settings_(std::move(settings)) {
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
  clearBattleContents();
  for (auto& [key, value] : images_) { (void)key; core_.images().release(value.handle); }
  for (auto& [key, value] : windows_) { (void)key; core_.canvases().release(value.first); core_.canvases().release(value.second); }
  for (auto handle : sounds_) { core_.media().stop(handle); core_.media().release(handle); }
  if (musicEffect_) { core_.media().stop(musicEffect_); core_.media().release(musicEffect_); }
  for (auto& [key, value] : audio_) { (void)key; core_.media().stop(value.second); core_.media().release(value.second); }
  core_.canvases().release(textCanvas_);
}
ImageInfo Presentation::image(const std::string& file, int hue) {
  const auto key = hue ? file + "#hue=" + std::to_string(hue) : file;
  const auto found = images_.find(key); if (found != images_.end()) return found->second;
  if (hue) {
    auto source = image(file);
    const auto surface = core_.canvases().create(source.width, source.height);
    if (!surface) throw std::runtime_error("cannot create hue surface");
    core_.canvases().drawImage(surface->handle, source.handle, 0, 0, source.width, source.height, 0, 0, source.width, source.height, 1);
    core_.canvases().rotateHue(surface->handle, hue);
    const auto handle = core_.canvases().prepareImage(surface->handle);
    if (!handle || !core_.images().retain(*handle)) { core_.canvases().release(surface->handle); throw std::runtime_error("cannot realize hue surface"); }
    source.handle = *handle; core_.canvases().release(surface->handle);
    images_[key] = source; return source;
  }
  const auto source = core_.vfs().resolve(file);
  if (!source) throw std::runtime_error("image unavailable: " + file);
  const auto loaded = core_.images().loadPng(*source, true);
  if (!loaded) throw std::runtime_error("cannot decode image: " + file);
  images_[file] = *loaded; return *loaded;
}
void Presentation::quad(ImageHandle handle, float sx, float sy, float sw, float sh, float x, float y, float width, float height, float alpha) {
  if (sw <= 0 || sh <= 0 || width <= 0 || height <= 0) return;
  if (!core_.renderer().queueImage(handle, {width / sw, 0, 0, height / sh, x, y}, {sx, sy, sw, sh}, alpha, 0xffffff, BlendMode::normal)) throw std::runtime_error("cannot queue image");
}
void Presentation::tile(int id, int x, int y) {
  if (id <= 0) return;
  const auto& tileset = session_.database_["tilesets"][session_.map()["tilesetId"].integer()];
  auto source = [&](int set) {
    const auto name = tileset["tilesetNames"][set].text();
    if (name.empty()) throw std::runtime_error("tile refers to an absent tileset image");
    return image("img/tilesets/" + name + ".png");
  };
  if (id < 2048) {
    const auto bitmap = source(id >= 1536 ? 4 : 5 + id / 256);
    quad(bitmap.handle, (id / 128 % 2 * 8 + id % 8) * 48, id % 256 / 8 * 48, 48, 48, x, y, 48, 48);
    return;
  }
  const int kind = (id - 2048) / 48, shape = (id - 2048) % 48, column = kind % 8, row = kind / 8;
  const int animation = static_cast<int>(session_.ticks_ / 30);
  int set = 0, baseX = 0, baseY = 0;
  std::string table = "floor";
  if (id < 2816) {
    const std::array<int, 4> water{0, 1, 2, 1};
    if (kind < 4) { baseX = kind < 2 ? water[animation % 4] * 2 : 6; baseY = kind % 2 * 3; }
    else {
      baseX = column / 4 * 8; baseY = row * 6 + column / 2 % 2 * 3;
      if (kind % 2 == 0) baseX += water[animation % 4] * 2;
      else { baseX += 6; baseY += animation % 3; table = "waterfall"; }
    }
  } else if (id < 4352) { set = 1; baseX = column * 2; baseY = (row - 2) * 3; }
  else if (id < 5888) { set = 2; baseX = column * 2; baseY = (row - 6) * 2; table = "wall"; }
  else { set = 3; baseX = column * 2; baseY = static_cast<int>(std::floor((row - 10) * 2.5 + (row % 2 ? 0.5 : 0))); if (row % 2) table = "wall"; }
  const auto bitmap = source(set);
  const auto& quarters = session_.database_["tileTables"][table][shape].array();
  if (quarters.size() != 4) throw std::runtime_error("invalid autotile shape");
  for (int i = 0; i < 4; ++i) quad(bitmap.handle, (baseX * 2 + quarters[i][0].integer()) * 24, (baseY * 2 + quarters[i][1].integer()) * 24, 24, 24, x + i % 2 * 24, y + i / 2 * 24, 24, 24);
}
void Presentation::character(const Character& value, double cameraX, double cameraY) {
  if (value.transparent || value.opacity <= 0 || value.characterName.empty()) return;
  const auto source = image("img/characters/" + value.characterName + ".png");
  const bool big = value.characterName.find('$') < 2, object = value.characterName.find('!') < 2;
  const int width = value.customFrameWidth > 0 ? value.customFrameWidth : value.singleFrame ? source.width : source.width / (big ? 3 : 12);
  const int height = value.customFrameHeight > 0 ? value.customFrameHeight : value.singleFrame ? source.height : source.height / (big ? 4 : 8);
  const int pattern = value.pattern < 3 ? value.pattern : 1;
  const int column = value.customFrameX >= 0 ? value.customFrameX : value.singleFrame ? 0 : (big ? 0 : value.characterIndex % 4 * 3) + pattern;
  const int row = value.customFrameY >= 0 ? value.customFrameY : value.singleFrame ? 0 : (big ? 0 : value.characterIndex / 4 * 4) + (value.direction - 2) / 2;
  const auto& tiled = session_.database_["tiledMaps"][std::to_string(session_.mapId_)];
  const int tw = tiled["tilewidth"].integer(48), th = tiled["tileheight"].integer(48);
  const int x = static_cast<int>(std::floor((value.realX - cameraX) * tw + tw / 2.0 + 0.5) + value.spriteOffsetX);
  const int y = static_cast<int>(std::floor((value.realY - cameraY) * th + th - (object ? 0 : 6) + 0.5) + value.spriteOffsetY);
  const float alpha = value.opacity / 255.0F;
  if (value.bushDepth) {
    quad(source.handle, column * width, row * height, width, height - value.bushDepth, x - width / 2.0F, y - height, width, height - value.bushDepth, alpha);
    quad(source.handle, column * width, row * height + height - value.bushDepth, width, value.bushDepth, x - width / 2.0F, y - value.bushDepth, width, value.bushDepth, alpha * 128.0F / 255);
  } else if (!core_.renderer().queueImage(source.handle, {1,0,0,1,x - width / 2.0F,static_cast<float>(y-height)},
      {static_cast<float>(column*width),static_cast<float>(row*height),static_cast<float>(width),static_cast<float>(height)},
      alpha,0xffffff,static_cast<BlendMode>(value.blendMode))) throw std::runtime_error("cannot queue character");
}
void Presentation::tiledMap(const Value& data) {
  const int width = data["width"].integer(), height = data["height"].integer();
  const int tw = data["tilewidth"].integer(), th = data["tileheight"].integer();
  const double screenX = core_.width() / double(tw), screenY = core_.height() / double(th);
  cameraX_ = width < screenX ? (width-screenX)/2 : std::clamp(session_.player_.realX-(screenX-1)/2,0.0,width-screenX);
  cameraY_ = height < screenY ? (height-screenY)/2 : std::clamp(session_.player_.realY-(screenY-1)/2,0.0,height-screenY);
  if (session_.savedCamera_) { cameraX_ = (*session_.savedCamera_)[0]; cameraY_ = (*session_.savedCamera_)[1]; }
  const int ox = static_cast<int>(std::floor(cameraX_*tw)), oy = static_cast<int>(std::floor(cameraY_*th));
  struct Draw { int z, y, priority; std::size_t order; const Character* actor = nullptr; int gid=0,x=0,tileY=0; float alpha=1; };
  std::vector<Draw> draws;
  const auto& layers = data["layers"].array();
  for (std::size_t layerIndex=0;layerIndex<layers.size();++layerIndex) {
    const auto& layer=layers[layerIndex];
    if (!layer["visible"].null() && !layer["visible"].boolean()) continue;
    const int z=std::stoi(layer["properties"]["zIndex"].text().empty() ? std::to_string(layer["properties"]["zIndex"].integer()) : layer["properties"]["zIndex"].text());
    const int priority=std::stoi(layer["properties"]["priority"].text().empty() ? std::to_string(layer["properties"]["priority"].integer()) : layer["properties"]["priority"].text());
    const int dx=layer["offsetx"].integer(),dy=layer["offsety"].integer();
    for (int y=std::max(0,(oy-dy)/th);y<std::min(height,(oy-dy+core_.height())/th+1);++y)
      for (int x=std::max(0,(ox-dx)/tw);x<std::min(width,(ox-dx+core_.width())/tw+1);++x) {
        const int gid=layer["data"][y*width+x].integer(); if (!gid) continue;
        const bool sorted=z==3 && priority>0;
        draws.push_back({z,sorted ? (y+1)*th-oy+dy : 0,sorted ? priority : 0,layerIndex*width*height+y*width+x,
          nullptr,gid,x*tw-ox+dx,y*th-oy+dy,static_cast<float>(layer["opacity"].number(1))});
      }
  }
  std::size_t order=layers.size()*width*height;
  auto actor=[&](const Character& value,int priority) {
    const bool object=value.characterName.find('!')<2;
    const int y=static_cast<int>(std::floor((value.realY-cameraY_)*th+th-(object?0:6)+0.5)+value.spriteOffsetY);
    draws.push_back({priority*2+1,y,0,order++,&value});
  };
  for (const auto& event:session_.events_) if(event.page>=0)actor(event.character,event.priority);
  for (auto follower=session_.followers_.rbegin();follower!=session_.followers_.rend();++follower)actor(*follower,1);
  actor(session_.player_,1);
  std::stable_sort(draws.begin(),draws.end(),[](const Draw&a,const Draw&b) {
    if(a.z!=b.z)return a.z<b.z;if(a.y!=b.y)return a.y<b.y;if(a.priority!=b.priority)return a.priority<b.priority;return a.order<b.order;
  });
  for(const auto& draw:draws) {
    if(draw.actor) { character(*draw.actor,cameraX_,cameraY_);continue; }
    const Value* set=nullptr;
    for(const auto& candidate:data["tilesets"].array())if(draw.gid>=candidate["firstgid"].integer())set=&candidate;
    if(!set)throw std::runtime_error("tile has no tileset");
    int id=draw.gid-(*set)["firstgid"].integer();
    const auto& animation=(*set)["tiles"][std::to_string(id)]["animation"].array();
    if(!animation.empty()) {
      double duration=0;for(const auto& frame:animation)duration+=frame["duration"].number();
      double age=std::fmod((session_.ticks_-sceneTickOrigin_)*1000/60,duration);
      for(const auto& frame:animation) { id=frame["tileid"].integer();age-=frame["duration"].number();if(age<0)break; }
    }
    const auto texture=image((*set)["image"].text());const int columns=(*set)["columns"].integer();
    quad(texture.handle,id%columns*tw,id/columns*th,tw,th,draw.x,draw.tileY,tw,th,draw.alpha);
  }
}
void Presentation::mapPictures() {
  const auto& tiled=session_.database_["tiledMaps"][std::to_string(session_.mapId_)];
  const int tw=tiled["tilewidth"].integer(48),th=tiled["tileheight"].integer(48);
  for(const auto& picture:session_.pictures_) {
    const auto name=picture["_name"].text();const double opacity=picture["_opacity"].number();
    if(name.empty()||opacity<=0)continue;
    const auto source=image("img/pictures/"+name+".png");
    const auto& frame=picture["_frameData"]["frames"][picture["_frameData"]["frameIndex"].integer()];
    const int sx=frame["x"].integer(),sy=frame["y"].integer(),sw=frame["width"].integer(source.width),sh=frame["height"].integer(source.height);
    const float width=sw*picture["_scaleX"].number(100)/100,height=sh*picture["_scaleY"].number(100)/100;
    float x=picture["_x"].number(),y=picture["_y"].number();
    if(picture["_pinnedToMap"].boolean()){x-=cameraX_*tw;y-=cameraY_*th;}
    if(picture["_origin"].integer()==1){x-=width/2;y-=height/2;}
    if(!core_.renderer().queueImage(source.handle,{width/sw,0,0,height/sh,x,y},
      {float(sx),float(sy),float(sw),float(sh)},opacity/255,0xffffff,static_cast<BlendMode>(picture["_blendMode"].integer())))throw std::runtime_error("cannot queue picture");
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

void Presentation::map() {
  const auto& tiled=session_.database_["tiledMaps"][std::to_string(session_.mapId_)];
  if(!tiled.null()) { tiledMap(tiled);mapPictures();mapAmbience();return; }
  const auto& mapData = session_.map();
  const int width = mapData["width"].integer(), height = mapData["height"].integer();
  const double screenX = core_.width() / 48.0, screenY = core_.height() / 48.0;
  cameraX_ = width < screenX ? (width - screenX) / 2 : std::clamp(session_.player_.realX - (screenX - 1) / 2, 0.0, width - screenX);
  cameraY_ = height < screenY ? (height - screenY) / 2 : std::clamp(session_.player_.realY - (screenY - 1) / 2, 0.0, height - screenY);
  const int originX = static_cast<int>(std::floor(cameraX_ * 48)), originY = static_cast<int>(std::floor(cameraY_ * 48));
  const auto& flags = session_.database_["tilesets"][mapData["tilesetId"].integer()]["flags"];
  struct Cell { int id, x, y; }; std::vector<Cell> upper;
  for (int y = std::max(0, originY / 48); y < std::min(height, (originY + core_.height()) / 48 + 1); ++y) {
    for (int x = std::max(0, originX / 48); x < std::min(width, (originX + core_.width()) / 48 + 1); ++x) {
      for (int layer = 0; layer < 4; ++layer) {
        const int id = mapData["data"][(layer * height + y) * width + x].integer();
        if (flags[id].integer() & 16) upper.push_back({id, x * 48 - originX, y * 48 - originY});
        else tile(id, x * 48 - originX, y * 48 - originY);
        if (layer == 1) {
          const int bits = mapData["data"][(4 * height + y) * width + x].integer();
          for (int i = 0; i < 4; ++i) if (bits & (1 << i)) core_.renderer().queueQuad(x * 48 - originX + i % 2 * 24, y * 48 - originY + i / 2 * 24, 24, 24, {0, 0, 0, 0.5F});
        }
      }
    }
  }
  struct Sprite { const Character* value; int priority; }; std::vector<Sprite> characters;
  for (const auto& event : session_.events_) if (event.page >= 0) characters.push_back({&event.character, event.priority});
  for (auto follower = session_.followers_.rbegin(); follower != session_.followers_.rend(); ++follower) characters.push_back({&*follower, 1});
  characters.push_back({&session_.player_, 1});
  std::stable_sort(characters.begin(), characters.end(), [](const Sprite& a, const Sprite& b) { return a.priority != b.priority ? a.priority < b.priority : a.value->realY < b.value->realY; });
  for (const auto& sprite : characters) if (sprite.priority < 2) character(*sprite.value, cameraX_, cameraY_);
  for (const auto& entry : upper) tile(entry.id, entry.x, entry.y);
  for (const auto& sprite : characters) if (sprite.priority >= 2) character(*sprite.value, cameraX_, cameraY_);
}
void Presentation::window(int x, int y, int width, int height, int selected, int rows, int openness) {
  if (openness <= 0) return;
  const auto key = std::pair{width, height};
  if (!windows_.contains(key)) {
    const auto back = core_.canvases().create(width - 8, height - 8), frame = core_.canvases().create(width, height);
    if (!back || !frame) throw std::runtime_error("cannot create window skin");
    windows_[key] = {back->handle, frame->handle};
    const auto skin = image("img/system/Window.png");
    auto blit = [&](CanvasHandle destination, int sx, int sy, int sw, int sh, int dx, int dy, int dw, int dh) { if (!core_.canvases().drawImage(destination, skin.handle, sx, sy, sw, sh, dx, dy, dw, dh, 1)) throw std::runtime_error("window skin drawing failed"); };
    blit(back->handle, 0, 0, 96, 96, 0, 0, width - 8, height - 8);
    for (int by = 0; by < height - 8; by += 96) for (int bx = 0; bx < width - 8; bx += 96) blit(back->handle, 0, 96, 96, 96, bx, by, 96, 96);
    const auto& tone = session_.database_["system"]["windowTone"];
    core_.canvases().adjustTone(back->handle, tone[0].number(), tone[1].number(), tone[2].number());
    for (int row = 0; row < 3; ++row) for (int col = 0; col < 3; ++col) {
      if (row == 1 && col == 1) continue;
      const int sx = col == 0 ? 96 : col == 1 ? 120 : 168, sy = row == 0 ? 0 : row == 1 ? 24 : 72;
      const int dx = col == 0 ? 0 : col == 1 ? 24 : width - 24, dy = row == 0 ? 0 : row == 1 ? 24 : height - 24;
      blit(frame->handle, sx, sy, col == 1 ? 48 : 24, row == 1 ? 48 : 24, dx, dy, col == 1 ? width - 48 : 24, row == 1 ? height - 48 : 24);
    }
  }
  const auto handles = windows_.at(key);
  const auto back = core_.canvases().prepareImage(handles.first), frame = core_.canvases().prepareImage(handles.second);
  if (!back || !frame) throw std::runtime_error("window skin realization failed");
  const float scale = std::min(255, openness) / 255.0F;
  quad(*back, 0, 0, width - 8, height - 8, x + 4, y + height * (1 - scale) / 2 + 4 * scale, width - 8, (height - 8) * scale, 192.0F / 255);
  quad(*frame, 0, 0, width, height, x, y + height * (1 - scale) / 2, width, height * scale);
  if (openness >= 255 && selected >= 0 && rows > 0) {
    const int row = selected % rows;
    const int phase = static_cast<int>(session_.ticks_ % 40);
    const float blink = (255 - (phase < 20 ? phase : 40 - phase) * 8) / 255.0F;
    const auto skin = image("img/system/Window.png");
    for (int cy = 0; cy < 3; ++cy) for (int cx = 0; cx < 3; ++cx) {
      const int sx = cx == 0 ? 96 : cx == 1 ? 100 : 140;
      const int sy = cy == 0 ? 96 : cy == 1 ? 100 : 140;
      const int dx = cx == 0 ? 0 : cx == 1 ? 4 : width - 40;
      const int dy = cy == 0 ? 0 : cy == 1 ? 4 : 32;
      quad(skin.handle, sx, sy, cx == 1 ? 40 : 4, cy == 1 ? 40 : 4,
           x + 18 + dx, y + 18 + row * 36 + dy, cx == 1 ? width - 44 : 4, cy == 1 ? 28 : 4, blink);
    }
  }
}
void Presentation::text(const std::string& value, int x, int y, int width, int color, int size, bool right, float opacity) {
  if (value.empty()) return;
  const double measured = core_.canvases().measureText(fonts_, value, size).value_or(0);
  const int destinationX = right ? x + width - static_cast<int>(std::ceil(measured)) : x;
  core_.canvases().drawText(textCanvas_, fonts_, value, destinationX, y + (36 + size * 0.7F) / 2, size, 128, 4);
  core_.canvases().drawText(textCanvas_, fonts_, value, destinationX, y + (36 + size * 0.7F) / 2, size, (colors_[std::clamp(color, 0, 31)] & 0xffffff00U) | static_cast<std::uint32_t>(255 * opacity));
}
void Presentation::face(int actorId, int x, int y) {
  const auto& actor = session_.database_["actors"][actorId];
  if (actor["faceName"].text().empty()) return;
  const auto source = image("img/faces/" + actor["faceName"].text() + ".png");
  const int index = actor["faceIndex"].integer();
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
  const auto& actor = session_.actors_.at(actorId); const auto& data = session_.database_["actors"][actorId];
  if (portrait) { face(actorId, x, y); x += 162; width -= 162; }
  text(data["name"].text(), x, y, width);
  text(session_.database_["classes"][data["classId"].integer()]["name"].text(), x + 180, y, width - 180);
  text("Lv", x, y + 36, 48, 16); text(std::to_string(actor.level), x + 48, y + 36);
  for (int i = 0; i < 2; ++i) gauge(actor, i, x, y + 72 + i * 36, std::min(186, width));
}
void Presentation::message() {
  const auto& message = session_.message_;
  if (!message.busy) return;
  const auto& style = settings_["messageStyle"];
  const int lineHeight = style["lineHeight"].integer(36), padding = style["padding"].integer(18);
  const int inset = style["inset"].integer(), width = core_.width() - inset * 2;
  const int height = lineHeight * 4 + padding * 2;
  const int y = message.position * (core_.height() - height) / 2 + (message.position == 2 ? -style["bottomInset"].integer() : message.position == 0 ? style["bottomInset"].integer() : 0);
  if (message.background == 0) window(inset, y, width, height);
  else if (message.background == 1) core_.renderer().queueQuad(inset, y, width, height, {0, 0, 0, 0.6F});
  int x = inset + padding + style["textInset"].integer();
  if (!message.faceName.empty()) { const auto bitmap = image("img/faces/" + message.faceName + ".png"); quad(bitmap.handle, message.faceIndex % 4 * 144, message.faceIndex / 4 * 144, 144, 144, 18, y + 18, 144, 144); x = 186; }
  int remaining = std::max(0, session_.messageAge_ - 8);
  int line = 0;
  for (int index = message.firstLine; index < message.pageEnd(); ++index) {
    const auto full = message.lines[index].text(); const int length = std::min(remaining, static_cast<int>(full.size()));
    text(full.substr(0, length), x, y + padding + line * lineHeight + style["textOffsetY"].integer(), width - x - padding, 0, style["fontSize"].integer(28)); remaining -= length; ++line;
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
      window(core_.width() - width, cy, width, h, session_.ui_.cursor, static_cast<int>(message.choices.size()));
      for (std::size_t i = 0; i < message.choices.size(); ++i) text(message.choices[i].text(), core_.width() - width + 24, cy + 18 + static_cast<int>(i) * 36);
    }
  }
}
void Presentation::menu() {
  const auto& ui = session_.ui_; const int width = core_.width(), height = core_.height();
  if (ui.scene == Scene::menu) {
    const std::array<std::string, 8> labels{"Item", "Skill", "Equip", "Status", "Formation", "Options", "Save", "Game End"};
    window(0, 0, 240, 324, ui.category == 2 ? ui.pendingId : ui.cursor, 8);
    for (int i = 0; i < 8; ++i) text(labels[i], 24, 18 + i * 36);
    window(0, height - 72, 240, 72); text(std::to_string(session_.gold_), 24, height - 54, 150, 0, 28, true); text(session_.database_["system"]["currencyUnit"].text(), 192, height - 54);
    window(240, 0, width - 240, height);
    for (std::size_t i = 0; i < session_.party_.size(); ++i) {
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
    for (int i = first; i < first + 4; ++i) { const int y = 90 + (i - first) * 132; if (i == ui.cursor) core_.renderer().queueQuad(18, y, width - 36, 128, {0.4F, 0.5F, 0.8F, 0.4F}); text("File " + std::to_string(i + 1), 24, y); }
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
    for (std::size_t i = 0; i < session_.party_.size(); ++i) { const int y = 18 + static_cast<int>(i) * 180; if (static_cast<int>(i) == ui.cursor) core_.renderer().queueQuad(18, y, width - 36, 172, {0.4F, 0.5F, 0.8F, 0.4F}); actorStatus(session_.party_[i], 24, y, width - 48, true); }
    return;
  }
  if (session_.party_.empty()) return;
  const int actorId = session_.party_[ui.actor];
  window(0, 0, width, height);
  if (ui.scene == Scene::status) {
    actorStatus(actorId, 24, 18, width - 48, true);
    const std::array<std::string, 6> labels{"Attack", "Defense", "M.Attack", "M.Defense", "Agility", "Luck"};
    for (int i = 0; i < 6; ++i) { text(labels[i], 24, 216 + i * 36, 180, 16); text(std::to_string(static_cast<int>(session_.parameter(session_.actors_.at(actorId), i + 2))), 210, 216 + i * 36, 100, 0, 28, true); }
    text(session_.database_["actors"][actorId]["profile"].text(), 24, height - 90);
    return;
  }
  if (ui.scene == Scene::equip) {
    actorStatus(actorId, 24, 18, width - 48, true);
    const std::array<std::string, 3> commands{"Change", "Optimize", "Clear"};
    for (int i = 0; i < 3; ++i) { if (ui.category == 0 && ui.cursor == i) core_.renderer().queueQuad(330 + i * 140, 18, 130, 36, {0.4F, 0.5F, 0.8F, 0.4F}); text(commands[i], 336 + i * 140, 18); }
    const auto& actor = session_.actors_.at(actorId);
    for (std::size_t i = 0; i < actor.equips.size(); ++i) { const int y = 216 + static_cast<int>(i) * 36; if (ui.category == 1 && static_cast<int>(i) == ui.cursor) core_.renderer().queueQuad(18, y, width - 36, 36, {0.4F, 0.5F, 0.8F, 0.4F}); text(session_.database_["system"]["equipTypes"][i + 1].text(), 24, y, 180, 16); text(session_.database_[i == 0 ? "weapons" : "armors"][actor.equips[i]]["name"].text(), 240, y); }
    if (ui.category == 2) {
      window(300, 72, width - 300, height - 72, ui.cursor, 12); text("None", 324, 90); int row = 1;
      for (const auto& entry : session_.database_[ui.slot == 0 ? "weapons" : "armors"].array()) if (session_.canEquip(session_.actors_.at(actorId), entry, ui.slot) && session_.inventory_[entry["id"].integer() + (ui.slot == 0 ? 100000 : 200000)] > 0) text(entry["name"].text(), 324, 90 + row++ * 36);
    }
    return;
  }
  const bool skill = ui.scene == Scene::skill;
  text(skill ? "Skills" : "Items", 24, 18, width - 48, 16);
  std::vector<int> entries;
  if (skill) for (int id : session_.actors_.at(actorId).skills) entries.push_back(id);
  else for (const auto& [id, count] : session_.inventory_) if (id < 100000 && count > 0) entries.push_back(id);
  for (std::size_t i = 0; i < entries.size(); ++i) {
    const int y = 90 + static_cast<int>(i) * 36;
    if (static_cast<int>(i) == ui.cursor && !ui.targeting) core_.renderer().queueQuad(18, y, width - 36, 36, {0.4F, 0.5F, 0.8F, 0.4F});
    const auto& entry = session_.database_[skill ? "skills" : "items"][entries[i]];
    text(entry["name"].text(), 24, y);
    text(std::to_string(skill ? entry["mpCost"].integer() : session_.inventory_[entries[i]]), width - 120, y, 80, 0, 28, true);
  }
  if (ui.targeting) { window(width / 2, 72, width / 2, height - 72); for (std::size_t i = 0; i < session_.party_.size(); ++i) { const int y = 90 + static_cast<int>(i) * 180; if (static_cast<int>(i) == ui.cursor) core_.renderer().queueQuad(width / 2 + 18, y, width / 2 - 36, 172, {0.4F, 0.5F, 0.8F, 0.4F}); actorStatus(session_.party_[i], width / 2 + 24, y, width / 2 - 48, true); } }
}
void Presentation::clearBattleContents() {
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
  const int width = core_.width(), height = core_.height(); const auto& ui = session_.ui_;
  for (auto& contents : battleContents_) contents.visible = false;
  for (int layer = 0; layer < 2; ++layer) {
    const auto name = session_.map()[layer == 0 ? "battleback1Name" : "battleback2Name"].text();
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
  const auto& members = session_.database_["troops"][session_.battle_.troopId]["members"].array();
  for (std::size_t i = 0; i < session_.battle_.enemies.size(); ++i) {
    const auto& enemy = session_.battle_.enemies[i]; if (enemy.hp <= 0 || enemy.hidden || enemy.escaped) continue;
    const auto& data = session_.database_["enemies"][enemy.id];
    if (data["battlerName"].text().empty()) continue;
    const auto source = image("img/sv_enemies/" + data["battlerName"].text() + ".png", data["battlerHue"].integer());
    quad(source.handle, 0, 0, source.width, source.height, members[i]["x"].integer() - source.width / 2.0F, members[i]["y"].integer() - source.height, source.width, source.height);
  }
  for (std::size_t i = 0; i < session_.party_.size(); ++i) {
    const int id = session_.party_[i]; const auto& actor = session_.actors_.at(id); const auto name = session_.database_["actors"][id]["battlerName"].text();
    if (name.empty()) continue;
    const auto source = image("img/sv_actors/" + name + ".png"); const int w = source.width / 9, h = source.height / 6;
    const bool inputting = session_.battle_.active && !session_.battle_.opening && !session_.battle_.wait && session_.ui_.category != 4 && session_.battle_.actorIndex == static_cast<int>(i);
    const int motion = actor.hp <= 0 ? 17 : session_.battle_.result == 0 ? 13 : session_.battle_.result == 1 ? 12 : inputting ? 0 : actor.guarding ? 3 : actor.hp < session_.parameter(actor, 0) / 4 ? 14 : 1;
    const int pattern = static_cast<int>(session_.ticks_ / 12) % 4;
    quad(source.handle, (motion / 6 * 3 + (pattern == 3 ? 1 : pattern)) * w, motion % 6 * h, w, h, 600 + static_cast<int>(i) * 32 - w / 2, 280 + static_cast<int>(i) * 48 - h, w, h);
  }
  battleEffects();
  const bool input = !session_.battle_.opening && !session_.message_.busy && !session_.battle_.wait && session_.battle_.active;
  if (input) {
    const bool party = ui.category == 4;
    std::vector<std::string> commands;
    std::vector<bool> enabled;
    if (party) { commands = {"Fight", "Escape"}; enabled = {true, session_.battle_.canEscape}; }
    else if (session_.battle_.actorIndex < static_cast<int>(session_.party_.size())) {
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
    statusKey.insert(statusKey.end(), {std::to_string(id), session_.database_["actors"][id]["name"].text(),
      std::to_string(actor.hp), std::to_string(actor.mp),
      std::to_string(static_cast<int>(session_.parameter(actor, 0))), std::to_string(static_cast<int>(session_.parameter(actor, 1)))});
    if (session_.database_["system"]["optDisplayTp"].boolean()) statusKey.push_back(std::to_string(actor.tp));
  }
  retainBattleContents(BattleWindow::status, std::move(statusKey), [&] {
    for (std::size_t i = 0; i < session_.party_.size(); ++i) {
      const int y = height - 162 + static_cast<int>(i) * 36; const int id = session_.party_[i]; const auto& actor = session_.actors_.at(id);
      text(session_.database_["actors"][id]["name"].text(), 216, y, 150, actor.hp <= 0 ? 18 : actor.hp < session_.parameter(actor, 0) / 4 ? 17 : 0);
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
      for (int id : session_.actors_.at(session_.party_[session_.battle_.actorIndex]).skills) if (session_.database_["skills"][id]["stypeId"].integer() == ui.skillType) entries.push_back(id);
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
    for (int index : targets) selectionKey.push_back(skill["scope"].integer() <= 6 ? session_.database_["enemies"][session_.battle_.enemies[index].id]["name"].text() : session_.database_["actors"][session_.party_[index]]["name"].text());
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
        targetHeight = data["battlerName"].text().empty() ? 0 : image("img/sv_enemies/" + data["battlerName"].text() + ".png").height;
      } else {
        if (index >= static_cast<int>(session_.party_.size())) continue;
        const auto& data = session_.database_["actors"][session_.party_[index]];
        targetX = 600 + index * 32; targetY = 280 + index * 48;
        targetHeight = data["battlerName"].text().empty() ? 0 : image("img/sv_actors/" + data["battlerName"].text() + ".png").height / 6;
      }
      if (age >= 8 && frameIndex < static_cast<int>(animation["frames"].array().size()) && (!screen || i == 0)) {
        const int position = animation["position"].integer();
        const float baseX = screen ? core_.width() / 2.0F : targetX;
        const float baseY = screen ? core_.height() / 2.0F : targetY - (position == 0 ? targetHeight : position == 1 ? targetHeight / 2 : 0);
        for (const auto& cell : animation["frames"][frameIndex].array()) {
          const int pattern = cell[0].integer(-1); if (pattern < 0) continue;
          const auto name = animation[pattern < 100 ? "animation1Name" : "animation2Name"].text(); if (name.empty()) continue;
          const auto source = image("img/animations/" + name + ".png", animation[pattern < 100 ? "animation1Hue" : "animation2Hue"].integer());
          const bool mirror = !enemy;
          const float rotation = cell[4].number() * 3.14159265358979323846 / 180 * (mirror ? -1 : 1);
          const float scaleY = cell[3].number() / 100, scaleX = scaleY * (cell[5].boolean() != mirror ? -1 : 1);
          const float a = std::cos(rotation) * scaleX, b = std::sin(rotation) * scaleX, c = -std::sin(rotation) * scaleY, d = std::cos(rotation) * scaleY;
          const float x = baseX + cell[1].number() * (mirror ? -1 : 1), y = baseY + cell[2].number();
          core_.renderer().queueImage(source.handle, {a,b,c,d,x - 96 * (a + c),y - 96 * (b + d)}, {static_cast<float>(pattern % 5 * 192), static_cast<float>(pattern % 100 / 5 * 192),192,192}, cell[6].number() / 255, 0xffffff, static_cast<BlendMode>(std::clamp(cell[7].integer(), 0, 3)));
        }
      }
      const int damageAge = visual.impact ? static_cast<int>(session_.ticks_ - visual.impact) : -1;
      if (damageAge >= 0 && damageAge < 90 && (target.result.hpAffected || target.result.mpDamage || target.result.missed || target.result.evaded)) {
        const auto source = image("img/system/Damage.png"); const int w = source.width / 10, h = source.height / 5;
        const int amount = target.result.hpAffected ? target.result.hpDamage : target.result.mpDamage;
        const bool missed = target.result.missed || target.result.evaded;
        const auto digits = std::to_string(std::abs(amount));
        if (missed) { quad(source.handle, 0, h * 4, w * 4, h, targetX - (enemy ? 0 : 32) - w * 2, targetY - (enemy ? 8 : 0) - 40 - h, w * 4, h, std::min(1.0F, (90 - damageAge) / 10.0F)); continue; }
        for (std::size_t digit = 0; digit < digits.size(); ++digit) {
          double y = -40, dy = -static_cast<int>(digit);
          for (int tick = 0; tick <= damageAge; ++tick) { dy += 0.5; y += dy; if (y >= 0) { y = 0; dy *= -0.6; } }
          quad(source.handle, (digits[digit] - '0') * w, ((target.result.hpAffected ? 0 : 2) + (amount < 0 ? 1 : 0)) * h, w, h, targetX - (enemy ? 0 : 32) + (static_cast<float>(digit) - (digits.size() - 1) / 2.0F) * w - w / 2, targetY - (enemy ? 8 : 0) + static_cast<int>(std::floor(y + 0.5)) - h, w, h, std::min(1.0F, (90 - damageAge) / 10.0F));
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
    const bool restore = kind == "battle-restore-bgm" || kind == "battle-restore-bgs";
    if (restore) kind = kind == "battle-restore-bgm" ? "bgm" : "bgs";
    const auto sound = restore ? kind == "bgm" ? session_.battle_.mapBgm : session_.battle_.mapBgs : command["sound"];
    const auto name = sound["name"].text();
    if (restore) (kind == "bgm" ? session_.savedBgm_ : session_.savedBgs_) = sound;
    if (kind == "me" && name.empty() && musicEffect_) {
      core_.media().stop(musicEffect_); core_.media().release(musicEffect_); musicEffect_ = 0;
      if (audio_["bgm"].second) core_.media().setSuspended(audio_["bgm"].second, false);
    }
    if (kind == "bgm" || kind == "bgs") {
      audioSettings_[kind] = sound;
      auto& active = audio_[kind];
      const bool changed = active.first != name;
      if (active.first != name && active.second) { core_.media().stop(active.second); core_.media().release(active.second); active = {}; }
      if (name.empty()) continue;
      if (active.first != name) {
        const auto source = core_.vfs().resolve("audio/" + kind + "/" + name + ".ogg");
        if (!source) throw std::runtime_error("audio unavailable: " + name);
        std::string error; active.second = core_.media().loadAudio(source->string(), &error); if (!active.second) throw std::runtime_error(error);
        active.first = name; core_.media().setParameters(active.second, sound["volume"].number(90) * session_.volumes_[kind == "bgm" ? 0 : kind == "bgs" ? 1 : kind == "me" ? 2 : 3] / 10000, sound["pitch"].number(100) / 100, sound["pan"].number() / 100); core_.media().play(active.second, true, 0);
      }
      if ((restore && changed) || command["restart"].boolean()) core_.media().play(active.second, true, sound["pos"].number());
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
    core_.media().setParameters(active.second, sound["volume"].number(90) * session_.volumes_[kind == "bgm" ? 0 : 1] / 10000, sound["pitch"].number(100) / 100, sound["pan"].number() / 100);
    if (kind == "bgm" && musicEffect_) core_.media().setSuspended(active.second, true);
  }
  for (auto it = sounds_.begin(); it != sounds_.end();) { if (!core_.media().isPlaying(*it)) { core_.media().release(*it); it = sounds_.erase(it); } else ++it; }
}
Value Presentation::audioState(const std::string& kind) {
  auto sound = audioSettings_[kind];
  if (sound.null()) sound = Value::Object{{"name", ""}, {"volume", 0}, {"pitch", 100}, {"pan", 0}};
  std::get<Value::Object>(sound.data)["pos"] = audio_[kind].second ? core_.media().position(audio_[kind].second) : 0;
  return sound;
}
void Presentation::captureAudioState() {
  processAudio();
  session_.savedBgm_ = audioState("bgm"); session_.savedBgs_ = audioState("bgs");
}
void Presentation::render() {
  const int sceneId = static_cast<int>(session_.ui_.scene);
  if (sceneId != lastScene_ || session_.mapId_ != lastMap_) {
    clearBattleContents();
    sceneTickOrigin_ = session_.ticks_;
    for (const auto& [key, value] : images_) { (void)key; core_.images().release(value.handle); }
    images_.clear();
    for (const auto& [key, value] : windows_) { (void)key; core_.canvases().release(value.first); core_.canvases().release(value.second); }
    windows_.clear(); lastScene_ = sceneId; lastMap_ = session_.mapId_;
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
    if (session_.mapId_ > 0) map();
    if (scene == Scene::map && session_.brightness_ < 255) core_.renderer().queueQuad(0, 0, width, height, {0, 0, 0, 1 - session_.brightness_ / 255.0F});
    if (scene == Scene::map) message(); else menu();
  }
  if (scene == Scene::battle) {
    for (const auto& contents : battleContents_) if (contents.visible) {
      if (const auto texture = core_.canvases().prepareImage(contents.canvas)) quad(*texture, 0, 0, width, height, 0, 0, width, height);
    }
  } else if (const auto texture = core_.canvases().prepareImage(textCanvas_)) quad(*texture, 0, 0, width, height, 0, 0, width, height);
  if (scene == Scene::title && session_.ui_.age < 24) core_.renderer().queueQuad(0, 0, width, height, {0, 0, 0, std::floor(255 * (1 - session_.ui_.age / 24.0F)) / 255});
}
}  // namespace pmjs::mv
