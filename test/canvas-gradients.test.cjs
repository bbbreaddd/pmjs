'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../js/pmjs-web/canvas.js'), 'utf8');

test('concentric radial gradient fill uses the native canvas fast path', () => {
  const calls = [];
  const context = {
    console,
    NativeHost: {
      runtime: { env: function() { return ''; } },
      canvas: {
        fillRadialGradient: function() { calls.push(Array.from(arguments)); }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const canvas = {
    width: 100,
    height: 80,
    _ensureNativeCanvas: function() { return { handle: 7 }; }
  };
  const drawing = new context.CanvasContext2D(canvas);
  const gradient = drawing.createRadialGradient(50, 40, 0, 50, 40, 30);
  gradient.addColorStop(0, '#ffffff');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  drawing.fillStyle = gradient;
  drawing.fillRect(20, 10, 60, 60);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 9), [7, 20, 10, 60, 60, 50, 40, 0, 30]);
  assert.deepEqual(Array.from(calls[0][9]), [0, 1]);
  assert.equal(calls[0][11], false);

  drawing.globalCompositeOperation = 'lighter';
  drawing.fillRect(20, 10, 60, 60);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][11], true);
});

test('radial gradients reject negative radii and invalid stops', () => {
  const context = { console, NativeHost: { runtime: { env: function() { return ''; } } } };
  vm.createContext(context);
  vm.runInContext(source, context);
  const drawing = new context.CanvasContext2D({});
  assert.throws(
    () => drawing.createRadialGradient(0, 0, -1, 0, 0, 1),
    /negative radial gradient radius/,
  );
  const gradient = drawing.createRadialGradient(0, 0, 0, 0, 0, 1);
  assert.throws(() => gradient.addColorStop(2, '#fff'), /invalid color stop/);
});

test('linear and radial factories inherit extensions from the shared gradient prototype', () => {
  const context = vm.createContext({ NativeHost: { runtime: { env: () => '' } } });
  vm.runInContext(source, context);
  vm.runInContext(`CanvasGradient.prototype.transparentStops = function() {
    this.addColorStop(0, 'rgba(255, 255, 255, 1)');
    this.addColorStop(1, 'rgba(255, 255, 255, 0)');
  };`, context);
  const drawing = new context.CanvasContext2D({});
  for (const gradient of [drawing.createLinearGradient(0, 0, 10, 0), drawing.createRadialGradient(0, 0, 0, 0, 0, 10)]) {
    assert.ok(gradient instanceof context.CanvasGradient);
    gradient.transparentStops();
    assert.deepEqual(Array.from(gradient.stops, stop => stop.offset), [0, 1]);
    assert.throws(() => gradient.addColorStop(0.5, 'invalid'), /Invalid color/);
  }
});

test('portable radial sampling chooses a circle with a nonnegative radius', () => {
  const context = vm.createContext({ NativeHost: { runtime: { env: () => '' } } });
  vm.runInContext(source, context);
  const drawing = new context.CanvasContext2D({});
  const gradient = drawing.createRadialGradient(0, 0, 0, 1, 0, 2);
  gradient.addColorStop(0, 'red'); gradient.addColorStop(1, 'blue');
  assert.equal(context.canvasStyleRgba(gradient, 1.5, 0, 1), 0x800080ff);
  const cone = drawing.createRadialGradient(0, 0, 1, 4, 0, 1);
  cone.addColorStop(0, 'red'); cone.addColorStop(1, 'blue');
  assert.equal(context.canvasStyleRgba(cone, 0, 3, 1), 0);
});
