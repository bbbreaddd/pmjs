'use strict';
const { bitmapHandle } = require('./native-bitmap.cjs');

function createSceneBindings(native, Bitmap, ImageManager, options = {}) {
  const api = native.mvDisplay, runtime = api.open();
  const nodes = new WeakMap(), registry = new Map();
  let currentRoot = null, nextRoot = null;
  let requestedKind = null, pendingNative = null;
  let acceptingNative = false, hasRun = false;
  const sceneInfo = new WeakMap(), stackStates = [];
  function entry(object) {
    const value = nodes.get(object);
    if (!value) throw new TypeError('Display object is not initialized');
    return value;
  }
  function attach(object, kind, existing = null) {
    if (nodes.has(object)) throw new Error('Display object is already initialized');
    const handle = existing || api.create(runtime, kind);
    options.initializeEvents?.(object);
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
    for (const [id, child] of own.children) if (!live.has(id)) {
      if (entry(child).parent === object) entry(child).parent = null;
      own.children.delete(id);
    }
    return result;
  }
  function Container() { this.initialize.apply(this, arguments); }
  if (options.containerPrototype) Object.setPrototypeOf(Container.prototype, options.containerPrototype);
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
    if (value.handle.kind === 'windowLayer') children(child);
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
      if (value.handle.kind === 'windowLayer') children(child);
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
  Container.prototype.destroy = function(settings = {}) {
    if (this._destroyed) return;
    if (settings === true || settings.children) for (const child of this.children) child.destroy(settings);
    this.removeChildren();
    if (this.parent) this.parent.removeChild(this);
    this.visible = false; this.renderable = false; this._destroyed = true;
    this.removeAllListeners?.();
  };
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
  Container.prototype.canvasToLocalX = function(x) { return api.invoke(entry(this).handle, 'canvasLocalX', x); };
  Container.prototype.canvasToLocalY = function(y) { return api.invoke(entry(this).handle, 'canvasLocalY', y); };
  function Sprite_Button() { this.initialize.apply(this, arguments); }
  inherit(Sprite_Button, Sprite);
  Sprite_Button.prototype.initialize = function() { Sprite.prototype.initialize.call(this); this._clickHandler = null; this._touching = false; };
  prop(Sprite_Button, '_touching', 'buttonTouching');
  Sprite_Button.prototype.setColdFrame = function(x, y, w, h) { api.invoke(entry(this).handle, 'buttonCold', x, y, w, h); };
  Sprite_Button.prototype.setHotFrame = function(x, y, w, h) { api.invoke(entry(this).handle, 'buttonHot', x, y, w, h); };
  Sprite_Button.prototype.updateFrame = function() { api.invoke(entry(this).handle, 'buttonFrame'); };
  Sprite_Button.prototype.setClickHandler = function(handler) { this._clickHandler = handler; };
  Sprite_Button.prototype.callClickHandler = function() { if (this._clickHandler) this._clickHandler(); };
  Sprite_Button.prototype.isActive = function() { for (let node = this; node; node = node.parent) if (!node.visible) return false; return true; };
  Sprite_Button.prototype.isButtonTouched = function() { const touch = options.touchInput(); return api.invoke(entry(this).handle, 'buttonHit', touch.x, touch.y); };
  Sprite_Button.prototype.updateTouch = function() {
    const touch = options.touchInput();
    if (api.invoke(entry(this).handle, 'buttonTouch', touch.isTriggered(), touch.isReleased(), this.isButtonTouched(), this.isActive())) this.callClickHandler();
  };
  Sprite_Button.prototype.update = function() { Sprite.prototype.update.call(this); this.updateFrame(); this.updateTouch(); };
  function Sprite_Base() { this.initialize.apply(this, arguments); }
  inherit(Sprite_Base, Sprite);
  Sprite_Base.prototype.initialize = function() { Sprite.prototype.initialize.call(this); };
  Sprite_Base.prototype.update = function() { Sprite.prototype.update.call(this); api.invoke(entry(this).handle, 'updateAnimations'); };
  Sprite_Base.prototype.isAnimationPlaying = function() { return api.invoke(entry(this).handle, 'isAnimationPlaying'); };
  Sprite_Base.prototype.startAnimation = function(animation, mirror, delay) {
    const stock = Sprite_Animation.prototype.initialize === animationInitialize && Sprite_Animation.prototype.setupRate === animationSetupRate;
    options.startAnimation(entry(this).handle, animation.id, mirror, delay, stock ? 4 : new Sprite_Animation()._rate);
  };
  function Sprite_Animation() { this.initialize.apply(this, arguments); }
  inherit(Sprite_Animation, Sprite);
  const animationInitialize = Sprite_Animation.prototype.initialize = function() { Sprite.prototype.initialize.call(this); this.setupRate(); };
  const animationSetupRate = Sprite_Animation.prototype.setupRate = function() { this._rate = 4; };
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
  prop(WindowLayer, 'width'); prop(WindowLayer, 'height');
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
  function Window_Message() { this.initialize.apply(this, arguments); }
  inherit(Window_Message, Window_Base);
  Window_Message.prototype.initialize = function() {
    Window_Base.prototype.initialize.call(this, 0, Graphics.boxHeight - this.windowHeight(), this.windowWidth(), this.windowHeight());
    this.openness = 0; this.clearFlags();
  };
  Window_Message.prototype.windowWidth = function() { return Graphics.boxWidth; };
  Window_Message.prototype.windowHeight = function() { return this.fittingHeight(this.numVisibleRows()); };
  Window_Message.prototype.numVisibleRows = function() { return 4; };
  Window_Message.prototype.clearFlags = function() { options.messageWindow('clearFlags'); };
  Window_Message.prototype.terminateMessage = function() { this.close(); options.messageWindow('terminateMessage'); };
  Window_Message.prototype.startInput = function() { return options.messageWindow('startInput'); };
  for (const field of ['_showFast', '_lineShowFast', '_pauseSkip']) Object.defineProperty(Window_Message.prototype, field, {
    configurable: true, get() { return options.messageWindowField(field); }, set(value) { options.messageWindowField(field, value); }
  });
  function Window_Selectable() { this.initialize.apply(this, arguments); }
  inherit(Window_Selectable, Window_Base);
  Window_Selectable.prototype.initialize = function(x, y, width, height) {
    Window_Base.prototype.initialize.call(this, x, y, width, height);
    this._handlers = {}; this.deactivate(); this.select(-1);
  };
  prop(Window_Selectable, '_index', 'index');
  prop(Window_Selectable, '_cursorFixed', 'cursorFixed'); prop(Window_Selectable, '_cursorAll', 'cursorAll');
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
  Window_Selectable.prototype.select = function(index) { this._index = index; this.ensureCursorVisible(); this.updateCursor(); this.callUpdateHelp(); };
  Window_Selectable.prototype.ensureCursorVisible = function() { api.invoke(entry(this).handle, 'ensureCursorVisible', this.maxItems(), this.maxCols(), this.maxPageRows()); };
  Window_Selectable.prototype.isCursorMovable = function() {
    return api.invoke(entry(this).handle, 'cursorMovable', this.isOpenAndActive(), this._cursorFixed, this._cursorAll, this.maxItems());
  };
  for (const method of ['cursorDown', 'cursorUp', 'cursorRight', 'cursorLeft', 'cursorPagedown', 'cursorPageup'])
    Window_Selectable.prototype[method] = function(wrap = false) {
      const index = api.invoke(entry(this).handle, 'cursorStep', this.maxItems(), this.maxCols(), this.maxPageRows(), method, Boolean(wrap));
      if (index !== this.index() || (wrap && this.maxItems() === 1)) this.select(index);
      else this.updateCursor();
    };
  Window_Selectable.prototype.update = function() {
    Window_Base.prototype.update.call(this); this.processCursorMove(); this.processHandling();
  };
  Window_Selectable.prototype.processCursorMove = function() {
    if (usesNativeInput(this)) return;
    const before = this.index();
    api.invoke(entry(this).handle, 'processCursorMove', this, Input);
    if (before !== this.index()) options.soundManager?.()?.playCursor();
  };
  Window_Selectable.prototype.processHandling = function() { if (usesNativeInput(this)) return; api.invoke(entry(this).handle, 'processHandling', this, Input); };
  for (const method of ['processOk', 'processCancel', 'processPagedown', 'processPageup'])
    Window_Selectable.prototype[method] = function() { api.invoke(entry(this).handle, method, this, options.soundManager?.()); };
  Window_Selectable.prototype.isCurrentItemEnabled = function() { return true; };
  Window_Selectable.prototype.isOkEnabled = function() { return this.isHandled('ok'); };
  Window_Selectable.prototype.isCancelEnabled = function() { return this.isHandled('cancel'); };
  Window_Selectable.prototype.isOkTriggered = function() { return Input.isRepeated('ok'); };
  Window_Selectable.prototype.isCancelTriggered = function() { return Input.isRepeated('cancel'); };
  Window_Selectable.prototype.updateInputData = function() { Input.update(); options.touchInput?.()?.update(); };
  Window_Selectable.prototype.callOkHandler = function() { this.callHandler('ok'); };
  Window_Selectable.prototype.callCancelHandler = function() { this.callHandler('cancel'); };
  for (const name of ['Ok', 'Buzzer'])
    Window_Selectable.prototype['play' + name + 'Sound'] = function() { options.soundManager?.()?.['play' + name]?.(); };
  Window_Selectable.prototype.deselect = function() { this.select(-1); };
  Window_Selectable.prototype.updateCursor = function() {
    const r = this._index < 0 ? { x: 0, y: 0, width: 0, height: 0 } : this.itemRect(this._index);
    this.setCursorRect(r.x, r.y, r.width, r.height);
  };
  Window_Selectable.prototype.refresh = function() { if (this.contents) { this.contents.clear(); this.drawAllItems(); } };
  Window_Selectable.prototype.drawAllItems = function() { for (let i = 0; i < this.maxItems(); ++i) this.drawItem(i); };
  Window_Selectable.prototype.drawItem = function() {};
  Window_Selectable.prototype.clearItem = function(index) { const rect = this.itemRect(index); this.contents.clearRect(rect.x, rect.y, rect.width, rect.height); };
  Window_Selectable.prototype.redrawItem = function(index) { if (index >= 0) { this.clearItem(index); this.drawItem(index); } };
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
    const own=entry(this), index=api.invoke(own.handle,'commandCount');
    api.invoke(own.handle, 'addCommand', String(name), String(symbol), Boolean(enabled)); own.extensions[index]=ext;
  };
  Window_Command.prototype.commandName = function(index) { return api.invoke(entry(this).handle, 'command', index).name; };
  Window_Command.prototype.isCommandEnabled = function(index) { return api.invoke(entry(this).handle, 'command', index).enabled; };
  Window_Command.prototype.isCurrentItemEnabled = function() { return Boolean(this.currentData()?.enabled); };
  Window_Command.prototype.isOkEnabled = function() { return true; };
  Window_Command.prototype.callOkHandler = function() { if (this.isHandled(this.currentSymbol())) this.callHandler(this.currentSymbol()); else Window_Selectable.prototype.callOkHandler.call(this); };
  Window_Command.prototype.currentSymbol = function() { return api.invoke(entry(this).handle, 'command', this.index())?.symbol; };
  Window_Command.prototype.commandSymbol = function(index) { return api.invoke(entry(this).handle, 'command', index).symbol; };
  Window_Command.prototype.currentData = function() {
    const data = api.invoke(entry(this).handle, 'command', this.index());
    return data ? { ...data, ext: entry(this).extensions?.[this.index()] ?? data.ext } : null;
  };
  Window_Command.prototype.currentExt = function() { return this.currentData()?.ext ?? null; };
  Window_Command.prototype.drawItem = function(index) {
    const rect = this.itemRectForText(index); this.resetTextColor(); this.changePaintOpacity(this.isCommandEnabled(index));
    this.drawText(this.commandName(index), rect.x, rect.y, rect.width, this.itemTextAlign());
  };
  Window_Command.prototype.itemTextAlign = function() { return 'left'; };
  Window_Command.prototype.findSymbol = function(symbol) { for (let i = 0; i < this.maxItems(); ++i) if (this.commandSymbol(i) === symbol) return i; return -1; };
  Window_Command.prototype.selectSymbol = function(symbol) { const index = this.findSymbol(symbol); this.select(index >= 0 ? index : 0); };
  const nativeWindows = {};
  const windowBases = { Window_Base, Window_Selectable, Window_Command };
  const windowDescriptions = new Map((options.windowClasses?.() || []).map(item => [item.name, item]));
  function installWindow(name) {
    if (nativeWindows[name] || windowBases[name]) return nativeWindows[name] || windowBases[name];
    const description = windowDescriptions.get(name);
    if (!description) throw new Error('Unknown native window parent: ' + name);
    const Parent = installWindow(description.parent);
    const Type = function() { this.initialize.apply(this, arguments); };
    Object.defineProperty(Type, 'name', { value: name });
    inherit(Type, Parent); nativeWindows[name] = Type;
    const invoke = (object, method, args = []) => options.windowModel(entry(object).handle, name, method, args);
    Type.prototype.initialize = function(...args) {
      if (!nodes.has(this)) attach(this, 'window');
      const nativeArgs = args.slice(0, description.arguments);
      if (name === 'Window_NameEdit') nativeArgs.splice(0, nativeArgs.length, options.actorId(args[0]), args[1], args[0]?.name() || '');
      const rect = invoke(this, 'construct', nativeArgs);
      if (description.arguments === 0 && args.length) this._messageWindow = args[0];
      if (description.command) Window_Command.prototype.initialize.call(this, rect[0], rect[1]);
      else {
        (description.selectable ? Window_Selectable : Window_Base).prototype.initialize.call(this, ...rect);
        this.refresh();
      }
    };
    Type.prototype.windowWidth = function() { return invoke(this, 'geometry')[2]; };
    Type.prototype.windowHeight = function() { return invoke(this, 'geometry')[3]; };
    if (description.command) Type.prototype.makeCommandList = function() { invoke(this, 'makeCommandList'); };
    else {
      Type.prototype.refresh = function() {
        invoke(this, 'refreshModel');
        if (this.contents) {
          this.contents.clear();
          if (description.selectable) this.drawAllItems(); else invoke(this, 'drawContent');
        }
      };
      if (description.selectable) {
        for (const method of ['maxItems', 'itemHeight', 'maxCols', 'isCurrentItemEnabled'])
          Type.prototype[method] = function() { return invoke(this, method); };
        Type.prototype.drawItem = function(index) { invoke(this, 'drawItem', [index]); };
      }
    }
    const fieldNames = { actorId: '_actor', skillType: '_stypeId' };
    for (const field of description.fields) {
      Object.defineProperty(Type.prototype, fieldNames[field] || '_' + field, {
        configurable: true,
        get() { const value = invoke(this, field); return field === 'actorId' ? options.actor(value) : value; },
        set(value) { invoke(this, field, [field === 'actorId' ? options.actorId(value) : value]); }
      });
      const method = field === 'actorId' ? 'setActor' : field === 'skillType' ? 'setStypeId' : 'set' + field[0].toUpperCase() + field.slice(1);
      Type.prototype[method] = function(value) { this[fieldNames[field] || '_' + field] = value; this.refresh(); };
    }
    return Type;
  }
  for (const name of windowDescriptions.keys()) installWindow(name);
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
  Scene_Base.prototype.fadeOutAll = function() {
    options.fadeAudio(this.slowFadeSpeed() / 60);
    this.startFadeOut(this.slowFadeSpeed());
  };
  Scene_Base.prototype.createWindowLayer = function() {
    this._windowLayer = new WindowLayer(); this._windowLayer.move(0, 0, Graphics.boxWidth, Graphics.boxHeight); this.addChild(this._windowLayer);
  };
  Scene_Base.prototype.addWindow = function(window) { this._windowLayer.addChild(window); };
  function Scene_Battle() { this.initialize.apply(this, arguments); }
  inherit(Scene_Battle, Scene_Base);
  Scene_Battle.prototype.initialize = function() { Scene_Base.prototype.initialize.call(this); };
  Scene_Battle.prototype.updateWindowPositions = function() {
    const target = this._partyCommandWindow.width / (options.battleManager().isInputting() ? 1 : 2);
    if (this._statusWindow.x < target) this._statusWindow.x = Math.min(target, this._statusWindow.x + 16);
    if (this._statusWindow.x > target) this._statusWindow.x = Math.max(target, this._statusWindow.x - 16);
  };
  function Scene_MenuBase() { this.initialize.apply(this, arguments); }
  inherit(Scene_MenuBase, Scene_Base);
  Scene_MenuBase.prototype.initialize = function() { Scene_Base.prototype.initialize.call(this); };
  Scene_MenuBase.prototype.create = function() {
    Scene_Base.prototype.create.call(this);
    this.createBackground(); this.updateActor(); this.createWindowLayer();
  };
  Scene_MenuBase.prototype.actor = function() { return this._actor; };
  Scene_MenuBase.prototype.updateActor = function() { this._actor = options.gameParty().menuActor(); };
  Scene_MenuBase.prototype.createBackground = function() {
    this._backgroundSprite = new Sprite();
    this._backgroundSprite.bitmap = SceneManager.backgroundBitmap();
    this.addChild(this._backgroundSprite);
  };
  Scene_MenuBase.prototype.setBackgroundOpacity = function(opacity) { this._backgroundSprite.opacity = opacity; };
  function Scene_GameEnd() { this.initialize.apply(this, arguments); }
  inherit(Scene_GameEnd, Scene_MenuBase);
  Scene_GameEnd.prototype.create = function() { Scene_MenuBase.prototype.create.call(this); this.createCommandWindow(); };
  Scene_GameEnd.prototype.stop = function() { Scene_MenuBase.prototype.stop.call(this); this._commandWindow.close(); };
  Scene_GameEnd.prototype.createBackground = function() { Scene_MenuBase.prototype.createBackground.call(this); this.setBackgroundOpacity(128); };
  Scene_GameEnd.prototype.createCommandWindow = function() {
    const Window_GameEnd = options.sceneClass('Window_GameEnd');
    this._commandWindow = new Window_GameEnd();
    this._commandWindow.setHandler('toTitle', this.commandToTitle.bind(this));
    this._commandWindow.setHandler('cancel', this.popScene.bind(this));
    this.addWindow(this._commandWindow);
  };
  Scene_GameEnd.prototype.commandToTitle = function() { this.fadeOutAll(); SceneManager.goto(Scene_Title); };
  Scene_MenuBase.prototype.nextActor = function() {
    options.gameParty().makeMenuActorNext(); this.updateActor(); this.onActorChange();
  };
  Scene_MenuBase.prototype.previousActor = function() {
    options.gameParty().makeMenuActorPrevious(); this.updateActor(); this.onActorChange();
  };
  Scene_MenuBase.prototype.onActorChange = function() {};
  function Window_MenuCommand() { this.initialize.apply(this, arguments); }
  inherit(Window_MenuCommand, Window_Command);
  Window_MenuCommand.prototype.makeCommandList = function() {
    for (const command of options.menuCommands()) this.addCommand(command.name, command.symbol, command.enabled);
  };
  function Scene_Menu() { this.initialize.apply(this, arguments); }
  inherit(Scene_Menu, Scene_MenuBase);
  Scene_Menu.prototype.createCommandWindow = function() {
    const window = this._commandWindow = new Window_MenuCommand(0, 0);
    for (const [symbol, method] of [['item', 'commandItem'], ['skill', 'commandPersonal'], ['equip', 'commandPersonal'],
      ['status', 'commandPersonal'], ['formation', 'commandFormation'], ['options', 'commandOptions'],
      ['save', 'commandSave'], ['gameEnd', 'commandGameEnd'], ['cancel', 'popScene']])
      window.setHandler(symbol, (...args) => this[method](...args));
    this.addWindow(window);
  };
  Scene_Menu.prototype.commandItem = function() { SceneManager.push(Scene_Item); };
  Scene_Menu.prototype.commandPersonal = function() {
    this._statusWindow.setFormationMode(false); this._statusWindow.selectLast(); this._statusWindow.activate();
    this._statusWindow.setHandler('ok', this.onPersonalOk.bind(this));
    this._statusWindow.setHandler('cancel', this.onPersonalCancel.bind(this));
  };
  Scene_Menu.prototype.onPersonalCancel = function() { this._statusWindow.deselect(); this._commandWindow.activate(); };
  Scene_Base.prototype.popScene = function() { SceneManager.pop(); };
  function Window_Options() { this.initialize.apply(this, arguments); }
  inherit(Window_Options, Window_Command);
  Window_Options.prototype.initialize = function() { Window_Command.prototype.initialize.call(this, 0, 0); this.updatePlacement(); };
  Window_Options.prototype.windowWidth = function() { return 400; };
  Window_Options.prototype.windowHeight = function() { return this.fittingHeight(Math.min(this.numVisibleRows(), 12)); };
  Window_Options.prototype.updatePlacement = function() { this.x = (Graphics.boxWidth - this.width) / 2; this.y = (Graphics.boxHeight - this.height) / 2; };
  Window_Options.prototype.makeCommandList = function() { this.addGeneralOptions(); this.addVolumeOptions(); };
  Window_Options.prototype.addGeneralOptions = function() {
    for (const command of options.optionCommands().slice(0, 2)) this.addCommand(command.name, command.symbol);
  };
  Window_Options.prototype.addVolumeOptions = function() {
    for (const command of options.optionCommands().slice(2)) this.addCommand(command.name, command.symbol);
  };
  Window_Options.prototype.getConfigValue = function(symbol) { return options.configManager()[symbol]; };
  Window_Options.prototype.setConfigValue = function(symbol, value) { options.configManager()[symbol] = value; };
  Window_Options.prototype.isVolumeSymbol = function(symbol) { return symbol.includes('Volume'); };
  Window_Options.prototype.volumeOffset = function() { return 20; };
  Window_Options.prototype.booleanStatusText = function(value) { return value ? 'ON' : 'OFF'; };
  Window_Options.prototype.volumeStatusText = function(value) { return value + '%'; };
  Window_Options.prototype.statusWidth = function() { return 120; };
  Window_Options.prototype.statusText = function(index) {
    const symbol = this.commandSymbol(index), value = this.getConfigValue(symbol);
    return this.isVolumeSymbol(symbol) ? this.volumeStatusText(value) : this.booleanStatusText(value);
  };
  Window_Options.prototype.drawItem = function(index) {
    const rect = this.itemRectForText(index), width = rect.width - this.statusWidth();
    this.resetTextColor(); this.changePaintOpacity(this.isCommandEnabled(index));
    this.drawText(this.commandName(index), rect.x, rect.y, width, 'left');
    this.drawText(this.statusText(index), width, rect.y, this.statusWidth(), 'right');
  };
  Window_Options.prototype.changeValue = function(symbol, value) {
    if (this.getConfigValue(symbol) !== value) {
      this.setConfigValue(symbol, value); this.redrawItem(this.findSymbol(symbol)); options.soundManager().playCursor();
    }
  };
  Window_Options.prototype.processOk = function() {
    const symbol = this.commandSymbol(this.index()), value = this.getConfigValue(symbol);
    this.changeValue(symbol, this.isVolumeSymbol(symbol) ? (value + this.volumeOffset() > 100 ? 0 : Math.max(0, value + this.volumeOffset())) : !value);
  };
  for (const [method, direction] of [['cursorLeft', -1], ['cursorRight', 1]]) Window_Options.prototype[method] = function() {
    const symbol = this.commandSymbol(this.index()), value = this.getConfigValue(symbol);
    this.changeValue(symbol, this.isVolumeSymbol(symbol) ? Math.max(0, Math.min(100, value + direction * this.volumeOffset())) : direction > 0);
  };
  function Scene_Options() { this.initialize.apply(this, arguments); }
  inherit(Scene_Options, Scene_MenuBase);
  Scene_Options.prototype.create = function() { Scene_MenuBase.prototype.create.call(this); this.createOptionsWindow(); };
  Scene_Options.prototype.createOptionsWindow = function() {
    this._optionsWindow = new Window_Options(); this._optionsWindow.setHandler('cancel', this.popScene.bind(this)); this.addWindow(this._optionsWindow);
  };
  Scene_Options.prototype.terminate = function() { Scene_MenuBase.prototype.terminate.call(this); options.configManager().save?.(); };
  function Scene_Gameover() { this.initialize.apply(this, arguments); }
  inherit(Scene_Gameover, Scene_Base);
  Scene_Gameover.prototype.create = function() { Scene_Base.prototype.create.call(this); this.playGameoverMusic(); this.createBackground(); };
  Scene_Gameover.prototype.playGameoverMusic = function() { options.gameoverMusic(); };
  Scene_Gameover.prototype.createBackground = function() {
    this._backSprite = new Sprite(ImageManager.loadSystem('GameOver')); this.addChild(this._backSprite);
  };
  Scene_Gameover.prototype.start = function() { Scene_Base.prototype.start.call(this); this.startFadeIn(this.slowFadeSpeed(), false); };
  Scene_Gameover.prototype.update = function() {
    if (!nativeDriven(this) && this.isActive() && !this.isBusy() && this.isTriggered()) this.gotoTitle();
    Scene_Base.prototype.update.call(this);
  };
  Scene_Gameover.prototype.isTriggered = function() { return Input.isTriggered('ok') || options.touchInput().isTriggered(); };
  Scene_Gameover.prototype.gotoTitle = function() { SceneManager.goto(Scene_Title); };
  Scene_Gameover.prototype.stop = function() { Scene_Base.prototype.stop.call(this); this.fadeOutAll(); };
  Scene_Gameover.prototype.terminate = function() { Scene_Base.prototype.terminate.call(this); options.audioManager().stopAll(); };
  function Scene_File() { this.initialize.apply(this, arguments); }
  inherit(Scene_File, Scene_MenuBase);
  Scene_File.prototype.initialize = function() { Scene_MenuBase.prototype.initialize.call(this); };
  function Scene_Load() { this.initialize.apply(this, arguments); }
  inherit(Scene_Load, Scene_File);
  Scene_Load.prototype.initialize = function() { Scene_File.prototype.initialize.call(this); this._loadSuccess = false; };
  Scene_Load.prototype.onLoadSuccess = function() {
    options.soundManager().playLoad(); this.fadeOutAll(); this.reloadMapIfUpdated();
    SceneManager.goto(Scene_Map); this._loadSuccess = true;
  };
  Scene_Load.prototype.reloadMapIfUpdated = function() { options.reloadMapIfUpdated?.(); };
  function Scene_ItemBase() { this.initialize.apply(this, arguments); }
  inherit(Scene_ItemBase, Scene_MenuBase);
  Scene_ItemBase.prototype.initialize = function() { Scene_MenuBase.prototype.initialize.call(this); };
  Scene_ItemBase.prototype.create = function() { Scene_MenuBase.prototype.create.call(this); };
  Scene_ItemBase.prototype.item = function() { return this._itemWindow.item(); };
  Scene_ItemBase.prototype.user = function() { return null; };
  Scene_ItemBase.prototype.isCursorLeft = function() { return this._itemWindow.index() % 2 === 0; };
  Scene_ItemBase.prototype.showSubWindow = function(window) {
    window.x = this.isCursorLeft() ? Graphics.boxWidth - window.width : 0;
    window.show(); window.activate();
  };
  Scene_ItemBase.prototype.hideSubWindow = function(window) {
    window.hide(); window.deactivate(); this.activateItemWindow();
  };
  Scene_ItemBase.prototype.activateItemWindow = function() { this._itemWindow.refresh(); this._itemWindow.activate(); };
  Scene_ItemBase.prototype.onActorCancel = function() { this.hideSubWindow(this._actorWindow); };
  function Scene_Item() { this.initialize.apply(this, arguments); }
  inherit(Scene_Item, Scene_ItemBase);
  function Scene_Skill() { this.initialize.apply(this, arguments); }
  inherit(Scene_Skill, Scene_ItemBase);
  function Scene_Boot() { this.initialize.apply(this, arguments); }
  inherit(Scene_Boot, Scene_Base);
  Scene_Boot.prototype.create = function() { Scene_Base.prototype.create.call(this); options.loadDatabase?.(); Scene_Boot.loadSystemImages(); };
  Scene_Boot.prototype.isReady = function() {
    return Scene_Base.prototype.isReady.call(this) && (options.isDatabaseReady ? options.isDatabaseReady() : true);
  };
  Scene_Boot.loadSystemImages = function() { ImageManager.reserveSystem('Window'); };
  Scene_Boot.prototype.checkPlayerLocation = function() { options.checkPlayerLocation?.(); };
  Scene_Boot.prototype.updateDocumentTitle = function() {};
  Scene_Boot.prototype.start = function() { Scene_Base.prototype.start.call(this); SceneManager.goto(Scene_Title); };
  function Scene_Title() { this.initialize.apply(this, arguments); }
  inherit(Scene_Title, Scene_Base);
  Scene_Title.prototype.start = function() { Scene_Base.prototype.start.call(this); SceneManager.clearStack(); if (!sceneInfo.get(this)?.nativeRequested) options.openTitle?.(); };
  function Scene_Map() { this.initialize.apply(this, arguments); }
  inherit(Scene_Map, Scene_Base);
  Scene_Map.prototype.create = function() {
    Scene_Base.prototype.create.call(this);
    if (options.mapSpriteset) this._spriteset = options.mapSpriteset;
    options.performTransfer?.();
  };
  function Scene_Equip() { this.initialize.apply(this, arguments); }
  inherit(Scene_Equip, Scene_MenuBase);
  function Scene_Status() { this.initialize.apply(this, arguments); }
  inherit(Scene_Status, Scene_MenuBase);
  function Scene_Save() { this.initialize.apply(this, arguments); }
  inherit(Scene_Save, Scene_File);
  function Scene_Shop() { this.initialize.apply(this, arguments); }
  inherit(Scene_Shop, Scene_MenuBase);
  function Scene_Name() { this.initialize.apply(this, arguments); }
  inherit(Scene_Name, Scene_MenuBase);
  function Scene_Debug() { this.initialize.apply(this, arguments); }
  inherit(Scene_Debug, Scene_MenuBase);
  Scene_Map.prototype.start = function() { Scene_Base.prototype.start.call(this); SceneManager.clearStack(); };
  const nativeScenes = [Scene_Title, Scene_Map, Scene_Menu, Scene_Item, Scene_Skill, Scene_Equip, Scene_Status,
    Scene_Menu, Scene_Options, Scene_Save, Scene_Load, Scene_Battle, Scene_Gameover, Scene_Shop, Scene_Name, Scene_Debug];
  function sceneClass(kind) {
    const type = nativeScenes[kind];
    return options.sceneClass?.(type.name) || type;
  }
  function kindOf(scene) {
    if (!scene) return -1;
    if (requestedKind !== null && requestedKind >= 0 && scene instanceof sceneClass(requestedKind)) return requestedKind;
    return nativeScenes.findIndex((type, kind) => scene instanceof sceneClass(kind));
  }
  function nativeDriven(scene) {
    if (!scene) return false;
    const kind = sceneInfo.get(scene)?.kind ?? kindOf(scene);
    return kind >= 0 && (sceneInfo.get(scene)?.nativeRequested || scene.constructor === sceneClass(kind) || scene instanceof Scene_Map);
  }
  function usesNativeInput(object) {
    while (object.parent) object = object.parent;
    return object === SceneManager._scene && nativeDriven(object);
  }
  function prepareScene(scene) {
    const kind = kindOf(scene);
    if (scene) sceneInfo.set(scene, { kind, nativeRequested: requestedKind !== null });
    if (!(acceptingNative && kind === requestedKind) && (kind >= 0 || (requestedKind !== null && requestedKind >= 0)))
      options.sceneControl?.('prepare', kind >= 0 ? kind : requestedKind);
  }
  function Graphics() { throw new Error('Graphics is a static class'); }
  Object.defineProperties(Graphics, Object.getOwnPropertyDescriptors({
    get width() { return native.render.presentation().sourceWidth; },
    get height() { return native.render.presentation().sourceHeight; },
    get boxWidth() { return this.width; }, get boxHeight() { return this.height; },
    get frameCount() { return api.scene(runtime, 'frameCount'); },
    set frameCount(value) { api.scene(runtime,'frameCount',Number(value)); }
  }));
  Graphics.initialize = function(width,height) { return options.coreService('initializeGraphics',width,height); };
  Graphics._rendererType = 'native'; Graphics._skipCount = 0; Graphics._maxSkip = 3;
  Graphics._renderer = { type: 'native', clear() { native.render.clearScene(0,0,0,1); }, render(stage) { options.submitStage(entry(stage).handle); } };
  Graphics.render = function(stage) { if (stage) this._renderer.render(stage); };
  for (const method of ['startLoading','endLoading','updateLoading','isVideoPlaying','tickStart','tickEnd'])
    Graphics[method] = (...args) => options.coreService(method,...args);
  Graphics.printError = function(name,message) { console.error(message?.stack || message); options.coreService('printError',String(name),String(message)); };
  Graphics.loadFont = (family, source) => Bitmap.loadFont(family, String(source).replace(/^\/game\//, ''));
  Graphics.isFontLoaded = family => options.coreService('isFontLoaded', family);
  Graphics._isFullScreen = () => native.runtime.isFullscreen();
  Graphics._requestFullScreen = () => native.runtime.setFullscreen(true);
  Graphics._cancelFullScreen = () => native.runtime.setFullscreen(false);
  const Input = {};
  for (const method of ['clear', 'update', 'isPressed', 'isTriggered', 'isRepeated', 'isLongPressed'])
    Input[method] = (...args) => api.input(runtime, method, ...args);
  for (const field of ['dir4', 'dir8', 'date']) Object.defineProperty(Input, field, { get() { return api.input(runtime, field); } });
  Object.defineProperty(Input, '_latestButton', { configurable: true, get() { return api.input(runtime, '_latestButton'); }, set(value) { api.input(runtime, '_latestButton', value); } });
  for (const name of ['keyMapper', 'gamepadMapper', '_currentState']) {
    const view = new Proxy({}, {
      get(target, key) { return api.input(runtime, name)[key]; },
      ownKeys() { return Reflect.ownKeys(api.input(runtime, name)); },
      getOwnPropertyDescriptor(target, key) { const map = api.input(runtime, name); return Object.hasOwn(map, key) ? { configurable: true, enumerable: true, writable: true, value: map[key] } : undefined; },
      set(target, key, value) { api.input(runtime, name, name === '_currentState' ? String(key) : Number(key), name === '_currentState' ? Boolean(value) : String(value)); return true; },
      deleteProperty(target, key) { api.input(runtime, name, name === '_currentState' ? String(key) : Number(key), null); return true; }
    });
    Object.defineProperty(Input, name, { configurable: true, enumerable: true, get() { return view; }, set(value) { api.input(runtime, name, value); } });
  }
  function dispatch(handle, method) {
    if (method === 'transitionBusy') return SceneManager.isCurrentSceneBusy();
    const scene = wrap(handle);
    if (method === 'create') options.sceneControl?.('commit', sceneInfo.get(scene)?.kind ?? kindOf(scene));
    const fn = scene[method];
    if (typeof fn !== 'function') throw new TypeError('Scene.' + method + ' is not callable');
    return fn.call(scene);
  }
  function SceneManager() { throw new Error('SceneManager is a static class'); }
  Object.defineProperties(SceneManager, Object.getOwnPropertyDescriptors({
    run(type) { this.initialize(); this.goto(type); },
    initialize() { this.ticker ||= options.createTicker?.(); this.initGraphics(); this.initAudio(); this.initInput(); this.checkPluginErrors(); },
    initGraphics() { (options.graphics?.() || Graphics).initialize(Graphics.width,Graphics.height); },
    initAudio() { options.webAudio().initialize(); },
    initInput() { Input.clear(); options.touchInput().clear(); },
    checkPluginErrors() { options.checkPluginErrors(); },
    goto(type) {
      pendingNative = null;
      hasRun = true;
      const next = type ? new type() : null;
      if (next && !(next instanceof Scene_Base)) throw new TypeError('Scene transition requires Scene_Base');
      nextRoot = next;
      api.scene(runtime, 'goto', next ? entry(next).handle : null, dispatch);
      prepareScene(next);
    },
    update(deltaTime = 1) { this.updateManagers(); this.updateMain(); this.renderScene(); },
    updateManagers() { ImageManager.update(); },
    updateInputData() { Input.update(); },
    updateMain() { this.updateInputData(); this.changeScene(); this.updateScene(); },
    changeScene() {
      if (pendingNative && !api.scene(runtime, 'stopped')) {
        const request = pendingNative;
        pendingNative = null;
        requestedKind = request.kind; acceptingNative = true;
        try { this.goto(request.type); }
        finally { requestedKind = null; acceptingNative = false; }
        if (!api.scene(runtime, 'changing')) options.sceneControl?.('commit', sceneInfo.get(this._scene)?.kind ?? kindOf(this._scene));
      }
      api.scene(runtime,'change',dispatch);
      currentRoot = wrap(api.scene(runtime, 'current')); nextRoot = wrap(api.scene(runtime, 'next'));
      if (!currentRoot && !nextRoot) options.sceneControl?.('commit', -1);
    },
    updateScene() {
      api.scene(runtime,'updateScene',dispatch);
      currentRoot = wrap(api.scene(runtime, 'current')); nextRoot = wrap(api.scene(runtime, 'next'));
      if (!currentRoot && !nextRoot) options.sceneControl?.('commit', -1);
      for (const [id, reference] of registry) if (!reference.deref()) registry.delete(id);
    },
    renderScene() {
      if (nativeDriven(this._scene)) { options.submitStage(null); return; }
      if (this._scene && this.isCurrentSceneStarted()) (options.graphics?.() || Graphics).render(this._scene);
    },
    onSceneStart() { Graphics.endLoading(); },
    catchException(error) { throw error; },
    get _stopped() { return api.scene(runtime,'stopped'); },
    set _stopped(value) { api.scene(runtime,'stopped',Boolean(value)); },
    get _sceneStarted() { return api.scene(runtime,'started'); },
    set _sceneStarted(value) { api.scene(runtime,'started',Boolean(value)); },
    get _scene() { return wrap(api.scene(runtime, 'current')); },
    get _nextScene() { return wrap(api.scene(runtime, 'next')); },
    set _nextScene(next) {
      pendingNative = null;
      if (next !== null && !(next instanceof Scene_Base)) throw new TypeError('Next scene requires Scene_Base');
      nextRoot = next;
      api.scene(runtime, 'next', next ? entry(next).handle : null);
      prepareScene(next);
    },
    backgroundBitmap() { return this._backgroundBitmap || null; },
    isSceneChanging() { return Boolean(pendingNative) || api.scene(runtime, 'changing'); },
    isCurrentSceneBusy() { return Boolean(this._scene && this._scene.isBusy()); },
    isCurrentSceneStarted() { return api.scene(runtime, 'started'); },
    stop() { api.scene(runtime, 'stopped', true); }, resume() { api.scene(runtime, 'stopped', false); },
    clearStack() { this._stack.length = 0; stackStates.length = 0; }, _stack: [],
    push(type) {
      if (this._scene) {
        const previous = this._scene.constructor;
        stackStates[this._stack.length] = { type: previous, kind: sceneInfo.get(this._scene)?.kind ?? kindOf(this._scene), nativeRequested: Boolean(sceneInfo.get(this._scene)?.nativeRequested), state: options.sceneControl?.('capture') };
        this._stack.push(previous);
      }
      this.goto(type);
    },
    pop() {
      const previous = stackStates[this._stack.length - 1], type = this._stack.pop() || null;
      stackStates.length = this._stack.length;
      this.goto(type);
      if (type && previous?.type === type && previous.state && this._nextScene?.constructor === type) {
        sceneInfo.set(this._nextScene, { kind: previous.kind, nativeRequested: previous.nativeRequested || requestedKind !== null });
        options.sceneControl?.('restore', previous.state);
      }
    },
    prepareNextScene(...args) { this._nextScene.prepare(...args); },
    isNextScene(type) { return pendingNative ? pendingNative.type === type : this._nextScene?.constructor === type; },
    get nativeDriven() { return nativeDriven(this._scene); },
    get canStep() { return !api.scene(runtime, 'stopped') && !this.isSceneChanging() && (!hasRun || this.isCurrentSceneStarted()); },
    get stageHandle() { return currentRoot ? entry(currentRoot).handle : null; }
  }));
  return { ...nativeWindows, Container, Stage: Container, Sprite, Sprite_Button, Sprite_Base, Sprite_Animation, TilingSprite, ScreenSprite, Window, WindowLayer, Window_Base, Window_Selectable, Window_Command, Window_MenuCommand, Window_Options, Window_Message,
    Scene_Base, Scene_Battle, Scene_MenuBase, Scene_Menu, Scene_Options, Scene_Gameover, Scene_GameEnd, Scene_File, Scene_Load, Scene_Save, Scene_Equip, Scene_Status, Scene_Shop, Scene_Name, Scene_Debug, Scene_ItemBase, Scene_Item, Scene_Skill, Scene_Boot, Scene_Title, Scene_Map, SceneManager, Graphics, Input,
    GlitchFilter,
    requestScene(method, kind) {
      if (method === 'ownsScenes') return true;
      if (method === 'hasPrevious') return SceneManager._stack.length > 0;
      if (method === 'isPreviousScene') {
        const previous = stackStates[SceneManager._stack.length - 1];
        return previous && previous.type === SceneManager._stack.at(-1) ? previous.kind === kind : SceneManager._stack.at(-1) === sceneClass(kind);
      }
      if (method === 'clearStack') { SceneManager.clearStack(); return true; }
      let type = sceneClass(kind), state;
      if (method === 'push') {
        const scene = SceneManager._scene, previousType = pendingNative?.type || scene?.constructor;
        if (previousType) {
          stackStates[SceneManager._stack.length] = { type: previousType, kind: pendingNative?.kind ?? sceneInfo.get(scene)?.kind ?? kindOf(scene), nativeRequested: Boolean(pendingNative || sceneInfo.get(scene)?.nativeRequested), state: options.sceneControl?.('capture') };
          SceneManager._stack.push(previousType);
        }
      } else if (method === 'pop') {
        const previous = stackStates[SceneManager._stack.length - 1];
        type = SceneManager._stack.pop() || null;
        stackStates.length = SceneManager._stack.length;
        if (type && previous?.type === type) { kind = previous.kind; state = previous.state; }
        else kind = nativeScenes.findIndex((base, index) => type === sceneClass(index));
      }
      pendingNative = { type, kind };
      if (state) options.sceneControl?.('restore', state);
      else if (kind >= 0) options.sceneControl?.('prepare', kind);
      return true;
    },
    displayHandle: object => entry(object).handle,
    displayField(handle, field, ...value) {
      return wrap(options.boundDisplayField(handle, field, runtime, ...value.map(object => object == null ? null : entry(object).handle)));
    },
    initializeDisplay(object, handle) {
      const display = options.boundDisplay(handle, runtime);
      if (!display) return false;
      attach(object, display.kind, display); return true;
    } };
}
module.exports = { createSceneBindings };
