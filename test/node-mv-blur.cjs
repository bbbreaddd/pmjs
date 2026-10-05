'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 32, height: 32,
  windowTitle: 'MV blur ownership' });
const handles = new Set();
function canvas(width, height) {
  const value = native.canvas.create(width, height);
  handles.add(value.handle);
  return value;
}
function read(value) {
  return Array.from(native.canvas.readPremultipliedPixels(value.handle, 0, 0, value.width, value.height));
}
try {
  const source = canvas(1, 1), retained = canvas(1, 1);
  native.canvas.fillRect(source.handle, 0, 0, 1, 1, 0xff0000ff);
  native.canvas.drawImage(retained.handle, source.handle, 0, 0, 1, 1, 0, 0, 1, 1, 1);
  assert.equal(native.canvas.blurMv(source.handle), true);
  assert.deepEqual(read(source), [75, 0, 0, 255]);
  native.canvas.release(source.handle);
  handles.delete(source.handle);
  assert.deepEqual(read(retained), [255, 0, 0, 255], 'queued source snapshot survives blur and release');
  assert.throws(() => native.canvas.blurMv(source.handle), /invalid canvas/);
  assert.throws(() => native.canvas.blurMv(0), /invalid canvas/);

  const white = canvas(2, 2);
  native.canvas.fillRect(white.handle, 0, 0, 2, 2, 0xffffffff);
  assert.equal(native.canvas.blurMv(white.handle), true);
  assert.deepEqual(read(white), Array(4).fill([200, 200, 200, 255]).flat());
  const clear = canvas(8, 8);
  assert.equal(native.canvas.blurMv(clear.handle), true);
  assert.deepEqual(read(clear), Array(64).fill([0, 0, 0, 255]).flat());

  const raw = canvas(1, 1), bytes = new Uint8Array([255, 2, 3, 0]);
  native.canvas.writePremultipliedPixels(raw.handle, 0, 0, 1, 1, bytes);
  assert.equal(native.canvas.blurMv(raw.handle), false);
  assert.deepEqual(read(raw), Array.from(bytes), 'unsupported raw content remains unchanged');
} finally {
  for (const handle of handles) native.canvas.release(handle);
  native.runtime.quit();
}
