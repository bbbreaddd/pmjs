#include "mv_sprites.hpp"
#include "mv_core_utils.hpp"

#include <cmath>
#include <iomanip>
#include <sstream>
#include <algorithm>

namespace pmjs::mv {

void Sprite_Character::setCharacter(const Character* c) {
  character = c;
  update();
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
  isBigCharacter = ImageManager::isBigCharacter(characterName);
}

core::Rectangle Sprite_Character::characterFrame(double width, double height) const {
  const bool single = character && character->singleFrame;
  const double column = character && character->customFrameX >= 0 ? character->customFrameX : single ? 0 :
      (isBigCharacter ? 0 : characterIndex % 4 * 3) + characterPatternX();
  const double row = character && character->customFrameY >= 0 ? character->customFrameY : single ? 0 :
      (isBigCharacter ? 0 : characterIndex / 4 * 4) + characterPatternY();
  return {column * width, row * height, width, height};
}

core::Rectangle Sprite_Character::tileFrame(int tileId, double width, double height) {
  return {(tileId / 128 % 2 * 8 + tileId % 8) * width, (tileId % 256 / 8 % 16) * height, width, height};
}

core::Rectangle Sprite_Character::sourceFrame(double imageWidth, double imageHeight, double tileWidth, double tileHeight) const {
  if (character && character->tileId > 0) return tileFrame(character->tileId, tileWidth, tileHeight);
  const bool single = character && character->singleFrame;
  const double width = character && character->customFrameWidth > 0 ? character->customFrameWidth :
      single ? imageWidth : imageWidth / (isBigCharacter ? 3.0 : 12.0);
  const double height = character && character->customFrameHeight > 0 ? character->customFrameHeight :
      single ? imageHeight : imageHeight / (isBigCharacter ? 4.0 : 8.0);
  return characterFrame(width, height);
}

Rect Sprite_Character::frameRect(int frameWidth, int frameHeight) const {
  const auto frame = characterFrame(frameWidth, frameHeight);
  return {static_cast<int>(frame.x), static_cast<int>(frame.y), frameWidth, std::max(0, frameHeight - bushDepth)};
}

Rect Sprite_Character::tilesetTileFrame(int tileId) {
  const auto frame = tileFrame(tileId, 48, 48);
  return {static_cast<int>(frame.x), static_cast<int>(frame.y), 48, 48};
}

void Sprite_Damage::setup(const ActionResult& result) {
  isCritical = result.critical;
  isMiss = result.missed || result.evaded;
  duration = 90;
  vx = 0.0f;
  vy = 0.0f;
  digitY = -40;
  opacity = 1;
  value = 0;
  isHp = true;
  flashDuration = isCritical ? 60 : 0;
  flashColor = isCritical ? std::array<double, 4>{255, 0, 0, 160} : std::array<double, 4>{0, 0, 0, 0};

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
  const auto age = static_cast<std::uint64_t>(90 - duration);
  const auto firstDigit = trajectory(age, 0);
  digitY = core::round(firstDigit[0]);
  vy = static_cast<float>(firstDigit[1]);
  opacity = static_cast<float>(popupOpacity(age));
  if (isCritical) {
    flashDuration = static_cast<int>(60 - std::min<std::uint64_t>(60, age));
    flashColor[3] = criticalAlpha(age);
  }
}

std::array<double, 2> Sprite_Damage::trajectory(std::uint64_t age, std::size_t digit) {
  double y = -40, velocity = -static_cast<double>(digit);
  for (std::uint64_t tick = 0; tick < std::min<std::uint64_t>(90, age); ++tick) {
    velocity += 0.5;
    y += velocity;
    if (y >= 0) { y = 0; velocity *= -0.6; }
  }
  return {y, velocity};
}

double Sprite_Damage::popupOpacity(std::uint64_t age) {
  return age < 80 ? 1 : age < 90 ? (90 - age) / 10.0 : 0;
}

double Sprite_Damage::criticalAlpha(std::uint64_t age) {
  return age < 60 ? 160 * (60 - age) / 60.0 : 0;
}

std::vector<Sprite_Damage::PopupDigit> Sprite_Damage::popup(const ActionResult& result, std::uint64_t age, double imageWidth, double imageHeight, bool targetAlive) {
  if (age >= 90) return {};
  const bool miss = result.missed || result.evaded;
  if (!miss && !result.hpAffected && (!targetAlive || result.mpDamage == 0)) return {};
  const double width = imageWidth / 10, height = imageHeight / 5;
  const int amount = result.hpAffected ? result.hpDamage : result.mpDamage;
  const auto digits = std::to_string(std::abs(static_cast<std::int64_t>(amount)));
  const std::size_t count = miss ? 1 : digits.size();
  const int row = miss ? 4 : (result.hpAffected ? 0 : 2) + (amount < 0 ? 1 : 0);
  std::vector<PopupDigit> children;
  children.reserve(count);
  for (std::size_t digit = 0; digit < count; ++digit) {
    PopupDigit child;
    const double childWidth = miss ? width * 4 : width;
    child.source = {miss ? 0 : (digits[digit] - '0') * width, row * height, childWidth, height};
    child.x = miss ? -childWidth / 2 : (digit - (count - 1) / 2.0) * width - width / 2;
    child.y = core::round(trajectory(age, digit)[0]) - height;
    child.opacity = popupOpacity(age);
    if (result.critical && age > 0) child.blendColor = {1, 0, 0, criticalAlpha(age - 1) / 255};
    children.push_back(child);
  }
  return children;
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
    case BattlerMotion::escape:
    case BattlerMotion::victory:
    case BattlerMotion::dying:
    case BattlerMotion::abnormal:
    case BattlerMotion::sleep:
    case BattlerMotion::dead:
      return true;
    default:
      return false;
  }
}

