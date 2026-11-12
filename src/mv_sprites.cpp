#include "mv_sprites.hpp"

#include <cmath>
#include <iomanip>
#include <sstream>
#include <algorithm>

namespace pmjs::mv {

namespace {
bool hasBigCharacterSign(const std::string& name) {
  for (char c : name) {
    if (c == '$') return true;
    if (c != '!') break;
  }
  return false;
}
}  // namespace

void Sprite_Character::setCharacter(const Character* c) {
  character = c;
  if (c) {
    characterName = c->characterName;
    characterIndex = c->characterIndex;
    isBigCharacter = hasBigCharacterSign(characterName);
  }
}

void Sprite_Character::update() {
  if (!character) return;
  characterName = character->characterName;
  characterIndex = character->characterIndex;
  direction = character->direction;
  pattern = character->pattern;
  bushDepth = character->bushDepth;
  opacity = character->opacity / 255.0f;
  blendMode = character->blendMode;
  visible = !character->transparent;
  isBigCharacter = hasBigCharacterSign(characterName);
}

Rect Sprite_Character::frameRect(int frameWidth, int frameHeight) const {
  const int px = characterPatternX();
  const int py = characterPatternY();
  const int col = isBigCharacter ? px : (characterIndex % 4) * 3 + px;
  const int row = isBigCharacter ? py : (characterIndex / 4) * 4 + py;
  return {col * frameWidth, row * frameHeight, frameWidth, std::max(0, frameHeight - bushDepth)};
}

Rect Sprite_Character::tilesetTileFrame(int tileId) {
  const int sx = (((tileId / 128) % 2) * 8 + (tileId % 8)) * 48;
  const int sy = (((tileId % 256) / 8) % 16) * 48;
  return {sx, sy, 48, 48};
}

void Sprite_Damage::setup(const ActionResult& result) {
  isCritical = result.critical;
  isMiss = result.missed || result.evaded;
  duration = 90;
  vx = 0.0f;
  vy = -5.0f;
  flashDuration = isCritical ? 60 : 0;
  flashColor = isCritical ? std::array<int, 4>{255, 0, 0, 160} : std::array<int, 4>{0, 0, 0, 0};

  if (isMiss) {
    value = 0;
  } else if (result.hpAffected) {
    isHp = true;
    value = result.hpDamage;
  } else if (result.mpDamage != 0) {
    isHp = false;
    value = result.mpDamage;
  }
}

Color Sprite_Damage::damageColor() const {
  if (isHp) {
    return value >= 0 ? Color{255, 255, 255, 255} : Color{176, 255, 176, 255};
  }
  return value >= 0 ? Color{255, 176, 255, 255} : Color{176, 176, 255, 255};
}

void Sprite_Damage::update() {
  if (duration <= 0) return;
  --duration;
  position.x += vx;
  position.y += vy;
  vy += 0.4f; // Gravity
  if (position.y >= 0.0f && vy > 0.0f) {
    position.y = 0.0f;
    vy = -vy * 0.4f; // Bounce dampening
  }
  if (duration < 30) {
    opacity = duration / 30.0f;
  }
  if (flashDuration > 0) {
    --flashDuration;
    flashColor[3] = std::max(0, 160 * flashDuration / 60);
  }
}

void Sprite_Battler::setBattler(const Battler* b) {
  battler = b;
}

void Sprite_Battler::setHome(float hx, float hy) {
  homePosition = {hx, hy};
  position = {homePosition.x + offset.x, homePosition.y + offset.y};
}

void Sprite_Battler::startMove(float tx, float ty, int duration) {
  if (targetOffset.x != tx || targetOffset.y != ty) {
    targetOffset = {tx, ty};
    movementDuration = std::max(0, duration);
    if (movementDuration == 0) {
      offset = targetOffset;
      position = {homePosition.x + offset.x, homePosition.y + offset.y};
    }
  }
}

void Sprite_Battler::updateMove() {
  if (movementDuration > 0) {
    const int d = movementDuration;
    offset.x = (offset.x * (d - 1) + targetOffset.x) / d;
    offset.y = (offset.y * (d - 1) + targetOffset.y) / d;
    --movementDuration;
  }
  position = {homePosition.x + offset.x, homePosition.y + offset.y};
}

void Sprite_Battler::startMotion(BattlerMotion m) {
  if (motion != m) {
    motion = m;
    motionCount = 0;
    pattern = 0;
  }
}

void Sprite_Battler::setupDamagePopup() {
  if (!battler) return;
  if (battler->result.hpAffected || battler->result.mpDamage != 0 ||
      battler->result.missed || battler->result.evaded) {
    Sprite_Damage popup;
    popup.setup(battler->result);
    popup.position = position;
    popup.position.y -= 40.0f;
    damagePopups.push_back(popup);
  }
}

void Sprite_Battler::update() {
  updateMove();

  for (auto it = damagePopups.begin(); it != damagePopups.end();) {
    it->update();
    if (!it->isPlaying()) {
      it = damagePopups.erase(it);
    } else {
      ++it;
    }
  }
}

void Sprite_Actor::setActorHome(int index) {
  setHome(600.0f + index * 32.0f, 280.0f + index * 48.0f);
}

void Sprite_Actor::stepForward() { startMove(-48.0f, 0.0f, 12); }
void Sprite_Actor::stepBack() { startMove(0.0f, 0.0f, 12); }
void Sprite_Actor::retreat() { startMove(300.0f, 0.0f, 30); }

bool Sprite_Actor::isMotionLooping(BattlerMotion m) {
  switch (m) {
    case BattlerMotion::walk:
    case BattlerMotion::wait:
    case BattlerMotion::chant:
    case BattlerMotion::guard:
    case BattlerMotion::dying:
    case BattlerMotion::abnormal:
    case BattlerMotion::sleep:
    case BattlerMotion::dead:
      return true;
    default:
      return false;
  }
}

void Sprite_Actor::refreshMotion() {
  if (!battler) return;
  if (battler->hp <= 0) startMotion(BattlerMotion::dead);
  else if (battler->guarding) startMotion(BattlerMotion::guard);
  else startMotion(BattlerMotion::wait);
}

void Sprite_Actor::update() {
  Sprite_Battler::update();
  if (battler) {
    if (battler->hp <= 0) startMotion(BattlerMotion::dead);
    else if (battler->guarding) startMotion(BattlerMotion::guard);
  }
  if (++motionCount >= 12) {
    if (isMotionLooping(motion)) {
      pattern = (pattern + 1) % 4;
    } else if (pattern < 2) {
      ++pattern;
    } else {
      refreshMotion();
    }
    motionCount = 0;
  }
}

void Sprite_Enemy::startEffect(const std::string& type) {
  effectType = type;
  if (type == "appear") {
    effectDuration = 16;
    appeared = true;
  } else if (type == "disappear") {
    effectDuration = 32;
    appeared = false;
  } else if (type == "whiten") {
    effectDuration = 16;
    opacity = 1.0f;
  } else if (type == "blink") {
    effectDuration = 20;
  } else if (type == "collapse") {
    effectDuration = 32;
    appeared = false;
  } else if (type == "bossCollapse") {
    effectDuration = 128;
    appeared = false;
  } else if (type == "instantCollapse") {
    effectDuration = 0;
    opacity = 0.0f;
    appeared = false;
  }
}

void Sprite_Enemy::startCollapse() { startEffect("collapse"); }
void Sprite_Enemy::startBossCollapse() { startEffect("bossCollapse"); }

void Sprite_Enemy::update() {
  Sprite_Battler::update();
  if (effectDuration > 0) {
    --effectDuration;
    if (effectType == "appear") {
      opacity = (16 - effectDuration) / 16.0f;
    } else if (effectType == "disappear") {
      opacity = effectDuration / 32.0f;
    } else if (effectType == "blink") {
      visible = (effectDuration % 10) >= 5;
    } else if (effectType == "collapse") {
      opacity = effectDuration / 32.0f;
    } else if (effectType == "bossCollapse") {
      opacity = effectDuration / 128.0f;
      position.x = homePosition.x + ((effectDuration % 2) * 2 - 1) * 4.0f;
    }
    if (effectDuration == 0) {
      visible = appeared;
      effectType.clear();
    }
  }
}

void Sprite_Balloon::setup(int id) {
  balloonId = id;
  duration = 76;
}

void Sprite_Balloon::update() {
  if (duration > 0) --duration;
}

int Sprite_Balloon::frameIndex() const {
  return std::clamp((76 - duration) / 8, 0, 7);
}

void Sprite_Timer::update(int frames) {
  totalSeconds = frames / 60;
  const int minutes = totalSeconds / 60;
  const int seconds = totalSeconds % 60;
  std::ostringstream ss;
  ss << std::setfill('0') << std::setw(2) << minutes << ":"
     << std::setfill('0') << std::setw(2) << seconds;
  text = ss.str();
}

void Sprite_Destination::update() {
  ++frameCount;
  opacity = (std::sin(frameCount * 0.1f) + 1.0f) * 0.5f;
}

void WeatherSystem::setWeather(std::string newType, int newPower) {
  type = std::move(newType);
  power = std::max(0, newPower);
  dimmerOpacity = power * 6;
  const std::size_t maxParticles = static_cast<std::size_t>(power * 10);
  particles.resize(maxParticles);
}

void WeatherSystem::update(int screenWidth, int screenHeight) {
  dimmerOpacity = power * 6;
  const std::size_t maxParticles = static_cast<std::size_t>(power * 10);
  if (particles.size() != maxParticles) {
    particles.resize(maxParticles);
  }
  if (type == "none" || power == 0) return;

  constexpr float kPi = 3.14159265358979323846f;
  for (auto& p : particles) {
    if (type == "rain") {
      p.rotation = kPi / 16.0f;
      p.ax -= 6.0f * std::sin(p.rotation);
      p.ay += 6.0f * std::cos(p.rotation);
      p.opacity -= 6;
    } else if (type == "storm") {
      p.rotation = kPi / 8.0f;
      p.ax -= 8.0f * std::sin(p.rotation);
      p.ay += 8.0f * std::cos(p.rotation);
      p.opacity -= 8;
    } else if (type == "snow") {
      p.rotation = kPi / 16.0f;
      p.ax -= 3.0f * std::sin(p.rotation);
      p.ay += 3.0f * std::cos(p.rotation);
      p.opacity -= 3;
    }

    if (p.opacity < 40) {
      p.ax = static_cast<float>(rand() % (screenWidth + 100) - 100) + originX;
      p.ay = static_cast<float>(rand() % (screenHeight + 200) - 200) + originY;
      p.opacity = 160 + (rand() % 60);
    }

    p.x = p.ax - originX;
    p.y = p.ay - originY;
  }
}

void Sprite_Animation::setup(const Value* anim, bool mirrorFlag, int delayFrames) {
  animation = anim;
  animationId = anim ? (*anim)["id"].integer() : 0;
  mirror = mirrorFlag;
  delay = std::max(0, delayFrames);
  rate = 4;
  flashDuration = 0;
  flashColor = {0, 0, 0, 0};
  duration = anim ? static_cast<int>((*anim)["frames"].array().size()) * rate : 0;
}

void Sprite_Animation::update() {
  if (delay > 0) {
    --delay;
    return;
  }
  if (duration > 0) {
    --duration;
  }
  if (flashDuration > 0) {
    --flashDuration;
  }
}

int Sprite_Animation::currentFrameIndex() const {
  if (!animation || duration <= 0) return -1;
  const int totalFrames = static_cast<int>((*animation)["frames"].array().size());
  return std::clamp(totalFrames - 1 - (duration - 1) / std::max(1, rate), 0, std::max(0, totalFrames - 1));
}

std::vector<AnimationTiming> Sprite_Animation::timingsAtFrame(int frameIndex) const {
  std::vector<AnimationTiming> result;
  if (!animation || frameIndex < 0) return result;
  for (const auto& entry : (*animation)["timings"].array()) {
    if (entry["frame"].integer() == frameIndex) {
      AnimationTiming timing;
      timing.frame = frameIndex;
      timing.flashScope = entry["flashScope"].integer();
      const auto& fc = entry["flashColor"].array();
      for (std::size_t i = 0; i < 4 && i < fc.size(); ++i) timing.flashColor[i] = fc[i].integer();
      timing.flashDuration = entry["flashDuration"].integer();
      if (!entry["se"].null()) timing.se = &entry["se"];
      result.push_back(timing);
    }
  }
  return result;
}

void Sprite_Button::setColdFrame(int x, int y, int w, int h) {
  coldFrame = {x, y, w, h};
}

void Sprite_Button::setHotFrame(int x, int y, int w, int h) {
  hotFrame = {x, y, w, h};
}

bool Sprite_Button::isButtonTouched(float touchX, float touchY) const {
  return visible && touchX >= position.x && touchY >= position.y &&
         touchX < position.x + coldFrame.width && touchY < position.y + coldFrame.height;
}

Sprite_Picture::Sprite_Picture(int id) : pictureId(id) {}

void Sprite_Picture::syncFromPicture(const Value& state) {
  pictureName = state["_name"].text();
  visible = !pictureName.empty();
  if (!visible) return;
  position.x = static_cast<float>(state["_x"].number());
  position.y = static_cast<float>(state["_y"].number());
  origin = state["_origin"].integer();
  anchor.x = origin == 0 ? 0.0f : 0.5f;
  anchor.y = origin == 0 ? 0.0f : 0.5f;
  scale.x = static_cast<float>(state["_scaleX"].number(100) / 100.0);
  scale.y = static_cast<float>(state["_scaleY"].number(100) / 100.0);
  opacity = static_cast<float>(state["_opacity"].number(255) / 255.0);
  blendMode = state["_blendMode"].integer();
  rotation = static_cast<float>(state["_angle"].number() * 3.14159265358979323846 / 180.0);
}

void Sprite_StateIcon::setup(const Battler* b) {
  battler = b;
}

void Sprite_StateIcon::update(const Session& session) {
  ++animationCount;
  if (animationCount >= 40) {
    animationCount = 0;
    if (!battler || battler->states.empty()) {
      iconIndex = 0;
      return;
    }
    std::vector<int> icons;
    for (int stateId : battler->states) {
      const int idx = session.database()["states"][stateId]["iconIndex"].integer();
      if (idx > 0) icons.push_back(idx);
    }
    if (icons.empty()) {
      iconIndex = 0;
    } else {
      animationIndex = (animationIndex + 1) % static_cast<int>(icons.size());
      iconIndex = icons[animationIndex];
    }
  }
}

void Sprite_StateOverlay::setup(const Battler* b) {
  battler = b;
}

void Sprite_StateOverlay::update(const Session& session) {
  ++animationCount;
  if (animationCount >= 8) {
    animationCount = 0;
    pattern = (pattern + 1) % 8;
  }
  overlayIndex = 0;
  if (!battler) return;
  int maxPriority = -1;
  for (int stateId : battler->states) {
    const auto& state = session.database()["states"][stateId];
    const int overlay = state["overlay"].integer();
    const int priority = state["priority"].integer();
    if (overlay > 0 && priority > maxPriority) {
      maxPriority = priority;
      overlayIndex = overlay;
    }
  }
}

void Sprite_Weapon::setup(int id) {
  weaponImageId = id;
  animationCount = 0;
  pattern = 0;
}

void Sprite_Weapon::update() {
  if (weaponImageId <= 0) return;
  ++animationCount;
  if (animationCount >= 6) {
    animationCount = 0;
    if (++pattern >= 3) {
      weaponImageId = 0;
      pattern = 0;
    }
  }
}

}  // namespace pmjs::mv

