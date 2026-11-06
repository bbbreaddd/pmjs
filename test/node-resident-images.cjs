'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { png } = require('./helpers/png.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const native = require(path.resolve(process.argv[2]));
const root = temporaryDirectory('resident-images-');
async function main() {
  const source = path.join(root, 'image.png'), pixels = Buffer.alloc(32 * 16 * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([i % 251, 80, 30, 255], i);
  fs.writeFileSync(source, png(32, 16, pixels));
  native.initialize({ gameRoot: root, width: 32, height: 32, windowTitle: 'resident images', imageWarmCacheBytes: 1 });
  const ordinary = await native.images.loadAsync('image.png', true);
  fs.renameSync(source, source + '.hidden');
  native.images.memory();
  const before = native.images.memory(100);
  const views = native.images.exportResident(ordinary.handle, path.join(root, 'ordinary'));
  assert.ok(views.some(view => view.kind === 'cpu-rgba'));
  assert.equal(native.images.memory().cpuBytes, before.cpuBytes);
  assert.equal(native.images.memory().gpuBytes, before.gpuBytes);
  for (const view of views.filter(view => view.file)) {
    const decoded = native.images.loadBytes(fs.readFileSync(view.file), true);
    assert.equal(decoded.width, 32); assert.equal(decoded.height, 16);
    const canvas = native.canvas.create(32, 16);
    native.canvas.drawImage(canvas.handle, decoded.handle, 0, 0, 32, 16, 0, 0, 32, 16, 1);
    assert.deepEqual(Buffer.from(native.canvas.readPixels(canvas.handle, 0, 0, 32, 16)), pixels);
    native.canvas.release(canvas.handle); native.images.release(decoded.handle);
  }
  native.images.release(ordinary.handle);
  assert.throws(() => native.images.exportResident(0, path.join(root, 'invalid')), /invalid image/);
  fs.renameSync(source + '.hidden', source);
  const directory = path.join(root, 'prepared');
  const descriptor = await native.assets.processImage('image.png', directory,
    { grid: [2, 1], framePages: true }, source, null, { pageCodec: 'lz4' });
  const sourceIdentity = native.assets.sourceIdentity('image.png');
  assert.equal(native.assets.installPrepared([{ source: 'image.png', sourceIdentity, directory, descriptor }]), 1);
  const prepared = await native.images.loadAsync('image.png');
  fs.renameSync(source, source + '.hidden');
  const crop = native.canvas.create(16, 16);
  native.canvas.drawImage(crop.handle, prepared.handle, 0, 0, 16, 16, 0, 0, 16, 16, 1);
  native.canvas.release(crop.handle);
  const schema = native.scene.schema, values = new Float32Array(schema.valueStride);
  values.set([1, 0, 0, 1, 0, 0, 1]); values.set([0, 0, 16, 16], 9); values.set([16, 16], 13);
  native.beginFrame();
  native.scene.submit(schema.version, new Uint32Array([1, 0xffffffff, prepared.handle, 0xffffff, 0, 0, 0]), values, 1);
  native.renderScene();
  const state = native.images.memory();
  const pages = native.images.exportResident(prepared.handle, path.join(root, 'prepared-export'));
  assert.ok(pages.some(page => page.file && /gpu|page|frame/.test(page.kind)));
  const after = native.images.memory();
  for (const key of ['cpuBytes', 'gpuBytes', 'preparedPageDecodes', 'preparedMaterializations',
    'textureCreates', 'preparedFrameCacheBytes']) assert.equal(after[key], state[key], key);
  native.images.release(prepared.handle);
  console.log('resident image export passed');
}
test('resident exports preserve pixels without loading absent image backing', async () => {
  try { await main(); }
  finally { native.runtime.quit(); fs.rmSync(root, { recursive: true, force: true }); }
});
