'use strict';

function installTroopBindings(scope, engine, session, wrapEnemy, createArray) {
  const invoke = (method, ...args) => engine.gameDataInvoke(session, 'battle', method, args);
  function Game_Troop() { throw new Error('Troop construction is engine-owned'); }
  Game_Troop.prototype = Object.create(scope.Game_Unit.prototype);
  Game_Troop.prototype.constructor = Game_Troop;
  Game_Troop.prototype.setup = function(id) { invoke('setupTroop', id); };
  for (const method of ['increaseTurn', 'setupBattleEvent', 'updateInterpreter']) Game_Troop.prototype[method] = function() { invoke(method); };
  Game_Troop.prototype.inBattle = function() { return scope.$gameParty.inBattle(); };
  Game_Troop.prototype.members = function() { return createArray(Array.from({ length: invoke('enemyCount') }, (_, index) => wrapEnemy(index))); };
  Game_Troop.prototype.troop = function() { return scope.$dataTroops[invoke('troopId')]; };
  Game_Troop.prototype.turnCount = function() { return invoke('turnCount'); };
  Game_Troop.prototype.isEventRunning = function() { return invoke('isEventRunning'); };
  scope.Game_Enemy.prototype.originalName = function() { return this.enemy().name; };
  Game_Troop.prototype.enemyNames = function() { return createArray(new Set(this.members().filter(enemy => enemy.isAlive()).map(enemy => enemy.originalName()))); };
  scope.Game_Troop = Game_Troop;
  scope.$gameTroop = Object.create(Game_Troop.prototype);
  scope.Game_Enemy.prototype.index = function() { return this.friendsUnit().members().indexOf(this); };
  scope.Game_Enemy.prototype.friendsUnit = function() { return scope.$gameTroop; };
  scope.Game_Enemy.prototype.battlerName = function() { return this.enemy().battlerName; };
  scope.Game_Enemy.prototype.battlerHue = function() { return this.enemy().battlerHue; };
  scope.Game_Enemy.prototype.opponentsUnit = function() { return scope.$gameParty; };
  scope.Game_Actor.prototype.index = function() { return scope.$gameParty.members().indexOf(this); };
  scope.Game_Actor.prototype.friendsUnit = function() { return scope.$gameParty; };
  scope.Game_Actor.prototype.opponentsUnit = function() { return scope.$gameTroop; };
  for (const method of ['friendsUnit', 'opponentsUnit']) scope.Game_Action.prototype[method] = function() { return this.subject()[method](); };
  const defaults = {};
  for (const method of ['setup', 'increaseTurn', 'setupBattleEvent']) defaults[method] = Game_Troop.prototype[method];
  for (const method of ['canEscape', 'canLose', 'isAborting', 'isTurnEnd']) scope.BattleManager[method] = function() { return invoke(method); };
  scope.BattleManager.actor = function() { const id=invoke('actorId'); return id ? scope.$gameActors.actor(id) : null; };
  return defaults;
}

module.exports = { installTroopBindings };
