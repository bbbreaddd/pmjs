#pragma once
#include "mv_engine.hpp"
#include "mv_core_display.hpp"
#include "runtime_core.hpp"
#include <functional>
#include "media_decoder.hpp"
#include <tuple>

namespace pmjs::mv {
class ImageCache;
class Presentation {
 public:
  Presentation(RuntimeCore& core, Session& session, Value settings);
  ~Presentation();
  void render();
  void captureAudioState();
 private:
  ImageInfo image(const std::string& file, int hue = 0);
  void quad(ImageHandle handle, float sx, float sy, float sw, float sh, float x, float y, float width, float height, float alpha = 1);
  void tile(int id, int x, int y, std::vector<TileLayerTile>& geometry);
  void clearMapGeometry();
  void prepareMapGeometry(int firstX, int firstY, int lastX, int lastY);
  void queueMapGeometry(bool upper, int originX, int originY);
  core::Tilemap stockTilemap_;
  int stockTileset_ = -1;
  std::uint64_t stockMapRevision_ = 0;
  void character(const Character& value, double cameraX, double cameraY);
  double scrolledMapX(double x, double cameraX, int tileWidth) const;
  double scrolledMapY(double y, double cameraY, int tileHeight) const;
  void map();
  void mapParallax(int tileWidth, int tileHeight);
  void mapDestination();
  void mapShadow();
  void mapName();
  void clearMapOverlays();
  CanvasHandle destinationCanvas_ = 0, mapNameCanvas_ = 0;
  std::string mapNameText_;
  std::uint64_t mapNameRevision_ = 0, mapNameTick_ = 0, destinationTick_ = 0;
  int mapNameShowCount_ = 0, mapNameOpacity_ = 0, destinationAge_ = 0;
  void tiledMap(const Value& data);
  void clearTiledGeometry();
  using TiledChunkKey = std::tuple<std::size_t, int, int>;
  struct TiledAnimation {
    TileLayerTile tile;
    std::vector<std::pair<int, double>> frames;
    double duration = 0;
    int columns = 0, frame = -1, nextFrame = -1;
  };
  struct TiledChunk {
    std::uint32_t stationary = 0, animated = 0;
    std::vector<TiledAnimation> animations;
    std::uint64_t lastUse = 0;
  };
  struct TiledDraw {
    TiledChunkKey key;
    int z = 0, y = 0, priority = 0;
    std::size_t order = 0;
    float alpha = 1;
    bool sorted = false;
  };
  TiledChunk& tiledChunk(const Value& data, const TiledDraw& draw);
  void updateTiledAnimation(TiledChunk& chunk, int tileWidth, int tileHeight, double age);
  const Value* tiledGeometryData_ = nullptr;
  std::map<TiledChunkKey, TiledChunk> tiledChunks_;
  std::vector<std::array<int, 4>> tiledBounds_, tiledNextBounds_;
  std::vector<TiledDraw> tiledDraws_;
  std::uint64_t tiledUse_ = 0, tiledGeometryRevision_ = 0;
  void mapPictures();
  void mapAmbience();
  void hitTarget(int x, int y, int width, int height, int index, int action = 0);
  void window(int x, int y, int width, int height, int selected = -1, int rows = 0, int openness = 255);
  void textEx(const std::string& value, int x, int y, int width = 0, int size = 28, bool prepared = false);
  void text(const std::string& value, int x, int y, int width = 0, int color = 0, int size = 28, bool right = false, float opacity = 1);
  void face(int actorId, int x, int y);
  void gauge(const Battler& actor, int stat, int x, int y, int width);
  void actorStatus(int actorId, int x, int y, int width, bool portrait);
  void message();
  void menu();
  enum class BattleWindow { commands, status, log, selection };
  struct RetainedContents {
    CanvasHandle canvas = 0;
    std::vector<std::string> key;
    bool valid = false, visible = false;
  };
  void retainBattleContents(BattleWindow part, std::vector<std::string> key, const std::function<void()>& draw);
  void clearBattleContents();
  void battle();
  void screenTone();
  void finishScreen(std::size_t first);
  void weather();
  std::unique_ptr<core::Weather> coreWeather_;
  void battleEffects();
  void battleSprites();
  std::vector<int> battlerIcons(const Battler& actor) const;
  void stateIcons(const Battler& actor, float x, float y, int width);
  struct BattlerDisplay { bool initialized = false, hidden = false, escaped = false, collapseSoundPlayed = false; int hp = 0; std::uint64_t death = 0, appeared = 0, disappeared = 0, lastBossSound = 0; };
  std::map<std::pair<bool,int>,BattlerDisplay> battlerDisplays_;
  void visualEffects();
  void animationCells(const Value& animation,int frame,float x,float y,bool mirror);
  void processAudio();
  void movie();
  void clearMovie();
  std::unique_ptr<VideoDecoderSession> movieDecoder_;
  std::string movieFile_;
  std::uint64_t movieStarted_ = 0;
  ImageHandle movieImage_ = 0;
  std::uint32_t movieAudio_ = 0;
  Value audioState(const std::string& kind);
  RuntimeCore& core_;
  Session& session_;
  Value settings_;
  CanvasHandle textCanvas_ = 0, timerCanvas_ = 0;
  std::array<RetainedContents, 4> battleContents_;
  std::map<std::string, ImageInfo> images_;
  std::unique_ptr<ImageCache> imageCache_;
  std::vector<ImageHandle> deferredImageReleases_;
  std::map<std::tuple<int,int,int,int>, std::shared_ptr<core::Window>> coreWindows_;
  std::shared_ptr<core::PixelBitmap> coreWindowskin_;
  std::vector<std::filesystem::path> fonts_;
  std::array<std::uint32_t, 32> colors_{};
  std::map<std::string, std::pair<std::string, std::uint32_t>> audio_;
  std::map<std::string, Value> audioSettings_;
  std::uint32_t musicEffect_ = 0;
  int lastScene_ = -1, lastMap_ = -1;
  std::uint64_t lastPresentationRevision_ = 0;
  std::vector<std::uint32_t> sounds_;
  double cameraX_ = 0, cameraY_ = 0;
  double sceneTickOrigin_ = 0;
};
}
