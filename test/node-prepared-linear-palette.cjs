'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { png } = require('./helpers/png.cjs');
const { spritePacket, drawPacket } = require('./helpers/sparse-palette.cjs');
const native = require(path.resolve(process.argv[2]));
const root = temporaryDirectory('prepared-linear-palette-');
const budget = process.argv.includes('--disabled') ? 0 : process.argv.includes('--small-budget') ? 64 : null;
const pixels = Buffer.alloc(64 * 48 * 4);
for (let y = 3; y < 45; y++) for (let x = 4; x < 60; x++) {
  const gray = (x + y) % 17 * 15;
  pixels.set([gray, gray, gray, x % 5 * 51], (y * 64 + x) * 4);
}
const bytes = png(64, 48, pixels);
fs.writeFileSync(path.join(root, 'source.png'), bytes);
const sheetPixels = Buffer.alloc(192 * 64 * 4);
for (let i = 0; i < sheetPixels.length; i += 4) {
  const value = i / 4;
  sheetPixels.set([value % 251, value * 53 % 251, 37, value % 3 * 127], i);
}
fs.writeFileSync(path.join(root, 'sheet.png'), png(192, 64, sheetPixels));
const fractional = fractionalFixture();
const whole = wholeFixture();
native.initialize({ gameRoot: root, width: 96, height: 80, windowTitle: 'Prepared linear palette', imageWarmCacheBytes: 0,
  ...(budget === null ? {} : { preparedFrameCacheBytes: budget }) });