void Sprite_Actor::synchronizeMotion(BattlerMotion requested, std::uint64_t requestedAt, std::uint64_t tick, BattlerMotion fallback) {
  if (!motionInitialized_ || tick < motionTick_ || requested != requestedMotion_ ||
      (requestedAt != requestedAt_ && motion != requested)) {
    motion = requested;
    motionStarted_ = isMotionLooping(requested) ? tick : std::min(requestedAt, tick);
    requestedMotion_ = requested;
    motionInitialized_ = true;
  }
  requestedAt_ = requestedAt;
  motionTick_ = tick;
  if (!isMotionLooping(motion) && tick - motionStarted_ >= 36) {
    motion = fallback;
    motionStarted_ += 36;
  }
  const auto age = tick - motionStarted_;
  const auto raw = age / 12;
  pattern = isMotionLooping(motion) ? static_cast<int>(raw % 4) : static_cast<int>(std::min<std::uint64_t>(2, raw));
  motionCount = static_cast<int>(age % 12);
}

core::Rectangle Sprite_Actor::sourceFrame(double imageWidth, double imageHeight) const {
  const double width = imageWidth / 9, height = imageHeight / 6;
  const int index = static_cast<int>(motion);
  return {(index / 6 * 3 + motionFrameColumn()) * width, (index % 6) * height, width, height};
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
  shake = 0;
  opacity = 1;
  blendMode = 0;
  blendColor = {};
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
    effectDuration = bitmapHeight;
    appeared = false;
  } else if (type == "instantCollapse") {
    effectDuration = 16;
    appeared = false;
  }
  if (effectDuration <= 0) { effectType.clear(); if (!appeared) opacity = 0; }
}

void Sprite_Enemy::startCollapse() { startEffect("collapse"); }
void Sprite_Enemy::startBossCollapse() { startEffect("bossCollapse"); }

void Sprite_Enemy::update() {
  Sprite_Battler::update();
  advance(1);
}

