#include "mv_core_display.hpp"
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace pmjs::mv::core {
const std::array<std::array<std::array<int,2>,4>,48> Tilemap::FLOOR_AUTOTILE_TABLE = {{{{{{2,4}},{{1,4}},{{2,3}},{{1,3}}}},{{{{2,0}},{{1,4}},{{2,3}},{{1,3}}}},{{{{2,4}},{{3,0}},{{2,3}},{{1,3}}}},{{{{2,0}},{{3,0}},{{2,3}},{{1,3}}}},{{{{2,4}},{{1,4}},{{2,3}},{{3,1}}}},{{{{2,0}},{{1,4}},{{2,3}},{{3,1}}}},{{{{2,4}},{{3,0}},{{2,3}},{{3,1}}}},{{{{2,0}},{{3,0}},{{2,3}},{{3,1}}}},{{{{2,4}},{{1,4}},{{2,1}},{{1,3}}}},{{{{2,0}},{{1,4}},{{2,1}},{{1,3}}}},{{{{2,4}},{{3,0}},{{2,1}},{{1,3}}}},{{{{2,0}},{{3,0}},{{2,1}},{{1,3}}}},{{{{2,4}},{{1,4}},{{2,1}},{{3,1}}}},{{{{2,0}},{{1,4}},{{2,1}},{{3,1}}}},{{{{2,4}},{{3,0}},{{2,1}},{{3,1}}}},{{{{2,0}},{{3,0}},{{2,1}},{{3,1}}}},{{{{0,4}},{{1,4}},{{0,3}},{{1,3}}}},{{{{0,4}},{{3,0}},{{0,3}},{{1,3}}}},{{{{0,4}},{{1,4}},{{0,3}},{{3,1}}}},{{{{0,4}},{{3,0}},{{0,3}},{{3,1}}}},{{{{2,2}},{{1,2}},{{2,3}},{{1,3}}}},{{{{2,2}},{{1,2}},{{2,3}},{{3,1}}}},{{{{2,2}},{{1,2}},{{2,1}},{{1,3}}}},{{{{2,2}},{{1,2}},{{2,1}},{{3,1}}}},{{{{2,4}},{{3,4}},{{2,3}},{{3,3}}}},{{{{2,4}},{{3,4}},{{2,1}},{{3,3}}}},{{{{2,0}},{{3,4}},{{2,3}},{{3,3}}}},{{{{2,0}},{{3,4}},{{2,1}},{{3,3}}}},{{{{2,4}},{{1,4}},{{2,5}},{{1,5}}}},{{{{2,0}},{{1,4}},{{2,5}},{{1,5}}}},{{{{2,4}},{{3,0}},{{2,5}},{{1,5}}}},{{{{2,0}},{{3,0}},{{2,5}},{{1,5}}}},{{{{0,4}},{{3,4}},{{0,3}},{{3,3}}}},{{{{2,2}},{{1,2}},{{2,5}},{{1,5}}}},{{{{0,2}},{{1,2}},{{0,3}},{{1,3}}}},{{{{0,2}},{{1,2}},{{0,3}},{{3,1}}}},{{{{2,2}},{{3,2}},{{2,3}},{{3,3}}}},{{{{2,2}},{{3,2}},{{2,1}},{{3,3}}}},{{{{2,4}},{{3,4}},{{2,5}},{{3,5}}}},{{{{2,0}},{{3,4}},{{2,5}},{{3,5}}}},{{{{0,4}},{{1,4}},{{0,5}},{{1,5}}}},{{{{0,4}},{{3,0}},{{0,5}},{{1,5}}}},{{{{0,2}},{{3,2}},{{0,3}},{{3,3}}}},{{{{0,2}},{{1,2}},{{0,5}},{{1,5}}}},{{{{0,4}},{{3,4}},{{0,5}},{{3,5}}}},{{{{2,2}},{{3,2}},{{2,5}},{{3,5}}}},{{{{0,2}},{{3,2}},{{0,5}},{{3,5}}}},{{{{0,0}},{{1,0}},{{0,1}},{{1,1}}}}}};
const std::array<std::array<std::array<int,2>,4>,16> Tilemap::WALL_AUTOTILE_TABLE = {{{{{{2,2}},{{1,2}},{{2,1}},{{1,1}}}},{{{{0,2}},{{1,2}},{{0,1}},{{1,1}}}},{{{{2,0}},{{1,0}},{{2,1}},{{1,1}}}},{{{{0,0}},{{1,0}},{{0,1}},{{1,1}}}},{{{{2,2}},{{3,2}},{{2,1}},{{3,1}}}},{{{{0,2}},{{3,2}},{{0,1}},{{3,1}}}},{{{{2,0}},{{3,0}},{{2,1}},{{3,1}}}},{{{{0,0}},{{3,0}},{{0,1}},{{3,1}}}},{{{{2,2}},{{1,2}},{{2,3}},{{1,3}}}},{{{{0,2}},{{1,2}},{{0,3}},{{1,3}}}},{{{{2,0}},{{1,0}},{{2,3}},{{1,3}}}},{{{{0,0}},{{1,0}},{{0,3}},{{1,3}}}},{{{{2,2}},{{3,2}},{{2,3}},{{3,3}}}},{{{{0,2}},{{3,2}},{{0,3}},{{3,3}}}},{{{{2,0}},{{3,0}},{{2,3}},{{3,3}}}},{{{{0,0}},{{3,0}},{{0,3}},{{3,3}}}}}};
const std::array<std::array<std::array<int,2>,4>,4> Tilemap::WATERFALL_AUTOTILE_TABLE = {{{{{{2,0}},{{1,0}},{{2,1}},{{1,1}}}},{{{{0,0}},{{1,0}},{{0,1}},{{1,1}}}},{{{{2,0}},{{3,0}},{{2,1}},{{3,1}}}},{{{{0,0}},{{3,0}},{{0,1}},{{3,1}}}}}};
namespace {
class TilemapLayer:public Container {
 public:TilemapLayer(Tilemap* owner,bool upper,std::weak_ptr<int> lifetime):owner_(owner),upper_(upper),lifetime_(std::move(lifetime)){z=upper?4:0;}
 protected:void draw(Renderer& renderer,const Matrix& world,double opacity)override {
   if(lifetime_.expired())return;
   const auto origin=owner_->scrollOrigin();
   const auto scroll=multiply(world,{1,0,0,1,float(-origin.x),float(-origin.y)});
   owner_->queueGeometry(renderer,upper_,scroll,opacity);
 }
 private:Tilemap* owner_;bool upper_;std::weak_ptr<int> lifetime_;
};
}
Tilemap::Tilemap(){addChild(std::make_shared<TilemapLayer>(this,false,layerLifetime_));addChild(std::make_shared<TilemapLayer>(this,true,layerLifetime_));}
void Tilemap::setData(int w,int h,std::vector<int> values){mapWidth=w;mapHeight=h;data=std::move(values);refresh();}
void Tilemap::update(){++animationCount;animationFrame=animationCount/30;Container::update();for(auto* bitmap:bitmaps)if(bitmap)bitmap->touch();}
bool Tilemap::isReady()const{return std::all_of(bitmaps.begin(),bitmaps.end(),[](const auto* bitmap){return !bitmap||bitmap->isReady();});}
int Tilemap::readMapData(int x,int y,int z)const {
  if(mapWidth<=0||mapHeight<=0||z<0)return 0;
  if(horizontalWrap)x=(x%mapWidth+mapWidth)%mapWidth;if(verticalWrap)y=(y%mapHeight+mapHeight)%mapHeight;
  if(x<0||y<0||x>=mapWidth||y>=mapHeight)return 0;
  const auto index=(std::size_t(z)*mapHeight+y)*mapWidth+x;return index<data.size()?data[index]:0;
}
bool Tilemap::isHigherTile(int id)const{return id>=0&&id<int(flags.size())&&(flags[id]&16);}
bool Tilemap::isTableTile(int id)const{return isTileA2(id)&&id<int(flags.size())&&(flags[id]&128);}
bool Tilemap::isOverpassPosition(int,int)const{return false;}
void Tilemap::computeTileLayers(int x,int y,std::vector<int>& lower,std::vector<int>& upper)const {
  lower.clear();upper.clear();const int t0=readMapData(x,y,0),t1=readMapData(x,y,1),t2=readMapData(x,y,2),t3=readMapData(x,y,3),above=readMapData(x,y-1,1);
  (isHigherTile(t0)?upper:lower).push_back(t0);(isHigherTile(t1)?upper:lower).push_back(t1);
  lower.push_back(-readMapData(x,y,4));
  if(isTableTile(above)&&!isTableTile(t1)&&!isShadowingTile(t0))lower.push_back(10000+above);
  (isOverpassPosition(x,y)||isHigherTile(t2)?upper:lower).push_back(t2);(isOverpassPosition(x,y)||isHigherTile(t3)?upper:lower).push_back(t3);
}
std::vector<Tilemap::TileRectangle> Tilemap::tileRectangles(int tileId,int x,int y)const {
  std::vector<TileRectangle> result;const bool edge=tileId>=10000;int id=edge?tileId-10000:tileId;
  if(!isVisibleTile(id))return result;
  const auto add=[&](int sheet,double sx,double sy,double w,double h,double px,double py,Point animation={}){result.push_back({sheet,{sx,sy,w,h},{px,py},animation});};
  if(!isAutotile(id)) {
    const int sheet=isTileA5(id)?4:5+id/256;
    add(sheet,(id/128%2*8+id%8)*tileWidth,(id%256/8%16)*tileHeight,tileWidth,tileHeight,x,y);return result;
  }
  const int kind=getAutotileKind(id),shape=getAutotileShape(id),tx=kind%8,ty=kind/8;
  int sheet=0,bx=0,by=0;const std::array<std::array<int,2>,4>* table=nullptr;Point animation;
  if(isTileA1(id)) {
    if(kind<4){bx=kind<2?0:6;by=kind%2*3;if(kind<2)animation.x=tileWidth*2;}
    else {bx=tx/4*8;by=ty*6+tx/2%2*3;if(kind%2==0)animation.x=tileWidth*2;else{bx+=6;animation.y=tileHeight;}}
    if(kind>=4&&kind%2){if(shape<int(WATERFALL_AUTOTILE_TABLE.size()))table=&WATERFALL_AUTOTILE_TABLE[shape];}
    else if(shape<int(FLOOR_AUTOTILE_TABLE.size()))table=&FLOOR_AUTOTILE_TABLE[shape];
  } else if(isTileA2(id)){sheet=1;bx=tx*2;by=(ty-2)*3;if(shape<int(FLOOR_AUTOTILE_TABLE.size()))table=&FLOOR_AUTOTILE_TABLE[shape];}
  else if(isTileA3(id)){sheet=2;bx=tx*2;by=(ty-6)*2;if(shape<int(WALL_AUTOTILE_TABLE.size()))table=&WALL_AUTOTILE_TABLE[shape];}
  else {sheet=3;bx=tx*2;by=int(std::floor((ty-10)*2.5+(ty%2?.5:0)));if(ty%2){if(shape<int(WALL_AUTOTILE_TABLE.size()))table=&WALL_AUTOTILE_TABLE[shape];}else if(shape<int(FLOOR_AUTOTILE_TABLE.size()))table=&FLOOR_AUTOTILE_TABLE[shape];}
  if(!table)return result;const double w=tileWidth/2.0,h=tileHeight/2.0;
  if(edge){if(!isTileA2(id))return result;for(int i=0;i<2;++i)add(sheet,(bx*2+(*table)[i+2][0])*w,(by*2+(*table)[i+2][1])*h+h/2,w,h/2,x+i*w,y);return result;}
  for(int i=0;i<4;++i){const int qx=(*table)[i][0],qy=(*table)[i][1];const double sx=(bx*2+qx)*w,sy=(by*2+qy)*h,px=x+i%2*w,py=y+i/2*h;
    if(isTableTile(id)&&(qy==1||qy==5)){constexpr std::array<int,4> alternate{0,3,2,1};add(sheet,(bx*2+(qy==1?alternate[qx]:qx))*w,(by*2+3)*h,w,h,px,py);add(sheet,sx,sy,w,h/2,px,py+h/2);}
    else add(sheet,sx,sy,w,h,px,py,animation);
  }return result;
}
void Tilemap::appendTileGeometry(std::vector<TileLayerTile>& output,int id,int x,int y,const ImageResolver& images)const {
  for(const auto& tile:tileRectangles(id,x,y)){const auto image=images(tile.sheet);if(!image.handle)continue;
    output.push_back({image.handle,{float(tile.source.x),float(tile.source.y),float(tile.source.width),float(tile.source.height)},
      {float(tile.destination.x),float(tile.destination.y)},{float(tile.animation.x),float(tile.animation.y)}});
  }
}
void Tilemap::drawTile(PixelBitmap& bitmap,int id,int x,int y)const {
  constexpr std::array<int,4> water{0,1,2,1};
  for(const auto& tile:tileRectangles(id,x,y)){const auto* source=bitmaps[tile.sheet];if(!source)continue;
    bitmap.blt(*source,int(tile.source.x+tile.animation.x*water[animationFrame%4]),int(tile.source.y+tile.animation.y*(animationFrame%3)),int(tile.source.width),int(tile.source.height),int(tile.destination.x),int(tile.destination.y));}
}
bool Tilemap::isSameKindTile(int id1,int id2){return isAutotile(id1)&&isAutotile(id2)?getAutotileKind(id1)==getAutotileKind(id2):id1==id2;}
void Tilemap::drawNormalTile(PixelBitmap& bitmap,int id,int x,int y)const{if(!isAutotile(id))drawTile(bitmap,id,x,y);}
void Tilemap::drawAutotile(PixelBitmap& bitmap,int id,int x,int y)const{if(isAutotile(id))drawTile(bitmap,id,x,y);}
void Tilemap::drawTableEdge(PixelBitmap& bitmap,int id,int x,int y)const{if(isTileA2(id))drawTile(bitmap,10000+id,x,y);}
void Tilemap::drawShadow(PixelBitmap& bitmap,int bits,int x,int y)const{for(int i=0;i<4;++i)if(bits&(1<<i))bitmap.fillRect(x+i%2*tileWidth/2,y+i/2*tileHeight/2,tileWidth/2,tileHeight/2,"rgba(0,0,0,0.5)");}
Tilemap::~Tilemap(){layerLifetime_.reset();clearGeometry();}
void Tilemap::clearGeometry(){if(geometryRenderer_){for(const auto& part:lowerGeometry_)if(part.layer)geometryRenderer_->releaseTileLayer(part.layer);for(auto layer:upperGeometry_)geometryRenderer_->releaseTileLayer(layer);}lowerGeometry_.clear();upperGeometry_.clear();geometryReady_=false;geometryRenderer_=nullptr;}
void Tilemap::prepareGeometry(Renderer& renderer,int firstX,int firstY,int lastX,int lastY) {
  const std::array key{firstX,firstY,lastX,lastY};if(geometryReady_&&geometryRenderer_==&renderer&&geometryBounds_==key&&geometryRevision_==revision_)return;
  clearGeometry();geometryRenderer_=&renderer;std::vector<TileLayerTile> lower,upper;std::vector<int> lowIds,highIds;
  const auto images=[&](int sheet){if(imageResolver)return imageResolver(sheet);if(bitmaps[sheet])if(auto image=bitmaps[sheet]->texture())return *image;return ImageInfo{};};
  const auto flush=[&](std::vector<TileLayerTile>& tiles,bool high){if(tiles.empty())return;const auto layer=renderer.createTileLayer(std::move(tiles));tiles.clear();if(!layer)throw std::runtime_error("cannot create core tile geometry");try{if(high)upperGeometry_.push_back(layer);else lowerGeometry_.push_back({layer,0,0});}catch(...){renderer.releaseTileLayer(layer);throw;}};
  try {for(int y=firstY;y<lastY;++y)for(int x=firstX;x<lastX;++x){computeTileLayers(x,y,lowIds,highIds);
    for(int id:lowIds){if(id<0){flush(lower,false);for(int i=0;i<4;++i)if((-id)&(1<<i))lowerGeometry_.push_back({0,x*tileWidth+i%2*tileWidth/2,y*tileHeight+i/2*tileHeight/2});}else{if(lower.size()>65528)flush(lower,false);appendTileGeometry(lower,id,x*tileWidth,y*tileHeight,images);}}
    for(int id:highIds){if(upper.size()>65528)flush(upper,true);appendTileGeometry(upper,id,x*tileWidth,y*tileHeight,images);}}
    flush(lower,false);flush(upper,true);geometryBounds_=key;geometryRevision_=revision_;geometryReady_=true;
  }catch(...){clearGeometry();throw;}
}
void Tilemap::queueGeometry(Renderer& renderer,bool upper,const Matrix& world,double opacity)const {
  constexpr std::array<float,4> water{0,1,2,1};const std::array<float,2> animation{water[animationFrame%4],float(animationFrame%3)};
  const auto queue=[&](std::uint32_t layer){if(!renderer.queueTileLayer(layer,world,animation,float(opacity),0xffffff,BlendMode::normal,!smooth))throw std::runtime_error("cannot queue core tile geometry");};
  if(upper)for(auto layer:upperGeometry_)queue(layer);else for(const auto& part:lowerGeometry_)if(part.layer)queue(part.layer);else{const auto first=renderer.queuedCommandCount();renderer.queueQuad(part.x,part.y,tileWidth/2.0F,tileHeight/2.0F,{0,0,0,float(opacity*.5)});renderer.transformQueuedCommands(first,world);}
}
void Tilemap::render(Renderer& renderer,const Matrix& parentWorld,double opacity) {
  if(!visible||!renderable||alpha<=0||tileWidth<=0||tileHeight<=0)return;for(const auto* bitmap:bitmaps)if(bitmap&&!bitmap->isReady())return;
  const auto origin=scrollOrigin();const double ox=origin.x,oy=origin.y;
  prepareGeometry(renderer,int(std::floor((ox-margin)/double(tileWidth))),int(std::floor((oy-margin)/double(tileHeight))),int(std::ceil((ox+width+margin)/double(tileWidth))),int(std::ceil((oy+height+margin)/double(tileHeight))));
  const auto world=multiply(parentWorld,localTransform());
  auto& sorted=children;
  std::stable_sort(sorted.begin(),sorted.end(),[](const auto& left,const auto& right){if(left->z!=right->z)return left->z<right->z;if(left->position.y!=right->position.y)return left->position.y<right->position.y;return left->displayId<right->displayId;});
  const auto count=children.size();for(std::size_t i=0;i<count&&i<children.size();++i){auto child=children[i];if(child)child->render(renderer,world,opacity*alpha);}
}
}