let reference, prepared;
function fractionalFixture() {
  const width = 256, height = 192, pixels = Buffer.alloc(width * height * 4);
  let state = 123456789;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) >>> 24;
  const colors = Array.from({ length: 256 }, () => [random(), random(), random(), random()]);
  for (let i = 0; i < width * height; ++i) pixels.set(colors[random()], i * 4);
  const bytes = png(width, height, pixels), source = 'fractional.png';
  fs.writeFileSync(path.join(root, source), bytes);
  return { width, height, bytes, source };
}
async function fractionalFrameSampling() {
  const { width, height, bytes, source } = fractional;
  const directory = path.join(root, 'fractional'); fs.mkdirSync(directory);
  const descriptor = await native.assets.processImage(source, directory, { grid: [2, 2], framePages: true },
    path.join(root, source), null, { pageCodec: 'lz4' });
  assert.ok(descriptor.textureArtifact);
  assert.equal(native.assets.installPrepared([{ source, directory, descriptor,
    sourceIdentity: native.assets.sourceIdentity(source) }]), 1);
  const reference = native.images.loadBytes(bytes), image = await native.images.loadAsync(source);
  try {
    const sample = (source, options) => {
      const packet = spritePacket(native, source, options);
      packet.metadata[3] = 0xffffff;
      packet.values[4] = 0.25; packet.values[5] = 0.5; packet.values[6] = 1;
      return drawPacket(native, packet);
    };
    for (const nearest of [true, false]) for (const scale of [0.19, 0.37, 0.61, 0.73, 0.97, 1.13]) {
      const options = { nearest, scale, crop: [width * 0.2, height * 0.1, width * 0.6, height * 0.7] };
      const actual = sample(image, options);
      const expected = sample(reference, options);
      let maximum = 0;
      for (let i = 0; i < actual.length; ++i) maximum = Math.max(maximum, Math.abs(actual[i] - expected[i]));
      assert.ok(maximum <= (nearest ? 0 : 1), `fractional cross-frame sampling delta ${maximum}`);
    }
  } finally {
    native.images.release(reference.handle); native.images.release(image.handle); native.beginFrame();
  }
}
function wholeFixture() {
  const width = 576, height = 1008, source = 'whole.png';
  const pixels = Buffer.alloc(width * height * 4);
  // Colored corners retain indexed storage and force a full-size padded page.
  pixels.set([1, 2, 3, 255], 0);
  pixels.set([1, 2, 3, 255], pixels.length - 4);
  // This high-contrast corner lands near an interpolation-weight boundary.
  for (let y = 203; y <= 204; ++y) for (let x = 479; x <= 480; ++x)
    pixels.set(x === 480 && y === 204 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * width + x) * 4);
  const bytes = png(width, height, pixels); fs.writeFileSync(path.join(root, source), bytes);
  return { width, height, source, bytes, pixels };
}
async function wholeSourceSampling() {
  native.render.setClearColor(0, 0, 0, 0);
  const { width, height, source, bytes, pixels } = whole;
  const directory = path.join(root, 'whole'); fs.mkdirSync(directory);
  const halo = 3, pageWidth = width + 2 * halo, pageHeight = height + 2 * halo;
  const page = Buffer.alloc(pageWidth * pageHeight * 4);
  for (let y = 0; y < pageHeight; ++y) for (let x = 0; x < pageWidth; ++x) {
    const sourceOffset = (Math.max(0, Math.min(height - 1, y - halo)) * width +
      Math.max(0, Math.min(width - 1, x - halo))) * 4;
    pixels.copy(page, (y * pageWidth + x) * 4, sourceOffset, sourceOffset + 4);
  }
  fs.writeFileSync(path.join(directory, 'page-0.png'), png(pageWidth, pageHeight, page));
  const descriptor = { version: 1, width, height, halo,
    cells: [{ rect: [0, 0, width, height], crop: [0, 0, width, height], fill: [0, 0, 0, 0],
      page: 0, atlas: [halo, halo, width, height] }],
    pages: [{ path: 'page-0.png', width: pageWidth, height: pageHeight }] };
  const sourceIdentity = native.assets.sourceIdentity(source);
  const storage = await native.assets.classifyImageStorage(path.join(root, source));
  assert.equal(storage.paletteBits, 8);
  assert.equal(native.assets.installImageStorage([{ source, sourceIdentity, storage }]), 1);
  assert.equal(native.assets.installPrepared([{ source, sourceIdentity, directory, descriptor }]), 1, 'whole-source fixture must install');
  const reference = native.images.loadBytes(bytes), image = await native.images.loadAsync(source);
  try {
    const sample = (image, nearest) => {
      const packet = spritePacket(native, image, { nearest, scale: 74 / height, crop: [0, 0, width, height] });
      packet.metadata[5] = nearest ? 8 : 0;
      packet.metadata[3] = 0xffffff;
      packet.values[4] = 0.25; packet.values[5] = 0.5; packet.values[6] = 1;
      return drawPacket(native, packet);
    };
    for (const nearest of [true, false]) {
      const expected = sample(reference, nearest), actual = sample(image, nearest);
      if (!nearest) assert.ok(expected.some((value, index) => index % 4 < 3 && value > 127),
        'the high-contrast corner must contribute a visible filtered pixel');
      let maximum = 0;
      for (let i = 0; i < actual.length; ++i) maximum = Math.max(maximum, Math.abs(actual[i] - expected[i]));
      assert.ok(maximum <= 2, `whole-source palette sampling nearest=${nearest} delta ${maximum}`);
    }
  } finally {
    native.images.release(reference.handle); native.images.release(image.handle); native.beginFrame();
  }
}
async function classifiedSheet() {
  const directory = path.join(root, 'sheet'); fs.mkdirSync(directory);
  const descriptor = await native.assets.processImage('sheet.png', directory,
    { grid: [3, 1], backdrop: [0, 0, 0, 0] });
  const storage = await native.assets.classifyImageStorage(path.join(root, 'sheet.png'));
  assert.ok(storage.paletteBits);
  const sourceIdentity = native.assets.sourceIdentity('sheet.png');
  assert.equal(native.assets.installImageStorage([{ source: 'sheet.png', sourceIdentity, storage }]), 1);
  assert.equal(native.assets.installPrepared([{ source: 'sheet.png', sourceIdentity, directory, descriptor }]), 1);
  const image = await native.images.loadAsync('sheet.png');
  const reference = native.canvas.create(192, 64);
  try {
    native.canvas.writePixels(reference.handle, 0, 0, 192, 64, sheetPixels);
    const options = { nearest: false, crop: [0, 0, 128, 64], scale: 0.7 };
    const actual = drawPacket(native, spritePacket(native, image, options));
    const expected = drawPacket(native, spritePacket(native, reference, { ...options, premultiplied: true }));
    let maximum = 0;
    for (let i = 0; i < actual.length; ++i) maximum = Math.max(maximum, Math.abs(actual[i] - expected[i]));
    assert.ok(maximum <= 1, 'classified frame changed ordinary filtering');
    const owner = () => native.images.memory(100).largest.find(entry => entry.handle === image.handle);
    assert.equal(owner().fullTextureResident, false,
      'an eligible frame must not allocate the full source palette');
    drawPacket(native, spritePacket(native, image, { ...options, nearest: true }));
    assert.equal(native.images.memory().sourceTextureBuilds, 0, 'nearest fallback must not compile texture data during drawing');
  } finally {
    native.images.release(image.handle);
    native.canvas.release(reference.handle);
    native.beginFrame();
  }
}
(async () => {
  try {
    const directory = path.join(root, 'prepared'); fs.mkdirSync(directory);
    const descriptor = await native.assets.processImage('source.png', directory, { grid: [1, 1], backdrop: [0, 0, 0, 0] });
    assert.ok(descriptor);
    const sourceIdentity = native.assets.sourceIdentity('source.png');
    const storage = await native.assets.classifyImageStorage(path.join(root, 'source.png'));
    native.assets.installImageStorage([{source:'source.png',sourceIdentity,storage}]);
    native.assets.installPrepared([{ source: 'source.png', directory, descriptor,
      sourceIdentity }]);
    reference = native.canvas.create(64, 48);
    native.canvas.writePixels(reference.handle, 0, 0, 64, 48, pixels);
    prepared = await native.images.loadAsync('source.png');
    native.render.setClearColor(0.1, 0.2, 0.3, 0.6);
    const memory = () => native.images.memory(100);
    drawPacket(native, spritePacket(native, prepared, { crop: [0, 0, 64, 48] }));
    assert.equal(memory().preparedFrameCacheMisses, 0, 'nearest sprites retain the indexed path');
    for (const scale of [0.98, 1.25]) for (const crop of [[0, 0, 64, 48], [0.25, 0.5, 60.5, 44.5]]) {
      const options = { nearest: false, scale, crop };
      const expected = drawPacket(native, spritePacket(native, reference, { ...options, premultiplied: true }));
      const actual = drawPacket(native, spritePacket(native, prepared, options));
      if (budget === null && scale === 0.98 && crop[0] === 0)
        assert.ok(memory().preparedFrameCacheBytes < 64 * 48 * 2,
          'converted frames must trim zero margins while retaining the filter halo');
      let maximum = 0;
      for (let i = 0; i < actual.length; i++) maximum = Math.max(maximum, Math.abs(actual[i] - expected[i]));
      assert.ok(maximum <= 1, `ordinary filtering rounding exceeded one byte: ${maximum}`);
    }
    if (budget !== null) {
      assert.equal(memory().preparedFrameCacheMisses, 0);
      assert.equal(memory().preparedFrameCacheBytes, 0);
      await classifiedSheet();
      await wholeSourceSampling();
      return;
    }
    assert.equal(memory().preparedFrameCacheMisses, 0, 'single-cell linear frames draw their prepared page directly');
    const packet = spritePacket(native, prepared, { nearest: false, crop: [0, 0, 64, 48] });
    const first = drawPacket(native, packet), uploads = memory().textureUploadBytes;
    assert.deepEqual(drawPacket(native, packet), first);
    assert.equal(memory().sourceTextureBuilds, 0, 'missing compiled data must not trigger a gameplay build');
    assert.equal(memory().paletteReadbacks, 0);
    assert.equal(memory().textureUploadBytes, uploads);
    assert.ok(memory().preparedFrameCacheBytes <= memory().preparedFrameCacheBudget);
    native.images.release(prepared.handle); prepared = null; native.beginFrame();
    assert.equal(memory().preparedFrameCacheBytes, 0, 'source release must clear converted frames');
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3])
      pixels[i] = pixels[i + 1] = pixels[i + 2] = (pixels[i] + 47) % 256;
    fs.writeFileSync(path.join(root, 'source.png'), png(64, 48, pixels));
    const replacementDirectory = path.join(root, 'replacement'); fs.mkdirSync(replacementDirectory);
    const replacement = await native.assets.processImage('source.png', replacementDirectory, { grid: [1, 1], backdrop: [0, 0, 0, 0] });
    assert.ok(replacement);
    native.assets.installPrepared([{ source: 'source.png', directory: replacementDirectory, descriptor: replacement,
      sourceIdentity: native.assets.sourceIdentity('source.png') }]);
    prepared = await native.images.loadAsync('source.png');
    native.canvas.writePixels(reference.handle, 0, 0, 64, 48, pixels);
    const replaced = drawPacket(native, spritePacket(native, prepared, { nearest: false, crop: [0, 0, 64, 48] }));
    const expected = drawPacket(native, spritePacket(native, reference, { nearest: false, premultiplied: true, crop: [0, 0, 64, 48] }));
    assert.notDeepEqual(replaced, first);
    let maximum = 0;
    for (let i = 0; i < replaced.length; i++) maximum = Math.max(maximum, Math.abs(replaced[i] - expected[i]));
    assert.ok(maximum <= 1, 'replacement must use new source pixels');
    await classifiedSheet();
    await fractionalFrameSampling();
    await wholeSourceSampling();
  } finally {
    if (prepared) native.images.release(prepared.handle);
    if (reference) native.canvas.release(reference.handle);
    native.runtime.quit();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
