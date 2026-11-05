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

  const setterError = new SyntaxError('result setter failed');
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'x');
  Object.defineProperty(Object.prototype, 'x', {
    configurable: true, set() { throw setterError; }
  });
  try {
    assert.throws(() => native.runtime.windowState(), error => error === setterError);
  } finally {
    if (previous) Object.defineProperty(Object.prototype, 'x', previous);
    else delete Object.prototype.x;
  }
  assert.equal(typeof native.runtime.windowState().width, 'number');
  native.canvas.release(canvas.handle);
} finally {
  native.runtime.quit();
}
