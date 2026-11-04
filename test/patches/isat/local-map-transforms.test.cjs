'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../../../patches/isat/local-map-transforms.js'), 'utf8');

function setup({ qualified = true, dataVerified = true, beforeInstall } = {}) {
  const stages = new WeakMap(), warnings = [], phases = [];
  const context = vm.createContext({
    console: { warn(message) { warnings.push(message); } },
    __pmjsBuiltinRequire: require,
    PMJS: { isatSourceQualification: Object.freeze({ verified: qualified, dormontDataVerified: dataVerified }),
      phases: { on(name, _owner, callback) { assert.equal(name, 'beforeBoot'); phases.push(callback); } },
      pixi4: { getStageRenderOptions(stage) { return stages.get(stage); },
        setStageRenderOptions(stage, options) { if (options) stages.set(stage, { ...options }); else stages.delete(stage); } } }
  });
  vm.runInContext(`
    function DisplayObject() { this.children = []; this.scale = {x:1,y:1}; }
    Object.defineProperties(DisplayObject.prototype, {
      filters: { configurable:true, get:function(){return this._filters;},set:function(v){this._filters=v;} },
      mask: { configurable:true, get:function(){return this._mask;},set:function(v){this._mask=v;} }
    });
    function Container(){DisplayObject.call(this);} Container.prototype=Object.create(DisplayObject.prototype);
    Container.prototype.constructor=Container;
    Container.prototype.updateTransform=function(){return'transform';};
    Container.prototype.addChild=function(child){this.children.push(child);child.parent=this;return child;};
    Container.prototype.removeChild=function(child){this.children.splice(this.children.indexOf(child),1);child.parent=null;return child;};
    function Sprite(){Container.call(this);}Sprite.prototype=Object.create(Container.prototype);Sprite.prototype.constructor=Sprite;
    Sprite.prototype.createHorrorFilter=function(filter){this._filters=[filter];};
    function Window(){Container.call(this);}Window.prototype=Object.create(Container.prototype);Window.prototype.constructor=Window;
    function Tilemap(){Container.call(this);}Tilemap.prototype=Object.create(Container.prototype);Tilemap.prototype.constructor=Tilemap;
    function ShaderTilemap(){Tilemap.call(this);}ShaderTilemap.prototype=Object.create(Tilemap.prototype);ShaderTilemap.prototype.constructor=ShaderTilemap;
    function TilingSprite(){Container.call(this);}TilingSprite.prototype=Object.create(Container.prototype);TilingSprite.prototype.constructor=TilingSprite;
    function Scene_Map(){Container.call(this);this._spriteset=new Container();this.addChild(this._spriteset);}
    Scene_Map.prototype=Object.create(Container.prototype);Scene_Map.prototype.constructor=Scene_Map;
    function SpriteWeatherEX(){Container.call(this);}SpriteWeatherEX.prototype=Object.create(Container.prototype);SpriteWeatherEX.prototype.constructor=SpriteWeatherEX;
    function Text(){Container.call(this);}Text.prototype=Object.create(Container.prototype);
    function Mesh(){Container.call(this);}Mesh.prototype=Object.create(Container.prototype);
    var PIXI={Container:Container,DisplayObject:DisplayObject,Sprite:Sprite,Text:Text,mesh:{Mesh:Mesh}};
    function Game_System(){}var $gameSystem=new Game_System();
    var $gameMap={mapId:function(){return 30;},isEventRunning:function(){return false;}};
    var $gameTemp={isManipulatingHud:false},$gamePlayer={isTransferring:function(){return false;}};
    var $gameScreen={zoomScale:function(){return 1;},tone:function(){return [0,0,0,0];}};
    var $dataMap={},$dataCommonEvents=[];
    var ImageManager={isReady:function(){return true;}},SceneManager={_scene:null};
    var Graphics={render:function(){return this._renderer.render.apply(this._renderer,arguments);}};
  `, context);
  for (const name of ['_updateCursor', '_updateArrows', '_updatePauseSign', '_updateContents', 'isOpen']) vm.runInContext(`Window.prototype.${name}=function(){return'${name}';};`, context);
  for (const name of ['_sortChildren', '_compareChildOrder', '_readMapData']) vm.runInContext(`Tilemap.prototype.${name}=function(){return'${name}';};`, context);
  for (const name of ['_updateLayerPositions', '_paintAllTiles', '_paintTiles', '_drawTile', '_drawNormalTile', '_drawAutotile', '_drawShadow', '_drawTableEdge']) vm.runInContext(`ShaderTilemap.prototype.${name}=function(){return'${name}';};`, context);
  for (const name of ['weatherEX_initialize', 'clearWeatherEX', 'commandSetupWeather']) vm.runInContext(`Game_System.prototype.${name}=function(){return'${name}';};`, context);
  vm.runInContext(fs.readFileSync(require.resolve('../../../js/pmjs-core/methods.js'), 'utf8'), context);
  let fixtureSource = source;
  const digest = fn => context.PMJS.methods.fingerprint(context.PMJS.methods.sourceOf(fn));
  fixtureSource = fixtureSource.replace('1a091756d85883232da57aa53141f43968c21abfc58b6b231a46c0faa9014861', digest(context.Container.prototype.updateTransform));
  const preparation = JSON.parse(source.match(/var preparationHashes = ([\s\S]*?);/)[1]);
  for (const [owner, methods] of Object.entries(preparation)) {
    for (const name of Object.keys(methods)) methods[name] = [digest(context[owner].prototype[name])];
  }
  fixtureSource = fixtureSource.replace(/var preparationHashes = [\s\S]*?;/, 'var preparationHashes = ' + JSON.stringify(preparation) + ';');
  const weather = JSON.parse(source.match(/var weatherHashes = ([^;]*);/)[1]);
  for (const name of Object.keys(weather)) weather[name] = digest(context.Game_System.prototype[name]);
  fixtureSource = fixtureSource.replace(/var weatherHashes = [^;]*;/, 'var weatherHashes = ' + JSON.stringify(weather) + ';');
  if (beforeInstall) beforeInstall(context);
  vm.runInContext(fixtureSource, context);
  assert.equal(context.PMJS.isatMapTransforms, undefined);
  phases.forEach(callback => callback());
  const events = [], listeners = { prerender: [], postrender: [] };
  let body = null;
  const renderer = { filterManager: { _onPrerender() {} }, listeners(name) { return listeners[name] || []; },
    render(stage, target) {
      events.push({ stage, target, mode: stages.get(stage)?.worldState || 'native' });
      if (body) body(this, stage); return 'rendered';
    } };
  context.Graphics._renderer = renderer;
  const stage = new context.Scene_Map(); context.SceneManager._scene = stage;
  context.PMJS.pixi4.setStageRenderOptions(stage, { worldState: 'pixi', plainSpriteSegments: false });
  return { context, stage, renderer, listeners, events, warnings, options: () => stages.get(stage),
    body(callback) { body = callback; }, render(...args) { return context.Graphics.render(stage, ...args); },
    state() { return context.PMJS.isatMapTransforms?.diagnostics(stage); } };
}

