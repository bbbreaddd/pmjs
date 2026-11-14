#pragma once

#include "mv_engine.hpp"
#include "mv_windows.hpp"
#include <string>
#include <vector>

namespace pmjs::mv {

struct PointF {
  float x = 0.0f, y = 0.0f;
};

class Sprite_Base {
 public:
  PointF position;
  PointF scale{1.0f, 1.0f};
  PointF anchor{0.0f, 0.0f};
  float rotation = 0.0f;
  float opacity = 1.0f;
  int blendMode = 0;
  bool visible = true;

  virtual ~Sprite_Base() = default;
  virtual void update() {}
};

class Sprite_Character : public Sprite_Base {
 public:
  const Character* character = nullptr;
  std::string characterName;
  int characterIndex = 0;
  int pattern = 1;
  int direction = 2;
  int bushDepth = 0;
  bool isBigCharacter = false;

  void setCharacter(const Character* c);
  void update() override;
  int characterPatternX() const { return pattern < 3 ? pattern : 1; }
  int characterPatternY() const { return (direction / 2) - 1; }
  Rect frameRect(int frameWidth, int frameHeight) const;
  static Rect tilesetTileFrame(int tileId);
  core::Rectangle sourceFrame(double imageWidth, double imageHeight, double tileWidth, double tileHeight) const;
 private:
  core::Rectangle characterFrame(double width, double height) const;
  static core::Rectangle tileFrame(int tileId, double width, double height);
};

enum class BattlerMotion {
  walk, wait, chant, guard, damage, evade,
  thrust, swing, missile, skill, spell, item,
  escape, victory, dying, abnormal, sleep, dead
};

class Sprite_Damage : public Sprite_Base {
 public:
  int value = 0;
  bool isHp = true;
  bool isCritical = false;
  bool isMiss = false;
  float vy = 0.0f;
  float vx = 0.0f;
  double digitY = -40;
  int duration = 90;
  int flashDuration = 0;
  std::array<double, 4> flashColor{0, 0, 0, 0};
  struct PopupDigit {
    core::Rectangle source;
    double x = 0, y = 0, opacity = 1;
    std::array<double, 4> blendColor{};
  };

  void setup(const ActionResult& result);
  static std::vector<PopupDigit> popup(const ActionResult& result, std::uint64_t age, double imageWidth, double imageHeight, bool targetAlive = true);
  Color damageColor() const;
  void update() override;
  bool isPlaying() const { return duration > 0; }
 private:
  static std::array<double, 2> trajectory(std::uint64_t age, std::size_t digit);
  static double popupOpacity(std::uint64_t age);
  static double criticalAlpha(std::uint64_t age);
};

class Sprite_Battler : public Sprite_Base {
 public:
  const Battler* battler = nullptr;
  PointF homePosition;
  PointF offset;
  PointF targetOffset;
  int movementDuration = 0;
  BattlerMotion motion = BattlerMotion::wait;
  int motionCount = 0;
  int pattern = 0;
  std::vector<Sprite_Damage> damagePopups;

  virtual ~Sprite_Battler() = default;
  void setBattler(const Battler* b);
  void setHome(float hx, float hy);
  void startMove(float tx, float ty, int duration);
  void updateMove();
  bool isMoving() const { return movementDuration > 0; }
  void startMotion(BattlerMotion m);
  void setupDamagePopup();
  void update() override;
};

class Sprite_Actor : public Sprite_Battler {
 public:
  int weaponImageId = 0;
  int stateIcon = 0;
  void setActorHome(int index);
  void stepForward();
  void stepBack();
  void retreat();
  static bool isMotionLooping(BattlerMotion m);
  void synchronizeMotion(BattlerMotion requested, std::uint64_t requestedAt, std::uint64_t tick, BattlerMotion fallback);
  core::Rectangle sourceFrame(double imageWidth, double imageHeight) const;
  int motionFrameColumn() const { return pattern == 3 ? 1 : pattern; }
  void refreshMotion();
  void update() override;
 private:
  bool motionInitialized_ = false;
  BattlerMotion requestedMotion_ = BattlerMotion::wait;
  std::uint64_t requestedAt_ = 0, motionStarted_ = 0, motionTick_ = 0;
};

class Sprite_Enemy : public Sprite_Battler {
 public:
  int effectDuration = 0;
  int bitmapHeight = 0;
  bool appeared = true;
  double shake = 0;
  std::array<double, 4> blendColor{};
  std::uint64_t bossCollapseSounds = 0;
  bool initialized = false;
  std::uint64_t lastUpdateTick = 0;
  std::string effectType; // "appear", "disappear", "whiten", "blink", "collapse", "bossCollapse", "instantCollapse"
  std::string requestedEffect;
  void startEffect(const std::string& type);
  void startCollapse();
  void startBossCollapse();
  void update() override;
  void advance(std::uint64_t ticks);
  bool isEffecting() const { return !effectType.empty(); }
};

class Sprite_Balloon : public Sprite_Base {
 public:
  static constexpr int durationFrames = 8 * 8 + 12;
  int balloonId = 0;
  int duration = 0;

