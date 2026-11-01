'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const v8 = require('node:v8');
const vm = require('node:vm');
const { loadPmjsRuntime, runModule } = require('./helpers/runtime-context.cjs');

v8.setFlagsFromString('--allow-natives-syntax');

const stock = fs.readFileSync(path.join(__dirname, 'fixtures/mv-jsonex.cjs'), 'utf8')
  .replace('module.exports = JsonEx;', 'globalThis.JsonEx = JsonEx;');

// Game-shaped classes: many fields, nested arrays, sharing, cycles, holes.
const world = `
function Game_Event(id) { this.initialize(id); }
Game_Event.prototype.initialize = function(id) {
  this._eventId = id; this._x = id % 7; this._y = -0; this._realX = NaN; this._through = false;
  this._characterName = 'ev' + id; this._moveRoute = { list: [{ code: 0, parameters: [] }], repeat: true };
  this._interpreter = null; this._pageIndex = -1; this._tags = [[1, 2], [], [3]];
  ${Array.from({ length: 40 }, (_, i) => `this._plugin${i} = ${i};`).join(' ')}
};
function Game_Interpreter() { this._list = [{ code: 101, parameters: ['a', 0] }]; this._event = null; }
function Game_Map() { this._mapId = 1; this._events = []; this._filters = new Map([[1, 2]]); }
function build(seed, count) {
  var s = seed;
  function rand() { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }
  var map = new Game_Map(), shared = { list: [1, 2, 3] };
  for (var i = 0; i < count; i++) {
    var e = new Game_Event(i);
    if (rand() < 0.3) e._interpreter = new Game_Interpreter();
    if (e._interpreter && rand() < 0.5) e._interpreter._event = e;
    if (rand() < 0.4) e._shared = shared;
    if (rand() < 0.2) { e._sparse = []; e._sparse[3] = 'x'; }
    if (rand() < 0.2) e._date = new Date(1700000000000 + i);
    if (rand() < 0.1) e._self = e;
    map._events.push(e);
  }
  map._events.push(null);
  return { map: map, events: map._events };
}
globalThis.build = build;
globalThis.fast = function(object) { return %HasFastProperties(object); };
`;

function context({ installed = true, env = {}, edit } = {}) {
  const ctx = loadPmjsRuntime({ __pmjsBuiltinRequire: require,
    NativeHost: { runtime: { env: name => env[name] } } });
  ctx.window = ctx;
  vm.runInContext(stock, ctx);
  if (edit) vm.runInContext(edit, ctx);
  vm.runInContext(world, ctx);
  if (installed) {
    runModule(ctx, 'js/pmjs-mv/jsonex.js');
    ctx.installNativeJsonEx();
  }
  return ctx;
}

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

test('a JsonEx changed by a plugin is refused and left in place', () => {
  const ctx = context({ edit: 'JsonEx._encode = function(value) { return value; };' });
  assert.equal(ctx.PMJS.optimizations.reason('storage.jsonex-fast-objects'),
    'refused: JsonEx._encode is not the stock MV 1.6 source');
  assert.equal(ctx.JsonEx._pmjsFastObjects, undefined);
});

test('CRLF stock sources are accepted', () => {
  const ctx = context({ installed: false });
  for (const name of ['stringify', 'parse', '_encode', '_decode', '_cleanMetadata']) {
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
