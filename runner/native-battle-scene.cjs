'use strict';
// RPG Maker MV behavior: Copyright (c) 2015 KADOKAWA CORPORATION./YOJI OJIMA.
// MIT license: third_party/rpg-maker-mv.LICENSE.

function installBattleScene({ Scene_Battle, Scene_Base, SceneManager, Graphics }, options) {
  Scene_Battle.prototype.isAnyInputWindowActive = function() {
      return (this._partyCommandWindow.active ||
              this._actorCommandWindow.active ||
              this._skillWindow.active ||
              this._itemWindow.active ||
              this._actorWindow.active ||
              this._enemyWindow.active);
  };

  Scene_Battle.prototype.changeInputWindow = function() {
      if (options.battleManager().isInputting()) {
          if (options.battleManager().actor()) {
              this.startActorCommandSelection();
          } else {
              this.startPartyCommandSelection();
          }
      } else {
          this.endCommandSelection();
      }
  };

  Scene_Battle.prototype.needsSlowFadeOut = function() {
      return (SceneManager.isNextScene(options.sceneClass('Scene_Title')) ||
              SceneManager.isNextScene(options.sceneClass('Scene_Gameover')));
  };

  Scene_Battle.prototype.createDisplayObjects = function() {
      this.createSpriteset();
      this.createWindowLayer();
      this.createAllWindows();
      options.battleManager().setLogWindow(this._logWindow);
      options.battleManager().setStatusWindow(this._statusWindow);
      options.battleManager().setSpriteset(this._spriteset);
      this._logWindow.setSpriteset(this._spriteset);
  };

  Scene_Battle.prototype.createSpriteset = function() {
      this._spriteset = new (options.sceneClass('Spriteset_Battle'))();
      this.addChild(this._spriteset);
  };

  Scene_Battle.prototype.createAllWindows = function() {
      this.createLogWindow();
      this.createStatusWindow();
      this.createPartyCommandWindow();
      this.createActorCommandWindow();
      this.createHelpWindow();
      this.createSkillWindow();
      this.createItemWindow();
      this.createActorWindow();
      this.createEnemyWindow();
      this.createMessageWindow();
      this.createScrollTextWindow();
  };

  Scene_Battle.prototype.createLogWindow = function() {
      this._logWindow = new (options.sceneClass('Window_BattleLog'))();
      this.addWindow(this._logWindow);
  };

  Scene_Battle.prototype.createStatusWindow = function() {
      this._statusWindow = new (options.sceneClass('Window_BattleStatus'))();
      this.addWindow(this._statusWindow);
  };

  Scene_Battle.prototype.createPartyCommandWindow = function() {
      this._partyCommandWindow = new (options.sceneClass('Window_PartyCommand'))();
      this._partyCommandWindow.setHandler('fight',  this.commandFight.bind(this));
      this._partyCommandWindow.setHandler('escape', this.commandEscape.bind(this));
      this._partyCommandWindow.deselect();
      this.addWindow(this._partyCommandWindow);
  };

  Scene_Battle.prototype.createActorCommandWindow = function() {
      this._actorCommandWindow = new (options.sceneClass('Window_ActorCommand'))();
      this._actorCommandWindow.setHandler('attack', this.commandAttack.bind(this));
      this._actorCommandWindow.setHandler('skill',  this.commandSkill.bind(this));
      this._actorCommandWindow.setHandler('guard',  this.commandGuard.bind(this));
      this._actorCommandWindow.setHandler('item',   this.commandItem.bind(this));
      this._actorCommandWindow.setHandler('cancel', this.selectPreviousCommand.bind(this));
      this.addWindow(this._actorCommandWindow);
  };

  Scene_Battle.prototype.createHelpWindow = function() {
      this._helpWindow = new (options.sceneClass('Window_Help'))();
      this._helpWindow.visible = false;
      this.addWindow(this._helpWindow);
  };

  Scene_Battle.prototype.createSkillWindow = function() {
      var wy = this._helpWindow.y + this._helpWindow.height;
      var wh = this._statusWindow.y - wy;
      this._skillWindow = new (options.sceneClass('Window_BattleSkill'))(0, wy, Graphics.boxWidth, wh);
      this._skillWindow.setHelpWindow(this._helpWindow);
      this._skillWindow.setHandler('ok',     this.onSkillOk.bind(this));
      this._skillWindow.setHandler('cancel', this.onSkillCancel.bind(this));
      this.addWindow(this._skillWindow);
  };

  Scene_Battle.prototype.createItemWindow = function() {
      var wy = this._helpWindow.y + this._helpWindow.height;
      var wh = this._statusWindow.y - wy;
      this._itemWindow = new (options.sceneClass('Window_BattleItem'))(0, wy, Graphics.boxWidth, wh);
      this._itemWindow.setHelpWindow(this._helpWindow);
      this._itemWindow.setHandler('ok',     this.onItemOk.bind(this));
      this._itemWindow.setHandler('cancel', this.onItemCancel.bind(this));
      this.addWindow(this._itemWindow);
  };

  Scene_Battle.prototype.createActorWindow = function() {
      this._actorWindow = new (options.sceneClass('Window_BattleActor'))(0, this._statusWindow.y);
      this._actorWindow.setHandler('ok',     this.onActorOk.bind(this));
      this._actorWindow.setHandler('cancel', this.onActorCancel.bind(this));
      this.addWindow(this._actorWindow);
  };

  Scene_Battle.prototype.createEnemyWindow = function() {
      this._enemyWindow = new (options.sceneClass('Window_BattleEnemy'))(0, this._statusWindow.y);
      this._enemyWindow.x = Graphics.boxWidth - this._enemyWindow.width;
      this._enemyWindow.setHandler('ok',     this.onEnemyOk.bind(this));
      this._enemyWindow.setHandler('cancel', this.onEnemyCancel.bind(this));
      this.addWindow(this._enemyWindow);
  };

  Scene_Battle.prototype.createMessageWindow = function() {
      this._messageWindow = new (options.sceneClass('Window_Message'))();
      this.addWindow(this._messageWindow);
      this._messageWindow.subWindows().forEach(function(window) {
          this.addWindow(window);
      }, this);
  };

  Scene_Battle.prototype.createScrollTextWindow = function() {
      this._scrollTextWindow = new (options.sceneClass('Window_ScrollText'))();
      this.addWindow(this._scrollTextWindow);
  };

  Scene_Battle.prototype.refreshStatus = function() {
      this._statusWindow.refresh();
  };

  Scene_Battle.prototype.startPartyCommandSelection = function() {
      this.refreshStatus();
      this._statusWindow.deselect();
      this._statusWindow.open();
      this._actorCommandWindow.close();
      this._partyCommandWindow.setup();
  };

  Scene_Battle.prototype.commandFight = function() {
      this.selectNextCommand();
  };

  Scene_Battle.prototype.commandEscape = function() {
      options.battleManager().processEscape();
      this.changeInputWindow();
  };

  Scene_Battle.prototype.startActorCommandSelection = function() {
      this._statusWindow.select(options.battleManager().actor().index());
      this._partyCommandWindow.close();
      this._actorCommandWindow.setup(options.battleManager().actor());
  };

  Scene_Battle.prototype.commandAttack = function() {
      options.battleManager().inputtingAction().setAttack();
      this.selectEnemySelection();
  };

  Scene_Battle.prototype.commandSkill = function() {
      this._skillWindow.setActor(options.battleManager().actor());
      this._skillWindow.setStypeId(this._actorCommandWindow.currentExt());
      this._skillWindow.refresh();
      this._skillWindow.show();
      this._skillWindow.activate();
  };

  Scene_Battle.prototype.commandGuard = function() {
      options.battleManager().inputtingAction().setGuard();
      this.selectNextCommand();
  };

  Scene_Battle.prototype.commandItem = function() {
      this._itemWindow.refresh();
      this._itemWindow.show();
      this._itemWindow.activate();
  };

  Scene_Battle.prototype.selectNextCommand = function() {
      options.battleManager().selectNextCommand();
      this.changeInputWindow();
  };

  Scene_Battle.prototype.selectPreviousCommand = function() {
      options.battleManager().selectPreviousCommand();
      this.changeInputWindow();
  };

  Scene_Battle.prototype.selectActorSelection = function() {
      this._actorWindow.refresh();
      this._actorWindow.show();
      this._actorWindow.activate();
  };

  Scene_Battle.prototype.onActorOk = function() {
      var action = options.battleManager().inputtingAction();
      action.setTarget(this._actorWindow.index());
      this._actorWindow.hide();
      this._skillWindow.hide();
      this._itemWindow.hide();
      this.selectNextCommand();
  };

  Scene_Battle.prototype.onActorCancel = function() {
      this._actorWindow.hide();
      switch (this._actorCommandWindow.currentSymbol()) {
      case 'skill':
          this._skillWindow.show();
          this._skillWindow.activate();
          break;
      case 'item':
          this._itemWindow.show();
          this._itemWindow.activate();
          break;
      }
  };

  Scene_Battle.prototype.selectEnemySelection = function() {
      this._enemyWindow.refresh();
      this._enemyWindow.show();
      this._enemyWindow.select(0);
      this._enemyWindow.activate();
  };

  Scene_Battle.prototype.onEnemyOk = function() {
      var action = options.battleManager().inputtingAction();
      action.setTarget(this._enemyWindow.enemyIndex());
      this._enemyWindow.hide();
      this._skillWindow.hide();
      this._itemWindow.hide();
      this.selectNextCommand();
  };

  Scene_Battle.prototype.onEnemyCancel = function() {
      this._enemyWindow.hide();
      switch (this._actorCommandWindow.currentSymbol()) {
      case 'attack':
          this._actorCommandWindow.activate();
          break;
      case 'skill':
          this._skillWindow.show();
          this._skillWindow.activate();
          break;
      case 'item':
          this._itemWindow.show();
          this._itemWindow.activate();
          break;
      }
  };

  Scene_Battle.prototype.onSkillOk = function() {
      var skill = this._skillWindow.item();
      var action = options.battleManager().inputtingAction();
      action.setSkill(skill.id);
      options.battleManager().actor().setLastBattleSkill(skill);
      this.onSelectAction();
  };

  Scene_Battle.prototype.onSkillCancel = function() {
      this._skillWindow.hide();
      this._actorCommandWindow.activate();
  };

  Scene_Battle.prototype.onItemOk = function() {
      var item = this._itemWindow.item();
      var action = options.battleManager().inputtingAction();
      action.setItem(item.id);
      options.gameParty().setLastItem(item);
      this.onSelectAction();
  };

  Scene_Battle.prototype.onItemCancel = function() {
      this._itemWindow.hide();
      this._actorCommandWindow.activate();
  };

  Scene_Battle.prototype.onSelectAction = function() {
      var action = options.battleManager().inputtingAction();
      this._skillWindow.hide();
      this._itemWindow.hide();
      if (!action.needsSelection()) {
          this.selectNextCommand();
      } else if (action.isForOpponent()) {
          this.selectEnemySelection();
      } else {
          this.selectActorSelection();
      }
  };

  Scene_Battle.prototype.endCommandSelection = function() {
      this._partyCommandWindow.close();
      this._actorCommandWindow.close();
      this._statusWindow.deselect();
  };
}

module.exports = { installBattleScene };
