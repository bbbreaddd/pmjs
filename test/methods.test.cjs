'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { loadPmjsRuntime } = require('./helpers/runtime-context.cjs');

function context(extra = {}) {
  return loadPmjsRuntime(extra, ['js/pmjs-core/methods.js']);
}

function method(ctx, key) {
  return JSON.parse(JSON.stringify(ctx.PMJS.methods.dump().find(entry => entry.key === key)));
}

test('wrap installs once around the final guest method', () => {
  const calls = [];
  const target = { update() { calls.push('original'); } };
  const ctx = context({ host: { target, calls } });
  vm.runInContext(`PMJS.methods.wrap({ key: 'Sprite.update', id: 'pmjs.sprite',
    getTarget: () => host.target, method: 'update',
    wrap: next => function() { host.calls.push('pmjs'); return next.apply(this, arguments); } });`, ctx);
  target.update = function() { calls.push('plugin'); };
  assert.equal(ctx.PMJS.methods.install()[0].state, 'installed');
  target.update();
  assert.deepEqual(calls, ['pmjs', 'plugin']);
  assert.deepEqual([...ctx.PMJS.methods.install()], []);
});

test('owner replaces the final guest method', () => {
  const target = { render() { return 'guest'; } };
  const ctx = context({ target });
  vm.runInContext(`PMJS.methods.own({ key: 'Graphics.render', id: 'pmjs.renderer',
    getTarget: () => target, method: 'render',
    replace: () => function() { return 'native'; } });`, ctx);
  assert.equal(ctx.PMJS.methods.install()[0].state, 'installed');
  assert.equal(target.render(), 'native');
});

test('one registration per key and registration closes at install', () => {
  const target = { update() {} };
  const ctx = context({ target });
  const definition = `PMJS.methods.wrap({ key: 'K.update', id: 'first',
    getTarget: () => target, method: 'update', wrap: next => next })`;
  vm.runInContext(definition, ctx);
  assert.throws(() => vm.runInContext(definition, ctx), /already registered/);
  ctx.PMJS.methods.install();
  assert.throws(() => vm.runInContext(`PMJS.methods.wrap({ key: 'Later.update',
    id: 'late', getTarget: () => target, method: 'update', wrap: next => next })`, ctx),
    /after install/);
});

test('unavailable targets are skipped at installation', () => {
  const host = { target: null };
  const ctx = context({ host });
  vm.runInContext(`PMJS.methods.wrap({ key: 'K.update', id: 'pmjs.k',
    getTarget: () => host.target, method: 'update', wrap: next => next })`, ctx);
  assert.equal(ctx.PMJS.methods.install()[0].state, 'skipped');
  host.target = { update() { return 'guest'; } };
  assert.deepEqual([...ctx.PMJS.methods.install()], []);
  assert.equal(host.target.update(), 'guest');
});

test('plugin mutation audit records mutator and failure', () => {
  const target = { update() {} };
  const ctx = context({ target });
  vm.runInContext(`PMJS.methods.wrap({ key: 'K.update', id: 'pmjs.k',
    getTarget: () => target, method: 'update', wrap: next => next })`, ctx);
  const token = ctx.PMJS.methods.beginPlugin('Changer');
  target.update = function() {};
  ctx.PMJS.methods.endPlugin(token, { error: new Error('boom') });
  assert.deepEqual(method(ctx, 'K.update').mutations, [{ plugin: 'Changer', failed: true }]);
});
