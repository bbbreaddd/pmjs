'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const runtimeRoot = path.resolve(__dirname, '..');
const optimizationsSource = fs.readFileSync(
  path.join(runtimeRoot, 'js/pmjs-core/optimizations.js'), 'utf8');
const terraxSource = fs.readFileSync(
  path.join(runtimeRoot, 'js/pmjs-plugins/terrax/lighting.js'), 'utf8');
const lifecycleSource = fs.readFileSync(
  path.join(runtimeRoot, 'js/pmjs-rpgmaker/lifecycle.js'), 'utf8');
const methodsSource = fs.readFileSync(
  path.join(runtimeRoot, 'js/pmjs-core/methods.js'), 'utf8');
const pluginsSource = fs.readFileSync(
  path.join(runtimeRoot, 'js/pmjs-rpgmaker/plugins.js'), 'utf8');

function loadRegistrySupport(context) {
  if (!context.PMJS || !context.PMJS.optimizations) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-core/config.js'), 'utf8'), context);
    vm.runInContext(optimizationsSource, context, { filename: 'optimizations.js' });
  }
  vm.runInContext(lifecycleSource, context, { filename: 'lifecycle.js' });
  vm.runInContext(methodsSource, context, { filename: 'methods.js' });
  vm.runInContext(pluginsSource, context, { filename: 'plugins.js' });
}

function knownAddSprite(x, y, bitmap) {
  var sprite = new Sprite(this.viewport); // eslint-disable-line no-undef
  sprite.bitmap = bitmap;
  sprite.blendMode = 2;
  sprite.x = x;
  sprite.y = y;
  this._sprites.push(sprite);
  this.addChild(sprite);
}

function knownRemoveSprite() {
  var sprite = this._sprites.pop();
  this.removeChild(sprite);
}

function defineKnownCreateLightmask(SpritesetMap, createState) {
  function Lightmask() {
    Object.assign(this, createState());
  }
  SpritesetMap.prototype.addChild = function() {};
  SpritesetMap.prototype.createLightmask = function() {
    this._lightmask = new Lightmask();
    this.addChild(this._lightmask);
  };
}

