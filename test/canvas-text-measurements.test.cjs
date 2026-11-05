'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { createHostContext } = require('./helpers/mz-host-context.cjs');
const { runModule } = require('./helpers/runtime-context.cjs');
const id = 'web.text-measurement-cache';

function fixture(native, enabled = true, engine = 'mv', beforeActivation) {
  let calls = 0;
  native = native || { runtime: { env: () => '' }, canvas: {
    create: (width, height) => ({ handle: 1, width, height }), release() {},
    measureTextMetrics(_paths, text, size) { calls++; return { width: size + text.length }; }
  } };
  const realm = createHostContext(native, { graphics: false });
  runModule(realm, 'js/pmjs-web/fonts.js');
  realm.PMJS.fonts.registerFace('GameFont', 'testfont.ttf');
  realm.PMJS.config.disableOptimizations = enabled ? [] : [id];
  runModule(realm, 'js/pmjs-core/optimizations.js');
  runModule(realm, 'js/pmjs-rpgmaker/lifecycle.js');
  const profile = require('../profiles/' + engine + '.json').modules;
  const module = 'js/pmjs-web/text-measurement-cache.js';
  assert.ok(profile.indexOf(module) > profile.indexOf('js/pmjs-web/canvas.js'));
  runModule(realm, module);
  if (beforeActivation) beforeActivation(realm);
  realm.PMJS.phases.emit('afterGuestPlugins');
  realm.PMJS.optimizations.finalize();
  const canvas = realm.document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const context = canvas.getContext('2d'); context.font = '24px GameFont';
  return { realm, canvas, context, calls: () => calls,
    stats: () => realm.PMJS.web.canvas.textMeasurements.diagnostics() };
}

test('both engine profiles reuse measurements by default and leave results caller-owned', () => {
  for (const engine of ['mv', 'mz']) {
    const h = fixture(undefined, true, engine);
    const first = h.context.measureText('AV'); first.width = 999;
    const next = h.context.measureText('AV');
    assert.equal(next.width, 26); assert.notEqual(first, next); assert.equal(h.calls(), 1);
    assert.equal(h.stats().hits, 1); assert.equal(h.stats().installed, true);
    const disabled = fixture(undefined, false, engine);
    disabled.context.measureText('AV'); disabled.context.measureText('AV');
    assert.equal(disabled.calls(), 2);
  }
});

test('font changes, coercion and custom host methods retain ordinary behavior', () => {
  const h = fixture(); h.context.measureText('AV');
  h.context.font = '25px GameFont'; h.context.measureText('AV');
  h.realm.PMJS.fonts.registerFace('GameFont', 'other.ttf'); h.context.measureText('AV');
  assert.equal(h.calls(), 3);
  let coerced = 0;
  const text = { toString() { coerced++; return 'AV'; } };
  h.context.measureText(text); h.context.measureText(text);
  assert.equal(coerced, 2); assert.equal(h.calls(), 3);
  assert.equal(h.context.measureText({ toString() { h.context.font = '32px GameFont'; return 'AV'; } }).width, 27);
  assert.equal(h.context.measureText('AV').width, 34);
  const custom = { width: 72 }; let replacements = 0;
  h.realm.NativeHost.canvas.measureTextMetrics = () => { replacements++; return custom; };
  assert.equal(h.context.measureText('AV'), custom); assert.equal(h.context.measureText('AV'), custom);
  assert.equal(replacements, 2);
});

test('installation preserves guest measurement replacements and reports refusal', () => {
  for (const engine of ['mv', 'mz']) for (const target of ['guest', 'native']) {
    let replacement;
    const h = fixture(undefined, true, engine, realm => {
      replacement = () => ({ width: 777 });
      if (target === 'guest') realm.measureCanvasText = replacement;
      else realm.NativeHost.canvas.measureTextMetrics = replacement;
    });
    assert.equal(h.context.measureText('AV').width, 777);
    assert.equal(target === 'guest' ? h.realm.measureCanvasText : h.realm.NativeHost.canvas.measureTextMetrics, replacement);
    assert.equal(h.realm.PMJS.web.canvas.textMeasurements, undefined);
    const state = h.realm.PMJS.optimizations.dump().find(entry => entry.id === id);
    assert.equal(state.enabled, false);
    assert.equal(state.disabledBy, 'refusal');
    assert.match(state.refusalReason, /text measurement/);
    assert.equal(h.calls(), 0);
  }
});

