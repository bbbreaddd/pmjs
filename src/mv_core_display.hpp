#pragma once
#include "mv_core_audio_graphics.hpp"
#include "renderer.hpp"
#include <memory>

namespace pmjs::mv::core {
struct SpriteFrame {
  Rectangle requested, real;
  Point pivot;
};
SpriteFrame spriteFrame(const Rectangle& requested,double bitmapWidth,double bitmapHeight);

class Container {
 public:
  Point position, scale{1,1}, pivot, skew;
  double rotation=0,alpha=1;
  bool visible=true,renderable=true,interactive=false;
  Container* parent=nullptr;
  std::vector<std::shared_ptr<Container>> children;
  virtual ~Container();
  virtual void update();
  virtual void render(Renderer& renderer,const Matrix& world={1,0,0,1,0,0},double opacity=1);
  void addChild(std::shared_ptr<Container> child);
  void addChildAt(std::shared_ptr<Container> child,std::size_t index);
  std::shared_ptr<Container> removeChild(Container* child);
  void removeChildren();
  Matrix localTransform()const;
  void move(double x,double y){position={x,y};}
 protected:
  virtual void draw(Renderer&,const Matrix&,double){}
};
class Stage:public Container {};
class Tilemap : public Container {
 public:
  static constexpr int TILE_ID_B = 0;
  static constexpr int TILE_ID_C = 256;
  static constexpr int TILE_ID_D = 512;
  static constexpr int TILE_ID_E = 768;
  static constexpr int TILE_ID_A5 = 1536;
  static constexpr int TILE_ID_A1 = 2048;
  static constexpr int TILE_ID_A2 = 2816;
  static constexpr int TILE_ID_A3 = 4352;
  static constexpr int TILE_ID_A4 = 5888;
  static constexpr int TILE_ID_MAX = 8192;

  static const std::array<std::array<std::array<int, 2>, 4>, 48> FLOOR_AUTOTILE_TABLE;
  static const std::array<std::array<std::array<int, 2>, 4>, 16> WALL_AUTOTILE_TABLE;
  static const std::array<std::array<std::array<int, 2>, 4>, 4> WATERFALL_AUTOTILE_TABLE;

  int tileWidth = 48;
  int tileHeight = 48;
  int mapWidth = 0;
  int mapHeight = 0;
  Point origin;
  bool horizontalWrap = false;
  bool verticalWrap = false;
  int animationCount = 0;
  int animationFrame = 0;
  std::vector<int> data;
  std::vector<int> flags;
  std::array<const PixelBitmap*, 9> bitmaps{};

  void setData(int width, int height, std::vector<int> mapData);
  void update() override;
  void refresh(){++revision_;}
  using ImageResolver=std::function<ImageInfo(int)>;
  struct TileRectangle {int sheet=0; Rectangle source; Point destination,animation;};
  std::vector<TileRectangle> tileRectangles(int tileId,int x,int y) const;
  void appendTileGeometry(std::vector<TileLayerTile>& output,int tileId,int x,int y,const ImageResolver& images) const;
  void render(Renderer&,const Matrix& world={1,0,0,1,0,0},double opacity=1) override;
  int width=816,height=624,margin=20;
  std::uint64_t revision_=0;
  ImageResolver imageResolver;
  ~Tilemap() override;
  void clearGeometry();
  void prepareGeometry(Renderer& renderer,int firstX,int firstY,int lastX,int lastY);
  void queueGeometry(Renderer& renderer,bool upper,const Matrix& transform,double opacity=1) const;
 private:
  struct GeometryPart {std::uint32_t layer=0;int x=0,y=0;};
  std::vector<GeometryPart> lowerGeometry_;
  std::vector<std::uint32_t> upperGeometry_;
  std::array<int,4> geometryBounds_{};
  std::uint64_t geometryRevision_=0;
  Renderer* geometryRenderer_=nullptr;
  bool geometryReady_=false;
 public:
  int readMapData(int x, int y, int z) const;
  void computeTileLayers(int mx, int my, std::vector<int>& lowerTiles, std::vector<int>& upperTiles) const;
  void drawTile(PixelBitmap& bitmap, int tileId, int dx, int dy) const;
  void drawNormalTile(PixelBitmap& bitmap, int tileId, int dx, int dy) const;
  void drawAutotile(PixelBitmap& bitmap, int tileId, int dx, int dy) const;
  void drawTableEdge(PixelBitmap& bitmap, int tileId, int dx, int dy) const;
  void drawShadow(PixelBitmap& bitmap, int shadowBits, int dx, int dy) const;
  bool isHigherTile(int tileId) const;
  bool isTableTile(int tileId) const;
  bool isOverpassPosition(int mx, int my) const;

