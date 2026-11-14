'use strict';
// RPG Maker MV behavior: Copyright (c) 2015 KADOKAWA CORPORATION./YOJI OJIMA.
// MIT license: third_party/rpg-maker-mv.LICENSE.

function installSceneCommands(types, options) {
  const { Scene_Title, Scene_Menu, Scene_ItemBase, Scene_Item, Scene_Skill, Scene_Map, Scene_Load, Scene_Options, SceneManager, Sprite, Bitmap, Graphics, ImageManager } = types;
  Scene_Title.prototype.createBackground = function() {
      this._backSprite1 = new Sprite(ImageManager.loadTitle1(options.databaseObject('system').title1Name));
      this._backSprite2 = new Sprite(ImageManager.loadTitle2(options.databaseObject('system').title2Name));
      this.addChild(this._backSprite1);
      this.addChild(this._backSprite2);
  };

  Scene_Title.prototype.createForeground = function() {
      this._gameTitleSprite = new Sprite(new Bitmap(Graphics.width, Graphics.height));
      this.addChild(this._gameTitleSprite);
      if (options.databaseObject('system').optDrawTitle) {
          this.drawGameTitle();
      }
  };

  Scene_Title.prototype.drawGameTitle = function() {
      var x = 20;
      var y = Graphics.height / 4;
      var maxWidth = Graphics.width - x * 2;
      var text = options.databaseObject('system').gameTitle;
      this._gameTitleSprite.bitmap.outlineColor = 'black';
      this._gameTitleSprite.bitmap.outlineWidth = 8;
      this._gameTitleSprite.bitmap.fontSize = 72;
      this._gameTitleSprite.bitmap.drawText(text, x, y, maxWidth, 48, 'center');
  };

  Scene_Title.prototype.centerSprite = function(sprite) {
      sprite.x = Graphics.width / 2;
      sprite.y = Graphics.height / 2;
      sprite.anchor.x = 0.5;
      sprite.anchor.y = 0.5;
  };

  Scene_Title.prototype.createCommandWindow = function() {
      this._commandWindow = new (options.sceneClass('Window_TitleCommand'))();
      this._commandWindow.setHandler('newGame',  this.commandNewGame.bind(this));
      this._commandWindow.setHandler('continue', this.commandContinue.bind(this));
      this._commandWindow.setHandler('options',  this.commandOptions.bind(this));
      this.addWindow(this._commandWindow);
  };

  Scene_Title.prototype.commandNewGame = function() {
      options.dataManager().setupNewGame();
      this._commandWindow.close();
      this.fadeOutAll();
      SceneManager.goto(Scene_Map);
  };

  Scene_Title.prototype.commandContinue = function() {
      this._commandWindow.close();
      SceneManager.push(Scene_Load);
  };

  Scene_Title.prototype.commandOptions = function() {
      this._commandWindow.close();
      SceneManager.push(Scene_Options);
  };

  Scene_Menu.prototype.createGoldWindow = function() {
      this._goldWindow = new (options.sceneClass('Window_Gold'))(0, 0);
      this._goldWindow.y = Graphics.boxHeight - this._goldWindow.height;
      this.addWindow(this._goldWindow);
  };

  Scene_Menu.prototype.createStatusWindow = function() {
      this._statusWindow = new (options.sceneClass('Window_MenuStatus'))(this._commandWindow.width, 0);
      this._statusWindow.reserveFaceImages();
      this.addWindow(this._statusWindow);
  };

  Scene_ItemBase.prototype.createActorWindow = function() {
      this._actorWindow = new (options.sceneClass('Window_MenuActor'))();
      this._actorWindow.setHandler('ok',     this.onActorOk.bind(this));
      this._actorWindow.setHandler('cancel', this.onActorCancel.bind(this));
      this.addWindow(this._actorWindow);
  };

  Scene_ItemBase.prototype.onActorOk = function() {
      if (this.canUse()) {
          this.useItem();
      } else {
          options.soundManager().playBuzzer();
      }
  };

  Scene_ItemBase.prototype.determineItem = function() {
      var action = new (options.sceneClass('Game_Action'))(this.user());
      var item = this.item();
      action.setItemObject(item);
      if (action.isForFriend()) {
          this.showSubWindow(this._actorWindow);
          this._actorWindow.selectForItem(this.item());
      } else {
          this.useItem();
          this.activateItemWindow();
      }
  };

  Scene_ItemBase.prototype.useItem = function() {
      this.playSeForItem();
      this.user().useItem(this.item());
      this.applyItem();
      this.checkCommonEvent();
      this.checkGameover();
      this._actorWindow.refresh();
  };

  Scene_ItemBase.prototype.itemTargetActors = function() {
      var action = new (options.sceneClass('Game_Action'))(this.user());
      action.setItemObject(this.item());
      if (!action.isForFriend()) {
          return [];
      } else if (action.isForAll()) {
          return options.gameParty().members();
      } else {
          return [options.gameParty().members()[this._actorWindow.index()]];
      }
  };

  Scene_ItemBase.prototype.canUse = function() {
      return this.user().canUse(this.item()) && this.isItemEffectsValid();
  };

  Scene_ItemBase.prototype.isItemEffectsValid = function() {
      var action = new (options.sceneClass('Game_Action'))(this.user());
      action.setItemObject(this.item());
      return this.itemTargetActors().some(function(target) {
          return action.testApply(target);
      }, this);
  };

  Scene_ItemBase.prototype.applyItem = function() {
      var action = new (options.sceneClass('Game_Action'))(this.user());
      action.setItemObject(this.item());
      this.itemTargetActors().forEach(function(target) {
          for (var i = 0; i < action.numRepeats(); i++) {
              action.apply(target);
          }
      }, this);
      action.applyGlobal();
  };

  Scene_ItemBase.prototype.checkCommonEvent = function() {
      if (options.gameTemp().isCommonEventReserved()) {
          SceneManager.goto(Scene_Map);
      }
  };

  Scene_Item.prototype.createItemWindow = function() {
      var wy = this._categoryWindow.y + this._categoryWindow.height;
      var wh = Graphics.boxHeight - wy;
      this._itemWindow = new (options.sceneClass('Window_ItemList'))(0, wy, Graphics.boxWidth, wh);
      this._itemWindow.setHelpWindow(this._helpWindow);
      this._itemWindow.setHandler('ok',     this.onItemOk.bind(this));
      this._itemWindow.setHandler('cancel', this.onItemCancel.bind(this));
      this.addWindow(this._itemWindow);
      this._categoryWindow.setItemWindow(this._itemWindow);
  };

  Scene_Item.prototype.onCategoryOk = function() {
      this._itemWindow.activate();
      this._itemWindow.selectLast();
  };

  Scene_Item.prototype.onItemCancel = function() {
      this._itemWindow.deselect();
      this._categoryWindow.activate();
  };

  Scene_Item.prototype.onItemOk = function() {
      options.gameParty().setLastItem(this.item());
      this.determineItem();
  };

  Scene_Item.prototype.user = function() {
      var members = options.gameParty().movableMembers();
      var bestActor = members[0];
      var bestPha = 0;
      for (var i = 0; i < members.length; i++) {
          if (members[i].pha > bestPha) {
              bestPha = members[i].pha;
              bestActor = members[i];
          }
      }
      return bestActor;
  };

  Scene_Item.prototype.playSeForItem = function() {
      options.soundManager().playUseItem();
  };

  Scene_Skill.prototype.onItemOk = function() {
      this.actor().setLastMenuSkill(this.item());
      this.determineItem();
  };

  Scene_Skill.prototype.refreshActor = function() {
      var actor = this.actor();
      this._skillTypeWindow.setActor(actor);
      this._statusWindow.setActor(actor);
      this._itemWindow.setActor(actor);
  };

  Scene_Skill.prototype.playSeForItem = function() {
      options.soundManager().playUseSkill();
  };

  Scene_Skill.prototype.user = function() {
      return this.actor();
  };
}

module.exports = { installSceneCommands };