void Sprite_Enemy::advance(std::uint64_t ticks) {
  const int elapsed = static_cast<int>(std::min<std::uint64_t>(ticks, std::max(0, effectDuration)));
  if (!elapsed) return;
  const int previous = effectDuration;
  effectDuration -= elapsed;
  if (effectType == "appear") {
    opacity = std::clamp((16 - effectDuration) * 16 / 255.0F, 0.0F, 1.0F);
  } else if (effectType == "disappear") {
    opacity = std::clamp((256 - (32 - effectDuration) * 10) / 255.0F, 0.0F, 1.0F);
  } else if (effectType == "whiten") {
    blendColor = {1, 1, 1, std::clamp((128 - (16 - effectDuration) * 10) / 255.0, 0.0, 1.0)};
  } else if (effectType == "blink") {
    opacity = effectDuration % 10 < 5 ? 1 : 0;
  } else if (effectType == "collapse" || effectType == "bossCollapse") {
    blendMode = 1;
    opacity *= static_cast<float>(effectDuration) / previous;
    if (effectType == "bossCollapse") {
      shake = effectDuration % 2 * 4 - 2;
      blendColor = {1, 1, 1, 1 - opacity};
      for (int remaining = previous - 1; remaining >= effectDuration; --remaining)
        if (remaining % 20 == 19) ++bossCollapseSounds;
    } else blendColor = {1, 128.0 / 255, 128.0 / 255, 128.0 / 255};
  } else if (effectType == "instantCollapse") {
    opacity = 0;
  }
  if (effectDuration == 0) effectType.clear();
}

void Sprite_Balloon::setup(int id) {
  balloonId = id;
  duration = durationFrames;
}

void Sprite_Balloon::update() {
  advance(1);
}

void Sprite_Balloon::advance(std::uint64_t ticks) {
  duration -= static_cast<int>(std::min<std::uint64_t>(ticks, std::max(0, duration)));
}

int Sprite_Balloon::frameIndex() const {
  return 7 - std::max(static_cast<int>(std::floor((duration - 12) / 8.0)), 0);
}

core::Rectangle Sprite_Balloon::sourceFrame(std::uint64_t age, int balloonId) {
  if (age == 0 || age >= durationFrames) return {};
  Sprite_Balloon sprite;
  sprite.setup(balloonId);
  sprite.advance(age);
  return {sprite.frameIndex() * 48.0, (balloonId - 1) * 48.0, 48, 48};
}

void Sprite_Timer::update(int frames) {
  totalSeconds = frames / 60;
  const int minutes = totalSeconds / 60 % 60;
  const int seconds = totalSeconds % 60;
  std::ostringstream ss;
  ss << std::setfill('0') << std::setw(2) << minutes << ":"
     << std::setfill('0') << std::setw(2) << seconds;
  text = ss.str();
}

Sprite_Destination::Sprite_Destination() {
  anchor = {0.5F, 0.5F};
  blendMode = 1;
}

void Sprite_Destination::update() {
  advance(1);
}

