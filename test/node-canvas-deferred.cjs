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

// The first memory query creates the diagnostic fallback texture.
native.images.memory(0);

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
const beforeCpuRead = native.images.memory(0);
const p1 = native.canvas.pixel(c1.handle, 12, 12);
assert.ok(p1 !== 0, 'pixel(12, 12) should have content after replay');
assert.equal(native.images.memory(0).textureCreates, beforeCpuRead.textureCreates,
  'CPU observation must not allocate a Canvas texture');
assert.equal(native.images.memory(0).textureUploadBytes, beforeCpuRead.textureUploadBytes);

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

// 6. Canvas draws capture their source without forcing CPU realization.
const srcCanvas = native.canvas.create(40, 40);
native.canvas.fillRect(srcCanvas.handle, 0, 0, 40, 40, 0xff0000ff); // RED
const dstCanvas = native.canvas.create(40, 40);

mem = native.canvas.memory();
assert.equal(mem.deferredCanvasCount, 2, 'Both canvases start deferred');

const beforeCopy = native.images.memory(0);
// Capture the source content before its next mutation.
native.canvas.drawImage(dstCanvas.handle, srcCanvas.handle, 0, 0, 40, 40, 0, 0, 40, 40, 1.0);
mem = native.canvas.memory();
assert.equal(mem.realizedCanvasCount, 0, 'Canvas copies should remain deferred');
assert.equal(mem.cpuPixelBytes, 0);

// Now modify srcCanvas to BLUE
native.canvas.clear(srcCanvas.handle);
native.canvas.fillRect(srcCanvas.handle, 0, 0, 40, 40, 0x0000ffff); // BLUE

// dstCanvas must still be RED
const dstColor = native.canvas.pixel(dstCanvas.handle, 20, 20);
assert.equal(dstColor, 0xff0000ff, 'dstCanvas must preserve snapshot of src at drawImage time (RED, not BLUE)');
assert.equal(native.images.memory(0).textureCreates, beforeCopy.textureCreates,
  'CPU Canvas copies and mutations must not allocate textures');
assert.equal(native.images.memory(0).textureUploadBytes, beforeCopy.textureUploadBytes);

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

const beforeCapture = native.images.memory(0);
const frame = native.canvas.captureScene();
const sampled = native.canvas.pixel(frame.handle, 16, 16);
assert.equal(sampled, 0x123456ff, 'Rendered frame should match canvas color');
assert.equal(native.images.memory(0).textureCreates, beforeCapture.textureCreates,
  'a CPU readback capture must not upload its pixels back to the GPU');
assert.equal(native.images.memory(0).textureUploadBytes, beforeCapture.textureUploadBytes);

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

// A CPU-only Canvas uploads its latest pixels once, when first submitted.
const cpuOnly = native.canvas.create(32, 32);
const beforeCpuOnly = native.images.memory(0);
native.canvas.fillRect(cpuOnly.handle, 0, 0, 32, 32, 0xff0000ff);
assert.equal(native.canvas.pixel(cpuOnly.handle, 16, 16), 0xff0000ff);
native.canvas.writePixels(cpuOnly.handle, 16, 16, 1, 1, new Uint8Array([0, 255, 0, 255]));
assert.ok(native.canvas.encodePng(cpuOnly.handle).length > 0);
native.beginFrame();
native.renderFrame();
assert.equal(native.images.memory(0).textureCreates, beforeCpuOnly.textureCreates);
assert.equal(native.images.memory(0).textureUploadBytes, beforeCpuOnly.textureUploadBytes,
  'the frame upload sweep must leave CPU-only Canvases alone');
metadata[2] = cpuOnly.handle;
native.beginFrame();
native.scene.submit(schema.version, metadata, values, 1);
native.renderFrame();
assert.equal(native.images.memory(0).textureCreates, beforeCpuOnly.textureCreates + 1);
assert.equal(native.images.memory(0).textureUploadBytes, beforeCpuOnly.textureUploadBytes + 32 * 32 * 4);
const cpuFrame = native.canvas.captureScene();
assert.equal(native.canvas.pixel(cpuFrame.handle, 16, 16), 0x00ff00ff);
assert.equal(native.canvas.pixel(cpuFrame.handle, 15, 16), 0xff0000ff);
native.canvas.release(cpuFrame.handle);
native.canvas.release(cpuOnly.handle);

