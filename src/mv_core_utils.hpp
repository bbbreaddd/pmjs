#pragma once

#include "mv_engine.hpp"
#include "mv_core_audio_graphics.hpp"
#include "mv_core_types.hpp"
#include "mv_core_display.hpp"

#include <array>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>
#include <memory>
#include <functional>
#include <optional>

namespace pmjs::mv {

// rpg_core.js Utils
class Utils : public core::Utils {
 public:
  static std::string escapeHtml(const std::string& str);
};

using ScreenSprite = core::ScreenSprite;
using ToneSprite = core::ToneSprite;
using WindowLayer = core::WindowLayer;

// rpg_sprites.js Spriteset_Base / Spriteset_Map / Spriteset_Battle
class Spriteset_Base {
 public:
  std::array<int, 4> tone{0, 0, 0, 0};
  ScreenSprite flashSprite;
  ScreenSprite fadeSprite;
  ToneSprite toneSprite;

  virtual ~Spriteset_Base() = default;
  virtual void update(const Session& session);
};

class Spriteset_Map : public Spriteset_Base {
 public:
  int parallaxZero = 0;
  double parallaxOx = 0.0;
  double parallaxOy = 0.0;
  std::vector<int> characterIds;

  void update(const Session& session) override;
};

class Spriteset_Battle : public Spriteset_Base {
 public:
  std::string battleback1Name;
  std::string battleback2Name;
  std::vector<int> enemySpriteIndices;
  std::vector<int> actorSpriteIndices;

  void update(const Session& session) override;
};

// rpg_managers.js DataManager / ConfigManager / StorageManager
class DataManager {
 public:
  static std::string globalId() { return "RPGMV"; }
  static int maxSavefiles() { return 20; }
  static bool isBattleTest(const Session& session);
  static bool isEventTest(const Session& session);
  static bool isSkill(const Value& item);
  static bool isItem(const Value& item);
  static bool isWeapon(const Value& item);
  static bool isArmor(const Value& item);
  static std::unordered_map<std::string, Value> extractMetadata(const std::string& note);
  static void extractMetadata(Value& data);
  static void onLoad(Value& object, bool isMap = false);
  static bool isThisGameFile(const Session& session, int savefileId, bool localMode = false);
  static bool isAnySavefileExists(const Session& session, bool localMode = false);
  static int latestSavefileId(const Session& session, bool localMode = false);
  static int lastAccessedSavefileId(const Session& session);
  static void selectSavefileForNewGame(Session& session, bool localMode = false);
  static Value makeSavefileInfo(const Session& session);
};

class ImageCache;
class RequestQueue;

class ImageManager {
 public:
  static std::string generateCacheKey(const std::string& path, int hue = 0);
  static bool isObjectCharacter(const std::string& filename);
  static bool isBigCharacter(const std::string& filename);
  static bool isZeroParallax(const std::string& filename);
  static std::string pathForFolder(const std::string& folder, const std::string& filename);
  static std::string animationPath(const std::string& filename) { return pathForFolder("img/animations/", filename); }
  static std::string battleback1Path(const std::string& filename) { return pathForFolder("img/battlebacks1/", filename); }
  static std::string battleback2Path(const std::string& filename) { return pathForFolder("img/battlebacks2/", filename); }
  static std::string enemyPath(const std::string& filename) { return pathForFolder("img/enemies/", filename); }
  static std::string characterPath(const std::string& filename) { return pathForFolder("img/characters/", filename); }
  static std::string facePath(const std::string& filename) { return pathForFolder("img/faces/", filename); }
  static std::string parallaxPath(const std::string& filename) { return pathForFolder("img/parallaxes/", filename); }
  static std::string picturePath(const std::string& filename) { return pathForFolder("img/pictures/", filename); }
  static std::string svActorPath(const std::string& filename) { return pathForFolder("img/sv_actors/", filename); }
  static std::string svEnemyPath(const std::string& filename) { return pathForFolder("img/sv_enemies/", filename); }
  static std::string systemPath(const std::string& filename) { return pathForFolder("img/system/", filename); }
  static std::string tilesetPath(const std::string& filename) { return pathForFolder("img/tilesets/", filename); }
  static std::string title1Path(const std::string& filename) { return pathForFolder("img/titles1/", filename); }
  static std::string title2Path(const std::string& filename) { return pathForFolder("img/titles2/", filename); }

