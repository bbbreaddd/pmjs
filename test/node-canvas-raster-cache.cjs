'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: process.cwd(), width: 64, height: 64,
  windowTitle: 'Canvas raster reuse ownership' });
const handles = [];
function create(width, height) {
  const canvas = native.canvas.create(width, height);
  handles.push(canvas.handle);
  return canvas.handle;
}
function pixels(handle) {
  return Buffer.from(native.canvas.readPremultipliedPixels(handle, 0, 0, 64, 64));
}
try {
  const source = create(2, 2);
  native.canvas.writePremultipliedPixels(source, 0, 0, 2, 2, Uint8Array.from([
    200, 0, 0, 100, 0, 128, 0, 128, 0, 0, 255, 255, 0, 0, 0, 0
  ]));
  function render({ reference = false, alpha = 1, smoothing = true } = {}) {
    const target = create(64, 64);
    // A transparent fill preserves pixels but excludes this command list from reuse.
    if (reference) native.canvas.fillRect(target, 0, 0, 64, 64, 0);
    native.canvas.drawImage(target, source, 0, 0, 2, 2, 0, 0, 64, 64, alpha, smoothing);
    native.canvas.drawImage(target, source, 0, 0, 1, 1, 10.25, 7.5, 12.5, 18.25, 0.5, smoothing);
    return target;
  }
  const expected = pixels(render({ reference: true }));
  const first = render(); assert.deepEqual(pixels(first), expected);
  const hits = native.canvas.memory().rasterCacheHits;
  const second = render(); assert.notEqual(first, second);
  assert.deepEqual(pixels(second), expected);
  assert.equal(native.canvas.memory().rasterCacheHits, hits + 1);
  native.canvas.fillRect(second, 0, 0, 64, 64, 0x00ff00ff);
  assert.deepEqual(pixels(first), expected, 'editing the new destination leaves the retained one unchanged');
  assert.deepEqual(pixels(render()), expected, 'an edited cached result is never copied');
  const pending = render();
  native.canvas.writePixels(pending, 0, 0, 1, 1, Uint8Array.from([255, 255, 255, 255]));
  assert.deepEqual(pixels(render()), expected,
    'a write that realizes deferred drawing invalidates the result after the write');
  for (const options of [{ alpha: 0.5 }, { smoothing: false }]) {
    assert.deepEqual(pixels(render(options)), pixels(render({ ...options, reference: true })));
  }
  native.canvas.writePixels(source, 0, 0, 2, 2, Uint8Array.from([
    0, 0, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255, 255, 255, 255, 255
  ]));
  const changed = pixels(render());
  assert.notDeepEqual(changed, expected);
  assert.deepEqual(changed, pixels(render({ reference: true })), 'source mutation invalidates the key');
  assert.deepEqual(pixels(first), expected, 'source edits leave already realized destinations unchanged');
  console.log('Canvas raster cache matches uncached draws and preserves independent ownership');
} finally {
  for (const handle of handles) native.canvas.release(handle);
  assert.equal(native.canvas.memory().cpuPixelBytes, 0, 'weak entries release their metadata with the canvases');
  native.runtime.quit();
}