// Chained snapshots survive source mutation, owner release, and handle reuse.
function copyCanvas(destination, source, width = 4, height = 4) {
  native.canvas.drawImage(destination.handle, source.handle, 0, 0, width, height,
    0, 0, width, height, 1);
}
const chainA = native.canvas.create(4, 4);
const chainB = native.canvas.create(4, 4);
const chainC = native.canvas.create(4, 4);
native.canvas.fillRect(chainA.handle, 0, 0, 4, 4, 0xff0000ff);
copyCanvas(chainB, chainA);
copyCanvas(chainC, chainB);
assert.equal(native.canvas.memory().cpuPixelBytes, 0);
native.canvas.fillRect(chainA.handle, 0, 0, 4, 4, 0x0000ffff);
native.canvas.clear(chainB.handle);
native.canvas.release(chainA.handle);
native.canvas.release(chainB.handle);
const recycled = native.canvas.create(8, 8);
native.canvas.fillRect(recycled.handle, 0, 0, 8, 8, 0x00ff00ff);
assert.equal(native.canvas.pixel(chainC.handle, 2, 2), 0xff0000ff);
native.canvas.release(chainC.handle);
native.canvas.release(recycled.handle);
assert.equal(native.canvas.memory().cpuPixelBytes, 0);
assert.equal(native.canvas.memory().deferredCommandCount, 0);

// Many readers share one realized source; only a mutation copies its pixels.
const shared = native.canvas.create(4, 4);
native.canvas.fillRect(shared.handle, 0, 0, 4, 4, 0x112233ff);
assert.equal(native.canvas.pixel(shared.handle, 0, 0), 0x112233ff);
const readers = Array.from({ length: 8 }, () => native.canvas.create(4, 4));
for (const reader of readers) copyCanvas(reader, shared);
assert.equal(native.canvas.memory().cpuPixelBytes, 4 * 4 * 4);
native.canvas.writePixels(shared.handle, 0, 0, 1, 1, new Uint8Array([255, 0, 0, 255]));
assert.equal(native.canvas.memory().cpuPixelBytes, 2 * 4 * 4 * 4);
assert.equal(native.canvas.pixel(shared.handle, 0, 0), 0xff0000ff);
native.canvas.release(shared.handle);
assert.equal(native.canvas.memory().cpuPixelBytes, 4 * 4 * 4,
  'released source pixels remain accounted for while readers retain them');
for (const reader of readers) {
  assert.equal(native.canvas.pixel(reader.handle, 0, 0), 0x112233ff);
  native.canvas.release(reader.handle);
}
assert.equal(native.canvas.memory().cpuPixelBytes, 0);

// Crop, scaling, alpha, and self draws agree with immediate CPU rasterization.
function drawSequence(immediate) {
  const source = native.canvas.create(4, 4);
  const destination = native.canvas.create(7, 5);
  native.canvas.fillRect(source.handle, 0, 0, 4, 4, 0x33669980);
  native.canvas.fillRect(source.handle, 1, 1, 2, 2, 0xff0000c0);
  native.canvas.fillRect(destination.handle, 0, 0, 7, 5, 0x00ff0030);
  if (immediate) native.canvas.pixel(destination.handle, 0, 0);
  native.canvas.drawImage(destination.handle, source.handle, 1, 0, 3, 4, -1, 1, 8, 3, 0.6);
  native.canvas.drawImage(destination.handle, destination.handle, 0, 0, 6, 4, 1, 1, 6, 4, 0.7);
  native.canvas.clear(source.handle);
  native.canvas.release(source.handle);
  const pixels = Array.from(native.canvas.readPixels(destination.handle, 0, 0, 7, 5));
  native.canvas.release(destination.handle);
  return pixels;
}
assert.deepEqual(drawSequence(false), drawSequence(true));

// Every CPU drawing entry point preserves an already captured source version.
for (const mutate of [
  canvas => native.canvas.clearRect(canvas.handle, 0, 0, 4, 4),
  canvas => native.canvas.blur(canvas.handle),
  canvas => native.canvas.drawText(canvas.handle, 'text-shaping.ttf', 'A', 0, 12, 12, 0xffffffff),
  canvas => native.canvas.fillRadialGradient(canvas.handle, 0, 0, 16, 16,
    8, 8, 0, 8, [0, 1], [0x00ff00ff, 0x00000000], false),
]) {
  const source = native.canvas.create(16, 16);
  const reader = native.canvas.create(16, 16);
  native.canvas.fillRect(source.handle, 0, 0, 8, 16, 0xff0000ff);
  const original = Array.from(native.canvas.readPixels(source.handle, 0, 0, 16, 16));
  copyCanvas(reader, source, 16, 16);
  mutate(source);
  assert.notDeepEqual(Array.from(native.canvas.readPixels(source.handle, 0, 0, 16, 16)), original);
  assert.deepEqual(Array.from(native.canvas.readPixels(reader.handle, 0, 0, 16, 16)), original);
  native.canvas.release(source.handle);
  native.canvas.release(reader.handle);
}

