'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 16, height: 16,
  windowTitle: 'Allocator reclamation' });
const canvas = native.canvas.create(16, 16);
const pixels = new Uint8Array(16 * 16 * 4).fill(127);
native.canvas.writePixels(canvas.handle, 0, 0, 16, 16, pixels);
const pixelsBefore = native.canvas.readPixels(canvas.handle, 0, 0, 16, 16);
native.beginFrame();
native.render.quad(0, 0, 16, 16, 0, 1, 0, 1);
const image = native.render.renderToImage(16, 16);
// Initialize diagnostic backing storage before comparing live resource counts.
native.images.memory(0);
native.canvas.memory();
const imagesBefore = native.images.memory(0), canvasBefore = native.canvas.memory();
const result = native.runtime.trimAllocator();
assert.ok(result === undefined || typeof result === 'boolean');
assert.equal(native.images.memory(0).gpuBytes, imagesBefore.gpuBytes);
assert.equal(native.canvas.memory().cpuPixelBytes, canvasBefore.cpuPixelBytes);
assert.deepEqual(native.canvas.readPixels(canvas.handle, 0, 0, 16, 16), pixelsBefore);
native.beginFrame();
native.render.image(image.handle, 1, 0, 0, 1, 0, 0, 0, 0, 16, 16, 1, 0xffffff, 0);
native.renderScene();
const capture = native.canvas.captureScene();
assert.deepEqual(Array.from(native.canvas.readPixels(capture.handle, 8, 8, 1, 1)), [0, 255, 0, 255]);
native.canvas.release(capture.handle);
native.images.release(image.handle);
native.canvas.release(canvas.handle);
native.runtime.quit();
