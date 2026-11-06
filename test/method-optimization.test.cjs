'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadPmjsRuntime } = require('./helpers/runtime-context.cjs');

function fixture({ phases = true, disabled = false } = {}) {
  const ctx = loadPmjsRuntime({
    __pmjsBuiltinRequire: require,
    PMJS_GAME_CONFIG: { disableOptimizations: disabled ? ['fixture.native'] : [] }
  }, [
    'js/pmjs-core/config.js', 'js/pmjs-core/optimizations.js',
    'js/pmjs-core/methods.js', 'js/pmjs-rpgmaker/lifecycle.js'
  ]);
  if (!phases) delete ctx.PMJS.phases;
  const target = { run(value) { return this.offset + value; }, offset: 4 };
  const original = target.run;
  const definition = {
    id: 'fixture.native', owner: 'fixture', fallback: 'original method',
    getTarget: () => target, method: 'run', recognized: original.toString(),
    refusalReason: 'modified fixture method', phaseKey: 'fixture.native',
    replace: next => function(value) { return next.call(this, value) * 2; }
  };
  return { ctx, target, original, definition,
    activate: () => ctx.PMJS.phases.emit('afterGuestPlugins') };
}

test('optimization waits for guest plugins and captures the original fallback', () => {
  const { ctx, target, original, definition, activate } = fixture();
  let captured;
  definition.replace = next => {
    captured = next;
    return function(...args) { return next.apply(this, args) * 2; };
  };
  ctx.PMJS.methods.optimize(definition);
  assert.equal(target.run, original);
  activate();
  assert.equal(captured, original);
  assert.equal(target.run(3), 14);
  assert.deepEqual([...ctx.PMJS.methods.dump()], []);
});

test('optimization activates immediately without a phase dispatcher', () => {
  const { ctx, target, definition } = fixture({ phases: false });
  ctx.PMJS.methods.optimize(definition);
  assert.equal(target.run(3), 14);
});

test('disabled optimizations retain the original without building a replacement', () => {
  const { ctx, target, original, definition, activate } = fixture({ disabled: true });
  definition.replace = () => assert.fail('disabled replacement built');
  ctx.PMJS.methods.optimize(definition);
  activate();
  assert.equal(target.run, original);
  assert.equal(ctx.PMJS.optimizations.reason(definition.id), 'disabled by configuration');
});

test('unrecognized source and guest replacements refuse without replacing guest behavior', () => {
  for (const change of ['source', 'plugin']) {
    const { ctx, target, original, definition, activate } = fixture();
    if (change === 'source') definition.recognized = 'unrecognized';
    definition.replace = () => assert.fail('refused replacement built');
    ctx.PMJS.methods.optimize(definition);
    const effective = change === 'plugin' ? function() { return 'plugin'; } : original;
    target.run = effective;
    activate();
    assert.equal(target.run, effective);
    assert.equal(ctx.PMJS.optimizations.reason(definition.id), 'refused: modified fixture method');
  }
});

test('non-function methods are not registered or scheduled', () => {
  const { ctx, target, definition, activate } = fixture();
  target.run = null;
  ctx.PMJS.methods.optimize(definition);
  activate();
  assert.equal(target.run, null);
  assert.throws(() => ctx.PMJS.optimizations.reason(definition.id), /Unknown PMJS optimization/);
});

test('builder and assignment errors propagate without changing the method', () => {
  for (const failure of ['builder', 'assignment']) {
    const { ctx, target, original, definition, activate } = fixture();
    const error = new Error(failure);
    if (failure === 'builder') definition.replace = () => { throw error; };
    else Object.defineProperty(target, 'run', {
      get: () => original, set() { throw error; }
    });
    ctx.PMJS.methods.optimize(definition);
    assert.throws(activate, caught => caught === error);
    assert.equal(target.run, original);
  }
});