  static bool isVisibleTile(int tileId) { return tileId > 0 && tileId < TILE_ID_MAX; }
  static bool isAutotile(int tileId) { return tileId >= TILE_ID_A1; }
  static int getAutotileKind(int tileId) { return (tileId - TILE_ID_A1) / 48; }
  static int getAutotileShape(int tileId) { return (tileId - TILE_ID_A1) % 48; }
  static int makeAutotileId(int kind, int shape) { return TILE_ID_A1 + kind * 48 + shape; }
  static bool isSameKindTile(int id1, int id2);
  static bool isTileA1(int tileId) { return tileId >= TILE_ID_A1 && tileId < TILE_ID_A2; }
  static bool isTileA2(int tileId) { return tileId >= TILE_ID_A2 && tileId < TILE_ID_A3; }
  static bool isTileA3(int tileId) { return tileId >= TILE_ID_A3 && tileId < TILE_ID_A4; }
  static bool isTileA4(int tileId) { return tileId >= TILE_ID_A4 && tileId < TILE_ID_MAX; }
  static bool isTileA5(int tileId) { return tileId >= TILE_ID_A5 && tileId < TILE_ID_A1; }
  static bool isWaterTile(int tileId) { return isTileA1(tileId) && !(tileId >= TILE_ID_A1 + 96 && tileId < TILE_ID_A1 + 192); }
  static bool isWaterfallTile(int tileId) { return tileId >= TILE_ID_A1 + 192 && tileId < TILE_ID_A2 && getAutotileKind(tileId) % 2 == 1; }
  static bool isGroundTile(int tileId) { return isTileA1(tileId) || isTileA2(tileId) || isTileA5(tileId); }
  static bool isShadowingTile(int tileId) { return isTileA3(tileId) || isTileA4(tileId); }
  static bool isRoofTile(int tileId) { return isTileA3(tileId) && getAutotileKind(tileId) % 16 < 8; }
  static bool isWallTopTile(int tileId) { return isTileA4(tileId) && getAutotileKind(tileId) % 16 < 8; }
  static bool isWallSideTile(int tileId) { return (isTileA3(tileId) || isTileA4(tileId)) && getAutotileKind(tileId) % 16 >= 8; }
  static bool isWallTile(int tileId) { return isWallTopTile(tileId) || isWallSideTile(tileId); }
  static bool isFloorTypeAutotile(int tileId) { return (isTileA1(tileId) && !isWaterfallTile(tileId)) || isTileA2(tileId) || isWallTopTile(tileId); }
  static bool isWallTypeAutotile(int tileId) { return isRoofTile(tileId) || isWallSideTile(tileId); }
  static bool isWaterfallTypeAutotile(int tileId) { return isWaterfallTile(tileId); }
};
class ShaderTilemap:public Tilemap {public:bool roundPixels=true;};
class Sprite:public Container {
 public:
  Sprite();
  std::uint64_t spriteId=0;
  Point anchor;
  bool opaque=false,isPicture=false;
  BlendMode blendMode=BlendMode::normal;
  void setBitmap(std::shared_ptr<PixelBitmap> bitmap);
  std::shared_ptr<PixelBitmap> bitmap()const{return bitmap_;}
  void setFrame(double x,double y,double width,double height);
  Rectangle frame()const{return frame_;}
  double width()const{return frame_.width;}
  double height()const{return frame_.height;}
  void setWidth(double width){frame_.width=width;}
  void setHeight(double height){frame_.height=height;}
  double opacity()const{return alpha*255;}
  void setOpacity(double value){alpha=std::clamp(value,0.0,255.0)/255;}
  void setBlendColor(std::array<double,4> value){blendColor_=value;}
  void setColorTone(std::array<double,4> value){colorTone_=value;}
  std::array<double,4> blendColor()const{return blendColor_;}
  std::array<double,4> colorTone()const{return colorTone_;}
  static bool queueFrame(Renderer&,const ImageInfo&,const Rectangle&,const Matrix&,double opacity=1,BlendMode blend=BlendMode::normal,
    Point anchor={},std::array<double,4> tone={},std::array<double,4> color={});
 protected:
  void draw(Renderer&,const Matrix&,double)override;
  std::shared_ptr<PixelBitmap> bitmap_;
  Rectangle frame_;
  bool refreshFrame_=true;
  std::array<double,4> colorTone_{},blendColor_{};
};
class TilingSprite:public Sprite {
 public:
  Point origin;
  double areaWidth=0,areaHeight=0;
  void move(double x,double y,double width,double height){position={x,y};areaWidth=width;areaHeight=height;}
 protected:
  void draw(Renderer&,const Matrix&,double)override;
};
class ScreenSprite:public Container {
 public:
  std::array<float,3> color{};
  void setColor(double r,double g,double b){color={float(std::clamp(r,0.0,255.0)/255),float(std::clamp(g,0.0,255.0)/255),float(std::clamp(b,0.0,255.0)/255)};}
  void setBlack(){setColor(0,0,0);} void setWhite(){setColor(255,255,255);}
  void setOpacity(double value){alpha=std::clamp(value,0.0,255.0)/255;}
  double opacity()const{return alpha*255;}
 protected:void draw(Renderer&,const Matrix&,double)override;
};
class ToneFilter {
 public:
  ToneFilter(){reset();}
  void reset();
  void adjustTone(double r,double g,double b);
  void adjustSaturation(double value);
  void adjustHue(double value);
  void adjustBrightness(double value);
  void adjustContrast(double value);
  void apply(Renderer& renderer)const{renderer.queueTone(matrix);}
  std::array<float,20> matrix{};
 private:void multiply(const std::array<float,20>& right);
};
class ToneSprite:public Container {
 public:
  void setTone(double r,double g,double b,double gray);
  void reset(){setTone(0,0,0,0);}
 protected:void draw(Renderer&,const Matrix&,double)override;
 private:std::array<double,4> tone_{};
};
class Window:public Container {
 public:
  std::shared_ptr<PixelBitmap> windowskin,contents;
  Point origin;
  Rectangle cursorRect;
  int width=0,height=0,padding=18,margin=4;
  double openness=255,opacity=255,backOpacity=192,contentsOpacity=255;
  std::array<double,3> tone{};
  bool active=true,downArrowVisible=false,upArrowVisible=false,pause=false;
  std::uint64_t animationCount=0;
  void update()override;
  void move(int x,int y,int w,int h){position={double(x),double(y)};width=w;height=h;}
  void setCursorRect(double x,double y,double w,double h){cursorRect={x,y,w,h};}
  void setTone(double r,double g,double b){tone={r,g,b};}
  bool isOpen()const{return openness>=255;} bool isClosed()const{return openness<=0;}
  Rectangle openBounds()const;
  double cursorAlpha()const;
  void render(Renderer&,const Matrix& world={1,0,0,1,0,0},double opacity=1)override;
 private:
  double pauseAlpha_=0;
  std::shared_ptr<PixelBitmap> back_;
  std::array<double,6> backKey_{};
  PixelBitmap* skinKey_=nullptr;
  void refreshBack();
};
class WindowLayer:public Container {
 public:
  double width=0,height=0;
  void move(double x,double y,double w,double h){position={x,y};width=w;height=h;}
  void render(Renderer&,const Matrix& world={1,0,0,1,0,0},double opacity=1)override;
};
}
