'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { createStorage } = require('../runner/storage.cjs');
const { png } = require('./helpers/png.cjs');
const native = require(process.env.PMJS_NATIVE_ADDON || path.resolve(__dirname, '../build/pmjs_native.node'));
const directory = temporaryDirectory('async-loading-');
const bytes = Buffer.from([0, 255, 128, 195, 40]);
fs.writeFileSync(path.join(directory, 'bytes.bin'), bytes);
fs.mkdirSync(path.join(directory, 'folder'));
const imageBytes = png(1, 1, Buffer.from([255, 0, 0, 255]));
fs.writeFileSync(path.join(directory, 'image.png'), imageBytes);
fs.writeFileSync(path.join(directory, 'collection.png'), imageBytes);
const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const encrypted = Buffer.from(imageBytes);
for (let i = 0; i < 16; i++) encrypted[i] ^= key[i];
fs.writeFileSync(path.join(directory, 'image.rpgmvp'), Buffer.concat([Buffer.alloc(16), encrypted]));
native.initialize({ gameRoot: directory, width: 32, height: 32, windowTitle: 'Async loading', imageWarmCacheBytes: 16 });
test.after(() => native.runtime.quit());

test('critical collection preserves image decodes already in flight', async () => {
  const { createMemoryReclaimer } = require('../runner/memory-reclamation.cjs');
  const pending = Array.from({ length: 8 }, () => native.images.loadAsync('collection.png', true));
  assert.ok(native.images.memory(0).pendingDecodeJobs > 0);
  let time = 0, collected = false;
  const policy = createMemoryReclaimer({ native, now: () => time,
    readMemory: () => ({ availableBytes: 80 * 1024 * 1024, rssBytes: process.memoryUsage.rss() }),
    collectGarbage() {
      assert.ok(native.images.memory(0).pendingDecodeJobs > 0);
      global.gc(); collected = true;
    },
    logger: { log() {}, warn(message) { assert.fail(message); } }
  });
  policy.observe({ availableBytes: 80 * 1024 * 1024, rssBytes: process.memoryUsage.rss() });
  policy.observe({ availableBytes: 80 * 1024 * 1024, rssBytes: process.memoryUsage.rss() });
  time = 2000;
  const reclamation = policy.atBoundary(null);
  const images = await Promise.all(pending);
  try {
    const result = await reclamation;
    assert.equal(collected, true);
    assert.equal(result.boundary, 'critical-pressure');
    for (const image of images) {
      const canvas = native.canvas.create(1, 1);
      try {
        native.canvas.drawImage(canvas.handle, image.handle, 0, 0, 1, 1, 0, 0, 1, 1, 1);
        assert.deepEqual(Buffer.from(native.canvas.readPixels(canvas.handle, 0, 0, 1, 1)),
          Buffer.from([255, 0, 0, 255]));
      } finally { native.canvas.release(canvas.handle); }
    }
  } finally { images.forEach(image => native.images.release(image.handle)); }
});

for (const host of [native.fs, createStorage(directory)]) {
  test('asynchronous bytes and bounded reads, backend=' + (host === native.fs ? 'vfs' : 'storage'), async () => {
    assert.deepEqual(Buffer.from(await host.readBytesAsync('bytes.bin')), bytes);
    assert.equal(await host.readBytesAsync('missing'), null);
    await assert.rejects(host.readBytesAsync('folder'), { code: 'EISDIR' });
    const reader = await host.openReadAsync('bytes.bin', 1);
    assert.deepEqual(Buffer.from(await reader.readAsync(2)), bytes.subarray(1, 3));
    assert.deepEqual(Buffer.from(await reader.readAsync(8)), bytes.subarray(3));
    assert.equal((await reader.readAsync(8)).length, 0);
    await reader.close(); await reader.close();
    assert.equal(await host.openReadAsync('missing'), null);
  });
  test('close during an asynchronous read retains the descriptor until completion', async () => {
    const reader = await host.openReadAsync('bytes.bin');
    const pending = reader.readAsync(5);
    await reader.close();
    assert.deepEqual(Buffer.from(await pending), bytes);
    if (host === native.fs) assert.throws(() => reader.read(1), { code: 'EBADF' });
    await assert.rejects(reader.readAsync(1), { code: 'EBADF' });
  });
}

function imageFixture(t) {
  const released = [], starts = [], byteStarts = [];
  const context = vm.createContext({ PMJS: {}, console, performance, Blob, __pmjsBuiltinRequire: require,
    NativeHost: { images: { ...native.images,
      loadAsync(...args) { starts.push(args[0]); return native.images.loadAsync(...args); },
      loadBytesAsync(...args) { byteStarts.push(args[0]); return native.images.loadBytesAsync(...args); } },
      runtime: { scheduling: require('node:timers') } },
    trackNativeResource: resource => resource,
    releaseNativeResource(resource) { if (resource) { released.push(resource.handle); native.images.release(resource.handle); } }
  });
  for (const module of ['pmjs-web/filesystem', 'pmjs-web/scheduler', 'pmjs-web/events', 'pmjs-web/elements',
    'pmjs-web/object-urls', 'pmjs-web/images', 'pmjs-web/image-element']) {
    const filename = path.resolve(__dirname, '../js', module + '.js');
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context);
  }
  t.after(() => context.PMJS.tasks.stop());
  function load(image, source) {
    return new Promise((resolve, reject) => {
      image.onload = resolve; image.onerror = reject; image.src = source;
    });
  }
  return { context, starts, byteStarts, released, load };
}

