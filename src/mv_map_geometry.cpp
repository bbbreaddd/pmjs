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

void Presentation::clearMapGeometry() {
  for (const auto& part : lowerMapGeometry_) if (part.layer) core_.renderer().releaseTileLayer(part.layer);
  for (auto layer : upperMapGeometry_) core_.renderer().releaseTileLayer(layer);
  lowerMapGeometry_.clear(); upperMapGeometry_.clear(); mapGeometryValid_ = false;
}
void Presentation::prepareMapGeometry(int firstX, int firstY, int lastX, int lastY) {
  const std::array key{session_.mapId_, session_.mapState_.tilesetId, firstX, firstY, lastX, lastY};
  if (mapGeometryValid_ && mapGeometryKey_ == key && mapGeometryRevision_ == session_.presentationRevision_) return;
  clearMapGeometry();
  const auto& data = session_.map();
  const int width = data["width"].integer(), height = data["height"].integer();
  const auto& flags = session_.database_["tilesets"][session_.mapState_.tilesetId]["flags"];
  std::vector<TileLayerTile> lower, upper;
  const auto flush = [&](std::vector<TileLayerTile>& tiles, bool high) {
    if (tiles.empty()) return;
    const auto layer = core_.renderer().createTileLayer(std::move(tiles));
    tiles.clear();
    if (!layer) throw std::runtime_error("cannot create map tile geometry");
    try {
      if (high) upperMapGeometry_.push_back(layer);
      else lowerMapGeometry_.push_back({layer, 0, 0});
    } catch (...) { core_.renderer().releaseTileLayer(layer); throw; }
  };
  try {
    for (int y = firstY; y < lastY; ++y) for (int x = firstX; x < lastX; ++x) {
      const int mapX = session_.roundMapX(x), mapY = session_.roundMapY(y);
      if (mapX < 0 || mapY < 0 || mapX >= width || mapY >= height) continue;
      for (int level = 0; level < 4; ++level) {
        const int id = data["data"][(level * height + mapY) * width + mapX].integer();
        const bool high = (flags[id].integer() & 16) != 0;
        auto& tiles = high ? upper : lower;
        if (tiles.size() > 65528) flush(tiles, high);
        tile(id, x * 48, y * 48, tiles);
        if (level == 1) {
          const int bits = data["data"][(4 * height + mapY) * width + mapX].integer();
          if (bits) flush(lower, false);
          for (int i = 0; i < 4; ++i) if (bits & (1 << i))
            lowerMapGeometry_.push_back({0, x * 48 + i % 2 * 24, y * 48 + i / 2 * 24});
          const int aboveY = session_.roundMapY(mapY - 1);
          const int above = aboveY >= 0 && aboveY < height ? data["data"][(height + aboveY) * width + mapX].integer() : 0;
          const int ground = data["data"][mapY * width + mapX].integer();
          const auto table = [&](int tileId) { return tileId >= 2816 && tileId < 4352 && (flags[tileId].integer() & 128); };
          if (table(above) && !table(id) && !(ground >= 4352 && ground < 8192)) {
            if (lower.size() > 65528) flush(lower, false);
            tile(10000 + above, x * 48, y * 48, lower);
          }
        }
      }
    }
    flush(lower, false); flush(upper, true);
    mapGeometryKey_ = key; mapGeometryRevision_ = session_.presentationRevision_; mapGeometryValid_ = true;
  } catch (...) { clearMapGeometry(); throw; }
}
void Presentation::queueMapGeometry(bool upper, int originX, int originY) {
  const int frame = static_cast<int>(session_.ticks_ / 30);
  constexpr std::array<float, 4> water{0, 1, 2, 1};
  const std::array<float, 2> animation{water[frame % 4], static_cast<float>(frame % 3)};
  const std::array<float, 6> transform{1, 0, 0, 1, -static_cast<float>(originX), -static_cast<float>(originY)};
  const auto queue = [&](std::uint32_t layer) {
    if (!core_.renderer().queueTileLayer(layer, transform, animation, 1, 0xffffff, BlendMode::normal))
      throw std::runtime_error("cannot queue map tile geometry");
  };
  if (upper) for (auto layer : upperMapGeometry_) queue(layer);
  else for (const auto& part : lowerMapGeometry_) {
    if (part.layer) queue(part.layer);
    else core_.renderer().queueQuad(part.x - originX, part.y - originY, 24, 24, {0, 0, 0, 0.5F});
  }
}
}

namespace pmjs::mv {
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
