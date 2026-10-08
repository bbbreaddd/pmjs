'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { png } = require('./helpers/png.cjs');
const native = require(path.resolve(process.argv[2]));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-prepared-load-'));

function fixture(name, pageBytes) {
  const source = name + '.png';
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  const pixels = Buffer.alloc(4 * 4 * 4);
  for (let y = 0; y < 4; ++y) for (let x = 0; x < 4; ++x) {
    pixels.set([37 + x, 73 + y, 109, 255], (y * 4 + x) * 4);
  }
  fs.writeFileSync(path.join(root, source), png(4, 4, pixels));
  const page = Buffer.alloc(6 * 6 * 4);
  for (let y = 0; y < 6; ++y) for (let x = 0; x < 6; ++x) {
    const offset = (Math.min(3, Math.max(0, y - 1)) * 4 + Math.min(3, Math.max(0, x - 1))) * 4;
    pixels.copy(page, (y * 6 + x) * 4, offset, offset + 4);
  }
  fs.writeFileSync(path.join(directory, 'page-0.png'), pageBytes || png(6, 6, page));
  return { source, directory, pixels,
    descriptor: { version: 1, width: 4, height: 4, halo: 1,
      pages: [{ path: 'page-0.png', width: 6, height: 6 }],
      cells: [{ rect: [0, 0, 4, 4], crop: [0, 0, 4, 4],
        fill: [0, 0, 0, 0], page: 0, atlas: [1, 1, 4, 4] }] }
  };
}

function install(fixture) {
  const entries = [{ ...fixture, sourceIdentity: native.assets.sourceIdentity(fixture.source) }];
  assert.equal(native.assets.installPrepared([Object.freeze({ ...entries[0] })]), 1);
  assert.equal(native.assets.installPrepared(entries, true), 1);
  assert.equal(native.assets.installPreparedCatalog(entries), 1);
}

// The sole worker blocks in FIFO open until the main thread releases it.
// Image requests queued behind it must leave the event loop free to run.
async function withBlockedWorker(run) {
  assert.equal(process.env.UV_THREADPOOL_SIZE, '1');
  const fifo = path.join(root, 'worker-barrier');
  execFileSync('mkfifo', [fifo]);
  const opened = new Promise((resolve, reject) => {
    fs.open(fifo, 'r', (error, fd) => {
      if (error) reject(error);
      else { fs.closeSync(fd); resolve(); }
    });
  });
  try { return await run(); }
  finally {
    const writer = fs.openSync(fifo, fs.constants.O_RDWR);
    await opened;
    fs.closeSync(writer);
    fs.unlinkSync(fifo);
  }
}

async function remainsPending(promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'prepared loading decoded on the JavaScript thread');
}

function entry(image) {
  return native.images.memory(100).largest.find(item => item.handle === image.handle);
}

function assertPixels(image, expected) {
  const canvas = native.canvas.create(4, 4);
  try {
    native.canvas.drawImage(canvas.handle, image.handle, 0, 0, 4, 4, 0, 0, 4, 4, 1);
    assert.deepEqual(Buffer.from(native.canvas.readPixels(canvas.handle, 0, 0, 4, 4)), expected);
  } finally { native.canvas.release(canvas.handle); }
}

