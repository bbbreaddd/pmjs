#include "mv_presentation.hpp"
#include <stdexcept>
#include <algorithm>
#include <cmath>

namespace pmjs::mv {
double Presentation::scrolledMapX(double x, double cameraX, int tileWidth) const {
  const double width = session_.map()["width"].number();
  return session_.loopHorizontal() && x < cameraX - (width - core_.width() / double(tileWidth)) / 2 ? x - cameraX + width : x - cameraX;
}
double Presentation::scrolledMapY(double y, double cameraY, int tileHeight) const {
  const double height = session_.map()["height"].number();
  return session_.loopVertical() && y < cameraY - (height - core_.height() / double(tileHeight)) / 2 ? y - cameraY + height : y - cameraY;
}

void Presentation::clearMapGeometry(){stockTilemap_.clearGeometry();stockTileset_=-1;stockMapRevision_=0;}
void Presentation::prepareMapGeometry(int firstX,int firstY,int lastX,int lastY) {
  if(stockMapRevision_!=session_.presentationRevision_||stockTileset_!=session_.mapState_.tilesetId) {
    const auto& map=session_.map();std::vector<int> data;
    data.reserve(map["data"].array().size());for(const auto& value:map["data"].array())data.push_back(value.integer());
    stockTilemap_.setData(map["width"].integer(),map["height"].integer(),std::move(data));
    stockTilemap_.flags.clear();for(const auto& flag:session_.database_["tilesets"][session_.mapState_.tilesetId]["flags"].array())stockTilemap_.flags.push_back(flag.integer());
    stockTilemap_.horizontalWrap=session_.loopHorizontal();stockTilemap_.verticalWrap=session_.loopVertical();
    stockTilemap_.imageResolver=[this](int sheet){const auto name=session_.database_["tilesets"][session_.mapState_.tilesetId]["tilesetNames"][sheet].text();return name.empty()?ImageInfo{}:image("img/tilesets/"+name+".png");};
    stockMapRevision_=session_.presentationRevision_;stockTileset_=session_.mapState_.tilesetId;
  }
  stockTilemap_.prepareGeometry(core_.renderer(),firstX,firstY,lastX,lastY);
}
void Presentation::queueMapGeometry(bool upper,int originX,int originY) {
  stockTilemap_.animationFrame=int(session_.ticks_/30);
  stockTilemap_.queueGeometry(core_.renderer(),upper,{1,0,0,1,float(-originX),float(-originY)});
}
void Presentation::clearMapOverlays() {
  if (destinationCanvas_) core_.canvases().release(destinationCanvas_);
  if (mapNameCanvas_) core_.canvases().release(mapNameCanvas_);
  destinationCanvas_ = 0; mapNameCanvas_ = 0; mapNameText_.clear();
}
void Presentation::mapDestination() {
  if (!session_.destination_) { destinationAge_ = 0; destinationTick_ = session_.ticks_; return; }
  if (!destinationCanvas_) {
    const auto canvas = core_.canvases().create(1, 1);
    if (!canvas) throw std::runtime_error("cannot create destination marker");
    destinationCanvas_ = canvas->handle;
    if (!core_.canvases().fillRect(destinationCanvas_, 0, 0, 1, 1, 0xffffffff)) throw std::runtime_error("cannot draw destination marker");
  }
  if (destinationTick_ != session_.ticks_) { destinationAge_ = (destinationAge_ + 1) % 20; destinationTick_ = session_.ticks_; }
  const auto source = core_.canvases().prepareImage(destinationCanvas_);
  if (!source) throw std::runtime_error("cannot prepare destination marker");
  const auto& tiled = session_.database_["tiledMaps"][std::to_string(session_.mapId_)];
  const int tw = tiled["tilewidth"].integer(48), th = tiled["tileheight"].integer(48);
  const double x = (scrolledMapX((*session_.destination_)[0], cameraX_, tw) + 0.5) * tw;
  const double y = (scrolledMapY((*session_.destination_)[1], cameraY_, th) + 0.5) * th;
  const float scale = 1 + destinationAge_ / 20.0F, width = tw * scale, height = th * scale;
  if (!core_.renderer().queueImage(*source, {width, 0, 0, height, static_cast<float>(x - width / 2), static_cast<float>(y - height / 2)},
      {0, 0, 1, 1}, (20 - destinationAge_) * 6 / 255.0F, 0xffffff, BlendMode::additive)) throw std::runtime_error("cannot queue destination marker");
}
void Presentation::mapName() {
  const auto name = session_.map()["displayName"].text();
  const bool changed = mapNameRevision_ != session_.presentationRevision_ || mapNameText_ != name;
  if (changed) {
    mapNameRevision_ = session_.presentationRevision_; mapNameText_ = name;
    mapNameShowCount_ = 150; mapNameOpacity_ = 0; mapNameTick_ = session_.ticks_;
    if (mapNameCanvas_) { core_.canvases().release(mapNameCanvas_); mapNameCanvas_ = 0; }
  }
  if (mapNameTick_ != session_.ticks_) {
    if (mapNameShowCount_ > 0 && session_.mapState_.nameDisplay) { --mapNameShowCount_; mapNameOpacity_ = std::min(255, mapNameOpacity_ + 16); }
    else mapNameOpacity_ = std::max(0, mapNameOpacity_ - 16);
    mapNameTick_ = session_.ticks_;
  }
  if (name.empty() || mapNameOpacity_ <= 0) return;
  if (!mapNameCanvas_) {
    const auto canvas = core_.canvases().create(324, 36);
    if (!canvas) throw std::runtime_error("cannot create map name contents");
    mapNameCanvas_ = canvas->handle;
    const std::vector<float> offsets{0, 1};
    if (!core_.canvases().paintRect(mapNameCanvas_, {0, 0, 162, 36}, 0xffffffff, 0, {0, 0, 162, 0}, offsets, {0x00000000, 0x00000099}) ||
        !core_.canvases().paintRect(mapNameCanvas_, {162, 0, 162, 36}, 0xffffffff, 0, {162, 0, 324, 0}, offsets, {0x00000099, 0x00000000})) throw std::runtime_error("cannot draw map name background");
    const double measured = core_.canvases().measureText(fonts_, name, 28).value_or(0);
    const float x = std::max(0.0, (324 - measured) / 2), baseline = (36 + 28 * 0.7F) / 2;
    if (!core_.canvases().drawText(mapNameCanvas_, fonts_, name, x, baseline, 28, 0x00000080, 4) ||
        !core_.canvases().drawText(mapNameCanvas_, fonts_, name, x, baseline, 28, colors_[0])) throw std::runtime_error("cannot draw map name");
  }
  const auto source = core_.canvases().prepareImage(mapNameCanvas_);
  if (!source || !core_.renderer().queueImage(*source, {1, 0, 0, 1, 18, 18}, {0, 0, 324, 36}, mapNameOpacity_ / 255.0F,
      0xffffff, BlendMode::normal)) throw std::runtime_error("cannot queue map name");
}
}

namespace pmjs::mv {
void Presentation::mapShadow() {
  const auto& airship = session_.vehicles_[2];
  if (airship.mapId != session_.mapId_ || airship.altitude <= 0) return;
  const auto source = image("img/system/Shadow1.png");
  const auto& tiled = session_.database_["tiledMaps"][std::to_string(session_.mapId_)];
  const int tw = tiled["tilewidth"].integer(48), th = tiled["tileheight"].integer(48);
  const double x = std::floor(scrolledMapX(airship.character.realX, cameraX_, tw) * tw + tw / 2.0 + 0.5);
  const bool object = airship.character.characterName.find('!') < 2;
  const double y = std::floor(scrolledMapY(airship.character.realY, cameraY_, th) * th + th - (object ? 0 : 6) + 0.5);
  quad(source.handle, 0, 0, source.width, source.height, x - source.width / 2.0, y - source.height,
    source.width, source.height, std::clamp(airship.altitude / 48.0F, 0.0F, 1.0F));
}
}
