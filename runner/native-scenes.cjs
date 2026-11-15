'use strict';
// RPG Maker MV behavior: Copyright (c) 2015 KADOKAWA CORPORATION./YOJI OJIMA.
// MIT license: third_party/rpg-maker-mv.LICENSE.
const { installWindowTouch } = require('./native-window-touch.cjs');
const { installMessageWindow } = require('./native-message-window.cjs');
const { installBattleLog } = require('./native-battle-log.cjs');
const { installBattleScene } = require('./native-battle-scene.cjs');
const { installSceneCommands } = require('./native-scene-commands.cjs');
const { installWindowParts } = require('./native-window-parts.cjs');
const { installWindowLayer } = require('./native-window-layer.cjs');
const { bitmapDrawingOverrides, bitmapHandle, snapBitmap, wrapBitmapHandle, bitmapFromSource } = require('./native-bitmap.cjs');
const { installWindowDrawing } = require('./native-window-drawing.cjs');
const { commandList } = require('./native-command-list.cjs');
const { installSpriteRenderHooks } = require('./native-sprite-render-hooks.cjs');
const { createObjectRenderer } = require('./native-object-renderer.cjs');
const { nativeArray, readNativeArray } = require('./native-array.cjs');
const { installInputState } = require('./native-input-state.cjs');
const { installScreenSprite } = require('./native-core-utilities.cjs');

