'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadPmjsRuntime } = require('./helpers/runtime-context.cjs');
function bootContext() {
  const events = [], target = { update() { return 'guest'; } };
  const ctx = loadPmjsRuntime({
    target, PMJS_MANUAL_BOOTSTRAP: true, $plugins: [{ name: 'Example', status: true }],
    console: { log() {}, error() {} }, nativeBootPhase: phase => events.push(phase),
    window: { dispatchEvent() { events.push('load'); }, onload() { events.push('scene'); } },
  });
  ctx.PluginManager = { setup() { ctx.PMJS.plugins.execute('Example', () => events.push('guest')); } };
  for (const file of ['js/pmjs-rpgmaker/bootstrap.js', 'js/pmjs-mv/bootstrap.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ctx);
  ctx.PMJS.plugins.snapshotOriginalManifest(ctx.$plugins);
  return { ctx, events, target, initialize: () => ctx.pmjsInitializeRpgMakerPlugins(() => {}) };
}
for (const failure of ['loaded', 'phase', 'method', 'beforeBoot']) {
  test('real MV boot stops and preserves unexpected ' + failure + ' installer failure', () => {
    const { ctx, events, target, initialize } = bootContext();
    const error = new Error(failure + ' failed');
    const explode = () => { target.partial = true; throw error; };
    if (failure === 'loaded') ctx.PMJS.plugins.onLoaded('Example', 'test', explode);
    if (failure === 'phase') ctx.PMJS.phases.on('afterGuestPlugins', 'test', explode);
    if (failure === 'beforeBoot') ctx.PMJS.phases.on('beforeBoot', 'test', explode);
    if (failure === 'method') ctx.PMJS.methods.wrap({ key: 'Test.update', id: 'test',
      method: 'update', getTarget: () => target, wrap: explode });
    const run = failure === 'beforeBoot' ? () => { ctx.pmjsMvStart(); } : initialize;
    if (failure === 'beforeBoot') initialize();
    assert.throws(run, error);
    assert.throws(run, error, 'Repeated boot cannot conceal a partially completed installer');
    assert.ok(target.partial);
    assert.ok(!events.includes('scene') && !events.includes('scene-boot-started'));
    if (failure !== 'beforeBoot') assert.ok(!events.includes('plugins-loaded'));
    if (failure === 'method') {
      assert.equal(ctx.PMJS.methods.dump()[0].state, 'failed');
      assert.equal(target.update(), 'guest');
      assert.throws(() => ctx.PMJS.methods.install(), error);
    }
    if (failure === 'phase') assert.throws(() => ctx.PMJS.phases.emit('afterGuestPlugins'), error);
  });
}
test('real MV boot preserves optional missing targets and explicit optimization refusal', () => {
  const { ctx, initialize, events } = bootContext();
  ctx.PMJS.methods.wrap({ key: 'Optional.update', id: 'optional', method: 'update', getTarget: () => null, wrap: next => next });
  ctx.PMJS.plugins.registerOptimization('Example', { id: 'optional', owner: 'test', fallback: 'guest' });
  ctx.PMJS.phases.on('afterGuestPlugins', () => ctx.PMJS.optimizations.refuse('optional', 'unsupported optional target'));
  initialize(); ctx.pmjsMvStart();
  assert.equal(ctx.PMJS.methods.dump()[0].state, 'skipped');
  assert.equal(ctx.PMJS.optimizations.isEnabled('optional'), false);
  assert.ok(events.includes('scene-boot-started'));
});
