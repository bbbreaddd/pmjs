'use strict';
const { nativeArray } = require('./native-array.cjs');
// RPG Maker MV behavior: Copyright (c) 2015 KADOKAWA CORPORATION./YOJI OJIMA.
// MIT license: third_party/rpg-maker-mv.LICENSE.

function installMapBindings(scope, engine, session, createArray, handles) {
  const map = scope.Game_Map.prototype, system = scope.Game_System.prototype;
  const invoke = (method, ...args) => engine.gameDataInvoke(session, 'map', method, args);
  scope.Game_Player.prototype.requestMapReload = function() { engine.characterCommand(session, handles.get(this), 'needsMapReload', [true]); };
  Object.defineProperty(scope.Game_Player.prototype, '_needsMapReload', { configurable: true,
    get() { return engine.characterCommand(session, handles.get(this), 'needsMapReload', []); },
    set(value) { engine.characterCommand(session, handles.get(this), 'needsMapReload', [Boolean(value)]); }
  });
  map.tilesetId = function() { return invoke('tilesetId'); };
  map.tileset = function() { return scope.$dataTilesets[this.tilesetId()]; };
  map.tilesetFlags = function() { const tileset=this.tileset();return tileset?tileset.flags:createArray([]); };
  for (const method of ['tileWidth', 'tileHeight', 'width', 'height', 'displayName', 'encounterStep', 'isLoopHorizontal', 'isLoopVertical', 'isEventRunning', 'displayX', 'displayY'])
    map[method] = function() { return invoke(method); };
  for (const field of ['displayX', 'displayY']) Object.defineProperty(map, '_' + field, {
    configurable: true,
    get() { return invoke(field); },
    set(value) { invoke(field, Number(value)); }
  });
  map.adjustX = function(x) { return invoke('adjustX', Number(x)); };
  map.adjustY = function(y) { return invoke('adjustY', Number(y)); };
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
  const tones = new WeakMap();
  system.windowTone = function() {
    if (!tones.has(this)) tones.set(this, nativeArray(() => createArray([]),
      () => engine.gameDataInvoke(session, 'system', 'windowTone', []) || [],
      values => engine.gameDataInvoke(session, 'system', 'setWindowTone', [values])));
    return tones.get(this).view;
  };
  system.setWindowTone = function(tone) { engine.gameDataInvoke(session, 'system', 'setWindowTone', [tone]); };
  system.versionId = function() { return engine.gameDataInvoke(session, 'system', 'versionId', []); };
  system.playtime = function() { return engine.gameDataInvoke(session, 'system', 'playtime', []); };
  system.playtimeText = function() { const total = this.playtime(); return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60].map(value => String(value).padStart(2, '0')).join(':'); };
  for (const [method, field] of Object.entries({ onBattleStart: '_battleCount', onBattleWin: '_winCount', onBattleEscape: '_escapeCount' }))
    system[method] = function() { ++this[field]; };
  for (const [axis, size, loop] of [['X', 'width', 'isLoopHorizontal'], ['Y', 'height', 'isLoopVertical']]) {
    map['delta' + axis] = function(first, second) {
      let distance = first - second;
      if (this[loop]() && Math.abs(distance) > this[size]() / 2) distance += distance < 0 ? this[size]() : -this[size]();
      return distance;
    };
    map['adjust' + axis] = function(position) {
      const display = this['display' + axis]();
      return this[loop]() && position < display - (this[size]() - this['screenTile' + axis]()) / 2 ? position - display + this[size]() : position - display;
    };
    scope.Game_CharacterBase.prototype['scrolled' + axis] = function() { return scope.$gameMap['adjust' + axis](this['_real' + axis]); };
    scope.Game_Character.prototype['delta' + axis + 'From'] = function(value) { return scope.$gameMap['delta' + axis](this[axis.toLowerCase()], value); };
  }
  for (const away of [false, true]) {
    const name = away ? 'moveAwayFromCharacter' : 'moveTowardCharacter';
    scope.Game_Character.prototype[name] = function(target) {
      const x = this.deltaXFrom(target.x), y = this.deltaYFrom(target.y);
      const horizontal = away ? (x > 0 ? 6 : 4) : (x > 0 ? 4 : 6);
      const vertical = away ? (y > 0 ? 2 : 8) : (y > 0 ? 8 : 2);
      if (Math.abs(x) > Math.abs(y)) {
        this.moveStraight(horizontal);
        if (!this.isMovementSucceeded() && y !== 0) this.moveStraight(vertical);
      } else if (y !== 0) {
        this.moveStraight(vertical);
        if (!this.isMovementSucceeded() && x !== 0) this.moveStraight(horizontal);
      }
    };
  }
  scope.Game_Character.prototype.moveTowardPlayer = function() { this.moveTowardCharacter(scope.$gamePlayer); };
  scope.Game_Character.prototype.moveAwayFromPlayer = function() { this.moveAwayFromCharacter(scope.$gamePlayer); };
  scope.Game_Character.prototype.moveRandom = function() { engine.characterCommand(session, handles.get(this), 'processMoveCommand', [{ code: 9, parameters: [] }]); };
  const player = scope.Game_Player.prototype;
  Object.defineProperty(player, '_vehicleType', { configurable: true,
    get() { return ['walk', 'boat', 'ship', 'airship'][engine.characterCommand(session, handles.get(this), 'vehicleType', []) + 1]; },
    set(value) { const id = ['walk', 'boat', 'ship', 'airship'].indexOf(value); if (id < 0) throw new RangeError('Unknown vehicle type'); engine.characterCommand(session, handles.get(this), 'vehicleType', [id - 1]); }
  });
  for (const field of ['vehicleGettingOn', 'vehicleGettingOff']) Object.defineProperty(player, '_' + field, { configurable: true,
    get() { return engine.characterCommand(session, handles.get(this), field, []); },
    set(value) { engine.characterCommand(session, handles.get(this), field, [Boolean(value)]); }
  });
  for (const method of ['getOnVehicle', 'getOffVehicle']) player[method] = function() { return engine.characterCommand(session, handles.get(this), method, []); };
  for (const type of ['Boat', 'Ship', 'Airship']) player['isIn' + type] = function() { return this._vehicleType === type.toLowerCase(); };
  player.vehicle = function() { return scope.$gameMap.vehicle(this._vehicleType); };
  player.isInVehicle = function() { return this.isInBoat() || this.isInShip() || this.isInAirship(); };
  player.areFollowersGathering = function() { return this.followers().isGathering(); };
  player.isDebugThrough = function() { return scope.Input.isPressed('control') && scope.$gameTemp.isPlaytest(); };
  player.canMove = function() {
    return !scope.$gameMap.isEventRunning() && !scope.$gameMessage.isBusy() && !this.isMoveRouteForcing() && !this.areFollowersGathering() &&
      !this._vehicleGettingOn && !this._vehicleGettingOff && (!this.isInVehicle() || this.vehicle().canMove());
  };
  player.canEncounter = function() { return !scope.$gameParty.hasEncounterNone() && scope.$gameSystem.isEncounterEnabled() && !this.isInAirship() && !this.isMoveRouteForcing() && !this.isDebugThrough(); };
  player.isCollided = function(x, y) { return !this.isThrough() && (this.pos(x, y) || this.followers().visibleFollowers().some(follower => follower.pos(x, y))); };
  scope.Game_Event.prototype.findProperPageIndex = function() {
    const pages = this.event().pages;
    for (let index = pages.length - 1; index >= 0; --index) if (this.meetsConditions(pages[index])) return index;
    return -1;
  };
  scope.Game_Event.prototype.meetsConditions = function(page) {
    const conditions = page.conditions;
    if (conditions.switch1Valid && !scope.$gameSwitches.value(conditions.switch1Id)) return false;
    if (conditions.switch2Valid && !scope.$gameSwitches.value(conditions.switch2Id)) return false;
    if (conditions.variableValid && scope.$gameVariables.value(conditions.variableId) < conditions.variableValue) return false;
    if (conditions.selfSwitchValid && scope.$gameSelfSwitches.value([this._mapId, this._eventId, conditions.selfSwitchCh]) !== true) return false;
    if (conditions.itemValid && !scope.$gameParty.hasItem(scope.$dataItems[conditions.itemId])) return false;
    if (conditions.actorValid && !scope.$gameParty.members().includes(scope.$gameActors.actor(conditions.actorId))) return false;
    return true;
  };
  scope.Game_Event.prototype.isCollidedWithPlayerCharacters = function(x, y) { return this.isNormalPriority() && scope.$gamePlayer.isCollided(x, y); };
  const character = scope.Game_CharacterBase.prototype;
  character.isNearTheScreen = function() {
    const width = scope.Graphics.width, height = scope.Graphics.height, tileWidth = scope.$gameMap.tileWidth(), tileHeight = scope.$gameMap.tileHeight();
    const x = this.scrolledX() * tileWidth + tileWidth / 2 - width / 2, y = this.scrolledY() * tileHeight + tileHeight / 2 - height / 2;
    return x >= -width && x <= width && y >= -height && y <= height;
  };
  character.pos = function(x, y) { return this._x === x && this._y === y; };
  character.isThrough = function() { return this._through; };
  character.posNt = function(x, y) { return this.pos(x, y) && !this.isThrough(); };
  for (const field of ['moveSpeed', 'pattern', 'tileId', 'jumpCount', 'movementSuccess', 'directionFix', 'stopCount', 'animationCount', 'stepAnime', 'walkAnime'])
    Object.defineProperty(character, '_' + field, { configurable: true,
      get() { return engine.entityField(handles.get(this), field); },
      set(value) { engine.entityField(handles.get(this), field, value); }
    });
  character.characterName = function() { return this._characterName; };
  character.tileId = function() { return this._tileId; };
  character.hasStepAnime = function() { return this._stepAnime; };
  character.hasWalkAnime = function() { return this._walkAnime; };
  character.maxPattern = function() { return 4; };
  character.pattern = function() { return this._pattern < 3 ? this._pattern : 1; };
  character.isOriginalPattern = function() { return this.pattern() === 1; };
  character.resetPattern = function() { this.setPattern(1); };
  character.updatePattern = function() {
    if (!this.hasStepAnime() && this._stopCount > 0) this.resetPattern();
    else this._pattern = (this._pattern + 1) % this.maxPattern();
  };
  Object.defineProperty(scope.Game_Event.prototype, '_originalPattern', { configurable: true,
    get() { return engine.characterCommand(session, handles.get(this), 'originalPattern', []); },
    set(value) { engine.characterCommand(session, handles.get(this), 'originalPattern', [value]); }
  });
  scope.Game_Event.prototype.isOriginalPattern = function() { return this.pattern() === this._originalPattern; };
  scope.Game_Event.prototype.resetPattern = function() { this.setPattern(this._originalPattern); };
  character.isJumping = function() { return this._jumpCount > 0; };
  character.isMovementSucceeded = function() { return this._movementSuccess; };
  character.isDirectionFixed = function() { return this._directionFix; };
  character.isDashing = function() { return false; };
  character.realMoveSpeed = function() { return this._moveSpeed + (this.isDashing() ? 1 : 0); };
  character.setMoveSpeed = function(value) { this._moveSpeed = value; };
  character.setPattern = function(value) { this._pattern = value; };
  character.setThrough = function(value) { this._through = Boolean(value); };
  character.setTransparent = function(value) { this._transparent = Boolean(value); };
  for (const method of ['requestAnimation', 'requestBalloon', 'isMoveRouteForcing', 'isNormalPriority', 'isObjectCharacter', 'jumpHeight', 'screenZ', 'jump']) character[method] = function(...args) { return engine.characterCommand(session, handles.get(this), method, args); };
  character.scrolledX = function() { return scope.$gameMap.adjustX(this._realX); };
  character.scrolledY = function() { return scope.$gameMap.adjustY(this._realY); };
  character.shiftY = function() { return this.isObjectCharacter() ? 0 : 6; };
  character.screenX = function() { return Math.round(this.scrolledX() * scope.$gameMap.tileWidth() + scope.$gameMap.tileWidth() / 2); };
  character.screenY = function() { return Math.round(this.scrolledY() * scope.$gameMap.tileHeight() + scope.$gameMap.tileHeight() - this.shiftY() - this.jumpHeight()); };
  for (const method of ['setMoveRoute', 'forceMoveRoute']) scope.Game_Character.prototype[method] = function(route) { engine.characterCommand(session, handles.get(this), method, [route]); };
  Object.assign(scope.Game_Character, { ROUTE_MOVE_DOWN: 1, ROUTE_MOVE_LEFT: 2, ROUTE_MOVE_RIGHT: 3, ROUTE_MOVE_UP: 4,
    ROUTE_MOVE_LOWER_L: 5, ROUTE_MOVE_LOWER_R: 6, ROUTE_MOVE_UPPER_L: 7, ROUTE_MOVE_UPPER_R: 8, ROUTE_SCRIPT: 45 });
}

module.exports = { installMapBindings };
