'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMvBlurContext } = require('./helpers/mv-blur-context.cjs');

function harness(options = {}) {
  const calls = [];
  const scales = [];
  const lanes = [];
  const warnings = [];
  const measurements = { writes: 0, reads: 0 };
  const native = { runtime: { env: () => '' }, canvas: {
    create: (width, height) => ({ handle: 7, width, height }), release() {},
    blurMv(handle, scale, laneWidth) { calls.push(handle); scales.push(scale); lanes.push(laneWidth); return true; },
    drawImage() {}, fillRect() {}, compositePixels() {},
    writePremultipliedPixels() { measurements.writes++; },
    readPremultipliedPixels(_handle, _x, _y, width, height) {
      measurements.reads++;
      // The scale measurement reads a 256x3 row of "lighter" results: answer with round(c/9).
      const out = new Uint8Array(width*height*4);
      if (width === 256 && height === 3) {
        for (let channel = 0; channel < 3; channel++) for (let value = 0; value < 256; value++)
          out[(channel * 256 + value) * 4 + channel] = Math.floor((value + 4) / 9);
      }
      // The lane measurement reads 128 rows (span = row % 64 + 1) drawn at x=1. Answer like a
      // rasterizer with options.lanes-pixel batches (default 16): an alpha-zero pixel survives
      // in a full batch holding a nonzero-alpha pixel; options.corrupt(row, i) flips pixels.
      if (width === 66 && height === 128) {
        const lanes = options.lanes || 16;
        const pattern = (row, span, i) => (i * 7 + span * 5 + row) % (row < 64 ? 11 : 29) === 0;
        for (let row = 0; row < 128; row++) {
          const span = row % 64 + 1, full = Math.floor(span / lanes) * lanes;
          for (let i = 0; i < span; i++) {
            let alive = pattern(row, span, i);
            if (!alive) {
              const start = Math.floor(i / lanes) * lanes;
              let batchHasAlpha = false;
              for (let j = start; j < start + lanes && j < span; j++) if (pattern(row, span, j)) batchHasAlpha = true;
              alive = lanes > 1 && i < full && batchHasAlpha;
            }
            if (options.corrupt && options.corrupt(row, i)) alive = !alive;
            if (alive) out[(row * 66 + 1 + i) * 4] = 255;
          }
        }
      }
      return out;
    },
  } };
  const context = createMvBlurContext(native, options);
  context.console = { ...console, warn(message) {
    if (message.startsWith('[pmjs-opt] bitmap.native-blur ')) warnings.push(message);
  } };
  return { context, native, calls, scales, lanes, measurements, warnings };
}

test('native MV blur measures the platform scale once and passes it on every call', () => {
  const { context, scales, measurements } = harness();
  context.PMJS.phases.emit('afterGuestPlugins');
  new context.Bitmap(8, 8).blur();
  new context.Bitmap(4, 4).blur();
  assert.equal(scales.length, 2);
  assert.equal(scales[0], scales[1], 'one table, measured once');
  assert.equal(measurements.writes, 2, 'scale and lane width measured once each');
  assert.equal(scales[0].length, 768);
  for (let channel = 0; channel < 3; channel++) {
    assert.deepEqual(Array.from(scales[0].subarray(channel * 256, channel * 256 + 15)),
      [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2], 'channel ' + channel + ' read from its own lane');
  }
});

test('native MV blur measures the alpha-zero batch width and passes it on', () => {
  for (const lanes of [16, 8, 4]) {
    const measured = harness({ lanes });
    measured.context.PMJS.phases.emit('afterGuestPlugins');
    new measured.context.Bitmap(8, 8).blur();
    new measured.context.Bitmap(8, 8).blur();
    assert.deepEqual(measured.lanes, [lanes, lanes], 'batch width ' + lanes);
  }
  // A rasterizer that breaks the rule anywhere gets no batch width: alpha-zero RGB keeps the stock path.
  for (const corrupt of [(row, i) => row === 70 && i === 3, (row, i) => row === 127 && i === 63]) {
    const odd = harness({ corrupt });
    odd.context.PMJS.phases.emit('afterGuestPlugins');
    new odd.context.Bitmap(8, 8).blur();
    assert.deepEqual(odd.lanes, [0]);
  }
});

test('a failed scale measurement keeps the stock blur', () => {
  const { context, native, calls, warnings } = harness();
  native.canvas.writePremultipliedPixels = () => { throw new Error('no pixels'); };
  context.PMJS.phases.emit('afterGuestPlugins');
  const bitmap = new context.Bitmap(8, 8);
  assert.equal(bitmap.blur(), undefined);
  assert.deepEqual(calls, []);
  assert.equal(warnings.length, 1);
});

test('native MV blur preserves Canvas state and invalidates bitmap content without JS readback', () => {
  const { context, calls, warnings } = harness();
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
  assert.equal(bitmap._context.fillStyle, '#ff0000');
  assert.equal(bitmap._context.globalAlpha, 1);
  assert.equal(bitmap._context.globalCompositeOperation, 'source-over');
  assert.equal(bitmap._context._stateStack.length, 1);
  assert.deepEqual(warnings, []);
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
    const { context, calls, warnings } = harness();
    context.PMJS.phases.emit('afterGuestPlugins');
    const bitmap = new context.Bitmap(8, 8);
    mutate(bitmap);
    assert.equal(bitmap.blur(), undefined);
    assert.equal(bitmap.dirtyCalls, 1);

    assert.deepEqual(calls, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /bitmap.native-blur refused for this use: /);
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

test('native blur resolves the current Bitmap prototype after guest plugins', () => {
  for (const override of [false, true]) {
    const { context } = harness();
    const previous = context.Bitmap.prototype;
    const original = previous.blur;
    const replacement = Object.create(previous);
    if (override) replacement.blur = function() { return 'plugin'; };
    context.Bitmap.prototype = replacement;
    const effective = replacement.blur;
    context.PMJS.phases.emit('afterGuestPlugins');
    assert.equal(previous.blur, original);
    if (override) {
      assert.equal(replacement.blur, effective);
      assert.match(context.PMJS.optimizations.reason('bitmap.native-blur'), /modified Bitmap blur/);
    } else {
      assert.notEqual(replacement.blur, original);
    }
  }
});

test('a guest locking a reviewed Bitmap method does not turn optional installation into a boot error', () => {
  const { context } = harness();
  const original = context.Bitmap.prototype.blur;
  Object.defineProperty(context.Bitmap.prototype, 'blur', { writable: false });
  assert.doesNotThrow(() => context.PMJS.phases.emit('afterGuestPlugins'));
  assert.equal(context.Bitmap.prototype.blur, original);
});
