'use strict';

function installMapBindings(scope, engine, session, createArray, handles) {
  const map = scope.Game_Map.prototype, system = scope.Game_System.prototype;
  const invoke = (method, ...args) => engine.gameDataInvoke(session, 'map', method, args);
  for (const method of ['tileWidth', 'tileHeight', 'width', 'height', 'displayName', 'encounterStep', 'isLoopHorizontal', 'isLoopVertical', 'isEventRunning', 'displayX', 'displayY'])
    map[method] = function() { return invoke(method); };
  map.events = function() { return createArray(invoke('eventIds')).map(id => this.event(id)); };
  map.eventsXy = function(x, y) { return this.events().filter(event => event.pos(x, y)); };
  map.eventsXyNt = function(x, y) { return this.events().filter(event => event.posNt(x, y)); };
  map.refreshIfNeeded = function() { invoke('refreshIfNeeded'); };
  map.screenTileX = function() { return scope.Graphics.width / this.tileWidth(); };
  map.screenTileY = function() { return scope.Graphics.height / this.tileHeight(); };
  map.isValid = function(x, y) { return x >= 0 && x < this.width() && y >= 0 && y < this.height(); };
  map.roundX = function(x) { return this.isLoopHorizontal() ? (x % this.width() + this.width()) % this.width() : x; };
  map.roundY = function(y) { return this.isLoopVertical() ? (y % this.height() + this.height()) % this.height() : y; };
  for (const [method, pattern] of Object.entries({ isJapanese: /^ja/, isChinese: /^zh/, isKorean: /^ko/, isRussian: /^ru/ }))
    system[method] = function() { const match = scope.$dataSystem.locale.match(pattern); return match && Object.assign(createArray(match), match); };
  system.isCJK = function() { return this.isJapanese() || this.isChinese() || this.isKorean(); };
  system.versionId = function() { return engine.gameDataInvoke(session, 'system', 'versionId', []); };
  system.playtime = function() { return engine.gameDataInvoke(session, 'system', 'playtime', []); };
  system.playtimeText = function() { const total = this.playtime(); return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60].map(value => String(value).padStart(2, '0')).join(':'); };
  for (const [method, field] of Object.entries({ onBattleStart: '_battleCount', onBattleWin: '_winCount', onBattleEscape: '_escapeCount' }))
    system[method] = function() { ++this[field]; };
  const character = scope.Game_CharacterBase.prototype;
  character.pos = function(x, y) { return this._x === x && this._y === y; };
  character.isThrough = function() { return this._through; };
  character.posNt = function(x, y) { return this.pos(x, y) && !this.isThrough(); };
  for (const field of ['moveSpeed', 'pattern', 'tileId', 'jumpCount', 'movementSuccess', 'directionFix'])
    Object.defineProperty(character, '_' + field, { configurable: true,
      get() { return engine.entityField(handles.get(this), field); },
      set(value) { engine.entityField(handles.get(this), field, value); }
    });
  character.characterName = function() { return this._characterName; };
  character.tileId = function() { return this._tileId; };
  character.isJumping = function() { return this._jumpCount > 0; };
  character.isMovementSucceeded = function() { return this._movementSuccess; };
  character.isDirectionFixed = function() { return this._directionFix; };
  character.isDashing = function() { return false; };
  character.realMoveSpeed = function() { return this._moveSpeed + (this.isDashing() ? 1 : 0); };
  character.setMoveSpeed = function(value) { this._moveSpeed = value; };
  character.setPattern = function(value) { this._pattern = value; };
  character.setThrough = function(value) { this._through = value; };
  character.setTransparent = function(value) { this._transparent = value; };
  for (const method of ['screenX', 'screenY', 'jump']) character[method] = function(...args) { return engine.characterCommand(session, handles.get(this), method, args); };
  for (const method of ['setMoveRoute', 'forceMoveRoute']) scope.Game_Character.prototype[method] = function(route) { engine.characterCommand(session, handles.get(this), method, [route]); };
  Object.assign(scope.Game_Character, { ROUTE_MOVE_DOWN: 1, ROUTE_MOVE_LEFT: 2, ROUTE_MOVE_RIGHT: 3, ROUTE_MOVE_UP: 4,
    ROUTE_MOVE_LOWER_L: 5, ROUTE_MOVE_LOWER_R: 6, ROUTE_MOVE_UPPER_L: 7, ROUTE_MOVE_UPPER_R: 8, ROUTE_SCRIPT: 45 });
}

module.exports = { installMapBindings };
