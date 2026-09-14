'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));

native.initialize({
  gameRoot: path.resolve(process.argv[3]),
  assetRoot: '',
  width: 64,
  height: 64,
  windowTitle: 'deferred canvas test',
});

// 1. Creation should be deferred: liveCount = 1, liveBytes = 0, cpuPixelBytes = 0
const c1 = native.canvas.create(100, 100);
assert.equal(typeof c1.handle, 'number');
assert.equal(c1.width, 100);
assert.equal(c1.height, 100);

let mem = native.canvas.memory();
assert.equal(mem.liveCount, 1);
assert.equal(mem.liveBytes, 0, 'Deferred canvas must not allocate CPU pixels');
assert.equal(mem.cpuPixelBytes, 0, 'cpuPixelBytes must be 0 for deferred canvas');
assert.equal(mem.deferredCanvasCount, 1, 'deferredCanvasCount must be 1');
assert.equal(mem.realizedCanvasCount, 0, 'realizedCanvasCount must be 0');
assert.equal(mem.deferredCommandCount, 0, 'deferredCommandCount must start at 0');
assert.equal(mem.deferredCommandBytes, 0, 'deferredCommandBytes must start at 0');

// 2. Safe operations (fillRect, clearRect, blur) queue without realizing
native.canvas.fillRect(c1.handle, 10, 10, 20, 20, 0xff0000ff);
native.canvas.clearRect(c1.handle, 15, 15, 5, 5);
native.canvas.blur(c1.handle);

mem = native.canvas.memory();
assert.equal(mem.liveBytes, 0, 'Queued draw operations must not realize canvas early');
assert.equal(mem.deferredCanvasCount, 1);
assert.equal(mem.realizedCanvasCount, 0);
assert.equal(mem.deferredCommandCount, 3, 'Expected 3 queued commands');
assert.ok(mem.deferredCommandBytes > 0, 'deferredCommandBytes should track queued command memory');

// Also test drawImage from an ImageHandle queues and retains image
const fixture = native.images.load('fixture.png');
native.canvas.drawImage(c1.handle, fixture.handle, 0, 0, 16, 16, 0, 0, 16, 16, 1.0);
mem = native.canvas.memory();
assert.equal(mem.liveBytes, 0, 'drawImage from ImageHandle must remain deferred');
assert.equal(mem.deferredCommandCount, 4, 'Expected 4 queued commands');
native.images.release(fixture.handle);

// 3. Direct pixel readback triggers realization and produces correct output
const p1 = native.canvas.pixel(c1.handle, 12, 12);
assert.ok(p1 !== 0, 'pixel(12, 12) should have content after replay');

mem = native.canvas.memory();
assert.equal(mem.liveBytes, 100 * 100 * 4, 'Canvas should be realized after pixel()');
assert.equal(mem.deferredCanvasCount, 0);
assert.equal(mem.realizedCanvasCount, 1);
assert.equal(mem.deferredCommandCount, 0, 'Realized canvas commands must be cleared');
assert.equal(mem.deferredCommandBytes, 0);

native.canvas.release(c1.handle);
mem = native.canvas.memory();
assert.equal(mem.liveCount, 0);
assert.equal(mem.liveBytes, 0);

// 4. Deferred clear() should discard commands and dependencies at zero cost
const c2 = native.canvas.create(200, 200);
native.canvas.fillRect(c2.handle, 0, 0, 100, 100, 0x00ff00ff);
const fixture2 = native.images.load('fixture.png');
native.canvas.drawImage(c2.handle, fixture2.handle, 0, 0, 16, 16, 0, 0, 16, 16, 1.0);
native.images.release(fixture2.handle);

mem = native.canvas.memory();
assert.equal(mem.deferredCommandCount, 2);
native.canvas.clear(c2.handle);
mem = native.canvas.memory();
assert.equal(mem.liveBytes, 0, 'Deferred clear must keep canvas unrealized');
assert.equal(mem.deferredCommandCount, 0, 'Deferred clear must reset command queue');
assert.equal(mem.deferredCommandBytes, 0);

// Reading pixels after clear should show 0 everywhere
const pxCleared = native.canvas.pixel(c2.handle, 50, 50);
assert.equal(pxCleared, 0, 'Cleared canvas pixel should be 0');
native.canvas.release(c2.handle);

// 5. Full clearRect() covering whole canvas resets queue like clear()
const c2b = native.canvas.create(50, 50);
native.canvas.fillRect(c2b.handle, 0, 0, 50, 50, 0x112233ff);
mem = native.canvas.memory();
assert.equal(mem.deferredCommandCount, 1);
native.canvas.clearRect(c2b.handle, 0, 0, 50, 50);
mem = native.canvas.memory();
assert.equal(mem.deferredCommandCount, 0, 'Full clearRect must reset deferred command queue');
assert.equal(mem.liveBytes, 0, 'Full clearRect must not allocate CPU pixels');
native.canvas.release(c2b.handle);

