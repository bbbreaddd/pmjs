#pragma once
#include "mv_engine.hpp"
#include "mv_core_display.hpp"
#include "mv_sprites.hpp"
#include "runtime_core.hpp"
#include <cstdint>
#include <functional>
#include "media_decoder.hpp"
#include <tuple>
#include <variant>

namespace pmjs::mv {
class ImageCache;
class Window_Base;
class Presentation {
 public:
  Presentation(RuntimeCore& core, Session& session, Value settings);
  ~Presentation();
  void render();
  bool renderFrame(const std::function<void()>& drawFrame);
  void captureAudioState();
 private:
  void renderStage();
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
  CanvasHandle destinationCanvas_ = 0;
  std::uint64_t mapNameRevision_ = 0, mapNameTick_ = 0, destinationTick_ = 0;
  std::shared_ptr<Window_MapName> mapNameWindow_;
  std::shared_ptr<Window_NameEdit> nameEdit_;
  std::shared_ptr<Window_NameInput> nameGrid_;
  std::shared_ptr<core::PixelBitmap> nameFace_;
  std::string nameFaceFile_;
  int nameFaceIndex_ = -1, nameActor_ = -1;
  bool nameFaceReady_ = false;
  void clearNameContents();
  Sprite_Destination destinationSprite_;
  bool destinationStarted_ = false;
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
  void window(int x, int y, int width, int height, int selected = -1, int rows = 0, int openness = 255, std::shared_ptr<core::PixelBitmap> contents = {}, std::optional<core::Rectangle> cursor = {}, const Window_Base* model = nullptr);
  void flushUiText();
  void streamUiWindow(core::Window& window);
  void finishUiLayer();
  void clearUiContents();
  void goldWindow(int x, int y);
  std::shared_ptr<Window_Gold> goldWindow_;
  double textEx(const std::string& value, double x, double y, int width = 0, int size = 28, bool prepared = false, bool measureOnly = false);
  void text(const std::string& value, double x, double y, int width = 0, int color = 0, int size = 28, bool right = false, float opacity = 1);
  void face(int actorId, int x, int y, float opacity = 1);
  void menuStatus(const Rect& bounds, int topRow, int selected, bool active, bool all = false, bool fixed = false);
  void simpleActorStatus(int actorId, int x, int y, int width);
  void gauge(const Battler& actor, int stat, int x, int y, int width);
  void actorStatus(int actorId, int x, int y, int width, bool portrait);
  void message();
  void messageBody();
  void messageInputs();
  void menu();
  enum class BattleWindow { commands, status, log, selection };
  struct UiTextOp {
    std::string text;
    double x = 0;
    double y = 0;
    int size = 28;
    std::uint32_t fill = 0;
    bool operator==(const UiTextOp&) const = default;
  };
  struct UiGaugeOp {
    int x = 0;
    int y = 0;
    int width = 0;
    int height = 6;
    std::vector<std::uint8_t> pixels;
    bool operator==(const UiGaugeOp&) const = default;
  };
  using UiDrawOp = std::variant<UiTextOp, UiGaugeOp>;
  void drawUiOp(CanvasHandle canvas, int offsetX, int offsetY, const UiDrawOp& op);
  struct WindowTextSurface {
    CanvasHandle canvas = 0;
    int width = 0;
    int height = 0;
    std::vector<UiDrawOp> ops;
    bool valid = false;
    bool used = false;
  };
  struct RetainedContents {
    CanvasHandle canvas = 0;
    int x = 0;
    int y = 0;
    int width = 0;
    int height = 0;
    std::vector<std::string> key;
    bool valid = false;
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
  struct BattlerDisplay {
    Sprite_StateIcon stateIcon;
    std::uint64_t stateIconTick = 0;
    bool stateIconStarted = false;
    Sprite_StateOverlay stateOverlay;
    Sprite_Weapon weapon;
    std::uint64_t actorSpriteTick = 0, weaponStarted = 0;
    bool actorSpritesStarted = false;
    Sprite_Actor actorSprite;
  };
  std::map<std::pair<bool,int>,BattlerDisplay> battlerDisplays_;
  void visualEffects();
  void animationCells(const Value& animation,int frame,float x,float y,bool mirror);
  void processAudio();
  void movie();
  void clearMovie();
  std::unique_ptr<VideoDecoderSession> movieDecoder_;
  std::string movieFile_;
  std::uint64_t movieStarted_ = 0;
  std::uint64_t movieRequest_ = 0;
  ImageHandle movieImage_ = 0;
  std::uint32_t movieAudio_ = 0;
  Value audioState(const std::string& kind);
  RuntimeCore& core_;
  Session& session_;
  Value settings_;
  CanvasHandle textCanvas_ = 0, globalTextCanvas_ = 0, timerCanvas_ = 0;
  int textOffsetX_ = 0, textOffsetY_ = 0, textWidth_ = 0, textHeight_ = 0;
  core::WindowLayer uiLayer_;
  std::optional<core::WindowLayer::StreamState> uiLayerState_;
  std::optional<std::array<int,4>> uiTextClip_;
  bool uiTextDirty_ = false;
  std::size_t uiWindowOrdinal_ = 0;
  std::optional<std::size_t> uiPendingSlot_;
  std::vector<UiDrawOp> pendingUiOps_;
  using WindowKey = std::tuple<int,int,int,int,std::size_t>;
  std::map<std::size_t, WindowTextSurface> uiTextCanvases_;
  std::array<RetainedContents, 4> battleContents_;
  std::map<std::string, ImageInfo> images_;
  std::unique_ptr<ImageCache> imageCache_;
  std::vector<ImageHandle> deferredImageReleases_;
  std::map<WindowKey, std::shared_ptr<core::Window>> coreWindows_;
  std::shared_ptr<core::PixelBitmap> coreWindowskin_;
  std::vector<std::filesystem::path> fonts_;
  std::array<std::uint32_t, 32> colors_{};
  std::map<std::string, std::pair<std::string, std::unique_ptr<core::WebAudio>>> audio_;
  std::map<std::string, Value> audioSettings_;
  std::unique_ptr<core::WebAudio> musicEffect_;
  int lastScene_ = -1, lastMap_ = -1;
  std::uint64_t lastPresentationRevision_ = 0;
  std::vector<std::unique_ptr<core::WebAudio>> sounds_;
  double cameraX_ = 0, cameraY_ = 0;
  double sceneTickOrigin_ = 0;
};
}
