'use strict';

process.env.PMJS_GRAPHICS_DIAGNOSTICS = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { png } = require('./helpers/png.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const native = require(path.resolve(process.argv[2]));

test('different prepared source paths share storage and retain independent snapshots', async context => {
  const root = temporaryDirectory('pmjs-shared-prepared-');
  const width = 49, height = 37, pageWidth = 29, pageHeight = 27;
  const pixels = Buffer.alloc(width * height * 4), page = Buffer.alloc(pageWidth * pageHeight * 4);
  for (const data of [pixels, page]) for (let i = 0; i < data.length; i += 4) data.set([241, 241, 241, 0], i);
  for (let y = 0; y < 21; ++y) for (let x = 0; x < 23; ++x) {
    const gray = (x * 13 + y * 17) % 256, alpha = (x * 19 + y * 7) % 256;
    const color = [gray, gray, gray, alpha];
    pixels.set(color, ((y + 7) * width + x + 9) * 4);
    page.set(color, ((y + 3) * pageWidth + x + 3) * 4);
  }
  const bytes = png(width, height, pixels), pageBytes = png(pageWidth, pageHeight, page);
  const descriptor = { version: 1, width, height, halo: 3,
    pages: [{ path: 'page-0.png', width: pageWidth, height: pageHeight }],
    cells: [{ rect: [0, 0, width, height], crop: [9, 7, 23, 21],
      fill: [241, 241, 241, 0], page: 0, atlas: [3, 3, 23, 21] }] };
  const entries = ['first', 'second'].map(name => {
    const directory = path.join(root, name), source = name + '.png';
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(root, source), bytes);
    fs.writeFileSync(path.join(directory, 'page-0.png'), pageBytes);
    return { source, directory, descriptor };
  });
  native.initialize({ gameRoot: root, assetRoot: '', width: 64, height: 48,
    windowTitle: 'shared prepared image snapshots', imageWarmCacheBytes: 0,
    preparedFrameCacheBytes: 0, preparedCompactSampling: false });
  try {
    native.render.setClearColor(0.08, 0.15, 0.2, 0.6);
    const schema = native.scene.schema;
    native.images.release(native.images.fallbackImage().handle);
    const emptyMemory = native.images.memory();
    function packet(image, effect = 0) {
      const values = new Float32Array(schema.valueStride);
      values.set([1, 0, 0, 1, 4.25, 3.5, 0.63]);
      values.set([0, 0, width, height, width, height], 9);
      if (effect) values.set([0.75, 0.25, 0.5, 0.3], 37);
      if (effect === 2) values.set([0.1, -0.05, 0.04, 0.3], 33);
      native.beginFrame();
      native.scene.submit(schema.version, new Uint32Array([1, 0xffffffff, image.handle,
        0xffffff, 0, (1 << 17) | (effect ? 16 : 0), 0]), values, 1);
      native.renderScene();
      return Buffer.from(native.canvas.captureSceneRawPremultiplied());
    }
    function direct(image) {
      native.beginFrame();
      native.render.image(image.handle, 1, 0, 0, 1, 4.25, 3.5, 0, 0, width, height, 0.63, 0xffffff, 0);
      native.renderScene();
      return Buffer.from(native.canvas.captureSceneRawPremultiplied());
    }
    function empty() {
      native.beginFrame();
      native.scene.submit(schema.version, new Uint32Array(), new Float32Array(), 0);
      native.renderScene();
    }
    function canvasCopy(image) {
      const canvas = native.canvas.create(width, height);
      try {
        native.canvas.drawImage(canvas.handle, image.handle, 0, 0, width, height, 0, 0, width, height, 1);
        return Buffer.from(native.canvas.readPixels(canvas.handle, 0, 0, width, height));
      } finally { native.canvas.release(canvas.handle); }
    }
    entries.forEach(entry => { entry.sourceIdentity = native.assets.sourceIdentity(entry.source); });
    assert.notEqual(entries[0].sourceIdentity, entries[1].sourceIdentity, 'source identity must remain path-specific');
    native.assets.installPrepared(entries);
    const original = native.images.loadBytes(bytes);
    const expectedDirect = direct(original), expectedEffects = [0, 1, 2].map(effect => packet(original, effect));
    const expectedCanvas = canvasCopy(original);
    const before = native.images.memory();
    const [first, second] = await Promise.all(entries.map(entry => native.images.loadAsync(entry.source)));
    assert.notEqual(first.handle, second.handle, 'physical sharing must preserve independent logical ownership');
    const loaded = native.images.memory();
    assert.equal(loaded.preparedPageDecodes - before.preparedPageDecodes, 1, 'workers must coalesce identical prepared page decoding');
    assert.equal(loaded.cpuBytes - before.cpuBytes, page.length, 'CPU accounting must count one physical prepared page');
    assert.deepEqual(direct(first), expectedDirect);
    for (let effect = 0; effect < 3; ++effect) assert.deepEqual(packet(first, effect), expectedEffects[effect]);
    const shared = native.images.memory();
    assert.equal(shared.gpuBytes - loaded.gpuBytes, width * height * 4 * 2,
      'NPOT fallback shares straight and premultiplied RGBA images');
    assert.deepEqual(direct(second), expectedDirect);
    for (let effect = 0; effect < 3; ++effect) assert.deepEqual(packet(second, effect), expectedEffects[effect]);
    assert.equal(native.images.memory().textureUploadBytes, shared.textureUploadBytes,
      'the second logical owner must reuse full fallback textures');
    assert.equal(native.images.memory().gpuBytes, shared.gpuBytes, 'alias fallback must not double GPU residency');

    // Replace one source and its page atomically while both old owners remain live.
    const replacement = Buffer.from(pixels), replacementPage = Buffer.from(page);
    replacement.set([31, 67, 149, 255], (8 * width + 10) * 4);
    replacementPage.set([31, 67, 149, 255], (4 * pageWidth + 4) * 4);
    fs.writeFileSync(path.join(root, 'replacement.png'), png(width, height, replacement));
    fs.renameSync(path.join(root, 'replacement.png'), path.join(root, entries[0].source));
    fs.writeFileSync(path.join(entries[0].directory, 'replacement.png'), png(pageWidth, pageHeight, replacementPage));
    fs.renameSync(path.join(entries[0].directory, 'replacement.png'), path.join(entries[0].directory, 'page-0.png'));
    const changedEntry = { ...entries[0], sourceIdentity: native.assets.sourceIdentity(entries[0].source) };
    native.assets.installPrepared([changedEntry, entries[1]]);
    const changed = await native.images.loadAsync(entries[0].source);
    const changedReference = native.images.loadBytes(png(width, height, replacement));
    assert.notEqual(changed.handle, first.handle, 'replacement source must get a new logical revision');
    assert.deepEqual(packet(changed, 2), packet(changedReference, 2));
    for (let frame = 0; frame < 61; ++frame) empty();
    assert.deepEqual(canvasCopy(first), expectedCanvas, 'old owner must reconstruct from its captured page snapshot');
    assert.deepEqual(canvasCopy(second), expectedCanvas, 'replacing another path must preserve the sibling snapshot');
    assert.deepEqual(packet(second, 2), expectedEffects[2]);
    empty();
    native.images.release(first.handle); native.beginFrame();
    assert.deepEqual(packet(second, 1), expectedEffects[1], 'sibling must remain usable after the first source is released');
    empty();
    for (const image of [second, changed, changedReference, original]) native.images.release(image.handle);
    native.beginFrame();
    const released = native.images.memory();
    assert.equal(released.gpuBytes, emptyMemory.gpuBytes, 'last owner release must reclaim shared GPU allocations');
    assert.equal(released.cpuBytes, emptyMemory.cpuBytes, 'last owner release must reclaim shared CPU allocations');
    context.diagnostic(JSON.stringify({ pageBytes: page.length,
      fullRgbaBytes: pixels.length, sharedGpuBytes: shared.gpuBytes - loaded.gpuBytes, memory: released }));
  } finally { native.runtime.quit(); }
});
