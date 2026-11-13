'use strict';

function createScriptRuntime(engine, session) {
  const pictures = new WeakMap(), interpreters = new WeakMap(), sprites = new WeakMap(), frames = new WeakMap(), tones = new WeakMap();
  const registry = new Map(), roots = new Map(), spriteSlots = new Map(), scripts = new Map();
  const pictureChildren = [];
  const fields = ['_name', '_origin', '_x', '_y', '_scaleX', '_scaleY', '_opacity', '_blendMode',
    '_targetX', '_targetY', '_targetScaleX', '_targetScaleY', '_targetOpacity', '_duration',
    '_toneDuration', '_angle', '_rotationSpeed'];
  const defaults = Object.create(null);

  function remember(object, handle, store) {
    store.set(object, handle);
    registry.set(handle.identity, new WeakRef(object));
    roots.set(handle.identity, object);
    return object;
  }
  function attachPicture(object, handle) {
    remember(object, handle, pictures);
    for (const field of fields) Object.defineProperty(object, field, {
      configurable: true, enumerable: true,
      get() { return engine.pictureField(handle, field); },
      set(value) { engine.pictureField(handle, field, value); }
    });
    for (const field of ['_tone', '_toneTarget']) Object.defineProperty(object, field, {
      configurable: true, enumerable: true,
      get() { return wrapTone(engine.pictureTone(session, handle, field)); },
      set(value) {
        if (value !== null && !tones.has(value)) throw new TypeError('Tone assignment requires a native tone array; tint() copies an ordinary array');
        engine.pictureTone(session, handle, field, value === null ? null : tones.get(value));
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
      for (const field of ['_mapId', '_eventId', '_index', '_waitCount', '_depth']) Object.defineProperty(object, field, {
        configurable: true, enumerable: true,
        get() { return engine.interpreterField(session, handle, field); },
        set(value) { engine.interpreterField(session, handle, field, Number(value)); }
      });
      Object.defineProperty(object, '_waitMode', {
        configurable: true, enumerable: true,
        get() { return engine.interpreterMode(session, handle); },
        set(mode) { engine.interpreterMode(session, handle, String(mode)); }
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
  Game_Interpreter.prototype.setWaitMode = function(mode) { this._waitMode = mode; };
  Game_Interpreter.prototype.wait = function(duration) { this._waitCount = duration; };
  Game_Interpreter.prototype.eventId = function() { return this._eventId; };
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
  function Sprite_Picture() { throw new Error('Picture sprite construction is engine-owned'); }
  Sprite_Picture.prototype.initialize = function(id) { this._pictureId = id; };
  Sprite_Picture.prototype.picture = function() { return scope.$gameScreen.picture(this._pictureId); };
  Sprite_Picture.prototype.update = function() { this.updateOther(); };
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
  const scope = { Game_Picture, Game_Interpreter, Sprite_Picture, Rectangle,
    $gameScreen: { picture(id) {
      const handle = engine.picture(session, id);
      if (!handle) return null;
      const picture = wrapPicture(handle);
      ensureSprite(handle);
      return picture;
    } },
    SceneManager: { _scene: { _spriteset: { _pictureContainer: { children: pictureChildren } } } }
  };
  const callbacks = {
    picture(handle, name, args) {
      const picture = wrapPicture(handle), method = picture[name];
      if (typeof method !== 'function') throw new TypeError('Game_Picture.' + name + ' is not callable');
      if (method === defaults[name]) return false;
      method.apply(picture, args); return true;
    },
    sprite(handle) { ensureSprite(handle)?.update(); },
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
      for (const id of roots.keys()) if (!active[String(id)]) roots.delete(id);
      for (const [id, reference] of registry) if (!reference.deref()) registry.delete(id);
    }
  };
  engine.connectRuntime(session, callbacks);
  return { scope };
}

module.exports = { createScriptRuntime };
