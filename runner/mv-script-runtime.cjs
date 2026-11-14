'use strict';
const { createBitmapClass, createImageManager, bitmapHandle } = require('./native-bitmap.cjs');

function createScriptRuntime(engine, session, options = {}) {
  const pictures = new WeakMap(), interpreters = new WeakMap(), sprites = new WeakMap(), frames = new WeakMap(), tones = new WeakMap();
  const registry = new Map(), roots = new Map(), spriteSlots = new Map(), scripts = new Map();
  const pictureChildren = [];
  const fields = ['_name', '_origin', '_x', '_y', '_scaleX', '_scaleY', '_opacity', '_blendMode',
    '_targetX', '_targetY', '_targetScaleX', '_targetScaleY', '_targetOpacity', '_duration',
    '_toneDuration', '_angle', '_rotationSpeed'];
  const defaults = Object.create(null);
  const collectionHandles = new WeakMap();

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
    const tone = [];
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
    const object = info.array ? [] : {}, children = new Map();
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
    Game_Interpreter.prototype[method] = nativeCommand[method] = function() {
      const handle = interpreters.get(this);
      if (!handle) throw new TypeError('Interpreter is not initialized');
      return engine.interpreterCommandInvoke(session, handle, method);
    };
  }
  Game_Interpreter.prototype.setWaitMode = function(mode) { this._waitMode = mode; };
  Game_Interpreter.prototype.wait = function(duration) { this._waitCount = duration; };
  Game_Interpreter.prototype.eventId = function() { return this._eventId; };
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
  for (const method of ['clear', 'add', 'setFaceImage', 'setBackground', 'setPositionType', 'faceName', 'faceIndex',
    'background', 'positionType', 'hasText', 'isBusy', 'isChoice', 'isNumberInput', 'isItemChoice', 'isScrollMode',
    'scrollSpeed', 'scrollNoFast', 'setScroll', 'allText']) {
    Game_Message.prototype[method] = nativeMessage[method] = function(...args) { return engine.messageInvoke(session, method, args); };
  }
  const gameMessage = Object.create(Game_Message.prototype);
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
  function Rectangle(x = 0, y = 0, width = 0, height = 0) {
    this.x = x; this.y = y; this.width = width; this.height = height;
  }
  const scope = { Game_Picture, Game_Interpreter, Game_Message, $gameMessage: gameMessage, Sprite_Picture, Rectangle,
    $gameMap: { mapId: () => engine.mapId(session) },
    $gameScreen: { picture(id) {
      const handle = engine.picture(session, id);
      if (!handle) return null;
      const picture = wrapPicture(handle);
      ensureSprite(handle);
      return picture;
    } },
    SceneManager: { _scene: { _spriteset: { _pictureContainer: { children: pictureChildren } } } }
  };
  if (options.native) {
    scope.Bitmap = createBitmapClass(options.native);
    scope.ImageManager = createImageManager(options.native, scope.Bitmap);
  }
  const callbacks = {
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
    message(method, args) {
      const fn = gameMessage[method];
      if (fn === nativeMessage[method]) return undefined;
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
    script(handle, source) {
      let fn = scripts.get(source);
      if (!fn) {
        fn = new Function('scope', 'with (scope) { return function() {\n' + source + '\n}; }')(scope);
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
  return { scope };
}

module.exports = { createScriptRuntime };
