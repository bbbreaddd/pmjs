'use strict';
const { createRequestQueueClass } = require('./native-request-queue.cjs');
const bitmapFactories = new WeakMap();
const sourceBitmaps = new WeakMap();
function findBitmapFactory(Type) {
  for (let current=Type;current;current=Object.getPrototypeOf(current)) {
    const factory=bitmapFactories.get(current);
    if (factory) return factory;
  }
  return null;
}
let nextReservation = 2n;

function createBitmapClass(native, PIXI = null, fonts = null, contextClass = () => globalThis.CanvasRenderingContext2D, canvasFactory = () => null, createArray = () => [], createRectangle = null) {
  let webImages = null;
  let clock=()=>Date.now();
  const api = native.mvBitmap;
  if (!api) throw new Error('Native Bitmap bindings are unavailable');
  const runtime = api.open();
  const instances = new WeakMap(), nativeInstances = new Map();
  const nativeFinalizer = new FinalizationRegistry(identity => { if (!nativeInstances.get(identity)?.deref()) nativeInstances.delete(identity); });
  const pending = new Set();
  const loadedFonts = new Map();
  const drawingMethods = new Set(['resize', 'clear', 'clearRect', 'fillRect', 'fillAll', 'gradientFillRect', 'drawCircle', 'drawText', 'blt', 'bltImage', 'rotateHue', 'adjustTone', 'blur', 'canvasChanged', 'snap']);

  function entry(bitmap) {
    const value = instances.get(bitmap);
    if (!value) throw new TypeError('Bitmap is not initialized');
    return value;
  }
  function remember(bitmap) {
    const value=entry(bitmap);
    if(value.identity && nativeInstances.get(value.identity)?.deref()===bitmap)nativeInstances.delete(value.identity);
    value.identity=value.handle.identity;nativeInstances.set(value.identity,new WeakRef(bitmap));
    nativeFinalizer.unregister(bitmap);nativeFinalizer.register(bitmap,value.identity,bitmap);
    if(!value.loadObserver) {
      const notify=method=>{
        if(value.pending)pending.delete(value.pending);value.pending=null;value.revision++;
        bitmap[method]();synchronizeTexture(bitmap,value);
      };
      value.loadObserver=()=>notify('_onLoad');value.errorObserver=()=>notify('_onError');
    }
    api.invoke(value.handle,'observeLoads',value.loadObserver,value.errorObserver);
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
    if (drawingMethods.has(method) && value.source?._context2d)
      api.property(value.handle, 'paintOpacity', value.source._context2d.globalAlpha * 255);
    const result = api.invoke(value.handle, method, ...args);
    if(method === "snap")remember(bitmap);
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
      const source = Object.defineProperties(canvasFactory() || {}, Object.getOwnPropertyDescriptors({
        get width() { return api.property(value.handle, 'width'); },
        set width(width) { bitmap.resize(width, this.height); if (this._context2d) contextClass().call(this._context2d, this); },
        get height() { return api.property(value.handle, 'height'); },
        set height(height) { bitmap.resize(this.width, height); if (this._context2d) contextClass().call(this._context2d, this); },
        getContext(type) {
          if (type !== '2d') return null;
          if (!this._context2d) {
            const Type = contextClass();
            if (!Type) throw new Error('Canvas 2D bindings are unavailable');
            this._context2d = new Type(this);
            this._context2d.globalAlpha = bitmap.paintOpacity / 255;
          }
          return this._context2d;
        },
        _pmjsNativeTextureSource() { return api.invoke(value.handle, 'surface'); },
        _ensureNativeCanvas() { return api.invoke(value.handle, 'canvasSurface'); },
        _pmjsContentChanged() { invoke(bitmap, 'canvasChanged'); }
      }));
      Object.defineProperty(source, '__pmjsContentRevision', { get() { return value.revision; } });
      value.source = source;sourceBitmaps.set(source,bitmap);
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
    if(old?.identity && nativeInstances.get(old.identity)?.deref()===this)nativeInstances.delete(old.identity);
    instances.set(this, { handle, managed: Boolean(old?.managed), listeners: createArray(), pending: null, revision: 0, textureRevision: -1, texture: null });
    remember(this);
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
    remember(bitmap); return bitmap;
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
      if (bitmap.isError()) { pending.delete(reference); value.pending = null; bitmap._onError(); continue; }
      if (!bitmap.isReady()) continue;
      value.revision++;
      synchronizeTexture(bitmap, value);
      pending.delete(reference);
      value.pending = null;
      bitmap._onLoad();
    }
  };
  Object.defineProperty(Bitmap.prototype, '_image', { configurable: true,
    get() {
      const value=entry(this);
      if(!value.image && this.url && webImages) {
        const source=invoke(this,'imageSource');
        value.image=source ? webImages.fromResource(source) : webImages.create();
        value.image._src=this.url;
      }
      return value.image || null;
    },set(image) {entry(this).image=image;}
  });
  Bitmap.prototype._callLoadListeners = function() {
    invoke(this,'callLoadListeners');
    while (entry(this).listeners.length) entry(this).listeners.shift()(this);
  };
  Bitmap.prototype._onLoad = function() {
    const value=entry(this), image=value.image;
    if(image && image.complete && image.naturalWidth && image.src !== this.url) {
      this.resize(image.naturalWidth,image.naturalHeight);this._context.drawImage(image,0,0);this._loadingState='loaded';
    } else if(image && !image.naturalWidth) {
      const source=invoke(this,'imageSource');if(source)image._adoptNativeResource(source);
    }
    invoke(this,'completeLoad');value.revision++;synchronizeTexture(this,value);
    if(this.isReady())this._callLoadListeners();
  };
  Object.defineProperty(Bitmap.prototype,'_loadListeners',{configurable:true,get() {return entry(this).listeners;},set(value) {entry(this).listeners=value;}});
  Bitmap.prototype._onError = function() { this._loadingState = 'error'; };
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
  Object.defineProperty(Bitmap.prototype, '_context', { configurable: true, get() { return this._canvas.getContext('2d'); } });
  Object.defineProperty(Bitmap.prototype, 'context', { configurable: true, get() { return this._context; } });
  Object.defineProperty(Bitmap.prototype, 'rect', { configurable: true, get() {
    if (createRectangle) return createRectangle(0,0,this.width,this.height);
    if (PIXI) return new PIXI.Rectangle(0,0,this.width,this.height);
    return { x:0,y:0,width:this.width,height:this.height };
  } });
  Bitmap.prototype._setDirty = function() { entry(this).revision++; };
  Bitmap.prototype.checkDirty = function() { synchronizeTexture(this, entry(this)); };
  Object.defineProperty(Bitmap.prototype, '_loadingState', { configurable: true,
    get() { return api.property(entry(this).handle, '_loadingState'); },
    set(value) { api.property(entry(this).handle, '_loadingState', String(value)); }
  });
  for (const name of ['width', 'height', 'url', '_url']) {
    Object.defineProperty(Bitmap.prototype, name, {
      configurable: true,
      get() { return api.property(entry(this).handle, name); }
    });
  }
  for (const name of ['paintOpacity', 'fontSize', 'fontFace', 'fontItalic', 'textColor', 'outlineColor', 'outlineWidth', 'smooth']) {
    Object.defineProperty(Bitmap.prototype, name, {
      configurable: true,
      get() {
        const context = entry(this).source?._context2d;
        return name === 'paintOpacity' && context ? context.globalAlpha * 255 : api.property(entry(this).handle, name);
      },
      set(value) {
        if (['fontFace', 'textColor', 'outlineColor'].includes(name)) value = String(value);
        else if (name === 'fontItalic' || name === 'smooth') value = Boolean(value);
        else value = Number(value);
        api.property(entry(this).handle, name, value);
        const context = entry(this).source?._context2d;
        if (name === "paintOpacity" && context) context.globalAlpha = value / 255;
      }
    });
  }
  for (const name of ['isReady', 'isError', 'isRequestOnly', 'isRequestReady', 'decode', 'startRequest', 'touch', 'rotateHue', 'adjustTone', 'blur', 'clear', 'clearRect', 'fillRect', 'fillAll', 'drawCircle', 'measureTextWidth', 'getPixel', 'getAlphaPixel', 'resize']) {
    Bitmap.prototype[name] = function(...args) { return invoke(this, name, ...args); };
  }
  const decode = Bitmap.prototype.decode;
  Bitmap.prototype.decode = function() {
    const result = decode.call(this), value = entry(this);
    if (!this.isReady() && !value.pending) { value.pending = new WeakRef(this); pending.add(value.pending); }
    return result;
  };
  Bitmap.prototype.gradientFillRect = function(x, y, width, height, first, second, vertical = false) {
    return invoke(this, 'gradientFillRect', x, y, width, height, first, second, Boolean(vertical));
  };
  const drawTextOutline = Bitmap.prototype._drawTextOutline = function(text, x, y, maxWidth) {
    const context = this._context;
    context.strokeStyle = this.outlineColor; context.lineWidth = this.outlineWidth; context.lineJoin = 'round';
    context.strokeText(text, x, y, maxWidth);
  };
  const drawTextBody = Bitmap.prototype._drawTextBody = function(text, x, y, maxWidth) {
    this._context.fillStyle = this.textColor; this._context.fillText(text, x, y, maxWidth);
  };
  const makeFontNameText=Bitmap.prototype._makeFontNameText = function() { return (this.fontItalic ? 'Italic ' : '') + this.fontSize + 'px ' + this.fontFace; };
  const measureTextWidth=Bitmap.prototype.measureTextWidth;
  Bitmap.prototype.measureTextWidth=function(text) {
    if(this._makeFontNameText===makeFontNameText)return measureTextWidth.call(this,text);
    const context=this._context;context.save();
    try {context.font=this._makeFontNameText();return context.measureText(text).width;} finally {context.restore();}
  };
  Bitmap.prototype.fillAll=function(color) {this.fillRect(0,0,this.width,this.height,color);};
  Bitmap.prototype.drawText = function(text, x, y, maxWidth = 0x7fffffff, lineHeight, align = 'left') {
    if (text === undefined) return;
    if (this._drawTextOutline === drawTextOutline && this._drawTextBody === drawTextBody && this._makeFontNameText===makeFontNameText)
      return invoke(this, 'drawText', String(text), x, y, maxWidth, lineHeight, align);
    const context = this._context, alpha = context.globalAlpha;
    const tx = x + (align === 'center' ? maxWidth / 2 : align === 'right' ? maxWidth : 0);
    const ty = y + lineHeight - (lineHeight - this.fontSize * 0.7) / 2;
    context.save();
    try {
      context.font = this._makeFontNameText(); context.textAlign = align; context.textBaseline = 'alphabetic';
      context.globalAlpha = 1; this._drawTextOutline(text, tx, ty, maxWidth);
      context.globalAlpha = alpha; this._drawTextBody(text, tx, ty, maxWidth);
    } finally { context.restore(); this._setDirty(); }
  };
  for (const name of ['blt', 'bltImage']) {
    Bitmap.prototype[name] = function(source, sx, sy, sw, sh, dx, dy, dw = sw, dh = sh) {
      return invoke(this, name, entry(source).handle, sx, sy, sw, sh, dx, dy, dw, dh);
    };
  }
  Bitmap.bindImages = function(images) { webImages=images; };
  Bitmap.bindClock = function(now) {clock=now;};
  Bitmap.bindPixi = function(pixi, fontRegistry = fonts) { PIXI = pixi; fonts = fontRegistry; };
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
  const drawingDefaults=new Map(['blt','bltImage','fillRect','fillAll','clear','clearRect','resize','adjustTone','gradientFillRect','drawCircle','drawText','measureTextWidth','_makeFontNameText','_drawTextOutline','_drawTextBody'].map(name=>[name,Bitmap.prototype[name]]));
  bitmapFactories.set(Bitmap, { drawingOverrides:()=>[...drawingDefaults].some(([name,method])=>Bitmap.prototype[name]!==method), now:()=>clock(), object:()=>Object.create(Object.getPrototypeOf(Object.getPrototypeOf(createArray()))), snap(stage) { const bitmap = new Bitmap(); invoke(bitmap, 'snap', stage); return bitmap; }, handle(bitmap) { return entry(bitmap).handle; }, manage(bitmap) { entry(bitmap).managed = true; }, adopt(result) {
    const existing=nativeInstances.get(result.handle.identity)?.deref();
    if(existing) {entry(existing).managed=true;return existing;}
    const bitmap = Object.create(Bitmap.prototype);
    bitmap.initialize();
    const value = entry(bitmap); value.handle = result.handle; value.managed = true; value.revision++;
    if(!api.invoke(value.handle,'isReady')) {value.pending = new WeakRef(bitmap); pending.add(value.pending);}
    remember(bitmap); return bitmap;
  }, wrap(handle) {
    const existing=nativeInstances.get(handle.identity)?.deref();
    if(existing)return existing;
    const bitmap=new Bitmap(), value=entry(bitmap);value.handle=handle;value.managed=true;value.revision++;remember(bitmap);return bitmap;
  } });
  return Bitmap;
}

