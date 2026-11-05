'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createMvBlurContext } = require('./helpers/mv-blur-context.cjs');
function fixture(options) {
  const calls = [];
  const native = { runtime: { env: () => '' }, canvas: {
    create: (width, height) => ({ handle: 7, width, height }), release() {},
    adjustTone(...args) { calls.push(['tone', ...args]); },
    rotateHue(...args) { calls.push(['hue', ...args]); },
    readPixels(_h, _x, _y, w, h) { calls.push(['read']); return new Uint8Array(w*h*4); },
    writePixels() { calls.push(['write']); }
  } };
  const context = createMvBlurContext(native, options);
  context.PMJS.phases.emit('afterGuestPlugins');
  return { context, calls, native, bitmap: new context.Bitmap(4, 3) };
}
test('native bitmap color transforms skip JS readback, invalidate content and ignore drawing state', () => {
  const { bitmap, calls } = fixture();
  bitmap._context.translate(2, 3); bitmap._context.globalAlpha = 0.25;
  bitmap._context.globalCompositeOperation = 'multiply';
  const revision = bitmap._canvas.__pmjsContentRevision;
  assert.equal(bitmap.adjustTone(0.5, -1.5, 255), undefined);
  assert.equal(bitmap.rotateHue(360), undefined);
  assert.deepEqual(calls, [['tone', 7, 0.5, -1.5, 255], ['hue', 7, 360]]);
  assert.equal(bitmap.dirtyCalls, 2);
  assert.ok(bitmap._canvas.__pmjsContentRevision > revision);
  assert.equal(bitmap._context.globalAlpha, 0.25);
});
test('neutral and empty bitmaps stay untouched', () => {
  const { bitmap, calls } = fixture();
  bitmap.adjustTone(0, 0, 0); bitmap.rotateHue(0); bitmap.rotateHue(NaN);
  bitmap.width = 0; bitmap.adjustTone(1, 2, 3); bitmap.rotateHue(45);
  assert.deepEqual(calls, []); assert.equal(bitmap.dirtyCalls, 0);
});
test('overridden pixel methods, nonnumeric arguments and unavailable capabilities use stock', () => {
  for (const change of [
    h => { const original = h.bitmap._context.getImageData; h.bitmap._context.getImageData = function(...a) { return original.apply(this, a); }; },
    h => { h.native.canvas.adjustTone = undefined; },
    h => { h.bitmap.width = 2; }
  ]) {
    const h = fixture(); change(h); h.bitmap.adjustTone(1, 2, 3);
    assert.deepEqual(h.calls, [['read'], ['write']]); assert.equal(h.bitmap.dirtyCalls, 1);
  }
  const h = fixture(); h.bitmap.adjustTone('1', undefined, 0);
  assert.deepEqual(h.calls, [['read'], ['write']]);
});
test('disabled optimizations and modified Bitmap methods retain original implementations', () => {
  const h = fixture({ disableOptimizations: ['bitmap.native-adjustTone', 'bitmap.native-rotateHue'] });
  h.bitmap.adjustTone(1, 2, 3); h.bitmap.rotateHue(45);
  assert.deepEqual(h.calls, [['read'], ['write'], ['read'], ['write']]);
  const changed = fixture({ stockAdjustTone: 'function() { this.stockCalls++; }' });
  changed.bitmap.adjustTone(1, 2, 3);
  assert.equal(changed.bitmap.stockCalls, 1); assert.deepEqual(changed.calls, []);
});
