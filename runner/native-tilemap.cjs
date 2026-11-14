'use strict';
const { installTilemapStatics } = require('./native-tilemap-statics.cjs');
const { createTilemapClasses } = require('./native-tilemap-drawing.cjs');

function installTilemap(runtime, engine, session) {
  const scope = runtime.scope;
  let display;
  const adapters = new WeakMap();
  let recording = null;
  const { Tilemap, ShaderTilemap } = createTilemapClasses(runtime, {
    initialize(object) {
      if (!display) throw new Error('Tilemap construction requires scene bindings');
      scope.Container.prototype.initialize.call(object);
      display.prepareDisplay(object, () => object.updateTransform());
    },
    tilePosition(tilemap, x, y) { return recording && tilemap === recording.tilemap ? [x*tilemap._tileWidth,y*tilemap._tileHeight] : [((x*tilemap._tileWidth)%tilemap._layerWidth+tilemap._layerWidth)%tilemap._layerWidth,((y*tilemap._tileHeight)%tilemap._layerHeight+tilemap._layerHeight)%tilemap._layerHeight]; },
    layer(tilemap, bitmap) {
      if(recording && tilemap===recording.tilemap)return bitmap===tilemap._lowerBitmap?recording.layers[0]:recording.layers[1];
      let pair = adapters.get(bitmap);
      if (!pair) {
        pair = { addRect(sheet, sx, sy, dx, dy, width, height, animX = 0, animY = 0) {
          if (sheet === -1) { bitmap.fillRect(dx, dy, width, height, 'rgba(0,0,0,0.5)'); return; }
          const source = tilemap.bitmaps[sheet];
          if (!source) return;
          const frame = tilemap.animationFrame, horizontal = [0,1,2,1][frame % 4];
          bitmap.bltImage(source, sx + animX * horizontal * tilemap._tileWidth,
            sy + animY * (frame % 3) * tilemap._tileHeight, width, height, dx, dy);
        } };
        adapters.set(bitmap, pair);
      }
      return pair;
    }
  });
  const sortChildren = Tilemap.prototype._sortChildren, compareChildOrder = Tilemap.prototype._compareChildOrder;
  const base = ShaderTilemap.prototype._drawShadow;
  const refresh = Tilemap.prototype.refresh, shaderRefresh = ShaderTilemap.prototype.refresh;
  let tilemap = Object.create(ShaderTilemap.prototype);
  let state = {};
  const ownedTilemaps=new WeakSet([tilemap]);
  let width = 48, height = 48, previous = base;
  const methods = ['_readMapData','_isHigherTile','_isTableTile','_isOverpassPosition'];
  const defaults = new Map(methods.map(name => [name, tilemap[name]]));
  const drawingMethods=['_paintAllTiles','_paintTiles','_drawTile','_drawNormalTile','_drawAutotile','_drawTableEdge'];
  const drawingDefaults=new Map(drawingMethods.map(name=>[name,tilemap[name]]));
  let previousMethods = methods.concat(drawingMethods).map(name => tilemap[name]);
  let staticChanged=false, pendingStaticChange=false;
  Object.defineProperties(tilemap, {
    _tileWidth: { get: () => width }, _tileHeight: { get: () => height }
  });
  Tilemap.prototype.refresh = function() {
    if (!ownedTilemaps.has(this)) return refresh.call(this);
    if(display&&this.bitmaps)display.tilemapState(this);
    engine.gameDataInvoke(session, 'map', 'invalidateTileShadows', [this._drawShadow !== base]);
  };
  ShaderTilemap.prototype.refresh = function() { if (!ownedTilemaps.has(this)) return shaderRefresh.call(this); return Tilemap.prototype.refresh.call(this); };
  Object.assign(scope, { Tilemap, ShaderTilemap });
  installTilemapStatics(runtime);
  const arrays=new WeakMap();
  function watch(value) {
    if(!Array.isArray(value))return value;
    if(!arrays.has(value))arrays.set(value,new Proxy(value,{
      get(array,key,receiver) {return watch(Reflect.get(array,key,receiver));},
      set(array,key,item) {Reflect.set(array,key,item);staticChanged=pendingStaticChange=true;return true;},
      deleteProperty(array,key) {Reflect.deleteProperty(array,key);staticChanged=pendingStaticChange=true;return true;}
    }));
    return arrays.get(value);
  }
  for(const name of Object.keys(Tilemap)) {
    let value=watch(Tilemap[name]);
    Object.defineProperty(Tilemap,name,{configurable:true,enumerable:true,get() {return value;},set(next) {value=watch(next);staticChanged=pendingStaticChange=true;}});
  }

  return {
    configure(bindings) { display = bindings; Object.setPrototypeOf(Tilemap.prototype, scope.Container.prototype); },
    attach(object) {
      ownedTilemaps.add(object);Object.setPrototypeOf(Object.getPrototypeOf(object),ShaderTilemap.prototype);
      const map=scope.$dataMap;
      Object.assign(object,{_margin:20,_width:scope.Graphics.width+40,_height:scope.Graphics.height+40,
        _tileWidth:display.tilemapField(object,'tileWidth'),_tileHeight:display.tilemapField(object,'tileHeight'),bitmaps:display.tilemapBitmaps(object),
        _mapWidth:map?.width||0,_mapHeight:map?.height||0,_mapData:map?.data||[],flags:scope.$gameMap.tilesetFlags(),
        horizontalWrap:scope.$gameMap.isLoopHorizontal(),verticalWrap:scope.$gameMap.isLoopVertical(),...state});
      for(const [name,field] of [['_margin','margin'],['_width','width'],['_height','height'],['_tileWidth','tileWidth'],['_tileHeight','tileHeight'],
        ['_mapWidth','mapWidth'],['_mapHeight','mapHeight'],['horizontalWrap','horizontalWrap'],['verticalWrap','verticalWrap'],
        ['animationCount','animationCount'],['animationFrame','animationFrame']]) {
        if(Object.hasOwn(object,name))display.tilemapField(object,field,object[name]);
        Object.defineProperty(object,name,{configurable:true,enumerable:true,get() {return display.tilemapField(this,field);},set(value) {display.tilemapField(this,field,value);}});
      }
      for(const [name,field] of [['tileWidth','_tileWidth'],['tileHeight','_tileHeight'],['width','_width'],['height','_height']])
        Object.defineProperty(object,name,{configurable:true,get() {return this[field];},set(value) {if(this[field]!==value){this[field]=value;this.refresh();}}});
      display.prepareDisplay(object, () => {
        const changed = object._sortChildren !== sortChildren || object._compareChildOrder !== compareChildOrder;
        display.tilemapField(object, 'customChildOrder', changed);
        if (changed) object._sortChildren();
      });
      object.refreshTileset=function() {display.tilemapState(this);};
      tilemap=object;pendingStaticChange=true;
    },
    state(value) { state=value;Object.assign(tilemap,value); },
    geometry(firstX,firstY,lastX,lastY,tileWidth,tileHeight) {
      if(!staticChanged&&!drawingMethods.some(name=>tilemap[name]!==drawingDefaults.get(name)))return undefined;
      width=tileWidth;height=tileHeight;
      if(!tilemap.bitmaps) {tilemap._width=(lastX-firstX-1)*width;tilemap._height=(lastY-firstY-1)*height;}
      const records=[[],[]];
      const layers=records.map(list=>({
        clear() {list.length=0;},
        addRect(sheet,sx,sy,dx,dy,w,h,animX=0,animY=0) {
          if(![sheet,sx,sy,dx,dy,w,h,animX,animY].every(Number.isFinite))throw new TypeError('Tile drawing rectangle must be finite');
          list.push([sheet,sx,sy,dx,dy,w,h,animX,animY]);
        }
      }));
      tilemap._lowerBitmap=tilemap._lowerLayer=layers[0];tilemap._upperBitmap=tilemap._upperLayer=layers[1];
      recording={tilemap,layers};
      try {tilemap._paintAllTiles(firstX,firstY);return records;} finally {recording=null;}
    },
    operation(method, ...args) {
      const fn = tilemap[method];
      if (fn === defaults.get(method)) return undefined;
      if (typeof fn !== 'function') throw new TypeError('Tilemap.' + method + ' is not callable');
      return fn.apply(tilemap, args);
    },
    update() {
      const current = methods.concat(drawingMethods).map(name => tilemap[name]);
      if (pendingStaticChange || current.some((method, index) => method !== previousMethods[index])) {
        previousMethods = current;
        pendingStaticChange=false;
        engine.gameDataInvoke(session, 'map', 'invalidateTileFunctions', [methods.some(name => tilemap[name] !== defaults.get(name)),staticChanged||drawingMethods.some(name=>tilemap[name]!==drawingDefaults.get(name))]);
      }
      if (tilemap._drawShadow !== previous) { previous = tilemap._drawShadow; tilemap.refresh(); }
    },
    draw(bits, x, y, tileWidth, tileHeight) {
      if (tilemap._drawShadow === base) return undefined;
      width = tileWidth; height = tileHeight;
      const rectangles = [];
      const layer = { addRect(texture, sx, sy, dx, dy, w, h) {
        if (texture !== -1) throw new Error('Tile shadow drawing only supports shadow rectangles');
        if (![dx, dy, w, h].every(Number.isFinite)) throw new Error('Tile shadow rectangle must be finite');
        rectangles.push([dx, dy, w, h]);
      } };
      tilemap._drawShadow(layer, bits, x, y);
      return rectangles;
    }
  };
}
module.exports = { installTilemap };
