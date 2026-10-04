'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { temporaryDirectory } = require('./helpers/temp.cjs');

const source = fs.readFileSync(path.join(__dirname,
  '../js/pmjs-pixi4/render-preflight.js'), 'utf8');

test('Pixi preflight reports plugin registrations and changed render hooks', () => {
  const hits = [];
  class Sprite {}
  Sprite.prototype._renderWebGL = function() {};
  class MVSprite {}
  MVSprite.prototype._renderWebGL = function() {};
  const rendererPlugins = { sprite: function() {} };
  const sandbox = {
    PIXI: { Sprite, WebGLRenderer: { __plugins: rendererPlugins } },
    Sprite: MVSprite,
    PMJS: { compat: { observed: (capability, detail) => hits.push([capability, detail]) } },
    nativeCompatibilityObserved(capability, detail) {
      hits.push([capability, detail]);
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  assert.deepEqual(Array.from(sandbox.pmjsPixiRenderPreflight.report.rendererPlugins), []);
  const original = Sprite.prototype._renderWebGL;
  rendererPlugins.custom = function() {};
  Sprite.prototype._renderWebGL = function() { original.call(this); };
  MVSprite.prototype._renderWebGL = function() {};
  sandbox.pmjsPixiRenderPreflight.scan();
  assert.deepEqual(Array.from(sandbox.pmjsPixiRenderPreflight.report.rendererPlugins),
    ['custom']);
  assert.deepEqual(Array.from(
    sandbox.pmjsPixiRenderPreflight.report.renderMethodOverrides),
  ['MVSprite._renderWebGL', 'Sprite._renderWebGL']);
  assert.deepEqual(hits, [
    ['render.rendererPluginRegistration', 'custom'],
    ['render.renderMethodOverride', 'MVSprite._renderWebGL'],
    ['render.renderMethodOverride', 'Sprite._renderWebGL']
  ]);
});

test('Pixi preflight inventories dormant registrations without strict failure', () => {
  class Sprite {}
  const registered = {};
  const sandbox = {
    PIXI: { Sprite, WebGLRenderer: { __plugins: registered } },
    PMJS: { compat: { observed() {} } },
    nativeCompatibilityHit(capability) {
      throw new Error('unsupported native capability: ' + capability);
    },
    nativeCompatibilityObserved() {}
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  registered.unknown = function() {};
  assert.doesNotThrow(() => sandbox.pmjsPixiRenderPreflight.scan());
  assert.deepEqual(Array.from(sandbox.pmjsPixiRenderPreflight.report.rendererPlugins),
    ['unknown']);
});

test('patched tilemap composite hooks are reported, not gated', () => {
  class DisplayObject {}
  class Container extends DisplayObject {}
  class RectTileLayer extends Container {}
  class CompositeRectTileLayer extends Container {}
  CompositeRectTileLayer.prototype.renderWebGL = function() {};
  const hits = [];
  const sandbox = { PIXI: { DisplayObject, Container,
    tilemap: { RectTileLayer, CompositeRectTileLayer },
    WebGLRenderer: { __plugins: {} } },
  PMJS: { compat: { observed: (capability, detail) => hits.push([capability, detail]) } },
  nativeCompatibilityObserved(capability, detail) {
    hits.push([capability, detail]);
  } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  sandbox.pmjsPixiRenderPreflight.scan();
  assert.deepEqual(hits, []);
  CompositeRectTileLayer.prototype.renderWebGL = function() {};
  sandbox.pmjsPixiRenderPreflight.scan();
  assert.deepEqual(Array.from(
    sandbox.pmjsPixiRenderPreflight.report.renderMethodOverrides),
  ['CompositeRectTileLayer.renderWebGL']);
  assert.deepEqual(hits, [
    ['render.renderMethodOverride', 'CompositeRectTileLayer.renderWebGL']
  ]);
});

test('Text preparation follows Pixi render resolution before rasterization', () => {
  const prepareSource = fs.readFileSync(path.join(__dirname,
    '../js/pmjs-pixi4/scene-prepare.js'), 'utf8');
  class Text {
    constructor() { this.resolution = 1; this.dirty = false; this.calls = []; }
    updateText(force) {
      this.calls.push([this.resolution, this.dirty, force]);
      this.dirty = false;
    }
  }
  const sandbox = { PIXI: { Text, extras: {}, mesh: {},
    WebGLRenderer: { __plugins: {} } }, nativeSceneFilterResolution: 2 };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  vm.runInNewContext(prepareSource, sandbox);
  const label = new Text();
  sandbox.prepareNativeSceneNode(label);
  assert.deepEqual(label.calls, [[2, true, true]]);
});

test('scene checks retain inherited baselines and recheck live prototype chains', () => {
  class Container {}
  Container.prototype.renderWebGL = function() {};
  Container.prototype._renderWebGL = function() {};
  class Sprite extends Container {}
  Sprite.prototype._renderWebGL = function() {};
  class Derived extends Sprite {}
  const sandbox = { PIXI: { Container, Sprite } };
  vm.runInNewContext(source, sandbox);
  const check = sandbox.pmjsPixiRenderPreflight.unsupportedMethod;
  const node = new Derived();
  assert.equal(check(node), null);
  const stock = Container.prototype.renderWebGL;
  Container.prototype.renderWebGL = function() {};
  assert.equal(check(node), 'renderWebGL');
  Container.prototype.renderWebGL = stock;
  assert.equal(check(node), null);
  // A different class's stock leaf does not establish equivalent drawing.
  node._renderWebGL = Container.prototype._renderWebGL;
  assert.equal(check(node), '_renderWebGL');
  delete node._renderWebGL;
  Object.setPrototypeOf(Derived.prototype, {
    __proto__: Sprite.prototype, renderWebGL() {}
  });
  assert.equal(check(node), 'renderWebGL');
});

test('scene checks distinguish stock cached drawing from custom cache overrides', () => {
  class DisplayObject {}
  DisplayObject.prototype._renderCachedWebGL = function() {};
  class Sprite extends DisplayObject {}
  Sprite.prototype.renderWebGL = function() {};
  Sprite.prototype._renderWebGL = function() {};
  const sandbox = { PIXI: { DisplayObject, Sprite } };
  vm.runInNewContext(source, sandbox);
  const check = sandbox.pmjsPixiRenderPreflight.unsupportedMethod;
  const node = new Sprite();
  node._cacheAsBitmap = true;
  node._cacheData = { originalRenderWebGL: node.renderWebGL, sprite: null };
  node.renderWebGL = node._renderCachedWebGL;
  assert.equal(check(node), null);
  node._cacheData.originalRenderWebGL = function() {};
  assert.equal(check(node), 'renderWebGL');
  node._cacheData.sprite = new Sprite();
  assert.equal(check(node), null);
  node.__pmjsBuildingBitmapCache = true;
  assert.equal(check(node), 'renderWebGL');
  node.__pmjsBuildingBitmapCache = false;
  node.renderWebGL = function() {};
  assert.equal(check(node), 'renderWebGL');
});

test('direct stock renderers do not dispatch an overridden leaf hook', () => {
  class Container {}
  Container.prototype.renderWebGL = function() {};
  class ParticleContainer extends Container {}
  class WindowLayer extends Container {}
  class RectTileLayer extends Container {}
  class CompositeRectTileLayer extends Container {}
  const classes = [ParticleContainer, WindowLayer, RectTileLayer, CompositeRectTileLayer];
  for (const cls of classes) cls.prototype.renderWebGL = function() {};
  const sandbox = { PIXI: { Container, particles: { ParticleContainer },
    tilemap: { RectTileLayer, CompositeRectTileLayer } }, WindowLayer };
  vm.runInNewContext(source, sandbox);
  const check = sandbox.pmjsPixiRenderPreflight.unsupportedMethod;
  for (const cls of classes) {
    const node = new cls();
    node._renderWebGL = function() {};
    assert.equal(check(node), null);
    node.renderWebGL = function() {};
    assert.equal(check(node), 'renderWebGL');
  }
});

test('Pixi baseline loads before plugin setup, with scan after adapters', () => {
  const runtimeRoot = path.join(__dirname, '..');
  const generic = JSON.parse(fs.readFileSync(path.join(runtimeRoot,
    'profiles/mv.json'), 'utf8')).modules;
  assert.ok(generic.indexOf('js/pmjs-pixi4/render-preflight.js') >
    generic.indexOf('js/pmjs-mv/plugin-loader.js'));
  assert.ok(generic.indexOf('js/pmjs-pixi4/render-preflight.js') <
    generic.indexOf('js/pmjs-mv/bootstrap.js'));
  const root = temporaryDirectory('pmjs-preflight-');
  const game = path.join(root, 'game');
  fs.mkdirSync(path.join(game, 'js', 'libs'), { recursive: true });
  fs.writeFileSync(path.join(game, 'js', 'rpg_core.js'), '// RPG Maker MV v1.6.1\n');
  fs.writeFileSync(path.join(game, 'js', 'rpg_managers.js'), '// managers\n');
  fs.writeFileSync(path.join(game, 'js', 'libs', 'pixi.js'), "PIXI.VERSION = '4.8.9';\n");
  fs.writeFileSync(path.join(game, 'js', 'libs', 'pixi-tilemap.js'),
    '// Pixi tilemap\n');
  fs.writeFileSync(path.join(game, 'js', 'plugins.js'),
    'var $plugins = [{"name": "YED_Tiled", "status": true}];\n');
  const manifest = path.join(root, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({
    adapters: 'none',
  }));
  const output = childProcess.execFileSync(process.execPath, [
    path.join(runtimeRoot, 'tools/build-js-runtime.mjs'),
    '--manifest', manifest,
    '--game', game,
    '--print-modules',
  ]).toString();
  const composed = JSON.parse(output)
    .map(entry => entry.base === 'native-runtime'
      ? `native-runtime/${entry.module}`
      : entry.module);
  assert.ok(composed.indexOf('native-runtime/js/pmjs-pixi4/render-preflight.js') <
    composed.indexOf('native-runtime/js/pmjs-mv/bootstrap.js'));
  assert.ok(composed.indexOf('native-runtime/js/pmjs-mv/plugin-loader.js') >= 0);
});
