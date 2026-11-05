'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 64, height: 64,
  windowTitle: 'Deferred paints' });
assert.equal(native.canvas.glyphStats().backend, 'skia65');
const owned = new Set();
function canvas() { const c = native.canvas.create(64, 64); owned.add(c.handle); return c.handle; }
function release(handle) { native.canvas.release(handle); owned.delete(handle); }
const pixels = handle => Buffer.from(native.canvas.readPremultipliedPixels(handle, 0, 0, 64, 64));
function draw(handle, offsets, colors) {
  native.canvas.fillRect(handle, 0, 0, 64, 64, 0x304050ff);
  native.canvas.drawText(handle, 'text-shaping.ttf', 'AV', 2.25, 25.5, 20, 0xffffff80);
  assert.equal(native.canvas.paintRect(handle, 0.25, 15.75, 50.5, 32.25, 0xffffff80, 1.5,
    2.25, 16, 47.5, 42.25, offsets, colors), true);
  native.canvas.clearRect(handle, 3, 4, 5, 6);
  native.canvas.drawText(handle, 'text-shaping.ttf', 'é', 20, 30, 16, 0x2070f0ff);
}
try {
  const immediate = canvas(), deferred = canvas();
  pixels(immediate);
  const offsets = [0, 0.4, 1], colors = [0xff000080, 0x00ff00ff, 0x0000ff00];
  draw(immediate, offsets, colors);
  draw(deferred, offsets, colors);
  assert.equal(native.canvas.memory().deferredCanvasCount, 1);
  offsets[1] = 0.8; colors[0] = 0xffffffff;
  const retained = canvas();
  native.canvas.drawImage(retained, deferred, 0, 0, 64, 64, 0, 0, 64, 64, 1);
  native.canvas.clear(deferred);
  release(deferred);
  assert.deepEqual(pixels(retained), pixels(immediate));
  release(retained); release(immediate);
  const discarded = canvas();
  draw(discarded, [0, 1], [0xffffffff, 0x000000ff]);
  assert.equal(native.canvas.memory().cpuPixelBytes, 0);
  native.canvas.clear(discarded);
  assert.equal(native.canvas.memory().deferredCommandCount, 0);
  assert.ok(pixels(discarded).every(byte => byte === 0));
  release(discarded);
  const overflow = canvas(), direct = canvas(); pixels(direct);
  for (let i = 0; i < 300; i++) for (const handle of [overflow, direct]) {
    native.canvas.paintRect(handle, i % 64, i % 61, 4, 3, 0xffffff80, 0,
      0, 0, 64, 0, [0, 1], [0xff000080, 0x00ff0080]);
  }
  assert.deepEqual(pixels(overflow), pixels(direct));
  release(overflow); release(direct);
  assert.equal(native.canvas.memory().liveCount, 0);
} finally { for (const h of owned) native.canvas.release(h); native.runtime.quit(); }
