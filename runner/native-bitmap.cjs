'use strict';
const bitmapFactories = new WeakMap();
function findBitmapFactory(Type) {
  for (let current=Type;current;current=Object.getPrototypeOf(current)) {
    const factory=bitmapFactories.get(current);
    if (factory) return factory;
  }
  return null;
}
let nextReservation = 2n;

function createBitmapClass(native, PIXI = null, fonts = null) {
  const api = native.mvBitmap;
  if (!api) throw new Error('Native Bitmap bindings are unavailable');
  const runtime = api.open();
  const instances = new WeakMap();
  const pending = new Set();
  const loadedFonts = new Map();
  const drawingMethods = new Set(['resize', 'clear', 'clearRect', 'fillRect', 'fillAll', 'gradientFillRect', 'drawCircle', 'drawText', 'blt', 'bltImage', 'rotateHue', 'adjustTone', 'blur', 'canvasChanged']);

  function entry(bitmap) {
    const value = instances.get(bitmap);
    if (!value) throw new TypeError('Bitmap is not initialized');
    return value;
  }
  function invoke(bitmap, method, ...args) {
    const value = entry(bitmap);
    if (fonts && (method === 'drawText' || method === 'measureTextWidth')) {
      const faces = fonts.getRegisteredFaces();
      const families = String(bitmap.fontFace).split(',').map(family => family.trim().replace(/^['"]|['"]$/g, '').toLowerCase());
      families.push('gamefont');
      for (const family of new Set(families)) {
        const face = faces[family];
        if (face && loadedFonts.get(face.family) !== face.path) Bitmap.loadFont(face.family, face.path);
      }
    }
    const result = api.invoke(value.handle, method, ...args);
    if (drawingMethods.has(method)) {
      value.revision++;
      synchronizeTexture(bitmap, value);
    }
    return result;
  }
  function synchronizeTexture(bitmap, value) {
    const texture = value.texture;
    if (!texture) return;
    texture.scaleMode = bitmap.smooth ? PIXI.SCALE_MODES.LINEAR : PIXI.SCALE_MODES.NEAREST;
    if (value.textureRevision === value.revision) return;
    const wasLoaded = texture.hasLoaded;
    texture.hasLoaded = bitmap.isReady();
    value.textureRevision = value.revision;
    texture.update();
    if (!wasLoaded && texture.hasLoaded) texture.emit('loaded', texture);
  }
  function bitmapSource(bitmap) {
    const value = entry(bitmap);
    if (!value.source) {
      const source = {
        get width() { return api.property(value.handle, 'width'); },
        get height() { return api.property(value.handle, 'height'); },
        _pmjsNativeTextureSource() { return api.invoke(value.handle, 'surface'); },
        _ensureNativeCanvas() { return api.invoke(value.handle, 'canvasSurface'); },
        _pmjsContentChanged() { invoke(bitmap, 'canvasChanged'); }
      };
      Object.defineProperty(source, '__pmjsContentRevision', { get() { return value.revision; } });
      value.source = source;
    }
    return value.source;
  }
  function baseTexture(bitmap) {
    const value = entry(bitmap);
    if (!value.texture) {
      if (!PIXI) throw new Error('Bitmap Pixi bindings are unavailable');
      value.texture = new PIXI.BaseTexture();
      value.texture.source = bitmapSource(bitmap);
      value.texture.mipmap = false;
    }
    synchronizeTexture(bitmap, value);
    return value.texture;
  }
  function Bitmap() { this.initialize.apply(this, arguments); }
  Object.defineProperty(Bitmap, 'nativeBacking', { value: true });
  Bitmap.prototype.initialize = function(width = 0, height = 0) {
    const old = instances.get(this);
    width = Math.max(0, Math.trunc(Number(width) || 0)); height = Math.max(0, Math.trunc(Number(height) || 0));
    const handle = old?.managed ? old.handle : api.create(runtime, width, height);
    if (old?.managed) api.invoke(handle, 'reset', width, height);
    if (old?.pending) pending.delete(old.pending);
    instances.set(this, { handle, managed: Boolean(old?.managed), listeners: [], pending: null, revision: 0, textureRevision: -1, texture: null });
  };
  function loadBitmap(Type, url, requestOnly) {
    const bitmap = Object.create(Type.prototype);
    bitmap.initialize();
    const value = entry(bitmap);
    value.handle = requestOnly ? api.create(runtime, String(url), true) : api.create(runtime, String(url));
    value.revision++;
    synchronizeTexture(bitmap, value);
    value.pending = new WeakRef(bitmap);
    pending.add(value.pending);
    return bitmap;
  }
  Bitmap.load = function(url) { return loadBitmap(this, url, false); };
  Bitmap.request = function(url) { return loadBitmap(this, url, true); };
  Bitmap.updateLoads = function(servicesUpdated = false) {
    if (!servicesUpdated) api.updateLoads(runtime);
    for (const reference of [...pending]) {
      const bitmap = reference.deref();
      if (!bitmap) { pending.delete(reference); continue; }
      const value = entry(bitmap);
      if (value.pending !== reference) { pending.delete(reference); continue; }
      if (bitmap.isError()) { pending.delete(reference); value.pending = null; value.listeners.length = 0; continue; }
      if (!bitmap.isReady()) continue;
      value.revision++;
      synchronizeTexture(bitmap, value);
      while (value.listeners.length) value.listeners.shift()(bitmap);
      pending.delete(reference);
      value.pending = null;
    }
  };
  Bitmap.prototype.addLoadListener = function(listener) {
    if (typeof listener !== 'function') throw new TypeError('Bitmap listener must be a function');
    if (this.isReady()) listener(this);
    else entry(this).listeners.push(listener);
  };
  for (const name of ['baseTexture', '_baseTexture']) {
    Object.defineProperty(Bitmap.prototype, name, {
      configurable: true,
      get() { return baseTexture(this); }
    });
  }
  for (const name of ['canvas', '_canvas']) {
    Object.defineProperty(Bitmap.prototype, name, {
      configurable: true,
      get() { return bitmapSource(this); }
    });
  }
  Bitmap.prototype._setDirty = function() { entry(this).revision++; };
  Bitmap.prototype.checkDirty = function() { synchronizeTexture(this, entry(this)); };
  for (const name of ['width', 'height', 'url', '_url', '_loadingState']) {
    Object.defineProperty(Bitmap.prototype, name, {
      configurable: true,
      get() { return api.property(entry(this).handle, name); }
    });
  }
  for (const name of ['paintOpacity', 'fontSize', 'fontFace', 'fontItalic', 'textColor', 'outlineColor', 'outlineWidth', 'smooth']) {
    Object.defineProperty(Bitmap.prototype, name, {
      configurable: true,
      get() { return api.property(entry(this).handle, name); },
      set(value) {
        if (['fontFace', 'textColor', 'outlineColor'].includes(name)) value = String(value);
        else if (name === 'fontItalic' || name === 'smooth') value = Boolean(value);
        else value = Number(value);
        api.property(entry(this).handle, name, value);
      }
    });
  }
  for (const name of ['isReady', 'isError', 'isRequestOnly', 'isRequestReady', 'decode', 'startRequest', 'touch', 'rotateHue', 'adjustTone', 'blur', 'clear', 'clearRect', 'fillRect', 'fillAll', 'drawCircle', 'measureTextWidth', 'getPixel', 'getAlphaPixel', 'resize']) {
    Bitmap.prototype[name] = function(...args) { return invoke(this, name, ...args); };
  }
  Bitmap.prototype.gradientFillRect = function(x, y, width, height, first, second, vertical = false) {
    return invoke(this, 'gradientFillRect', x, y, width, height, first, second, Boolean(vertical));
  };
  Bitmap.prototype.drawText = function(text, x, y, maxWidth = 0x7fffffff, lineHeight, align = 'left') {
    if (text === undefined) return;
    return invoke(this, 'drawText', String(text), x, y, maxWidth, lineHeight, align);
  };
  for (const name of ['blt', 'bltImage']) {
    Bitmap.prototype[name] = function(source, sx, sy, sw, sh, dx, dy, dw = sw, dh = sh) {
      return invoke(this, name, entry(source).handle, sx, sy, sw, sh, dx, dy, dw, dh);
    };
  }
  Bitmap.loadFont = function(family, source) {
    family = String(family); source = String(source);
    api.loadFont(runtime, family, source);
    loadedFonts.set(family, source);
  };
  Bitmap.surface = function(bitmap) {
    const surface = invoke(bitmap, 'surface');
    Object.defineProperty(surface, 'bitmap', { value: bitmap });
    return surface;
  };
  bitmapFactories.set(Bitmap, { runtime, handle(bitmap) { return entry(bitmap).handle; }, manage(bitmap) { entry(bitmap).managed = true; }, adopt(result) {
    const bitmap = Object.create(Bitmap.prototype);
    bitmap.initialize();
    const value = entry(bitmap); value.handle = result.handle; value.managed = true; value.revision++;
    value.pending = new WeakRef(bitmap); pending.add(value.pending);
    return bitmap;
  } });
  return Bitmap;
}

function createImageManager(native, Bitmap) {
  const factory = findBitmapFactory(Bitmap);
  if (!factory) throw new TypeError('ImageManager requires the native Bitmap constructor');
  if (factory.manager) return factory.manager;
  const api = native.mvBitmap, states = new WeakMap(), known = new Map();
  const reservations = new Map([[1, 1n]]), reservationNames = new Map([[1n, 1]]);
  let defaultReservation = null;
  function reservation(id) {
    if (!id) return 0n;
    if (!reservations.has(id)) { reservations.set(id, nextReservation++); reservationNames.set(reservations.get(id), id); }
    return reservations.get(id);
  }
  function adopt(state, result) {
    if (!result) return null;
    let bitmap = known.get(result.identity)?.deref();
    if (!bitmap) { bitmap = factory.adopt(result); known.set(result.identity, new WeakRef(bitmap)); }
    state.roots.set(result.identity, bitmap); return bitmap;
  }
  function synchronize(state, current = api.imageManager(state.runtime, 'state')) {
    const live = new Set(current.identities);
    for (const id of state.roots.keys()) if (!live.has(id)) state.roots.delete(id);
    for (const [key, entry] of state.records) if (!live.has(entry.identity)) state.records.delete(key);
    for (const [id, weak] of known) if (!weak.deref()) known.delete(id);
    return current;
  }
  function record(cache, key) {
    const state = states.get(cache), result = api.cacheImage(state.runtime, 'entry', String(key));
    if (!result) return undefined;
    if (state.records.get(key)?.identity === result.identity) return state.records.get(key).value;
    const bitmap = adopt(state, result), value = { bitmap, key: result.key };
    for (const field of ['touch', 'reservationId']) Object.defineProperty(value, field, {
      enumerable: true,
      get() {
        const entry = api.cacheImage(state.runtime, 'entry', String(key));
        if (entry?.identity === result.identity) result[field] = entry[field];
        return field === 'reservationId' ? reservationNames.get(result[field]) : result[field];
      },
      set(next) {
        const entry = api.cacheImage(state.runtime, 'entry', String(key));
        result[field] = field === 'reservationId' ? next == null ? null : reservation(next) : Number(next);
        if (entry?.identity === result.identity) api.cacheImage(state.runtime, 'setEntry', String(key), { [field]: result[field] });
      }
    });
    state.records.set(key, { identity: result.identity, value }); return value;
  }
  function ImageCache() { this.initialize.apply(this, arguments); }
  ImageCache.limit = 10 * 1000 * 1000;
  ImageCache.prototype.initialize = function() {
    const state = states.get(this) || { runtime: api.open() };
    api.imageManager(state.runtime, 'clear'); state.roots = new Map(); state.records = new Map(); states.set(this, state);
    this._items = new Proxy({}, {
      get: (target, key) => typeof key === 'string' ? record(this, key) : undefined,
      ownKeys: () => api.cacheImage(state.runtime, 'keys', ''),
      has: (target, key) => typeof key === 'string' && Boolean(record(this, key)),
      getOwnPropertyDescriptor: (target, key) => record(this, key) ? { enumerable: true, configurable: true } : undefined,
      deleteProperty: (target, key) => { api.cacheImage(state.runtime, 'remove', String(key)); state.records.delete(key); synchronize(state); return true; },
      set: (target, key, value) => { this.add(key, value.bitmap); const entry = record(this, key); if (value.touch !== undefined) entry.touch = value.touch; if (value.reservationId !== undefined) entry.reservationId = value.reservationId; return true; }
    });
  };
  ImageCache.prototype.add = function(key, bitmap) {
    const state = states.get(this), result = api.cacheImage(state.runtime, 'add', String(key), factory.handle(bitmap));
    factory.manage(bitmap); known.set(result.identity, new WeakRef(bitmap)); state.roots.set(result.identity, bitmap);
    this._truncateCache();
  };
  ImageCache.prototype.get = function(key) { const state = states.get(this); return adopt(state, api.cacheImage(state.runtime, 'get', String(key))); };
  ImageCache.prototype.reserve = function(key, bitmap, id) {
    const state = states.get(this);
    if (!record(this, key)) {
      const result = api.cacheImage(state.runtime, 'add', String(key), factory.handle(bitmap));
      factory.manage(bitmap); known.set(result.identity, new WeakRef(bitmap)); state.roots.set(result.identity, bitmap);
    }
    record(this, key).reservationId = id;
  };
  ImageCache.prototype.releaseReservation = function(id) { if (reservations.has(id)) api.imageManager(states.get(this).runtime, 'release', reservation(id)); };
  ImageCache.prototype._truncateCache = function() { const state = states.get(this); api.imageManager(state.runtime, 'limit', ImageCache.limit); api.cacheImage(state.runtime, 'truncate', ''); synchronize(state); };
  ImageCache.prototype._mustBeHeld = function(item) { return api.cacheImage(states.get(this).runtime, 'held', String(item.key)); };
  ImageCache.prototype.isReady = function() { return api.imageManager(states.get(this).runtime, 'state').ready; };
  ImageCache.prototype.getErrorBitmap = function() { const state = states.get(this); api.imageManager(state.runtime, 'state'); return adopt(state, api.cacheImage(state.runtime, 'error', '')); };
  function load(path, hue, smooth, mode, id) {
    if (!path) { hue = 0; smooth = false; mode = 'reserve'; id = 1; }
    const cache = manager._imageCache, state = states.get(cache);
    api.imageManager(state.runtime, 'limit', ImageCache.limit);
    const result = api.managedImage(state.runtime, path, Number(hue) || 0, Boolean(smooth), mode, reservation(id));
    const bitmap = adopt(state, result); cache._truncateCache(); return bitmap;
  }
  const manager = {
    faceWidth: 144, faceHeight: 144,
    _generateCacheKey(path, hue = 0) { return String(path) + ':' + Number(hue || 0); },
    loadBitmap(folder, filename, hue = 0, smooth = true) { return load(api.imagePath(folder, String(filename || '')), hue, smooth, 'load', 0); },
    reserveBitmap(folder, filename, hue = 0, smooth = true, id = defaultReservation) { return load(api.imagePath(folder, String(filename || '')), hue, smooth, 'reserve', id); },
    requestBitmap(folder, filename, hue = 0, smooth = true) { return load(api.imagePath(folder, String(filename || '')), hue, smooth, 'request', 0); },
    loadNormalBitmap(path, hue = 0) { return load(String(path), hue, true, 'load', 0); },
    reserveNormalBitmap(path, hue = 0, id = defaultReservation) { return load(String(path), hue, true, 'reserve', id); },
    requestNormalBitmap(path, hue = 0) { return load(String(path), hue, true, 'request', 0); },
    loadEmptyBitmap() { return load('', 0, false, 'reserve', 1); },
    isReady() { const error = this._imageCache.getErrorBitmap(); if (error) throw new Error('Failed to load: ' + error.url); return this._imageCache.isReady(); },
    update() { const state = states.get(this._imageCache); synchronize(state, api.imageManager(state.runtime, 'update')); Bitmap.updateLoads(true); },
    clear() { this._imageCache = new ImageCache(); },
    clearRequest() { api.imageManager(states.get(this._imageCache).runtime, 'clearRequests'); },
    setDefaultReservationId(id) { defaultReservation = id; },
    releaseReservation(id) { this._imageCache.releaseReservation(id); },
    setCacheLimit(pixels) { ImageCache.limit = pixels; api.imageManager(states.get(this._imageCache).runtime, 'limit', pixels); },
    isObjectCharacter(name) { return api.imageNameFlag('object', String(name)); },
    isBigCharacter(name) { return api.imageNameFlag('big', String(name)); },
    isZeroParallax(name) { return api.imageNameFlag('zero', String(name)); }
  };
  const folders = { Animation: ['animations', true], Battleback1: ['battlebacks1', true], Battleback2: ['battlebacks2', true],
    Enemy: ['enemies', true], Character: ['characters', false], Face: ['faces', true], Parallax: ['parallaxes', true],
    Picture: ['pictures', true], SvActor: ['sv_actors', false], SvEnemy: ['sv_enemies', true], System: ['system', false],
    Tileset: ['tilesets', false], Title1: ['titles1', true], Title2: ['titles2', true] };
  for (const [name, [folder, smooth]] of Object.entries(folders)) {
    manager['load' + name] = function(filename, hue = 0) { return this.loadBitmap('img/' + folder + '/', filename, hue, smooth); };
    manager['reserve' + name] = function(filename, hue = 0, id = defaultReservation) { return this.reserveBitmap('img/' + folder + '/', filename, hue, smooth, id); };
    manager['request' + name] = function(filename, hue = 0) { return this.requestBitmap('img/' + folder + '/', filename, hue, smooth); };
  }
  manager._systemReservationId = 1;
  manager._imageCache = Object.create(ImageCache.prototype);
  states.set(manager._imageCache, { runtime: factory.runtime }); manager._imageCache.initialize();
  manager._requestQueue = { _queue: { get length() { return api.imageManager(states.get(manager._imageCache).runtime, 'state').requestCount; } } };
  manager.reserveSystem = function(filename, hue = 0, id) { return this.reserveBitmap('img/system/', filename, hue, false, id || this._systemReservationId); };
  factory.manager = manager;
  return manager;
}

function bitmapHandle(Bitmap, bitmap) {
  const factory = findBitmapFactory(Bitmap);
  if (!factory) throw new TypeError('Native Bitmap constructor is unavailable');
  return factory.handle(bitmap);
}
module.exports = { createBitmapClass, createImageManager, bitmapHandle };
