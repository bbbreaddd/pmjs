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
  float vy = -5.0f;
  float vx = 0.0f;
  int duration = 90;
  int flashDuration = 0;
  std::array<int, 4> flashColor{0, 0, 0, 0};

  void setup(const ActionResult& result);
  Color damageColor() const;
  void update() override;
  bool isPlaying() const { return duration > 0; }
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
  int motionFrameColumn() const { return pattern == 3 ? 1 : pattern; }
  void refreshMotion();
  void update() override;
};

class Sprite_Enemy : public Sprite_Battler {
 public:
  int effectDuration = 0;
  bool appeared = true;
  std::string effectType; // "appear", "disappear", "whiten", "blink", "collapse", "bossCollapse", "instantCollapse"
  void startEffect(const std::string& type);
  void startCollapse();
  void startBossCollapse();
  void update() override;
};

class Sprite_Balloon : public Sprite_Base {
 public:
  int balloonId = 0;
  int duration = 76; // 8 frames * 8 speed + 12 wait

  void setup(int id);
  void update() override;
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

  void update() override;
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
  std::array<int, 4> flashColor{0, 0, 0, 0};
  int flashDuration = 0;
  const Value* se = nullptr;
};

class Sprite_Animation : public Sprite_Base {
 public:
  int animationId = 0;
  bool mirror = false;
  int delay = 0;
  int rate = 4;
  int duration = 0;
  int maxTimingFrames = 0;
  int flashDuration = 0;
  std::array<int, 4> flashColor{0, 0, 0, 0};
  const Value* animation = nullptr;

  void setup(const Value* anim, bool mirrorFlag, int delayFrames);
  void update() override;
  int currentFrameIndex() const;
  std::vector<AnimationTiming> timingsAtFrame(int frameIndex) const;
  bool isPlaying() const { return duration > 0 || delay > 0; }
};

class Sprite_Button : public Sprite_Base {
 public:
  Rect coldFrame{0, 0, 0, 0};
  Rect hotFrame{0, 0, 0, 0};
  bool touching = false;
  bool pressed = false;

  void setColdFrame(int x, int y, int w, int h);
  void setHotFrame(int x, int y, int w, int h);
  bool isButtonTouched(float touchX, float touchY) const;
};

class Sprite_Picture : public Sprite_Base {
 public:
  int pictureId = 0;
  std::string pictureName;
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

  void setup(const Battler* b);
  void update(const Session& session);
};

class Sprite_StateOverlay : public Sprite_Base {
 public:
  const Battler* battler = nullptr;
  int overlayIndex = 0;
  int animationCount = 0;
  int pattern = 0;

  void setup(const Battler* b);
  void update(const Session& session);
};

class Sprite_Weapon : public Sprite_Base {
 public:
  int weaponImageId = 0;
  int animationCount = 0;
  int pattern = 0;

  void setup(int id);
  void update() override;
  bool isPlaying() const { return weaponImageId > 0; }
};

}  // namespace pmjs::mv

