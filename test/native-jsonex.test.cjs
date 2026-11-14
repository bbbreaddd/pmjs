'use strict';
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { installJsonEx } = require('../runner/native-jsonex.cjs');

test('JsonEx copies plugin objects with cycles, shared arrays and prototypes without running constructors', () => {
  const scope = {}, context = vm.createContext(scope);
  const runScript = source => vm.runInContext(source, context);
  installJsonEx({ scope, runScript });
  runScript(`
    let constructions = 0;
    function PluginData() { ++constructions; this.value = 3; }
    PluginData.prototype.answer = function() { return this.value * 2; };
    var source = new PluginData();
    source.array = [source]; source.alias = source.array; source.self = source;
    var copy = JsonEx.makeDeepCopy(source);
    if (constructions !== 1 || !(copy instanceof PluginData) || copy.answer() !== 6) throw new Error('prototype mismatch');
    if (copy === source || copy.self !== copy || copy.array[0] !== copy || copy.array !== copy.alias) throw new Error('identity mismatch');
    if (!(copy.array instanceof Array) || Object.keys(copy).some(key => key.startsWith('@'))) throw new Error('metadata mismatch');
  `);
  assert.equal(scope.source.self, scope.source);
  assert.equal(Object.hasOwn(scope.source, '@c'), false);
  const original = scope.JsonEx.stringify;
  let calls = 0;
  scope.JsonEx.stringify = function(...args) { ++calls; return original.apply(this, args); };
  scope.JsonEx.makeDeepCopy({ value: 1 }); assert.equal(calls, 1);
  scope.JsonEx.maxDepth = 1;
  assert.throws(() => scope.JsonEx.stringify({ nested: { tooDeep: {} } }), /nesting limit/);
});
