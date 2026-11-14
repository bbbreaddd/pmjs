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
  map.distance = function(x1, y1, x2, y2) { return Math.abs(this.deltaX(x1, x2)) + Math.abs(this.deltaY(y1, y2)); };
  map.canvasToMapX = function(x) { return this.roundX(Math.floor((this.displayX() * this.tileWidth() + x) / this.tileWidth())); };
  map.canvasToMapY = function(y) { return this.roundY(Math.floor((this.displayY() * this.tileHeight() + y) / this.tileHeight())); };
  for (const method of ['regionId', 'terrainTag', 'checkLayeredTilesFlags', 'changeTileset', 'changeBattleback', 'isDashDisabled', 'isNameDisplayEnabled'])
    map[method] = function(...args) { return invoke(method, ...args); };
  map.eraseEvent = function(id) { invoke('eraseEvent', id); };
  map.isAnyEventStarting = function() { return invoke('isAnyEventStarting'); };
  map.tilesetId = function() { return invoke('tilesetId'); };
  map.tileset = function() { return scope.$dataTilesets[this.tilesetId()]; };
  map.tilesetFlags = function() { const tileset=this.tileset();return tileset?tileset.flags:createArray([]); };
  for (const method of ['tileWidth', 'tileHeight', 'width', 'height', 'displayName', 'encounterStep', 'isLoopHorizontal', 'isLoopVertical', 'isEventRunning', 'displayX', 'displayY', 'battleback1Name', 'battleback2Name', 'isOverworld'])
    map[method] = function() { return invoke(method); };
  for (const field of ['displayX', 'displayY']) Object.defineProperty(map, '_' + field, {
    configurable: true,
    get() { return invoke(field); },
    set(value) { invoke(field, Number(value)); }
  });
  map.autotileType = function(x, y, z) { return invoke('autotileType', x, y, z); };
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
  system.saveBgm = function() { this._savedBgm = scope.AudioManager.saveBgm(); };
  system.replayBgm = function() { if (this._savedBgm) scope.AudioManager.replayBgm(this._savedBgm); };
  system.victoryMe = function() { return this._victoryMe || scope.$dataSystem.victoryMe; };
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
  player.isDebugThrough = function() { return Boolean(scope.Input?.isPressed('control') && scope.$gameTemp.isPlaytest()); };
  player.centerX = function() { return (scope.Graphics.width / scope.$gameMap.tileWidth() - 1) / 2; };
  player.centerY = function() { return (scope.Graphics.height / scope.$gameMap.tileHeight() - 1) / 2; };
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
  for (const field of ['moveSpeed', 'pattern', 'tileId', 'jumpCount', 'movementSuccess', 'directionFix', 'stopCount', 'animationCount', 'stepAnime', 'walkAnime', 'characterIndex', 'moveFrequency', 'bushDepth'])
    Object.defineProperty(character, '_' + field, { configurable: true,
      get() { return engine.entityField(handles.get(this), field); },
      set(value) { engine.entityField(handles.get(this), field, value); }
    });
  character.characterIndex = function() { return this._characterIndex; };
  character.moveFrequency = function() { return this._moveFrequency; };
  character.opacity = function() { return this._opacity; };
  character.setOpacity = function(value) { this._opacity = value; };
  character.setStepAnime = function(value) { this._stepAnime = value; };
  character.setWalkAnime = function(value) { this._walkAnime = value; };
  character.isTransparent = function() { return this._transparent; };
  character.resetStopCount = function() { this._stopCount = 0; };
  character.checkStop = function(threshold) { return this._stopCount > threshold; };
  character.animationWait = function() { return (9 - this.realMoveSpeed()) * 3; };
  character.regionId = function() { return scope.$gameMap.regionId(this._x, this._y); };
  for (const method of ['isMapPassable', 'isCollidedWithCharacters', 'isOnBush', 'increaseSteps', 'setImage'])
    character[method] = function(...args) { return engine.characterCommand(session, handles.get(this), method, args); };
  character.canPass = function(x, y, direction) {
    const map = scope.$gameMap, nx = map.roundXWithDirection(x, direction), ny = map.roundYWithDirection(y, direction);
    if (!map.isValid(nx, ny)) return false;
    if (this.isThrough() || this.isDebugThrough()) return true;
    return this.isMapPassable(x, y, direction) && !this.isCollidedWithCharacters(nx, ny);
  };
  character.isDebugThrough ||= function() { return false; };
  character.canPassDiagonally = function(x, y, horizontal, vertical) {
    const nx = scope.$gameMap.roundXWithDirection(x, horizontal), ny = scope.$gameMap.roundYWithDirection(y, vertical);
    return (this.canPass(x, y, vertical) && this.canPass(x, ny, horizontal)) || (this.canPass(x, y, horizontal) && this.canPass(nx, y, vertical));
  };
  map.roundXWithDirection = function(x, direction) { return this.roundX(x + (direction === 6 ? 1 : direction === 4 ? -1 : 0)); };
  map.roundYWithDirection = function(y, direction) { return this.roundY(y + (direction === 2 ? 1 : direction === 8 ? -1 : 0)); };
  const movable = scope.Game_Character.prototype;
  movable.moveForward = function() { this.moveStraight(this.direction()); };
  movable.turn180 = function() { this.setDirection(10 - this.direction()); };
  movable.turnRight90 = function() { this.setDirection({ 2: 4, 4: 8, 6: 2, 8: 6 }[this.direction()]); };
  movable.turnLeft90 = function() { this.setDirection({ 2: 6, 4: 2, 6: 8, 8: 4 }[this.direction()]); };
  movable.turnTowardCharacter = function(target) {
    const x = this.deltaXFrom(target.x), y = this.deltaYFrom(target.y);
    if (Math.abs(x) > Math.abs(y)) this.setDirection(x > 0 ? 4 : 6);
    else if (y !== 0) this.setDirection(y > 0 ? 8 : 2);
  };
  movable.turnAwayFromCharacter = function(target) {
    const x = this.deltaXFrom(target.x), y = this.deltaYFrom(target.y);
    if (Math.abs(x) > Math.abs(y)) this.setDirection(x > 0 ? 6 : 4);
    else if (y !== 0) this.setDirection(y > 0 ? 2 : 8);
  };
  movable.turnTowardPlayer = function() { this.turnTowardCharacter(scope.$gamePlayer); };
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
    ROUTE_WAIT: 15, ROUTE_CHANGE_OPACITY: 42, ROUTE_MOVE_LOWER_L: 5, ROUTE_MOVE_LOWER_R: 6, ROUTE_MOVE_UPPER_L: 7, ROUTE_MOVE_UPPER_R: 8, ROUTE_SCRIPT: 45 });
  const followers = scope.Game_Followers.prototype;
  followers.areGathering = function() { return this.isGathering(); };
  followers.isSomeoneCollided = function(x, y) { return this.visibleFollowers().some(follower => follower.pos(x, y)); };
  scope.Game_Vehicle.prototype.vehicle = function() { return scope.$dataSystem[this._type] || null; };
  scope.Game_Vehicle.prototype.loadSystemSettings = function() { engine.characterCommand(session, handles.get(this), 'loadSystemSettings', []); };
  scope.Game_CharacterBase.prototype.checkEventTriggerTouch = function(x, y) {};
  for (const method of ['updateStop', 'updateMove']) scope.Game_CharacterBase.prototype[method] = function() { return engine.characterCommand(session, handles.get(this), method, []); };
  scope.Game_Character.prototype.updateRoutineMove = function() { return engine.characterCommand(session, handles.get(this), 'updateRoutineMove', []); };
  for (const method of ['isStarting', 'lock', 'unlock', 'start', 'setupPageSettings', 'updateParallel', 'checkEventTriggerAuto']) scope.Game_Event.prototype[method] = function() { return engine.characterCommand(session, handles.get(this), method, []); };
  scope.Game_Event.prototype.isTriggerIn = function(triggers) { return triggers.includes(this._trigger); };
  for (const field of ['trigger', 'starting', 'locked', 'prelockDirection']) Object.defineProperty(scope.Game_Event.prototype, '_' + field, { configurable: true,
    get() { return engine.characterCommand(session, handles.get(this), 'event.' + field, []); },
    set(value) { engine.characterCommand(session, handles.get(this), 'event.' + field, [value]); }
  });
  for (const method of ['makeEncounterCount', 'makeEncounterTroopId', 'updateNonmoving']) scope.Game_Player.prototype[method] = function(...args) { return engine.characterCommand(session, handles.get(this), method, args); };
  scope.Game_Player.prototype.executeMove = function(direction) { this.moveStraight(direction); };
  scope.Game_Player.prototype.startMapEvent = function(x, y, triggers, normal) {
      if (!scope.$gameMap.isEventRunning()) {
          scope.$gameMap.eventsXy(x, y).forEach(function(event) {
              if (event.isTriggerIn(triggers) && event.isNormalPriority() === normal) {
                  event.start();
              }
          });
      }
  };
  
  scope.Game_Player.prototype.moveByInput = function() {
      if (!this.isMoving() && this.canMove()) {
          var direction = this.getInputDirection();
          if (direction > 0) {
              scope.$gameTemp.clearDestination();
          } else if (scope.$gameTemp.isDestinationValid()){
              var x = scope.$gameTemp.destinationX();
              var y = scope.$gameTemp.destinationY();
              direction = this.findDirectionTo(x, y);
          }
          if (direction > 0) {
              this.executeMove(direction);
          }
      }
  };
  
  scope.Game_Player.prototype.updateScroll = function(lastScrolledX, lastScrolledY) {
      var x1 = lastScrolledX;
      var y1 = lastScrolledY;
      var x2 = this.scrolledX();
      var y2 = this.scrolledY();
      if (y2 > y1 && y2 > this.centerY()) {
          scope.$gameMap.scrollDown(y2 - y1);
      }
      if (x2 < x1 && x2 < this.centerX()) {
          scope.$gameMap.scrollLeft(x1 - x2);
      }
      if (x2 > x1 && x2 > this.centerX()) {
          scope.$gameMap.scrollRight(x2 - x1);
      }
      if (y2 < y1 && y2 < this.centerY()) {
          scope.$gameMap.scrollUp(y1 - y2);
      }
  };
  
  scope.Game_Player.prototype.checkEventTriggerHere = function(triggers) {
      if (this.canStartLocalEvents()) {
          this.startMapEvent(this.x, this.y, triggers, false);
      }
  };
  
  scope.Game_Player.prototype.canStartLocalEvents = function() {
      return !this.isInAirship();
  };
  
  scope.Game_Player.prototype.isNormal = function() {
      return this._vehicleType === 'walk' && !this.isMoveRouteForcing();
  };
  
  scope.Game_Player.prototype.getInputDirection = function() {
      return scope.Input.dir4;
  };
  
  scope.Game_Event.prototype.checkEventTriggerTouch = function (x, y) {
      if (!scope.$gameMap.isEventRunning()) {
          if (this._trigger === 2 && scope.$gamePlayer.pos(x, y)) {
              if (!this.isJumping() && this.isNormalPriority()) {
                  this.start();
              }
          }
      }
  };
  return new Map([scope.Game_CharacterBase, scope.Game_Character, scope.Game_Player, scope.Game_Event, scope.Game_Follower, scope.Game_Vehicle].filter(Boolean).map(Type => [Type, Object.fromEntries(['canPass', 'canPassDiagonally', 'isMapPassable', 'isCollidedWithCharacters', 'isThrough', 'isDebugThrough'].map(name => [name, Type.prototype[name]]))]));
}

module.exports = { installMapBindings };