void Sprite_Destination::advance(std::uint64_t ticks) {
  if (!ticks) return;
  frameCount = static_cast<int>((frameCount + ticks % 20) % 20);
  opacity = (20 - frameCount) * 6 / 255.0F;
  scale.x = scale.y = 1 + frameCount / 20.0F;
  visible = true;
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

int Sprite_Animation::durationFor(const Value& animation, int rate) {
  return static_cast<int>(animation["frames"].array().size()) * std::max(1, rate) + 1;
}

int Sprite_Animation::frameAtAge(const Value& animation, std::uint64_t age, int delay, int rate) {
  const auto wait = static_cast<std::uint64_t>(std::max(0, delay));
  if (age <= wait) return -1;
  age -= wait;
  if (age >= static_cast<std::uint64_t>(durationFor(animation, rate))) return -1;
  return static_cast<int>((age - 1) / std::max(1, rate));
}

void Sprite_Animation::setup(const Value* anim, bool mirrorFlag, int delayFrames) {
  animation = anim;
  animationId = anim ? (*anim)["id"].integer() : 0;
  mirror = mirrorFlag;
  delay = std::max(0, delayFrames);
  rate = 4;
  flashDuration = 0;
  flashColor = {};
  duration = anim ? durationFor(*anim, rate) : 0;
}

void Sprite_Animation::updateFlash(std::array<float, 4>& color, int& remaining) {
  if (remaining > 0) { color[3] *= static_cast<float>(remaining - 1) / remaining; --remaining; }
}

void Sprite_Animation::update() {
  if (duration > 0) {
    if (delay > 0) --delay;
    else {
      --duration;
      if (duration % std::max(1, rate) == 0) {
        for (const auto& timing : timingsAtFrame(currentFrameIndex())) if (timing.flashScope == 1) {
          flashColor = timing.flashColor;
          flashDuration = timing.flashDuration;
        }
      }
    }
  }
  updateFlash(flashColor, flashDuration);
}

int Sprite_Animation::currentFrameIndex() const {
  if (!animation) return -1;
  const int speed = std::max(1, rate);
  return static_cast<int>((*animation)["frames"].array().size()) - (duration + speed - 1) / speed;
}

std::vector<AnimationTiming> Sprite_Animation::timingsAtFrame(int frameIndex) const {
  return animation ? timings(*animation, frameIndex, rate) : std::vector<AnimationTiming>{};
}

std::vector<AnimationTiming> Sprite_Animation::timings(const Value& animation, int frame, int rate) {
  std::vector<AnimationTiming> result;
  if (frame < 0 || frame >= static_cast<int>(animation["frames"].array().size())) return result;
  for (const auto& entry : animation["timings"].array()) if (entry["frame"].integer() == frame) {
    AnimationTiming timing;
    timing.frame = frame;
    timing.flashScope = entry["flashScope"].integer();
    for (int component = 0; component < 4; ++component) timing.flashColor[component] = entry["flashColor"][component].number() / 255;
    timing.flashDuration = entry["flashDuration"].integer() * std::max(1, rate);
    if (!entry["se"].null()) timing.se = &entry["se"];
    result.push_back(timing);
  }
  return result;
}

std::vector<Sprite_Animation::Cell> Sprite_Animation::cells(const Value& animation, int frame, bool mirror) {
  std::vector<Cell> result;
  if (frame < 0 || frame >= static_cast<int>(animation["frames"].array().size())) return result;
  const auto& data = animation["frames"][frame].array();
  for (std::size_t index = 0; index < std::min<std::size_t>(16, data.size()); ++index) {
    const auto& entry = data[index];
    const int pattern = entry[0].integer(-1);
    if (pattern < 0) continue;
    Cell cell;
    cell.name = animation[pattern < 100 ? "animation1Name" : "animation2Name"].text();
    cell.hue = animation[pattern < 100 ? "animation1Hue" : "animation2Hue"].integer();
    cell.source = {pattern % 5 * 192.0, pattern % 100 / 5 * 192.0, 192, 192};
    const double angle = entry[4].number() * 3.14159265358979323846 / 180 * (mirror ? -1 : 1);
    const double sy = entry[3].number() / 100, sx = sy * (entry[5].boolean() != mirror ? -1 : 1);
    const double a = std::cos(angle) * sx, b = std::sin(angle) * sx, c = -std::sin(angle) * sy, d = std::cos(angle) * sy;
    const double x = entry[1].number() * (mirror ? -1 : 1), y = entry[2].number();
    cell.transform = {float(a), float(b), float(c), float(d), float(x - 96 * (a + c)), float(y - 96 * (b + d))};
    cell.opacity = core::clamp(entry[6].number(), 0, 255) / 255;
    cell.blendMode = entry[7].integer();
    result.push_back(std::move(cell));
  }
  return result;
}

void Sprite_Button::setColdFrame(int x, int y, int w, int h) {
  coldFrame = {x, y, w, h};
  hasColdFrame_ = true;
}

void Sprite_Button::setHotFrame(int x, int y, int w, int h) {
  hotFrame = {x, y, w, h};
  hasHotFrame_ = true;
}

void Sprite_Button::updateFrame() {
  if (touching ? hasHotFrame_ : hasColdFrame_) frame = touching ? hotFrame : coldFrame;
}

bool Sprite_Button::updateTouch(bool triggered, bool released, double touchX, double touchY, bool parentVisible) {
  updateFrame();
  bool clicked = false;
  if (visible && parentVisible) {
    if (triggered && isButtonTouched(touchX, touchY)) touching = true;
    if (touching && (released || !isButtonTouched(touchX, touchY))) {
      touching = false;
      clicked = released;
    }
  } else touching = false;
  pressed = touching;
  return clicked;
}

bool Sprite_Button::isButtonTouched(double touchX, double touchY) const {
  return visible && touchX >= position.x && touchY >= position.y &&
         touchX < position.x + frame.width && touchY < position.y + frame.height;
}

Sprite_Picture::Sprite_Picture(int id) : pictureId(id) {}

void Sprite_Picture::syncFromPicture(const Value& state) {
  pictureName = state["_name"].text();
  visible = !pictureName.empty();
  if (!visible) return;
  position.x = static_cast<float>(std::floor(state["_x"].number()));
  position.y = static_cast<float>(std::floor(state["_y"].number()));
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
  advance(session, 1);
}

std::vector<int> Sprite_StateIcon::allIcons(const Battler& value, const Session& session) {
  std::vector<int> icons;
  for (int stateId : value.states) {
    const int icon = session.database()["states"][stateId]["iconIndex"].integer();
    if (icon > 0) icons.push_back(icon);
  }
  for (std::size_t parameter = 0; parameter < value.buffs.size(); ++parameter) {
    const int level = value.buffs[parameter];
    if (level) icons.push_back((level > 0 ? 32 : 48) + (std::abs(level) - 1) * 8 + static_cast<int>(parameter));
  }
  return icons;
}

void Sprite_StateIcon::advance(const Session& session, std::uint64_t ticks) {
  const auto remainder = animationCount + ticks % 40;
  const auto changes = ticks / 40 + remainder / 40;
  animationCount = static_cast<int>(remainder % 40);
  if (!changes) return;
  const auto icons = battler && battler->hp > 0 && !battler->hidden ? allIcons(*battler, session) : std::vector<int>{};
  if (icons.empty()) {
    animationIndex = 0;
    iconIndex = 0;
  } else {
    // The first update increments before selecting, including after the list changes.
    if (animationIndex + 1 >= static_cast<int>(icons.size())) animationIndex = 0;
    else ++animationIndex;
    animationIndex = static_cast<int>((animationIndex + (changes - 1) % icons.size()) % icons.size());
    iconIndex = icons[animationIndex];
  }
  frame = {iconIndex % 16 * 32, iconIndex / 16 * 32, 32, 32};
}

void Sprite_StateOverlay::setup(const Battler* b) {
  battler = b;
}

void Sprite_StateOverlay::update(const Session& session) {
  advance(session, 1);
}

void Sprite_StateOverlay::advance(const Session& session, std::uint64_t ticks) {
  const auto remainder = animationCount + ticks % 8;
  const auto changes = ticks / 8 + remainder / 8;
  animationCount = static_cast<int>(remainder % 8);
  if (!changes) return;
  pattern = static_cast<int>((pattern + changes % 8) % 8);
  if (battler) overlayIndex = battler->states.empty() ? 0 : session.database()["states"][battler->states.front()]["overlay"].integer();
  frame = overlayIndex > 0 ? Rect{pattern * 96, (overlayIndex - 1) * 96, 96, 96} : Rect{};
}

void Sprite_Weapon::setup(int id) {
  weaponImageId = id;
  animationCount = 0;
  pattern = 0;
  updateFrame();
}

void Sprite_Weapon::update() {
  advance(1);
}

void Sprite_Weapon::advance(std::uint64_t ticks) {
  const auto remainder = animationCount + ticks % 12;
  const auto changes = ticks / 12 + remainder / 12;
  animationCount = static_cast<int>(remainder % 12);
  if (!changes) return;
  if (changes >= 3 || pattern >= 3 - static_cast<int>(changes)) {
    pattern = 3;
    weaponImageId = 0;
  } else pattern += static_cast<int>(changes);
  updateFrame();
}

void Sprite_Weapon::updateFrame() {
  if (weaponImageId <= 0) { frame = {}; return; }
  const int index = (weaponImageId - 1) % 12;
  frame = {(index / 6 * 3 + pattern) * 96, index % 6 * 64, 96, 64};
}

}  // namespace pmjs::mv

