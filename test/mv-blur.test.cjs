'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMvBlurContext } = require('./helpers/mv-blur-context.cjs');

function harness(options) {
  const calls = [];
  const native = { runtime: { env: () => '' }, canvas: {
    create: (width, height) => ({ handle: 7, width, height }), release() {},
    blurMv(handle) { calls.push(handle); return true; },
    drawImage() {}, fillRect() {}, compositePixels() {},
    readPremultipliedPixels(_handle, _x, _y, width, height) { return new Uint8Array(width*height*4); },
  } };
  return { context: createMvBlurContext(native, options), native, calls };
}

test('native MV blur preserves Canvas state and invalidates bitmap content without JS readback', () => {
  const { context, calls } = harness();
  context.PMJS.phases.emit('afterGuestPlugins');
  const bitmap = new context.Bitmap(8, 8);
  bitmap._context.fillStyle = 'red';
  bitmap._context.save();
  const revision = bitmap._canvas.__pmjsContentRevision;
  bitmap.blur();
  assert.deepEqual(calls, [7]);
  assert.equal(bitmap.stockCalls, 0);
  assert.equal(bitmap.dirtyCalls, 1);
  assert.ok(bitmap._canvas.__pmjsContentRevision > revision);
  assert.equal(bitmap._context.fillStyle, 'red');
  assert.equal(bitmap._context.globalAlpha, 1);
  assert.equal(bitmap._context.globalCompositeOperation, 'source-over');
  assert.equal(bitmap._context._stateStack.length, 1);
});

test('MV blur retains the stock method for unsupported state, methods, or native content', () => {
  const mutations = [
    bitmap => { bitmap._context.globalAlpha = 0.5; },
    bitmap => { bitmap._context.globalCompositeOperation = 'multiply'; },
    bitmap => { bitmap._context.translate(1, 0); },
    bitmap => { bitmap._context.beginPath(); bitmap._context.rect(0, 0, 2, 2); bitmap._context.clip(); },
    bitmap => { bitmap._context.drawImage = function() {}; },
    bitmap => { bitmap._context.fillRect = function() {}; },
    bitmap => { bitmap._context.save = function() {}; },
    bitmap => { bitmap._context.restore = function() {}; },
    bitmap => { bitmap.width = 2; },
  ];
  for (const mutate of mutations) {
    const { context, calls } = harness();
    context.PMJS.phases.emit('afterGuestPlugins');
    const bitmap = new context.Bitmap(8, 8);
    mutate(bitmap);
    assert.equal(bitmap.blur(), undefined);
    assert.equal(bitmap.dirtyCalls, 1);

    assert.deepEqual(calls, []);
  }
  const { context, native } = harness();
  context.PMJS.phases.emit('afterGuestPlugins');
  native.canvas.blurMv = () => false;
  assert.equal(new context.Bitmap(8, 8).blur(), undefined);
  delete native.canvas.blurMv;
  assert.equal(new context.Bitmap(8, 8).blur(), undefined);
});

test('native MV blur respects optimization disables and plugin overrides before and after installation', () => {
  const disabled = harness({ disableOptimizations: ['bitmap.native-blur'] });
  disabled.context.PMJS.phases.emit('afterGuestPlugins');
  assert.equal(new disabled.context.Bitmap(8, 8).blur(), undefined);
  assert.deepEqual(disabled.calls, []);

  const { context, calls } = harness();
  const pluginBlur = function() { return 'plugin'; };
  context.Bitmap.prototype.blur = pluginBlur;
  context.PMJS.phases.emit('afterGuestPlugins');
  assert.equal(context.Bitmap.prototype.blur, pluginBlur);
  assert.match(context.PMJS.optimizations.reason('bitmap.native-blur'), /modified Bitmap blur/);
  assert.deepEqual(calls, []);

  const later = harness();
  later.context.PMJS.phases.emit('afterGuestPlugins');
  const bitmap = new later.context.Bitmap(8, 8);
  bitmap.blur = pluginBlur;
  assert.equal(bitmap.blur(), 'plugin');
  later.context.CanvasContext2D.prototype.drawImage = function() {};
  assert.equal(new later.context.Bitmap(8, 8).blur(), undefined);
  assert.deepEqual(later.calls, []);
});

test('native MV blur preserves a custom method already present before installation', () => {
  const { context, calls } = harness({ stockBlur: 'function() { this.stockCalls++; return "authored"; }' });
  const original = context.Bitmap.prototype.blur;
  context.PMJS.phases.emit('afterGuestPlugins');
  const bitmap = new context.Bitmap(8, 8);
  assert.equal(context.Bitmap.prototype.blur, original);
  assert.equal(bitmap.blur(), 'authored');
  assert.equal(bitmap.stockCalls, 1);
  assert.deepEqual(calls, []);
});
