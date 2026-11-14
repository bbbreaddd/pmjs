'use strict';
// RPG Maker MV behavior: Copyright (c) 2015 KADOKAWA CORPORATION./YOJI OJIMA.
// MIT license: third_party/rpg-maker-mv.LICENSE.

function installBattlerSprites(scope) {
  const { Sprite_Battler, Sprite_Actor, Sprite_Enemy, Sprite_Base, Sprite, Sprite_Weapon, Sprite_StateOverlay, Sprite_StateIcon, ImageManager, Graphics } = scope;
  Sprite_Battler.prototype.initMembers = function() {
      this.anchor.x = 0.5;
      this.anchor.y = 1;
      this.setBattler(null);
      this._effectTarget = this;
      this._damages = [];
      this._homeX = 0;
      this._homeY = 0;
      this._offsetX = 0;
      this._offsetY = 0;
      this._targetOffsetX = NaN;
      this._targetOffsetY = NaN;
      this._movementDuration = 0;
      this._selectionEffectCount = 0;
  };

  Sprite_Battler.prototype.updateBitmap = function() {
  };

  Sprite_Battler.prototype.updateFrame = function() {
  };

  Sprite_Battler.prototype.onMoveEnd = function() {
  };

  Sprite_Battler.prototype.updateSelectionEffect = function() {
      var target = this._effectTarget || this;
      if (this._battler.isSelected()) {
          this._selectionEffectCount++;
          if (this._selectionEffectCount % 30 < 15) {
              target.setBlendColor([255, 255, 255, 64]);
          } else {
              target.setBlendColor([0, 0, 0, 0]);
          }
      } else if (this._selectionEffectCount > 0) {
          this._selectionEffectCount = 0;
          target.setBlendColor([0, 0, 0, 0]);
      }
  };

  Sprite_Actor.prototype.createMainSprite = function() {
      this._mainSprite = new Sprite_Base();
      this._mainSprite.anchor.x = 0.5;
      this._mainSprite.anchor.y = 1;
      this.addChild(this._mainSprite);
      this._effectTarget = this._mainSprite;
  };

  Sprite_Actor.prototype.createShadowSprite = function() {
      this._shadowSprite = new Sprite();
      this._shadowSprite.bitmap = ImageManager.loadSystem('Shadow2');
      this._shadowSprite.anchor.x = 0.5;
      this._shadowSprite.anchor.y = 0.5;
      this._shadowSprite.y = -2;
      this.addChild(this._shadowSprite);
  };

  Sprite_Actor.prototype.createWeaponSprite = function() {
      this._weaponSprite = new Sprite_Weapon();
      this.addChild(this._weaponSprite);
  };

  Sprite_Actor.prototype.createStateSprite = function() {
      this._stateSprite = new Sprite_StateOverlay();
      this.addChild(this._stateSprite);
      if (this._actor) this._stateSprite.setup(this._actor);
  };

  Sprite_Actor.prototype.updateBitmap = function() {
      if (!this._mainSprite) this.createMainSprite();
      Sprite_Battler.prototype.updateBitmap.call(this);
      var name = this._actor.battlerName();
      if (this._battlerName !== name) {
          this._battlerName = name;
          this._mainSprite.bitmap = ImageManager.loadSvActor(name);
      }
  };

  Sprite_Actor.prototype.updateFrame = function() {
      if (!this._mainSprite) this.createMainSprite();
      Sprite_Battler.prototype.updateFrame.call(this);
      var bitmap = this._mainSprite.bitmap;
      if (bitmap) {
          var motionIndex = this._motion ? this._motion.index : 0;
          var pattern = this._pattern < 3 ? this._pattern : 1;
          var cw = bitmap.width / 9;
          var ch = bitmap.height / 6;
          var cx = Math.floor(motionIndex / 6) * 3 + pattern;
          var cy = motionIndex % 6;
          this._mainSprite.setFrame(cx * cw, cy * ch, cw, ch);
      }
  };

  Sprite_Actor.prototype.updateMotionCount = function() {
      if (this._motion && ++this._motionCount >= this.motionSpeed()) {
          if (this._motion.loop) {
              this._pattern = (this._pattern + 1) % 4;
          } else if (this._pattern < 2) {
              this._pattern++;
          } else {
              this.refreshMotion();
          }
          this._motionCount = 0;
      }
  };

  Sprite_Actor.prototype.motionSpeed = function() {
      return 12;
  };

  Sprite_Actor.prototype.updateShadow = function() {
      if (!this._shadowSprite) this.createShadowSprite();
      this._shadowSprite.visible = !!this._actor;
  };

  Sprite_Enemy.prototype.loadBitmap = function(name, hue) {
      if (scope.$gameSystem.isSideView()) {
          this.bitmap = ImageManager.loadSvEnemy(name, hue);
      } else {
          this.bitmap = ImageManager.loadEnemy(name, hue);
      }
  };

  Sprite_Enemy.prototype.initVisibility = function() {
      this._appeared = this._enemy.isAlive();
      if (!this._appeared) {
          this.opacity = 0;
      }
  };

  Sprite_Enemy.prototype.createStateIconSprite = function() {
      this._stateIconSprite = new Sprite_StateIcon();
      this.addChild(this._stateIconSprite);
  };

  Sprite_Enemy.prototype.updateBitmap = function() {
      Sprite_Battler.prototype.updateBitmap.call(this);
      var name = this._enemy.battlerName();
      var hue = this._enemy.battlerHue();
      if (this._battlerName !== name || this._battlerHue !== hue) {
          this._battlerName = name;
          this._battlerHue = hue;
          this.loadBitmap(name, hue);
          this.initVisibility();
      }
  };

  Sprite_Enemy.prototype.updateFrame = function() {
      Sprite_Battler.prototype.updateFrame.call(this);
      var frameHeight = this.bitmap.height;
      if (this._effectType === 'bossCollapse') {
          frameHeight = this._effectDuration;
      }
      this.setFrame(0, 0, this.bitmap.width, frameHeight);
  };

  Sprite_Enemy.prototype.updateStateSprite = function() {
      if (!this._stateIconSprite) { this.createStateIconSprite(); this._stateIconSprite.setup(this._enemy); }
      this._stateIconSprite.y = -Math.round((this.bitmap.height + 40) * 0.9);
      if (this._stateIconSprite.y < 20 - this.y) {
          this._stateIconSprite.y = 20 - this.y;
      }
  };

  Sprite_Enemy.prototype.updateCollapse = function() {
      this.blendMode = Graphics.BLEND_ADD;
      this.setBlendColor([255, 128, 128, 128]);
      this.opacity *= this._effectDuration / (this._effectDuration + 1);
  };

  Sprite_Enemy.prototype.updateBossCollapse = function() {
      this._shake = this._effectDuration % 2 * 4 - 2;
      this.blendMode = Graphics.BLEND_ADD;
      this.opacity *= this._effectDuration / (this._effectDuration + 1);
      this.setBlendColor([255, 255, 255, 255 - this.opacity]);
      if (this._effectDuration % 20 === 19) {
          scope.SoundManager.playBossCollapse2();
      }
  };

  Sprite_Enemy.prototype.updateInstantCollapse = function() {
      this.opacity = 0;
  };
  Object.defineProperty(Sprite_Actor.prototype, '_motion', { configurable: true,
    get() { return Object.values(Sprite_Actor.MOTIONS).find(motion => motion.index === this._motionIndex); },
    set(value) { this._motionIndex = value ? value.index : 1; }
  });
  Sprite_Actor.prototype.startMotion = function(name) {
    const motion = Sprite_Actor.MOTIONS[name];
    if (motion !== this._motion) { this._motion = motion; this._motionCount = 0; this._pattern = 0; }
  };
}

module.exports = { installBattlerSprites };
