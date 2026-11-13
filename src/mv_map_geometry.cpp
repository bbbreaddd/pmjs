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
  destinationCanvas_ = 0; mapNameWindow_.reset();
  destinationSprite_.reset(); destinationStarted_ = false;
}
void Presentation::mapDestination() {
  if (!session_.destination_) {
    destinationSprite_.reset(); destinationStarted_ = false; destinationTick_ = session_.ticks_;
    return;
  }
  if (!destinationCanvas_) {
    const auto canvas = core_.canvases().create(1, 1);
    if (!canvas) throw std::runtime_error("cannot create destination marker");
    destinationCanvas_ = canvas->handle;
    if (!core_.canvases().fillRect(destinationCanvas_, 0, 0, 1, 1, 0xffffffff)) throw std::runtime_error("cannot draw destination marker");
  }
  if (!destinationStarted_ || session_.ticks_ < destinationTick_) {
    destinationSprite_.reset(); destinationSprite_.advance(1); destinationStarted_ = true;
  } else {
    destinationSprite_.advance(session_.ticks_ - destinationTick_);
  }
  destinationTick_ = session_.ticks_;
  const auto source = core_.canvases().prepareImage(destinationCanvas_);
  if (!source) throw std::runtime_error("cannot prepare destination marker");
  const auto& tiled = session_.database_["tiledMaps"][std::to_string(session_.mapId_)];
  const int tw = tiled["tilewidth"].integer(48), th = tiled["tileheight"].integer(48);
  destinationSprite_.targetX = (*session_.destination_)[0]; destinationSprite_.targetY = (*session_.destination_)[1];
  const double x = (scrolledMapX(destinationSprite_.targetX, cameraX_, tw) + 0.5) * tw;
  const double y = (scrolledMapY(destinationSprite_.targetY, cameraY_, th) + 0.5) * th;
  const float width = tw * destinationSprite_.scale.x, height = th * destinationSprite_.scale.y;
  if (!core_.renderer().queueImage(*source, {width, 0, 0, height, static_cast<float>(x - width / 2), static_cast<float>(y - height / 2)},
      {0, 0, 1, 1}, destinationSprite_.opacity, 0xffffff, static_cast<BlendMode>(destinationSprite_.blendMode))) throw std::runtime_error("cannot queue destination marker");
}
void Presentation::mapName() {
  const auto name = session_.map()["displayName"].text();
  const bool rewound = session_.ticks_ < mapNameTick_;
  const bool changed = !mapNameWindow_ || rewound || mapNameRevision_ != session_.presentationRevision_ || mapNameWindow_->mapName != name;
  if (changed) {
    if (!mapNameWindow_ || rewound) mapNameWindow_ = std::make_shared<Window_MapName>();
    auto& contents = mapNameWindow_->contents;
    contents.textColor = core::Utils::rgbToCssColor(colors_[0] >> 24, (colors_[0] >> 16) & 255, (colors_[0] >> 8) & 255);
    mapNameWindow_->open(name);
    mapNameWindow_->advance(1, session_.mapState_.nameDisplay);
    mapNameRevision_ = session_.presentationRevision_;
  } else {
    mapNameWindow_->advance(session_.ticks_ - mapNameTick_, session_.mapState_.nameDisplay);
  }
  mapNameTick_ = session_.ticks_;
  if (name.empty() || mapNameWindow_->contentsOpacity <= 0) return;
  core::Window window;
  window.move(0,0,mapNameWindow_->rect.width,mapNameWindow_->rect.height);
  window.opacity=0;window.contentsOpacity=mapNameWindow_->contentsOpacity;
  window.contents=std::shared_ptr<core::PixelBitmap>(mapNameWindow_,&mapNameWindow_->contents);
  streamUiWindow(window);
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
