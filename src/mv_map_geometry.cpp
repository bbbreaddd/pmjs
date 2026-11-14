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

void Presentation::clearMapGeometry(){stockTilemap_.clearGeometry();stockTilemap_.imageResolver={};stockTileset_=-1;stockMapRevision_=0;graphTilemapId_=0;graphTilemapRevision_=0;}
void Presentation::prepareMapGeometry(int firstX,int firstY,int lastX,int lastY) {
  if(stockMapRevision_!=session_.presentationRevision_||stockTileset_!=session_.mapState_.tilesetId||(!graphTilemap_&&graphTilemapId_)) {
    const auto& map=session_.map();std::vector<int> data;
    data.reserve(map["data"].arrayLength());for(const auto& value:map["data"].array())data.push_back(value.integer());
    stockTilemap_.setData(map["width"].integer(),map["height"].integer(),std::move(data));
    stockTilemap_.flags.clear();for(const auto& flag:session_.database_["tilesets"][session_.mapState_.tilesetId]["flags"].array())stockTilemap_.flags.push_back(flag.integer());
    stockTilemap_.horizontalWrap=session_.loopHorizontal();stockTilemap_.verticalWrap=session_.loopVertical();
    stockTilemap_.imageResolver=[this](int sheet){const auto name=session_.database_["tilesets"][session_.mapState_.tilesetId]["tilesetNames"][sheet].text();return name.empty()?ImageInfo{}:image("img/tilesets/"+name+".png");};
    if(!graphTilemap_&&(session_.runtimeTileFunctions_||session_.runtimeTileDrawing_) && session_.runtimeHooks_ && session_.runtimeHooks_->tilemapState)
      session_.runtimeHooks_->tilemapState(Value::Object{{"_mapWidth",stockTilemap_.mapWidth},{"_mapHeight",stockTilemap_.mapHeight},{"_mapData",map["data"].reference()},{"flags",session_.database_["tilesets"][session_.mapState_.tilesetId]["flags"].reference()},{"horizontalWrap",stockTilemap_.horizontalWrap},{"verticalWrap",stockTilemap_.verticalWrap}});
    stockMapRevision_=session_.presentationRevision_;stockTileset_=session_.mapState_.tilesetId;graphTilemapId_=0;
  }
  if(graphTilemap_) {
    const auto& source=*graphTilemap_;
    if(stockTilemap_.tileWidth!=source.tileWidth||stockTilemap_.tileHeight!=source.tileHeight||
       stockTilemap_.mapWidth!=source.mapWidth||stockTilemap_.mapHeight!=source.mapHeight||
       stockTilemap_.horizontalWrap!=source.horizontalWrap||stockTilemap_.verticalWrap!=source.verticalWrap||
       graphTilemapId_!=source.displayId||graphTilemapRevision_!=source.revision_) {
      stockTilemap_.tileWidth=source.tileWidth;stockTilemap_.tileHeight=source.tileHeight;
      stockTilemap_.setData(source.mapWidth,source.mapHeight,source.data);
      stockTilemap_.flags=source.flags;stockTilemap_.horizontalWrap=source.horizontalWrap;stockTilemap_.verticalWrap=source.verticalWrap;
      graphTilemapId_=source.displayId;graphTilemapRevision_=source.revision_;stockTilemap_.refresh();
    }
    stockTilemap_.imageResolver=[source=graphTilemap_](int sheet) {
      if(sheet>=0&&sheet<int(source->bitmaps.size()))if(auto* bitmap=source->bitmaps[sheet])if(auto image=bitmap->texture())return *image;
      return ImageInfo{};
    };
  }
  stockTilemap_.readOverride={};stockTilemap_.classifyOverride={};
  if(session_.runtimeTileFunctions_ && session_.runtimeHooks_ && session_.runtimeHooks_->tilemapOperation) {
    stockTilemap_.readOverride=[this](int x,int y,int z)->std::optional<int> {
      const auto value=session_.runtimeHooks_->tilemapOperation("_readMapData",x,y,z);return value?std::optional<int>{value->integer()}:std::nullopt;
    };
    stockTilemap_.classifyOverride=[this](const std::string& method,int first,int second)->std::optional<bool> {
      const auto value=session_.runtimeHooks_->tilemapOperation(method,first,second,0);return value?std::optional<bool>{value->boolean()}:std::nullopt;
    };
  }
  stockTilemap_.paintGeometry={};
  if(session_.runtimeTileDrawing_ && session_.runtimeHooks_ && session_.runtimeHooks_->tilemapGeometry) {
    stockTilemap_.paintGeometry=[this](int firstX,int firstY,int lastX,int lastY)->std::optional<std::array<std::vector<core::Tilemap::TileRectangle>,2>> {
      const auto result=session_.runtimeHooks_->tilemapGeometry(firstX,firstY,lastX,lastY,stockTilemap_.tileWidth,stockTilemap_.tileHeight);
      if(!result)return {};
      if(result->arrayLength()!=2)throw std::invalid_argument("tile drawing requires two layers");
      std::array<std::vector<core::Tilemap::TileRectangle>,2> layers;
      for(int layer=0;layer<2;++layer)for(const auto& record:(*result)[layer].array()) {
        if(record.arrayLength()!=9)throw std::invalid_argument("tile drawing requires nine rectangle fields");
        for(const auto& value:record.array())if(!std::isfinite(value.number()))throw std::invalid_argument("tile drawing rectangle must be finite");
        layers[layer].push_back({record[0].integer(),{record[1].number(),record[2].number(),record[5].number(),record[6].number()},
          {record[3].number(),record[4].number()},{record[7].number()*stockTilemap_.tileWidth,record[8].number()*stockTilemap_.tileHeight}});
      }
      return layers;
    };
  }
  stockTilemap_.shadowGeometry = {};
  if (session_.runtimeTileShadows_) stockTilemap_.shadowGeometry = [this](int bits,int x,int y) -> std::optional<std::vector<core::Rectangle>> {
    if (!session_.runtimeHooks_ || !session_.runtimeHooks_->tileShadow) return {};
    const auto custom = session_.runtimeHooks_->tileShadow(bits,x,y,stockTilemap_.tileWidth,stockTilemap_.tileHeight);
    if (!custom) return {};
    std::vector<core::Rectangle> rectangles;
    for (const auto& rect : custom->array()) rectangles.push_back({rect[0].number(),rect[1].number(),rect[2].number(),rect[3].number()});
    return rectangles;
  };
  stockTilemap_.prepareGeometry(core_.renderer(),firstX,firstY,lastX,lastY);
}
void Presentation::queueMapGeometry(bool upper,int originX,int originY) {
  stockTilemap_.animationFrame=graphTilemap_?graphTilemap_->animationFrame:int(session_.ticks_/30);
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
  const auto& tiled = session_.tiledMapData(session_.mapId_);
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
  if (graphCharacterRenderer_) return;
  const auto shadow = session_.runtimeMapShadow();
  if (shadow[2] <= 0) return;
  const auto source = image("img/system/Shadow1.png");
  quad(source.handle, 0, 0, source.width, source.height, shadow[0] - source.width / 2.0, shadow[1] - source.height,
    source.width, source.height, shadow[2] / 255.0);
}
}
