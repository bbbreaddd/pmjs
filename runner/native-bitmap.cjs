'use strict';

function createBitmapClass(native, PIXI = null, fonts = null) {
  const api = native.mvBitmap;
  if (!api) throw new Error('Native Bitmap bindings are unavailable');
  const runtime = api.open();
  const instances = new WeakMap();
  const pending = new Set();
  const loadedFonts = new Map();
  const drawingMethods = new Set(['resize', 'clear', 'clearRect', 'fillRect', 'fillAll', 'gradientFillRect', 'drawCircle', 'drawText', 'blt', 'bltImage', 'rotateHue', 'adjustTone', 'blur']);

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
        _pmjsNativeTextureSource() { return api.invoke(value.handle, 'surface'); }
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
    const handle = api.create(runtime, Math.max(0, Math.trunc(Number(width) || 0)), Math.max(0, Math.trunc(Number(height) || 0)));
    const old = instances.get(this);
    if (old?.pending) pending.delete(old.pending);
    instances.set(this, { handle, listeners: [], pending: null, revision: 0, textureRevision: -1, texture: null });
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
  Bitmap.updateLoads = function() {
    api.updateLoads(runtime);
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
  return Bitmap;
}

module.exports = { createBitmapClass };
