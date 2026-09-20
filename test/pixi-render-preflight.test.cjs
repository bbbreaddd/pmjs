'use strict';

const assert = require('node:assert/strict');
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

  assert.equal(sandbox.PMJS.rendererPlugins, undefined);
  assert.equal(typeof sandbox.PMJS.rendererContracts.register, 'undefined');
});

test('cached nodes require the stock Pixi wrapper and a proven original hook', () => {
  class DisplayObject {}
  DisplayObject.prototype.renderWebGL = function() {};
  DisplayObject.prototype._renderCachedWebGL = function() {};
  class Sprite extends DisplayObject {}
  Sprite.prototype._renderWebGL = function() {};
  const sandbox = { PIXI: { DisplayObject, Sprite,
    WebGLRenderer: { __plugins: {} } },
    nativeCompatibilityObserved() {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  const node = new Sprite();
  node._cacheData = { originalRenderWebGL: node.renderWebGL };
  node.renderWebGL = node._renderCachedWebGL;
  assert.equal(sandbox.PMJS.rendererContracts.proveCached(node, 'sprite'), '');
  node._renderCachedWebGL = function() {};
  assert.equal(sandbox.PMJS.rendererContracts.proveCached(node, 'sprite'),
    'cached renderWebGL');
  delete node._renderCachedWebGL;
  node._cacheData.originalRenderWebGL = function() {};
  assert.equal(sandbox.PMJS.rendererContracts.proveCached(node, 'sprite'),
    'renderWebGL');
});

test('known Pixi class needs a matching native semantic contract', () => {
  class DisplayObject {}
  DisplayObject.prototype.renderWebGL = function() {};
  class Container extends DisplayObject {}
  class Text extends Container {}
  Text.prototype.renderWebGL = function() {};
  const sandbox = { PIXI: { DisplayObject, Container, Text,
    WebGLRenderer: { __plugins: {} } }, nativeCompatibilityObserved() {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  const contracts = sandbox.PMJS.rendererContracts;
  assert.equal(contracts.prove(new DisplayObject(), 'container'),
    'no native semantic contract');
  assert.equal(contracts.prove(new Text(), 'container'),
    'native representation mismatch');
  assert.equal(contracts.prove(new Text(), 'sprite'), '');
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
  const omori = JSON.parse(fs.readFileSync(path.join(runtimeRoot,
    '../ports/omori/port/native/runtime-bundle.json'), 'utf8')).modules;
  assert.ok(generic.indexOf('js/pmjs-pixi4/render-preflight.js') >
    generic.indexOf('js/pmjs-mv/plugin-loader.js'));
  assert.ok(generic.indexOf('js/pmjs-pixi4/render-preflight.js') <
    generic.indexOf('js/pmjs-mv/bootstrap.js'));
  assert.ok(omori.indexOf('native-runtime/js/pmjs-pixi4/render-preflight.js') <
    omori.indexOf('ports/omori/port/native/pmjs-omori/plugins.js'));
});

