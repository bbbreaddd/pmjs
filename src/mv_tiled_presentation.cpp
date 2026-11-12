#include "mv_presentation.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace pmjs::mv {
namespace {
constexpr int chunkWidth = 32;
constexpr std::size_t maxChunks = 512;
int property(const Value& value) {
  return value.text().empty() ? value.integer() : std::stoi(value.text());
}
}

void Presentation::clearTiledGeometry() {
  for (auto& [key, chunk] : tiledChunks_) {
    (void)key;
    if (chunk.stationary) core_.renderer().releaseTileLayer(chunk.stationary);
    if (chunk.animated) core_.renderer().releaseTileLayer(chunk.animated);
  }
  tiledChunks_.clear(); tiledDraws_.clear(); tiledBounds_.clear(); tiledNextBounds_.clear();
  tiledGeometryData_ = nullptr; tiledUse_ = 0; tiledGeometryRevision_ = 0;
}

Presentation::TiledChunk& Presentation::tiledChunk(const Value& data, const TiledDraw& draw) {
  if (auto found = tiledChunks_.find(draw.key); found != tiledChunks_.end()) {
    found->second.lastUse = ++tiledUse_;
    return found->second;
  }
  if (tiledChunks_.size() >= maxChunks) {
    const auto oldest = std::min_element(tiledChunks_.begin(), tiledChunks_.end(), [](const auto& left, const auto& right) {
      return left.second.lastUse < right.second.lastUse;
    });
    if (oldest->second.stationary) core_.renderer().releaseTileLayer(oldest->second.stationary);
    if (oldest->second.animated) core_.renderer().releaseTileLayer(oldest->second.animated);
    tiledChunks_.erase(oldest);
  }
  const auto [layerIndex, row, column] = draw.key;
  const auto& layer = data["layers"][layerIndex];
  const int width = data["width"].integer(), tw = data["tilewidth"].integer(), th = data["tileheight"].integer();
  std::vector<TileLayerTile> stationary;
  std::vector<TiledAnimation> animations;
  for (int x = column; x < (session_.loopHorizontal() ? column + chunkWidth : std::min(column + chunkWidth, width)); ++x) {
    const int mapX = session_.roundMapX(x), mapY = session_.roundMapY(row);
    const int gid = layer["data"][mapY * width + mapX].integer();
    if (!gid) continue;
    const Value* set = nullptr;
    for (const auto& candidate : data["tilesets"].array()) if (gid >= candidate["firstgid"].integer()) set = &candidate;
    if (!set) throw std::runtime_error("tile has no tileset");
    const int id = gid - (*set)["firstgid"].integer(), columns = (*set)["columns"].integer();
    if (columns <= 0) throw std::runtime_error("tileset has no columns");
    const auto source = image((*set)["image"].text());
    TileLayerTile tile{source.handle,
      {float(id % columns * tw), float(id / columns * th), float(tw), float(th)},
      {float(x * tw + layer["offsetx"].integer()), float(row * th + layer["offsety"].integer())}, {0, 0}};
    const auto& sequence = (*set)["tiles"][std::to_string(id)]["animation"].array();
    if (sequence.empty()) stationary.push_back(tile);
    else {
      TiledAnimation animation;
      animation.tile = tile; animation.columns = columns;
      for (const auto& frame : sequence) {
        const double duration = frame["duration"].number();
        if (duration <= 0) throw std::runtime_error("tile animation has an invalid duration");
        animation.frames.emplace_back(frame["tileid"].integer(), duration);
        animation.duration += duration;
      }
      animations.push_back(std::move(animation));
    }
  }
  auto [found, inserted] = tiledChunks_.try_emplace(draw.key);
  (void)inserted;
  auto& chunk = found->second;
  try {
    chunk.animations = std::move(animations); chunk.lastUse = ++tiledUse_;
    if (!stationary.empty()) {
      chunk.stationary = core_.renderer().createTileLayer(std::move(stationary));
      if (!chunk.stationary) throw std::runtime_error("cannot retain tiled geometry");
    }
  } catch (...) {
    if (chunk.stationary) core_.renderer().releaseTileLayer(chunk.stationary);
    tiledChunks_.erase(found);
    throw;
  }
  return chunk;
}

