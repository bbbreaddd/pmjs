'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
    native.images.release(image.handle); native.images.release(plain.handle);
  } finally { native.runtime.quit(); }
});
