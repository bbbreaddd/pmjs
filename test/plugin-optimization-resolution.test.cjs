'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadPmjsRuntime, runModule } = require('./helpers/runtime-context.cjs');

const adapters = [
  ['yanfly/core-engine', 'YEP_CoreEngine', ['plugins.yanfly.core-native-text', 'plugins.yanfly.core-number-format']],
  ['yanfly/message-core', 'YEP_MessageCore', ['plugins.yanfly.message-word-wrap-measure']],
  ['yanfly/event-mini-label', 'YEP_EventMiniLabel', ['plugins.yanfly.event-mini-label']],
  ['yanfly/event-copier', 'YEP_EventCopier', ['plugins.yanfly.event-copier-preload']],
  ['yanfly/slippery-tiles', 'YEP_SlipperyTiles', ['plugins.yanfly.slippery-tiles']],
  ['yanfly/visual-atb-gauge', 'YEP_X_VisualATBGauge', ['plugins.yanfly.enemy-atb-refresh']],
  ['yed/tiled', 'YED_Tiled', ['tilemap.yed-indexed-paint-loops', 'tilemap.yed-indexed-animation', 'tilemap.yed-reflection-sprites']],
  ['olivia/horror-effects', 'Olivia_HorrorEffects', ['plugins.olivia.horror-effects']],
  ['terrax/lighting', 'Terrax_Lighting', ['terrax.native-lighting']],
];

for (const state of ['unloaded', 'failed', 'disabled', 'not discovered']) {
  test('shared plugin policy refuses an unavailable guest: ' + state, () => {
    const ctx = loadPmjsRuntime({ console: { log() {}, error() {} } });
    ctx.PMJS.plugins.registerOptimization('TestGuest', {
      id: 'test.guest', owner: 'test', fallback: 'original',
    });
    ctx.PMJS.plugins.snapshotEffectiveManifest(state === 'not discovered'
      ? [] : [{ name: 'TestGuest', status: state !== 'disabled' }]);
    if (state === 'failed') {
      assert.throws(() => ctx.PMJS.plugins.execute('TestGuest',
        () => { throw new Error('guest load failed'); }), /guest load failed/);
    }
    ctx.PMJS.plugins.finish();
    ctx.PMJS.optimizations.finalize();
    assert.equal(ctx.PMJS.optimizations.isEnabled('test.guest'), false);
    assert.match(ctx.PMJS.optimizations.reason('test.guest'),
      new RegExp('required guest plugin .* unavailable: ' + state));
  });
}

for (const policy of ['configuration', 'PMJS_DISABLE_OPT']) {
  test('shared plugin policy preserves disable policy when the guest is unavailable: ' + policy, () => {
    const ctx = loadPmjsRuntime({
      console: { log() {}, error() {} },
      PMJS_GAME_CONFIG: policy === 'configuration' ? { disableOptimizations: ['test.guest'] } : {},
      NativeHost: { runtime: { env: name => policy === 'PMJS_DISABLE_OPT' && name === 'PMJS_DISABLE_OPT' ? 'test.guest' : undefined } },
    });
    ctx.PMJS.plugins.registerOptimization('TestGuest', {
      id: 'test.guest', owner: 'test', fallback: 'original',
    });
    ctx.PMJS.plugins.snapshotEffectiveManifest([]);
    ctx.PMJS.plugins.finish();
    ctx.PMJS.optimizations.finalize();
    assert.equal(ctx.PMJS.optimizations.reason('test.guest'), 'disabled by ' + policy);
  });
}

for (const [adapter, plugin, ids] of adapters) {
  test(adapter + ' registers its guest dependency with the shared optimization registry', () => {
    const unavailable = loadPmjsRuntime({ console: { log() {}, error() {} } });
    runModule(unavailable, 'js/pmjs-plugins/' + adapter + '.js');
    unavailable.PMJS.plugins.snapshotEffectiveManifest([]);
    unavailable.PMJS.plugins.finish();
    unavailable.PMJS.optimizations.finalize();

    const available = loadPmjsRuntime({ console: { log() {}, error() {} } });
    runModule(available, 'js/pmjs-plugins/' + adapter + '.js');
    available.PMJS.plugins.snapshotEffectiveManifest([{ name: plugin, status: true }]);
    available.PMJS.plugins.execute(plugin, () => {});
    available.PMJS.plugins.finish();
    available.PMJS.optimizations.finalize();

    for (const id of ids) {
      assert.equal(unavailable.PMJS.optimizations.isEnabled(id), false);
      assert.match(unavailable.PMJS.optimizations.reason(id), /required guest plugin .* unavailable/);
      assert.equal(available.PMJS.optimizations.isEnabled(id), true);
    }
  });
}

test('successful guest resolution preserves enabled state and normalizes plugin names', () => {
  const ctx = loadPmjsRuntime({ console: { log() {}, error() {} } });
  ctx.PMJS.plugins.registerOptimization('Guest.js', {
    id: 'test.guest', owner: 'test', fallback: 'original guest method',
  });
  ctx.PMJS.plugins.snapshotEffectiveManifest([{ name: 'GUEST' }]);
  ctx.PMJS.plugins.execute('guest', () => {});
  assert.equal(ctx.PMJS.plugins.finish(), true);
  assert.equal(ctx.PMJS.plugins.finish(), false);
  ctx.PMJS.optimizations.finalize();
  assert.equal(ctx.PMJS.optimizations.reason('test.guest'), 'enabled');
  assert.throws(() => ctx.PMJS.plugins.registerOptimization('guest', {
    id: 'test.late', owner: 'test', fallback: 'original',
  }), /registration after resolution/);
});