// Repeated self draws eventually use the bounded immediate path.
const self = native.canvas.create(4, 1);
native.canvas.fillRect(self.handle, 0, 0, 1, 1, 0xff0000ff);
for (let index = 0; index < 64; index++) {
  native.canvas.drawImage(self.handle, self.handle, 0, 0, 3, 1, 1, 0, 3, 1, 1);
}
assert.equal(native.canvas.memory().realizedCanvasCount, 1);
assert.deepEqual(Array.from(native.canvas.readPixels(self.handle, 0, 0, 4, 1)),
  Array.from({ length: 4 }, () => [255, 0, 0, 255]).flat());
native.canvas.release(self.handle);
assert.equal(native.canvas.memory().cpuPixelBytes, 0);
assert.equal(native.canvas.memory().deferredCommandCount, 0);

// An existing GPU backing still follows its live Canvas after a CPU snapshot.
const renderedSource = native.canvas.create(32, 32);
const renderedReader = native.canvas.create(32, 32);
native.canvas.fillRect(renderedSource.handle, 0, 0, 32, 32, 0xff0000ff);
metadata[2] = renderedSource.handle;
native.beginFrame();
native.scene.submit(schema.version, metadata, values, 1);
native.renderFrame();
copyCanvas(renderedReader, renderedSource, 32, 32);
native.canvas.fillRect(renderedSource.handle, 0, 0, 32, 32, 0x0000ffff);
native.beginFrame();
native.scene.submit(schema.version, metadata, values, 1);
native.renderFrame();
const updatedFrame = native.canvas.captureScene();
assert.equal(native.canvas.pixel(updatedFrame.handle, 16, 16), 0x0000ffff);
assert.equal(native.canvas.pixel(renderedReader.handle, 16, 16), 0xff0000ff);
native.canvas.release(updatedFrame.handle);
native.canvas.release(renderedSource.handle);
native.canvas.release(renderedReader.handle);

// Captured image dependencies outlive both their caller and source Canvas.
const imageSource = native.canvas.create(4, 4);
const imageReader = native.canvas.create(4, 4);
const retainedImage = native.images.load('fixture.png');
native.canvas.drawImage(imageSource.handle, retainedImage.handle, 0, 0, 2, 2, 0, 0, 4, 4, 1);
copyCanvas(imageReader, imageSource);
native.images.release(retainedImage.handle);
native.canvas.release(imageSource.handle);
assert.equal(native.images.memory(20).largest.find(entry => entry.handle === retainedImage.handle).references, 1);
assert.notEqual(native.canvas.pixel(imageReader.handle, 0, 0), 0);
native.canvas.release(imageReader.handle);
const imageAfterReplay = native.images.memory(20).largest.find(entry => entry.handle === retainedImage.handle);
assert.ok(!imageAfterReplay || imageAfterReplay.references === 0);

// Failed replay keeps its commands and dependencies until retry or discard.
const failed = native.canvas.create(16, 16);
const dependency = native.images.load('fixture.png');
native.canvas.fillRect(failed.handle, 0, 0, 16, 16, 0xff0000ff);
native.canvas.drawImage(failed.handle, dependency.handle, 0, 0, 2, 2, 0, 0, 2, 2, 1);
native.canvas.drawText(failed.handle, 'fixture.png', 'not a font', 0, 12, 12, 0xffffffff);
native.images.release(dependency.handle);
const beforeFailure = native.canvas.memory();
for (let attempt = 0; attempt < 2; attempt++) {
  assert.throws(() => native.canvas.pixel(failed.handle, 8, 8));
  assert.equal(native.canvas.memory().deferredCommandCount, beforeFailure.deferredCommandCount);
  assert.equal(native.canvas.memory().deferredCommandBytes, beforeFailure.deferredCommandBytes);
  assert.equal(native.canvas.memory().cpuPixelBytes, beforeFailure.cpuPixelBytes);
  assert.equal(native.images.memory(20).largest.find(entry => entry.handle === dependency.handle).references, 1);
}
const failedCopy = native.canvas.create(16, 16);
native.canvas.drawImage(failedCopy.handle, failed.handle, 0, 0, 16, 16, 0, 0, 16, 16, 1);
assert.throws(() => native.canvas.pixel(failedCopy.handle, 8, 8));
native.canvas.release(failedCopy.handle);
native.canvas.clear(failed.handle);
assert.equal(native.canvas.memory().deferredCommandCount, 0);
const discarded = native.images.memory(20).largest.find(entry => entry.handle === dependency.handle);
assert.ok(!discarded || discarded.references === 0);
native.canvas.fillRect(failed.handle, 0, 0, 16, 16, 0x0000ffff);
assert.equal(native.canvas.pixel(failed.handle, 8, 8), 0x0000ffff);
native.canvas.release(failed.handle);

console.log('Deferred canvas tests passed successfully.');
