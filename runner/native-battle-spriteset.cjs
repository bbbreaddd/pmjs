'use strict';
// RPG Maker MV behavior: Copyright (c) 2015 KADOKAWA CORPORATION./YOJI OJIMA.
// MIT license: third_party/rpg-maker-mv.LICENSE.

function installBattleSpriteset(scope) {
  const { Spriteset_Battle, Sprite_Actor, Sprite_Enemy, ImageManager, Graphics, TilingSprite, Sprite } = scope;
  Spriteset_Battle.prototype.createBattleField = function() {
      var width = Graphics.boxWidth;
      var height = Graphics.boxHeight;
      var x = (Graphics.width - width) / 2;
      var y = (Graphics.height - height) / 2;
      this._battleField = new Sprite();
      this._battleField.setFrame(x, y, width, height);
      this._battleField.x = x;
      this._battleField.y = y;
      this._baseSprite.addChild(this._battleField);
  };

  Spriteset_Battle.prototype.createBattleback = function() {
      var margin = 32;
      var x = -this._battleField.x - margin;
      var y = -this._battleField.y - margin;
      var width = Graphics.width + margin * 2;
      var height = Graphics.height + margin * 2;
      this._back1Sprite = new TilingSprite();
      this._back2Sprite = new TilingSprite();
      this._back1Sprite.bitmap = this.battleback1Bitmap();
      this._back2Sprite.bitmap = this.battleback2Bitmap();
      this._back1Sprite.move(x, y, width, height);
      this._back2Sprite.move(x, y, width, height);
      this._battleField.addChild(this._back1Sprite);
      this._battleField.addChild(this._back2Sprite);
  };

  Spriteset_Battle.prototype.locateBattleback = function() {
      var width = this._battleField.width;
      var height = this._battleField.height;
      var sprite1 = this._back1Sprite;
      var sprite2 = this._back2Sprite;
      sprite1.origin.x = sprite1.x + (sprite1.bitmap.width - width) / 2;
      sprite2.origin.x = sprite1.y + (sprite2.bitmap.width - width) / 2;
      if (scope.$gameSystem.isSideView()) {
          sprite1.origin.y = sprite1.x + sprite1.bitmap.height - height;
          sprite2.origin.y = sprite1.y + sprite2.bitmap.height - height;
      }
  };
  const createLowerLayer = Spriteset_Battle.prototype.createLowerLayer;
  Spriteset_Battle.prototype.createLowerLayer = function() { createLowerLayer.call(this); this.createEnemies(); this.createActors(); this.updateActors(); };
  Spriteset_Battle.prototype.battleback1Bitmap = function() {
      return ImageManager.loadBattleback1(this.battleback1Name());
  };

  Spriteset_Battle.prototype.battleback2Bitmap = function() {
      return ImageManager.loadBattleback2(this.battleback2Name());
  };

  Spriteset_Battle.prototype.battleback1Name = function() {
      if (scope.BattleManager.isBattleTest()) {
          return scope.$dataSystem.battleback1Name;
      } else if (scope.$gameMap.battleback1Name()) {
          return scope.$gameMap.battleback1Name();
      } else if (scope.$gameMap.isOverworld()) {
          return this.overworldBattleback1Name();
      } else {
          return '';
      }
  };

  Spriteset_Battle.prototype.battleback2Name = function() {
      if (scope.BattleManager.isBattleTest()) {
          return scope.$dataSystem.battleback2Name;
      } else if (scope.$gameMap.battleback2Name()) {
          return scope.$gameMap.battleback2Name();
      } else if (scope.$gameMap.isOverworld()) {
          return this.overworldBattleback2Name();
      } else {
          return '';
      }
  };

  Spriteset_Battle.prototype.overworldBattleback1Name = function() {
      if (scope.$gameMap.battleback1Name() === '') return '';
      if (scope.$gamePlayer.isInVehicle()) {
          return this.shipBattleback1Name();
      } else {
          return this.normalBattleback1Name();
      }
  };

  Spriteset_Battle.prototype.overworldBattleback2Name = function() {
      if (scope.$gameMap.battleback2Name() === '') return '';
      if (scope.$gamePlayer.isInVehicle()) {
          return this.shipBattleback2Name();
      } else {
          return this.normalBattleback2Name();
      }
  };

  Spriteset_Battle.prototype.normalBattleback1Name = function() {
      return (this.terrainBattleback1Name(this.autotileType(1)) ||
              this.terrainBattleback1Name(this.autotileType(0)) ||
              this.defaultBattleback1Name());
  };

  Spriteset_Battle.prototype.normalBattleback2Name = function() {
      return (this.terrainBattleback2Name(this.autotileType(1)) ||
              this.terrainBattleback2Name(this.autotileType(0)) ||
              this.defaultBattleback2Name());
  };

  Spriteset_Battle.prototype.terrainBattleback1Name = function(type) {
      switch (type) {
      case 24: case 25:
          return 'Wasteland';
      case 26: case 27:
          return 'DirtField';
      case 32: case 33:
          return 'Desert';
      case 34:
          return 'Lava1';
      case 35:
          return 'Lava2';
      case 40: case 41:
          return 'Snowfield';
      case 42:
          return 'Clouds';
      case 4: case 5:
          return 'PoisonSwamp';
      default:
          return null;
      }
  };

  Spriteset_Battle.prototype.terrainBattleback2Name = function(type) {
      switch (type) {
      case 20: case 21:
          return 'Forest';
      case 22: case 30: case 38:
          return 'Cliff';
      case 24: case 25: case 26: case 27:
          return 'Wasteland';
      case 32: case 33:
          return 'Desert';
      case 34: case 35:
          return 'Lava';
      case 40: case 41:
          return 'Snowfield';
      case 42:
          return 'Clouds';
      case 4: case 5:
          return 'PoisonSwamp';
      }
  };

  Spriteset_Battle.prototype.defaultBattleback1Name = function() {
      return 'Grassland';
  };

  Spriteset_Battle.prototype.defaultBattleback2Name = function() {
      return 'Grassland';
  };

  Spriteset_Battle.prototype.shipBattleback1Name = function() {
      return 'Ship';
  };

  Spriteset_Battle.prototype.shipBattleback2Name = function() {
      return 'Ship';
  };

  Spriteset_Battle.prototype.autotileType = function(z) {
      return scope.$gameMap.autotileType(scope.$gamePlayer.x, scope.$gamePlayer.y, z);
  };

  Spriteset_Battle.prototype.createEnemies = function() {
      var enemies = scope.$gameTroop.members();
      var sprites = [];
      for (var i = 0; i < enemies.length; i++) {
          sprites[i] = new Sprite_Enemy(enemies[i]);
      }
      sprites.sort(this.compareEnemySprite.bind(this));
      for (var j = 0; j < sprites.length; j++) {
          this._battleField.addChild(sprites[j]);
      }
      this._enemySprites = sprites;
  };

  Spriteset_Battle.prototype.compareEnemySprite = function(a, b) {
      if (a.y !== b.y) {
          return a.y - b.y;
      } else {
          return b.spriteId - a.spriteId;
      }
  };

  Spriteset_Battle.prototype.createActors = function() {
      this._actorSprites = [];
      for (var i = 0; i < scope.$gameParty.maxBattleMembers(); i++) {
          this._actorSprites[i] = new Sprite_Actor();
          this._battleField.addChild(this._actorSprites[i]);
      }
  };

  Spriteset_Battle.prototype.updateActors = function() {
      var members = scope.$gameParty.battleMembers();
      for (var i = 0; i < this._actorSprites.length; i++) {
          this._actorSprites[i].setBattler(members[i]);
      }
  };

  Spriteset_Battle.prototype.battlerSprites = function() {
      return this._enemySprites.concat(this._actorSprites);
  };

  Spriteset_Battle.prototype.isAnimationPlaying = function() {
      return this.battlerSprites().some(function(sprite) {
          return sprite.isAnimationPlaying();
      });
  };

  Spriteset_Battle.prototype.isEffecting = function() {
      return this.battlerSprites().some(function(sprite) {
          return sprite.isEffecting();
      });
  };

  Spriteset_Battle.prototype.isAnyoneMoving = function() {
      return this.battlerSprites().some(function(sprite) {
          return sprite.isMoving();
      });
  };
}

module.exports = { installBattleSpriteset };
