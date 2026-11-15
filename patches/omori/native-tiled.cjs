'use strict';

function installNativeTiled(runtime, engine, session, nativePosition, resolveTilesets) {
  const scope = runtime.scope, map = scope.Game_Map.prototype;
  const invoke = (method, ...args) => engine.tiledInvoke(session, method, args);
  const array = runtime.runScript('(function() { return []; })');
  const object = runtime.runScript('(function() { return {}; })');
  function guest(value) {
    if (value === null || typeof value !== 'object') return value;
    const result = Array.isArray(value) ? array() : object();
    for (const key of Object.keys(value)) result[key] = guest(value[key]);
    return result;
  }
  const matrix = runtime.runScript('(function() { var A=Array,fill=A.prototype.fill; return function(size,value) { var result=new A(size); fill.call(result,value); return result; }; })()');
  const apply = (table, level = 0) => engine.tiledApply(session, table, level, matrix);
  const parameters = scope.PluginManager.parameters('YED_Tiled');
  invoke('configure', parameters);
  scope.Imported ||= {};
  scope.Imported.YED_Tiled = true;
  scope.YED_TiledParameters = parameters;

  const manager = scope.DataManager;
  manager._tempTiledData = null; manager._tiledLoaded = false; manager._tilesetToLoad = 0;
  manager.loadTilesetData = function() {
    if (!this._tempTiledData) return;
    const resolved = resolveTilesets(this._tempTiledData);
    for (let index = 0; index < resolved.length; ++index) Object.assign(this._tempTiledData.tilesets[index], guest(resolved[index]));
    this._tilesetToLoad = 0;
  };
  manager.unloadTiledMapData = function() { this._tempTiledData = null; this._tiledLoaded = false; this._tilesetToLoad = 0; invoke('unload'); };
  const load = manager.loadMapData;
  manager.loadMapData = function(id) { this.unloadTiledMapData(); return load.call(this, id); };
  const loaded = manager.isMapLoaded;
  manager.isMapLoaded = function() { return loaded.call(this) && this._tiledLoaded && this._tilesetToLoad <= 0; };

  const fields = new WeakMap();
  function state(object) {
    if (!fields.has(object)) fields.set(object, {});
    return fields.get(object);
  }
  const tables = { _collisionMap: 'collision', _arrowCollisionMap: 'arrows', _regions: 'regions', _mapLevelChange: 'levelChanges' };
  const descriptors = {};
  for (const [field, name] of Object.entries(tables)) descriptors[field] = { configurable: true, enumerable: true,
    get() { return state(this)[field]; }, set(value) { state(this)[field] = value; invoke('bindTables', name, value); }
  };
  descriptors._reflection = { configurable: true, enumerable: true,
    get() { return state(this)._reflection; },
    set(value) { state(this)._reflection = value; invoke('bindReflections', value); }
  };
  descriptors._currentMapLevel = { configurable: true, enumerable: true,
    get() { return invoke('localLevel'); }, set(value) { invoke('localLevel', value); }
  };
  Object.defineProperties(map, descriptors);
  Object.defineProperty(map, 'tiledData', { configurable: true, get() { return manager._tempTiledData; } });
  Object.defineProperty(map, 'currentMapLevel', { configurable: true,
    get() { return invoke('level'); }, set(value) { invoke('level', value); }
  });
  map.isTiledMap = function() { return invoke('isTiledMap'); };
  map.isHalfTile = function() { return invoke('isHalfTile'); };
  map.isSaveEventLocations = function() { return invoke('saveEventLocations'); };
  map.checkMapLevelChanging = function(x, y) { return invoke('levelChange', x, y); };
  map.isOnReflection = function(character) {
    return invoke('containsReflection', character._realX, this.tileWidth(), character._realY, this.tileHeight());
  };
  map.getReflections = function(character) {
    return arrayFrom(invoke('reflections', character._realX, this.tileWidth(), character._realY, this.tileHeight()));
  };
  function arrayFrom(values) { const result = array(); for (const value of values) result.push(value); return result; }
  const passable = map.isPassable;
  map.isPassable = function(x, y, direction) {
    return this.isTiledMap() || typeof passable !== 'function' ? invoke('passable', x, y, direction) : passable.call(this, x, y, direction);
  };

  map._initializeMapLevel = function(level) { apply('initialize', level); };
  map._getTileProperties = function(id) { return invoke('tileProperties', id); };
  map._getArrowBit = function(value) { return invoke('arrowBit', value); };
  map._setupTiled = function() {
    this._initializeMapLevel(0); this._setupCollision(); this._setupRegion();
    this._setupMapLevelChange(); this._setupReflection(); this._setupTiledEvents();
  };
  map._setupCollision = function() { this._setupCollisionFull(); this._setupCollisionArrow(); };
  map._setupCollisionFull = function() { apply('collision'); };
  map._setupCollisionArrow = function() { apply('arrows'); };
  map._setupRegion = function() { apply('regions'); };
  map._setupMapLevelChange = function() { apply('levelChanges'); };
  map._setupReflection = function() {
    for (const reflection of guest(invoke('objects').reflectionAreas)) this._reflection.push(reflection);
  };
  map._setupTiledEvents = function() { invoke('setupEvents'); };
  const setup = map.setup;
  map.setup = function(id) {
    setup.call(this, id);
    this._isSetupBefore ||= object();
    Object.defineProperties(this, descriptors);
    if (this.isTiledMap()) invoke('initialize');
    for (const field of Object.keys(tables)) this[field] = array();
    this._reflection = array(); this._currentMapLevel = 0; this.currentMapLevel = 0;
    if (this.isTiledMap()) {
      scope.$dataMap.width = invoke('width'); scope.$dataMap.height = invoke('height');
      this._setupTiled(); this._isSetupBefore[id] = true;
    }
  };
  runtime.installTiledCharacters({ isOnReflection: map.isOnReflection, getReflections: map.getReflections,
    tileWidth: map.tileWidth, tileHeight: map.tileHeight, isTiledMap: map.isTiledMap }, map._initializeMapLevel);

  const trigger = scope.Game_Player.prototype.checkEventTriggerHere;
  scope.Game_Player.prototype._checkMapLevelChangingHere = function() { return scope.$gameMap.checkMapLevelChanging(this.x, this.y); };
  scope.Game_Player.prototype.checkEventTriggerHere = function(triggers) { trigger.call(this, triggers); this._checkMapLevelChangingHere(); };
  scope.ImageManager.loadParserTileset = function(file, hue) {
    return file ? this.loadNormalBitmap('img/tilesets/' + file.split('/').pop(), hue) : this.loadEmptyBitmap();
  };

  const BaseCharacterSprite = scope.Sprite_Character, basePrototype = BaseCharacterSprite.prototype;
  function Sprite_CharacterReflect() { return BaseCharacterSprite.apply(this, arguments); }
  Object.setPrototypeOf(Sprite_CharacterReflect, BaseCharacterSprite);
  Sprite_CharacterReflect.prototype = Object.create(basePrototype);
  Object.defineProperty(Sprite_CharacterReflect.prototype, 'constructor', { value: Sprite_CharacterReflect, configurable: true, writable: true });
  Sprite_CharacterReflect.prototype.initMembers = function() { basePrototype.initMembers.call(this); this.initializeReflection(); };
  Sprite_CharacterReflect.prototype.update = function() { basePrototype.update.call(this); this.updateReflect(); };
  Sprite_CharacterReflect.prototype.updatePosition = nativePosition;
  Sprite_CharacterReflect.prototype.updateReflect = scope.Sprite_Character.prototype.updateReflect;
  runtime.nativeTiledSprites = { reflectionPrototype: Sprite_CharacterReflect.prototype };
  const spriteset = scope.Spriteset_Map.prototype;
  const create = spriteset.createCharacters;
  spriteset.createCharacters = function() {
    create.call(this);
    const append = character => {
      const sprite = new Sprite_CharacterReflect(character);
      this._characterSprites.push(sprite); this._tilemap.addChild(sprite);
    };
    scope.$gameMap.events().forEach(append); scope.$gameMap.vehicles().forEach(append);
    scope.$gamePlayer.followers().reverseEach(append); append(scope.$gamePlayer);
  };
  const tilemap = spriteset.createTilemap;
  spriteset.createTilemap = function() {
    tilemap.call(this);
    this._tilemap.hideOnLevel = level => this.setMapLevel(level);
    if (scope.$gameMap.isTiledMap()) {
      this._reflectSurfaceSprite = new scope.Sprite(); this.addChild(this._reflectSurfaceSprite); this.createReflectionMask();
    }
  };
}

module.exports = { installNativeTiled };