void Presentation::updateTiledAnimation(TiledChunk& chunk, int tw, int th, double age) {
  if (chunk.animations.empty()) return;
  bool changed = !chunk.animated;
  for (auto& animation : chunk.animations) {
    double remaining = std::fmod(age, animation.duration);
    int id = animation.frames.back().first;
    for (const auto& [candidate, duration] : animation.frames) {
      id = candidate; remaining -= duration;
      if (remaining < 0) break;
    }
    animation.nextFrame = id;
    changed = changed || id != animation.frame;
  }
  if (!changed) return;
  std::vector<TileLayerTile> tiles;
  tiles.reserve(chunk.animations.size());
  for (std::size_t index = 0; index < chunk.animations.size(); ++index) {
    const auto& animation = chunk.animations[index];
    auto tile = animation.tile;
    const int id = animation.nextFrame;
    tile.source[0] = id % animation.columns * tw; tile.source[1] = id / animation.columns * th;
    tiles.push_back(tile);
  }
  const auto replacement = core_.renderer().createTileLayer(std::move(tiles));
  if (!replacement) throw std::runtime_error("cannot retain animated tiled geometry");
  if (chunk.animated) core_.renderer().releaseTileLayer(chunk.animated);
  chunk.animated = replacement;
  for (auto& animation : chunk.animations) animation.frame = animation.nextFrame;
}