test('normal qualified startup selects local mode and restores stage options', () => {
  const h = setup(); h.listeners.prerender.push(h.renderer.filterManager._onPrerender); assert.equal(h.render(), 'rendered'); assert.equal(h.events[0].mode, 'local');
  assert.equal(h.options().worldState, 'pixi'); assert.equal(h.options().plainSpriteSegments, false);
  assert.deepEqual(JSON.parse(JSON.stringify(h.state())), { localRenders: 1, reason: null });
  const unqualified = setup({ qualified: false }); unqualified.render();
  assert.equal(unqualified.events[0].mode, 'pixi'); assert.equal(unqualified.state(), undefined);
  const unreviewedData = setup({ dataVerified: false }); unreviewedData.render();
  assert.equal(unreviewedData.context.PMJS.isatSourceQualification.verified, true);
  assert.equal(unreviewedData.events[0].mode, 'pixi'); assert.equal(unreviewedData.state(), undefined);
});

test('offscreen, nested rendering and thrown renders retain ordinary contexts', () => {
  const h = setup(); h.render({ texture: true }); assert.equal(h.events[0].mode, 'pixi');
  let nested = false;
  h.body((renderer, stage) => {
    if (nested) return; nested = true;
    renderer.render(stage, { texture: true }); assert.equal(h.options().worldState, 'local');
  });
  h.render(); assert.equal(h.events[1].mode, 'local'); assert.equal(h.events[2].mode, 'pixi'); assert.equal(h.options().worldState, 'pixi');
  h.body(() => { throw Error('render failure'); }); assert.throws(() => h.render(), /render failure/);
  assert.equal(h.options().worldState, 'pixi');
  h.body(null); h.render(); assert.equal(h.events.at(-1).mode, 'local');
});

