'use strict';
const { bitmapHandle } = require('./native-bitmap.cjs');

function createSceneBindings(native, Bitmap, ImageManager, options = {}) {
  const api = native.mvDisplay, runtime = api.open();
  const nodes = new WeakMap(), registry = new Map();
  let currentRoot = null, nextRoot = null;
  function entry(object) {
    const value = nodes.get(object);
    if (!value) throw new TypeError('Display object is not initialized');
    return value;
  }
  function attach(object, kind) {
    if (nodes.has(object)) throw new Error('Display object is already initialized');
    const handle = api.create(runtime, kind);
    nodes.set(object, { handle, children: new Map(), parent: null, bitmaps: new Map(), points: new Map() });
    registry.set(handle.identity, new WeakRef(object));
  }
  function wrap(handle) {
    if (!handle) return null;
    const existing = registry.get(handle.identity)?.deref();
    if (existing) return existing;
    const types = { scene: Scene_Base, window: Window, windowLayer: WindowLayer, sprite: Sprite, tiling: TilingSprite, screen: ScreenSprite, container: Container, glitch: GlitchFilter };
    const object = Object.create(types[handle.kind].prototype);
    nodes.set(object, { handle, children: new Map(), parent: null, bitmaps: new Map(), points: new Map() });
    registry.set(handle.identity, new WeakRef(object));
    return object;
  }
  function prop(type, name, field = name) {
    Object.defineProperty(type.prototype, name, {
      configurable: true, enumerable: true,
      get() { return api.field(entry(this).handle, field); },
      set(value) { api.field(entry(this).handle, field, value); }
    });
  }
  function point(type, name, x, y) {
    Object.defineProperty(type.prototype, name, { configurable: true, get() {
      const value = entry(this);
      if (!value.points.has(name)) {
        const handle = value.handle, point = {};
        for (const [key, field] of [['x', x], ['y', y]]) Object.defineProperty(point, key, {
          enumerable: true, get() { return api.field(handle, field); }, set(value) { api.field(handle, field, value); }
        });
        point.set = function(a = 0, b = a) { this.x = a; this.y = b; };
        value.points.set(name, point);
      }
      return value.points.get(name);
    } });
  }
  function bitmapProperty(type, name) {
    Object.defineProperty(type.prototype, name, {
      configurable: true,
      get() { return entry(this).bitmaps.get(name) || null; },
      set(value) {
        const own = entry(this);
        api.invoke(own.handle, name, value == null ? null : bitmapHandle(Bitmap, value));
        own.bitmaps.set(name, value);
      }
    });
  }
  function children(object) {
    const own = entry(object), handles = api.children(own.handle), live = new Set();
    const result = handles.map(handle => {
      live.add(handle.identity);
      const child = own.children.get(handle.identity) || wrap(handle);
      own.children.set(handle.identity, child); entry(child).parent = object;
      return child;
    });
    for (const id of own.children.keys()) if (!live.has(id)) own.children.delete(id);
    return result;
  }
  function Container() { this.initialize.apply(this, arguments); }
  Container.prototype.initialize = function() { attach(this, 'container'); };
  for (const field of ['x', 'y', 'rotation', 'alpha', 'visible', 'renderable', 'z']) prop(Container, field);
  point(Container, 'position', 'x', 'y'); point(Container, 'scale', 'scaleX', 'scaleY');
  point(Container, 'pivot', 'pivotX', 'pivotY'); point(Container, 'skew', 'skewX', 'skewY');
  Object.defineProperty(Container.prototype, 'parent', { get() { return entry(this).parent; } });
  Object.defineProperty(Container.prototype, 'children', { get() { return Object.freeze(children(this)); } });
  Container.prototype.addChildAt = function(child, index) {
    const own = entry(this), value = entry(child), oldParent = value.parent;
    api.invoke(own.handle, 'add', value.handle, index);
    if (oldParent) entry(oldParent).children.delete(value.handle.identity);
    own.children.set(value.handle.identity, child); value.parent = this;
    return child;
  };
  Container.prototype.addChild = function(...items) {
    for (const child of items) this.addChildAt(child, api.children(entry(this).handle).length);
    return items[0];
  };
  Container.prototype.removeChild = function(...items) {
    const own = entry(this);
    for (const child of items) {
      const value = entry(child);
      api.invoke(own.handle, 'remove', value.handle);
      own.children.delete(value.handle.identity); if (value.parent === this) value.parent = null;
    }
    return items[0];
  };
  Container.prototype.removeChildren = function(begin = 0, end = this.children.length) {
    const removed = this.children.slice(begin, end); this.removeChild(...removed); return removed;
  };
  Container.prototype.getChildIndex = function(child) { const index = this.children.indexOf(child); if (index < 0) throw new Error('Display object is not a child'); return index; };
  Container.prototype.getChildAt = function(index) { const child = this.children[index]; if (!child) throw new RangeError('Child index is outside the display tree'); return child; };
  Container.prototype.setChildIndex = function(child, index) { if (this.getChildIndex(child) < 0) return; this.addChildAt(child, index); };
  Container.prototype.update = function() { this.updateChildren(); };
  Container.prototype.updateChildren = function() { for (const child of this.children) if (typeof child.update === 'function') child.update(); };
  Container.prototype.move = function(x, y) { this.position.set(x, y); };
  Container.prototype.show = function() { this.visible = true; };
  Container.prototype.hide = function() { this.visible = false; };
  function inherit(type, base) { type.prototype = Object.create(base.prototype); type.prototype.constructor = type; }
  function Sprite() { this.initialize.apply(this, arguments); }
  inherit(Sprite, Container);
  Sprite.prototype.initialize = function(bitmap) { attach(this, 'sprite'); if (bitmap) this.bitmap = bitmap; };
  bitmapProperty(Sprite, 'bitmap'); point(Sprite, 'anchor', 'anchorX', 'anchorY');
  for (const field of ['width', 'height', 'opacity', 'blendMode']) prop(Sprite, field);
  Sprite.prototype.setFrame = function(x, y, w, h) { api.invoke(entry(this).handle, 'frame', x, y, w, h); };
  Object.defineProperty(Sprite.prototype, '_frame', { get() {
    const own = entry(this);
    if (!own.frame) {
      own.frame = {};
      ['x', 'y', 'width', 'height'].forEach((field, index) => Object.defineProperty(own.frame, field, {
        enumerable: true,
        get() { return api.invoke(own.handle, 'frame')[index]; },
        set(value) { const rect = api.invoke(own.handle, 'frame'); rect[index] = value; api.invoke(own.handle, 'frame', ...rect); }
      }));
    }
    return own.frame;
  } });
  Sprite.prototype._refresh = function() { api.invoke(entry(this).handle, 'refreshSprite'); };
  Sprite.prototype.getColorTone = function() { return api.invoke(entry(this).handle, 'tone'); };
  Sprite.prototype.setColorTone = function(value) { api.invoke(entry(this).handle, 'tone', ...value); };
  Sprite.prototype.getBlendColor = function() { return api.invoke(entry(this).handle, 'blend'); };
  Sprite.prototype.setBlendColor = function(value) { api.invoke(entry(this).handle, 'blend', ...value); };
  Object.defineProperty(Container.prototype, 'filters', {
    get() { return entry(this).filters || null; },
    set(value) { api.invoke(entry(this).handle, 'filters', ...(value || []).map(filter => entry(filter).handle)); entry(this).filters = value; }
  });
  function GlitchFilter() { attach(this, 'glitch'); }
  for (const field of ['slices', 'offset', 'direction', 'fillMode', 'seed', 'enabled']) prop(GlitchFilter, field);
  function Sprite_Base() { this.initialize.apply(this, arguments); }
  inherit(Sprite_Base, Sprite);
  Sprite_Base.prototype.initialize = function() { Sprite.prototype.initialize.call(this); };
  Sprite_Base.prototype.update = function() { Sprite.prototype.update.call(this); api.invoke(entry(this).handle, 'updateAnimations'); };
  Sprite_Base.prototype.isAnimationPlaying = function() { return api.invoke(entry(this).handle, 'isAnimationPlaying'); };
  Sprite_Base.prototype.startAnimation = function(animation, mirror, delay) { options.startAnimation(entry(this).handle, animation.id, mirror, delay); };
  function TilingSprite() { this.initialize.apply(this, arguments); }
  inherit(TilingSprite, Sprite);
  TilingSprite.prototype.initialize = function(bitmap) { attach(this, 'tiling'); if (bitmap) this.bitmap = bitmap; };
  point(TilingSprite, 'origin', 'originX', 'originY');
  TilingSprite.prototype.move = function(x, y, w, h) { this.x = x; this.y = y; this.width = w; this.height = h; };
  function ScreenSprite() { this.initialize.apply(this, arguments); }
  inherit(ScreenSprite, Container);
  ScreenSprite.prototype.initialize = function() { attach(this, 'screen'); };
  prop(ScreenSprite, 'opacity');
  ScreenSprite.prototype.setColor = function(r, g, b) { api.invoke(entry(this).handle, 'color', r, g, b); };
  ScreenSprite.prototype.setBlack = function() { this.setColor(0, 0, 0); };
  ScreenSprite.prototype.setWhite = function() { this.setColor(255, 255, 255); };
  function Window() { this.initialize.apply(this, arguments); }
  inherit(Window, Container);
  Window.prototype.initialize = function() {
    if (!nodes.has(this)) attach(this, 'window');
    if (entry(this).windowInitialized) throw new Error('Window is already initialized');
    entry(this).windowInitialized = true;
  };
  for (const field of ['width', 'height', 'padding', 'margin', 'openness', 'opacity', 'backOpacity', 'contentsOpacity', 'active', 'opening', 'closing']) prop(Window, field);
  for (const field of ['width', 'height', 'padding', 'margin', 'openness', 'opening', 'closing']) prop(Window, '_' + field, field);
  point(Window, 'origin', 'originX', 'originY');
  bitmapProperty(Window, 'contents'); bitmapProperty(Window, 'windowskin');
  Window.prototype.move = TilingSprite.prototype.move;
  Window.prototype.setCursorRect = function(x, y, w, h) { api.invoke(entry(this).handle, 'cursor', x, y, w, h); };
  Window.prototype._refreshAllParts = function() { api.invoke(entry(this).handle, 'refreshWindow'); };
  Window.prototype.update = function() { api.invoke(entry(this).handle, 'tick'); this.updateChildren(); };
  function WindowLayer() { this.initialize.apply(this, arguments); }
  inherit(WindowLayer, Container);
  WindowLayer.prototype.initialize = function() { attach(this, 'windowLayer'); };
  WindowLayer.prototype.move = function(x, y, width, height) { this.x = x; this.y = y; this.width = width; this.height = height; };
  function Window_Base() { this.initialize.apply(this, arguments); }
  inherit(Window_Base, Window);
  Window_Base.prototype.initialize = function(x, y, width, height) {
    Window.prototype.initialize.call(this);
    this.windowskin = ImageManager.loadSystem('Window');
    this.move(x, y, width, height); this.padding = this.standardPadding();
    this.backOpacity = this.standardBackOpacity(); this.createContents();
  };
  Window_Base.prototype.standardFontFace = function() { return 'GameFont'; };
  Window_Base.prototype.standardFontSize = function() { return 28; };
  Window_Base.prototype.standardPadding = function() { return 18; };
  Window_Base.prototype.standardBackOpacity = function() { return 192; };
  Window_Base.prototype.lineHeight = function() { return 36; };
  Window_Base.prototype.textPadding = function() { return 6; };
  Window_Base.prototype.translucentOpacity = function() { return 160; };
  Window_Base.prototype.contentsWidth = function() { return Math.max(0, this.width - this.padding * 2); };
  Window_Base.prototype.contentsHeight = function() { return Math.max(0, this.height - this.padding * 2); };
  Window_Base.prototype.fittingHeight = function(rows) { return rows * this.lineHeight() + this.standardPadding() * 2; };
  Window_Base.prototype.createContents = function() { this.contents = new Bitmap(this.contentsWidth(), this.contentsHeight()); this.resetFontSettings(); };
  Window_Base.prototype.resetFontSettings = function() { this.contents.fontFace = this.standardFontFace(); this.contents.fontSize = this.standardFontSize(); this.resetTextColor(); };
  Window_Base.prototype.normalColor = function() { return this.textColor(0); };
  Window_Base.prototype.textColor = function(index) { return this.windowskin.getPixel(96 + (index % 8) * 12 + 6, 144 + Math.floor(index / 8) * 12 + 6); };
  Window_Base.prototype.resetTextColor = function() { this.changeTextColor(this.normalColor()); };
  Window_Base.prototype.changeTextColor = function(color) { this.contents.textColor = color; };
  Window_Base.prototype.changePaintOpacity = function(enabled) { this.contents.paintOpacity = enabled ? 255 : this.translucentOpacity(); };
  Window_Base.prototype.textWidth = function(text) { return this.contents.measureTextWidth(text); };
  Window_Base.prototype.drawText = function(text, x, y, width, align = 'left') { this.contents.drawText(text, x, y, width, this.lineHeight(), align); };
  Window_Base.prototype.open = function() { if (!this.isOpen()) this.opening = true; this.closing = false; return this; };
  Window_Base.prototype.close = function() { if (!this.isClosed()) this.closing = true; this.opening = false; return this; };
  Window_Base.prototype.isOpen = function() { return this.openness >= 255; };
  Window_Base.prototype.isClosed = function() { return this.openness <= 0; };
  Window_Base.prototype.isOpening = function() { return this.opening; };
  Window_Base.prototype.isClosing = function() { return this.closing; };
  Window_Base.prototype.activate = function() { this.active = true; return this; };
  Window_Base.prototype.deactivate = function() { this.active = false; return this; };
  function Window_Selectable() { this.initialize.apply(this, arguments); }
  inherit(Window_Selectable, Window_Base);
  Window_Selectable.prototype.initialize = function(x, y, width, height) {
    Window_Base.prototype.initialize.call(this, x, y, width, height);
    this._handlers = {}; this.deactivate(); this.select(-1);
  };
  prop(Window_Selectable, '_index', 'index');
  Window_Selectable.prototype.index = function() { return this._index; };
  Window_Selectable.prototype.maxCols = function() { return 1; };
  Window_Selectable.prototype.maxItems = function() { return 0; };
  Window_Selectable.prototype.spacing = function() { return 12; };
  Window_Selectable.prototype.itemHeight = function() { return this.lineHeight(); };
  Window_Selectable.prototype.itemWidth = function() { return Math.floor((this.width - this.padding * 2 + this.spacing()) / this.maxCols() - this.spacing()); };
  Window_Selectable.prototype.itemRect = function(index) {
    const rect = api.invoke(entry(this).handle, 'itemRect', index, this.maxCols(), this.itemHeight(), this.spacing(), this.itemWidth());
    return { x: rect[0], y: rect[1], width: rect[2], height: rect[3] };
  };
  Window_Selectable.prototype.select = function(index) { this._index = index; this.updateCursor(); this.callUpdateHelp(); };
  Window_Selectable.prototype.deselect = function() { this.select(-1); };
  Window_Selectable.prototype.updateCursor = function() {
    const r = this._index < 0 ? { x: 0, y: 0, width: 0, height: 0 } : this.itemRect(this._index);
    this.setCursorRect(r.x, r.y, r.width, r.height);
  };
  Window_Selectable.prototype.refresh = function() { if (this.contents) { this.contents.clear(); this.drawAllItems(); } };
  Window_Selectable.prototype.drawAllItems = function() { for (let i = 0; i < this.maxItems(); ++i) this.drawItem(i); };
  Window_Selectable.prototype.drawItem = function() {};
  Window_Selectable.prototype.setHandler = function(symbol, method) { this._handlers[symbol] = method; };
  Window_Selectable.prototype.isHandled = function(symbol) { return Boolean(this._handlers[symbol]); };
  Window_Selectable.prototype.callHandler = function(symbol) { if (this.isHandled(symbol)) this._handlers[symbol](); };
  Window_Selectable.prototype.callUpdateHelp = function() { if (this.active && this._helpWindow) this.updateHelp(); };
  Window_Selectable.prototype.updateHelp = function() { this._helpWindow.clear(); };
  Window_Selectable.prototype.itemRectForText = function(index) { const rect = this.itemRect(index); rect.x += this.textPadding(); rect.width -= this.textPadding() * 2; return rect; };
  Window_Selectable.prototype.maxPageRows = function() { return Math.floor((this.height - this.padding * 2) / this.itemHeight()); };
  Window_Selectable.prototype.maxPageItems = function() { return this.maxPageRows() * this.maxCols(); };
  Window_Selectable.prototype.topIndex = function() { return api.field(entry(this).handle, 'topRow') * this.maxCols(); };
  Window_Selectable.prototype.topRow = function() { return api.field(entry(this).handle, 'topRow'); };
  Window_Selectable.prototype.bottomRow = function() { return Math.max(0, this.topRow() + this.maxPageRows() - 1); };
  Window_Selectable.prototype.row = function() { return Math.floor(this.index() / this.maxCols()); };
  Window_Selectable.prototype.maxRows = function() { return Math.max(Math.ceil(this.maxItems() / this.maxCols()), 1); };
  Window_Selectable.prototype.isOpenAndActive = function() { return this.isOpen() && this.active; };
  Window_Selectable.prototype.isCursorVisible = function() { return api.invoke(entry(this).handle, 'cursorVisible', this.maxCols(), this.maxPageRows()); };
  function Window_Command() { this.initialize.apply(this, arguments); }
  inherit(Window_Command, Window_Selectable);
  Window_Command.prototype.initialize = function(x = 0, y = 0) {
    this.clearCommandList(); this.makeCommandList();
    Window_Selectable.prototype.initialize.call(this, x, y, this.windowWidth(), this.windowHeight());
    this.refresh(); this.select(0); this.activate();
  };
  Window_Command.prototype.windowWidth = function() { return 240; };
  Window_Command.prototype.windowHeight = function() { return this.fittingHeight(this.numVisibleRows()); };
  Window_Command.prototype.numVisibleRows = function() { return Math.ceil(this.maxItems() / this.maxCols()); };
  Window_Command.prototype.maxItems = function() { return nodes.has(this) ? api.invoke(entry(this).handle, 'commandCount') : 0; };
  Window_Command.prototype.clearCommandList = function() {
    if (!nodes.has(this)) attach(this, 'window');
    api.invoke(entry(this).handle, 'clearCommands'); entry(this).extensions = [];
  };
  Window_Command.prototype.makeCommandList = function() {};
  Window_Command.prototype.addCommand = function(name, symbol, enabled = true, ext = null) {
    api.invoke(entry(this).handle, 'addCommand', String(name), String(symbol), Boolean(enabled)); entry(this).extensions.push(ext);
  };
  Window_Command.prototype.commandName = function(index) { return api.invoke(entry(this).handle, 'command', index).name; };
  Window_Command.prototype.isCommandEnabled = function(index) { return api.invoke(entry(this).handle, 'command', index).enabled; };
  Window_Command.prototype.currentSymbol = function() { return api.invoke(entry(this).handle, 'command', this.index())?.symbol; };
  Window_Command.prototype.commandSymbol = function(index) { return api.invoke(entry(this).handle, 'command', index).symbol; };
  Window_Command.prototype.currentData = function() {
    const data = api.invoke(entry(this).handle, 'command', this.index());
    return data ? { ...data, ext: entry(this).extensions[this.index()] } : null;
  };
  Window_Command.prototype.currentExt = function() { return this.currentData()?.ext ?? null; };
  Window_Command.prototype.drawItem = function(index) {
    const rect = this.itemRectForText(index); this.resetTextColor(); this.changePaintOpacity(this.isCommandEnabled(index));
    this.drawText(this.commandName(index), rect.x, rect.y, rect.width, this.itemTextAlign());
  };
  Window_Command.prototype.itemTextAlign = function() { return 'left'; };
  function Scene_Base() { this.initialize.apply(this, arguments); }
  inherit(Scene_Base, Container);
  Scene_Base.prototype.initialize = function() { attach(this, 'scene'); this._imageReservationId ??= String(entry(this).handle.identity); };
  prop(Scene_Base, '_active', 'active'); prop(Scene_Base, '_fadeDuration', 'fadeDuration'); prop(Scene_Base, '_fadeSign', 'fadeSign');
  Scene_Base.prototype.create = function() {};
  Scene_Base.prototype.isActive = function() { return this._active; };
  Scene_Base.prototype.isReady = function() { return ImageManager.isReady(); };
  Scene_Base.prototype.start = function() { this._active = true; };
  Scene_Base.prototype.stop = function() { this._active = false; };
  Scene_Base.prototype.isBusy = function() { return this._fadeDuration > 0; };
  Scene_Base.prototype.terminate = function() {};
  Scene_Base.prototype.attachReservation = function() { ImageManager.setDefaultReservationId(this._imageReservationId); };
  Scene_Base.prototype.detachReservation = function() { ImageManager.releaseReservation(this._imageReservationId); };
  Scene_Base.prototype.updateFade = function() { api.invoke(entry(this).handle, 'updateFade'); };
  Scene_Base.prototype.update = function() { this.updateFade(); this.updateChildren(); };
  Scene_Base.prototype.startFadeIn = function(duration, white = false) { api.invoke(entry(this).handle, 'fade', false, duration, white); };
  Scene_Base.prototype.startFadeOut = function(duration, white = false) { api.invoke(entry(this).handle, 'fade', true, duration, white); };
  Scene_Base.prototype.fadeSpeed = function() { return 24; };
  Scene_Base.prototype.slowFadeSpeed = function() { return this.fadeSpeed() * 2; };
  Scene_Base.prototype.createWindowLayer = function() {
    this._windowLayer = new WindowLayer(); this._windowLayer.move(0, 0, Graphics.boxWidth, Graphics.boxHeight); this.addChild(this._windowLayer);
  };
  Scene_Base.prototype.addWindow = function(window) { this._windowLayer.addChild(window); };
  function Scene_Boot() { this.initialize.apply(this, arguments); }
  inherit(Scene_Boot, Scene_Base);
  Scene_Boot.prototype.create = function() { Scene_Base.prototype.create.call(this); options.loadDatabase?.(); Scene_Boot.loadSystemImages(); };
  Scene_Boot.loadSystemImages = function() { ImageManager.reserveSystem('Window'); };
  Scene_Boot.prototype.checkPlayerLocation = function() { options.checkPlayerLocation?.(); };
  Scene_Boot.prototype.updateDocumentTitle = function() {};
  Scene_Boot.prototype.start = function() { Scene_Base.prototype.start.call(this); SceneManager.goto(Scene_Title); };
  function Scene_Title() { this.initialize.apply(this, arguments); }
  inherit(Scene_Title, Scene_Base);
  Scene_Title.prototype.start = function() { Scene_Base.prototype.start.call(this); options.openTitle?.(); };
  function Scene_Map() { this.initialize.apply(this, arguments); }
  inherit(Scene_Map, Scene_Base);
  Scene_Map.prototype.create = function() { Scene_Base.prototype.create.call(this); options.performTransfer?.(); };
  const Graphics = {
    get width() { return native.render.presentation().sourceWidth; },
    get height() { return native.render.presentation().sourceHeight; },
    get boxWidth() { return this.width; }, get boxHeight() { return this.height; },
    get frameCount() { return api.scene(runtime, 'frameCount'); }
  };
  const Input = {};
  for (const method of ['clear', 'isPressed', 'isTriggered', 'isRepeated', 'isLongPressed'])
    Input[method] = (...args) => api.input(runtime, method, ...args);
  for (const field of ['dir4', 'dir8', 'date']) Object.defineProperty(Input, field, { get() { return api.input(runtime, field); } });
  for (const name of ['keyMapper', 'gamepadMapper']) {
    const view = new Proxy({}, {
      get(target, key) { return api.input(runtime, name)[key]; },
      ownKeys() { return Reflect.ownKeys(api.input(runtime, name)); },
      getOwnPropertyDescriptor(target, key) { const map = api.input(runtime, name); return Object.hasOwn(map, key) ? { configurable: true, enumerable: true, writable: true, value: map[key] } : undefined; },
      set(target, key, value) { api.input(runtime, name, Number(key), String(value)); return true; },
      deleteProperty(target, key) { api.input(runtime, name, Number(key), null); return true; }
    });
    Object.defineProperty(Input, name, { configurable: true, enumerable: true, get() { return view; }, set(value) { api.input(runtime, name, value); } });
  }
  function dispatch(handle, method) {
    if (method === 'transitionBusy') return SceneManager.isCurrentSceneBusy();
    const scene = wrap(handle), fn = scene[method];
    if (typeof fn !== 'function') throw new TypeError('Scene.' + method + ' is not callable');
    return fn.call(scene);
  }
  const SceneManager = {
    run(type) { this.goto(type); },
    goto(type) {
      const next = type ? new type() : null;
      if (next && !(next instanceof Scene_Base)) throw new TypeError('Scene transition requires Scene_Base');
      nextRoot = next;
      api.scene(runtime, 'goto', next ? entry(next).handle : null, dispatch);
    },
    update() {
      api.input(runtime, 'update');
      ImageManager.update();
      api.scene(runtime, 'update', dispatch);
      currentRoot = wrap(api.scene(runtime, 'current')); nextRoot = wrap(api.scene(runtime, 'next'));
      for (const [id, reference] of registry) if (!reference.deref()) registry.delete(id);
    },
    get _scene() { return wrap(api.scene(runtime, 'current')); },
    get _nextScene() { return wrap(api.scene(runtime, 'next')); },
    set _nextScene(next) {
      if (next !== null && !(next instanceof Scene_Base)) throw new TypeError('Next scene requires Scene_Base');
      nextRoot = next;
      api.scene(runtime, 'next', next ? entry(next).handle : null);
    },
    isSceneChanging() { return api.scene(runtime, 'changing'); },
    isCurrentSceneBusy() { return Boolean(this._scene && this._scene.isBusy()); },
    isCurrentSceneStarted() { return api.scene(runtime, 'started'); },
    stop() { api.scene(runtime, 'stopped', true); }, resume() { api.scene(runtime, 'stopped', false); },
    clearStack() { this._stack.length = 0; }, _stack: [],
    push(type) { if (this._scene) this._stack.push(this._scene.constructor); this.goto(type); },
    pop() { this.goto(this._stack.pop() || null); },
    prepareNextScene(...args) { this._nextScene.prepare(...args); },
    isNextScene(type) { return this._nextScene?.constructor === type; },
    get stageHandle() { return currentRoot ? entry(currentRoot).handle : null; }
  };
  return { Container, Stage: Container, Sprite, Sprite_Base, TilingSprite, ScreenSprite, Window, WindowLayer, Window_Base, Window_Selectable, Window_Command,
    Scene_Base, Scene_Boot, Scene_Title, Scene_Map, SceneManager, Graphics, Input,
    GlitchFilter,
    displayHandle: object => entry(object).handle };
}
module.exports = { createSceneBindings };