void Presentation::tiledMap(const Value& data) {
  if (tiledGeometryData_ != &data || tiledGeometryRevision_ != session_.presentationRevision_) {
    clearTiledGeometry(); tiledGeometryData_ = &data; tiledGeometryRevision_ = session_.presentationRevision_;
  }
  const int width = data["width"].integer(), height = data["height"].integer();
  const int tw = data["tilewidth"].integer(), th = data["tileheight"].integer();
  if (width <= 0 || height <= 0 || tw <= 0 || th <= 0) throw std::runtime_error("invalid tiled map dimensions");
  const double screenX = core_.width() / double(tw), screenY = core_.height() / double(th);
  cameraX_ = width < screenX ? (width - screenX) / 2 : std::clamp(session_.player_.realX - (screenX - 1) / 2, 0.0, width - screenX);
  cameraY_ = height < screenY ? (height - screenY) / 2 : std::clamp(session_.player_.realY - (screenY - 1) / 2, 0.0, height - screenY);
  if (session_.savedCamera_) { cameraX_ = (*session_.savedCamera_)[0]; cameraY_ = (*session_.savedCamera_)[1]; }
  const int ox = static_cast<int>(std::floor(cameraX_ * tw)), oy = static_cast<int>(std::floor(cameraY_ * th));
  const auto& layers = data["layers"].array();
  auto& bounds = tiledNextBounds_;
  bounds.clear(); bounds.reserve(layers.size());
  for (const auto& layer : layers) {
    if (!layer["visible"].null() && !layer["visible"].boolean()) { bounds.push_back({}); continue; }
    const int dx = layer["offsetx"].integer(), dy = layer["offsety"].integer();
    const int firstX = static_cast<int>(std::floor(double(ox - dx) / tw)), firstY = static_cast<int>(std::floor(double(oy - dy) / th));
    bounds.push_back({session_.loopHorizontal() ? firstX : std::max(0, firstX),
      session_.loopHorizontal() ? (ox - dx + core_.width()) / tw + 1 : std::min(width, (ox - dx + core_.width()) / tw + 1),
      session_.loopVertical() ? firstY : std::max(0, firstY),
      session_.loopVertical() ? (oy - dy + core_.height()) / th + 1 : std::min(height, (oy - dy + core_.height()) / th + 1)});
  }
  if (bounds != tiledBounds_) {
    tiledDraws_.clear(); tiledBounds_ = bounds;
    for (std::size_t index = 0; index < layers.size(); ++index) {
      const auto& layer = layers[index]; const auto& area = bounds[index];
      const int z = property(layer["properties"]["zIndex"]), priority = property(layer["properties"]["priority"]);
      const bool sorted = z == 3 && priority > 0;
      for (int row = area[2]; row < area[3]; ++row) {
        for (int column = static_cast<int>(std::floor(double(area[0]) / chunkWidth)) * chunkWidth; column < area[1]; column += chunkWidth) {
          tiledDraws_.push_back({{index, row, column}, z, sorted ? (row + 1) * th + layer["offsety"].integer() : 0,
            sorted ? priority : 0, tiledDraws_.size(),
            static_cast<float>(layer["opacity"].number(1)), sorted});
        }
      }
    }
    std::stable_sort(tiledDraws_.begin(), tiledDraws_.end(), [oy](const TiledDraw& left, const TiledDraw& right) {
      return std::tuple(left.z, left.sorted ? left.y - oy : 0, left.priority, left.order) <
        std::tuple(right.z, right.sorted ? right.y - oy : 0, right.priority, right.order);
    });
  }
  struct Actor { int z, y; std::size_t order; const Character* character; };
  std::vector<Actor> actors;
  std::size_t order = tiledDraws_.size();
  const auto actor = [&](const Character& value, int priority) {
    const bool object = value.characterName.find('!') < 2;
    const int y = static_cast<int>(std::floor(scrolledMapY(value.realY, cameraY_, th) * th + th - (object ? 0 : 6) + 0.5) + value.spriteOffsetY);
    actors.push_back({priority * 2 + 1, y, order++, &value});
  };
  for (const auto& event : session_.events_) if (event.page >= 0) actor(event.character, event.priority);
  for (const auto& vehicle : session_.vehicles_) if (vehicle.mapId == session_.mapId_) actor(vehicle.character, vehicle.type == 2 ? vehicle.altitude > 0 ? 2 : 0 : 1);
  for (auto follower = session_.followers_.rbegin(); follower != session_.followers_.rend(); ++follower) actor(*follower, 1);
  actor(session_.player_, 1);
  const auto& airship = session_.vehicles_[2];
  if (airship.mapId == session_.mapId_ && airship.altitude > 0) {
    const bool object = airship.character.characterName.find('!') < 2;
    const int y = static_cast<int>(std::floor(scrolledMapY(airship.character.realY, cameraY_, th) * th + th - (object ? 0 : 6) + 0.5));
    actors.push_back({6, y, order++, nullptr});
  }
  std::stable_sort(actors.begin(), actors.end(), [](const Actor& left, const Actor& right) {
    return std::tie(left.z, left.y, left.order) < std::tie(right.z, right.y, right.order);
  });
  const auto drawActor = [&](const Actor& value) { if (value.character) character(*value.character, cameraX_, cameraY_); else mapShadow(); };
  std::size_t nextActor = 0;
  const double age = (session_.ticks_ - sceneTickOrigin_) * 1000 / 60;
  for (const auto& draw : tiledDraws_) {
    const auto key = std::tuple(draw.z, draw.sorted ? draw.y - oy : 0, draw.priority, draw.order);
    while (nextActor < actors.size() && std::tuple(actors[nextActor].z, actors[nextActor].y, 0, actors[nextActor].order) < key)
      drawActor(actors[nextActor++]);
    auto& chunk = tiledChunk(data, draw);
    updateTiledAnimation(chunk, tw, th, age);
    for (const auto handle : {chunk.stationary, chunk.animated}) if (handle &&
      !core_.renderer().queueTileLayer(handle, {1, 0, 0, 1, float(-ox), float(-oy)}, {0, 0}, draw.alpha, 0xffffff, BlendMode::normal))
      throw std::runtime_error("cannot queue retained tiled geometry");
  }
  while (nextActor < actors.size()) drawActor(actors[nextActor++]);
}

}  // namespace pmjs::mv
