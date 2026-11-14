'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { nativeArray } = require('../runner/native-array.cjs');

test('live native arrays preserve guest prototypes and original records without adopting replacement arrays', () => {
  const realm = vm.createContext({}), first = { id: 1 }, second = { id: 2 }, allowed = new Set([first, second, null]);
  let native = [first, second];
  const array = nativeArray(() => vm.runInContext('[]', realm), () => native.slice(), values => {
    if (Array.from(values).some(value => !allowed.has(value))) throw new TypeError('unregistered record');
    native = Array.from(values);
  });
  assert.ok(array.view instanceof vm.runInContext('Array', realm));
  assert.equal(array.view[0], first); array.view.reverse(); assert.equal(native[0], second);
  const replacement = [first]; array.replace(replacement); replacement.push(second);
  assert.equal(array.view.length, 1); assert.equal(array.view[0], first);
  assert.throws(() => { array.view[0] = {}; }, /unregistered/); assert.equal(native[0], first);
  vm.runInContext('globalThis.splices = 0; const original = Array.prototype.splice; Array.prototype.splice = function(...args) { ++splices; return original.apply(this, args); }', realm);
  assert.equal(array.view.length, 1); assert.equal(vm.runInContext('splices', realm), 0);
  array.view.splice(0, 1, second); assert.equal(native[0], second); assert.equal(vm.runInContext('splices', realm), 1);
});

test('native array reads take one current snapshot and preserve ordinary plugin arrays', () => {
  const { readNativeArray } = require('../runner/native-array.cjs');
  let values = [12, -8, 20], reads = 0;
  const { view } = nativeArray(() => [], () => { ++reads; return values.slice(); }, next => { values = next; });
  assert.deepEqual(readNativeArray(view), [12, -8, 20]); assert.equal(reads, 1);
  view[1] = 30;
  assert.deepEqual(readNativeArray(view), [12, 30, 20]);
  values = [1, 2, 3]; assert.deepEqual(readNativeArray(view), values);
  const plugin = [4, 5, 6]; assert.equal(readNativeArray(plugin), plugin);
  const getters = { get 0() { return ++reads; } };
  assert.equal(readNativeArray(getters), getters);
});
