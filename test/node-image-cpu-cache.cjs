'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { png } = require('./helpers/png.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const native = require(path.resolve(process.argv[2]));
const root = temporaryDirectory('image-cpu-cache-');
const pixels = Buffer.alloc(32 * 16 * 4);
for (let i = 0; i < pixels.length; i += 4) pixels.set([i % 251, 80, 30, 64 + i % 192], i);
for (const name of ['plain.png', 'prepared.png']) fs.writeFileSync(path.join(root, name), png(32, 16, pixels));
native.initialize({ gameRoot: root, width: 32, height: 32, windowTitle: 'CPU image cache', imageWarmCacheBytes: 0 });
function owner(handle) { return native.images.memory(100).largest.find(entry => entry.handle === handle); }
function advance(frames) { for (let i = 0; i < frames; i++) native.beginFrame(); }
function read(image) {
  const canvas = native.canvas.create(32, 16);
  try {
    native.canvas.drawImage(canvas.handle, image.handle, 0, 0, 32, 16, 0, 0, 32, 16, 1);
    return Buffer.from(native.canvas.readPixels(canvas.handle, 0, 0, 32, 16));
  } finally { native.canvas.release(canvas.handle); }
}
test('idle prepared CPU copies expire without invalidating live handles or non-reconstructible pixels', async () => {
  try {
    const bytes = png(32, 16, pixels);
    const reference = native.images.load('plain.png', true);
    const byteExpected = read(reference);
    native.images.release(reference.handle);
    const pending = native.images.loadBytesAsync(bytes);
    assert.equal(native.images.pendingDecodeJobs(), 1);
    assert.equal(native.images.memory().pendingDecodeJobs, 1);
    bytes.fill(0);
    const fromBytes = await pending;
    assert.equal(native.images.pendingDecodeJobs(), 0);
    assert.deepEqual(read(fromBytes), byteExpected, 'byte loading snapshots caller-owned input');
    native.images.release(fromBytes.handle);
    await assert.rejects(native.images.loadBytesAsync(Uint8Array.from([1, 2, 3, 4])));
    assert.equal(native.images.pendingDecodeJobs(), 0, 'failed byte decodes settle their job count');
    let peakJobs = 0;
    const context = { PMJS: { tasks: { stopped: false } }, NativeHost: { images: {
      loadBytesAsync(...args) {
        const promise = native.images.loadBytesAsync(...args);
        peakJobs = Math.max(peakJobs, native.images.pendingDecodeJobs());
        return promise;
      }
    } } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web/images.js'), 'utf8'), context);
    const beforeBurst = native.images.memory().liveCount;
    const blob = new Blob([png(32, 16, pixels)]);
    const burst = Array.from({ length: 32 }, () =>
      context.PMJS.images.loadBlob(blob, false, () => true).then(loaded => {
        assert.deepEqual(read(loaded), byteExpected, 'queued blob decoding preserves pixels');
        native.images.release(loaded.handle);
      }));
    await Promise.all(burst);
    assert.ok(peakJobs > 0 && peakJobs <= 2, 'blob loading bounds real native decode jobs');
    assert.equal(native.images.pendingDecodeJobs(), 0);
    assert.equal(native.images.memory().liveCount, beforeBurst, 'decoded blob ownership returns to baseline');
    const directory = path.join(root, 'prepared');
    const descriptor = await native.assets.processImage('prepared.png', directory, { grid: [2, 1] }, path.join(root, 'prepared.png'));
    const sourceIdentity = native.assets.sourceIdentity('prepared.png');
    assert.equal(native.assets.installPrepared([{ source: 'prepared.png', sourceIdentity, directory, descriptor }]), 1);
    const image = await native.images.loadAsync('prepared.png', true);
    const plain = await native.images.loadAsync('plain.png', true);
    const expected = read(plain);
    fs.renameSync(path.join(root, 'prepared.png'), path.join(root, 'source-hidden.png'));
    const initial = owner(image.handle).cpuBytes;
    assert.ok(initial >= pixels.length);
    native.images.pin(image.handle); advance(4000);
    assert.equal(owner(image.handle).cpuBytes, initial);
    native.images.unpin(image.handle); advance(3000);
    assert.deepEqual(read(image), expected);
    advance(1000);
    assert.ok(owner(image.handle).cpuBytes >= pixels.length, 'recent CPU reads refresh retention');
    advance(3601);
    assert.ok(owner(image.handle).cpuBytes < initial, 'cold prepared CPU backing is released');
    assert.ok(owner(plain.handle).cpuBytes >= pixels.length, 'ordinary retained pixels remain owned');
    const decodes = native.images.memory().preparedPageDecodes;
    assert.deepEqual(read(image), expected, 'prepared backing reconstructs exact pixels without the original source');
    assert.ok(native.images.memory().preparedPageDecodes > decodes);
    native.images.pin(image.handle);
    const pinnedBytes = owner(image.handle).cpuBytes;
    native.images.releaseCpuCaches();
    assert.equal(owner(image.handle).cpuBytes, pinnedBytes, 'pressure preserves pinned CPU backing');
    native.images.unpin(image.handle);
    native.images.releaseCpuCaches();
    assert.ok(owner(image.handle).cpuBytes < pinnedBytes, 'pressure drops recent reconstructible CPU backing');
    assert.ok(owner(plain.handle).cpuBytes >= pixels.length, 'pressure preserves ordinary retained pixels');
    assert.deepEqual(read(image), expected, 'pressure release reconstructs without the original source');
    assert.deepEqual(read(plain), expected, 'pressure release preserves ordinary image content');
    native.images.releaseCpuCaches();
    const settled = native.images.memory();
    const settledCanvases = native.canvas.memory().liveCount;
    for (let cycle = 0; cycle < 32; cycle++) {
      assert.deepEqual(read(image), expected, 'repeated reconstruction preserves pixels');
      native.images.releaseCpuCaches();
      const current = native.images.memory();
      assert.equal(current.cpuBytes, settled.cpuBytes, 'repeated reclamation returns to the same CPU storage');
      assert.equal(current.liveCount, settled.liveCount, 'repeated reconstruction does not leak image owners');
      assert.equal(native.canvas.memory().liveCount, settledCanvases, 'readback canvases are released');
    }
    native.images.release(image.handle); native.images.release(plain.handle);
  } finally { native.runtime.quit(); }
});