test('bitmap-cache restoration keeps an unchanged instance transform eligible', () => {
  const h = setup(), hud = new h.context.Sprite();
  h.stage.addChild(hud);
  const inherited = hud.updateTransform;
  hud.updateTransform = inherited;
  hud._cacheAsBitmap = false;
  h.render();
  assert.equal(h.events.at(-1).mode, 'local');
  assert.equal(h.state().reason, null);
  hud.updateTransform = function customTransform() {};
  h.render();
  assert.equal(h.events.at(-1).mode, 'pixi');
  assert.equal(h.state().reason, 'instance-transform');
});

test('instance transforms still reject overrides, accessors and reactivated caches', () => {
  for (const mutate of [
    hud => { hud.updateTransform = function customTransform() {}; },
    hud => { const method = hud.updateTransform; Object.defineProperty(hud, 'updateTransform', { get() { return method; } }); }
  ]) {
    const h = setup(), hud = new h.context.Sprite();
    h.stage.addChild(hud); mutate(hud); h.render();
    assert.equal(h.events.at(-1).mode, 'pixi');
    assert.equal(h.state().reason, 'inventory');
  }
  const h = setup(), hud = new h.context.Sprite();
  h.stage.addChild(hud); hud.updateTransform = hud.updateTransform;
  h.render(); assert.equal(h.events.at(-1).mode, 'local');
  hud._cacheAsBitmap = true;
  h.render(); assert.equal(h.events.at(-1).mode, 'pixi');
  assert.equal(h.state().reason, 'instance-transform');
});

test('tree and filter changes invalidate future renders without claiming rollback', () => {
  for (const mutate of [h => h.stage.addChild(new h.context.Sprite()), h => { h.stage.filters = [{ enabled: true }]; }]) {
    const h = setup(); h.render(); mutate(h); h.render(); assert.equal(h.events.at(-1).mode, 'pixi');
    assert.match(h.state().reason, /tree:|property:/);
  }
  const effect = setup(), sprite = new effect.context.Sprite(); effect.stage.addChild(sprite); effect.render();
  sprite.createHorrorFilter({ enabled: true }); effect.render(); assert.equal(effect.events.at(-1).mode, 'pixi');
  assert.equal(effect.state().reason, 'horror-filter');
  const toggled = setup(); toggled.stage._filters = [{ enabled: false }]; toggled.render();
  toggled.stage._filters[0].enabled = true; toggled.render(); assert.equal(toggled.events.at(-1).mode, 'pixi');
  assert.equal(toggled.state().reason, 'effect');
  const h = setup(); h.body(() => { h.stage.addChild(new h.context.Sprite()); }); h.render();
  assert.equal(h.events[0].mode, 'local'); assert.equal(h.options().worldState, 'pixi');
  h.body(null); h.render(); assert.equal(h.events[1].mode, 'pixi'); assert.match(h.state().reason, /tree:addChild/);
});

test('render and nested-render policy changes survive local-mode restoration', () => {
  for (const nested of [false, true]) {
    const h = setup();
    const producers = { nodes: [], valid() { return true; } };
    let entered = false;
    h.body((renderer, stage) => {
      if (!entered) {
        entered = true;
        if (nested) { renderer.render(stage, { texture: true }); return; }
      }
      h.context.PMJS.pixi4.setStageRenderOptions(stage, {
        ...h.options(), plainSpriteSegments: true, bitmapCacheProducers: producers
      });
    });
    h.render();
    assert.equal(h.options().worldState, 'pixi');
    assert.equal(h.options().plainSpriteSegments, true);
    assert.equal(h.options().bitmapCacheProducers, producers);
  }
});