// 6. Canvas -> Canvas drawImage MUST force realization of destination immediately
// and preserve draw-call snapshot semantics!
const srcCanvas = native.canvas.create(40, 40);
native.canvas.fillRect(srcCanvas.handle, 0, 0, 40, 40, 0xff0000ff); // RED
const dstCanvas = native.canvas.create(40, 40);

mem = native.canvas.memory();
assert.equal(mem.deferredCanvasCount, 2, 'Both canvases start deferred');

// Draw src into dst -> dst must realize immediately
native.canvas.drawImage(dstCanvas.handle, srcCanvas.handle, 0, 0, 40, 40, 0, 0, 40, 40, 1.0);
mem = native.canvas.memory();
assert.equal(mem.realizedCanvasCount, 2, 'Canvas -> Canvas blit realizes both src and dst');

// Now modify srcCanvas to BLUE
native.canvas.clear(srcCanvas.handle);
native.canvas.fillRect(srcCanvas.handle, 0, 0, 40, 40, 0x0000ffff); // BLUE

// dstCanvas must still be RED
const dstColor = native.canvas.pixel(dstCanvas.handle, 20, 20);
assert.equal(dstColor, 0xff0000ff, 'dstCanvas must preserve snapshot of src at drawImage time (RED, not BLUE)');

native.canvas.release(srcCanvas.handle);
native.canvas.release(dstCanvas.handle);

// 7. writePixels MUST force realization immediately
const cWrite = native.canvas.create(20, 20);
mem = native.canvas.memory();
assert.equal(mem.deferredCanvasCount, 1);

const pxData = new Uint8Array(4 * 4 * 4);
pxData.fill(0xaa);
native.canvas.writePixels(cWrite.handle, 0, 0, 4, 4, pxData);

mem = native.canvas.memory();
assert.equal(mem.realizedCanvasCount, 1, 'writePixels must realize canvas immediately');
assert.equal(mem.deferredCanvasCount, 0);
assert.equal(mem.liveBytes, 20 * 20 * 4);
native.canvas.release(cWrite.handle);

// 8. Scene submission with deferred canvas should realize and render
const uploadsBeforeScene = native.images.memory(0);
const c3 = native.canvas.create(32, 32);
native.canvas.fillRect(c3.handle, 0, 0, 32, 32, 0x123456ff);
mem = native.canvas.memory();
assert.equal(mem.liveBytes, 0, 'c3 should be deferred');

const schema = native.scene.schema;
const metadata = new Uint32Array([
  1, 0xffffffff, c3.handle, 0xffffff, 0, 0, 0,
]);
const values = new Float32Array(schema.valueStride);
values.set([1, 0, 0, 1, 0, 0, 1], 0);
values.set([0, 0, 32, 32], 9);
values.set([32, 32], 13);

native.beginFrame();
native.scene.submit(schema.version, metadata, values, 1);
native.renderFrame();

let uploads = native.images.memory(0);
assert.ok(uploads.textureCreates >= uploadsBeforeScene.textureCreates + 1);
assert.equal(uploads.textureFullUpdates, uploadsBeforeScene.textureFullUpdates);
assert.equal(uploads.textureRegionUpdates,
  uploadsBeforeScene.textureRegionUpdates);
assert.ok(uploads.textureUploadBytes >=
  uploadsBeforeScene.textureUploadBytes + 32 * 32 * 4);

mem = native.canvas.memory();
assert.equal(mem.liveBytes, 32 * 32 * 4, 'c3 should have been realized upon submitScene');

const frame = native.canvas.captureScene();
const sampled = native.canvas.pixel(frame.handle, 16, 16);
assert.equal(sampled, 0x123456ff, 'Rendered frame should match canvas color');

const uploadsBeforeMutation = native.images.memory(0);
native.canvas.fillRect(c3.handle, 0, 0, 1, 1, 0xffffffff);
native.beginFrame();
native.renderFrame();
uploads = native.images.memory(0);
assert.equal(uploads.textureCreates, uploadsBeforeMutation.textureCreates);
assert.equal(uploads.textureFullUpdates, uploadsBeforeMutation.textureFullUpdates);
assert.equal(uploads.textureRegionUpdates,
  uploadsBeforeMutation.textureRegionUpdates + 1);
assert.equal(uploads.textureUploadBytes,
  uploadsBeforeMutation.textureUploadBytes + 4);

native.canvas.release(frame.handle);
native.canvas.release(c3.handle);

console.log('Deferred canvas tests passed successfully.');