test('cached numeric formatting and text measurements activate together', () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const { pinSourceFingerprint } = require('./helpers/reviewed-function-fixture.cjs');
  const h = fixture(undefined, true, 'mv', realm => {
    vm.runInContext(`var Yanfly = { Param: { DigitGroup: true }, Util: {
      toGroup: function(value) { if (typeof value === 'string' || !Yanfly.Param.DigitGroup) return value; return value.toLocaleString('en'); }
    } };`, realm);
    realm.PMJS.plugins = {
      registerOptimization(_plugin, definition) { realm.PMJS.optimizations.register(definition); },
      onLoaded(_plugin, _owner, callback) { callback(); }
    };
    const adapters = require('../profiles/plugin-adapters.json').adapters;
    const modules = adapters.find(adapter => adapter.plugins.includes('YEP_CoreEngine')).modules;
    const module = 'js/pmjs-plugins/yanfly/core-number-format.js';
    assert.ok(modules.includes(module));
    const source = fs.readFileSync(path.join(__dirname, '..', module), 'utf8');
    vm.runInContext(pinSourceFingerprint(source, 'expected', realm.Yanfly.Util.toGroup), realm);
  });
  for (let i = 0; i < 2; i++) {
    const text = h.realm.Yanfly.Util.toGroup(1234567);
    assert.equal(text, '1,234,567'); assert.equal(h.context.measureText(text).width, 33);
  }
  assert.equal(h.calls(), 1); assert.equal(h.stats().hits, 1);
  assert.equal(h.realm.PMJS.plugins.numberFormat.diagnostics().formatted, 2);
});

test('cache retention is bounded and public measurement wrappers keep their side effects', () => {
  const h = fixture();
  for (let i = 0; i < 600; i++) h.context.measureText('glyph-' + i);
  assert.equal(h.stats().entries, 512);
  h.context.measureText('glyph-0'); assert.equal(h.calls(), 601);
  h.context.measureText('x'.repeat(257)); h.context.measureText('x'.repeat(257));
  assert.equal(h.calls(), 603);
  const wrapped = fixture();
  const original = wrapped.context.measureText; let wrappers = 0;
  Object.getPrototypeOf(wrapped.context).measureText = function(text) {
    wrappers++; return original.call(this, text);
  };
  wrapped.context.measureText('AV'); wrapped.context.measureText('AV');
  assert.equal(wrappers, 2); assert.equal(wrapped.calls(), 1);
});

test('cached and ordinary native metrics and pixels match across fonts and baselines', { skip: !process.env.PMJS_TEXT_CACHE_NATIVE }, () => {
  const native = require(path.resolve(process.env.PMJS_TEXT_CACHE_NATIVE));
  native.initialize({ gameRoot: path.join(__dirname, 'assets'), width: 32, height: 32, windowTitle: 'Text measurement cache' });
  const realms = [fixture(native, false), fixture(native, true)];
  let comparisons = 0;
  for (const font of ['24px GameFont', 'bold 24px GameFont', 'italic 23.5px GameFont'])
    for (const align of ['left', 'center', 'right']) for (const baseline of ['alphabetic', 'top', 'bottom']) {
      const frames = realms.map(h => {
        const context = h.context;
        context.font = font; context.textAlign = align; context.textBaseline = baseline;
        const metrics = context.measureText('AVATAR office'), repeat = context.measureText('AVATAR office');
        assert.deepEqual(repeat, metrics);
        context.clearRect(0, 0, 256, 64); context.fillStyle = '#627fbd'; context.fillText('AVATAR office', 128, 30);
        return { metrics: JSON.stringify(metrics), pixels: native.canvas.readPremultipliedPixels(h.canvas._ensureNativeCanvas().handle, 0, 0, 256, 64) };
      });
      assert.deepEqual(frames[1], frames[0], JSON.stringify({ font, align, baseline })); comparisons++;
    }
  assert.equal(comparisons, 27); assert.ok(realms[1].stats().hits > 0);
  realms.forEach(h => h.canvas._releaseNativeCanvas());
  assert.equal(native.canvas.memory().liveCount, 0);
});
