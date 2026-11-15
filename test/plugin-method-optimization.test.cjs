'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadPmjsRuntime } = require('./helpers/runtime-context.cjs');

function fixture({ disabled = false } = {}) {
  const ctx = loadPmjsRuntime({
    console: { log() {}, error() {} }, __pmjsBuiltinRequire: require,
    PMJS_GAME_CONFIG: { disableOptimizations: disabled ? ['fixture.method'] : [] }
  });
  const target = { offset: 4, run(value) { return this.offset + value; } };
  const definition = {
    plugin: 'Fixture', id: 'fixture.method', owner: 'fixture', fallback: 'guest method',
    phaseKey: 'fixture.method', getTarget: () => target, method: 'run',
    recognized: target.run.toString(), refusalReason: 'unrecognized guest method',
    replace: original => function(...args) { return original.apply(this, args) * 2; }
  };
  const load = () => ctx.PMJS.plugins.execute('Fixture', () => {});
  const activate = () => ctx.PMJS.phases.emit('afterGuestPlugins');
  return { ctx, target, definition, load, activate };
}

test('plugin optimization resolves the final target only after the plugin and phase complete', () => {
  const { ctx, target, definition, load, activate } = fixture();
  let effective;
  definition.getTarget = () => { assert.ok(effective); return effective; };
  ctx.PMJS.plugins.optimizeMethod(definition);
  load();
  effective = Object.create(target);
  const original = effective.run;
  activate();
  assert.equal(target.run, original);
  assert.equal(effective.run(3), 14);
  const installed = effective.run;
  activate();
  assert.equal(effective.run, installed);
  assert.deepEqual([...ctx.PMJS.methods.dump()], []);
});

test('a reviewed final method is captured instead of a method present before plugins load', () => {
  const { ctx, target, definition, load, activate } = fixture();
  const reviewed = target.run;
  target.run = () => 'pre-plugin';
  ctx.PMJS.plugins.optimizeMethod(definition);
  load();
  target.run = reviewed;
  activate();
  assert.equal(target.run(3), 14);
});

test('disabled plugin optimization never resolves or builds the replacement', () => {
  const { ctx, definition, load, activate } = fixture({ disabled: true });
  definition.getTarget = () => assert.fail('disabled target resolved');
  definition.replace = () => assert.fail('disabled replacement built');
  ctx.PMJS.plugins.optimizeMethod(definition);
  load();
  activate();
  assert.equal(ctx.PMJS.optimizations.reason(definition.id), 'disabled by configuration');
});

test('missing targets and unrecognized methods retain distinct refusal reasons', () => {
  for (const unavailableReason of [undefined, 'method unavailable']) {
    for (const missing of [true, false]) {
      const { ctx, target, definition, load, activate } = fixture();
      definition.unavailableReason = unavailableReason;
      const original = target.run;
      definition.getTarget = () => missing ? null : target;
      if (!missing) definition.recognized = 'unknown';
      definition.replace = () => assert.fail('refused replacement built');
      ctx.PMJS.plugins.optimizeMethod(definition);
      load(); activate();
      assert.equal(target.run, original);
      assert.equal(ctx.PMJS.optimizations.reason(definition.id),
        'refused: ' + (missing && unavailableReason || definition.refusalReason));
    }
  }
});

test('plugin method installation preserves resolver, builder and assignment errors', () => {
  for (const failure of ['resolver', 'builder', 'setter', 'locked']) {
    const { ctx, target, definition, load, activate } = fixture();
    const original = target.run;
    const error = new Error(failure);
    if (failure === 'resolver') definition.getTarget = () => { throw error; };
    if (failure === 'builder') definition.replace = () => { throw error; };
    if (failure === 'setter') Object.defineProperty(target, 'run', {
      get: () => original, set() { throw error; }
    });
    if (failure === 'locked') Object.defineProperty(target, 'run', { writable: false });
    ctx.PMJS.plugins.optimizeMethod(definition);
    load();
    assert.throws(activate, caught => failure === 'locked' ? caught.name === 'TypeError' : caught === error);
    assert.equal(target.run, original);
  }
});
