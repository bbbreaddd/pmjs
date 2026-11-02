'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { runModule } = require('./helpers/runtime-context.cjs');
const { context } = require('./helpers/jsonex-context.cjs');

function assertSameGraph(a, b, pairs = new Map(), where = 'root') {
  if (a === null || typeof a !== 'object') {
    assert.ok(Object.is(a, b), where);
    return;
  }
  assert.ok(b && typeof b === 'object', where);
  if (pairs.has(a)) {
    assert.equal(pairs.get(a), b, where + ' sharing');
    return;
  }
  pairs.set(a, b);
  assert.equal(Object.prototype.toString.call(a), Object.prototype.toString.call(b), where);
  assert.equal(a.constructor && a.constructor.name, b.constructor && b.constructor.name, where);
  assert.deepEqual(Object.keys(a), Object.keys(b), where);
  if (Array.isArray(a)) assert.equal(a.length, b.length, where);
  for (const key of Object.keys(a)) assertSameGraph(a[key], b[key], pairs, where + '.' + key);
}

test('JsonEx saves are byte-identical to stock and leave live objects untouched and fast', () => {
  const stockCtx = context({ installed: false });
  const ctx = context();
  assert.equal(ctx.PMJS.optimizations.reason('storage.jsonex-fast-objects'), 'enabled');
  for (let seed = 1; seed <= 100; seed++) {
    const live = ctx.build(seed, 1 + seed % 30);
    const reference = ctx.build(seed, 1 + seed % 30);
    assert.equal(ctx.JsonEx.stringify(live),
      stockCtx.JsonEx.stringify(stockCtx.build(seed, 1 + seed % 30)), 'seed ' + seed);
    assertSameGraph(reference, live);
    for (const event of live.events) {
      if (event) assert.equal(ctx.fast(event), true, 'seed ' + seed);
    }
  }
  const stockLive = stockCtx.build(3, 5);
  stockCtx.JsonEx.stringify(stockLive);
  assert.equal(stockCtx.fast(stockLive.events[1]), false, 'stock JsonEx makes saved objects slow');
});

test('JsonEx loads match stock loads and return fast objects', () => {
  const stockCtx = context({ installed: false });
  const ctx = context();
  for (let seed = 1; seed <= 50; seed++) {
    const json = stockCtx.JsonEx.stringify(stockCtx.build(seed, 1 + seed % 20));
    const loaded = ctx.JsonEx.parse(json);
    assertSameGraph(stockCtx.JsonEx.parse(json), loaded);
    assert.equal(loaded.map._events, loaded.events);
    for (const event of loaded.events) {
      if (!event) continue;
      assert.equal(ctx.fast(event), true, 'seed ' + seed);
      if (event._interpreter && event._interpreter._event) assert.equal(event._interpreter._event, event);
    }
  }
  const json = stockCtx.JsonEx.stringify(stockCtx.build(2, 5));
  assert.equal(stockCtx.fast(stockCtx.JsonEx.parse(json).events[1]), false,
    'stock JsonEx returns slow objects');
});

test('makeDeepCopy keeps both the source and the copy fast', () => {
  const stockCtx = context({ installed: false });
  const ctx = context();
  const source = ctx.build(9, 8);
  const copy = ctx.JsonEx.makeDeepCopy(source);
  // A JSON round trip is lossy (-0, NaN, Date) in stock MV as well.
  assertSameGraph(stockCtx.JsonEx.makeDeepCopy(stockCtx.build(9, 8)), copy);
  assert.equal(ctx.fast(source.events[2]), true);
  assert.equal(ctx.fast(copy.events[2]), true);
});

for (const name of ['stringify', 'parse', '_encode', '_decode', '_cleanMetadata',
  '_generateId', '_restoreCircularReference', '_linkCircularReference',
  '_getConstructorName', '_resetPrototype']) {
  test('a plugin replacement of JsonEx.' + name + ' is refused and left in place', () => {
    const ctx = context({ edit: 'JsonEx.' + name + ' = function(value) { return value; };' });
    assert.equal(ctx.PMJS.optimizations.reason('storage.jsonex-fast-objects'),
      'refused: JsonEx.' + name + ' is not the stock MV 1.6 source');
    assert.equal(ctx.JsonEx._pmjsFastObjects, undefined);
    assert.equal(ctx.JsonEx[name](42), 42);
  });
}