  void setup(int id);
  void update() override;
  void advance(std::uint64_t ticks);
  static core::Rectangle sourceFrame(std::uint64_t age, int balloonId);
  int frameIndex() const;
  bool isPlaying() const { return duration > 0; }
};

class Sprite_Timer : public Sprite_Base {
 public:
  int totalSeconds = 0;
  std::string text;

  void update(int frames);
};

class Sprite_Destination : public Sprite_Base {
 public:
  int targetX = 0, targetY = 0;
  int frameCount = 0;

  Sprite_Destination();
  void update() override;
  void advance(std::uint64_t ticks);
  void reset() { frameCount = 0; visible = false; }
};

struct WeatherParticle {
  float x = 0.0f, y = 0.0f;
  float ax = 0.0f, ay = 0.0f;
  float rotation = 0.0f;
  int opacity = 0;
};

class WeatherSystem {
 public:
  std::string type = "none"; // "none", "rain", "storm", "snow"
  int power = 0;
  int dimmerOpacity = 0;
  float originX = 0.0f;
  float originY = 0.0f;
  std::vector<WeatherParticle> particles;

  void setWeather(std::string newType, int newPower);
  void update(int screenWidth, int screenHeight);
};

struct AnimationTiming {
  int frame = 0;
  int flashScope = 0; // 0: none, 1: target, 2: screen, 3: hide target
  std::array<float, 4> flashColor{0, 0, 0, 0};
  int flashDuration = 0;
  const Value* se = nullptr;
};

class Sprite_Animation : public Sprite_Base {
 public:
  struct Cell {
    std::string name;
    int hue = 0, blendMode = 0;
    core::Rectangle source;
    core::Matrix transform{};
    double opacity = 1;
  };
  int animationId = 0;
  bool mirror = false;
  int delay = 0;
  int rate = 4;
  int duration = 0;
  int maxTimingFrames = 0;
  int flashDuration = 0;
  std::array<float, 4> flashColor{0, 0, 0, 0};
  const Value* animation = nullptr;

  void setup(const Value* anim, bool mirrorFlag, int delayFrames);
  void update() override;
  int currentFrameIndex() const;
  std::vector<AnimationTiming> timingsAtFrame(int frameIndex) const;
  static int durationFor(const Value& animation, int rate = 4);
  static int frameAtAge(const Value& animation, std::uint64_t age, int delay = 0, int rate = 4);
  static std::vector<Cell> cells(const Value& animation, int frame, bool mirror);
  static std::vector<AnimationTiming> timings(const Value& animation, int frame, int rate = 4);
  static void updateFlash(std::array<float, 4>& color, int& remaining);
  bool isPlaying() const { return duration > 0; }
};

class Sprite_Button : public Sprite_Base {
 public:
  Rect coldFrame{0, 0, 0, 0};
  Rect hotFrame{0, 0, 0, 0};
  Rect frame;
  bool touching = false;
  bool pressed = false;

  void setColdFrame(int x, int y, int w, int h);
  void setHotFrame(int x, int y, int w, int h);
  void updateFrame();
  bool updateTouch(bool triggered, bool released, double touchX, double touchY, bool parentVisible = true);
  bool isButtonTouched(double touchX, double touchY) const;
 private:
  bool hasColdFrame_ = false, hasHotFrame_ = false;
};

class Sprite_Picture : public Sprite_Base {
 public:
  const std::uint64_t runtimeIdentity = nextRuntimeIdentity();
  std::optional<std::array<double, 4>> sourceFrame;
  int pictureId = 0;
  std::string pictureName;
  std::string bitmapName;
  std::shared_ptr<core::PixelBitmap> bitmap;
  int origin = 0;

  explicit Sprite_Picture(int id);
  void syncFromPicture(const Value& state);
};

class Sprite_StateIcon : public Sprite_Base {
 public:
  const Battler* battler = nullptr;
  int iconIndex = 0;
  int animationCount = 0;
  int animationIndex = 0;
  Rect frame;

  void setup(const Battler* b);
  void update(const Session& session);
  void advance(const Session& session, std::uint64_t ticks);
  static std::vector<int> allIcons(const Battler& battler, const Session& session);
};

class Sprite_StateOverlay : public Sprite_Base {
 public:
  const Battler* battler = nullptr;
  int overlayIndex = 0;
  int animationCount = 0;
  int pattern = 0;
  Rect frame;

  void setup(const Battler* b);
  void update(const Session& session);
  void advance(const Session& session, std::uint64_t ticks);
};

class Sprite_Weapon : public Sprite_Base {
 public:
  int weaponImageId = 0;
  int animationCount = 0;
  int pattern = 0;
  Rect frame;

  void setup(int id);
  void update() override;
  void advance(std::uint64_t ticks);
  int pageId() const { return weaponImageId > 0 ? (weaponImageId - 1) / 12 + 1 : 0; }
  bool isPlaying() const { return weaponImageId > 0; }
 private:
  void updateFrame();
};

}  // namespace pmjs::mv