function createSceneBindings(native, Bitmap, ImageManager, options = {}) {
  const api = native.mvDisplay, runtime = api.open();
  const nodes = new WeakMap(), registry = new Map();
  const nativeDisplaySymbol = Symbol('native display handle');
  const displayLists = new WeakMap();
  const nativeFilters = new WeakMap(), filterUpdates = new Set();
  let currentRoot = null, nextRoot = null;
  let spriteRenderHooks;
  let objectRenderer;
  let windowParts;
  let windowLayerParts;
  function prepareWindow(object) {
    const own = entry(object);
    if (own.prepareWindow) return;
    own.prepareWindow = () => windowParts.prepare(object);
    api.invoke(own.handle, "windowPrepare", own.prepareWindow);
  }
  let requestedKind = null, pendingNative = null;
  let acceptingNative = false, hasRun = false;
  const sceneInfo = new WeakMap(), stackStates = [];
  function entry(object) {
    const value = nodes.get(object);
    if (!value) throw new TypeError('Display object is not initialized');
    return value;
  }
  function treeHooks(object, kind) {
    const own = entry(object), removal = kind === 'windowLayer' ? object.onRemoveAsAChild : null;
    if (removal && object.on) object.on('removed',removal);
    own.added = parent => { object.emit?.('added',wrap(parent)); return true; };
    own.removed = parent => {
      if (object.emit) { object.emit('removed',wrap(parent)); return true; }
      if (removal) { removal.call(object,wrap(parent)); return true; }
      return false;
    };
    api.invoke(own.handle,'displayTreeHooks',own.added,own.removed);
  }
  function attach(object, kind, existing = null) {
    if (nodes.has(object)) throw new Error('Display object is already initialized');
    const handle = existing || api.create(runtime, kind);
    Object.defineProperty(object, nativeDisplaySymbol, { value: handle });
    options.initializeEvents?.(object);
    nodes.set(object, { handle, children: new Map(), parent: null, bitmaps: new Map(), points: new Map(), filters:null });
    registry.set(handle.identity, new WeakRef(object));
    treeHooks(object,kind);
    if (kind === "window") prepareWindow(object);
    if(object instanceof Sprite)registerSprite(object);
  }
  function wrap(handle) {
    if (!handle) return null;
    const existing = registry.get(handle.identity)?.deref();
    if (existing) return existing;
    const types = { scene: Scene_Base, window: Window, windowLayer: WindowLayer, sprite: Sprite, tiling: TilingSprite, tilemap: TilemapDisplay, screen: ScreenSprite, tone: ToneSprite, container: Container, glitch: GlitchFilter };
    const object = Object.create(types[handle.kind].prototype);
    Object.defineProperty(object, nativeDisplaySymbol, { value: handle });
    nodes.set(object, { handle, children: new Map(), parent: null, bitmaps: new Map(), points: new Map(), filters:null });
    registry.set(handle.identity, new WeakRef(object));
    options.initializeEvents?.(object); treeHooks(object,handle.kind);
    if(handle.kind==='window') prepareWindow(object);
    if(handle.kind==='windowLayer') initializeWindowLayer(object);
    if(handle.kind==='tilemap')options.attachTilemap?.(object);
    if(object instanceof Sprite)registerSprite(object);
    return object;
  }
  function registerSprite(object) {
    object._canvas=null;object._context=null;object._tintTexture=null;
    spriteRenderHooks?.register(object);
    const own=entry(object);
    own.bitmapAssigned=handle=>{
      const bitmap=wrapBitmapHandle(Bitmap,handle);own.bitmaps.set('bitmap',bitmap);
      if(bitmap)bitmap.addLoadListener(value=>object._onBitmapLoad(value));
      else {object._refreshFrame=false;object._pmjsBitmapCleared?.();}
    };
    api.invoke(own.handle,'spriteBitmapAssignedHook',own.bitmapAssigned);
    const bitmap=api.invoke(own.handle,'bitmap');if(bitmap)own.bitmapAssigned(bitmap);
  }
  function numericState(object) {
    const own = entry(object);
    return own.numericState ||= api.numericState(own.handle);
  }
  function prop(type, name, field = name) {
    Object.defineProperty(type.prototype, name, {
      configurable: true, enumerable: true,
      get() {
        if (field === 'x' || field === 'y') return numericState(this).position[field === 'x' ? 0 : 1];
        if (field === 'rotation' || field === 'alpha') return numericState(this)[field][0];
        if (field === 'visible' || field === 'renderable') return Boolean(numericState(this)[field][0]);
        if (field === 'z') return numericState(this).z[0];
        if (field === 'opacity' && entry(this).handle.kind !== 'window') return numericState(this).alpha[0] * 255;
        return api.field(entry(this).handle, field);
      },
      set(value) {
        const own = entry(this);
        if (own.handle.kind !== 'window' && typeof value === 'number') {
          if (field === 'x' || field === 'y') { numericState(this).position[field === 'x' ? 0 : 1] = value; return; }
          if (field === 'rotation' || field === 'alpha' || field === 'z') { numericState(this)[field][0] = value; return; }
          if (field === 'opacity') { numericState(this).alpha[0] = value < 0 ? 0 : value > 255 ? 1 : value / 255; return; }
        }
        if (own.handle.kind !== 'window' && typeof value === 'boolean' && (field === 'visible' || field === 'renderable')) {
          numericState(this)[field][0] = value ? 1 : 0; return;
        }
        api.field(own.handle, field, value);
      }
    });
  }
  function point(type, name, x, y) {
    const shared = ['position', 'scale', 'pivot', 'skew', 'anchor', 'origin'].includes(name);
    Object.defineProperty(type.prototype, name, { configurable: true, get() {
      const value = entry(this);
      if (!value.points.has(name)) {
        const handle = value.handle, view = shared ? numericState(this)[name] : null, point = Object.create(options.pointPrototype?.() || Object.prototype);
        for (const [key, field] of [['x', x], ['y', y]]) Object.defineProperty(point, key, {
          enumerable: true,
          get() { return shared ? view[key === 'x' ? 0 : 1] : api.field(handle, field); },
          set(value) {
            if (shared && handle.kind !== 'window' && typeof value === 'number') view[key === 'x' ? 0 : 1] = value;
            else api.field(handle, field, value);
          }
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
      get() {
        const own = entry(this);
        if (name === 'bitmap' && own.bitmapAssigned) return own.bitmaps.get(name) || null;
        const bitmap=wrapBitmapHandle(Bitmap,api.invoke(own.handle,name));
        own.bitmaps.set(name,bitmap);return bitmap;
      },
      set(value) {
        if(this[name]===value)return;
        const own = entry(this);
        if (name === 'windowskin') windowParts?.beforeChange(this);
        api.invoke(own.handle, name, value == null ? null : bitmapHandle(Bitmap, value));
        own.bitmaps.set(name, value);
        if (name === "contents") windowParts?.contents(this);
        if (name === "windowskin") windowParts?.remember(this);
        if (name === "windowskin" && value) value.addLoadListener(() => this._onWindowskinLoad());
      }
    });
  }
  function children(object) {
    const own = entry(object), revision = numericState(object).childrenRevision[0];
    if (own.childSnapshot && own.childRevision === revision) return own.childValues;
    const snapshot = api.childSnapshot(own.handle, own.childSnapshot);
    own.childRevision = revision;
    if (snapshot === own.childSnapshot) return own.childValues;
    const handles = snapshot.handles;
    const live = new Set();
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
    own.childSnapshot = snapshot; own.childValues = result;
    return result;
  }
  function Container() { this.initialize.apply(this, arguments); }
  if (options.containerPrototype) Object.setPrototypeOf(Container.prototype, options.containerPrototype);
  Container.prototype.initialize = function() { attach(this, 'container'); };
  function Stage() { this.initialize.apply(this, arguments); }
  inherit(Stage, Container);
  Stage.prototype.initialize = function() { Container.prototype.initialize.call(this); this.interactive = false; };
  for (const field of ['x', 'y', 'rotation', 'alpha', 'visible', 'renderable', 'z']) prop(Container, field);
  point(Container, 'position', 'x', 'y'); point(Container, 'scale', 'scaleX', 'scaleY');
  point(Container, 'pivot', 'pivotX', 'pivotY'); point(Container, 'skew', 'skewX', 'skewY');
  function TilemapDisplay() { throw new Error('Map tilemaps are created by the native spriteset'); }
  inherit(TilemapDisplay, Container);
  point(TilemapDisplay, 'origin', 'originX', 'originY');
  Object.defineProperty(Container.prototype, 'parent', { get() {
    const own = entry(this), revision = numericState(this).parentRevision[0];
    if (own.parentRevision !== revision) { own.parent = wrap(api.invoke(own.handle, 'parent')); own.parentRevision = revision; }
    return own.parent;
  } });
  Object.defineProperty(Container.prototype, 'children', { get() {
    const object = this, own = entry(object);
    if (!own.childArray) {
      const target = options.createArray ? options.createArray() : [];
      const mutators = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'copyWithin', 'fill']);
      let currentValues;
      function refresh() {
        const values = children(object);
        if (values !== currentValues) { target.splice(0, target.length, ...values); currentValues = values; }
      }
      function commit(values) {
        api.invoke(own.handle, 'replaceChildren', ...values.map(child => entry(child).handle));
        refresh();
      }
      own.childArray = new Proxy(target, {
        get(array, key, receiver) {
          refresh();
          if (mutators.has(key)) return (...args) => {
            const values = target.slice(), result = Array.prototype[key].apply(values, args);
            commit(values); return result === values ? receiver : result;
          };
          return Reflect.get(array, key, receiver);
        },
        set(array, key, value) {
          refresh(); const values = target.slice(); Reflect.set(values, key, value); commit(values); return true;
        },
        deleteProperty(array, key) {
          refresh(); const values = target.slice(); delete values[key]; commit(values); return true;
        }
      });
    }
    return own.childArray;
  } });
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
  Container.prototype.removeChildAt = function(index) { const child = this.getChildAt(index); this.removeChild(child); return child; };
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
  Sprite.prototype.pluginName='sprite';
  Sprite.prototype.calculateVertices=function() {
    const texture=this.texture,frame=texture&&(texture.orig||texture.frame);
    let width=frame?frame.width:this.width,height=frame?frame.height:this.height;
    if(!frame&&this.bitmap) {
      const requested=this._frame,x=Math.max(0,Math.min(Math.floor(requested.x),this.bitmap.width)),y=Math.max(0,Math.min(Math.floor(requested.y),this.bitmap.height));
      width=Math.max(0,Math.min(Math.floor(requested.width)-x+Math.floor(requested.x),this.bitmap.width-x));
      height=Math.max(0,Math.min(Math.floor(requested.height)-y+Math.floor(requested.y),this.bitmap.height-y));
    }
    let left=-this.anchor.x*width,top=-this.anchor.y*height;
    if(texture?.trim) {left+=texture.trim.x;top+=texture.trim.y;width=texture.trim.width;height=texture.trim.height;}
    const matrix=this.worldTransform,vertices=this.vertexData||(this.vertexData=options.createVertices?options.createVertices():new Float32Array(8));
    for(const [index,x,y] of [[0,left,top],[2,left+width,top],[4,left+width,top+height],[6,left,top+height]]) {
      vertices[index]=matrix.a*x+matrix.c*y+matrix.tx;vertices[index+1]=matrix.b*x+matrix.d*y+matrix.ty;
    }
  };
  spriteRenderHooks=installSpriteRenderHooks(Sprite,{
    renderDefault(object,renderer) {objectRenderer.route(object,renderer);},
    defer(callback) { options.runScript('setTimeout')(callback,0); },
    filterArea() { return options.rectangle(0,0,Graphics.width,Graphics.height); },
    requiresHook(object) {return objectRenderer?.requiresHook(object)||false;},
    rendererChanged() {return objectRenderer?.changed()||false;},
    isWebGL() {return options.coreService('isWebGL');},
    renderer() {return options.graphics()._renderer;},
    setHook(object,callback) {entry(object).renderHook=callback;api.invoke(entry(object).handle,'spriteRenderHook',callback);}
  });
  for (const field of ['width', 'height', 'opacity', 'blendMode', 'opaque', '_isPicture', 'spriteId', 'ax', 'ay', '_refreshFrame']) prop(Sprite, field);
  Sprite.prototype.setFrame = function(x, y, w, h) { this._refreshFrame = false; api.invoke(entry(this).handle, 'frame', x, y, w, h); };
  Object.defineProperty(Sprite.prototype, '_frame', { get() {
    const own = entry(this);
    if (!own.frame) {
      own.frame = new (options.rectangleClass?.() || Object)();
      ['x', 'y', 'width', 'height'].forEach((field, index) => Object.defineProperty(own.frame, field, {
        enumerable: true,
        get() { return api.invoke(own.handle, 'frame')[index]; },
        set(value) { const rect = api.invoke(own.handle, 'frame'); rect[index] = value; api.invoke(own.handle, 'frame', ...rect); }
      }));
    }
    return own.frame;
  } });
  Sprite.prototype._refresh = function() { api.invoke(entry(this).handle, 'refreshSprite'); };
  Sprite.prototype._onBitmapLoad = function(bitmap) {
    if (bitmap === this.bitmap && this._refreshFrame) { this._refreshFrame = false; this._frame.width=bitmap.width;this._frame.height=bitmap.height; }
    this._refresh();
  };
  Object.defineProperty(Sprite.prototype, '_bitmap', { configurable: true, get() { return this.bitmap; }, set(value) { this.bitmap = value; } });
  Sprite.prototype._isInBitmapRect = function(x, y, width, height) { return this.bitmap && x + width > 0 && y + height > 0 && x < this.bitmap.width && y < this.bitmap.height; };
  Sprite.prototype._needsTint = function() { const tone = this._colorTone; return tone[0] || tone[1] || tone[2] || tone[3] || this._blendColor[3] > 0; };
  for (const [name, method] of [['_colorTone','tone'], ['_blendColor','blend']]) Object.defineProperty(Sprite.prototype, name, {
    configurable: true,
    get() {
      const own = entry(this), object=this;
      if (!own[name]) {
        const target = options.createArray ? options.createArray() : []; target.push(0, 0, 0, 0);
        own[name] = new Proxy(target, {
          get(array, key) { return key === 'length' || ['0','1','2','3'].includes(key) ? Reflect.get(api.invoke(own.handle, method), key) : Reflect.get(array, key); },
          set(array, key, value) { const color = api.invoke(own.handle, method); color[key] = value; api.invoke(own.handle, method, ...color); object._refresh(); return Reflect.set(array, key, value); }
        });
      }
      return own[name];
    },
    set(value) { api.invoke(entry(this).handle, method, ...value); this._refresh(); }
  });

  Sprite.prototype.getColorTone = function() { const values = options.createArray ? options.createArray() : []; values.push(...api.invoke(entry(this).handle, 'tone')); return values; };
  Sprite.prototype.setColorTone = function(value) { api.invoke(entry(this).handle, 'tone', ...value); };
  Sprite.prototype.getBlendColor = function() { const values = options.createArray ? options.createArray() : []; values.push(...api.invoke(entry(this).handle, 'blend')); return values; };
  Sprite.prototype.setBlendColor = function(value) { api.invoke(entry(this).handle, 'blend', ...value); };
  Object.defineProperty(Container.prototype, 'worldTransform', { configurable: true, get() {
    const own=entry(this);
    if(own.handle.kind==='sprite'||own.handle.kind==='tiling') {const rendered=api.invoke(own.handle,'renderWorld');if(rendered)return options.matrix(rendered);}
    const rotation=this.rotation, skewY=this.skew.y, scaleX=this.scale.x, skewX=this.skew.x, scaleY=this.scale.y;
    const a = Math.cos(rotation + skewY) * scaleX, b = Math.sin(rotation + skewY) * scaleX;
    const c = -Math.sin(rotation - skewX) * scaleY, d = Math.cos(rotation - skewX) * scaleY;
    const x=this.x, pivotX=this.pivot.x, pivotY=this.pivot.y, y=this.y;
    const tx = x - pivotX * a - pivotY * c, ty = y - pivotX * b - pivotY * d;
    const parent = this.parent?.worldTransform;
    return options.matrix(parent ? [parent.a*a+parent.c*b,parent.b*a+parent.d*b,parent.a*c+parent.c*d,parent.b*c+parent.d*d,parent.a*tx+parent.c*ty+parent.tx,parent.b*tx+parent.d*ty+parent.ty] : [a,b,c,d,tx,ty]);
  } });
  Container.prototype.getBounds = function() {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    const add = (x,y) => { left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y); };
    const matrix = this.worldTransform;
    let x=0,y=0,width=0,height=0;
    if (this instanceof Sprite) {
      const bitmap=this.bitmap, frame=api.invoke(entry(this).handle,'frame');
      if (bitmap) {
        const clippedSize = (offset, size, extent) => {
          const start = Math.max(0, Math.min(Math.floor(offset), extent));
          return Math.max(0, Math.min(Math.floor(size) - start + Math.floor(offset), extent - start));
        };
        width=clippedSize(frame[0],frame[2],bitmap.width);height=clippedSize(frame[1],frame[3],bitmap.height);
      }
      x=-this.anchor.x*width;y=-this.anchor.y*height;
      if(this instanceof TilingSprite) {width=this.width;height=this.height;x=0;y=0;}
    } else if(this instanceof Window) {width=this.width;height=this.height;}
    else if(this instanceof ScreenSprite) {x=-Graphics.width*5;y=-Graphics.height*5;width=Graphics.width*10;height=Graphics.height*10;}
    if(width>0&&height>0)for(const [px,py] of [[x,y],[x+width,y],[x,y+height],[x+width,y+height]])add(matrix.a*px+matrix.c*py+matrix.tx,matrix.b*px+matrix.d*py+matrix.ty);
    for(const child of this.children)if(child.visible&&child.renderable) {const bounds=child.getBounds();if(bounds.width>0&&bounds.height>0){add(bounds.x,bounds.y);add(bounds.x+bounds.width,bounds.y+bounds.height);}}
    return options.rectangle(Number.isFinite(left)?left:0,Number.isFinite(top)?top:0,Number.isFinite(right)?right-left:0,Number.isFinite(bottom)?bottom-top:0);
  };
  const filteredDisplays = new Set();
  function compileDisplayFilters(object) {
    if (object instanceof WindowLayer && object.filterArea) {
      for (const key of ['x', 'y', 'width', 'height']) object.filterArea[key] = object[key];
    }
    const filters=entry(object).filters || [];
    const groups=options.compileFilters?.(object, filters);
    if(groups) {api.invoke(entry(object).handle,'filterGroups',groups);return true;}
    return false;
  }
  function filterHandle(filter) {
    if (nodes.has(filter)) return entry(filter).handle;
    let binding=nativeFilters.get(filter);
    if (!binding) {
      const Type=options.glitchFilterClass?.(), Color=options.colorMatrixFilterClass?.();
      if ((!Type || !(filter instanceof Type)) && (!Color || !(filter instanceof Color))) throw new TypeError('Native display filter is unsupported: '+filter.constructor?.name);
      binding={ source:new WeakRef(filter), handle:api.create(runtime,'glitch'), color: !!(Color && filter instanceof Color) };
      nativeFilters.set(filter,binding); filterUpdates.add(binding);
    }
    return binding.handle;
  }
  function updateFilters(stage) {
    spriteRenderHooks.update();
    for (const weak of filteredDisplays) {
      const object=weak.deref();
      if(!object)filteredDisplays.delete(weak);
      else {
        if (stage) {
          let ancestor = object;
          while (ancestor && ancestor !== stage) ancestor = ancestor.parent;
          if (!ancestor) continue;
        }
        if(!compileDisplayFilters(object))api.invoke(entry(object).handle,'filters',...(entry(object).filters||[]).map(filterHandle));
      }
    }
    for (const binding of filterUpdates) {
      const filter=binding.source.deref();
      if (!filter) { filterUpdates.delete(binding); continue; }
      if (binding.color) {
        api.invoke(binding.handle, 'filterMatrix', filter.matrix, filter.alpha === undefined ? 1 : filter.alpha);
        api.field(binding.handle, 'enabled', filter.enabled !== false);
        continue;
      }
      for (const field of ['slices','offset','direction','fillMode','seed','enabled'])
        api.field(binding.handle,field,filter[field]);
    }
  }
  function assignFilters(object,value) {
      const own=entry(object), previous=own.filters; own.filters=value;
      try {
        const compiled=compileDisplayFilters(object);
        if (!compiled) api.invoke(own.handle, 'filters', ...(value || []).map(filterHandle));
        if (!own.filterRef) {own.filterRef=new WeakRef(object);filteredDisplays.add(own.filterRef);}
        updateFilters();
      } catch(error) {own.filters=previous;throw error;}
  }
  Object.defineProperty(Container.prototype, 'filters', {
    configurable:true,
    get() {const filters=entry(this).filters;return filters&&filters.slice();},
    set(value) {assignFilters(this,value&&value.slice());}
  });
  Object.defineProperty(Container.prototype,'_filters',{
    configurable:true,get() {return entry(this).filters;},set(value) {assignFilters(this,value);}
  });
  function GlitchFilter() { attach(this, 'glitch'); }
  for (const field of ['slices', 'offset', 'direction', 'fillMode', 'seed', 'enabled']) prop(GlitchFilter, field);
  Container.prototype.canvasToLocalX = function(x) { return api.invoke(entry(this).handle, 'canvasLocalX', x); };
  Container.prototype.canvasToLocalY = function(y) { return api.invoke(entry(this).handle, 'canvasLocalY', y); };
  Object.defineProperty(Sprite.prototype, 'spriteId', { configurable: true, get() { return Number(entry(this).handle.identity); } });
  Sprite._counter = 0;
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
  Sprite_Base.prototype.update = function() {
    Sprite.prototype.update.call(this); api.invoke(entry(this).handle, 'updateAnimations');
    if (this._animationSprites) this._animationSprites = this._animationSprites.filter(sprite => { if (sprite.isPlaying()) return true; sprite.remove(); return false; });
  };
  Sprite_Base.prototype.isAnimationPlaying = function() { return Boolean(this._animationSprites?.length) || api.invoke(entry(this).handle, 'isAnimationPlaying'); };
  Sprite_Base.prototype.startAnimation = function(animation, mirror, delay) {
    const stock = Object.entries(nativeAnimationMethods).every(([name, original]) => ['initialize', 'setupRate'].includes(name) || Sprite_Animation.prototype[name] === original);
    if (!stock) {
      const sprite = new Sprite_Animation(); sprite.setup(this._effectTarget || this, animation, mirror, delay);
      this.parent.addChild(sprite); (this._animationSprites ||= []).push(sprite); return;
    }
    const defaultRate = Sprite_Animation.prototype.initialize === animationInitialize && Sprite_Animation.prototype.setupRate === animationSetupRate;
    let rate = 4;
    if (!defaultRate) { const sprite = new Sprite_Animation(); sprite.setupRate(); rate = sprite._rate; }
    options.startAnimation(entry(this).handle, animation.id, mirror, delay, rate);
  };
  function Sprite_Animation() { this.initialize.apply(this, arguments); }
  inherit(Sprite_Animation, Sprite);
  const animationInitialize = Sprite_Animation.prototype.initialize = function() { Sprite.prototype.initialize.call(this); this.initMembers(); };
  Sprite_Animation.prototype.initMembers = function() {
      this._target = null;
      this._animation = null;
      this._mirror = false;
      this._delay = 0;
      this._rate = 4;
      this._duration = 0;
      this._flashColor = [0, 0, 0, 0];
      this._flashDuration = 0;
      this._screenFlashDuration = 0;
      this._hidingDuration = 0;
      this._bitmap1 = null;
      this._bitmap2 = null;
      this._cellSprites = [];
      this._screenFlashSprite = null;
      this._duplicated = false;
      this.z = 8;
  };
  
  Sprite_Animation.prototype.setup = function(target, animation, mirror, delay) {
      this._target = target;
      this._animation = animation;
      this._mirror = mirror;
      this._delay = delay;
      if (this._animation) {
          this.remove();
          this.setupRate();
          this.setupDuration();
          this.loadBitmaps();
          this.createSprites();
      }
  };
  
  Sprite_Animation.prototype.remove = function() {
      if (this.parent && this.parent.removeChild(this)) {
          this._target.setBlendColor([0, 0, 0, 0]);
          this._target.show();
      }
  };
  
  Sprite_Animation.prototype.setupDuration = function() {
      this._duration = this._animation.frames.length * this._rate + 1;
  };
  
  Sprite_Animation.prototype.isPlaying = function() {
      return this._duration > 0;
  };
  
  Sprite_Animation.prototype.loadBitmaps = function() {
      var name1 = this._animation.animation1Name;
      var name2 = this._animation.animation2Name;
      var hue1 = this._animation.animation1Hue;
      var hue2 = this._animation.animation2Hue;
      this._bitmap1 = ImageManager.loadAnimation(name1, hue1);
      this._bitmap2 = ImageManager.loadAnimation(name2, hue2);
  };
  
  Sprite_Animation.prototype.isReady = function() {
      return this._bitmap1 && this._bitmap1.isReady() && this._bitmap2 && this._bitmap2.isReady();
  };
  
  Sprite_Animation.prototype.createSprites = function() {
      if (!Sprite_Animation._checker2[this._animation]) {
          this.createCellSprites();
          if (this._animation.position === 3) {
              Sprite_Animation._checker2[this._animation] = true;
          }
          this.createScreenFlashSprite();
      }
      if (Sprite_Animation._checker1[this._animation]) {
          this._duplicated = true;
      } else {
          this._duplicated = false;
          if (this._animation.position === 3) {
              Sprite_Animation._checker1[this._animation] = true;
          }
      }
  };
  
  Sprite_Animation.prototype.createCellSprites = function() {
      this._cellSprites = [];
      for (var i = 0; i < 16; i++) {
          var sprite = new Sprite();
          sprite.anchor.x = 0.5;
          sprite.anchor.y = 0.5;
          this._cellSprites.push(sprite);
          this.addChild(sprite);
      }
  };
  
  Sprite_Animation.prototype.createScreenFlashSprite = function() {
      this._screenFlashSprite = new ScreenSprite();
      this.addChild(this._screenFlashSprite);
  };
  
  Sprite_Animation.prototype.updateMain = function() {
      if (this.isPlaying() && this.isReady()) {
          if (this._delay > 0) {
              this._delay--;
          } else {
              this._duration--;
              this.updatePosition();
              if (this._duration % this._rate === 0) {
                  this.updateFrame();
              }
          }
      }
  };
  
  Sprite_Animation.prototype.updateFrame = function() {
      if (this._duration > 0) {
          var frameIndex = this.currentFrameIndex();
          this.updateAllCellSprites(this._animation.frames[frameIndex]);
          this._animation.timings.forEach(function(timing) {
              if (timing.frame === frameIndex) {
                  this.processTimingData(timing);
              }
          }, this);
      }
  };
  
  Sprite_Animation.prototype.currentFrameIndex = function() {
      return (this._animation.frames.length -
              Math.floor((this._duration + this._rate - 1) / this._rate));
  };
  
  Sprite_Animation.prototype.updateAllCellSprites = function(frame) {
      for (var i = 0; i < this._cellSprites.length; i++) {
          var sprite = this._cellSprites[i];
          if (i < frame.length) {
              this.updateCellSprite(sprite, frame[i]);
          } else {
              sprite.visible = false;
          }
      }
  };
  
  Sprite_Animation.prototype.updateCellSprite = function(sprite, cell) {
      var pattern = cell[0];
      if (pattern >= 0) {
          var sx = pattern % 5 * 192;
          var sy = Math.floor(pattern % 100 / 5) * 192;
          var mirror = this._mirror;
          sprite.bitmap = pattern < 100 ? this._bitmap1 : this._bitmap2;
          sprite.setFrame(sx, sy, 192, 192);
          sprite.x = cell[1];
          sprite.y = cell[2];
          sprite.rotation = cell[4] * Math.PI / 180;
          sprite.scale.x = cell[3] / 100;
  
          if(cell[5]){
              sprite.scale.x *= -1;
          }
          if(mirror){
              sprite.x *= -1;
              sprite.rotation *= -1;
              sprite.scale.x *= -1;
          }
  
          sprite.scale.y = cell[3] / 100;
          sprite.opacity = cell[6];
          sprite.blendMode = cell[7];
          sprite.visible = true;
      } else {
          sprite.visible = false;
      }
  };
  Sprite_Animation._checker1 = {}; Sprite_Animation._checker2 = {};
  const animationSetupRate = Sprite_Animation.prototype.setupRate = function() { this._rate = 4; };
  Sprite_Animation.prototype.updatePosition = function() {
      if (this._animation.position === 3) {
          this.x = this.parent.width / 2;
          this.y = this.parent.height / 2;
      } else {
          var parent = this._target.parent;
          var grandparent = parent ? parent.parent : null;
          this.x = this._target.x;
          this.y = this._target.y;
          if (this.parent === grandparent) {
              this.x += parent.x;
              this.y += parent.y;
          }
          if (this._animation.position === 0) {
              this.y -= this._target.height;
          } else if (this._animation.position === 1) {
              this.y -= this._target.height / 2;
          }
      }
  };

  Sprite_Animation.prototype.processTimingData = function(timing) {
      var duration = timing.flashDuration * this._rate;
      switch (timing.flashScope) {
      case 1:
          this.startFlash(timing.flashColor, duration);
          break;
      case 2:
          this.startScreenFlash(timing.flashColor, duration);
          break;
      case 3:
          this.startHiding(duration);
          break;
      }
      if (!this._duplicated && timing.se) {
          options.audioManager().playSe(timing.se);
      }
  };

  Sprite_Animation.prototype.startFlash = function(color, duration) {
      this._flashColor = Array.from(color);
      this._flashDuration = duration;
  };

  Sprite_Animation.prototype.startScreenFlash = function(color, duration) {
      this._screenFlashDuration = duration;
      if (!this._screenFlashSprite) { this._screenFlashSprite = new ScreenSprite(); this.addChild(this._screenFlashSprite); }
      if (this._screenFlashSprite) {
          this._screenFlashSprite.setColor(color[0], color[1], color[2]);
          this._screenFlashSprite.opacity = color[3];
      }
  };

  Sprite_Animation.prototype.startHiding = function(duration) {
      this._hidingDuration = duration;
      this._target.hide();
  };
  Sprite_Animation.prototype.update = function() {
    Sprite.prototype.update.call(this); this.updateMain(); this.updateFlash(); this.updateScreenFlash(); this.updateHiding();
    Sprite_Animation._checker1 = {}; Sprite_Animation._checker2 = {};
  };
  Sprite_Animation.prototype.updateFlash = function() {
      if (this._flashDuration > 0) {
          var d = this._flashDuration--;
          this._flashColor[3] *= (d - 1) / d;
          this._target.setBlendColor(this._flashColor);
      }
  };

  Sprite_Animation.prototype.updateScreenFlash = function() {
      if (this._screenFlashDuration > 0) {
          var d = this._screenFlashDuration--;
          if (this._screenFlashSprite) {
              this._screenFlashSprite.x = -this.absoluteX();
              this._screenFlashSprite.y = -this.absoluteY();
              this._screenFlashSprite.opacity *= (d - 1) / d;
              this._screenFlashSprite.visible = (this._screenFlashDuration > 0);
          }
      }
  };

  Sprite_Animation.prototype.updateHiding = function() {
      if (this._hidingDuration > 0) {
          this._hidingDuration--;
          if (this._hidingDuration === 0) {
              this._target.show();
          }
      }
  };

  Sprite_Animation.prototype.absoluteX = function() {
      var x = 0;
      var object = this;
      while (object) {
          x += object.x;
          object = object.parent;
      }
      return x;
  };

  Sprite_Animation.prototype.absoluteY = function() {
      var y = 0;
      var object = this;
      while (object) {
          y += object.y;
          object = object.parent;
      }
      return y;
  };
  function TilingSprite() { this.initialize.apply(this, arguments); }
  inherit(TilingSprite, Sprite);
  TilingSprite.prototype.initialize = function(bitmap) { attach(this, 'tiling'); if (bitmap) this.bitmap = bitmap; };
  TilingSprite.prototype.pluginName='picture';
  spriteRenderHooks.installTiling(TilingSprite);
  TilingSprite.prototype._onBitmapLoad=function() {this._refreshFrame=false;this._refresh();};
  point(TilingSprite, 'origin', 'originX', 'originY');
  TilingSprite.prototype.move = function(x, y, w, h) { this.x = x; this.y = y; this.width = w; this.height = h; };
  function ScreenSprite() { this.initialize.apply(this, arguments); }
  inherit(ScreenSprite, Container);
  ScreenSprite.prototype.initialize = function() { attach(this, 'screen'); };
  prop(ScreenSprite, 'opacity'); prop(ScreenSprite, 'blendMode');
  ScreenSprite.prototype.setColor = function(r, g, b) { api.invoke(entry(this).handle, 'color', r, g, b); };
  ScreenSprite.prototype.setBlack = function() { this.setColor(0, 0, 0); };
  ScreenSprite.prototype.setWhite = function() { this.setColor(255, 255, 255); };
  installScreenSprite(options.runScript, ScreenSprite);
  function ToneSprite() { this.initialize.apply(this, arguments); }
  inherit(ToneSprite, Container);
  ToneSprite.prototype.initialize = function() { attach(this, 'tone'); this.clear(); };
  for (const field of ['_red', '_green', '_blue', '_gray']) prop(ToneSprite, field);
  ToneSprite.prototype.clear = function() { this.setTone(0, 0, 0, 0); };
  ToneSprite.prototype.setTone = function(r, g, b, gray) { api.invoke(entry(this).handle, 'toneColor', r || 0, g || 0, b || 0, gray || 0); };
  function Window() { this.initialize.apply(this, arguments); }
  inherit(Window, Container);
  Window.prototype.initialize = function() {
    if (!nodes.has(this)) attach(this, 'window');
    if (entry(this).windowInitialized) throw new Error('Window is already initialized');
    entry(this).windowInitialized = true;
    this._windowArrowSprites = options.runScript('[]');
    windowParts.initialize(this);
    this._createAllParts();
    windowParts.created(this);
  };
  for (const field of ['width', 'height', 'padding', 'margin', 'openness', 'opacity', 'backOpacity', 'contentsOpacity', 'active', 'opening', 'closing', 'pause', 'upArrowVisible', 'downArrowVisible']) prop(Window, field);
  for (const field of ['width', 'height', 'padding', 'margin']) {
    Object.defineProperty(Window.prototype, field, { configurable: true, enumerable: true,
      get() { return api.field(entry(this).handle, field); },
      set(value) {
        windowParts.beforeChange(this);
        api.field(entry(this).handle, field, value);
        windowParts.remember(this); this._refreshAllParts();
      }
    });
  }
  for (const field of ['opacity', 'backOpacity', 'contentsOpacity']) {
    Object.defineProperty(Window.prototype, field, { configurable: true, enumerable: true,
      get() { return windowParts.opacity(this, field); },
      set(value) { api.field(entry(this).handle, field, value); windowParts.setOpacity(this, field, value); }
    });
  }
  prop(Window, "_animationCount"); prop(Window,"_isWindow");
  for (const field of ['width', 'height', 'padding', 'margin']) {
    Object.defineProperty(Window.prototype, '_' + field, { configurable: true,
      get() { return api.field(entry(this).handle, field); },
      set(value) {
        windowParts.privateChange(this); api.field(entry(this).handle, field, value);
        windowParts.remember(this);
      }
    });
  }
  for (const field of ['openness', 'opening', 'closing']) prop(Window, '_' + field, field);
  prop(Window,'_openness','rawOpenness');
  Object.defineProperty(Window.prototype,'_windowSpriteContainer',{ configurable:true,get() {
    windowParts?.privateChange(this);
    const part=wrap(api.invoke(entry(this).handle,'windowPart','container')); entry(part).parent=this; return part;
  } });
  point(Window, 'origin', 'originX', 'originY');
  bitmapProperty(Window, 'contents'); bitmapProperty(Window, 'windowskin');
  Window.prototype.move = function(x, y, width, height) {
    this.x = x || 0; this.y = y || 0;
    if (this.width !== width || this.height !== height) {
      windowParts.beforeChange(this);
      const handle = entry(this).handle;
      api.field(handle, 'width', width || 0); api.field(handle, 'height', height || 0);
      windowParts.remember(this); this._refreshAllParts();
    }
  };
  Window.prototype.addChildToBack = function(child) {
    const own = entry(this), value = entry(child), previous = value.parent;
    api.invoke(own.handle, 'addBack', value.handle);
    if (previous) entry(previous).children.delete(value.handle.identity);
    own.children.set(value.handle.identity, child); value.parent = this; return child;
  };
  Window.prototype.isOpen = function() { return this.openness >= 255; };
  Window.prototype.isClosed = function() { return this.openness <= 0; };
  Window.prototype.setCursorRect = function(x, y, w, h) {
    const rectangle = [x,y,w,h].map(value => Math.floor(value || 0));
    const previous = windowParts.cursorValues(this);
    if (rectangle.some((value, index) => value !== previous[index])) {
      api.invoke(entry(this).handle, 'cursor', ...rectangle); windowParts.updateCursor(this, rectangle); this._refreshCursor();
    }
  };
  Window.prototype._createAllParts = function() { api.invoke(entry(this).handle, 'refreshWindow'); };
  Window.prototype._refreshAllParts = function() { api.invoke(entry(this).handle, 'refreshWindow'); };
  Window.prototype.update = function() { api.invoke(entry(this).handle, 'tick'); this.updateChildren(); };
  function WindowLayer() { this.initialize.apply(this, arguments); }
  inherit(WindowLayer, Container);
  function initializeWindowLayer(object) {
    const own=entry(object);
    own.prepareLayer=()=>windowLayerParts.prepare(object);
    api.invoke(own.handle,'displayPrepare',own.prepareLayer);
    object.filterArea = options.rectangle();
    if (WindowLayer.voidFilter) object.filters = [WindowLayer.voidFilter];
  }
  WindowLayer.prototype.initialize = function() { attach(this, 'windowLayer'); initializeWindowLayer(this); };
  WindowLayer.prototype.onRemoveAsAChild = function() { this.removeChildren(); };
  prop(WindowLayer, 'width'); prop(WindowLayer, 'height');
  prop(WindowLayer, '_width', 'width'); prop(WindowLayer, '_height', 'height');
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
  installWindowDrawing(Window_Base, ImageManager, options);
  Window_Base.prototype.open = function() { if (!this.isOpen()) this.opening = true; this.closing = false; return this; };
  Window_Base.prototype.close = function() { if (!this.isClosed()) this.closing = true; this.opening = false; return this; };
  Window_Base.prototype.isOpen = function() { return this.openness >= 255; };
  Window_Base.prototype.isClosed = function() { return this.openness <= 0; };
  Window_Base.prototype.isOpening = function() { return this.opening; };
  Window_Base.prototype.isClosing = function() { return this.closing; };
  Window_Base.prototype.dimColor1 = function() { return 'rgba(0, 0, 0, 0.6)'; };
  Window_Base.prototype.dimColor2 = function() { return 'rgba(0, 0, 0, 0)'; };
  Window_Base.prototype.setBackgroundType = function(type) {
    this.opacity = type === 0 ? 255 : 0;
    if (type === 1) this.showBackgroundDimmer(); else this.hideBackgroundDimmer();
  };
  Window_Base.prototype.showBackgroundDimmer = function() {
    if (!this._dimmerSprite) { this._dimmerSprite = new Sprite(new Bitmap(0, 0)); this.addChildToBack(this._dimmerSprite); }
    if (this._dimmerSprite.bitmap.width !== this.width || this._dimmerSprite.bitmap.height !== this.height) this.refreshDimmerBitmap();
    this._dimmerSprite.visible = true; this.updateBackgroundDimmer();
  };
  Window_Base.prototype.hideBackgroundDimmer = function() { if (this._dimmerSprite) this._dimmerSprite.visible = false; };
  Window_Base.prototype.updateBackgroundDimmer = function() { if (this._dimmerSprite) this._dimmerSprite.opacity = this.openness; };
  Window_Base.prototype.refreshDimmerBitmap = function() {
    if (!this._dimmerSprite) return;
    const bitmap = this._dimmerSprite.bitmap, w = this.width, h = this.height, m = this.padding, c1 = this.dimColor1(), c2 = this.dimColor2();
    bitmap.resize(w, h); bitmap.gradientFillRect(0, 0, w, m, c2, c1, true);
    bitmap.fillRect(0, m, w, h - m * 2, c1); bitmap.gradientFillRect(0, h - m, w, m, c1, c2, true);
    this._dimmerSprite.setFrame(0, 0, w, h);
  };
  Window_Base.prototype.updateTone = function() { const tone = readNativeArray(options.gameSystem().windowTone()); this.setTone(tone[0] || 0, tone[1] || 0, tone[2] || 0); };
  Window_Base.prototype.update = function() { Window.prototype.update.call(this); this.updateTone(); this.updateBackgroundDimmer(); };
  Window_Base.prototype.activate = function() { this.active = true; return this; };
  Window_Base.prototype.deactivate = function() { this.active = false; return this; };
  const nativeAnimationMethods = Object.fromEntries(Object.getOwnPropertyNames(Sprite_Animation.prototype).filter(name => typeof Sprite_Animation.prototype[name] === 'function').map(name => [name, Sprite_Animation.prototype[name]]));
  function Window_Message() { this.initialize.apply(this, arguments); }
  inherit(Window_Message, Window_Base);
  Window_Message.prototype.initialize = function() {
    const width = this.windowWidth();
    Window_Base.prototype.initialize.call(this, (Graphics.boxWidth - width) / 2, 0, width, this.windowHeight());
    this.openness = 0; this.initMembers(); this.createSubWindows(); this.updatePlacement();
  };
  Window_Message.prototype.initMembers = function() {
    this._imageReservationId = String(entry(this).handle.identity);
    this._background = 0; this._positionType = 2; this._waitCount = 0;
    this._faceBitmap = null; this._textState = null; this.clearFlags();
  };
  Window_Message.prototype.createSubWindows = function() {
    this._goldWindow = new (options.sceneClass('Window_Gold'))(0, 0);
    this._goldWindow.x = Graphics.boxWidth - this._goldWindow.width; this._goldWindow.openness = 0;
    this._choiceWindow = new (options.sceneClass('Window_ChoiceList'))(this);
    this._numberWindow = new (options.sceneClass('Window_NumberInput'))(this);
    this._itemWindow = new (options.sceneClass('Window_EventItem'))(this);
  };
  Window_Message.prototype.subWindows = function() { return [this._goldWindow, this._choiceWindow, this._numberWindow, this._itemWindow]; };
  Window_Message.prototype.updatePlacement = function() {
    this._positionType = options.gameMessage().positionType();
    this.y = this._positionType * (Graphics.boxHeight - this.height) / 2;
    this._goldWindow.y = this.y > 0 ? 0 : Graphics.boxHeight - this._goldWindow.height;
  };
  Window_Message.prototype.windowWidth = function() { return Graphics.boxWidth; };
  Window_Message.prototype.windowHeight = function() { return this.fittingHeight(this.numVisibleRows()); };
  Window_Message.prototype.numVisibleRows = function() { return 4; };
  Window_Message.prototype.clearFlags = function() { options.messageWindow('clearFlags'); };
  Window_Message.prototype.terminateMessage = function() { this.close(); options.messageWindow('terminateMessage'); };
  Window_Message.prototype.startInput = function() {
    if (!scriptMessages()) return options.messageWindow('startInput');
    if (options.gameMessage().isChoice()) { this._choiceWindow.start(); return true; }
    if (options.gameMessage().isNumberInput()) { this._numberWindow.start(); return true; }
    if (options.gameMessage().isItemChoice()) { this._itemWindow.start(); return true; }
    return false;
  };
  for (const field of ['_showFast', '_lineShowFast', '_pauseSkip', '_waitCount', 'pause']) Object.defineProperty(Window_Message.prototype, field, {
    configurable: true, get() { return options.messageWindowField(field); }, set(value) { options.messageWindowField(field, value); }
  });
  Object.defineProperty(Window_Message.prototype, 'pause', { configurable: true,
    get() { return options.messageWindowField('pause'); },
    set(value) { api.field(entry(this).handle, 'pause', Boolean(value)); options.messageWindowField('pause', Boolean(value)); }
  });
  function Window_Selectable() { this.initialize.apply(this, arguments); }
  inherit(Window_Selectable, Window_Base);
  Window_Selectable.prototype.initialize = function(x, y, width, height) {
    Window_Base.prototype.initialize.call(this, x, y, width, height);
    this._index = -1; this._handlers = {}; this._stayCount = 0; this._touching = false; this.deactivate();
  };
  prop(Window_Selectable, '_index', 'index');
  prop(Window_Selectable, '_cursorFixed', 'cursorFixed'); prop(Window_Selectable, '_cursorAll', 'cursorAll');
  Window_Selectable.prototype.index = function() { return this._index; };
  Window_Selectable.prototype.cursorAll = function() { return this._cursorAll; };
  Window_Selectable.prototype.setCursorAll = function(value) { this._cursorAll = value; };
  Window_Selectable.prototype.setCursorFixed = function(value) { this._cursorFixed = value; };
  Window_Selectable.prototype.reselect = function() { this.select(this._index); };
  Window_Selectable.prototype.isHorizontal = function() { return this.maxPageRows() === 1; };
  Window_Selectable.prototype.showHelpWindow = function() { if (this._helpWindow) this._helpWindow.show(); };
  Window_Selectable.prototype.hideHelpWindow = function() { if (this._helpWindow) this._helpWindow.hide(); };
  Window_Selectable.prototype.setHelpWindow = function(window) { this._helpWindow = window; this.callUpdateHelp(); };
  Window_Selectable.prototype.setHelpWindowItem = function(item) { if (this._helpWindow) this._helpWindow.setItem(item); };
  Window_Selectable.prototype.maxTopRow = function() { return Math.max(0, this.maxRows() - this.maxPageRows()); };
  Window_Selectable.prototype.setTopRow = function(row) {
    const next = Math.max(0, Math.min(row, this.maxTopRow()));
    if (this.topRow() !== next) { api.field(entry(this).handle, 'topRow', next); this.refresh(); this.updateCursor(); }
  };
  Window_Selectable.prototype.setBottomRow = function(row) { this.setTopRow(row - (this.maxPageRows() - 1)); };
  Window_Selectable.prototype.resetScroll = function() { this.setTopRow(0); };
  Window_Selectable.prototype.maxCols = function() { return 1; };
  Window_Selectable.prototype.maxItems = function() { return 0; };
  Window_Selectable.prototype.spacing = function() { return 12; };
  Window_Selectable.prototype.itemHeight = function() { return this.lineHeight(); };
  Window_Selectable.prototype.itemWidth = function() { return Math.floor((this.width - this.padding * 2 + this.spacing()) / this.maxCols() - this.spacing()); };
  Window_Selectable.prototype.itemRect = function(index) {
    const rect = api.invoke(entry(this).handle, 'itemRect', index, this.maxCols(), this.itemHeight(), this.spacing(), this.itemWidth());
    return { x: rect[0], y: rect[1], width: rect[2], height: rect[3] };
  };
  Window_Selectable.prototype.select = function(index) { this._stayCount = 0; this._index = index; this.ensureCursorVisible(); this.updateCursor(); this.callUpdateHelp(); };
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
    Window_Base.prototype.update.call(this); ++this._stayCount; this.processCursorMove(); this.processHandling(); this.processTouch();
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
    entry(this).commandList?.detach();
    api.invoke(entry(this).handle, 'clearCommands'); entry(this).extensions = [];
  };
  Window_Command.prototype.makeCommandList = function() {};
  Window_Command.prototype.refresh = function() { this.clearCommandList(); this.makeCommandList(); this.createContents(); this.drawAllItems(); };
  function commandsFor(window) {
    const own = entry(window);
    if (!own.commandList) own.commandList = commandList(
      () => Array.from({ length: api.invoke(own.handle, 'commandCount') }, (_, index) => { const command = api.invoke(own.handle, 'command', index); return { ...command, ext: own.extensions?.[index] ?? command.ext }; }),
      values => {
        api.invoke(own.handle, 'clearCommands'); own.extensions = [];
        for (const value of values) window.addCommand(value.name, value.symbol, value.enabled, value.ext);
      },
      (index, value) => {
        api.invoke(own.handle, 'setCommand', index, String(value.name), String(value.symbol), Boolean(value.enabled)); own.extensions[index] = value.ext;
      },
      values => Object.assign(options.createArray(), values));
    return own.commandList;
  }
  Object.defineProperty(Window_Command.prototype, '_list', { configurable: true,
    get() { return commandsFor(this).view; }, set(value) { commandsFor(this).assign(value); }
  });
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
  Window_Command.prototype.findExt = function(ext) { return this._list.findIndex(command => command.ext === ext); };
  Window_Command.prototype.selectExt = function(ext) { const index = this.findExt(ext); this.select(index >= 0 ? index : 0); };
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
        if (description.data && typeof this.makeItemList === 'function') this.makeItemList();
        else invoke(this, 'refreshModel');
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
    if (description.data) {
      const skillData = name === 'Window_SkillList' || name === 'Window_BattleSkill';
      Type.prototype.isCurrentItemEnabled = function() {
        return options.databaseObject(skillData ? 'skills' : 'items') ? this.isEnabled(this.item()) : invoke(this, 'isCurrentItemEnabled');
      };
      function list(object) {
        const own = entry(object);
        if (!own.itemData) own.itemData = nativeArray(() => options.createArray(),
          () => invoke(object, 'data').map(encoded => skillData ? options.databaseObject('skills', encoded)
            : options.databaseObject(encoded >= 200000 ? 'armors' : encoded >= 100000 ? 'weapons' : 'items', encoded % 100000)),
          items => {
            const ids = Array.from(items, item => {
              if (item == null) return 0;
              const types = skillData ? ['skills'] : ['items', 'weapons', 'armors'];
              for (let kind = 0; kind < types.length; ++kind) {
                const index = options.databaseIndex(types[kind], item);
                if (index >= 0) return index + kind * 100000;
              }
              throw new TypeError('Window data requires registered database objects');
            });
            invoke(object, 'data', [ids]);
          });
        return own.itemData;
      }
      Object.defineProperty(Type.prototype, '_data', { configurable: true,
        get() { return list(this).view; }, set(value) { list(this).replace(value); }
      });
      Type.prototype.item = function() { return this._data[this.index()] || null; };
    }
    const fieldNames = { actorId: '_actor', skillType: '_stypeId' };
    for (const field of description.fields) {
      Object.defineProperty(Type.prototype, fieldNames[field] || '_' + field, {
        configurable: true,
        get() { const value = invoke(this, field); return field === 'actorId' ? options.actor(value) : value; },
        set(value) { invoke(this, field, [field === 'actorId' ? options.actorId(value) : value]); }
      });
      const method = field === 'actorId' ? 'setActor' : field === 'skillType' ? 'setStypeId' : 'set' + field[0].toUpperCase() + field.slice(1);
      Type.prototype[method] = function(value) { const property = fieldNames[field] || '_' + field; if (this[property] !== value) { this[property] = value; this.refresh(); } };
    }
    return Type;
  }
  for (const name of windowDescriptions.keys()) installWindow(name);
  nativeWindows.Window_Gold.prototype.value = function() { return options.gameParty().gold(); };
  nativeWindows.Window_Gold.prototype.currencyUnit = function() { return options.textManager().currencyUnit; };
  nativeWindows.Window_ItemCategory.prototype.setItemWindow = function(window) { this._itemWindow = window; window.setCategory(this.currentSymbol()); };
  nativeWindows.Window_ItemCategory.prototype.update = function() {
    Window_Command.prototype.update.call(this);
    if (this._itemWindow) this._itemWindow.setCategory(this.currentSymbol());
  };
  nativeWindows.Window_MenuStatus.prototype.drawItemBackground = function(index) {
      if (index === this._pendingIndex) {
          var rect = this.itemRect(index);
          var color = this.pendingColor();
          this.changePaintOpacity(false);
          this.contents.fillRect(rect.x, rect.y, rect.width, rect.height, color);
          this.changePaintOpacity(true);
      }
  };
  nativeWindows.Window_ShopStatus.prototype.currentEquippedItem = function(actor, etypeId) {
      var list = [];
      var equips = actor.equips();
      var slots = actor.equipSlots();
      for (var i = 0; i < slots.length; i++) {
          if (slots[i] === etypeId) {
              list.push(equips[i]);
          }
      }
      var paramId = this.paramId();
      var worstParam = Number.MAX_VALUE;
      var worstItem = null;
      for (var j = 0; j < list.length; j++) {
          if (list[j] && list[j].params[paramId] < worstParam) {
              worstParam = list[j].params[paramId];
              worstItem = list[j];
          }
      }
      return worstItem;
  };
  nativeWindows.Window_ShopStatus.prototype.drawPossession = function(x, y) {
      var width = this.contents.width - this.textPadding() - x;
      var possessionWidth = this.textWidth('0000');
      this.changeTextColor(this.systemColor());
      this.drawText(options.textManager().possession, x, y, width - possessionWidth);
      this.resetTextColor();
      this.drawText(options.gameParty().numItems(this._item), x, y, width, 'right');
  };
  const shopBuy = nativeWindows.Window_ShopBuy.prototype;
  function shopItem(window, index) {
    const item = options.windowModel(entry(window).handle, 'Window_ShopBuy', 'shopItem', [index]);
    return item ? options.databaseObject(['items', 'weapons', 'armors'][item[0]], item[1]) : null;
  }
  shopBuy.item = function() { return shopItem(this, this.index()); };
  shopBuy.drawItem = function(index) {
    const item = shopItem(this, index), rect = this.itemRect(index); rect.width -= this.textPadding();
    this.changePaintOpacity(this.isEnabled(item)); this.drawItemName(item, rect.x, rect.y, rect.width - 96);
    this.drawText(this.price(item), rect.x + rect.width - 96, rect.y, 96, 'right'); this.changePaintOpacity(true);
  };
  shopBuy.isCurrentItemEnabled = function() { return this.isEnabled(this.item()); };
  shopBuy.price = function(item) {
    for (const [kind, table] of ['items', 'weapons', 'armors'].entries()) {
      const id = options.databaseIndex(table, item);
      if (id > 0) {
        const price = options.windowModel(entry(this).handle, 'Window_ShopBuy', 'priceForItem', [kind, id]);
        return price < 0 ? item.price : price;
      }
    }
    return 0;
  };
  shopBuy.isEnabled = function(item) { return item && this.price(item) <= this._money && !options.gameParty().hasMaxItems(item); };
  const shopNumber = nativeWindows.Window_ShopNumber.prototype;
  shopNumber.maxDigits = function() { return 2; };
  shopNumber.itemY = function() { return Math.round(this.contentsHeight() / 2 - this.lineHeight() * 1.5); };
  shopNumber.cursorWidth = function() { return this.maxDigits() * this.textWidth('0') + this.textPadding() * 2; };
  shopNumber.cursorX = function() { return this.contentsWidth() - this.cursorWidth() - this.textPadding(); };
  const actorCommand = nativeWindows.Window_ActorCommand.prototype;
  actorCommand.addAttackCommand = function() { this.addCommand(options.textManager().attack, 'attack', this._actor.canAttack()); };
  actorCommand.addGuardCommand = function() { this.addCommand(options.textManager().guard, 'guard', this._actor.canGuard()); };
  actorCommand.addItemCommand = function() { this.addCommand(options.textManager().item, 'item'); };
  actorCommand.addSkillCommands = function() {
    for (const id of this._actor.addedSkillTypes().sort((a, b) => a - b)) this.addCommand(options.databaseObject('system').skillTypes[id], 'skill', true, id);
  };
  actorCommand.makeCommandList = function() {
    if (this._actor) { this.addAttackCommand(); this.addSkillCommands(); this.addGuardCommand(); this.addItemCommand(); }
  };
  const savefile = nativeWindows.Window_SavefileList.prototype;
  savefile.maxItems = function() {
      return options.dataManager().maxSavefiles();
  };
  savefile.maxVisibleItems = function() {
      return 5;
  };
  savefile.itemHeight = function() {
      const innerHeight = this.height - this.padding * 2;
      return Math.floor(innerHeight / this.maxVisibleItems());
  };
  savefile.drawItem = function(index) {
      const id = index + 1;
      const valid = options.dataManager().isThisGameFile(id);
      const info = options.dataManager().loadSavefileInfo(id);
      const rect = this.itemRectForText(index);
      this.resetTextColor();
      if (this._mode === 'load') {
          this.changePaintOpacity(valid);
      }
      this.drawFileId(id, rect.x, rect.y);
      if (info) {
          this.changePaintOpacity(valid);
          this.drawContents(info, rect, valid);
          this.changePaintOpacity(true);
      }
  };
  savefile.drawFileId = function(id, x, y) {
      this.drawText(options.textManager().file + ' ' + id, x, y, 180);
  };
  savefile.drawContents = function(info, rect, valid) {
      const bottom = rect.y + rect.height;
      if (rect.width >= 420) {
          this.drawGameTitle(info, rect.x + 192, rect.y, rect.width - 192);
          if (valid) {
              this.drawPartyCharacters(info, rect.x + 220, bottom - 4);
          }
      }
      const lineHeight = this.lineHeight();
      const y2 = bottom - lineHeight;
      if (y2 >= lineHeight) {
          this.drawPlaytime(info, rect.x, y2, rect.width);
      }
  };
  savefile.drawGameTitle = function(info, x, y, width) {
      if (info.title) {
          this.drawText(info.title, x, y, width);
      }
  };
  savefile.drawPartyCharacters = function(info, x, y) {
      if (info.characters) {
          for (let i = 0; i < info.characters.length; i++) {
              const data = info.characters[i];
              this.drawCharacter(data[0], data[1], x + i * 48, y);
          }
      }
  };
  savefile.drawPlaytime = function(info, x, y, width) {
      if (info.playtime) {
          this.drawText(info.playtime, x, y, width, 'right');
      }
  };
  nativeWindows.Window_NameEdit.prototype.name = function() { return this._name; };
  const scrollText = nativeWindows.Window_ScrollText.prototype;
  scrollText.initialize = function() {
    this._text = ''; this._allTextHeight = 0;
    Window_Base.prototype.initialize.call(this, 0, 0, Graphics.boxWidth, Graphics.boxHeight);
    this.opacity = 0; this.hide();
  };
  scrollText.contentsHeight = function() { return Math.max(this._allTextHeight, 1); };
  scrollText.startMessage = function() { this._text = options.gameMessage().allText(); this.refresh(); this.show(); };
  scrollText.refresh = function() {
    const state = { index: 0, text: this.convertEscapeCharacters(this._text) };
    this.resetFontSettings(); this._allTextHeight = this.calcTextHeight(state, true); this.createContents();
    this.origin.y = -this.height; this.drawTextEx(this._text, this.textPadding(), 1);
  };
  scrollText.update = function() {
    Window_Base.prototype.update.call(this);
    const message = options.gameMessage();
    if (message.scrollMode()) {
      if (this._text) this.updateMessage();
      if (!this._text && message.hasText()) this.startMessage();
    }
  };
  scrollText.updateMessage = function() { this.origin.y += this.scrollSpeed(); if (this.origin.y >= this.contents.height) this.terminateMessage(); };
  scrollText.scrollSpeed = function() { return options.gameMessage().scrollSpeed() / 2 * (this.isFastForward() ? this.fastForwardRate() : 1); };
  scrollText.isFastForward = function() { return !options.gameMessage().scrollNoFast() && (Input.isPressed('ok') || Input.isPressed('shift') || options.touchInput().isPressed()); };
  scrollText.fastForwardRate = function() { return 3; };
  scrollText.terminateMessage = function() { this._text = null; options.gameMessage().clear(); this.hide(); };
  const choice = nativeWindows.Window_ChoiceList.prototype;
  const initializeChoice = choice.initialize;
  choice.initialize = function(messageWindow) { initializeChoice.call(this, messageWindow); this.openness = 0; this.deactivate(); this._background = 0; };
  choice.contentsHeight = function() { return this.maxItems() * this.itemHeight(); };
  choice.drawItem = function(index) { const rect = this.itemRectForText(index); this.drawTextEx(this.commandName(index), rect.x, rect.y); };
  choice.isCancelEnabled = function() { return options.gameMessage().choiceCancelType() !== -1; };
  choice.isOkTriggered = function() { return Input.isTriggered('ok'); };
  choice.callOkHandler = function() { options.gameMessage().onChoice(this.index()); this._messageWindow.terminateMessage(); this.close(); };
  choice.callCancelHandler = function() { options.gameMessage().onChoice(options.gameMessage().choiceCancelType()); this._messageWindow.terminateMessage(); this.close(); };
  choice.updatePlacement = function() {
    this.width = this.windowWidth(); this.height = this.windowHeight();
    const position = options.gameMessage().choicePositionType(), message = this._messageWindow;
    if (position === 0) this.x = 0;
    else if (position === 1) this.x = (Graphics.boxWidth - this.width) / 2;
    else if (position === 2) this.x = Graphics.boxWidth - this.width;
    this.y = message.y >= Graphics.boxHeight / 2 ? message.y - this.height : message.y + message.height;
  };
  choice.numVisibleRows = function() {
    const message = this._messageWindow, center = Graphics.boxHeight / 2;
    return Math.min(options.gameMessage().choices().length, message.y < center && message.y + message.height > center ? 4 : 8);
  };
  choice.windowHeight = function() { return this.fittingHeight(this.numVisibleRows()); };
  choice.textWidthEx = function(text) { return this.drawTextEx(text, 0, this.contents.height); };
  choice.maxChoiceWidth = function() { return Math.max(96, ...options.gameMessage().choices().map(text => this.textWidthEx(text) + this.textPadding() * 2)); };
  choice.windowWidth = function() { return Math.min(this.maxChoiceWidth() + this.padding * 2, Graphics.boxWidth); };
  choice.updateBackground = function() { this._background = options.gameMessage().choiceBackground(); this.setBackgroundType(this._background); };
  choice.selectDefault = function() { this.select(options.gameMessage().choiceDefaultType()); };
  choice.start = function() { this.updatePlacement(); this.updateBackground(); this.refresh(); this.selectDefault(); this.open(); this.activate(); };
  const numberInput = nativeWindows.Window_NumberInput.prototype;
  numberInput.maxCols = function() { return this._maxDigits; };
  numberInput.spacing = function() { return 0; };
  numberInput.itemWidth = function() { return 32; };
  numberInput.windowWidth = function() { return this.maxCols() * this.itemWidth() + this.padding * 2; };
  numberInput.windowHeight = function() { return this.fittingHeight(1); };
  numberInput.updatePlacement = function() {
    const message = this._messageWindow;
    this.width = this.windowWidth(); this.height = this.windowHeight(); this.x = (Graphics.boxWidth - this.width) / 2;
    this.y = message.y >= Graphics.boxHeight / 2 ? message.y - this.height - 8 : message.y + message.height + 8;
  };
  nativeWindows.Window_EventItem.prototype.updatePlacement = function() { this.y = this._messageWindow.y >= Graphics.boxHeight / 2 ? 0 : Graphics.boxHeight - this.height; };
  nativeWindows.Window_ItemList.prototype.makeItemList = function() {
    if (!options.databaseObject('items')) return options.windowModel(entry(this).handle, 'Window_ItemList', 'refreshModel', []);
    this._data = options.gameParty().allItems().filter(item => this.includes(item));
    if (this.includes(null)) this._data.push(null);
  };
  nativeWindows.Window_SkillList.prototype.makeItemList = function() {
    if (!options.databaseObject('skills')) return options.windowModel(entry(this).handle, 'Window_SkillList', 'refreshModel', []);
    this._data = this._actor ? this._actor.skills().filter(item => this.includes(item)) : [];
  };
  nativeWindows.Window_EventItem.prototype.includes = function(item) { return options.dataManager().isItem(item) && item.itypeId === options.gameMessage().itemChoiceItypeId(); };
  const eventItem = nativeWindows.Window_EventItem.prototype, initializeEventItem = eventItem.initialize;
  eventItem.initialize = function(messageWindow) {
    initializeEventItem.call(this, messageWindow); this.openness = 0; this.deactivate();
    this.setHandler('ok', this.onOk.bind(this)); this.setHandler('cancel', this.onCancel.bind(this));
  };
  eventItem.isEnabled = function() { return true; };
  eventItem.onOk = function() {
    const item = this.item(); options.gameVariables().setValue(options.gameMessage().itemChoiceVariableId(), item ? item.id : 0);
    this._messageWindow.terminateMessage(); this.close();
  };
  eventItem.onCancel = function() { options.gameVariables().setValue(options.gameMessage().itemChoiceVariableId(), 0); this._messageWindow.terminateMessage(); this.close(); };
  nativeWindows.Window_ItemList.prototype.includes = function(item) {
    const manager = options.dataManager();
    switch (this._category) {
      case 'item': return manager.isItem(item) && item.itypeId === 1;
      case 'keyItem': return manager.isItem(item) && item.itypeId === 2;
      case 'weapon': return manager.isWeapon(item);
      case 'armor': return manager.isArmor(item);
      default: return false;
    }
  };
  nativeWindows.Window_ItemList.prototype.isEnabled = function(item) { return options.gameParty().canUse(item); };
  nativeWindows.Window_ItemList.prototype.needsNumber = function() { return true; };
  nativeWindows.Window_SkillList.prototype.includes = function(item) { return item && item.stypeId === this._stypeId; };
  nativeWindows.Window_SkillList.prototype.isEnabled = function(item) { return this._actor && this._actor.canUse(item); };
  nativeWindows.Window_EquipItem.prototype.isEnabled = function() { return true; };
  nativeWindows.Window_ShopSell.prototype.isEnabled = function(item) { return item && item.price > 0; };
  nativeWindows.Window_EquipItem.prototype.includes = function(item) {
    if (item === null) return true;
    return !!(this._actor && item.etypeId === this._actor.equipSlots()[this._slotId] && this._actor.canEquip(item));
  };
  nativeWindows.Window_EquipSlot.prototype.maxItems = function() { return this._actor ? this._actor.equipSlots().length : 0; };
  nativeWindows.Window_EquipSlot.prototype.isEnabled = function(index) { return this._actor ? this._actor.isEquipChangeOk(index) : false; };
  nativeWindows.Window_EquipSlot.prototype.isCurrentItemEnabled = function() { return this.isEnabled(this.index()); };
  nativeWindows.Window_EquipSlot.prototype.drawItem = function(index) {
    if (!this._actor) return;
    const rect = this.itemRectForText(index);
    this.changeTextColor(this.systemColor()); this.changePaintOpacity(this.isEnabled(index));
    this.drawText(this.slotName(index), rect.x, rect.y, 138);
    this.drawItemName(this._actor.equips()[index], rect.x + 138, rect.y, rect.width - 138);
    this.changePaintOpacity(true);
  };
  nativeWindows.Window_EquipSlot.prototype.update = function() {
    Window_Selectable.prototype.update.call(this);
    if (this._itemWindow) this._itemWindow.setSlotId(this.index());
  };
  nativeWindows.Window_EquipSlot.prototype.item = function() { return this._actor ? this._actor.equips()[this.index()] : null; };
  nativeWindows.Window_EquipSlot.prototype.slotName = function(index) { return this._actor ? options.databaseObject('system').equipTypes[this._actor.equipSlots()[index]] : ''; };
  nativeWindows.Window_EquipItem.prototype.setStatusWindow = function(window) { this._statusWindow = window; this.callUpdateHelp(); };
  nativeWindows.Window_EquipSlot.prototype.setStatusWindow = function(window) { this._statusWindow = window; this.callUpdateHelp(); };
  nativeWindows.Window_EquipSlot.prototype.setItemWindow = function(window) { this._itemWindow = window; this.update(); };
  nativeWindows.Window_BattleActor.prototype.actor = function() { return options.gameParty().members()[this.index()]; };
  nativeWindows.Window_BattleEnemy.prototype.enemy = function() { return options.gameTroop().aliveMembers()[this.index()]; };
  const mapName = nativeWindows.Window_MapName.prototype, initializeMapName = mapName.initialize;
  mapName.initialize = function() {
    initializeMapName.call(this);
    this.opacity = 0; this.contentsOpacity = 0; this._showCount = 0; this.refresh();
  };
  mapName.update = function() {
    Window_Base.prototype.update.call(this);
    if (this._showCount > 0 && options.gameMap().isNameDisplayEnabled()) { this.updateFadeIn(); this._showCount--; }
    else this.updateFadeOut();
  };
  mapName.updateFadeIn = function() { this.contentsOpacity += 16; };
  mapName.updateFadeOut = function() { this.contentsOpacity -= 16; };
  mapName.open = function() { this.refresh(); this._showCount = 150; };
  mapName.close = function() { this._showCount = 0; };
  mapName.refresh = function() {
    this.contents.clear();
    const name = options.gameMap().displayName();
    if (name) {
      const width = this.contentsWidth(); this.drawBackground(0, 0, width, this.lineHeight());
      this.drawText(name, 0, 0, width, 'center');
    }
  };
  mapName.drawBackground = function(x, y, width, height) {
      var color1 = this.dimColor1();
      var color2 = this.dimColor2();
      this.contents.gradientFillRect(x, y, width / 2, height, color2, color1);
      this.contents.gradientFillRect(x + width / 2, y, width / 2, height, color1, color2);
  };
  nativeWindows.Window_SkillList.prototype.selectLast = function() {
    const skill = this._actor ? (options.gameParty().inBattle() ? this._actor.lastBattleSkill() : this._actor.lastMenuSkill()) : null;
    const index = this._data.indexOf(skill); this.select(index >= 0 ? index : 0);
  };
  nativeWindows.Window_Help.prototype.clear = function() { this.setText(''); };
  nativeWindows.Window_Help.prototype.setItem = function(item) { this.setText(item ? item.description : ''); };
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
  Scene_Base.prototype.createFadeSprite = function(white) {
      if (!this._fadeSprite) {
          this._fadeSprite = wrap(api.invoke(entry(this).handle, 'fadeSprite'));
          this.addChild(this._fadeSprite);
      }
      if (white) {
          this._fadeSprite.setWhite();
      } else {
          this._fadeSprite.setBlack();
      }
  };
  Scene_Base.prototype.startFadeIn = function(duration, white = false) { this.createFadeSprite(white); api.invoke(entry(this).handle, 'fadeSprite', entry(this._fadeSprite).handle); api.invoke(entry(this).handle, 'fade', false, duration, white); };
  Scene_Base.prototype.startFadeOut = function(duration, white = false) { this.createFadeSprite(white); api.invoke(entry(this).handle, 'fadeSprite', entry(this._fadeSprite).handle); api.invoke(entry(this).handle, 'fade', true, duration, white); };
  Scene_Base.prototype.fadeSpeed = function() { return 24; };
  Scene_Base.prototype.slowFadeSpeed = function() { return this.fadeSpeed() * 2; };
  Scene_Base.prototype.fadeOutAll = function() {
    options.fadeAudio(this.slowFadeSpeed() / 60);
    this.startFadeOut(this.slowFadeSpeed());
  };
  Scene_Base.prototype.createWindowLayer = function() {
    this._windowLayer = new WindowLayer();
    this._windowLayer.move((Graphics.width-Graphics.boxWidth)/2,(Graphics.height-Graphics.boxHeight)/2,Graphics.boxWidth,Graphics.boxHeight);
    this.addChild(this._windowLayer);
  };
  Scene_Base.prototype.checkGameover = function() { if (options.gameParty().isAllDead()) SceneManager.goto(Scene_Gameover); };
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
  Scene_MenuBase.prototype.createHelpWindow = function() { this._helpWindow = new nativeWindows.Window_Help(); this.addWindow(this._helpWindow); };
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
  Window_MenuCommand.initCommandPosition = function() { this._lastCommandSymbol = null; };
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
  Scene_File.prototype.savefileId = function() { return this._listWindow.index() + 1; };
  Scene_File.prototype.mode = function() { return null; };
  Scene_File.prototype.firstSavefileIndex = function() { return 0; };
  Scene_File.prototype.helpWindowText = function() { return ''; };
  Scene_File.prototype.createHelpWindow = function() {
    this._helpWindow = new nativeWindows.Window_Help(1); this._helpWindow.setText(this.helpWindowText()); this.addWindow(this._helpWindow);
  };
  Scene_File.prototype.activateListWindow = function() { this._listWindow.activate(); };
  function Scene_Load() { this.initialize.apply(this, arguments); }
  inherit(Scene_Load, Scene_File);
  Scene_Load.prototype.initialize = function() { Scene_File.prototype.initialize.call(this); this._loadSuccess = false; };
  Scene_Load.prototype.mode = function() { return 'load'; };
  Scene_Load.prototype.firstSavefileIndex = function() { return options.dataManager().latestSavefileId() - 1; };
  Scene_Load.prototype.helpWindowText = function() { return options.textManager().loadMessage; };
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
  Scene_Boot.prototype.loadSystemWindowImage = function() { ImageManager.reserveSystem('Window'); };
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
  Scene_Title.prototype.create = function() {
    Scene_Base.prototype.create.call(this);
    this.createBackground(); this.createForeground(); this.createWindowLayer(); this.createCommandWindow();
  };
  Scene_Title.prototype.start = function() {
    Scene_Base.prototype.start.call(this); SceneManager.clearStack();
    if (!sceneInfo.get(this)?.nativeRequested) options.openTitle?.();
    this.centerSprite(this._backSprite1); this.centerSprite(this._backSprite2);
    this.playTitleMusic(); this.startFadeIn(this.fadeSpeed(), false);
  };
  Scene_Title.prototype.update = function() {
    if (!this.isBusy()) this._commandWindow.open();
    Scene_Base.prototype.update.call(this);
  };
  Scene_Title.prototype.isBusy = function() { return this._commandWindow.isClosing() || Scene_Base.prototype.isBusy.call(this); };
  Scene_Title.prototype.playTitleMusic = function() {
    const audio = options.audioManager(); audio.playBgm(options.databaseObject('system').titleBgm); audio.stopBgs(); audio.stopMe();
  };
  function Scene_Map() { this.initialize.apply(this, arguments); }
  inherit(Scene_Map, Scene_Base);
  Scene_Map.prototype.initialize = function() {
    Scene_Base.prototype.initialize.call(this);
    this._waitCount = 0; this._encounterEffectDuration = 0;
    this._mapLoaded = false; this._touchCount = 0;
  };
  Scene_Map.prototype.create = function() {
    Scene_Base.prototype.create.call(this);
    this._transfer = options.gamePlayer().isTransferring();
    options.loadMap(this._transfer ? options.gamePlayer().newMapId() : options.gameMap().mapId());
  };
  Scene_Map.prototype.isReady = function() {
    if (!this._mapLoaded && options.isMapReady()) { this.onMapLoaded(); this._mapLoaded = true; }
    return this._mapLoaded && Scene_Base.prototype.isReady.call(this);
  };
  Scene_Map.prototype.onMapLoaded = function() {
    if (this._transfer) options.gamePlayer().performTransfer();
    this.createDisplayObjects();
  };
  Scene_Map.prototype.createDisplayObjects = function() {
    this.createSpriteset(); this.createMapNameWindow(); this.createWindowLayer(); this.createAllWindows();
  };
  Scene_Map.prototype.createSpriteset = function() {
    this._spriteset = new (options.sceneClass('Spriteset_Map'))();
    options.bindMapSpriteset(this._spriteset); this.addChild(this._spriteset);
  };
  Scene_Map.prototype.createMapNameWindow = function() { this._mapNameWindow = new (options.sceneClass('Window_MapName'))(); this.addChild(this._mapNameWindow); };
  Scene_Map.prototype.createAllWindows = function() { this.createMessageWindow(); this.createScrollTextWindow(); };
  Scene_Map.prototype.createMessageWindow = function() {
    this._messageWindow = new (options.sceneClass('Window_Message'))(); this.addWindow(this._messageWindow);
    this._messageWindow.subWindows().forEach(window => this.addWindow(window));
  };
  Scene_Map.prototype.createScrollTextWindow = function() { this._scrollTextWindow = new (options.sceneClass('Window_ScrollText'))(); this.addWindow(this._scrollTextWindow); };
  Scene_Map.prototype.processMapTouch = function() {
      if (options.touchInput().isTriggered() || this._touchCount > 0) {
          if (options.touchInput().isPressed()) {
              if (this._touchCount === 0 || this._touchCount >= 15) {
                  var x = options.gameMap().canvasToMapX(options.touchInput().x);
                  var y = options.gameMap().canvasToMapY(options.touchInput().y);
                  options.gameTemp().setDestination(x, y);
              }
              this._touchCount++;
          } else {
              this._touchCount = 0;
          }
      }
  };
  
  Scene_Map.prototype.updateEncounter = function() {
     if (options.gamePlayer().executeEncounter()) {
         SceneManager.push(options.sceneClass('Scene_Battle'));
     }
  };
  
  Scene_Map.prototype.updateCallMenu = function() {
      if (this.isMenuEnabled()) {
          if (this.isMenuCalled()) {
              this.menuCalling = true;
          }
          if (this.menuCalling && !options.gamePlayer().isMoving()) {
              this.callMenu();
          }
      } else {
          this.menuCalling = false;
      }
  };
  
  Scene_Map.prototype.callMenu = function() {
      options.soundManager().playOk();
      SceneManager.push(Scene_Menu);
      Window_MenuCommand.initCommandPosition();
      options.gameTemp().clearDestination();
      this._mapNameWindow.hide();
      this._waitCount = 2;
  };
  Scene_Map.prototype.updateDestination = function() { options.mapPhase('destination'); };
  Scene_Map.prototype.updateMain = function() { options.mapPhase('update'); };
  Scene_Map.prototype.updateMainMultiply = function() { this.updateMain(); if (this.isFastForward()) this.updateMain(); };
  Scene_Map.prototype.isFastForward = function() { return options.gameMap().isEventRunning() && !SceneManager.isSceneChanging() && (Input.isLongPressed('ok') || options.touchInput().isLongPressed()); };
  Scene_Map.prototype.isSceneChangeOk = function() { return this.isActive() && !options.gameMessage().isBusy(); };
  Scene_Map.prototype.isMenuEnabled = function() { return options.gameSystem().isMenuEnabled() && !options.gameMap().isEventRunning(); };
  Scene_Map.prototype.isMenuCalled = function() { return Input.isTriggered('menu') || options.touchInput().isCancelled(); };
  Scene_Map.prototype.updateScene = function() { options.mapPhase('sceneChange'); };
  Scene_Map.prototype.updateWaitCount = function() { if (this._waitCount > 0) { --this._waitCount; return true; } return false; };
  Scene_Map.prototype.update = function() {
    this.updateDestination(); this.updateMainMultiply();
    if (this.isSceneChangeOk()) this.updateScene();
    else if (SceneManager.isNextScene(options.sceneClass('Scene_Battle'))) this.updateEncounterEffect();
    this.updateWaitCount(); Scene_Base.prototype.update.call(this);
  };
  Scene_Map.prototype.needsFadeIn = function() { return SceneManager.isPreviousScene(options.sceneClass('Scene_Battle')) || SceneManager.isPreviousScene(options.sceneClass('Scene_Load')); };
  Scene_Map.prototype.fadeInForTransfer = function() {
    const fade = options.gamePlayer().fadeType(); if (fade === 0 || fade === 1) this.startFadeIn(this.fadeSpeed(), fade === 1);
  };
  function Scene_Equip() { this.initialize.apply(this, arguments); }
  inherit(Scene_Equip, Scene_MenuBase);
  Scene_Equip.prototype.create = function() {
      Scene_MenuBase.prototype.create.call(this);
      this.createHelpWindow();
      this.createStatusWindow();
      this.createCommandWindow();
      this.createSlotWindow();
      this.createItemWindow();
      this.refreshActor();
  };
  Scene_Equip.prototype.createStatusWindow = function() {
      this._statusWindow = new (options.sceneClass('Window_EquipStatus'))(0, this._helpWindow.height);
      this.addWindow(this._statusWindow);
  };
  Scene_Equip.prototype.createCommandWindow = function() {
      const wx = this._statusWindow.width;
      const wy = this._helpWindow.height;
      const ww = Graphics.boxWidth - this._statusWindow.width;
      this._commandWindow = new (options.sceneClass('Window_EquipCommand'))(wx, wy, ww);
      this._commandWindow.setHelpWindow(this._helpWindow);
      this._commandWindow.setHandler('equip',    this.commandEquip.bind(this));
      this._commandWindow.setHandler('optimize', this.commandOptimize.bind(this));
      this._commandWindow.setHandler('clear',    this.commandClear.bind(this));
      this._commandWindow.setHandler('cancel',   this.popScene.bind(this));
      this._commandWindow.setHandler('pagedown', this.nextActor.bind(this));
      this._commandWindow.setHandler('pageup',   this.previousActor.bind(this));
      this.addWindow(this._commandWindow);
  };
  Scene_Equip.prototype.createSlotWindow = function() {
      const wx = this._statusWindow.width;
      const wy = this._commandWindow.y + this._commandWindow.height;
      const ww = Graphics.boxWidth - this._statusWindow.width;
      const wh = this._statusWindow.height - this._commandWindow.height;
      this._slotWindow = new (options.sceneClass('Window_EquipSlot'))(wx, wy, ww, wh);
      this._slotWindow.setHelpWindow(this._helpWindow);
      this._slotWindow.setStatusWindow(this._statusWindow);
      this._slotWindow.setHandler('ok',       this.onSlotOk.bind(this));
      this._slotWindow.setHandler('cancel',   this.onSlotCancel.bind(this));
      this.addWindow(this._slotWindow);
  };
  Scene_Equip.prototype.createItemWindow = function() {
      const wx = 0;
      const wy = this._statusWindow.y + this._statusWindow.height;
      const ww = Graphics.boxWidth;
      const wh = Graphics.boxHeight - wy;
      this._itemWindow = new (options.sceneClass('Window_EquipItem'))(wx, wy, ww, wh);
      this._itemWindow.setHelpWindow(this._helpWindow);
      this._itemWindow.setStatusWindow(this._statusWindow);
      this._itemWindow.setHandler('ok',     this.onItemOk.bind(this));
      this._itemWindow.setHandler('cancel', this.onItemCancel.bind(this));
      this._slotWindow.setItemWindow(this._itemWindow);
      this.addWindow(this._itemWindow);
  };
  Scene_Equip.prototype.refreshActor = function() {
      const actor = this.actor();
      this._statusWindow.setActor(actor);
      this._slotWindow.setActor(actor);
      this._itemWindow.setActor(actor);
  };
  Scene_Equip.prototype.commandEquip = function() {
      this._slotWindow.activate();
      this._slotWindow.select(0);
  };
  Scene_Equip.prototype.commandOptimize = function() {
      options.soundManager().playEquip();
      this.actor().optimizeEquipments();
      this._statusWindow.refresh();
      this._slotWindow.refresh();
      this._commandWindow.activate();
  };
  Scene_Equip.prototype.commandClear = function() {
      options.soundManager().playEquip();
      this.actor().clearEquipments();
      this._statusWindow.refresh();
      this._slotWindow.refresh();
      this._commandWindow.activate();
  };
  Scene_Equip.prototype.onSlotOk = function() {
      this._itemWindow.activate();
      this._itemWindow.select(0);
  };
  Scene_Equip.prototype.onSlotCancel = function() {
      this._slotWindow.deselect();
      this._commandWindow.activate();
  };
  Scene_Equip.prototype.onItemOk = function() {
      options.soundManager().playEquip();
      this.actor().changeEquip(this._slotWindow.index(), this._itemWindow.item());
      this._slotWindow.activate();
      this._slotWindow.refresh();
      this._itemWindow.deselect();
      this._itemWindow.refresh();
      this._statusWindow.refresh();
  };
  Scene_Equip.prototype.onItemCancel = function() {
      this._slotWindow.activate();
      this._itemWindow.deselect();
  };
  Scene_Equip.prototype.onActorChange = function() {
      this.refreshActor();
      this._commandWindow.activate();
  };
  function Scene_Status() { this.initialize.apply(this, arguments); }
  inherit(Scene_Status, Scene_MenuBase);
  function Scene_Save() { this.initialize.apply(this, arguments); }
  inherit(Scene_Save, Scene_File);
  Scene_Save.prototype.mode = function() { return 'save'; };
  Scene_Save.prototype.firstSavefileIndex = function() { return options.dataManager().lastAccessedSavefileId() - 1; };
  Scene_Save.prototype.helpWindowText = function() { return options.textManager().saveMessage; };
  function Scene_Shop() { this.initialize.apply(this, arguments); }
  inherit(Scene_Shop, Scene_MenuBase);
  Scene_Shop.prototype.buyingPrice = function() { return this._buyWindow.price(this._item); };
  Scene_Shop.prototype.sellingPrice = function() { return Math.floor(this._item.price / 2); };
  Scene_Shop.prototype.doBuy = function(number) { options.gameParty().loseGold(number * this.buyingPrice()); options.gameParty().gainItem(this._item, number); };
  Scene_Shop.prototype.doSell = function(number) { options.gameParty().gainGold(number * this.sellingPrice()); options.gameParty().loseItem(this._item, number); };

  function Scene_Name() { this.initialize.apply(this, arguments); }
  inherit(Scene_Name, Scene_MenuBase);
  function Scene_Debug() { this.initialize.apply(this, arguments); }
  inherit(Scene_Debug, Scene_MenuBase);
  Scene_Map.prototype.start = function() {
    Scene_Base.prototype.start.call(this); SceneManager.clearStack();
    if (this._transfer) { this.fadeInForTransfer(); this._mapNameWindow.open(); options.gameMap().autoplay(); }
    else if (this.needsFadeIn()) this.startFadeIn(this.fadeSpeed(), false);
    this.menuCalling = false;
  };
  Scene_Map.prototype.launchBattle = function() {
    this.stopAudioOnBattleStart(); options.sceneClass('SoundManager').playBattleStart();
    this.startEncounterEffect(); this._mapNameWindow.hide();
  };
  Scene_Map.prototype.stopAudioOnBattleStart = function() {
    options.audioManager().stopBgs(); options.audioManager().stopMe(); options.audioManager().stopSe();
  };
  Scene_Map.prototype.startEncounterEffect = function() {
    this._spriteset.hideCharacters(); this._encounterEffectDuration = this.encounterEffectSpeed();
  };
  Scene_Map.prototype.encounterEffectSpeed = function() { return 60; };
  Scene_Map.prototype.snapForBattleBackground = function() {
    this._windowLayer.visible = false;
    try { SceneManager.snapForBackground(); } finally { this._windowLayer.visible = true; }
  };
  Scene_Map.prototype.startFlashForEncounter = function(duration) { options.gameScreen().startFlash([255, 255, 255, 255], duration); };
  Scene_Map.prototype.updateEncounterEffect = function() {
    if (this._encounterEffectDuration <= 0) return;
    --this._encounterEffectDuration;
    const speed = this.encounterEffectSpeed(), elapsed = speed - this._encounterEffectDuration, progress = elapsed / speed;
    const x = options.gamePlayer().screenX(), y = options.gamePlayer().screenY() - 24;
    if (elapsed === 2) { options.gameScreen().setZoom(x, y, 1); this.snapForBattleBackground(); this.startFlashForEncounter(speed / 2); }
    options.gameScreen().setZoom(x, y, ((progress - 1) * 20 * progress + 5) * progress + 1);
    if (elapsed === Math.floor(speed / 6)) this.startFlashForEncounter(speed / 2);
    if (elapsed === Math.floor(speed / 2)) { options.battleManager().playBattleBgm(); this.startFadeOut(this.fadeSpeed()); }
    if (this._encounterEffectDuration === 0) options.gameScreen().clearZoom();
  };
  Scene_Map.prototype.needsSlowFadeOut = function() { return SceneManager.isNextScene(options.sceneClass('Scene_Title')) || SceneManager.isNextScene(options.sceneClass('Scene_Gameover')); };
  Scene_Map.prototype.stop = function() {
    Scene_Base.prototype.stop.call(this); options.gamePlayer().straighten(); this._mapNameWindow.close();
    if (this.needsSlowFadeOut()) this.startFadeOut(this.slowFadeSpeed(), false);
    else if (SceneManager.isNextScene(options.sceneClass('Scene_Map'))) this.fadeOutForTransfer();
    else if (SceneManager.isNextScene(options.sceneClass('Scene_Battle'))) this.launchBattle();
  };
  Scene_Map.prototype.fadeOutForTransfer = function() { const fade = options.gamePlayer().fadeType(); if (fade === 0 || fade === 1) this.startFadeOut(this.fadeSpeed(), fade === 1); };
  Scene_Map.prototype.isBusy = function() { return Boolean(this._messageWindow?.isClosing() || this._waitCount > 0 || this._encounterEffectDuration > 0 || Scene_Base.prototype.isBusy.call(this)); };
  Scene_Map.prototype.terminate = function() {
    Scene_Base.prototype.terminate.call(this);
    if (!SceneManager.isNextScene(options.sceneClass('Scene_Battle'))) { this._spriteset.update(); this._mapNameWindow.hide(); SceneManager.snapForBackground(); }
    else ImageManager.clearRequest();
    if (SceneManager.isNextScene(options.sceneClass('Scene_Map'))) ImageManager.clearRequest();
    options.gameScreen().clearZoom();
    for (const child of [this._fadeSprite, this._mapNameWindow, this._windowLayer, this._spriteset]) if (child) this.removeChild(child);
  };
  installBattleScene({ Scene_Battle, Scene_Base, SceneManager, Graphics }, options);
  installSceneCommands({ Scene_Title, Scene_Menu, Scene_ItemBase, Scene_Item, Scene_Skill, Scene_Map, Scene_Load, Scene_Options, SceneManager, Sprite, Bitmap, Graphics, ImageManager }, options);
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
    return kind > 0 && (sceneInfo.get(scene)?.nativeRequested || scene.constructor === sceneClass(kind) || scene instanceof Scene_Map);
  }
  function usesNativeInput(object) {
    const message = SceneManager._scene?._messageWindow;
    if (message && scriptMessages() && (object === message || message.subWindows().includes(object))) return false;
    while (object.parent) object = object.parent;
    return object === SceneManager._scene && nativeDriven(object);
  }
  function scriptMessages() {
    const scene = SceneManager._scene, window = scene?._messageWindow;
    if (!(scene instanceof Scene_Map) || !window || options.gameMessage().scrollMode()) return false;
    return !!window._textState || window.openness > 0 || nativeMessageMethods.some(([name, original]) => window[name] !== original);
  }
  function prepareScene(scene) {
    const kind = kindOf(scene);
    if (scene) sceneInfo.set(scene, { kind, nativeRequested: requestedKind !== null });
    if (!(acceptingNative && kind === requestedKind) && (kind >= 0 || (requestedKind !== null && requestedKind >= 0)))
      options.sceneControl?.('prepare', kind >= 0 ? kind : requestedKind);
  }
  Bitmap.snap = stage => { updateFilters(stage); return snapBitmap(Bitmap, entry(stage).handle); };
  function Graphics() { throw new Error('Graphics is a static class'); }
  Object.defineProperties(Graphics, Object.getOwnPropertyDescriptors({
    get frameCount() { return api.scene(runtime, 'frameCount'); },
    set frameCount(value) { api.scene(runtime,'frameCount',Number(value)); }
  }));
  for (const field of ['width', 'height', 'boxWidth', 'boxHeight']) {
    Object.defineProperty(Graphics, '_' + field, { configurable: true,
      get() { return options.coreService('graphicsDimension', field); },
      set(value) {
        options.coreService('graphicsDimension', field, Number(value));
        if (!field.startsWith('box')) options.screenSize?.(this._width,this._height);
      }
    });
    Object.defineProperty(Graphics, field, { configurable: true,
      get() { return this['_' + field]; },
      set(value) {
        if (field.startsWith('box')) this['_' + field] = value;
        else if (this['_' + field] !== value) { this['_' + field] = value; this._updateAllElements(); }
      }
    });
  }
  for (const [name,field] of [['_scale','scale'],['_realScale','realScale'],['_stretchEnabled','stretchEnabled'],['_videoVolume','videoVolume']])
    Object.defineProperty(Graphics,name,{configurable:true,get() {return options.coreService('graphicsState',field);},
      set(value) {options.coreService('graphicsState',field,field==='stretchEnabled'?Boolean(value):Number(value));}});
  Object.defineProperty(Graphics,'scale',{configurable:true,get() {return this._scale;},
    set(value) {if(this._scale!==value) {this._scale=value;this._updateAllElements();}}});
  Graphics._updateRealScale=function() {options.coreService('updateGraphicsScale');};
  Graphics._createAllElements=function() { this._updateAllElements(); };
  Graphics._updateAllElements=function() {this._updateRealScale();options.coreService('updateGraphicsElements');};
  Graphics.initialize = function(width,height) {
    const result=options.coreService('initializeGraphics',width || 800,height || 600);
    options.screenSize?.(this.width,this.height);return result;
  };
  Object.assign(Graphics, { BLEND_NORMAL: 0, BLEND_ADD: 1, BLEND_MULTIPLY: 2, BLEND_SCREEN: 3 });
  Graphics._rendererType = 'native'; Graphics._skipCount = 0; Graphics._maxSkip = 3;
  objectRenderer=createObjectRenderer({
    graphicsInfo() { return native.render.graphicsInfo(); },
    draw(object,vertices) {const own=entry(object);own.prepareRender?.();api.invoke(own.handle,'renderSprite',...(vertices?Array.from(vertices):[]));},
    isTiling(object) {return entry(object).handle.kind==='tiling';},
    clear() {native.render.clearScene(0,0,0,1);},update:updateFilters,
    submit(stage) {options.submitStage(entry(stage).handle);},dimension(field) {return Graphics[field];}
  });
  Graphics._renderer=objectRenderer.renderer;
  Graphics.render = function(stage) { if (stage) this._renderer.render(stage); };
  for (const method of ['startLoading','endLoading','updateLoading','isVideoPlaying','tickStart','tickEnd','playVideo','canPlayVideoType','setVideoVolume','pageToCanvasX','pageToCanvasY','isInsideCanvas','isWebGL','hasWebGL','canUseDifferenceBlend','canUseSaturationBlend','setLoadingImage','printLoadingError','eraseLoadingError','callGC','showFps','hideFps'])
    Graphics[method] = (...args) => options.coreService(method,...args);
  Graphics.pageToCanvasX=x=>options.coreService('pageToCanvasX',Number(x));
  Graphics.pageToCanvasY=y=>options.coreService('pageToCanvasY',Number(y));
  Graphics.isInsideCanvas=(x,y)=>options.coreService('isInsideCanvas',Number(x),Number(y));
  Graphics.printError = function(name,message) { console.error(message?.stack || message); options.coreService('printError',String(name),String(message)); };
  Graphics._clearUpperCanvas = function() {
    if (this._upperCanvas) this._upperCanvas.getContext('2d').clearRect(0, 0, this.width, this.height);
    options.coreService('clearUpperCanvas');
  };
  Graphics._centerElement = function(element) {
    Object.assign(element.style, { position: 'absolute', margin: 'auto', top: 0, left: 0, right: 0, bottom: 0,
      width: element.width * this._realScale + 'px', height: element.height * this._realScale + 'px' });
  };
  Graphics._updateErrorPrinter = function() {
    if (!this._errorPrinter) this._errorPrinter = { style: {} };
    this._errorPrinter.width = this._width * 0.9; this._errorPrinter.height = 40;
    Object.assign(this._errorPrinter.style, { textAlign: 'center', textShadow: '1px 1px 3px #000', fontSize: '20px', zIndex: 99 });
    this._centerElement(this._errorPrinter);
  };
  Graphics._applyCanvasFilter = function() {
    if (this._canvas) Object.assign(this._canvas.style, { opacity: 0.5, filter: 'blur(8px)', webkitFilter: 'blur(8px)' });
  };
  Graphics._onVideoEnd = function() {
    if (this._video) this._video.style.opacity = 0;
    if (this._canvas) this._canvas.style.opacity = 1;
    options.coreService('videoEnded');
  };
  Graphics._switchFPSMeter = function() { options.coreService('switchFPSMeter'); };
  Graphics.loadFont = (family, source) => Bitmap.loadFont(family, String(source).replace(/^\/game\//, ''));
  Graphics.isFontLoaded = family => options.coreService('isFontLoaded', family);
  Graphics._isFullScreen = () => native.runtime.isFullscreen();
  Graphics._requestFullScreen = () => native.runtime.setFullscreen(true);
  Graphics._cancelFullScreen = () => native.runtime.setFullscreen(false);
  const Input = options.runScript('(function Input() { throw new Error("This is a static class"); })');
  for (const method of ['clear', 'update', 'isPressed', 'isTriggered', 'isRepeated', 'isLongPressed'])
    Input[method] = (...args) => api.input(runtime, method, ...args);
  for (const field of ['dir4', 'dir8', 'date']) Object.defineProperty(Input, field, { get() { return api.input(runtime, field); } });
  for (const field of ['keyRepeatWait', 'keyRepeatInterval']) Object.defineProperty(Input, field, {
    configurable: true, enumerable: true,
    get() { return api.input(runtime, field); },
    set(value) { api.input(runtime, field, Number(value)); }
  });
  for (const field of ['_pressedTime', '_preferredAxis', '_dir4', '_dir8','_date']) Object.defineProperty(Input, field, {
    configurable: true, get() { return api.input(runtime, field); }, set(value) { api.input(runtime, field, value); }
  });
  Object.defineProperty(Input, '_latestButton', { configurable: true, get() { return api.input(runtime, '_latestButton'); }, set(value) { api.input(runtime, '_latestButton', value); } });
  const inputState = installInputState(Input, (name, ...args) => api.input(runtime, name, ...args),
    () => options.runScript('({})'), () => options.createArray ? options.createArray() : []);
  const clearInput = Input.clear;
  Input.clear = function() { clearInput(); inputState.reset(); };
  Input._isEscapeCompatible = function(name) { return name === 'cancel' || name === 'menu'; };
  Input._shouldPreventDefault = function(code) { return [8, 33, 34, 37, 38, 39, 40].includes(code); };
  Input._onKeyDown = function(event) {
    if (this._shouldPreventDefault(event.keyCode)) event.preventDefault?.();
    if (event.keyCode === 144) this.clear();
    const name = this.keyMapper[event.keyCode], resources = options.resourceHandler?.();
    if (resources?.exists() && name === 'ok') resources.retry();
    else if (name) this._currentState[name] = true;
  };
  Input._onKeyUp = function(event) { if (this.keyMapper[event.keyCode]) this._currentState[this.keyMapper[event.keyCode]] = false; if (event.keyCode === 0) this.clear(); };
  Input._onLostFocus = function() { this.clear(); };
  Input._pollGamepads = function() {
    for (const pad of options.gamepads?.() || []) if (pad?.connected) this._updateGamepadState(pad);
  };
  Input._updateGamepadState = function(pad) { inputState.push(); api.input(runtime, 'updateGamepad', pad); inputState.pull(pad.index); };
  Input._signX = function() { return Number(this.isPressed('right')) - Number(this.isPressed('left')); };
  Input._signY = function() { return Number(this.isPressed('down')) - Number(this.isPressed('up')); };
  Input._makeNumpadDirection = function(x,y) { return x || y ? 5-y*3+x : 0; };
  const directionHooks=new Map(['_signX','_signY','_makeNumpadDirection'].map(name=>[name,Input[name]]));
  let nativeIsPressed;
  Input._updateDirection = function() {
    if (this.isPressed === nativeIsPressed && [...directionHooks].every(([name,method])=>this[name]===method)) { inputState.push(); return api.input(runtime, 'updateDirection'); }
    let x = this._signX(), y = this._signY();
    this._dir8 = this._makeNumpadDirection(x,y);
    if (x && y) { if (this._preferredAxis === 'x') y = 0; else x = 0; }
    else if (x) this._preferredAxis = 'y'; else if (y) this._preferredAxis = 'x';
    this._dir4 = this._makeNumpadDirection(x,y);
  };
  const inputHooks = new Map(['_onKeyDown', '_onKeyUp', '_onLostFocus', '_pollGamepads', '_updateGamepadState', '_updateDirection', '_shouldPreventDefault', '_isEscapeCompatible',...directionHooks.keys()].map(name => [name, Input[name]]));
  Input.update = function() {
    const now=options.date?options.date():Date.now();
    inputState.push();
    for (const event of api.input(runtime, 'events')) {
      if (event.type === 'blur') this._onLostFocus();
      else if (event.type === 'keydown') this._onKeyDown(event);
      else this._onKeyUp(event);
    }
    this._pollGamepads(); inputState.push(); api.input(runtime, 'advance',now); inputState.pull(); this._updateDirection();
  };
  for (const method of ['isPressed', 'isTriggered', 'isRepeated', 'isLongPressed']) {
    const base = Input[method];
    Input[method] = function(name) {
      if (method === 'isPressed') return Boolean((this._isEscapeCompatible(name) && this.isPressed('escape')) || this._currentState[name]);
      if (this._isEscapeCompatible === inputHooks.get('_isEscapeCompatible')) return base(name);
      if (this._isEscapeCompatible(name) && this[method]('escape')) return true;
      if (method === 'isPressed') return !!this._currentState[name];
      if (this._latestButton !== name) return false;
      if (method === 'isTriggered') return this._pressedTime === 0;
      if (method === 'isLongPressed') return this._pressedTime >= this.keyRepeatWait;
      return this._pressedTime === 0 || (this._pressedTime >= this.keyRepeatWait && this._pressedTime % this.keyRepeatInterval === 0);
    };
  }
  nativeIsPressed = Input.isPressed;
  inputHooks.set('isPressed', Input.isPressed); inputHooks.set('clear', Input.clear);
  function dispatch(handle, method) {
    if (method === 'transitionBusy') return SceneManager.isCurrentSceneBusy();
    const scene = wrap(handle);
    if (method === 'create') options.sceneControl?.('commit', sceneInfo.get(scene)?.kind ?? kindOf(scene));
    const fn = scene[method];
    if (typeof fn !== 'function') throw new TypeError('Scene.' + method + ' is not callable');
    const result = fn.call(scene);
    if (method === 'create') SceneManager.onSceneCreate();
    if (method === 'start') { SceneManager._sceneStarted = true; SceneManager.onSceneStart(); }
    if (method === 'isReady' && !result) SceneManager.onSceneLoading();
    return result;
  }
  installWindowTouch(Window_Selectable, options, usesNativeInput);
  installMessageWindow({ Window_Message, Window_Base, ImageManager, Input }, { ...options,
    scriptMessageOwned(window) { return SceneManager._scene?._messageWindow === window && scriptMessages(); }
  });
  const nativeMessageMethods = ['update', 'startMessage', 'newPage', 'convertEscapeCharacters', 'processEscapeCharacter', 'processNormalCharacter', 'drawMessageFace']
    .map(name => [name, Window_Message.prototype[name]]);
  installBattleLog({ Window_BattleLog: nativeWindows.Window_BattleLog, Window_Base, Bitmap, Sprite, Graphics, Input }, options);
  function SceneManager() { throw new Error('SceneManager is a static class'); }
  Object.defineProperties(SceneManager, Object.getOwnPropertyDescriptors({
    run(type) { try { this.initialize(); this.goto(type); this.requestUpdate(); } catch (error) { this.catchException(error); } },
    initialize() { this.ticker ||= options.createTicker?.(); this.initGraphics(); this.checkFileAccess(); this.initAudio(); this.initInput(); this.initNwjs(); this.checkPluginErrors(); this.setupErrorHandlers(); },
    initGraphics() {
      const graphics = options.graphics?.() || Graphics;
      graphics.initialize(this._screenWidth, this._screenHeight, this.preferableRendererType());
      graphics.boxWidth = this._boxWidth; graphics.boxHeight = this._boxHeight;
      graphics.setLoadingImage('img/system/Loading.png');
      if (this.preferableRendererType() === 'webgl') this.checkWebGL();
    },
    preferableRendererType() { return options.utils?.().isOptionValid('canvas') ? 'canvas' : options.utils?.().isOptionValid('webgl') ? 'webgl' : 'auto'; },
    shouldUseCanvasRenderer() { return Boolean(options.utils?.().isMobileDevice()); },
    checkFileAccess() { if (options.utils && !options.utils().canReadGameFiles()) throw new Error('Local game files are unavailable'); },
    checkWebGL() { if (!Graphics.hasWebGL()) throw new Error('WebGL is unavailable'); },
    initNwjs() { this._nativeWindow = native.runtime; },
    setupErrorHandlers() {
      if (this._errorHandlers) return;
      const target = options.eventTarget?.();
      if (target?.addEventListener) { target.addEventListener('error', this.onError.bind(this)); target.addEventListener('keydown', this.onKeyDown.bind(this)); this._errorHandlers = true; }
    },
    requestUpdate() { this._updateRequested = !this._stopped; },
    tickStart() { Graphics.tickStart(); }, tickEnd() { Graphics.tickEnd(); },
    _getTimeInMsWithoutMobileSafari() { return options.now?.() ?? Date.now(); },
    onError(event) { this.catchException(event.error || new Error(event.message)); },
    onKeyDown(event) { if (!event.ctrlKey && !event.altKey && event.keyCode === 116) options.reload?.(); },
    initAudio() { options.webAudio().initialize(); },
    initInput() { Input.initialize(); options.touchInput().initialize(); },
    checkPluginErrors() { options.checkPluginErrors(); },
    goto(type) {
      pendingNative = null;
      hasRun = true;
      const next = type ? new type() : null;
      if (next && !(next instanceof Scene_Base)) throw new TypeError('Scene transition requires Scene_Base');
      nextRoot = next;
      prepareScene(next);
      api.scene(runtime, 'goto', next ? entry(next).handle : null, dispatch);
    },
    update(deltaTime = 1) {
      if (this._stopped) return;
      try { this.tickStart(); this.updateManagers(); this.updateMain(); this.renderScene(); this.tickEnd(); this.requestUpdate(); }
      catch (error) { this.catchException(error); }
    },
    updateManagers() { ImageManager.update(); },
    updateInputData() { Input.update(); options.updateTouch?.(); },
    updateMain() { this.updateInputData(); this.changeScene(); this.updateScene(); },
    changeScene() {
      if (pendingNative && !api.scene(runtime, 'stopped')) {
        const request = pendingNative;
        pendingNative = null;
        if (request.newGame) { this.clearStack(); options.dataManager().setupNewGame(); }
        requestedKind = request.kind; acceptingNative = true;
        try { this.goto(request.type); }
        finally { requestedKind = null; acceptingNative = false; }
        if (!api.scene(runtime, 'changing')) options.sceneControl?.('commit', sceneInfo.get(this._scene)?.kind ?? kindOf(this._scene));
      }
      const previousScene = this._scene;
      if (api.scene(runtime, 'changing') && previousScene && !this.isCurrentSceneBusy()) this._previousClass = previousScene.constructor;
      api.scene(runtime,'change',dispatch);
      currentRoot = wrap(api.scene(runtime, 'current')); nextRoot = wrap(api.scene(runtime, 'next'));
      if (!currentRoot && !nextRoot) { options.sceneControl?.('commit', -1); if (this._exiting) this.terminate(); }
    },
    updateScene() {
      api.scene(runtime,'updateScene',dispatch);
      currentRoot = wrap(api.scene(runtime, 'current')); nextRoot = wrap(api.scene(runtime, 'next'));
      if (!currentRoot && !nextRoot) options.sceneControl?.('commit', -1);
      for (const [id, reference] of registry) if (!reference.deref()) registry.delete(id);
    },
    isPreviousScene(type) { return this._previousClass === type; },
    renderScene() {
      if (nativeDriven(this._scene) && !(this._scene instanceof Scene_Map)) { options.submitStage(null); return; }
      if (this._scene instanceof Scene_Map && !this.isCurrentSceneStarted()) { options.submitStage(entry(this._scene).handle); return; }
      if (this._scene && this.isCurrentSceneStarted()) (options.graphics?.() || Graphics).render(this._scene);
    },
    onSceneCreate() { Graphics.startLoading(); },
    onSceneStart() { Graphics.endLoading(); },
    onSceneLoading() { Graphics.updateLoading(); },
    catchException(error) { options.coreService('printError', error.name || 'Error', error.message || String(error)); options.audioManager()?.stopAll(); this.stop(); },
    exit() { this.goto(null); this._exiting = true; },
    terminate() { options.sceneControl?.('exit'); },
    snap() { return Bitmap.snap(this._scene); },
    snapForBackground() { this._backgroundBitmap = this.snap(); this._backgroundBitmap.blur(); },
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
    stop() { api.scene(runtime, 'stopped', true); }, resume() { api.scene(runtime, 'stopped', false); this.requestUpdate(); this._currentTime = this._getTimeInMsWithoutMobileSafari(); this._accumulator = 0; },
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
      if (!this._stack.length) { this.exit(); return; }
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
  windowLayerParts=installWindowLayer(options.runScript,WindowLayer,{
    rectangle(object) {return api.invoke(entry(object).handle,'windowLayerMask');},
    hook(object,callback) {
      const own=entry(object);own.windowMask=callback?handle=>callback(wrap(handle)):null;
      api.invoke(own.handle,'windowLayerMask',own.windowMask);
    },
    mask() {
      const Type=options.graphicsClass?.();
      if(Type) {const mask=new Type();mask.beginFill(0xffffff,1);mask.drawRect(0,0,0,0);mask.endFill();return mask;}
      const rectangle=options.rectangle();
      return {graphicsData:[{shape:rectangle}],getBounds() {return rectangle;}};
    }
  });
  windowParts = installWindowParts(options.runScript, { Window, Sprite, Bitmap }, {
    spriteHooksActive() {return spriteRenderHooks.overridden();},
    bitmapHooksActive() {return bitmapDrawingOverrides(Bitmap);},
    setCursor(object, rectangle) { api.invoke(entry(object).handle, 'cursor', ...rectangle); },
    setWindowskin(object, bitmap) {
      api.invoke(entry(object).handle, 'windowskin', bitmap == null ? null : bitmapHandle(Bitmap, bitmap));
      entry(object).bitmaps.set('windowskin', bitmap);
    },
    activate(object) { api.invoke(entry(object).handle, 'windowCustomParts'); },
    refresh(object) { api.invoke(entry(object).handle, 'refreshWindow'); },
    opacity(object, name) { return api.field(entry(object).handle, name); },
    tone(object) { return api.invoke(entry(object).handle, 'windowTone'); },
    setTone(object, value) { api.invoke(entry(object).handle, 'windowTone', ...value); },
    cursor(object) { return api.invoke(entry(object).handle, 'cursorRect'); }
  });
  Object.assign(SceneManager, { _screenWidth: Graphics.width, _screenHeight: Graphics.height, _boxWidth: Graphics.boxWidth, _boxHeight: Graphics.boxHeight,
    _deltaTime: 1 / 60, _currentTime: 0, _accumulator: 0, _exiting: false, _previousClass: null, _backgroundBitmap: null });
  return { scriptMessages, bitmapFromSource, transformTexture(source, destination, x,y,width,height,rotation) { native.canvas.copyTransformedPixels(destination._canvas._ensureNativeCanvas().handle,source._canvas._ensureNativeCanvas().handle,x,y,width,height,rotation);destination._canvas._pmjsContentChanged(); }, setSpriteTexture(object, bitmap, frame, resolution=1) { api.invoke(entry(object).handle,'spriteTexture',bitmap ? bitmapHandle(Bitmap,bitmap) : null,...(frame ? [frame.x,frame.y,frame.width,frame.height,resolution] : [])); }, updateFilters, ...nativeWindows, Container, Stage, Sprite, Sprite_Button, Sprite_Base, Sprite_Animation, TilingSprite, ScreenSprite, ToneSprite, Window, WindowLayer, Window_Base, Window_Selectable, Window_Command, Window_MenuCommand, Window_Options, Window_Message,
    Scene_Base, Scene_Battle, Scene_MenuBase, Scene_Menu, Scene_Options, Scene_Gameover, Scene_GameEnd, Scene_File, Scene_Load, Scene_Save, Scene_Equip, Scene_Status, Scene_Shop, Scene_Name, Scene_Debug, Scene_ItemBase, Scene_Item, Scene_Skill, Scene_Boot, Scene_Title, Scene_Map, SceneManager, Graphics, Input,
    GlitchFilter,
    prepareNativeRequest() {
      if (pendingNative?.newGame) {
        pendingNative.newGame = false;
        SceneManager.clearStack(); options.dataManager().setupNewGame();
      }
    },
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
      pendingNative = { type, kind, newGame: method === 'newGame' };
      if (state) options.sceneControl?.('restore', state);
      else if (kind >= 0) options.sceneControl?.('prepare', kind);
      return true;
    },
    prepareDisplay(object, prepare) { const own = entry(object); own.prepareRender = prepare; api.invoke(own.handle, 'displayPrepare', prepare); },
    tilemapBitmaps(object) { return api.invoke(entry(object).handle,'tilemapBitmaps').map(handle=>wrapBitmapHandle(Bitmap,handle)); },
    tilemapField(object,field,...value) {return api.field(entry(object).handle,field,...value);},
    tilemapState(object) {
      api.invoke(entry(object).handle,'tilemapState',object._tileWidth,object._tileHeight,object._mapWidth,object._mapHeight,
        object._mapData,object.flags,object.horizontalWrap,object.verticalWrap,object.bitmaps.map(bitmap=>bitmap?bitmapHandle(Bitmap,bitmap):null));
    },
    displayListField(handle, field, ...assigned) {
      let fields = displayLists.get(handle);
      if (!fields) { fields = new Map(); displayLists.set(handle, fields); }
      const read = () => options.boundDisplayField(handle, field, runtime).map(wrap);
      const write = values => {
        if (!Array.isArray(values)) throw new TypeError('Native display lists require an array');
        options.boundDisplayField(handle, field, runtime, values.map(object => entry(object).handle));
      };
      if (assigned.length) write(assigned[0]);
      if (!fields.has(field)) {
        const target = options.createArray ? options.createArray() : [];
        const mutators = new Set(['push','pop','shift','unshift','splice','sort','reverse','fill','copyWithin']), methods = new Map();
        const index = key => typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key)<4294967295;
        const refresh = () => {
          const values=read(); target.length=0; target.length=values.length;
          for (let i=0;i<values.length;++i) if (i in values) target[i]=values[i];
        };
        const proxy = new Proxy(target, {
          get(array, key, receiver) {
            refresh();
            if (mutators.has(key)) {
              if (!methods.has(key)) methods.set(key,function(...args) {
                if (this!==proxy) return Array.prototype[key].apply(this,args);
                refresh(); const values=target.slice(), result=Array.prototype[key].apply(values,args);
                write(values); refresh(); return result===values ? proxy : result;
              });
              return methods.get(key);
            }
            return Reflect.get(array,key,receiver);
          },
          set(array,key,value) {
            if (key!=='length' && !index(key)) return Reflect.set(array,key,value);
            refresh(); const values=target.slice(); Reflect.set(values,key,value);
            write(values); refresh(); return true;
          },
          deleteProperty(array,key) {
            if (!index(key)) return Reflect.deleteProperty(array,key);
            refresh(); const values=target.slice(); delete values[key]; write(values); refresh(); return true;
          },
          has(array,key) { refresh(); return Reflect.has(array,key); },
          ownKeys(array) { refresh(); return Reflect.ownKeys(array); },
          getOwnPropertyDescriptor(array,key) { refresh(); return Reflect.getOwnPropertyDescriptor(array,key); },
          defineProperty(array,key,descriptor) {
            if (key!=='length' && !index(key)) return Reflect.defineProperty(array,key,descriptor);
            if (descriptor.get || descriptor.set || descriptor.writable===false || descriptor.configurable===false || index(key) && descriptor.enumerable===false)
              throw new TypeError('Native display list entries require ordinary writable data properties');
            if ('value' in descriptor) {
              refresh(); const values=target.slice(); Reflect.set(values,key,descriptor.value); write(values); refresh();
            }
            return true;
          }
        });
        fields.set(field,proxy);
      }
      return fields.get(field);
    },
    displayHandle: object => entry(object).handle,
    nativeDisplaySymbol,
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