  static ImageCache& imageCache();
  static RequestQueue& requestQueue();
  static std::uint64_t systemReservationId();
  static void setDefaultReservationId(std::uint64_t reservationId);
  static std::uint64_t defaultReservationId();
  static void reserve(const std::string& folder, const std::string& filename, int hue = 0, std::size_t pixelCount = 0, std::uint64_t reservationId = 0);
  static void request(const std::string& folder, const std::string& filename, int hue = 0, std::function<void()> startRequest = {}, std::function<bool()> isRequestReady = {});
  static void releaseReservation(std::uint64_t reservationId);
  static bool isReady();
  static void update();
  static void clear();
  static void clearRequest();

 private:
  static inline std::uint64_t defaultReservationId_ = 1;
};

class AudioManager {
 public:
  static Value makeEmptyAudioObject();
  static std::string audioFileExt();
  static bool shouldUseHtml5Audio();
  static int bgmVolume(const Session& session);
  static void setBgmVolume(Session& session, int value);
  static int bgsVolume(const Session& session);
  static void setBgsVolume(Session& session, int value);
  static int meVolume(const Session& session);
  static void setMeVolume(Session& session, int value);
  static int seVolume(const Session& session);
  static void setSeVolume(Session& session, int value);

  static bool isCurrentBgm(const Session& session, const Value& bgm);
  static void playBgm(Session& session, const Value& bgm);
  static void playBgm(Session& session, const Value& bgm, double pos);
  static void replayBgm(Session& session, const Value& bgm);
  static void updateBgmParameters(Session& session, const Value& bgm);
  static void stopBgm(Session& session);
  static void fadeOutBgm(Session& session, double durationSeconds);
  static void fadeInBgm(Session& session, double durationSeconds);

  static bool isCurrentBgs(const Session& session, const Value& bgs);
  static void playBgs(Session& session, const Value& bgs);
  static void playBgs(Session& session, const Value& bgs, double pos);
  static void replayBgs(Session& session, const Value& bgs);
  static void updateBgsParameters(Session& session, const Value& bgs);
  static void stopBgs(Session& session);
  static void fadeOutBgs(Session& session, double durationSeconds);
  static void fadeInBgs(Session& session, double durationSeconds);

  static void playMe(Session& session, const Value& me);
  static void updateMeParameters(Session& session, const Value& me);
  static void fadeOutMe(Session& session, double durationSeconds);
  static void stopMe(Session& session);

  static void playSe(Session& session, const Value& se);
  static void stopSe(Session& session);
  static void playStaticSe(Session& session, const Value& se);
  static void loadStaticSe(const Value& se);
  static bool isStaticSe(const Value& se);
  static void stopAll(Session& session);

  static Value saveBgm(const Session& session);
  static Value saveBgs(const Session& session);
};

class ConfigManager {
 public:
  bool alwaysDash = false;
  bool commandRemember = false;
  int bgmVolume = 100;
  int bgsVolume = 100;
  int meVolume = 100;
  int seVolume = 100;

  Value makeData() const;
  void applyData(const Value& config);
  static bool readFlag(const Value& config, const std::string& name);
  static int readVolume(const Value& config, const std::string& name);
  void applyToSession(Session& session) const;
  void readFromSession(const Session& session);
  static void load(Session& session, const Value& config);
  static Value save(const Session& session);
};

class StorageManager {
 public:
  static bool isLocalMode();
  static std::string localFileDirectoryPath(const std::string& baseDir);
  static std::string localFilePath(const std::string& baseDir, int savefileId);
  static std::string localFileBackupPath(const std::string& baseDir, int savefileId);
  static std::string webStorageKey(int savefileId);
  static bool localFileExists(const std::string& baseDir, int savefileId);
  static bool localFileBackupExists(const std::string& baseDir, int savefileId);
  static bool removeLocalFile(const std::string& baseDir, int savefileId);
};

// rpg_core.js Decrypter
class Decrypter {
 public:
  static constexpr std::size_t kHeaderLen = 16;
  static inline bool hasEncryptedImages = false;
  static inline bool hasEncryptedAudio = false;
  static inline std::array<std::uint8_t, 16> encryptionKey{};
  static inline std::vector<std::string> ignoreList = {
    "img/system/Window.png"
  };