async function main() {
  const lazy = fixture('lazy');
  const retainedFixtures = [fixture('cpu'), fixture('coalesced-cpu')];
  const cached = fixture('cached-cpu');
  const staleFixtures = [fixture('stale-page'), fixture('missing-page'), fixture('stale-source'), fixture('missing-source')];
  const fallbackFixtures = [fixture('corrupt', Buffer.from('invalid PNG data')),
    fixture('dimensions', png(2, 2, Buffer.alloc(16, 255)))];
  const oversized = { source: 'oversized.png', directory: root,
    descriptor: { version: 1, width: 4096, height: 4097, halo: 1,
      uniform: [255, 255, 255, 255], pages: [], cells: [] } };
  fs.writeFileSync(path.join(root, oversized.source),
    png(4096, 4097, new Uint8Array(4096 * 4097 * 4).fill(255).buffer));
  native.initialize({ gameRoot: root, assetRoot: '', width: 16, height: 16,
    windowTitle: 'prepared image loading', imageWarmCacheBytes: 0 });
  install(lazy);
  let first, second;
  const before = native.images.memory();
  await withBlockedWorker(async () => {
    first = native.images.loadAsync(lazy.source);
    second = native.images.loadAsync(lazy.source);
    await remainsPending(first);
    const queued = native.images.memory();
    assert.equal(queued.pendingDecodeJobs, 1);
    assert.equal(queued.decodeJobs - before.decodeJobs, 1);
    assert.equal(queued.coalescedRequests - before.coalescedRequests, 1);
    native.assets.installPrepared([]);
    const replacement = path.join(lazy.directory, 'replacement.png');
    fs.writeFileSync(replacement, png(6, 6, Buffer.alloc(6 * 6 * 4, 255)));
    fs.renameSync(replacement, path.join(lazy.directory, 'page-0.png'));
    fs.writeFileSync(replacement, png(2, 2, Buffer.alloc(16, 255)));
    fs.renameSync(replacement, path.join(root, lazy.source));
    fs.rmSync(lazy.directory, { recursive: true });
  });
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.handle, right.handle);
  assert.notEqual(left, right);
  assert.equal(entry(left).references, 2);
  assert.equal(entry(left).cpuBytes, 0, 'validation retained decoded pages');
  assert.equal(entry(left).gpuBytes, 0, 'validation allocated GPU backing');
  native.images.release(left.handle);
  assertPixels(right, lazy.pixels);
  assert.equal(entry(right).references, 1);
  native.images.release(right.handle);
  const replacement = await native.images.loadAsync(lazy.source);
  assert.deepEqual([replacement.width, replacement.height], [2, 2]);
  native.images.release(replacement.handle);

  for (const lateRequest of [false, true]) {
    const retained = retainedFixtures[Number(lateRequest)];
    install(retained);
    let owner, cpuOwner;
    await withBlockedWorker(async () => {
      owner = native.images.loadAsync(retained.source, !lateRequest);
      cpuOwner = native.images.loadAsync(retained.source, true);
      await remainsPending(owner);
      native.assets.installPrepared([]);
      fs.rmSync(retained.directory, { recursive: true });
    });
    const [a, b] = await Promise.all([owner, cpuOwner]);
    assert.equal(a.handle, b.handle);
    assert.equal(entry(a).cpuBytes, retained.pixels.length);
    assert.equal(entry(a).gpuBytes, 0);
    for (let frame = 0; frame < 61; ++frame) native.beginFrame();
    assert.equal(entry(a).cpuBytes, retained.pixels.length, 'explicit CPU retention expired');
    assertPixels(a, retained.pixels);
    native.images.release(a.handle); native.images.release(b.handle);
  }

  install(cached);
  const original = await native.images.loadAsync(cached.source);
  assert.equal(entry(original).cpuBytes, 0);
  native.assets.installPrepared([]);
  fs.rmSync(cached.directory, { recursive: true });
  let cpuRequest;
  await withBlockedWorker(async () => {
    cpuRequest = native.images.loadAsync(cached.source, true);
    await remainsPending(cpuRequest);
    assert.equal(entry(original).cpuBytes, 0);
  });
  const cpu = await cpuRequest;
  assert.equal(cpu.handle, original.handle);
  assert.equal(entry(cpu).cpuBytes, cached.pixels.length);
  assertPixels(cpu, cached.pixels);
  native.images.release(original.handle); native.images.release(cpu.handle);

  for (const fallback of fallbackFixtures) {
    install(fallback);
    let pending;
    await withBlockedWorker(async () => {
      pending = native.images.loadAsync(fallback.source, true);
      await remainsPending(pending);
      native.assets.installPrepared([]);
      fs.rmSync(fallback.directory, { recursive: true });
      const changed = path.join(root, 'changed.png');
      fs.writeFileSync(changed, png(2, 2, Buffer.alloc(16, 255)));
      fs.renameSync(changed, path.join(root, fallback.source));
    });
    const image = await pending;
    assert.deepEqual([image.width, image.height], [4, 4]);
    assert.ok(entry(image).gpuBytes > 0, 'invalid prepared page did not use original decoding');
    assertPixels(image, fallback.pixels);
    native.images.release(image.handle);
  }
  install(oversized);
  const large = await native.images.loadAsync(oversized.source, true);
  assert.deepEqual([large.width, large.height], [4096, 4097]);
  assert.equal(entry(large).cpuBytes, 4096 * 4097 * 4, 'explicit large CPU retention lost its pixels');
  assert.equal(entry(large).gpuBytes, 0);
  native.images.release(large.handle);
  for (const stale of staleFixtures) {
    const entries = [{ ...stale, sourceIdentity: native.assets.sourceIdentity(stale.source) }];
    assert.equal(native.assets.installPrepared(entries, true), 1);
    if (stale.source === 'missing-source.png') {
      fs.unlinkSync(path.join(root, stale.source));
      assert.equal(native.assets.installPreparedCatalog(entries), 1);
      await assert.rejects(async () => native.images.loadAsync(stale.source), /cannot open image/);
      continue;
    }
    const page = path.join(stale.directory, 'page-0.png');
    let expected = stale.pixels;
    if (stale.source === 'missing-page.png') fs.unlinkSync(page);
    else if (stale.source === 'stale-page.png') fs.writeFileSync(page, 'invalid page');
    else {
      expected = Buffer.alloc(4*4*4, 255);
      fs.writeFileSync(path.join(root, stale.source), png(4, 4, expected));
    }
    native.assets.consumePreparationInvalidations();
    assert.equal(native.assets.installPreparedCatalog(entries), 1, 'catalog installation must not inspect stale files');
    const image = await native.images.loadAsync(stale.source);
    assertPixels(image, expected);
    assert.ok(entry(image).gpuBytes > 0, 'stale catalog should use original decoding');
    assert.equal(native.assets.consumePreparationInvalidations() & 1, 1, 'observed stale images request catalog regeneration');
    assert.equal(native.assets.consumePreparationInvalidations(), 0, 'signals are consumed once');
    native.images.release(image.handle);
  }
  console.log('[pmjs-prepared-image-load] worker loading, snapshots, coalescing, CPU retention and fallback passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  native.runtime.quit(); fs.rmSync(root, { recursive: true, force: true });
});
