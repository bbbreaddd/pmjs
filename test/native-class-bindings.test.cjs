'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installClassBindings } = require('../runner/native-class-bindings.cjs');

function fixture() {
  let next = 0, initializations = 0;
  function ExternalBase() {}
  ExternalBase.prototype.initialize = function() { ++initializations; };
  const scope = { ExternalBase }, session = {};
  const bindings = {
    describe() { return [
      { name: 'Counter', parent: 'ExternalBase', fields: [{ name: 'value', writable: true }], methods: [{ name: 'add', arity: 1 }] },
      { name: 'NamedCounter', parent: 'Counter', fields: [{ name: 'label', writable: false }], methods: [] }
    ]; },
    create(owner, type) { assert.equal(owner, session); return { identity: ++next, type, value: 0, label: type, active: true }; },
    field(handle, name, ...value) { if (value.length) handle[name] = value[0]; return handle[name]; },
    invoke(handle, method, args) { assert.equal(method, 'add'); return handle.value += args[0]; },
    active(handle) { return handle.active; }
  };
  const bridge = installClassBindings(scope, bindings, session);
  return { scope, bindings, bridge, session, initializations: () => initializations };
}

test('native descriptions generate inherited classes, fields and method signatures', () => {
  const { scope } = fixture();
  class Extended extends scope.NamedCounter {}
  const first = new Extended(), second = new scope.Counter();
  assert.ok(first instanceof scope.Counter); assert.ok(first instanceof scope.ExternalBase);
  assert.equal(first.label, 'NamedCounter', 'script subclasses must select the nearest native type');
  assert.equal(scope.Counter.name, 'Counter'); assert.equal(scope.Counter.prototype.add.length, 1);
  assert.equal(scope.Counter.prototype.add.name, 'add');
  assert.equal(first.add(3), 3); assert.equal(second.value, 0);
  first.value = 7; assert.equal(first.add(2), 9);
  assert.throws(() => { first.label = 'changed'; }, TypeError);
});

test('generated defaults support aliases and retain wrapper state while native models are active', () => {
  const { scope, bindings, bridge, session, initializations } = fixture();
  const handle = bindings.create(session, 'NamedCounter');
  let argumentsRead=false;
  assert.equal(bridge.overridden(handle,'NamedCounter','add'),false);
  assert.equal(bridge.dispatch(handle, 'NamedCounter', 'add', ()=> {argumentsRead=true;return [1];}), null);
  assert.equal(argumentsRead,false,'unchanged native methods must not materialize callback arguments');
  assert.equal(initializations(), 0, 'unchanged native methods must not construct script wrappers');
  const original = scope.Counter.prototype.add;
  const seen = [];
  scope.Counter.prototype.add = function(value) {
    this.calls = (this.calls || 0) + 1; seen.push(this); return original.call(this, value * 2);
  };
  assert.equal(bridge.overridden(handle,'NamedCounter','add'),true);
  assert.equal(bridge.dispatch(handle, 'NamedCounter', 'add', [2]).value, 4);
  bridge.dispatch(handle, 'NamedCounter', 'add', [3]);
  assert.equal(seen[0], seen[1]); assert.equal(seen[0].calls, 2); assert.equal(handle.value, 10);
  assert.equal(initializations(), 1);
  handle.active = false; bridge.sweep();
  assert.equal(seen[0].value, 10, 'retired wrappers must retain native model access');
});

test('reference arguments and constructor aliases preserve the original script object', () => {
  const calls = [], target = {}, nativeTarget = {}, handles = new WeakMap([[target, nativeTarget]]);
  function External() {}
  External.prototype.initialize = function() {};
  const scope = { External }, bindings = {
    describe: () => [{ name: 'Holder', parent: 'External', fields: [], initializer: 'setTarget', constructorDefaults: [null],
      methods: [{ name: 'setTarget', arity: 1, argumentKinds: ['object'], aliases: [{ property: '_target', index: 0 }] }] }],
    create: () => ({}), invoke(handle, method, args) { calls.push(args[0]); }, active: () => true
  };
  installClassBindings(scope, bindings, {}, { unwrap: object => handles.get(object) });
  const empty = new scope.Holder(); assert.equal(empty._target, null); assert.equal(calls[0], null);
  const holder = new scope.Holder(target);
  assert.equal(calls[1], nativeTarget); assert.equal(holder._target, target);
  assert.throws(() => holder.setTarget({}), /object argument is not bound/);
  assert.equal(calls.length, 2); assert.equal(holder._target, target);
  holder.setTarget(undefined); assert.equal(calls[2], null); assert.equal(holder._target, undefined);
});


test('derived initializer aliases enter later parent overrides without duplicating native construction', () => {
  const { scope, initializations } = fixture(), calls = [];
  const childInitialize = scope.NamedCounter.prototype.initialize;
  scope.NamedCounter.prototype.initialize = function(...args) { calls.push('child'); childInitialize.apply(this, args); this.pluginChild = true; };
  const parentInitialize = scope.Counter.prototype.initialize;
  scope.Counter.prototype.initialize = function(...args) { calls.push('parent'); parentInitialize.apply(this, args); this.pluginParent = true; };
  const object = new scope.NamedCounter();
  assert.deepEqual(calls, ['child', 'parent']); assert.equal(initializations(), 1);
  assert.equal(object.label, 'NamedCounter'); assert.equal(object.pluginChild, true); assert.equal(object.pluginParent, true);
});


test('native-created descendant initializers dispatch later parent overrides', () => {
  const { scope, bindings, bridge, session, initializations } = fixture();
  const initialize = scope.Counter.prototype.initialize;
  let calls = 0;
  scope.Counter.prototype.initialize = function(...args) { ++calls; initialize.apply(this, args); this.pluginParent = true; };
  const handle = bindings.create(session, 'NamedCounter');
  assert.deepEqual(bridge.dispatch(handle, 'NamedCounter', 'initialize', []), { value: undefined });
  assert.equal(calls, 1); assert.equal(initializations(), 1);
  assert.equal(bridge.wrap(handle, 'NamedCounter').pluginParent, true);
});
