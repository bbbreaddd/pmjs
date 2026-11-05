'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadPmjsRuntime, runModule } = require('./helpers/runtime-context.cjs');

const adapters = [
  ['yanfly/message-core', 'YEP_MessageCore', ['plugins.yanfly.message-word-wrap-measure']],
  ['yanfly/event-mini-label', 'YEP_EventMiniLabel', ['plugins.yanfly.event-mini-label']],
  ['yanfly/slippery-tiles', 'YEP_SlipperyTiles', ['plugins.yanfly.slippery-tiles']],
  ['yanfly/visual-atb-gauge', 'YEP_X_VisualATBGauge', ['plugins.yanfly.enemy-atb-refresh']],
  ['yed/tiled', 'YED_Tiled', ['tilemap.yed-indexed-paint-loops', 'tilemap.yed-indexed-animation', 'tilemap.yed-reflection-sprites']],
  ['olivia/horror-effects', 'Olivia_HorrorEffects', ['plugins.olivia.horror-effects']],
  ['terrax/lighting', 'Terrax_Lighting', ['terrax.native-lighting']],
];

for (const [adapter, plugin, ids] of adapters) {
  for (const state of ['unloaded', 'failed', 'disabled', 'not discovered']) {
    test(adapter + ' refuses an unavailable guest: ' + state, () => {
      const ctx = loadPmjsRuntime({ console: { log() {}, error() {} } });
      runModule(ctx, 'js/pmjs-plugins/' + adapter + '.js');
      ctx.PMJS.plugins.snapshotEffectiveManifest(state === 'not discovered'
        ? [] : [{ name: plugin, status: state !== 'disabled' }]);
      if (state === 'failed') {
        assert.throws(() => ctx.PMJS.plugins.execute(plugin,
          () => { throw new Error('guest load failed'); }), /guest load failed/);
      }
      ctx.PMJS.plugins.finish();
      ctx.PMJS.phases.emit('afterGuestPlugins');
      ctx.PMJS.optimizations.finalize();
      for (const id of ids) {
        assert.equal(ctx.PMJS.optimizations.isEnabled(id), false);
        assert.match(ctx.PMJS.optimizations.reason(id),
          new RegExp('required guest plugin .* unavailable: ' + state));
      }
    });
  }

  for (const policy of ['configuration', 'PMJS_DISABLE_OPT']) {
    test(adapter + ' preserves disable policy when the guest is unavailable: ' + policy, () => {
      const ctx = loadPmjsRuntime({
        console: { log() {}, error() {} },
        PMJS_GAME_CONFIG: policy === 'configuration' ? { disableOptimizations: ids } : {},
        NativeHost: { runtime: { env(name) {
          return policy === 'PMJS_DISABLE_OPT' && name === 'PMJS_DISABLE_OPT'
            ? ids.join(',') : undefined;
        } } },
      });
      runModule(ctx, 'js/pmjs-plugins/' + adapter + '.js');
      ctx.PMJS.plugins.snapshotEffectiveManifest([]);
      ctx.PMJS.plugins.finish();
      ctx.PMJS.phases.emit('afterGuestPlugins');
      ctx.PMJS.optimizations.finalize();
      for (const id of ids) {
        assert.equal(ctx.PMJS.optimizations.reason(id), 'disabled by ' + policy);
      }
    });
  }
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