test('CRLF stock sources are accepted', () => {
  const ctx = context({ installed: false });
  for (const name of ['stringify', 'parse', '_encode', '_decode', '_cleanMetadata',
    '_generateId', '_restoreCircularReference', '_linkCircularReference',
    '_getConstructorName', '_resetPrototype']) {
    const source = Function.prototype.toString.call(ctx.JsonEx[name]).replace(/\n/g, '\r\n');
    ctx.JsonEx[name] = vm.runInContext('(' + source + ')', ctx);
  }
  runModule(ctx, 'js/pmjs-mv/jsonex.js');
  ctx.installNativeJsonEx();
  assert.equal(ctx.JsonEx._pmjsFastObjects, true);
});

test('PMJS_DISABLE_OPT keeps stock JsonEx', () => {
  const ctx = context({ env: { PMJS_DISABLE_OPT: 'storage.jsonex-fast-objects' } });
  assert.equal(ctx.PMJS.optimizations.reason('storage.jsonex-fast-objects'),
    'disabled by PMJS_DISABLE_OPT');
  const live = ctx.build(4, 4);
  ctx.JsonEx.stringify(live);
  assert.equal(ctx.fast(live.events[1]), false);
});

for (const [label, setup] of [
  ['non-enumerable toJSON', `
    Object.defineProperty(object, 'toJSON', { value: function() {
      calls.push(this === object); return { ret: this.x };
    } });
  `],
  ['inherited toJSON with external receiver state', `
    var values = new WeakMap([[object, 17]]);
    Object.setPrototypeOf(object, { toJSON: function() {
      calls.push(this === object); return { ret: values.get(this) };
    } });
  `],
  ['enumerable getter with hidden state', `
    Object.defineProperty(object, 'hidden', { value: 17 });
    Object.defineProperty(object, 'x', { enumerable: true, get: function() {
      calls.push(this === object); return this.hidden;
    } });
  `],
  ['toJSON getter', `
    Object.defineProperty(object, 'toJSON', { get: function() {
      calls.push(this === object); return function() { return { ret: this.x }; };
    } });
  `],
  ['custom Date serialization observing live metadata', `
    object = new Date(1700000000000);
    object.toJSON = function() { calls.push(input['@c']); return input['@c']; };
  `],
  ['function with custom serialization', `
    object = function() {};
    object.toJSON = function() { calls.push(input['@c']); return input['@c']; };
  `],
  ['function with a toJSON getter', `
    object = function() {};
    Object.defineProperty(object, 'toJSON', { get: function() {
      calls.push(!!input['@c']); return function() { calls.push(this === object); return 17; };
    } });
  `],
  ['function with inherited serialization', `
    object = function() {};
    Function.prototype.toJSON = function() { calls.push(this === object, !!input['@c']); return 17; };
  `],
  ['function with a tag getter', `
    object = function() {};
    Object.defineProperty(object, Symbol.toStringTag, { get: function() {
      calls.push(!!input['@c']); return 'Function';
    } });
  `],
  ['function with an object tag', `
    object = function() {};
    Object.defineProperty(object, Symbol.toStringTag, { value: 'Object' });
  `],
  ['function proxy', `
    object = new Proxy(function() {}, { get: function(target, key, receiver) {
      calls.push(String(key) + ':' + !!input['@c']); return Reflect.get(target, key, receiver);
    } });
  `],
  ['function with a proxy prototype', `
    object = function() {};
    Object.setPrototypeOf(object, new Proxy(Function.prototype, { get: function(target, key, receiver) {
      calls.push(String(key) + ':' + !!input['@c']); return Reflect.get(target, key, receiver);
    } }));
  `],
  ['inherited constructor object with a name getter', `
    Object.setPrototypeOf(object, { constructor: {
      get name() { calls.push(!!input['@c']); return input['@c'] ? 'Live' : 'Copy'; }
    } });
  `],
  ['inherited constructor function with a name getter', `
    function Constructor() {}
    Object.defineProperty(Constructor, 'name', { get: function() {
      calls.push(!!input['@c']); return input['@c'] ? 'Live' : 'Copy';
    } });
    Object.setPrototypeOf(object, { constructor: Constructor });
  `],
  ['inherited proxy constructor', `
    var constructor = new Proxy(function Constructor() {}, { get: function(target, key, receiver) {
      if (key === 'name') {
        calls.push(!!input['@c']); return input['@c'] ? 'Live' : 'Copy';
      }
      return Reflect.get(target, key, receiver);
    } });
    Object.setPrototypeOf(object, { constructor: constructor });
  `],
  ['proxy', `
    var target = object;
    object = new Proxy(target, { get: function(target, key, receiver) {
      calls.push(String(key)); return Reflect.get(target, key, receiver);
    } });
  `]
]) {
  test('stringify preserves stock bytes, receivers and callback order for ' + label, () => {
    const edit = `
      var calls = [], object = { x: 17 };
      ${setup}
      var input = { before: { data: 1 }, nested: object };
    `;
    const reference = context({ installed: false, edit });
    const ctx = context({ edit });
    assert.equal(ctx.JsonEx.stringify(ctx.input), reference.JsonEx.stringify(reference.input));
    assert.deepEqual(Array.from(ctx.calls), Array.from(reference.calls));
    assertSameGraph(reference.input.before, ctx.input.before);
    assert.equal(ctx.fast(ctx.input.before), reference.fast(reference.input.before),
      'the whole graph uses stock serialization');
  });
}

