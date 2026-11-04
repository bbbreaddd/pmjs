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

test('wrap sees a guest replacement made after registration', () => {
  const ctx = context();
  vm.runInContext(`
    function Target() {}
    Target.prototype.foo = function() { return 'stock'; };
    globalThis.Target = Target;
    PMJS.methods.wrap({ key: 'Target.foo', id: 'pmjs.target',
      getTarget: () => Target.prototype, method: 'foo',
      wrap: guestFoo => function() { return 'pmjs:' + guestFoo.apply(this, arguments); } });
    Target.prototype.foo = function() { return 'plugin'; };
  `, ctx);
  ctx.PMJS.methods.install();
  assert.equal(vm.runInContext('new Target().foo()', ctx), 'pmjs:plugin');
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

test('installation resolves a target once and preserves resolver, getter, builder and setter errors', () => {
  for (const failure of ['resolver', 'getter', 'builder', 'setter']) {
    const ctx = context();
    const error = new Error(failure);
    let resolutions = 0;
    const target = failure === 'getter' ? Object.defineProperty({}, 'update', { get() { throw error; } }) :
      failure === 'setter' ? Object.defineProperty({}, 'update', { get() { return () => {}; }, set() { throw error; } }) :
      { update() {} };
    ctx.PMJS.methods.wrap({ key: 'K.update', id: 'pmjs.k', method: 'update',
      getTarget() { resolutions++; if (failure === 'resolver') throw error; return target; },
      wrap(next) { if (failure === 'builder') throw error; return next; } });
    assert.throws(() => ctx.PMJS.methods.install(), caught => caught === error);
    assert.equal(resolutions, 1);
    assert.equal(method(ctx, 'K.update').state, 'failed');
    assert.equal(method(ctx, 'K.update').reason, failure);
    assert.throws(() => ctx.PMJS.methods.install(), caught => caught === error);
    assert.equal(resolutions, 1, 'a failed installation cannot mutate targets on retry');
  }
});

test('non-function methods remain explicit skips', () => {
  const ctx = context();
  ctx.PMJS.methods.own({ key: 'K.update', id: 'pmjs.k', method: 'update',
    getTarget: () => ({ update: 42 }), replace: () => () => {} });
  assert.equal(ctx.PMJS.methods.install()[0].state, 'skipped');
  assert.equal(method(ctx, 'K.update').reason, 'method is not a function');
});

test('falsy thrown values are sticky installation failures', () => {
  for (const error of [null, undefined, false, 0, '']) {
    const ctx = context();
    let resolutions = 0;
    ctx.PMJS.methods.wrap({ key: 'K.update', id: 'pmjs.k', method: 'update',
      getTarget() { resolutions++; throw error; }, wrap: next => next });
    assert.throws(() => ctx.PMJS.methods.install(), caught => caught === error);
    assert.throws(() => ctx.PMJS.methods.install(), caught => caught === error);
    assert.equal(resolutions, 1);
    assert.equal(method(ctx, 'K.update').state, 'failed');
  }
});

test('formatting an installation error cannot replace it or lose the failed state', () => {
  const ctx = context();
  const error = { get message() { throw new Error('formatting failure'); } };
  ctx.PMJS.methods.wrap({ key: 'K.update', id: 'pmjs.k', method: 'update',
    getTarget() { throw error; }, wrap: next => next });
  assert.throws(() => ctx.PMJS.methods.install(), caught => caught === error);
  assert.throws(() => ctx.PMJS.methods.install(), caught => caught === error);
  assert.equal(method(ctx, 'K.update').state, 'failed');
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

test('plugin audits observe accessors without invoking them and track descriptor changes', () => {
  let reads = 0;
  const target = Object.create(Object.defineProperty({}, 'update', {
    configurable: true, get() { reads++; throw new Error('guest getter'); }
  }));
  const ctx = context();
  ctx.PMJS.methods.wrap({ key: 'K.update', id: 'pmjs.k', method: 'update',
    getTarget: () => target, wrap: next => next });
  const unchanged = ctx.PMJS.methods.beginPlugin('Unchanged');
  ctx.PMJS.methods.endPlugin(unchanged);
  assert.equal(reads, 0);
  assert.deepEqual(method(ctx, 'K.update').mutations, []);
  const changed = ctx.PMJS.methods.beginPlugin('Changer');
  Object.defineProperty(target, 'update', { value() {}, configurable: true });
  ctx.PMJS.methods.endPlugin(changed);
  assert.equal(reads, 0);
  assert.deepEqual(method(ctx, 'K.update').mutations, [{ plugin: 'Changer', failed: false }]);
});

test('unavailable audit evidence cannot prevent plugin execution or replace its error', () => {
  const ctx = context();
  const error = new Error('unavailable resolver');
  ctx.PMJS.methods.wrap({ key: 'K.update', id: 'pmjs.k', method: 'update',
    getTarget() { throw error; }, wrap: next => next });
  const token = ctx.PMJS.methods.beginPlugin('Guest');
  assert.equal(ctx.PMJS.methods.endPlugin(token, { failed: true }), 'Guest');
  assert.deepEqual(method(ctx, 'K.update').mutations, []);
  assert.throws(() => ctx.PMJS.methods.install(), caught => caught === error);
});

test('ignored method assignments fail installation and cannot be retried', () => {
  const guest = () => 'guest';
  const target = Object.defineProperty({}, 'update', { get: () => guest, set() {} });
  const ctx = context();
  ctx.PMJS.methods.own({ key: 'K.update', id: 'pmjs.k', method: 'update',
    getTarget: () => target, replace: () => () => 'native' });
  let error;
  assert.throws(() => ctx.PMJS.methods.install(), caught => {
    error = caught;
    return /replacement did not become the effective method/.test(caught.message);
  });
  assert.equal(target.update(), 'guest');
  assert.equal(method(ctx, 'K.update').state, 'failed');
  assert.throws(() => ctx.PMJS.methods.install(), caught => caught === error);
});

test('wrap composes around subclass methods capturing the parent', () => {
  const ctx = context();
  vm.runInContext(`
    function Base() {}
    Base.prototype.foo = function() { return ['stock']; };
    function Child() {}
    Child.prototype = Object.create(Base.prototype);
    globalThis.Child = Child;
    // Simulated guest plugin: capture the inherited method, then override.
    var captured = Child.prototype.foo;
    Child.prototype.foo = function() {
      return ['plugin'].concat(captured.call(this));
    };
    PMJS.methods.wrap({ key: 'Child.foo', id: 'pmjs.child',
      getTarget: () => Child.prototype, method: 'foo',
      wrap: next => function() {
        return ['pmjs'].concat(next.call(this));
      } });
  `, ctx);
  ctx.PMJS.methods.install();
  assert.deepEqual([...vm.runInContext('new Child().foo()', ctx)], [
    'pmjs', 'plugin', 'stock',
  ]);
});

test('dump reports owner, state, and mutation attribution', () => {
  const target = { update() { return 'guest'; } };
  const ctx = context({ target });
  vm.runInContext(`PMJS.methods.wrap({ key: 'K.update', id: 'pmjs.k',
    getTarget: () => target, method: 'update', wrap: next => next })`, ctx);
  const token = ctx.PMJS.methods.beginPlugin('Changer');
  target.update = function() { return 'changed'; };
  ctx.PMJS.methods.endPlugin(token);
  ctx.PMJS.methods.install();
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.PMJS.methods.dump())), [{
    key: 'K.update', id: 'pmjs.k', mode: 'wrap',
    state: 'installed', reason: 'installed',
    mutations: [{ plugin: 'Changer', failed: false }],
  }]);
  assert.equal(target.update(), 'changed');
});

test('source matching retains literal whitespace, comments and parameters', () => {
  const { createHash } = require('node:crypto');
  const ctx = context({ __pmjsBuiltinRequire: require });
  const compile = source => vm.runInNewContext('(' + source + ')');
  const hash = fn => createHash('sha256').update(Function.prototype.toString.call(fn)).digest('hex');
  const matches = ctx.PMJS.methods.matchesSource;
  for (const [source, changed] of [
    ["function() { return 'a b'; }", "function() { return 'ab'; }"],
    ["function() { return 'a/*b*/c'; }", "function() { return 'ac'; }"],
    ['function() { return /a b/; }', 'function() { return /ab/; }'],
    ['function(value) { return value; }', 'function(other) { return value; }'],
  ]) {
    const original = compile(source), replacement = compile(changed);
    assert.equal(matches(original, hash(original)), true);
    assert.equal(matches(replacement, hash(original)), false);
    assert.equal(matches(replacement, [hash(original), hash(replacement)]), true);
  }
  const original = compile('function() { return 1; }');
  vm.runInContext('Function.prototype.toString = function() { return "spoofed"; };', ctx);
  assert.equal(matches(original, hash(original)), true);
  assert.equal(matches(null, null), false);
  delete ctx.__pmjsBuiltinRequire;
  assert.equal(matches(original, hash(original)), false);
});

test('unrecognized source leaves the effective guest method as the original fallback', () => {
  const { createHash } = require('node:crypto');
  const reviewed = function() { return 'reviewed'; };
  const expected = createHash('sha256').update(reviewed.toString()).digest('hex');
  for (const original of [reviewed, function() { return 'guest replacement'; }]) {
    const target = { update: original };
    const ctx = context({ __pmjsBuiltinRequire: require });
    ctx.PMJS.methods.own({ key: 'Target.update', id: 'test.source', method: 'update',
      getTarget: () => target,
      replace: guest => ctx.PMJS.methods.matchesSource(guest, expected) ? () => 'optimized' : guest
    });
    ctx.PMJS.methods.install();
    assert.equal(target.update(), original === reviewed ? 'optimized' : 'guest replacement');
    if (original !== reviewed) assert.equal(target.update, original);
  }
});

test('cached modules keep globals, prototypes, task queues and native hosts isolated', async t => {
  function fixture() {
    return loadPmjsRuntime({ performance, __pmjsBuiltinRequire: require,
      NativeHost: { calls: [] } }, ['js/pmjs-core/methods.js', 'js/pmjs-web/scheduler.js']);
  }
  const first = fixture(), second = fixture();
  t.after(() => { first.PMJS.tasks.stop(); second.PMJS.tasks.stop(); });
  vm.runInContext(`globalThis.marker = 1; Object.prototype.marker = 2;
    PMJS.methods.wrap({ key: 'first', id: 'fixture', getTarget: () => NativeHost,
      method: 'update', wrap: next => next });`, first);
  assert.equal(vm.runInContext('typeof marker', second), 'undefined');
  assert.equal(vm.runInContext('Object.prototype.marker', second), undefined);
  assert.equal(second.PMJS.methods.dump().length, 0);
  first.PMJS.tasks.stop();
  await second.PMJS.tasks.invoke(() => second.NativeHost.calls.push('second'));
  assert.deepEqual(first.NativeHost.calls, []);
  assert.deepEqual(second.NativeHost.calls, ['second']);
});


test('reviewed source strings match exactly through the captured intrinsic reader', () => {
  const ctx = context();
  const reviewed = function(value) { return value + 'a b'; };
  const source = ctx.PMJS.methods.sourceOf(reviewed);
  assert.equal(ctx.PMJS.methods.matchesSource(reviewed, source), true);
  const changed = function(value) { return value + 'ab'; };
  changed.toString = () => source;
  assert.equal(ctx.PMJS.methods.matchesSource(changed, [source]), false);
  assert.notEqual(ctx.PMJS.methods.sourceOf(changed), source);
  const multiline = 'function() {\n  return 3;\n}';
  const crlf = vm.runInNewContext('(' + multiline.replace(/\n/g, '\r\n') + ')');
  assert.equal(ctx.PMJS.methods.matchesSource(crlf, multiline), true);
  assert.equal(ctx.PMJS.methods.matchesSource(crlf, [multiline, multiline.replace(/\n/g, '\r\n')]), true);
});

test('all source qualification uses LF while preserving function names and bodies', () => {
  const { createHash } = require('node:crypto');
  const ctx = context({ __pmjsBuiltinRequire: require });
  const hash = source => createHash('sha256').update(source).digest('hex');
  const compile = source => vm.runInNewContext('(' + source + ')');
  const lf = 'function Named(value) {\n return value;\n}';
  const crlf = lf.replace(/\n/g, '\r\n');
  const matches = ctx.PMJS.methods.matchesSource;
  assert.equal(matches(compile(crlf), hash(lf)), true);
  assert.equal(matches(compile(lf), hash(lf)), true);
  assert.equal(matches(compile(crlf), lf), true);
  assert.equal(matches(compile(lf), crlf), true);
  for (const changed of [
    lf.replace('Named', 'Other'), lf.replace('Named', ''),
    lf.replace('return value;', '/* changed */ return value;'),
    lf.replace(' return value;', '  return value;'),
    lf.replace('return value;', 'return "a b";')
  ]) assert.equal(matches(compile(changed), hash(lf)), false);
  const asyncSource = 'async function Named(value) { return value; }';
  assert.equal(matches(compile(asyncSource), hash(asyncSource)), true);
  assert.equal(matches(compile(asyncSource.replace('Named', 'Other')), hash(asyncSource)), false);
  assert.equal(ctx.PMJS.methods.matchesText('script\r\n', hash('script\n')), true);
  assert.equal(ctx.PMJS.methods.fingerprint('script\r\n'), hash('script\n'));
  assert.equal(ctx.PMJS.methods.matchesText(null, hash('')), false);
  delete ctx.__pmjsBuiltinRequire;
  assert.equal(matches(compile(crlf), hash(lf)), false);
  assert.equal(matches(compile(crlf), lf), true);
  assert.equal(ctx.PMJS.methods.fingerprint(lf), null);
});

test('whole-script qualification requires a fingerprint rather than accepting digest text as source', () => {
  const { createHash } = require('node:crypto');
  const ctx = context({ __pmjsBuiltinRequire: require });
  const source = 'globalThis.reviewed = true;';
  const digest = createHash('sha256').update(source).digest('hex');
  assert.equal(ctx.PMJS.methods.matchesText(source, digest), true);
  assert.equal(ctx.PMJS.methods.matchesText(digest, digest), false);
  assert.equal(ctx.PMJS.methods.matchesText(digest, [digest]), false);
  assert.equal(ctx.PMJS.methods.matchesText(source, source), false);
});

test('unavailable hashing refuses fingerprints while preserving exact function-source matching', () => {
  const reviewed = function() { return 'reviewed'; };
  const source = Function.prototype.toString.call(reviewed);
  const digest = require('node:crypto').createHash('sha256').update(source).digest('hex');
  for (const loader of [
    () => { throw new Error('crypto unavailable'); },
    () => ({ createHash() { throw new Error('hashing unavailable'); } })
  ]) {
    const ctx = context({ __pmjsBuiltinRequire: loader });
    assert.equal(ctx.PMJS.methods.matchesSource(reviewed, digest), false);
    assert.equal(ctx.PMJS.methods.matchesText(source, digest), false);
    assert.equal(ctx.PMJS.methods.matchesSource(reviewed, source), true);
  }
});
