'use strict';
const { createBitmapClass, createImageManager, bitmapHandle } = require('./native-bitmap.cjs');
const vm = require('node:vm');
const { installManagerReference } = require('./native-manager-reference.cjs');
const { createSceneBindings } = require('./native-scenes.cjs');
const { installTilemap } = require('./native-tilemap.cjs');
const { installClassBindings } = require('./native-class-bindings.cjs');
const { installTextManager, installSoundManager, installAudioManager } = require('./native-managers.cjs');
const { installBattlerBindings } = require('./native-battlers.cjs');
const { installPartyBindings } = require('./native-party.cjs');
const { installCoreUtilities } = require('./native-core-utilities.cjs');
const { installJsonEx } = require('./native-jsonex.cjs');
const { installBattleData } = require('./native-battle-data.cjs');
const { installMapBindings } = require('./native-game-map.cjs');
const { installActionBindings } = require('./native-actions.cjs');
const { installTroopBindings } = require('./native-troop.cjs');
const { installDataArray } = require('./native-data-arrays.cjs');

function createScriptRuntime(engine, session, options = {}) {
  const pictures = new WeakMap(), interpreters = new WeakMap(), sprites = new WeakMap(), frames = new WeakMap(), tones = new WeakMap();
  const registry = new Map(), roots = new Map(), spriteSlots = new Map(), scripts = new Map();
  const conditions = new Map();
  const values = new Map();
  const pictureChildren = [];
  const fields = ['_name', '_origin', '_x', '_y', '_scaleX', '_scaleY', '_opacity', '_blendMode',
    '_targetX', '_targetY', '_targetScaleX', '_targetScaleY', '_targetOpacity', '_duration',
    '_toneDuration', '_angle', '_rotationSpeed'];
  const defaults = Object.create(null);
  const collectionHandles = new WeakMap();
  const characters = new WeakMap(), actors = new WeakMap();
  let GuestArray;
  function decorateArray(array) {
    Object.defineProperties(array, {
      clone: { value() { return GuestArray.from(this); } },
      contains: { value(value) { return this.indexOf(value) >= 0; } }
    });
    return array;
  }

  function remember(object, handle, store) {
    if (store) store.set(object, handle);
    registry.set(handle.identity, new WeakRef(object));
    roots.set(handle.identity, object);
    return object;
  }
  function attachPicture(object, handle) {
    remember(object, handle, pictures);
    const collectionViews = new Map();
    for (const field of fields) Object.defineProperty(object, field, {
      configurable: true, enumerable: true,
      get() { return engine.pictureField(handle, field); },
      set(value) { engine.pictureField(handle, field, value); }
    });
    for (const field of ['_tone', '_toneTarget']) Object.defineProperty(object, field, {
      configurable: true, enumerable: true,
      get() {
        const tone = wrapTone(engine.pictureTone(session, handle, field));
        collectionViews.set(field, tone);
        return tone;
      },
      set(value) {
        if (value !== null && !tones.has(value)) throw new TypeError('Tone assignment requires a native tone array; tint() copies an ordinary array');
        engine.pictureTone(session, handle, field, value === null ? null : tones.get(value));
        collectionViews.set(field, value);
      }
    });
    return object;
  }
  function wrapTone(handle) {
    if (!handle) return null;
    const existing = registry.get(handle.identity)?.deref();
    if (existing) return existing;
    const tone = decorateArray([]);
    for (let i = 0; i < 4; ++i) Object.defineProperty(tone, i, {
      enumerable: true,
      get() { return engine.toneComponent(handle, i); },
      set(value) { engine.toneComponent(handle, i, Number(value)); }
    });
    Object.defineProperty(tone, 'length', { writable: false });
    return remember(tone, handle, tones);
  }
  function wrapCollection(handle) {
    if (!handle) return null;
    const existing = registry.get(handle.identity)?.deref();
    if (existing) return existing;
    const info = engine.collectionInfo(handle);
    if (info.branch) {
      const numeric = key => typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key);
      const object = new Proxy({}, {
        get(target, key, receiver) { return numeric(key) ? engine.collectionField(session, handle, key) : Reflect.get(target, key, receiver); },
        set(target, key, value, receiver) {
          if (!numeric(key)) return Reflect.set(target, key, value, receiver);
          engine.collectionField(session, handle, key, value); return true;
        },
        has(target, key) { return numeric(key) ? engine.collectionInfo(handle).keys.includes(key) : Reflect.has(target, key); },
        ownKeys(target) { return [...engine.collectionInfo(handle).keys, ...Reflect.ownKeys(target)]; },
        getOwnPropertyDescriptor(target, key) {
          if (!numeric(key)) return Reflect.getOwnPropertyDescriptor(target, key);
          if (!engine.collectionInfo(handle).keys.includes(key)) return undefined;
          return { configurable: true, enumerable: true, writable: true, value: engine.collectionField(session, handle, key) };
        },
        defineProperty(target, key, descriptor) {
          if (numeric(key)) throw new TypeError('Branch property descriptors are not bound');
          return Reflect.defineProperty(target, key, descriptor);
        },
        deleteProperty(target, key) { return numeric(key) ? engine.collectionDelete(session, handle, key) : Reflect.deleteProperty(target, key); },
        preventExtensions() { return false; }
      });
      return remember(object, handle, collectionHandles);
    }
    const object = info.array ? decorateArray([]) : {}, children = new Map();
    for (const key of info.keys) Object.defineProperty(object, key, {
      enumerable: true,
      get() {
        const value = engine.collectionField(session, handle, key);
        if (value !== null && typeof value === 'object') {
          const child = wrapCollection(value); children.set(key, child); return child;
        }
        return value;
      },
      set(value) { engine.collectionField(session, handle, key, value); }
    });
    if (info.array) Object.defineProperty(object, 'length', { writable: false });
    return remember(object, handle, collectionHandles);
  }
  function pictureHandle(object) {
    let handle = pictures.get(object);
    if (!handle) { handle = engine.createPicture(session); attachPicture(object, handle); }
    return handle;
  }
  function wrapPicture(handle) {
    return registry.get(handle.identity)?.deref() || attachPicture(Object.create(Game_Picture.prototype), handle);
  }
  function wrapInterpreter(handle) {
    let object = registry.get(handle.identity)?.deref();
    if (!object) {
      object = remember(Object.create(Game_Interpreter.prototype), handle, interpreters);
      for (const field of ['_mapId', '_eventId', '_index', '_waitCount', '_depth', '_indent']) Object.defineProperty(object, field, {
        configurable: true, enumerable: true,
        get() { return engine.interpreterField(session, handle, field); },
        set(value) { engine.interpreterField(session, handle, field, Number(value)); }
      });
      const views = new Map();
      for (const field of ['_list', '_params', '_branch']) Object.defineProperty(object, field, {
        configurable: true, enumerable: true,
        get() {
          const value = wrapCollection(engine.interpreterCollection(session, handle, field));
          views.set(field, value); return value;
        },
        ...(field === '_list' ? { set(value) {
          const source = value === null ? null : collectionHandles.get(value);
          if (value !== null && !source) throw new TypeError('Interpreter list assignment requires a native command array');
          engine.interpreterSetList(session, handle, source);
          views.set(field, value);
        } } : {})
      });
      Object.defineProperty(object, '_waitMode', {
        configurable: true, enumerable: true,
        get() { return engine.interpreterMode(session, handle); },
        set(mode) { engine.interpreterMode(session, handle, String(mode)); }
      });
      Object.defineProperty(object, '_comments', {
        configurable: true, enumerable: true,
        get() { return engine.interpreterField(session, handle, '_comments'); },
        set(value) { engine.interpreterField(session, handle, '_comments', String(value)); }
      });
    }
    return object;
  }
  function Game_Picture() { this.initialize.apply(this, arguments); }
  for (const name of ['initialize', 'initBasic', 'initTarget', 'initTone', 'initRotation',
    'show', 'move', 'tint', 'rotate', 'update', 'updateMove', 'updateTone', 'updateRotation']) {
    Game_Picture.prototype[name] = defaults[name] = function(...args) {
      return engine.pictureInvoke(session, pictureHandle(this), name, args);
    };
  }
  for (const [name, field] of [['name', '_name'], ['origin', '_origin'], ['x', '_x'], ['y', '_y'],
    ['scaleX', '_scaleX'], ['scaleY', '_scaleY'], ['opacity', '_opacity'],
    ['blendMode', '_blendMode'], ['angle', '_angle'], ['tone', '_tone']]) {
    Game_Picture.prototype[name] = function() { return this[field]; };
  }
  function Game_Interpreter() { throw new Error('Interpreter construction is not bound'); }
  const nativeLifecycle = Object.create(null);
  Game_Interpreter.requestImages = function(list, commonList) {
    if (!list || !scope.ImageManager) return;
    const handle = collectionHandles.get(list);
    if (!handle) throw new TypeError('Image requests require a native command list');
    for (const request of engine.imageRequests(session, handle)) {
      if (request.commonEvent !== undefined) {
        if (!commonList) commonList = [];
        if (!commonList.includes(request.commonEvent)) {
          commonList.push(request.commonEvent);
          Game_Interpreter.requestImages(wrapCollection(engine.commonEventList(session, request.commonEvent)), commonList);
        }
      } else scope.ImageManager[request.method](...request.arguments);
    }
  };
  for (const method of ['clear', 'setup', 'terminate']) {
    Game_Interpreter.prototype[method] = nativeLifecycle[method] = function(list, eventId = 0) {
      const handle = interpreters.get(this);
      if (!handle) throw new TypeError('Interpreter is not initialized');
      if (method !== 'setup') return engine.interpreterLifecycle(session, handle, method);
      const source = list === null ? null : collectionHandles.get(list);
      if (list !== null && !source) throw new TypeError('Interpreter setup requires a native command array');
      return engine.interpreterLifecycle(session, handle, method, source, Number(eventId));
    };
  }
  const nativeCommand = Object.create(null);
  const commandCodes = [
    101, 102, 103, 104, 105, 108, 111, 112, 113, 115, 117, 118, 119, 121, 122, 123, 124, 125,
    126, 127, 128, 129, 132, 133, 134, 135, 136, 137, 138, 139, 140, 201, 202, 203, 204, 205,
    206, 211, 212, 213, 214, 216, 217, 221, 222, 223, 224, 225, 230, 231, 232, 233, 234, 235,
    236, 241, 242, 243, 244, 245, 246, 249, 250, 251, 261, 281, 282, 283, 284, 285, 301, 302,
    303, 311, 312, 313, 314, 315, 316, 317, 318, 319, 320, 321, 322, 323, 324, 325, 326, 331,
    332, 333, 334, 335, 336, 337, 339, 340, 342, 351, 352, 353, 354, 355, 356, 402, 403, 411,
    413, 601, 602, 603
  ];
  for (const method of ['executeCommand', ...commandCodes.map(code => 'command' + code)]) {
    const code = method === 'executeCommand' ? null : Number(method.slice(7));
    Game_Interpreter.prototype[method] = nativeCommand[method] = function() {
      const handle = interpreters.get(this);
      if (!handle) throw new TypeError('Interpreter is not initialized');
      return engine.interpreterCommandInvoke(session, handle, code);
    };
  }
  Game_Interpreter.prototype.setWaitMode = function(mode) { this._waitMode = mode; };
  Game_Interpreter.prototype.wait = function(duration) { this._waitCount = duration; };
  Game_Interpreter.prototype.eventId = function() { return this._eventId; };
  const nativeControl = Object.create(null);
  Game_Interpreter.prototype.skipBranch = nativeControl.skipBranch = function() {
    return engine.interpreterControl(session, interpreters.get(this), 'skipBranch', [this._indent]);
  };
  for (const method of ['jumpTo', 'setupChoices', 'setupNumInput', 'setupItemChoice']) {
    Game_Interpreter.prototype[method] = nativeControl[method] = function(argument) {
      return engine.interpreterControl(session, interpreters.get(this), method, [argument]);
    };
  }
  Game_Interpreter.prototype.isOnCurrentMap = function() { return this._mapId === scope.$gameMap.mapId(); };
  Game_Interpreter.prototype.currentCommand = function() { return this._list[this._index]; };
  Game_Interpreter.prototype.nextEventCode = function() { return this._list[this._index + 1]?.code || 0; };
  Game_Interpreter.prototype.isRunning = function() { return engine.interpreterField(session, interpreters.get(this), 'running'); };
  const nativePluginCommand = Game_Interpreter.prototype.pluginCommand = function(command, args) {
    return engine.interpreterPluginCommand(session, interpreters.get(this), command, args);
  };
  const nativeWait = Object.create(null);
  for (const method of ['updateWait', 'updateWaitCount', 'updateWaitMode']) {
    Game_Interpreter.prototype[method] = nativeWait[method] = function() {
      const handle = interpreters.get(this);
      if (!handle) throw new TypeError('Interpreter is not initialized');
      return engine.interpreterWaitInvoke(session, handle, method);
    };
  }
  function Game_Message() { throw new Error('Message construction is engine-owned'); }
  const nativeMessage = Object.create(null);
  let choiceView = null;
  for (const method of ['clear', 'add', 'setFaceImage', 'setBackground', 'setPositionType', 'faceName', 'faceIndex',
    'background', 'positionType', 'hasText', 'isBusy', 'isChoice', 'isNumberInput', 'isItemChoice', 'isScrollMode',
    'scrollSpeed', 'scrollNoFast', 'setScroll', 'allText', 'setChoices', 'setChoiceBackground', 'setChoicePositionType',
    'choiceDefaultType', 'choiceCancelType', 'choiceBackground', 'choicePositionType']) {
    Game_Message.prototype[method] = nativeMessage[method] = function(...args) {
      const result = engine.messageInvoke(session, method, args);
      if (method === 'clear') { this._choiceCallback = null; choiceView = null; }
      return result;
    };
  }
  const gameMessage = Object.create(Game_Message.prototype);
  gameMessage._choiceCallback = null;
  Game_Message.prototype.choices = function() { choiceView = wrapCollection(engine.messageChoices(session)); return choiceView; };
  Object.defineProperty(gameMessage, '_choices', { configurable: true, enumerable: true, get() { return this.choices(); } });
  Game_Message.prototype.setChoiceCallback = function(callback) { this._choiceCallback = callback; };
  const nativeOnChoice = Game_Message.prototype.onChoice = function(index) {
    if (this._choiceCallback) { this._choiceCallback(index); this._choiceCallback = null; }
  };
  for (const field of ['_faceName', '_faceIndex', '_background', '_positionType', '_choiceBackground', '_choicePositionType']) {
    Object.defineProperty(gameMessage, field, {
      configurable: true, enumerable: true,
      get() { return engine.messageField(session, field); },
      set(value) { engine.messageField(session, field, value); }
    });
  }
  function Sprite_Picture() { throw new Error('Picture sprite construction is engine-owned'); }
  const spriteBitmaps = new WeakMap();
  Object.defineProperty(Sprite_Picture.prototype, '_pictureName', {
    configurable: true,
    get() { return engine.pictureBitmap(session, sprites.get(this), 'name'); },
    set(value) { engine.pictureBitmap(session, sprites.get(this), 'name', String(value)); }
  });
  Object.defineProperty(Sprite_Picture.prototype, 'bitmap', {
    configurable: true,
    get() { return spriteBitmaps.get(this) || null; },
    set(value) {
      engine.pictureBitmap(session, sprites.get(this), 'bitmap', value === null ? null : bitmapHandle(scope.Bitmap, value));
      spriteBitmaps.set(this, value);
    }
  });
  Sprite_Picture.prototype.initialize = function(id) { this._pictureId = id; };
  Sprite_Picture.prototype.picture = function() { return scope.$gameScreen.picture(this._pictureId); };
  Sprite_Picture.prototype.loadBitmap = function() { this.bitmap = scope.ImageManager.loadPicture(this._pictureName); };
  Sprite_Picture.prototype.updateBitmap = function() {
    if (!scope.ImageManager) return;
    const picture = this.picture();
    if (!picture) { this._pictureName = ''; this.bitmap = null; return; }
    const name = picture.name();
    if (name !== this._pictureName) { this._pictureName = name; this.loadBitmap(); }
  };
  Sprite_Picture.prototype.update = function() { this.updateBitmap(); this.updateOther(); };
  Sprite_Picture.prototype.updateOther = function() {
    engine.pictureInvoke(session, sprites.get(this), 'syncSprite');
  };
  Sprite_Picture.prototype.setFrame = function(x, y, width, height) {
    engine.pictureFrame(sprites.get(this), x, y, width, height);
  };
  Object.defineProperty(Sprite_Picture.prototype, '_frame', { get() {
    let frame = frames.get(this);
    if (!frame) {
      const sprite = this;
      frame = {};
      ['x', 'y', 'width', 'height'].forEach((field, index) => Object.defineProperty(frame, field, {
        enumerable: true,
        get() { return (engine.pictureFrame(sprites.get(sprite)) || [0, 0, 0, 0])[index]; },
        set(value) {
          const rect = engine.pictureFrame(sprites.get(sprite)) || [0, 0, 0, 0];
          rect[index] = Number(value);
          engine.pictureFrame(sprites.get(sprite), ...rect);
        }
      }));
      frames.set(sprite, frame);
    }
    return frame;
  } });
  function ensureSprite(handle) {
    const slot = handle.slot;
    if (slot < 0) return null;
    let sprite = spriteSlots.get(slot);
    if (!sprite || sprites.get(sprite).spriteIdentity !== handle.spriteIdentity) {
      sprite = Object.create(Sprite_Picture.prototype);
      spriteSlots.set(slot, sprite);
      sprites.set(sprite, handle);
      pictureChildren[slot > 100 ? slot - 100 : slot] = sprite;
      engine.pictureInvoke(session, handle, 'syncSprite');
      sprite.initialize(slot > 100 ? slot - 100 : slot);
    } else sprites.set(sprite, handle);
    return sprite;
  }
  function Point() { this.initialize.apply(this, arguments); }
  Point.prototype.initialize = function(x, y) { this.x = x || 0; this.y = y || 0; };
  function Rectangle() { this.initialize.apply(this, arguments); }
  Rectangle.prototype.initialize = function(x, y, width, height) {
    this.x = x || 0; this.y = y || 0; this.width = width || 0; this.height = height || 0;
  };
  Rectangle.emptyRectangle = new Rectangle(0, 0, 0, 0);
  const scope = { Game_Picture, Game_Interpreter, Game_Message, $gameMessage: gameMessage, Sprite_Picture, Point, Rectangle,
    $gameMap: { mapId: () => engine.mapId(session),
      get _mapId() { return engine.mapId(session); },
      requestRefresh() { engine.gameDataInvoke(session, 'variables', 'onChange', []); } },
    $gameScreen: { picture(id) {
      const handle = engine.picture(session, id);
      if (!handle) return null;
      const picture = wrapPicture(handle);
      ensureSprite(handle);
      return picture;
    } },
    SceneManager: { _scene: { _spriteset: { _pictureContainer: { children: pictureChildren } } } }
  };
  const gameDataDefaults = new Map(), gameDataStores = new Map();
  for (const [name, kind] of [['Game_Variables', 'variables'], ['Game_Switches', 'switches'], ['Game_SelfSwitches', 'selfSwitches']]) {
    const Type = { [name]: function() { throw new Error(name + ' construction is engine-owned'); } }[name];
    const defaults = {};
    for (const method of ['clear', 'value', 'setValue', 'onChange']) Type.prototype[method] = defaults[method] = function(...args) {
      return engine.gameDataInvoke(session, kind, method, args);
    };
    Type.prototype.initialize = function() { this.clear(); };
    if (kind !== 'selfSwitches') installDataArray(Type.prototype, engine, session, kind, values => GuestArray.from(values));
    const object = Object.create(Type.prototype);
    scope[name] = Type; scope['$game' + name.slice(5)] = object;
    gameDataDefaults.set(kind, defaults); gameDataStores.set(kind, object);
  }
  function Game_Screen() { throw new Error('Game_Screen construction is engine-owned'); }
  const screenDefaults = {};
  Game_Screen.prototype.picture = scope.$gameScreen.picture;
  delete scope.$gameScreen.picture;
  for (const method of ['startTint', 'startFlash', 'startShake', 'startFadeOut', 'startFadeIn', 'startZoom', 'setZoom', 'changeWeather',
    'showPicture', 'movePicture', 'rotatePicture', 'tintPicture', 'erasePicture',
    'clearFade', 'clearTone', 'clearFlash', 'clearShake', 'clearZoom', 'clearWeather', 'brightness', 'shake', 'zoomX', 'zoomY', 'zoomScale', 'weatherType', 'weatherPower'])
    Game_Screen.prototype[method] = screenDefaults[method] = function(...args) { return engine.gameDataInvoke(session, 'screen', method, args); };
  Object.setPrototypeOf(scope.$gameScreen, Game_Screen.prototype);
  scope.Game_Screen = Game_Screen;
  gameDataDefaults.set('screen', screenDefaults); gameDataStores.set('screen', scope.$gameScreen);
  function Game_Timer() { throw new Error('Game_Timer construction is engine-owned'); }
  const timerDefaults={};
  for (const method of ['initialize','start','stop','update','seconds','isWorking','onExpire'])
    Game_Timer.prototype[method]=timerDefaults[method]=function(...args) { return engine.gameDataInvoke(session,'timer',method,args); };
  for (const [field,method] of [['_frames','frames'],['_working','working']]) Object.defineProperty(Game_Timer.prototype,field,{
    configurable:true,get() { return engine.gameDataInvoke(session,'timer',method,[]); },set(value) { engine.gameDataInvoke(session,'timer',method,[value]); }
  });
  scope.Game_Timer=Game_Timer; scope.$gameTimer=Object.create(Game_Timer.prototype);
  gameDataDefaults.set('timer',timerDefaults); gameDataStores.set('timer',scope.$gameTimer);
  function Game_System() { throw new Error('Game_System construction is engine-owned'); }
  Game_System.prototype.isSideView = function() { return engine.gameDataInvoke(session, 'system', 'isSideView', []); };
  Game_System.prototype.initialize = function() { engine.gameDataInvoke(session, 'system', 'initialize', []); };
  for (const name of ['save', 'menu', 'encounter', 'formation']) {
    const field = name + 'Enabled', label = name[0].toUpperCase() + name.slice(1);
    Object.defineProperty(Game_System.prototype, '_' + field, { configurable: true,
      get() { return engine.gameDataInvoke(session, 'system', field, []); },
      set(value) { engine.gameDataInvoke(session, 'system', field, [value]); }
    });
    Game_System.prototype['is' + label + 'Enabled'] = function() { return this['_' + field]; };
    Game_System.prototype['enable' + label] = function() { this['_' + field] = true; };
    Game_System.prototype['disable' + label] = function() { this['_' + field] = false; };
  }
  for (const name of ['battleCount', 'winCount', 'escapeCount', 'saveCount']) {
    Object.defineProperty(Game_System.prototype, '_' + name, { configurable: true,
      get() { return engine.gameDataInvoke(session, 'system', name, []); },
      set(value) { engine.gameDataInvoke(session, 'system', name, [value]); }
    });
    Game_System.prototype[name] = function() { return this['_' + name]; };
  }
  scope.Game_System = Game_System; scope.$gameSystem = Object.create(Game_System.prototype);
  function Game_Temp() { throw new Error('Game_Temp construction is engine-owned'); }
  Game_Temp.prototype.initialize = function() {
    engine.gameDataInvoke(session, 'temp', 'initialize', []);
    this._isPlaytest = scope.Utils.isOptionValid('test');
  };
  Game_Temp.prototype.isPlaytest = function() { return this._isPlaytest; };
  for (const method of ['reserveCommonEvent', 'clearCommonEvent', 'isCommonEventReserved',
    'setDestination', 'clearDestination', 'isDestinationValid', 'destinationX', 'destinationY'])
    Game_Temp.prototype[method] = function(...args) { return engine.gameDataInvoke(session, 'temp', method, args); };
  Game_Temp.prototype.reservedCommonEvent = function() {
    return scope.$dataCommonEvents[engine.gameDataInvoke(session, 'temp', 'commonEventId', [])];
  };
  scope.Game_Temp = Game_Temp; scope.$gameTemp = Object.create(Game_Temp.prototype);
  scope.BattleManager = Object.assign(function BattleManager() { throw new Error('BattleManager is a static class'); }, {
    isInputting() { return engine.gameDataInvoke(session, 'battle', 'isInputting', []); }
  });
  function Game_Party() { throw new Error('Game_Party construction is engine-owned'); }
  const partyDefaults = {};
  for (const method of ['initialize', 'gold', 'inBattle'])
    Game_Party.prototype[method] = partyDefaults[method] = function() { return engine.gameDataInvoke(session, 'party', method, []); };
  Game_Party.prototype.allMembers = function() { return decorateArray(engine.gameDataInvoke(session, 'party', 'members', []).map(id => scope.$gameActors.actor(id))); };
  Game_Party.prototype.members = function() { return this.allMembers(); };
  scope.Game_Party = Game_Party; scope.$gameParty = Object.create(Game_Party.prototype);
  gameDataDefaults.set('party', partyDefaults); gameDataStores.set('party', scope.$gameParty);
  for (const [category, field] of ['_items', '_weapons', '_armors'].entries()) {
    const invoke = (method, ...args) => engine.gameDataInvoke(session, 'inventory', method, [category, ...args]);
    const itemId = key => typeof key === 'string' && /^[1-9][0-9]*$/.test(key) && Number(key) < 100000 ? Number(key) : null;
    const view = new Proxy({}, {
      get(target, key) { const id = itemId(key); return id === null ? Reflect.get(target, key) : invoke('value', id); },
      set(target, key, value) { const id = itemId(key); if (id === null) throw new TypeError('Inventory keys must be item IDs'); invoke('set', id, value); return true; },
      deleteProperty(target, key) { const id = itemId(key); if (id === null) return false; invoke('delete', id); return true; },
      ownKeys() { return Object.keys(invoke('read')); },
      has(target, key) { const id = itemId(key); return id === null ? Reflect.has(target, key) : invoke('value', id) !== undefined; },
      getOwnPropertyDescriptor(target, key) { const id = itemId(key); const value = id === null ? undefined : invoke('value', id); return value === undefined ? undefined : { configurable: true, enumerable: true, writable: true, value }; },
      defineProperty() { throw new TypeError('Inventory property descriptors are not supported'); },
      preventExtensions() { throw new TypeError('Inventory dictionaries must remain extensible'); }
    });
    // Replacements import snapshots. Retaining aliases to assigned plain objects
    // is outside this dictionary binding's contract.
    Object.defineProperty(Game_Party.prototype, field, { configurable: true, get() { return view; }, set(value) { invoke('replace', value); } });
  }
  function Game_CharacterBase() { throw new Error('Character construction is engine-owned'); }
  function Game_Character() { this.initialize.apply(this, arguments); }
  Game_Character.prototype = Object.create(Game_CharacterBase.prototype); Game_Character.prototype.constructor = Game_Character;
  function Game_Player() { this.initialize.apply(this, arguments); }
  Game_Player.prototype = Object.create(Game_Character.prototype); Game_Player.prototype.constructor = Game_Player;
  function Game_Follower() { this.initialize.apply(this, arguments); }
  Game_Follower.prototype = Object.create(Game_Character.prototype); Game_Follower.prototype.constructor = Game_Follower;
  Game_Follower.prototype.initialize = function(memberIndex) {
    const handle=engine.entity(session, 'character', -memberIndex-1);
    if (!handle) throw new RangeError('Native follower index is outside the party capacity');
    remember(this,handle,characters);
    engine.characterCommand(session,handle,'initialize',[]);
  };
  Object.defineProperty(Game_Follower.prototype,'_memberIndex',{ configurable:true,get() { return -engine.entityField(characters.get(this),'id')-1; } });
  Game_Follower.prototype.actor = function() { return scope.$gameParty.battleMembers()[this._memberIndex] || null; };
  Game_Follower.prototype.isVisible = function() { return Boolean(this.actor()) && scope.$gamePlayer.followers().isVisible(); };
  Game_Follower.prototype.update = function() { engine.characterCommand(session,characters.get(this),'update',[]); };
  function Game_Followers() { this.initialize.apply(this,arguments); }
  Game_Followers.prototype.initialize = function() { this._data=[1,2,3].map(index => new Game_Follower(index)); };
  const followerInvoke=(method,...args) => engine.characterCommand(session,engine.entity(session,'character',-1),'followers.'+method,args);
  Game_Followers.prototype.isVisible=function() { return followerInvoke('visible'); };
  Game_Followers.prototype.show=function() { followerInvoke('visible',true); };
  Game_Followers.prototype.hide=function() { followerInvoke('visible',false); };
  Game_Followers.prototype.follower=function(index) { return this._data[index]; };
  Game_Followers.prototype.forEach=function(callback,thisArg) { this._data.forEach(callback,thisArg); };
  Game_Followers.prototype.reverseEach=function(callback,thisArg) { this._data.slice().reverse().forEach(callback,thisArg); };
  Game_Followers.prototype.visibleFollowers=function() { return this._data.filter(follower => follower.isVisible()); };
  for (const method of ['gather','isGathering','isGathered','updateMove','jumpAll','synchronize','refresh','update'])
    Game_Followers.prototype[method]=function(...args) { return followerInvoke(method,...args); };
  Game_Followers.prototype.areMoving=function() { return followerInvoke('isMoving'); };
  let followers;
  Game_Player.prototype.followers=function() { return followers ||= new Game_Followers(); };
  function Game_Vehicle() { this.initialize.apply(this,arguments); }
  Game_Vehicle.prototype=Object.create(Game_Character.prototype); Game_Vehicle.prototype.constructor=Game_Vehicle;
  Game_Vehicle.prototype.initialize=function(type) {
    const index=['boat','ship','airship'].indexOf(type);
    if (index<0) throw new RangeError('Unknown vehicle type: '+type);
    remember(this,engine.entity(session,'character',-5-index),characters);
  };
  Object.defineProperty(Game_Vehicle.prototype,'_type',{ configurable:true,get() { return ['boat','ship','airship'][-engine.entityField(characters.get(this),'id')-5]; } });
  for (const type of ['Boat','Ship','Airship']) Game_Vehicle.prototype['is'+type]=function() { return this._type===type.toLowerCase(); };
  Game_Vehicle.prototype.isLandOk=function(x,y,direction) { return engine.characterCommand(session,characters.get(this),'isLandOk',[x,y,direction]); };
  function Game_Event() { this.initialize.apply(this, arguments); }
  Game_Event.prototype = Object.create(Game_Character.prototype); Game_Event.prototype.constructor = Game_Event;
  function Game_BattlerBase() { throw new Error('Battler construction is engine-owned'); }
  Game_BattlerBase.prototype.maxTp = function() { return 100; };
  function Game_Battler() { throw new Error('Battler construction is engine-owned'); }
  Game_Battler.prototype = Object.create(Game_BattlerBase.prototype); Game_Battler.prototype.constructor = Game_Battler;
  function Game_Enemy() { throw new Error('Enemy construction is engine-owned'); }
  Game_Enemy.prototype = Object.create(Game_Battler.prototype); Game_Enemy.prototype.constructor = Game_Enemy;
  for (const field of ['screenX', 'screenY']) Object.defineProperty(Game_Enemy.prototype, '_' + field, {
    configurable: true, get() { return engine.entityField(actors.get(this), field); },
    set(value) { engine.entityField(actors.get(this), field, value); }
  });
  Game_Enemy.prototype.screenX = function() { return this._screenX; };
  Game_Enemy.prototype.screenY = function() { return this._screenY; };
  Game_BattlerBase.prototype.isActor = function() { return !engine.entityField(actors.get(this), 'enemy'); };
  Game_BattlerBase.prototype.isEnemy = function() { return engine.entityField(actors.get(this), 'enemy'); };
  Game_BattlerBase.prototype.attackSkillId = function() { return 1; };
  function Game_Action(subject, forcing = false) { this.initialize(subject, forcing); }
  Game_Action.prototype.initialize = function(subject, forcing) { this._subject = subject; this._forcing = forcing; this.clear(); };
  Game_Action.prototype.clear = function() { this._itemId = 0; this._isItem = false; this._targetIndex = -1; };
  Game_Action.prototype.subject = function() { return this._subject; };
  Game_Action.prototype.setSkill = function(id) { this._itemId = id; this._isItem = false; };
  Game_Action.prototype.setItem = function(id) { this._itemId = id; this._isItem = true; };
  Game_Action.prototype.item = function() { return scope[this._isItem ? '$dataItems' : '$dataSkills'][this._itemId]; };
  Game_Action.prototype.isPhysical = function() { return this.item().hitType === 1; };
  Game_Action.prototype.isMagical = function() { return this.item().hitType === 2; };
  Game_Action.prototype.isCertainHit = function() { return this.item().hitType === 0; };
  Game_Action.prototype.isSkill = function() { return this._itemId > 0 && !this._isItem; };
  Game_Action.prototype.isItem = function() { return this._itemId > 0 && this._isItem; };
  Game_Action.prototype.setTarget = function(index) { this._targetIndex = index; };
  const nativeActionRates = {};
  for (const method of ['itemHit', 'itemEva']) Game_Action.prototype[method] = nativeActionRates[method] = function(target) {
    return engine.actionRate(session, actors.get(this.subject()), actors.get(target), method, this._isItem, this._itemId);
  };
  scope.Game_Action = Game_Action;
  function Game_Actor() { throw new Error('Actor construction is engine-owned'); }
  Game_Actor.prototype = Object.create(Game_Battler.prototype); Game_Actor.prototype.constructor = Game_Actor;
  function entityProperty(type, store, name, field, writable = true) {
    Object.defineProperty(type.prototype, name, {
      configurable: true, enumerable: true,
      get() { return engine.entityField(store.get(this), field); },
      ...(writable ? { set(value) { engine.entityField(store.get(this), field, value); } } : {})
    });
  }
  for (const field of ['x', 'y', 'realX', 'realY', 'direction', 'opacity', 'transparent', 'through', 'characterName', 'moveRouteIndex'])
    entityProperty(Game_CharacterBase, characters, '_' + field, field);
  for (const field of ['x', 'y']) entityProperty(Game_CharacterBase, characters, field, field, false);
  Game_CharacterBase.prototype.direction = function() { return this._direction; };
  Game_CharacterBase.prototype.isMoving = function() { return this._realX !== this._x || this._realY !== this._y; };
  Game_Player.prototype.isDashing = function() { return engine.characterCommand(session, characters.get(this), 'isDashing', []); };
  Game_CharacterBase.prototype.locate = function(x, y) { engine.characterCommand(session, characters.get(this), 'locate', [x, y]); };
  Game_CharacterBase.prototype.setDirection = function(direction) { engine.characterCommand(session, characters.get(this), 'setDirection', [direction]); };
  for (const method of ['findDirectionTo', 'moveStraight', 'setMovementSuccess', 'setPosition', 'refresh', 'update'])
    Game_CharacterBase.prototype[method] = function(...args) { return engine.characterCommand(session, characters.get(this), method, args); };
  Game_Event.prototype.eventId = function() { return engine.entityField(characters.get(this), 'id'); };
  entityProperty(Game_Event, characters, '_mapId', 'mapId', false);
  entityProperty(Game_Event, characters, '_eventId', 'id', false);
  for (const field of ['hp', 'mp', 'tp', 'name', 'nickname']) entityProperty(Game_Actor, actors, '_' + field, field);
  for (const field of ['hp', 'mp', 'tp']) entityProperty(Game_BattlerBase, actors, field, field, false);
  Game_Actor.prototype.actorId = function() { return engine.entityField(actors.get(this), 'id'); };
  entityProperty(Game_Actor, actors, '_actorId', 'id');
  entityProperty(Game_Actor, actors, '_classId', 'classId');
  entityProperty(Game_Enemy, actors, '_enemyId', 'id');
  Game_Actor.prototype.actor = function() { return scope.$dataActors[this._actorId]; };
  Game_Actor.prototype.currentClass = function() { return scope.$dataClasses[this._classId]; };
  Game_Enemy.prototype.enemy = function() { return scope.$dataEnemies[this._enemyId]; };
  const context = vm.createContext(scope);
  GuestArray = vm.runInContext("Array", context);
  installCoreUtilities({ runScript(source) { return vm.runInContext(source, context); } });
  installManagerReference({ scope, runScript: (source, filename) => new vm.Script(source, { filename }).runInContext(context) }, 'DataManager');
  const referenceDatabaseLoad = scope.DataManager.loadDatabase;
  installTextManager(scope);
  for (const [method, table] of Object.entries({ isSkill: '$dataSkills', isItem: '$dataItems', isWeapon: '$dataWeapons', isArmor: '$dataArmors' }))
    scope.DataManager[method] = function(item) { return item && scope[table].includes(item); };
  Game_Actor.prototype.name = function() { return this._name; };
  Game_Actor.prototype.isStateAffected = function(id) { return engine.actorState(actors.get(this), id); };
  const nativeActorMethods = {};
  for (const method of ['initMembers', 'initSkills'])
    Game_Actor.prototype[method] = nativeActorMethods[method] = function() { return engine.actorInvoke(session, actors.get(this), method); };
  function wrapEntity(handle, type, store) {
    if (!handle) return null;
    return registry.get(handle.identity)?.deref() || remember(Object.create((scope[type.name] || type).prototype), handle, store);
  }
  Object.assign(scope, { Game_CharacterBase, Game_Character, Game_Player, Game_Follower, Game_Followers, Game_Vehicle, Game_Event, Game_BattlerBase, Game_Battler, Game_Enemy, Game_Actor });
  installBattleData(scope, values => GuestArray.from(values));
  installBattlerBindings(scope, engine, session, actors, values => GuestArray.from(values));
  installActionBindings(scope);
  Object.defineProperty(scope, '$gamePlayer', { configurable: true, enumerable: true,
    get() { return wrapEntity(engine.entity(session, 'character', -1), Game_Player, characters); } });
  function Game_Actors() { throw new Error('Game_Actors construction is engine-owned'); }
  Game_Actors.prototype.actor = function(id) { return wrapEntity(engine.entity(session, 'actor', id), Game_Actor, actors); };
  scope.Game_Actors = Game_Actors; scope.$gameActors = Object.create(Game_Actors.prototype);
  const actorIds = () => engine.gameDataInvoke(session, 'actors', 'ids', []);
  const actorArray = new Proxy(GuestArray.from([]), {
    get(target, key, receiver) {
      if (key === 'length') return Math.max(0, ...actorIds()) + 1;
      if (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)) return actorIds().includes(Number(key)) ? scope.$gameActors.actor(Number(key)) : null;
      return Reflect.get(target, key, receiver);
    },
    ownKeys(target) { target.length = Math.max(0, ...actorIds()) + 1; return [...new Set(actorIds().map(String).concat(Reflect.ownKeys(target)))]; },
    getOwnPropertyDescriptor(target, key) {
      if (key === 'length') { target.length = Math.max(0, ...actorIds()) + 1; return Reflect.getOwnPropertyDescriptor(target, key); }
      return typeof key === 'string' && actorIds().includes(Number(key)) ? { configurable: true, enumerable: true, writable: true, value: scope.$gameActors.actor(Number(key)) } : Reflect.getOwnPropertyDescriptor(target, key);
    }
  });
  Object.defineProperty(Game_Actors.prototype, '_data', { configurable: true, get() { return actorArray; } });
  installPartyBindings(scope, engine, session, values => GuestArray.from(values));
  installTroopBindings(scope, engine, session, index => wrapEntity(engine.entity(session, 'enemy', index), Game_Enemy, actors), values => GuestArray.from(values));
  function Game_Map() { throw new Error('Game_Map construction is engine-owned'); }
  Object.defineProperties(Game_Map.prototype, Object.getOwnPropertyDescriptors(scope.$gameMap));
  for (const key of Object.keys(scope.$gameMap)) delete scope.$gameMap[key];
  Object.setPrototypeOf(scope.$gameMap, Game_Map.prototype); scope.Game_Map = Game_Map;
  const nativeMapSetup = Game_Map.prototype.setup = function(mapId) {
    if (this !== scope.$gameMap) throw new Error('Detached map setup is not bound');
    return engine.gameDataInvoke(session, 'map', 'setup', [Number(mapId)]);
  };
  const nativeMapInitialize = Game_Map.prototype.initialize = function() {
    if (this !== scope.$gameMap) throw new Error('Detached map initialization is not bound');
    return engine.gameDataInvoke(session, 'map', 'initialize', []);
  };
  Game_Map.prototype.autoplay = function() {
    if (this !== scope.$gameMap) throw new Error('Detached map autoplay is not bound');
    return engine.gameDataInvoke(session, 'map', 'autoplay', []);
  };
  const nativeMapSetupScroll = Game_Map.prototype.setupScroll = function() {
    if (this !== scope.$gameMap) throw new Error('Detached map scrolling is not bound');
    return engine.gameDataInvoke(session, 'map', 'setupScroll', []);
  };
  gameDataDefaults.set('map', { setup: nativeMapSetup, initialize: nativeMapInitialize, setupScroll: nativeMapSetupScroll });
  gameDataStores.set('map', scope.$gameMap);
  Object.defineProperty(Game_Map.prototype, '_events', { configurable: true, get() {
    const result = GuestArray.from([null]); for (const event of this.events()) result[event.eventId()] = event; return result;
  } });
  Object.defineProperty(Game_Map.prototype, '_interpreter', { configurable: true, get() { return wrapInterpreter(engine.scriptInterpreter(session, 0)); } });
  Object.defineProperty(Game_Event.prototype, '_interpreter', { configurable: true, get() { const handle = engine.scriptInterpreter(session, this.eventId()); return handle ? wrapInterpreter(handle) : null; } });
  Game_Map.prototype.event = function(id) { return wrapEntity(engine.entity(session, 'character', id), Game_Event, characters); };
  installMapBindings(scope, engine, session, values => GuestArray.from(values), characters);
  Game_Map.prototype.camTargetSet = function(target, speed) {
    const handle = characters.get(target);
    if (!handle) throw new TypeError('Camera target must be a native character');
    engine.characterCommand(session, handle, 'cameraTarget', [speed]);
  };
  Object.defineProperty(Game_Map.prototype, 'camNorm', { configurable: true,
    get() { return engine.gameDataInvoke(session, 'map', 'cameraNormal', []); },
    set(value) { engine.gameDataInvoke(session, 'map', 'cameraNormal', [value]); } });
  scope.Utils = function() { throw new Error('Utils is a static class'); };
  for (const field of ['RPGMAKER_NAME', 'RPGMAKER_VERSION']) scope.Utils[field] = engine.utilsInvoke(session, field);
  for (const method of ['isNwjs', 'canReadGameFiles', 'isSupportPassiveEvent', 'rgbToCssColor', 'escapeHtml'])
    scope.Utils[method] = (...args) => engine.utilsInvoke(session, method, args);
  for (const method of ['isMobileDevice', 'isMobileSafari', 'isAndroidChrome'])
    scope.Utils[method] = () => engine.utilsInvoke(session, method, [scope.navigator?.userAgent || '']);
  scope.Utils._id = 1;
  scope.Utils.generateRuntimeId = function() { return this._id++; };
  scope.Utils.isOptionValid = name => engine.utilsInvoke(session, 'isOptionValid', [String(name), options.guestArguments || [], '']);
  const touchHandlers = {
    mousedown: '_onMouseDown', mousemove: '_onMouseMove', mouseup: '_onMouseUp', wheel: '_onWheel',
    touchstart: '_onTouchStart', touchmove: '_onTouchMove', touchend: '_onTouchEnd', touchcancel: '_onTouchCancel', pointerdown: '_onPointerDown'
  };
  scope.TouchInput = {};
  for (const method of ['clear', 'update', 'isPressed', 'isTriggered', 'isCancelled', 'isMoved', 'isReleased', 'isRepeated', 'isLongPressed'])
    scope.TouchInput[method] = () => engine.touchInvoke(session, method);
  for (const method of ['_onLeftButtonDown', '_onMiddleButtonDown', '_onRightButtonDown', ...Object.values(touchHandlers).filter(name => name !== '_onMouseDown')])
    scope.TouchInput[method] = event => engine.touchInvoke(session, method, event);
  scope.TouchInput._onMouseDown = function(event) {
    if (event.button === 0) this._onLeftButtonDown(event);
    else if (event.button === 1) this._onMiddleButtonDown(event);
    else if (event.button === 2) this._onRightButtonDown(event);
  };
  for (const field of ['x', 'y', 'wheelX', 'wheelY', 'date', 'keyRepeatWait', 'keyRepeatInterval']) Object.defineProperty(scope.TouchInput, field, {
    configurable: true, enumerable: true,
    get() { return engine.touchInvoke(session, field); },
    ...(['keyRepeatWait', 'keyRepeatInterval'].includes(field) ? { set(value) { engine.touchInvoke(session, field, value); } } : {})
  });
  const touchTransitions = new Map();
  for (const method of ['_onTrigger', '_onCancel', '_onMove', '_onRelease']) {
    const base = scope.TouchInput[method] = function(x, y) { engine.touchInvoke(session, method, { x, y }); };
    touchTransitions.set(method, base);
  }
  if (options.native) {
    scope.Bitmap = createBitmapClass(options.native, null, null, () => scope.CanvasRenderingContext2D);
    scope.ImageManager = createImageManager(options.native, scope.Bitmap, scope.RequestQueue);
    scope.ImageCache = scope.ImageManager._imageCache.constructor;
  }
  vm.runInContext(`Object.defineProperties(Array.prototype, {
    equals: {value: function(other) {
      if (!other || this.length !== other.length) return false;
      for (var index = 0; index < this.length; ++index) {
        var value = this[index], compared = other[index];
        if (value instanceof Array && compared instanceof Array) { if (!value.equals(compared)) return false; }
        else if (value !== compared) return false;
      }
      return true;
    }},
    clone: {value: function() {return this.slice(0);}},
    contains: {value: function(value) {return this.indexOf(value) >= 0;}}
  }); String.prototype.contains = function(value) {return this.indexOf(value) >= 0;};
  Number.prototype.clamp = function(min, max) { return Math.min(Math.max(this, min), max); };
  Number.prototype.mod = function(divisor) { return ((this % divisor) + divisor) % divisor; };
  String.prototype.format = function(...args) { return this.replace(/%([0-9]+)/g, (match, index) => args[Number(index) - 1]); };
  String.prototype.padZero = function(length) { var value = this; while (value.length < length) value = '0' + value; return value; };
  Number.prototype.padZero = function(length) { return String(this).padZero(length); };
  Math.randomInt = function(max) {return Math.floor(max * Math.random());};`, context);
  GuestArray = vm.runInContext('Array', context);
  installJsonEx({ scope, runScript(source) { return vm.runInContext(source, context); } });
  vm.runInContext('Math', context).random = () => engine.random(session);
  const tilemapBinding = installTilemap({ scope, runScript(source) { return vm.runInContext(source, context); } }, engine, session);
  let rateAction = null;
  function wrapRuntimeEntity(handle) {
    if (handle.entityType === 'character') return wrapEntity(handle,handle.entityId > 0 ? Game_Event : handle.entityId === -1 ? Game_Player : handle.entityId <= -5 ? Game_Vehicle : handle.entityId <= -2 ? Game_Follower : Game_Character,characters);
    return wrapEntity(handle,handle.entityType === 'enemy' ? Game_Enemy : Game_Actor,actors);
  }
  const callbacks = {
    scene(method, kind) { return scenes ? scenes.requestScene(method, kind) : null; },
    tileShadow(...args) { return tilemapBinding.draw(...args); },
    actionRate(method, subjectHandle, targetHandle, item, id) {
      if (method === 'itemHit') rateAction = null;
      if (scope.Game_Action.prototype[method] === nativeActionRates[method]) {
        if (method === 'itemEva') rateAction = null;
        return undefined;
      }
      const wrapBattler = handle => wrapEntity(handle, engine.entityField(handle, 'enemy') ? Game_Enemy : Game_Actor, actors);
      const action = rateAction || new scope.Game_Action(wrapBattler(subjectHandle));
      if (!rateAction) action[item ? 'setItem' : 'setSkill'](id);
      if (method === 'itemHit') rateAction = action;
      try { return action[method](wrapBattler(targetHandle)); }
      finally { if (method === 'itemEva') rateAction = null; }
    },
    boundMethod(handle, method, args) {
      return classBindings ? classBindings.dispatch(handle, handle.bindingType, method, args) : null;
    },
    retainBoundObject(handle) { classBindings.wrap(handle, handle.bindingType); },
    boundListener(handle, token) { classBindings.deliver(handle, token); },
    audioBuffer(kind, name) { return classBindings ? classBindings.handle(scope.AudioManager.createBuffer(kind, name)) : null; },
    systemBitmap(handle, name) {
      const sprite = classBindings.wrap(handle, 'Sprite_Balloon');
      sprite.bitmap = scope.ImageManager.loadSystem(name);
      return bitmapHandle(scope.Bitmap, sprite.bitmap);
    },
    boundObjectMethod(handle, method, argument) {
      return classBindings ? classBindings.dispatch(handle,handle.bindingType,method,() => [argument ? wrapRuntimeEntity(argument) : null]) : null;
    },
    nativeBitmap(handle, method, args, slot) {
      const root=classBindings.wrap(handle,handle.bindingType);
      const sprite=slot ? root[slot] : root;
      sprite.bitmap=method === 'createBitmap' ? new scope.Bitmap(...args) : scope.ImageManager[method](...args);
      return bitmapHandle(scope.Bitmap,sprite.bitmap);
    },
    enemySpriteBattler(handle, enemyHandle) {
      if (!classBindings) return false;
      return classBindings.dispatch(handle, 'Sprite_Enemy', 'setBattler', () => [wrapEntity(enemyHandle, Game_Enemy, actors)]) !== null;
    },
    actorSpriteHome(handle, index) { return classBindings ? classBindings.dispatch(handle, 'Sprite_Actor', 'setActorHome', [index]) !== null : false; },
    actorLifecycle(handle, method) {
      const actor = wrapEntity(handle, Game_Actor, actors);
      if (actor[method] === nativeActorMethods[method]) return false;
      if (typeof actor[method] !== 'function') throw new TypeError('Game_Actor.' + method + ' is not callable');
      actor[method](); return true;
    },
    characterScript(handle, source) {
      const type = engine.entityField(handle, 'id') === -1 ? Game_Player : Game_Event;
      const character = wrapEntity(handle, type, characters);
      if (typeof character.processMoveRouteScriptCall === 'function') return character.processMoveRouteScriptCall(source);
      const fn = new vm.Script('(function() {\n' + source + '\n})', { filename: 'mv-route-script.js' }).runInContext(context);
      return fn.call(character);
    },
    scriptValue(handle, source) {
      let fn = values.get(source);
      if (!fn) {
        fn = new vm.Script('(function() { return eval(' + JSON.stringify(source) + '); })', { filename: 'mv-variable-script.js' }).runInContext(context);
        values.set(source, fn);
      }
      return fn.call(wrapInterpreter(handle));
    },
    gameDataMutation(kind, method, args) {
      const object = gameDataStores.get(kind), fn = object[method];
      if (fn === gameDataDefaults.get(kind)[method]) return false;
      if (typeof fn !== 'function') throw new TypeError('Game_' + kind + '.' + method + ' is not callable');
      fn.apply(object, args); return true;
    },
    touchEvent(event) {
      const method = touchHandlers[event.type], handler = scope.TouchInput[method];
      if (typeof handler !== 'function') throw new TypeError('TouchInput.' + method + ' is not callable');
      event.preventDefault = function() { this.defaultPrevented = true; };
      event.stopPropagation = function() { this.cancelBubble = true; };
      handler.call(scope.TouchInput, event);
    },
    touchTransition(method, x, y) {
      const fn = scope.TouchInput[method];
      if (fn === touchTransitions.get(method)) return false;
      if (typeof fn !== 'function') throw new TypeError('TouchInput.' + method + ' is not callable');
      fn.call(scope.TouchInput, x, y); return true;
    },
    touchUpdate() { scope.TouchInput.update(); },
    command(handle, name) {
      const interpreter = wrapInterpreter(handle), method = interpreter[name];
      if (method === nativeCommand[name] && typeof method === 'function') return undefined;
      if (typeof method !== 'function') {
        if (name === 'executeCommand') throw new TypeError('Game_Interpreter.executeCommand is not callable');
        return name in nativeCommand || name in interpreter ? true : undefined;
      }
      return Boolean(method.call(interpreter));
    },
    requestImages(list) { Game_Interpreter.requestImages(wrapCollection(list)); },
    choice(index) {
      if (gameMessage.onChoice === nativeOnChoice && !gameMessage._choiceCallback) return false;
      gameMessage.onChoice(index); return true;
    },
    setupChoiceCallback(handle) {
      const interpreter = wrapInterpreter(handle);
      gameMessage.setChoiceCallback(index => { interpreter._branch[interpreter._indent] = index; });
    },
    interpreterControl(handle, method, args) {
      const interpreter = wrapInterpreter(handle), fn = interpreter[method];
      if (fn === nativeControl[method]) return false;
      if (typeof fn !== 'function') throw new TypeError('Game_Interpreter.' + method + ' is not callable');
      fn.apply(interpreter, args); return true;
    },
    message(method, args) {
      const fn = gameMessage[method];
      if (fn === nativeMessage[method]) {
        if (method === 'clear') { gameMessage._choiceCallback = null; choiceView = null; }
        return undefined;
      }
      if (typeof fn !== 'function') throw new TypeError('Game_Message.' + method + ' is not callable');
      const value = fn.apply(gameMessage, args);
      return method === 'isBusy' ? Boolean(value) : true;
    },
    lifecycle(handle, method, list, eventId) {
      const interpreter = wrapInterpreter(handle), fn = interpreter[method];
      if (fn === nativeLifecycle[method]) return false;
      if (typeof fn !== 'function') throw new TypeError('Game_Interpreter.' + method + ' is not callable');
      if (method === 'setup') fn.call(interpreter, wrapCollection(list), eventId);
      else fn.call(interpreter);
      return true;
    },
    picture(handle, name, args) {
      const picture = wrapPicture(handle), method = picture[name];
      if (typeof method !== 'function') throw new TypeError('Game_Picture.' + name + ' is not callable');
      if (method === defaults[name]) return false;
      method.apply(picture, args); return true;
    },
    sprite(handle) { ensureSprite(handle); },
    updateSprites() {
      const battle = engine.inBattle(session);
      for (const [slot, sprite] of spriteSlots) {
        const logical = slot > 100 ? slot - 100 : slot;
        if (!engine.ownsPictureSprite(session, sprites.get(sprite))) {
          spriteSlots.delete(slot);
          if (pictureChildren[logical] === sprite) delete pictureChildren[logical];
          continue;
        }
        if ((slot > 100) !== battle) continue;
        pictureChildren[logical] = sprite;
        sprite.update();
      }
    },
    wait(handle, name) {
      const interpreter = wrapInterpreter(handle);
      if (interpreter[name] === nativeWait[name]) return undefined;
      if (typeof interpreter[name] !== 'function') throw new TypeError('Game_Interpreter.' + name + ' is not callable');
      return Boolean(interpreter[name]());
    },
    scriptCondition(handle, source) {
      let fn = conditions.get(source);
      if (!fn) {
        fn = new vm.Script('(function() { return eval(' + JSON.stringify(source) + '); })', { filename: 'mv-event-condition.js' }).runInContext(context);
        conditions.set(source, fn);
      }
      return Boolean(fn.call(wrapInterpreter(handle)));
    },
    script(handle, source) {
      let fn = scripts.get(source);
      if (!fn) {
        fn = new vm.Script('(function() {\n' + source + '\n})', { filename: 'mv-event-script.js' }).runInContext(context);
        scripts.set(source, fn);
      }
      fn.call(wrapInterpreter(handle));
    },
    pluginCommand(handle, command, args) {
      const interpreter = wrapInterpreter(handle);
      if (interpreter.pluginCommand === nativePluginCommand) return false;
      if (typeof interpreter.pluginCommand !== 'function') throw new TypeError('Game_Interpreter.pluginCommand is not callable');
      interpreter.pluginCommand(command, args);
      return true;
    },
    collect(active) {
      if (options.native) scope.ImageManager.update();
      for (const id of roots.keys()) if (!active[String(id)]) roots.delete(id);
      for (const [id, reference] of registry) if (!reference.deref()) registry.delete(id);
    }
  };
  engine.connectRuntime(session, callbacks);
  let scenes, classBindings, renderSubmitted = false, mapUpdated = false, frameInput;
  const result = {
    scope,
    runScript(source, filename = 'mv-plugin.js') { return new vm.Script(source, { filename }).runInContext(context); },
    installScenes() {
      if (!options.native) throw new Error('Scene bindings require native graphics services');
      if (scenes) return scenes;
      scenes = createSceneBindings(options.native, scope.Bitmap, scope.ImageManager, {
        createArray() { return vm.runInContext("[]", context); },
        runScript(source) { return vm.runInContext(source, context); },
        resourceHandler() { return scope.ResourceHandler; },
        gamepads() { return scope.navigator?.getGamepads?.() || []; },
        colorMatrixFilterClass() { return scope.PIXI?.filters?.ColorMatrixFilter; },
        glitchFilterClass() { return scope.PIXI?.filters?.GlitchFilter; },
        containerPrototype: scope.PIXI?.Container?.prototype,
        initializeEvents(object) { if (scope.PIXI?.utils?.EventEmitter) scope.PIXI.utils.EventEmitter.call(object); },
        createTicker() { return scope.PIXI?.ticker ? new scope.PIXI.ticker.Ticker() : null; },
        graphics() { return scope.Graphics; },
        webAudio() { return scope.WebAudio; },
        checkPluginErrors() { scope.PluginManager?.checkErrors(); },
        submitStage(handle) { renderSubmitted=true; engine.scriptStage(session,handle); },
        coreService(...args) { return engine.coreService(...args); },
        windowClasses() { return engine.windowClasses(); },
        windowModel(handle, name, method, args) { return engine.windowModel(session, handle, name, method, args); },
        actor(id) { return id ? scope.$gameActors.actor(id) : null; },
        actorId(actor) { return actor ? actor.actorId() : 0; },
        openTitle() { engine.sceneControl(session, 'title'); },
        sceneClass(name) { return scope[name]; },
        sceneControl(method, ...args) { return engine.sceneControl(session, method, ...args); },
        menuCommands() { return engine.managerInvoke(session, 'menuCommands'); },
        optionCommands() { return engine.managerInvoke(session, 'optionCommands'); },
        configManager() { return scope.ConfigManager; },
        touchInput() { return scope.TouchInput; },
        audioManager() { return scope.AudioManager; },
        gameoverMusic() { scope.AudioManager.stopBgm(); scope.AudioManager.stopBgs(); scope.AudioManager.playMe(scope.$dataSystem.gameoverMe); },
        gameParty() { return scope.$gameParty; },
        gameVariables() { return scope.$gameVariables; },
        actorName(id) { return scope.$gameActors.actor(id)?.name() || ''; },
        textManager() { return scope.TextManager; },
        battleManager() { return scope.BattleManager; },
        soundManager() { return scope.SoundManager; },
        gamePlayer() { return scope.$gamePlayer; },
        gameMap() { return scope.$gameMap; },
        gameMessage() { return scope.$gameMessage; },
        gameScreen() { return scope.$gameScreen; },
        loadMap(id) { result.mapDatabase.load(id); },
        isMapReady() { return result.mapDatabase.isReady(); },
        bindMapSpriteset(object) { engine.bindMapSpriteset(session, classBindings.handle(object)); },
        mapPhase(phase) {
          if (phase === 'update') mapUpdated = true;
          return phase === 'destination' && frameInput !== undefined ? engine.mapScene(session, phase, frameInput) : engine.mapScene(session, phase);
        },
        fadeAudio(seconds) {
          scope.AudioManager.fadeOutBgm(seconds);
          scope.AudioManager.fadeOutBgs(seconds);
          scope.AudioManager.fadeOutMe(seconds);
        },
        loadDatabase() { if (result.database) result.database.load(); else if (scope.XMLHttpRequest || scope.DataManager.loadDatabase !== referenceDatabaseLoad) scope.DataManager.loadDatabase?.(); },
        isDatabaseReady() { return result.database ? result.database.isReady() : true; },
        startAnimation(handle, id, mirror, delay, rate) { engine.displayAnimation(session, handle, id, mirror, delay, rate); },
        performTransfer() { engine.playerTransfer(session, 'perform'); },
        messageWindow(method) { return engine.messageInvoke(session, 'window.' + method, []); },
        messageWindowField(field, ...value) { return engine.messageField(session, field, ...value); },
        boundDisplay(handle, runtime) { return engine.classBindings.display(handle, runtime); },
        boundDisplayField(handle, field, runtime, ...value) { return engine.classBindings.displayField(handle, field, runtime, ...value); }
      });
      Object.assign(scope, scenes);
      classBindings = installClassBindings(scope, engine.classBindings, session, { unwrap: object => actors.get(object) || characters.get(object), initializeDisplay: scenes.initializeDisplay, displayField: scenes.displayField,
        wrapReference: wrapRuntimeEntity });
      scope.navigator = {
        ...scope.navigator,
        platform: scope.navigator?.platform || process.platform, userAgent: 'pmjs native runtime', language: 'en-US',
        getGamepads() {
          const result = [];
          for (const pad of options.native.input.snapshot().gamepads) {
            while (result.length <= pad.index) result.push(null);
            result[pad.index] = pad;
          }
          return result;
        }
      };
      installAudioManager(scope,engine,session,classBindings,values => GuestArray.from(values));
      installSoundManager(scope, engine, session);
      Object.assign(scope.DataManager, {
        createGameObjects() {
          for (const name of ['Temp','System','Timer','Screen','Party','Troop','Map','Actors']) {
            const object=scope['$game'+name], Type=scope['Game_'+name];
            if (object && Type) Object.setPrototypeOf(object,Type.prototype);
          }
          engine.newGame(session); scope.$gameTemp.initialize(); scope.$gameSystem.initialize(); scope.$gameTimer.initialize();
        },
        setupNewGame() { this.createGameObjects(); }
      });
      Game_Player.prototype.reserveTransfer = function(mapId, x, y, direction = 0, fadeType = 0) {
        if (this !== scope.$gamePlayer) throw new Error('Detached player transfer is not bound');
        engine.playerTransfer(session, 'reserve', mapId, x, y, direction, fadeType);
      };
      Game_Player.prototype.isTransferring = function() {
        if (this !== scope.$gamePlayer) throw new Error('Detached player transfer is not bound');
        return engine.playerTransfer(session, 'isTransferring');
      };
      Game_Player.prototype.newMapId = function() { return engine.playerTransfer(session, 'newMapId'); };
      Game_Player.prototype.fadeType = function() { return engine.playerTransfer(session, 'fadeType'); };
      Game_Player.prototype.performTransfer = function() {
        if (this !== scope.$gamePlayer) throw new Error('Detached player transfer is not bound');
        engine.playerTransfer(session, 'perform');
      };
      for (const method of ['isBattleTest', 'isEventTest', 'isAnySavefileExists']) scope.DataManager[method] = () => engine.managerInvoke(session, method);
      scope.ConfigManager = function ConfigManager() { throw new Error('ConfigManager is a static class'); };
      for (const field of ['alwaysDash', 'commandRemember', 'bgmVolume', 'bgsVolume', 'meVolume', 'seVolume']) Object.defineProperty(scope.ConfigManager, field, {
        enumerable: true, configurable: true, get() { return engine.configuration(session)[field]; }, set(value) { engine.configure(session, { [field]: value }); }
      });
      for (const field of ['bgmVolume', 'bgsVolume', 'meVolume', 'seVolume']) Object.defineProperty(scope.AudioManager, field, {
        enumerable: true, configurable: true,
        get() { return engine.configuration(session)[field]; }, set(value) { engine.configure(session, { [field]: value }); }
      });
      function Window_TitleCommand() { this.initialize.apply(this, arguments); }
      Window_TitleCommand.prototype = Object.create(scope.Window_Command.prototype);
      Window_TitleCommand.prototype.constructor = Window_TitleCommand;
      Window_TitleCommand.prototype.makeCommandList = function() {
        for (const command of engine.managerInvoke(session, 'titleCommands')) this.addCommand(command.name, command.symbol, command.enabled);
      };
      Window_TitleCommand.initCommandPosition = () => engine.managerInvoke(session, 'initTitleCommandPosition');
      scope.Window_TitleCommand = Window_TitleCommand;
      result.start = () => scope.SceneManager.run(scope.Scene_Boot);
      result.step = input => {
        renderSubmitted=false;
        mapUpdated=false; frameInput=input;
        classBindings.sweep();
        tilemapBinding.update();
        engine.updateTouch(session);
        if (scope.SceneManager._stopped) return true;
        scope.SceneManager.ticker?.update(scope.performance?.now() ?? performance.now());
        scope.SceneManager.update(1);
        scenes.updateFilters();
        const scene = scope.SceneManager._scene;
        const builtin = !scene || scope.SceneManager.nativeDriven;
        if (!renderSubmitted) engine.scriptStage(session, builtin ? null : scope.SceneManager.stageHandle);
        if (mapUpdated || !builtin || !scope.SceneManager.canStep) return true;
        return input === undefined ? engine.step(session) : engine.step(session, input);
      };
      return scenes;
    }
  };
  return result;
}

module.exports = { createScriptRuntime };