test('registers terrax.native-lighting optimization', () => {
  const context = {
    console: { log() {} }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-core/config.js'), 'utf8'), context);
  vm.runInContext(optimizationsSource, context);
  loadRegistrySupport(context);
  vm.runInContext(terraxSource, context);

  assert.equal(context.PMJS.optimizations.isEnabled('terrax.native-lighting'), true);
  assert.ok(context.PMJS.optimizations.ids().includes('terrax.native-lighting'));
});

test('native Terrax adapter retains one mask sprite', () => {
  const hooks = {};
  function Sprite() {}
  function SpritesetMap() {}
  defineKnownCreateLightmask(SpritesetMap, function() {
    return {
      _sprites: [],
      added: 0,
      addChild() { this.added++; },
      removeChild() {},
      _addSprite: knownAddSprite,
      _removeSprite: knownRemoveSprite
    };
  });
  const context = {
    Sprite,
    Spriteset_Map: SpritesetMap,
    pmjsRegisterHook(name, callback) { hooks[name] = callback; },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-core/config.js'), 'utf8'), context);
  vm.runInContext(optimizationsSource, context);
  loadRegistrySupport(context);
  vm.runInContext(terraxSource, context);
  context.PMJS.phases.emit('afterGuestPlugins');

  const spriteset = new context.Spriteset_Map();
  spriteset.createLightmask();
  const mask = spriteset._lightmask;
  mask._addSprite(1, 2, { id: 1 });
  const retained = mask._sprites[0];
  mask._removeSprite();
  mask._addSprite(3, 4, { id: 2 });

  assert.equal(mask.added, 1);
  assert.equal(mask._sprites[0], retained);
  assert.equal(retained.visible, true);
  assert.equal(retained.x, 3);
  assert.equal(retained.bitmap.id, 2);
});

test('native Terrax adapter records supported mask draws into one GPU layer', () => {
  const hooks = {};
  const updates = [];
  function Sprite() {}
  function SpritesetMap() {}
  const canvas = {};
  const context2d = {
    _transform: [1, 0, 0, 1, 0, 0],
    fillStyle: '#000000', globalAlpha: 1,
    globalCompositeOperation: 'source-over', cpuFills: 0,
    save() {}, restore() {},
    fillRect() { this.cpuFills++; },
    fill() {},
  };
  const bitmap = { width: 64, height: 48, _canvas: canvas, _context: context2d,
    destroy() {} };
  defineKnownCreateLightmask(SpritesetMap, function() {
    return {
      _sprites: [], _maskBitmap: bitmap, addChild() {}, removeChild() {},
      _addSprite: knownAddSprite, _removeSprite: knownRemoveSprite,
      _updateMask() {
        var maskBitmap = this._maskBitmap;
        void maskBitmap;
        context2d.fillStyle = '#000000';
        context2d.globalCompositeOperation = 'source-over';
        context2d.fillRect(0, 0, 64, 48);
        context2d.fillStyle = { _pmjsStyle: 'radial-gradient', nativeConcentric: true,
          x0: 20, y0: 20, r0: 0, r1: 10,
          stops: [{ offset: 0, color: '#ffffff' },
            { offset: 1, color: '#000000' }] };
        context2d.globalCompositeOperation = 'lighter';
        context2d.fillRect(10, 10, 20, 20);
      },
    };
  });
  const context = {
    Sprite, Spriteset_Map: SpritesetMap,
    NativeHost: { runtime: { env() { return ''; } }, render: {
      createPrimitiveSurface() {
        return { handle: 42, image: { handle: 84, width: 64, height: 48 } };
      },
      renderPrimitiveSurface(handle, clear, records) {
        updates.push([handle, clear.slice(), records.slice()]);
      },
      releasePrimitiveSurface() { return true; },
    } },
    colorWithGlobalAlpha(color) {
      return color === '#ffffff' ? 0xffffffff : 0x000000ff;
    },
    pmjsRegisterHook(name, callback) { hooks[name] = callback; },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-core/config.js'), 'utf8'), context);
  vm.runInContext(optimizationsSource, context);
  loadRegistrySupport(context);
  vm.runInContext(terraxSource, context);
  context.PMJS.phases.emit('afterGuestPlugins');
  const spriteset = new context.Spriteset_Map();
  spriteset.createLightmask();
  spriteset._lightmask._updateMask();

  assert.equal(updates.length, 1);
  assert.equal(updates[0][0], 42);
  assert.deepEqual(Array.from(updates[0][1]), [0, 0, 0, 1]);
  assert.equal(updates[0][2].length, 26);
  assert.equal(context2d.cpuFills, 0);
  assert.equal(canvas._nativeImage.handle, 84);
});

test('native Terrax adapter keeps Canvas rendering without the color helper', () => {
  const hooks = {};
  let surfaces = 0;
  function SpritesetMap() {}
  defineKnownCreateLightmask(SpritesetMap, function() {
    return { _sprites: [], addChild() {}, removeChild() {},
      _addSprite: knownAddSprite, _removeSprite: knownRemoveSprite };
  });
  const context = {
    console,
    Spriteset_Map: SpritesetMap,
    NativeHost: { render: {
      createPrimitiveSurface() {
        surfaces++;
        return { handle: 1, image: {} };
      }
    } },
    pmjsRegisterHook(name, callback) { hooks[name] = callback; }
  };
  context.globalThis = context;
  vm.createContext(context);
  loadRegistrySupport(context);
  vm.runInContext(terraxSource, context);
  context.PMJS.phases.emit('afterGuestPlugins');

  const spriteset = new context.Spriteset_Map();
  spriteset.createLightmask();
  assert.equal(surfaces, 0);
  assert.equal(spriteset._lightmask._pmjsMaskSprite, undefined);
});

test('Terrax adapter leaves an unknown createLightmask implementation untouched', () => {
  function SpritesetMap() {}
  function customCreateLightmask() {
    this.customLightingSetup = true;
  }
  SpritesetMap.prototype.createLightmask = customCreateLightmask;
  const context = {
    Spriteset_Map: SpritesetMap,
    pmjsRegisterHook() {}
  };
  context.globalThis = context;
  vm.createContext(context);
  loadRegistrySupport(context);
  vm.runInContext(terraxSource, context);

  assert.equal(context.Spriteset_Map.prototype.createLightmask,
    customCreateLightmask);
  assert.equal(context.pmjsInstallTerraxLightingFastPaths(), false);
});

test('Terrax adapter preserves unknown per-instance sprite methods', () => {
  function SpritesetMap() {}
  function customAddSprite() { this.customAdd = true; }
  function customRemoveSprite() { this.customRemove = true; }
  defineKnownCreateLightmask(SpritesetMap, function() {
    return {
      _sprites: [],
      addChild() {},
      _addSprite: customAddSprite,
      _removeSprite: customRemoveSprite
    };
  });
  const context = {
    Spriteset_Map: SpritesetMap,
    pmjsRegisterHook() {}
  };
  context.globalThis = context;
  vm.createContext(context);
  loadRegistrySupport(context);
  vm.runInContext(terraxSource, context);

  const spriteset = new context.Spriteset_Map();
  spriteset.createLightmask();
  assert.equal(spriteset._lightmask._addSprite, customAddSprite);
  assert.equal(spriteset._lightmask._removeSprite, customRemoveSprite);
});

test('Terrax adapter requires the complete primitive-surface capability', () => {
  let surfaces = 0;
  function Sprite() {}
  function SpritesetMap() {}
  defineKnownCreateLightmask(SpritesetMap, function() {
    return {
      _sprites: [],
      _maskBitmap: { _canvas: {}, _context: { fillRect() {} } },
      addChild() {},
      removeChild() {},
      _addSprite: knownAddSprite,
      _removeSprite: knownRemoveSprite,
      _updateMask() {
        var maskBitmap = this._maskBitmap;
        maskBitmap._context.fillRect(0, 0, 1, 1);
      }
    };
  });
  const context = {
    Sprite,
    Spriteset_Map: SpritesetMap,
    colorWithGlobalAlpha() { return 0; },
    NativeHost: { render: {
      createPrimitiveSurface() { surfaces++; return { handle: 1 }; }
    } },
    pmjsRegisterHook() {}
  };
  context.globalThis = context;
  vm.createContext(context);
  loadRegistrySupport(context);
  vm.runInContext(terraxSource, context);

  const spriteset = new context.Spriteset_Map();
  spriteset.createLightmask();
  assert.equal(surfaces, 0);
});

function terraxDisabledContext({ config, env }) {
  const hooks = {};
  const updates = [];
  const stockAdds = [];
  function Sprite() {}
  function SpritesetMap() {}
  const canvas = {};
  const context2d = {
    _transform: [1, 0, 0, 1, 0, 0],
    fillStyle: '#000000', globalAlpha: 1,
    globalCompositeOperation: 'source-over', cpuFills: 0,
    save() {}, restore() {},
    fillRect() { this.cpuFills++; },
    fill() {},
  };
  const bitmap = { width: 64, height: 48, _canvas: canvas, _context: context2d,
    destroy() {} };
  defineKnownCreateLightmask(SpritesetMap, function() {
    return {
      _sprites: [], _maskBitmap: bitmap, addChild() {},
      removeChild() {},
      _addSprite(x, y, source) { stockAdds.push([x, y, source]); },
      _removeSprite() {},
      _updateMask() {
        var maskBitmap = this._maskBitmap;
        void maskBitmap;
        context2d.fillStyle = '#000000';
        context2d.globalCompositeOperation = 'source-over';
        context2d.fillRect(0, 0, 64, 48);
      },
    };
  });
  const context = {
    Sprite, Spriteset_Map: SpritesetMap,
    PMJS_GAME_CONFIG: config,
    NativeHost: { runtime: { env(name) { return env[name] || ''; } }, render: {
      createPrimitiveSurface() {
        return { handle: 42, image: { handle: 84, width: 64, height: 48 } };
      },
      renderPrimitiveSurface(handle, clear, records) {
        updates.push([handle, clear.slice(), records.slice()]);
      },
      releasePrimitiveSurface() { return true; },
    } },
    colorWithGlobalAlpha(color) {
      return color === '#ffffff' ? 0xffffffff : 0x000000ff;
    },
    pmjsRegisterHook(name, callback) { hooks[name] = callback; },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-core/config.js'), 'utf8'), context);
  vm.runInContext(optimizationsSource, context);
  loadRegistrySupport(context);
  vm.runInContext(terraxSource, context);
  context.PMJS.phases.emit('afterGuestPlugins');
  const spriteset = new context.Spriteset_Map();
  spriteset.createLightmask();
  return { mask: spriteset._lightmask, updates, stockAdds, context2d };
}

test('terrax.native-lighting disabled by port runs the ordinary Canvas path', () => {
  const { mask, updates, stockAdds, context2d } = terraxDisabledContext({
    config: { disableOptimizations: ['terrax.native-lighting'] }, env: {},
  });
  mask._updateMask();
  assert.equal(updates.length, 0);
  assert.ok(context2d.cpuFills > 0);

  mask._addSprite(1, 2, { id: 1 });
  assert.deepEqual(stockAdds, [[1, 2, { id: 1 }]]);
  assert.equal(mask._pmjsMaskSprite, undefined);
});

test('terrax.native-lighting disabled by PMJS_DISABLE_OPT runs the ordinary Canvas path', () => {
  const { mask, updates, context2d } = terraxDisabledContext({
    config: {}, env: { PMJS_DISABLE_OPT: 'terrax.native-lighting' },
  });
  mask._updateMask();
  assert.equal(updates.length, 0);
  assert.ok(context2d.cpuFills > 0);
});