for (const count of [3, 100, 160]) {
  test('own properties bypass inherited setters on save and load with ' + count + ' fields', () => {
    const edit = `
      var setters = 0;
      function SavedRecord() {}
      Object.defineProperty(SavedRecord.prototype, '_x', {
        set: function() { setters++; }, configurable: true
      });
      var object = new SavedRecord();
      Object.defineProperty(object, '_x', { value: 5, enumerable: true, writable: true });
      for (var i = 0; i < ${count}; i++) {
        Object.defineProperty(object, 'field' + i, {
          value: i, enumerable: true, writable: true, configurable: true
        });
      }
    `;
    const reference = context({ installed: false, edit });
    const ctx = context({ edit });
    const json = reference.JsonEx.stringify(reference.object);
    assert.equal(ctx.JsonEx.stringify(ctx.object), json);
    const loaded = ctx.JsonEx.parse(json);
    assertSameGraph(reference.JsonEx.parse(json), loaded);
    assert.equal(Object.hasOwn(loaded, '_x'), true);
    assert.equal(loaded._x, 5);
    assert.equal(ctx.setters, 0);
    assert.equal(ctx.fast(loaded), true);
  });
}

test('own __proto__ data survives serialization and reconstruction', () => {
  const edit = `var object = JSON.parse('{"__proto__":{"x":5},"value":17}');`;
  const reference = context({ installed: false, edit });
  const ctx = context({ edit });
  const json = reference.JsonEx.stringify(reference.object);
  assert.equal(ctx.JsonEx.stringify(ctx.object), json);
  const loaded = ctx.JsonEx.parse(json);
  assertSameGraph(reference.JsonEx.parse(json), loaded);
  assert.equal(Object.hasOwn(loaded, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(loaded), vm.runInContext('Object.prototype', ctx));
});

test('layouts containing null characters remain distinct across successive parses', () => {
  const reference = context({ installed: false });
  const ctx = context();
  for (const json of ['{"a\\u0000b":1,"c":2}', '{"a":3,"b\\u0000c":4}']) {
    const expected = reference.JsonEx.parse(json);
    const loaded = ctx.JsonEx.parse(json);
    assertSameGraph(expected, loaded);
    assert.equal(ctx.JsonEx.stringify(loaded), reference.JsonEx.stringify(expected));
  }
});

test('parse conservatively uses stock for tagged class accessors', () => {
  const edit = `
    var calls = 0;
    function TaggedRecord() {}
    Object.defineProperty(TaggedRecord.prototype, Symbol.toStringTag, {
      get: function() { calls++; return 'TaggedRecord'; }
    });
  `;
  const reference = context({ installed: false, edit });
  const ctx = context({ edit });
  const json = '{"@":"TaggedRecord","@c":1,"x":5}';
  const expected = reference.JsonEx.parse(json);
  const loaded = ctx.JsonEx.parse(json);
  assert.deepEqual(Object.keys(loaded), Object.keys(expected));
  assert.equal(loaded.x, expected.x);
  assert.equal(Object.getPrototypeOf(loaded), ctx.TaggedRecord.prototype);
  assert.equal(ctx.calls, reference.calls);
  assert.equal(ctx.fast(loaded), reference.fast(expected));
  assert.equal(ctx.PMJS.optimizations.dump().find(entry => entry.id === 'storage.jsonex-fast-objects')
    .fallbackCounts['parse: unsupported decoded graph'], 1);
});


for (const method of ['preventExtensions', 'seal', 'freeze']) {
  test('stringify preserves stock behavior for Object.' + method, () => {
    const edit = `var object = { x: 17, nested: { n: 5 }, array: [1, 2] };
      Object.${method}(object);`;
    const reference = context({ installed: false, edit });
    const ctx = context({ edit });
    assert.equal(ctx.JsonEx.stringify(ctx.object), reference.JsonEx.stringify(reference.object));
    assertSameGraph(reference.object, ctx.object);
  });
}

test('parse creates array elements without invoking inherited index setters', () => {
  const edit = `
    var calls = 0;
    Object.defineProperty(Array.prototype, '1', {
      set: function() { calls++; }, configurable: true
    });
  `;
  const reference = context({ installed: false, edit });
  const ctx = context({ edit });
  const json = '{"@c":1,"list":{"@c":2,"@a":[1,2,3]}}';
  const expected = reference.JsonEx.parse(json);
  const loaded = ctx.JsonEx.parse(json);
  assertSameGraph(expected, loaded);
  assert.equal(ctx.calls, reference.calls);
});


test('stringify preserves read-only array fields and shared references', () => {
  const edit = `
    var array = [1, 2];
    var object = {};
    Object.defineProperty(object, 'first', { value: array, enumerable: true });
    object.second = array;
  `;
  const reference = context({ installed: false, edit });
  const ctx = context({ edit });
  assert.equal(ctx.JsonEx.stringify(ctx.object), reference.JsonEx.stringify(reference.object));
  assertSameGraph(reference.object, ctx.object);
  assert.equal(ctx.object.first, ctx.object.second);
  assert.equal(Object.getOwnPropertyDescriptor(ctx.object, 'first').writable, false);
});

test('late decoder hooks retain the exact object and hidden state they returned', () => {
  const ctx = context();
  vm.runInContext(`
    var decode = JsonEx._decode, captured;
    JsonEx._decode = function(value, circular, registry) {
      var result = decode.call(this, value, circular, registry);
      if (result && typeof result === 'object') {
        captured = result; Object.defineProperty(result, 'hidden', { value: 42 });
      }
      return result;
    };
    var loaded = JsonEx.parse('{"x":1,"@c":1}');
  `, ctx);
  assert.equal(ctx.loaded, ctx.captured);
  assert.equal(ctx.loaded.hidden, 42);
});

test('an alternate parse receiver can return an object with internal slots', () => {
  const ctx = context();
  assert.equal(vm.runInContext(`
    var receiver = Object.create(JsonEx);
    receiver._decode = function() { return new Date(0); };
    JsonEx.parse.call(receiver, '{}').getTime();
  `, ctx), 0);
});

test('decode prototype hooks retain the returned object identity', () => {
  const ctx = context();
  assert.equal(vm.runInContext(`
    var seen = new WeakSet();
    function Retained() {}
    Retained.prototype.hasOwnProperty = function(key) {
      seen.add(this); return Object.prototype.hasOwnProperty.call(this, key);
    };
    seen.has(JsonEx.parse('{"@":"Retained","@c":1,"x":1}'));
  `, ctx), true);
});

for (const hook of ['toJSON', 'valueOf', 'toISOString', 'primitive']) {
  test('modified Date ' + hook + ' observes stock live serialization state', () => {
    const setup = `
      var root = { date: new Date(0) };
      ${hook === 'primitive' ? "Object.defineProperty(Date.prototype, Symbol.toPrimitive, { value: function() { root.flag = !!root['@c']; return 0; } });" :
        `Date.prototype.${hook} = function() { root.flag = !!root['@c']; return ${hook === 'valueOf' ? '0' : "'date'"}; };`}
    `;
    const stock = context({ installed: false, edit: setup });
    const ctx = context({ edit: setup });
    assert.equal(ctx.JsonEx.stringify(ctx.root), stock.JsonEx.stringify(stock.root));
    assert.equal(ctx.root.flag, stock.root.flag);
  });
}

test('unsaved deep state is not recursively traversed', () => {
  const ctx = context();
  vm.runInContext(`
    var root = { x: 1 }, cursor = root;
    for (var i = 0; i < 12000; i++) {
      var next = {}; Object.defineProperty(cursor, 'hidden', { value: next }); cursor = next;
    }
  `, ctx);
  assert.equal(ctx.JsonEx.stringify(ctx.root), '{"x":1,"@c":1}');
});

test('deep serialized state retains the stock depth error', () => {
  const ctx = context();
  vm.runInContext('var root = {}, cursor = root; for (var i = 0; i < 12000; i++) cursor = cursor.next = {};', ctx);
  assert.throws(() => ctx.JsonEx.stringify(ctx.root), /^Error: Object too deep$/);
});

test('Date conversion accessors execute only in stock serialization order', () => {
  const edit = `
    var root = { date: new Date(0) }, calls = [], original = Date.prototype.valueOf;
    Object.defineProperty(Date.prototype, 'valueOf', { get: function() {
      calls.push(!!root['@c']); return original;
    } });
  `;
  const stock = context({ installed: false, edit });
  const ctx = context({ edit });
  assert.equal(ctx.JsonEx.stringify(ctx.root), stock.JsonEx.stringify(stock.root));
  assert.deepEqual(Array.from(ctx.calls), Array.from(stock.calls));
});

for (const key of ['@', '@c']) {
  test('existing own ' + key + ' metadata uses stock live-object cleanup', () => {
    const setup = `var child = { x: 1 }, root = { child: child, again: child };
      Object.defineProperty(child, ${JSON.stringify(key)}, { value: 17, writable: true, configurable: true, enumerable: true });`;
    const stock = context({ installed: false, edit: setup });
    const ctx = context({ edit: setup });
    assert.equal(ctx.JsonEx.stringify(ctx.root), stock.JsonEx.stringify(stock.root));
    assert.deepEqual(Object.getOwnPropertyDescriptor(ctx.child, key), Object.getOwnPropertyDescriptor(stock.child, key));
    assert.equal(ctx.root.child, ctx.child);
    assert.equal(ctx.root.again, ctx.child);
    assertSameGraph(stock.root, ctx.root);
    const record = ctx.PMJS.optimizations.dump().find(value => value.id === 'storage.jsonex-fast-objects');
    assert.equal(record.fallbackCounts['stringify: unsupported save graph'], 1);
  });
}

for (const when of ['before installation', 'after installation']) {
  test('replaced Object.setPrototypeOf uses ordinary stock behavior ' + when, () => {
    const edit = 'Object.setPrototypeOf = function() { throw new Error("Prototype changes blocked"); };';
    const ctx = context({ edit: when === 'before installation' ? edit : undefined });
    if (when === 'after installation') vm.runInContext(edit, ctx);
    assert.equal(ctx.JsonEx.parse('{"x":1}').x, 1);
    assert.equal(vm.runInContext('JsonEx.stringify({x:1})', ctx), '{"x":1,"@c":1}');
    assert.equal(ctx.PMJS.optimizations.dump().find(value => value.id === 'storage.jsonex-fast-objects')
      .fallbackCounts['parse: modified serializer or non-string input'], 1);
  });
}

test('qualified parsing uses one JSON parse and retains graph reconstruction', () => {
  const ctx = context({ installed: false });
  vm.runInContext(`var nativeParse = JSON.parse, parseCount = 0;
    JSON.parse = function(json) { parseCount++; return nativeParse(json); };`, ctx);
  runModule(ctx, 'js/pmjs-mv/jsonex.js');
  ctx.installNativeJsonEx();
  const loaded = ctx.JsonEx.parse('{"@c":1,"child":{"@c":2,"x":1},"again":{"@r":2}}');
  assert.equal(ctx.parseCount, 1);
  assert.equal(loaded.child, loaded.again);
  assert.equal(ctx.fast(loaded.child), true);
});


test('own root metadata is overwritten and removed exactly as stock', () => {
  for (const key of ['@', '@c']) {
    const setup = 'var root = { x: 1, ' + JSON.stringify(key) + ': 17 };';
    const stock = context({ installed: false, edit: setup }), ctx = context({ edit: setup });
    assert.equal(ctx.JsonEx.stringify(ctx.root), stock.JsonEx.stringify(stock.root));
    assert.equal(Object.getOwnPropertyDescriptor(ctx.root, key), undefined);
    assertSameGraph(stock.root, ctx.root);
  }
});


for (const [key, result] of [['Symbol.toStringTag', "'Object'"], ["'@'", 'undefined'], ["'@c'", '1']]) {
  test('parse preserves identity and getter order for inherited ' + key, () => {
    const edit = `var seen = new WeakSet(), calls = [];
      Object.defineProperty(Object.prototype, ${key}, { configurable: true,
        get: function() { seen.add(this); calls.push('get'); return ${result}; } });`;
    const stock = context({ installed: false, edit }), ctx = context({ edit });
    const json = key === "'@c'" ? '{"x":1}' : '{"@c":1,"x":1}';
    for (const target of [stock, ctx]) {
      target.loaded = target.JsonEx.parse(json);
      assert.equal(vm.runInContext('seen.has(loaded)', target), true);
      assert.equal(target.loaded.x, 1);
    }
    assert.deepEqual(Array.from(ctx.calls), Array.from(stock.calls));
    assert.equal(ctx.PMJS.optimizations.dump().find(entry => entry.id === 'storage.jsonex-fast-objects')
      .fallbackCounts['parse: unsupported decoded graph'], 1);
  });
}

test('parse preserves decoded array identity observed by an inherited tag getter', () => {
  const edit = `var seen = new WeakSet(), calls = 0;
    Object.defineProperty(Array.prototype, Symbol.toStringTag, { configurable: true,
      get: function() { seen.add(this); calls++; return 'Array'; } });`;
  const stock = context({ installed: false, edit }), ctx = context({ edit });
  for (const target of [stock, ctx]) {
    target.loaded = target.JsonEx.parse('[1,2]');
    assert.equal(vm.runInContext('seen.has(loaded)', target), true);
  }
  assert.equal(ctx.calls, stock.calls);
});

test('parse guards hasOwnProperty accessors without an extra callback', () => {
  const edit = `var originalOwn = Object.prototype.hasOwnProperty, seen = new WeakSet(), calls = [];
    Object.defineProperty(Object.prototype, 'hasOwnProperty', { configurable: true,
      get: function() { seen.add(this); calls.push(this === Object.prototype ? 'prototype' : 'instance'); return originalOwn; } });`;
  const stock = context({ installed: false, edit }), ctx = context({ edit });
  for (const target of [stock, ctx]) {
    target.loaded = target.JsonEx.parse('{"@c":1,"x":1}');
    assert.equal(vm.runInContext('seen.has(loaded)', target), true);
  }
  assert.deepEqual(Array.from(ctx.calls), Array.from(stock.calls));
});


test('ordinary callback fields preserve stock bytes, live identities and fast game objects', () => {
  const edit = `
    var calls = 0;
    var callback = function() { calls++; };
    var callbacks = [callback, callback.bind(null), () => calls++, async function() {}, function*() {}, class Callback {}];
    Object.defineProperty(callback, 'ignored', { enumerable: true, get: function() { throw new Error('not serialized'); } });
    Object.freeze(callbacks[1]);
  `;
  const stock = context({ installed: false, edit }), ctx = context({ edit });
  for (const target of [stock, ctx]) {
    target.input = target.build(7, 12);
    vm.runInContext(`
      input.picture = { updateMove: callbacks[1] };
      input.map.camTarget = { screenX: callback, screenY: callback };
      input.callbacks = callbacks; input.callback = callback; callback.owner = input;
    `, target);
  }
  const descriptor = Object.getOwnPropertyDescriptor(ctx.callback, 'ignored');
  assert.equal(ctx.JsonEx.stringify(ctx.input), stock.JsonEx.stringify(stock.input));
  assert.equal(ctx.input.callback, ctx.callback);
  assert.equal(ctx.callback.owner, ctx.input);
  assert.equal(ctx.input.picture.updateMove, ctx.callbacks[1]);
  assert.equal(ctx.input.map.camTarget.screenX, ctx.callback);
  assert.deepEqual(Object.getOwnPropertyDescriptor(ctx.callback, 'ignored'), descriptor);
  assert.equal(ctx.calls, 0);
  assert.equal(stock.calls, 0);
  assert.ok(ctx.input.events.filter(Boolean).every(event => ctx.fast(event)));
  assert.ok(stock.input.events.filter(Boolean).every(event => !stock.fast(event)));
  const json = ctx.JsonEx.stringify(ctx.input);
  const plain = JSON.parse(json);
  assert.equal(Object.hasOwn(plain, 'callback'), false);
  assert.deepEqual(plain.callbacks['@a'], Array(6).fill(null));
  assert.deepEqual({ ...ctx.PMJS.optimizations.dump().find(entry => entry.id === 'storage.jsonex-fast-objects').fallbackCounts }, {});
});

test('a function root preserves stock return value and metadata cleanup', () => {
  const edit = `var callback = function() {}; callback['@c'] = 17; callback['@'] = 'custom';`;
  const stock = context({ installed: false, edit }), ctx = context({ edit });
  assert.equal(ctx.JsonEx.stringify(ctx.callback), stock.JsonEx.stringify(stock.callback));
  assert.equal(Object.hasOwn(ctx.callback, '@c'), false);
  assert.equal(Object.hasOwn(ctx.callback, '@'), false);
});