  static bool checkImgIgnore(const std::string& url);
  static bool hasEncryptedHeader(const std::vector<std::uint8_t>& data);
  static std::vector<std::uint8_t> cutArrayHeader(const std::vector<std::uint8_t>& data, std::size_t length);
  static std::vector<std::uint8_t> decryptArrayBuffer(const std::vector<std::uint8_t>& data, const std::array<std::uint8_t, 16>& key);
  static std::vector<std::uint8_t> decryptArrayBuffer(const std::vector<std::uint8_t>& data, const std::string& hexKey);
  static std::vector<std::uint8_t> decryptArrayBuffer(const std::vector<std::uint8_t>& data);
  static std::string extToEncryptExt(const std::string& url);
  static void readEncryptionkey(const Value& systemJson);
};

// rpg_core.js JsonEx
struct JsonNode {
  using Ptr = std::shared_ptr<JsonNode>;
  using Array = std::vector<Ptr>;
  using Object = std::map<std::string, Ptr>;
  std::variant<std::monostate, bool, double, std::string, Array, Object, Value::Undefined> data;
  std::string constructorName;
};
struct JsonGraph {
  JsonNode::Ptr root;
  explicit JsonGraph(JsonNode::Ptr value) : root(std::move(value)) {}
  JsonGraph(const JsonGraph&) = delete;
  JsonGraph& operator=(const JsonGraph&) = delete;
  JsonGraph(JsonGraph&&) noexcept = default;
  ~JsonGraph();
};
class JsonEx {
 public:
  static constexpr int kMaxDepth = 100;
  static std::string stringify(const Value& value);
  static std::optional<std::string> stringifyOptional(const Value& value);
  static Value parse(const std::string& json);
  static Value makeDeepCopy(const Value& value);
  static void cleanMetadata(Value& value);
  static JsonNode::Ptr parseGraph(const std::string& json);
  static std::string stringifyGraph(const JsonNode::Ptr& value);
  static std::optional<std::string> stringifyGraphOptional(const JsonNode::Ptr& value);
  static void destroyGraph(JsonNode::Ptr& value);
  static JsonNode::Ptr fromValue(const Value& value);
  static Value toValue(const JsonNode::Ptr& value);
};

class CacheMap;
class CacheEntry : public std::enable_shared_from_this<CacheEntry> {
 public:
  CacheMap* cache = nullptr;
  std::string key;
  std::size_t itemId = 0;
  bool cached = false;
  std::uint64_t touchTicks = 0;
  double touchSeconds = 0;
  std::uint64_t ttlTicks = 0;
  double ttlSeconds = 0;
  bool freedByTTL = false;
  void free(bool byTTL = false);
  void allocate();
  void setTimeToLive(std::uint64_t ticks, double seconds);
  bool isStillAlive(std::uint64_t currentTicks, double currentSeconds) const;
  bool isStillAlive() const;
  void touch(std::uint64_t currentTicks, double currentSeconds);
  void touch();
};
class CacheMap {
 public:
  std::unordered_map<std::string,std::shared_ptr<CacheEntry>> entries;
  std::uint64_t updateTicks = 0;
  double updateSeconds = 0, lastCheckTTL = 0, delayCheckTTL = 100;
  CacheMap();
  void checkTTL();
  CacheEntry* getItem(const std::string& key);
  std::shared_ptr<CacheEntry> setItem(const std::string& key, std::size_t itemId, std::uint64_t ttlTicks = 0, double ttlSeconds = 0);
  void update(std::uint64_t tickIncrement, double deltaSeconds);
  void clear();
};
class ImageCache {
 public:
  static constexpr std::size_t kLimit = 10 * 1000 * 1000;
  struct Entry {
    std::string key;
    std::size_t pixelCount = 0;
    std::uint64_t touch = 0, order = 0;
    std::optional<std::uint64_t> reservationId;
    bool ready = true, error = false, requestOnly = false;
    std::function<void()> release;
  };
  std::unordered_map<std::string,Entry> items;
  std::uint64_t counter = 0;
  std::size_t limit = kLimit;
  std::function<std::uint64_t()> clock;
  ImageCache();
  void add(const std::string& key, std::size_t pixelCount, std::function<void()> release = {});
  Entry* get(const std::string& key);
  void reserve(const std::string& key, std::size_t pixelCount, std::uint64_t reservationId);
  void releaseReservation(std::uint64_t reservationId);
  bool mustBeHeld(const Entry& item) const;
  bool isReady() const;
  Entry* getErrorBitmap();
  void truncateCache();
  void clear();
};
class RequestQueue {
 public:
  struct Request {
    std::string key;
    bool started = false, completed = false;
    std::function<void()> startRequest;
    std::function<bool()> isRequestReady;
  };
  std::vector<Request> queue;
  void enqueue(const std::string& key, std::function<void()> startRequest = {}, std::function<bool()> isRequestReady = {});
  void update();
  void raisePriority(const std::string& key);
  void clear();
};
class ResourceHandler {
 public:
  static ResourceHandler& shared();
  using Callback = std::function<void()>;
  struct LoaderEntry {
    std::string url;
    std::size_t retryCount = 0;
    std::vector<int> retryInterval{500,1000,3000};
    Callback retryMethod, resignMethod;
  };
  std::vector<Callback> reloaders;
  Callback stop, resume;
  std::function<void(const std::string&)> printLoadingError;
  Callback eraseLoadingError;
  bool exists() const { return !reloaders.empty(); }
  Callback createLoader(const std::string& url, Callback retryMethod = {}, Callback resignMethod = {}, std::vector<int> retryInterval = {500,1000,3000});
  void update(double milliseconds);
  void retry();
  void clear();
 private:
  double time_ = 0;
  struct Scheduled { double time; Callback callback; };
  std::vector<Scheduled> scheduled_;
};

using Bitmap = core::PixelBitmap;
using TilingSprite = core::TilingSprite;
using ToneFilter = core::ToneFilter;
using Stage = core::Stage;
namespace core { class Tilemap; class ShaderTilemap; }
using Tilemap = core::Tilemap;
using ShaderTilemap = core::ShaderTilemap;

// rpg_objects.js Game_Temp / Game_Item / Game_Timer / Game_SelfSwitches
class Game_Temp {
 public:
  bool isPlaytest = false;
  int commonEventId = 0;
  int destinationX = -1;
  int destinationY = -1;

  void setDestination(int x, int y) { destinationX = x; destinationY = y; }
  void clearDestination() { destinationX = -1; destinationY = -1; }
  bool isDestinationValid() const { return destinationX >= 0 && destinationY >= 0; }
};

class Game_Item {
 public:
  std::string dataClass; // "skill", "item", "weapon", "armor"
  int itemId = 0;

  bool isSkill() const { return dataClass == "skill"; }
  bool isItem() const { return dataClass == "item"; }
  bool isWeapon() const { return dataClass == "weapon"; }
  bool isArmor() const { return dataClass == "armor"; }
  bool isNull() const { return dataClass.empty() || itemId <= 0; }
  void setEquip(bool isWeaponFlag, int id);
};

class Game_Timer {
 public:
  int frames = 0;
  bool working = false;

  void start(int count) { frames = count; working = true; }
  void stop() { working = false; }
  void update() { if (working && frames > 0) --frames; }
  int seconds() const { return frames / 60; }
};

class Game_SelfSwitches {
 public:
  std::unordered_map<std::string, bool> data;
  bool value(int mapId, int eventId, const std::string& ch) const;
  void setValue(int mapId, int eventId, const std::string& ch, bool val);
  void clear() { data.clear(); }
};

}  // namespace pmjs::mv