test('native cold/warm image loads publish dimensions in browser tasks', async t => {
  const { context, load } = imageFixture(t), trace = [];
  const before = native.images.memory(0);
  for (let i = 0; i < 2; i++) {
    const image = new context.NativeImage();
    const loaded = load(image, 'image.png');
    assert.equal(image.complete, false);
    Promise.resolve().then(() => trace.push('setter-micro'));
    image.addEventListener('load', () => {
      trace.push('load'); assert.equal(image.complete, true); assert.equal(image.naturalWidth, 1);
    });
    await loaded; await context.PMJS.tasks.idle();
    assert.equal(context.PMJS.images.pendingLoads, 0);
    context.releaseNativeResource(image._nativeImage);
  }
  assert.deepEqual(trace, ['setter-micro', 'load', 'setter-micro', 'load']);
  const after = native.images.memory(0);
  assert.equal(after.decodeJobs - before.decodeJobs, 1);
  assert.equal(after.warmHits - before.warmHits, 1);
});

test('asynchronously read encrypted bytes decode through object URLs with dimensions installed before load', async t => {
  const { context, load, byteStarts } = imageFixture(t);
  const bytes = Buffer.from(await native.fs.readBytesAsync('image.rpgmvp')).subarray(16);
  for (let i = 0; i < 16; i++) bytes[i] ^= key[i];
  assert.deepEqual(bytes, imageBytes);
  const url = context.URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  const image = new context.NativeImage();
  await load(image, url); await context.PMJS.tasks.idle();
  assert.equal(image.complete, true);
  assert.equal(image.naturalWidth, 1); assert.equal(image.naturalHeight, 1);
  assert.equal(byteStarts.length, 1);
  context.URL.revokeObjectURL(url);
  context.releaseNativeResource(image._nativeImage);
});

test('superseding an object URL during conversion avoids native decode', async t => {
  const { context, load, byteStarts } = imageFixture(t);
  let finish;
  const blob = new Blob([imageBytes]);
  blob.arrayBuffer = () => new Promise(resolve => { finish = resolve; });
  const image = new context.NativeImage(), url = context.URL.createObjectURL(blob);
  image.src = url; await context.PMJS.tasks.idle();
  const loaded = load(image, 'image.png');
  finish(imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.length));
  await loaded; await context.PMJS.tasks.idle();
  assert.equal(context.PMJS.images.pendingLoads, 0);
  assert.equal(byteStarts.length, 0);
  context.URL.revokeObjectURL(url);
  context.releaseNativeResource(image._nativeImage);
});

test('shutdown releases a late native image result without guest notification', async t => {
  const { context, released } = imageFixture(t);
  let finish, events = 0;
  context.NativeHost.images.loadAsync = () => new Promise(resolve => { finish = resolve; });
  const image = new context.NativeImage();
  image.onload = image.onerror = () => events++;
  image.src = 'image.png'; await context.PMJS.tasks.idle();
  const result = await native.images.loadAsync('image.png');
  context.PMJS.tasks.stop(); finish(result);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(released, [result.handle]);
  assert.equal(context.PMJS.images.pendingLoads, 0);
  assert.equal(events, 0); assert.equal(image.complete, false);
});

test('superseded queued images do not initiate native decoding', async t => {
  const { context, starts, load } = imageFixture(t), image = new context.NativeImage();
  image.src = 'unused-A.png'; image.src = 'unused-B.png';
  await load(image, 'image.png'); await context.PMJS.tasks.idle();
  assert.deepEqual(starts, ['image.png']);
  context.releaseNativeResource(image._nativeImage);
});

test('superseded native completions release only their own ownership', async t => {
  const { context, load, released } = imageFixture(t);
  let finish;
  const original = native.images.loadAsync('image.png');
  context.NativeHost.images.loadAsync = () => new Promise(resolve => { finish = resolve; });
  const image = new context.NativeImage();
  image.src = 'image.png'; await context.PMJS.tasks.idle();
  const obsolete = await original;
  context.NativeHost.images.loadAsync = (...args) => native.images.loadAsync(...args);
  const loaded = load(image, 'image.png');
  finish(obsolete);
  await loaded; await context.PMJS.tasks.idle();
  assert.deepEqual(released, [obsolete.handle]);
  assert.equal(context.PMJS.images.pendingLoads, 0);
  const current = image._nativeImage;
  const entry = native.images.memory(20).largest.find(entry => entry.handle === current.handle);
  assert.equal(entry.references, 1);
  assert.equal(image.naturalWidth, 1);
  context.releaseNativeResource(current);
});
