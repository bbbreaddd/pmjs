'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

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
    nativeCompatibilityHit(capability) {
      throw new Error('unsupported native capability: ' + capability);
    },
    nativeCompatibilityObserved() {}
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  registered.unknown = function() {};
  assert.doesNotThrow(() => sandbox.pmjsPixiRenderPreflight.scan());
  assert.equal(sandbox.PMJS, undefined);
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

test('Pixi baseline loads before plugin setup, with scan after adapters', () => {
  const runtimeRoot = path.join(__dirname, '..');
  const generic = JSON.parse(fs.readFileSync(path.join(runtimeRoot,
    'profiles/mv.json'), 'utf8')).modules;
  assert.ok(generic.indexOf('js/pmjs-pixi4/render-preflight.js') >
    generic.indexOf('js/pmjs-mv/plugin-loader.js'));
  assert.ok(generic.indexOf('js/pmjs-pixi4/render-preflight.js') <
    generic.indexOf('js/pmjs-mv/bootstrap.js'));
  const repoRoot = path.join(runtimeRoot, '..');
  const output = childProcess.execFileSync(process.execPath, [
    path.join(runtimeRoot, 'tools/build-js-runtime.mjs'),
    '--root', repoRoot,
    '--manifest', 'ports/omori/port/native/runtime-bundle.json',
    '--game', 'ports/omori/OMORI-decrypted',
    '--print-modules',
  ], { cwd: repoRoot }).toString();
  const omori = JSON.parse(output)
    .map(entry => entry.base === 'native-runtime'
      ? `native-runtime/${entry.module}`
      : entry.module);
  assert.ok(omori.indexOf('native-runtime/js/pmjs-pixi4/render-preflight.js') <
    omori.indexOf('native-runtime/js/pmjs-mv/bootstrap.js'));
  assert.ok(omori.indexOf('native-runtime/js/pmjs-mv/plugin-loader.js') >= 0);
});
