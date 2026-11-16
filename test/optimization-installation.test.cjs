'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadPmjsRuntime } = require('./helpers/runtime-context.cjs');

function fixture() {
  return loadPmjsRuntime({ console: { log() {}, error() {} } }, [
    'js/pmjs-core/config.js', 'js/pmjs-core/optimizations.js',
    'js/pmjs-core/methods.js', 'js/pmjs-rpgmaker/lifecycle.js', 'js/pmjs-rpgmaker/plugins.js'
  ]);
}

function definition(events, phase) {
  return { id: 'fixture.install', owner: 'fixture', fallback: 'guest behavior',
    phaseKey: 'fixture.install', phase, install() { events.push('installed'); } };
}

test('runtime installation registers policy immediately and runs once at the requested phase', () => {
  for (const phase of ['afterGuestPlugins', 'beforeBoot']) {
    const ctx = fixture(), events = [];
    ctx.PMJS.optimizations.install(definition(events, phase));
    assert.equal(ctx.PMJS.optimizations.isEnabled('fixture.install'), true);
    assert.deepEqual(events, []);
    ctx.PMJS.phases.emit('afterGuestPlugins');
    assert.deepEqual(events, phase === 'afterGuestPlugins' ? ['installed'] : []);
    ctx.PMJS.phases.emit('beforeBoot');
    ctx.PMJS.phases.emit(phase);
    assert.deepEqual(events, ['installed']);
  }
});

test('runtime installation keeps immediate activation when phase hooks are absent', () => {
  const ctx = fixture(), events = [];
  delete ctx.PMJS.phases;
  ctx.PMJS.optimizations.install(definition(events));
  assert.deepEqual(events, ['installed']);
});

test('plugin installation preserves load order within each phase', () => {
  const ctx = fixture(), events = [];
  for (const plugin of ['First', 'Second']) {
    const def = definition(events);
    def.id = plugin; def.phaseKey = plugin; def.install = () => events.push(plugin);
    ctx.PMJS.plugins.installOptimization(plugin, def);
  }
  ctx.PMJS.plugins.execute('Second', () => {});
  ctx.PMJS.plugins.execute('First', () => {});
  assert.deepEqual(events, []);
  ctx.PMJS.phases.emit('afterGuestPlugins');
  assert.deepEqual(events, ['Second', 'First']);
});

test('plugin installation honors beforeBoot and rejects unavailable dependencies', () => {
  for (const loaded of [true, false]) {
    const ctx = fixture(), events = [];
    ctx.PMJS.plugins.installOptimization('Fixture', definition(events, 'beforeBoot'));
    ctx.PMJS.plugins.snapshotEffectiveManifest([{ name: 'Fixture', status: true }]);
    if (loaded) ctx.PMJS.plugins.execute('Fixture', () => {});
    ctx.PMJS.plugins.finish();
    ctx.PMJS.phases.emit('afterGuestPlugins');
    assert.deepEqual(events, []);
    ctx.PMJS.phases.emit('beforeBoot');
    assert.deepEqual(events, loaded ? ['installed'] : []);
    assert.equal(ctx.PMJS.optimizations.isEnabled('fixture.install'), loaded);
  }
});

test('late registration and installer failures retain phase execution semantics', () => {
  for (const plugin of [false, true]) {
    const ctx = fixture();
    if (plugin) ctx.PMJS.plugins.execute('Fixture', () => {});
    ctx.PMJS.phases.emit('afterGuestPlugins');
    const error = new Error('installer failure');
    const def = definition([]); def.install = () => { throw error; };
    assert.throws(() => plugin ? ctx.PMJS.plugins.installOptimization('Fixture', def)
      : ctx.PMJS.optimizations.install(def), caught => caught === error);
    assert.throws(() => ctx.PMJS.phases.emit('afterGuestPlugins'), caught => caught === error);
  }
});

test('module-order plugin installers preserve early scheduling and still track guest availability', () => {
  const ctx = fixture(), events = [];
  for (const [plugin, order] of [['First', 'plugin'], ['Second', 'module']]) {
    const def = definition(events);
    def.id = plugin; def.phaseKey = plugin; def.order = order;
    def.install = () => events.push(plugin);
    ctx.PMJS.plugins.installOptimization(plugin, def);
  }
  ctx.PMJS.plugins.snapshotEffectiveManifest(['First', 'Second'].map(name => ({ name, status: true })));
  ctx.PMJS.plugins.execute('First', () => {});
  ctx.PMJS.plugins.execute('Second', () => {});
  ctx.PMJS.plugins.finish();
  ctx.PMJS.phases.emit('afterGuestPlugins');
  assert.deepEqual(events, ['Second', 'First']);
  assert.equal(ctx.PMJS.optimizations.isEnabled('Second'), true);
});
