'use strict';

const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const vm = require('node:vm');
const { loadPmjsRuntime, runModule } = require('./runtime-context.cjs');

v8.setFlagsFromString('--allow-natives-syntax');

const stock = fs.readFileSync(path.join(__dirname, '../fixtures/mv-jsonex.cjs'), 'utf8')
  .replace('module.exports = JsonEx;', 'globalThis.JsonEx = JsonEx;');

// Game-shaped classes: many fields, nested arrays, sharing, cycles, holes.
function world(fields) {
  return `
function Game_Event(id) { this.initialize(id); }
Game_Event.prototype.initialize = function(id) {
  this._eventId = id; this._x = id % 7; this._y = -0; this._realX = NaN; this._through = false;
  this._characterName = 'ev' + id; this._moveRoute = { list: [{ code: 0, parameters: [] }], repeat: true };
  this._interpreter = null; this._pageIndex = -1; this._tags = [[1, 2], [], [3]];
  ${Array.from({ length: fields }, (_, i) => `this._plugin${i} = ${i};`).join(' ')}
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
}

function context({ installed = true, env = {}, edit, fields = 40 } = {}) {
  const ctx = loadPmjsRuntime({ __pmjsBuiltinRequire: require,
    NativeHost: { runtime: { env: name => env[name] } } });
  ctx.window = ctx;
  vm.runInContext(stock, ctx);
  if (installed) runModule(ctx, 'js/pmjs-mv/jsonex.js');
  if (edit) vm.runInContext(edit, ctx);
  vm.runInContext(world(fields), ctx);
  if (installed) {
    ctx.installNativeJsonEx();
  }
  return ctx;
}

module.exports = { context };