test('foreign world modes and cleared policies are not reclaimed after nested or thrown renders', () => {
  for (const nested of [false, true]) for (const replacement of [null, { worldState: 'native' }]) {
    const h = setup();
    let entered = false;
    h.body((renderer, stage) => {
      if (!entered) {
        entered = true;
        if (nested) { renderer.render(stage, { texture: true }); return; }
      }
      h.context.PMJS.pixi4.setStageRenderOptions(stage, replacement);
      throw Error('render failure');
    });
    assert.throws(() => h.render(), /render failure/);
    assert.deepEqual(h.options(), replacement || undefined);
  }
});

test('an initially absent policy is removed again without losing newly installed fields', () => {
  const h = setup();
  const pixi = h.context.PMJS.pixi4;
  pixi.setStageRenderOptions(h.stage, null);
  h.render();
  assert.equal(h.options(), undefined);
  h.body((renderer, stage) => {
    pixi.setStageRenderOptions(stage, { ...h.options(), plainSpriteSegments: false });
  });
  h.render();
  assert.equal(h.options().worldState, 'native');
  assert.equal(h.options().plainSpriteSegments, false);
});

test('unknown listeners, preparation hooks, world effects and source changes use ordinary transforms', () => {
  const mutations = [
    h => h.listeners.prerender.push(() => {}), h => h.listeners.postrender.push(() => {}),
    h => { h.context.Window.prototype._updateCursor = () => {}; },
    h => { h.context.$gameScreen.tone = () => [1,0,0,0]; },
    h => { h.context.$gameScreen.zoomScale = () => 2; },
    h => { h.stage._spriteset._weather = { type: 'rain' }; },
    h => { h.context.PMJS.isatSourceQualification = { verified: true }; },
    h => { h.context.$dataMap = {}; }, h => { h.context.$dataCommonEvents = []; }
  ];
  for (const mutate of mutations) { const h = setup(); h.render(); mutate(h); h.render(); assert.equal(h.events.at(-1).mode, 'pixi'); }
  for (const type of ['Text', 'Mesh']) {
    const h = setup(); h.stage.addChild(new (type === 'Text' ? h.context.PIXI.Text : h.context.PIXI.mesh.Mesh)());
    h.render(); assert.equal(h.events[0].mode, 'pixi'); assert.equal(h.state().reason, 'inventory');
  }
});

test('reviewed weather notifications and sunlight ownership changes invalidate local mode', () => {
  const h = setup(); h.render(); h.context.$gameSystem.commandSetupWeather([]); h.render();
  assert.equal(h.events.at(-1).mode, 'pixi'); assert.equal(h.state().reason, 'weather-producer');
  const sun = setup();
  vm.runInContext(`
    var set=SceneManager._scene._spriteset;set._weatherField_1=new PIXI.Container();set._weatherField_2=new PIXI.Container();set._weatherField_3=new PIXI.Container();
    set.addChild(set._weatherField_1);set.addChild(set._weatherField_2);set.addChild(set._weatherField_3);
    var owner=new SpriteWeatherEX();owner._id=0;owner._image={};owner._sprites=[];
    for(var i=0;i<15;i++){var sprite=new Sprite();sprite.bitmap=owner._image;sprite.blendMode=1;owner.addChild(sprite);owner._sprites.push(sprite);}
    set._weatherEXSprites=[owner];set._weatherField_2.addChild(owner);
    $gameSystem._weatherEX_Data=[{mode:21,power:15,speed:100,blendMode:1,fileName:'SunLight_01B',z:1,scale:100,frames:1}];
  `, sun.context);
  sun.render(); assert.equal(sun.events[0].mode, 'local');
  sun.context.$gameSystem._weatherEX_Data[0].power = 16; sun.render(); assert.equal(sun.events.at(-1).mode, 'pixi');
});
