'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));

native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '',
  width: 16, height: 16, windowTitle: 'binding errors' });
try {
  assert.throws(() => native.canvas.create('wide', 4), TypeError);
  assert.throws(() => native.canvas.create(-1, 4), RangeError);
  assert.throws(() => native.canvas.readPixels(), TypeError);
  assert.throws(() => native.runtime.preparationProgress({ completed: -1, total: 1 }), RangeError);
  assert.throws(() => native.canvas.fillRect(0xffffffff, 0, 0, 1, 1, 0xffffffff),
    error => error.constructor === Error && /invalid canvas/.test(error.message));

  const canvas = native.canvas.create(4, 4);
  assert.throws(() => native.canvas.compositePixels(canvas.handle, 0, 0, 1, 1,
    {}, new Uint8Array(1), 'copy', 1), TypeError);
  assert.throws(() => native.canvas.compositePixels(canvas.handle, 0, 0, 1, 1,
    new Uint8Array(4), new Uint8Array(1), 'invalid', 1), RangeError);
  const getterError = new SyntaxError('descriptor getter failed');
  assert.throws(() => native.canvas.paintCircle(canvas.handle, {
    get geometry() { throw getterError; }
  }), error => error === getterError);

  const image = native.images.load('fixture.png');
  const directory = native.fs.readDirectory('.');
  assert.ok(directory.includes('fixture.png'));
  assert.ok(directory.every(name => typeof name === 'string'));
  assert.throws(() => native.fs.readDirectory('missing-directory'), /cannot read directory/);
  const memory = native.images.memory(100);
  assert.equal(typeof memory.tileHits, 'number');
  assert.equal(typeof memory.sceneryWindowRejections, 'object');
  assert.equal(typeof memory.preparedFallbacks, 'object');
  const entry = memory.largest.find(item => item.handle === image.handle);
  assert.equal(entry.width, image.width);
  assert.equal(entry.height, image.height);
  assert.equal(typeof entry.path, 'string');
  assert.equal(typeof entry.warm, 'boolean');

  const setterError = new SyntaxError('result setter failed');
  for (const [key, operation] of [
    ['x', () => native.runtime.windowState()],
    ['pointerEvents', () => native.input.snapshot()],
    ['tileHits', () => native.images.memory(100)],
    ['handle', () => native.images.memory(100)]
  ]) {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
    Object.defineProperty(Object.prototype, key, {
      configurable: true, set() { throw setterError; }
    });
    try {
      assert.throws(operation, error => error === setterError);
    } finally {
      if (previous) Object.defineProperty(Object.prototype, key, previous);
      else delete Object.prototype[key];
    }
  }
  assert.equal(typeof native.runtime.windowState().width, 'number');
  const snapshot = native.input.snapshot();
  for (const key of ['keysDown', 'keysPressed', 'keyEvents', 'pointerEvents', 'gamepads'])
    assert.ok(Array.isArray(snapshot[key]), key);
  assert.ok(native.images.memory(100).largest.some(item => item.handle === image.handle));
  native.images.release(image.handle);
  native.canvas.release(canvas.handle);
} finally {
  native.runtime.quit();
}