function createImageManager(native, Bitmap, RequestQueue = createRequestQueueClass()) {
  const factory = findBitmapFactory(Bitmap);
  if (!factory) throw new TypeError('ImageManager requires the native Bitmap constructor');
  if (factory.manager) return factory.manager;
  const api = native.mvBitmap, states = new WeakMap(), known = new Map();
  const cacheFinalizer=new FinalizationRegistry(runtime=>{try {api.imageManager(runtime,'clear');} catch { /* The graphics runtime may already have closed. */ }});
  const reservations = new Map([[1, 1n]]);
  let defaultReservation = null;
  function reservation(id) {
    if (!id) return 0n;
    if (!reservations.has(id)) reservations.set(id, nextReservation++);
    return reservations.get(id);
  }
  function adopt(state, result) {
    if (!result) return null;
    let bitmap = known.get(result.identity)?.deref();
    if(bitmap&&factory.handle(bitmap).identity!==result.handle.identity)bitmap=null;
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
  function synchronizeEntry(cache,key,item) {
    const state=states.get(cache);key=String(key);
    if(!item) {
      api.cacheImage(state.runtime,'remove',key);state.records.delete(key);return;
    }
    let result=state.records.get(key);
    if(!result)result=api.cacheImage(state.runtime,'entry',key);
    if(!result)result=api.cacheImage(state.runtime,'add',key,factory.handle(item.bitmap));
    api.cacheImage(state.runtime,'setEntry',key,{bitmap:factory.handle(item.bitmap),touch:Number(item.touch),
      reservationId:item.reservationId==null?null:reservation(item.reservationId)});
    factory.manage(item.bitmap);known.set(result.identity,new WeakRef(item.bitmap));state.roots.set(result.identity,item.bitmap);
    state.records.set(key,{identity:result.identity});
  }
  function synchronizeItems(cache) {
    const state=states.get(cache),items=cache._items,keys=Object.keys(items),live=new Set(keys);
    for(const key of state.records.keys())if(!live.has(key))synchronizeEntry(cache,key,null);
    for(const key of keys)synchronizeEntry(cache,key,items[key]);
    synchronize(state);
  }
  function ImageCache() { this.initialize.apply(this, arguments); }
  ImageCache.limit = 10 * 1000 * 1000;
  ImageCache.prototype.initialize = function() {
    const state = states.get(this) || { runtime: api.open(true) };
    if(!states.has(this))cacheFinalizer.register(this,state.runtime);
    api.imageManager(state.runtime,'externalCachePolicy',true);
    api.imageManager(state.runtime,'clear');state.roots=new Map();state.records=new Map();states.set(this,state);
    this._items=factory.object();
  };
  ImageCache.prototype.add = function(key, bitmap) {
    this._items[key]=Object.assign(factory.object(),{bitmap,touch:factory.now(),key});
    synchronizeEntry(this,key,this._items[key]);this._truncateCache();
  };
  ImageCache.prototype.get = function(key) {
    const item=this._items[key];
    if(!item) {synchronizeEntry(this,key,null);return null;}
    item.touch=factory.now();synchronizeEntry(this,key,item);return item.bitmap;
  };
  ImageCache.prototype.reserve = function(key, bitmap, id) {
    if(!this._items[key])this._items[key]=Object.assign(factory.object(),{bitmap,touch:factory.now(),key});
    this._items[key].reservationId=id;synchronizeEntry(this,key,this._items[key]);
  };
  ImageCache.prototype.releaseReservation = function(id) {
    for(const key of Object.keys(this._items))if(this._items[key].reservationId===id) {
      delete this._items[key].reservationId;synchronizeEntry(this,key,this._items[key]);
    }
  };
  ImageCache.prototype._truncateCache = function() {
    const items=this._items;let sizeLeft=ImageCache.limit;
    Object.keys(items).map(key=>items[key]).sort((a,b)=>b.touch-a.touch).forEach(item=>{
      if(sizeLeft>0||this._mustBeHeld(item))sizeLeft-=item.bitmap.width*item.bitmap.height;
      else delete items[item.key];
    });
    synchronizeItems(this);
  };
  ImageCache.prototype._mustBeHeld = function(item) { return !item.bitmap.isRequestOnly() && (Boolean(item.reservationId) || !item.bitmap.isReady()); };
  ImageCache.prototype.isReady = function() { return !Object.keys(this._items).some(key=>{const bitmap=this._items[key].bitmap;return !bitmap.isRequestOnly()&&!bitmap.isReady();}); };
  ImageCache.prototype.getErrorBitmap = function() { for(const key of Object.keys(this._items))if(this._items[key].bitmap.isError())return this._items[key].bitmap;return null; };
  function load(path, hue, smooth, mode, id) {
    if (!path) { hue = 0; smooth = false; mode = 'reserve'; id = 1; }
    const cache = manager._imageCache, state = states.get(cache);
    api.imageManager(state.runtime, 'limit', ImageCache.limit);
    const key = path ? manager._generateCacheKey(path, hue) : 'empty';
    const existing = cache.get(key);
    const result = api.managedImage(state.runtime, path, Number(hue) || 0, Boolean(smooth), mode === 'request' ? 'requestExternal' : mode, reservation(id));
    const bitmap = adopt(state, result);
    if(!existing) {
      cache._items[key]=Object.assign(factory.object(),{bitmap,touch:factory.now(),key});
      if(mode==='reserve')cache._items[key].reservationId=id;
      state.records.set(key,{identity:result.identity});
    } else if(mode==='reserve')cache._items[key].reservationId=id;
    if (mode === 'request') {
      if (!existing) manager._requestQueue.enqueue(key, bitmap);
      manager._requestQueue.raisePriority(key);
    }
    if(!existing)cache._truncateCache(); return bitmap;
  }
  const manager = {
    faceWidth: 144, faceHeight: 144,
    _generateCacheKey(path, hue = 0) { return String(path) + ':' + Number(hue || 0); },
    loadBitmap(folder, filename, hue = 0, smooth = true) { return load(api.imagePath(folder, encodeURIComponent(String(filename || ''))), hue, smooth, 'load', 0); },
    reserveBitmap(folder, filename, hue = 0, smooth = true, id = defaultReservation) { return load(api.imagePath(folder, encodeURIComponent(String(filename || ''))), hue, smooth, 'reserve', id); },
    requestBitmap(folder, filename, hue = 0, smooth = true) { return load(api.imagePath(folder, encodeURIComponent(String(filename || ''))), hue, smooth, 'request', 0); },
    loadNormalBitmap(path, hue = 0) { return load(String(path), hue, true, 'load', 0); },
    reserveNormalBitmap(path, hue = 0, id = defaultReservation) { return load(String(path), hue, true, 'reserve', id); },
    requestNormalBitmap(path, hue = 0) { return load(String(path), hue, true, 'request', 0); },
    loadEmptyBitmap() { return load('', 0, false, 'reserve', 1); },
    isReady() { const error = this._imageCache.getErrorBitmap(); if (error) throw new Error('Failed to load: ' + error.url); return this._imageCache.isReady(); },
    update() { this._requestQueue.update();synchronizeItems(this._imageCache); const state = states.get(this._imageCache); synchronize(state, api.imageManager(state.runtime, 'update')); Bitmap.updateLoads(true); },
    clear() { this._imageCache = new ImageCache(); },
    clearRequest() { this._requestQueue.clear(); api.imageManager(states.get(this._imageCache).runtime, 'clearRequests'); },
    setDefaultReservationId(id) { defaultReservation = id; },
    releaseReservation(id) { this._imageCache.releaseReservation(id); },
    setCacheLimit(pixels) { ImageCache.limit = pixels; api.imageManager(states.get(this._imageCache).runtime, 'limit', pixels); },
    isObjectCharacter(name) { const sign = String(name).match(/^[!$]+/); return sign && sign[0].includes('!'); },
    isBigCharacter(name) { const sign = String(name).match(/^[!$]+/); return sign && sign[0].includes('$'); },
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
  manager._imageCache = new ImageCache();
  manager._requestQueue = new RequestQueue();
  manager.reserveSystem = function(filename, hue = 0, id) { return this.reserveBitmap('img/system/', filename, hue, false, id || this._systemReservationId); };
  factory.manager = manager;
  return manager;
}

function bitmapHandle(Bitmap, bitmap) {
  const factory = findBitmapFactory(Bitmap);
  if (!factory) throw new TypeError('Native Bitmap constructor is unavailable');
  return factory.handle(bitmap);
}
function snapBitmap(Bitmap, stage) {
  const factory = findBitmapFactory(Bitmap);
  if (!factory) throw new TypeError('Snapshot requires the native Bitmap constructor');
  return factory.snap(stage);
}
function wrapBitmapHandle(Bitmap, handle) {
  return handle == null ? null : findBitmapFactory(Bitmap).wrap(handle);
}
function bitmapFromSource(source) {return source && sourceBitmaps.get(source) || null;}
function bitmapDrawingOverrides(Type) {return findBitmapFactory(Type)?.drawingOverrides()||false;}
module.exports = { bitmapDrawingOverrides, bitmapFromSource, createBitmapClass, createImageManager, bitmapHandle, snapBitmap, wrapBitmapHandle };
