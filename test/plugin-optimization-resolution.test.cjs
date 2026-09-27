'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { loadPmjsRuntime } = require('./helpers/runtime-context.cjs');

const adapters = [
  ['yanfly/event-mini-label', 'YEP_EventMiniLabel', ['plugins.yanfly.event-mini-label']],
  ['yanfly/slippery-tiles', 'YEP_SlipperyTiles', ['plugins.yanfly.slippery-tiles']],
  ['yed/tiled', 'YED_Tiled', ['tilemap.yed-indexed-paint-loops', 'tilemap.yed-indexed-animation']],
  ['olivia/horror-effects', 'Olivia_HorrorEffects', ['plugins.olivia.horror-effects']],
  ['terrax/lighting', 'Terrax_Lighting', ['terrax.native-lighting']],
];

for (const [adapter, plugin, ids] of adapters) {
  for (const state of ['unloaded', 'failed', 'disabled', 'not discovered']) {
    test(adapter + ' refuses an unavailable guest: ' + state, () => {
      const ctx = loadPmjsRuntime({ console: { log() {}, error() {} } });
      vm.runInContext(fs.readFileSync(path.join(__dirname,
        '../js/pmjs-plugins/' + adapter + '.js'), 'utf8'), ctx);
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

  for (const policy of ['port', 'PMJS_DISABLE_OPT']) {
    test(adapter + ' preserves disable policy when the guest is unavailable: ' + policy, () => {
      const ctx = loadPmjsRuntime({
        console: { log() {}, error() {} },
        PMJS_GAME_CONFIG: policy === 'port' ? { disableOptimizations: ids } : {},
        NativeHost: { runtime: { env(name) {
          return policy === 'PMJS_DISABLE_OPT' && name === 'PMJS_DISABLE_OPT'
            ? ids.join(',') : undefined;
        } } },
      });
      vm.runInContext(fs.readFileSync(path.join(__dirname,
        '../js/pmjs-plugins/' + adapter + '.js'), 'utf8'), ctx);
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
