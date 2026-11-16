'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(require.resolve('../js/pmjs-mv/window-frame.js'), 'utf8');

function fixture({ rounded = false, batch = true, unknown = false, native = false } = {}) {
  const calls = { ordinary: 0, bitmap: 0, dirty: 0, blt: [], batches: [] };
  function Window() {}
  const frame = function() { calls.ordinary++; };
  const blt = function() { calls.blt.push(Array.from(arguments)); };
  const roundBlt = function() { return blt.apply(this, arguments); };
  const nativeBlt = function() { return blt.apply(this, arguments); };
  const dirty = function() { calls.dirty++; };
  function Bitmap(width, height) { calls.bitmap++; this.width=width; this.height=height; this._context={}; }
  Bitmap.prototype.blt = rounded ? roundBlt : native ? nativeBlt : blt;
  Bitmap.prototype._setDirty = dirty;
  Window.prototype._refreshFrame = unknown ? function() { calls.ordinary++; } : frame;
  const phases = [];
  const realm = { Window, Bitmap, _Bitmap_blt: blt, Yanfly: { Core: { Bitmap_blt: native ? nativeBlt : blt } }, PMJS: {
    optimizations: { register() {}, isEnabled: () => true, refuse() { calls.refused = true; } },
    phases: { on(_phase, _id, callback) { phases.push(callback); } },
    methods: { matchesSource(fn, hashes) {
      // Independent fixture functions stand in for already qualified engine bodies.
      return fn === nativeBlt && typeof hashes === 'string' && hashes.startsWith('68ab7') ||
        fn === frame && hashes[0].startsWith('304170') ||
        fn === blt && hashes[0].startsWith('d62410') ||
        fn === roundBlt && hashes[0].startsWith('8b54c7') ||
        fn === dirty && hashes[0].startsWith('4e5d20');
    } },
    web: { canvas: { drawImageBatch(_context, _source, rectangles) {
      calls.batches.push(Array.from(rectangles)); return batch;
    } } }
  } };
  vm.createContext(realm);
  const optimizationHooks = { ...realm.PMJS.optimizations };
  realm.PMJS.config ||= {};
  require('./helpers/runtime-context.cjs').runModule(realm, 'js/pmjs-core/optimizations.js');
  Object.assign(realm.PMJS.optimizations, optimizationHooks);
  vm.runInContext(source, realm); phases.forEach(f => f());
  const window = new Window();
  Object.assign(window, { _width: 99.8, _height: 80.7, _windowskin: { width:192, height:96, _canvas:{} },
    _windowFrameSprite: { setFrame(...args) { calls.frame=args; } } });
  return { realm, window, calls };
}

test('window frame batching preserves geometry, plugin rounding and one Bitmap construction', () => {
  for (const rounded of [false, true]) {
    const { window, calls } = fixture({ rounded }); window._refreshFrame();
    assert.equal(calls.bitmap, 1); assert.equal(calls.dirty, 1); assert.equal(calls.blt.length, 0);
    assert.deepEqual(calls.frame, [0,0,99.8,80.7]);
    assert.equal(calls.batches[0].length, 64);
    assert.equal(calls.batches[0][6], rounded ? 51 : 51.8);
    assert.deepEqual(calls.batches[0].slice(-8), rounded ? [168,72,24,24,75,56,24,24] : [168,72,24,24,75.8,56.7,24,24]);
  }
});
test('unsupported Canvas state retains ordinary draws on the same frame Bitmap', () => {
  const { window, calls } = fixture({ batch:false }); window._refreshFrame();
  assert.equal(calls.bitmap, 1); assert.equal(calls.blt.length, 8);
  assert.equal(calls.ordinary, 0);
});
test('unknown drawing and changed rounding predecessors keep the original frame path', () => {
  const unknown = fixture({ unknown:true }); unknown.window._refreshFrame();
  assert.equal(unknown.calls.refused, true); assert.equal(unknown.calls.bitmap, 0);
  const changed = fixture({ rounded:true }); changed.realm.Yanfly.Core.Bitmap_blt = function() {};
  changed.window._refreshFrame(); assert.equal(changed.calls.ordinary, 1); assert.equal(changed.calls.bitmap, 0);
  const small = fixture(); small.window._width=20; small.window._refreshFrame();
  assert.equal(small.calls.ordinary, 1); assert.equal(small.calls.bitmap, 0);
});


test('native blit composition requires the original engine predecessor to remain unchanged', () => {
  const { realm, window, calls } = fixture({ rounded:true, native:true });
  window._refreshFrame(); assert.equal(calls.batches.length, 1);
  realm._Bitmap_blt = function() {};
  window._refreshFrame(); assert.equal(calls.ordinary, 1); assert.equal(calls.batches.length, 1);
});
