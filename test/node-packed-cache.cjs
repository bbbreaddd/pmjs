'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { png } = require('./helpers/png.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { packCache, loadPackedCache } = require('../runner/packed-cache.cjs');
const native = require(path.resolve(process.argv[2]));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

const root = temporaryDirectory('native-packed-images-'), directory = path.join(root, 'entries', 'a'.repeat(64));
fs.mkdirSync(directory, { recursive: true });
const width = 1536, height = 768, pixels = Buffer.alloc(width * height * 4);
for (let y = 5; y < height - 5; y++) for (let x = 5; x < width - 5; x++)
  pixels.set([x * 2, y * 4, (x + y) % 255, (x + y) % 3 ? 128 : 255], (y * width + x) * 4);
const bytes = png(width, height, pixels); fs.writeFileSync(path.join(root, 'sheet.png'), bytes);
const settings = { gameRoot: root, assetRoot: '', width: 128, height: 64,
  windowTitle: 'packed prepared images', imageWarmCacheBytes: 0, preparedFrameCacheBytes: 0 };
fs.mkdirSync(path.join(root, 'img', 'pictures'), { recursive: true });
const smallPixels = Buffer.alloc(128 * 128 * 4);
for (let y = 40; y < 80; y++) for (let x = 40; x < 80; x++)
  smallPixels.set([x * 2, y * 2, 70, (x + y) % 3 ? 128 : 255], (y * 128 + x) * 4);
fs.writeFileSync(path.join(root, 'img', 'pictures', 'test.png'), png(128, 128, smallPixels));
const sparseSource = require('./helpers/sparse-palette.cjs').fixture(root, 257, 259);
const noise = Buffer.alloc(257 * 259 * 4);
for (let i = 0; i < noise.length; i += 4) noise.set([i & 255, (i >>> 8) & 255, (i >>> 16) & 255, 255], i);
fs.writeFileSync(path.join(root, 'dense.png'), png(257, 259, noise));
test.before(() => native.initialize(settings));
test.after(() => native.runtime.quit());

test('packed prepared pages preserve async loads, texture uploads, pixels and live ownership', async () => {
  try {
    const descriptor = await native.assets.processImage('sheet.png', directory,
      { grid: [3, 2], framePages: true, backdrop: [0, 0, 0, 0] }, path.join(root, 'sheet.png'), undefined, { pageCodec: 'lz4' });
    assert(descriptor && descriptor.pages.length);
    assert.equal(descriptor.textureArtifact, 'texture.pmtx');
    const outputs = Object.fromEntries(fs.readdirSync(directory).map(name => [name, hash(fs.readFileSync(path.join(directory, name)))]));
    const data = { files: {}, results: { ['entries/' + 'a'.repeat(64)]: { outputs } }, indices: {}, failures: {} };
    fs.writeFileSync(path.join(root, 'preparation-state.json'), JSON.stringify({ version: 1, checksum: hash(JSON.stringify(data)), data }));
    const entry = { source: 'sheet.png', directory, descriptor, pageHashes: descriptor.pages.map(page => outputs[page.path]),
      sourceIdentity: native.assets.sourceIdentity('sheet.png'), ...(descriptor.textureArtifact ? { textureHash: outputs[descriptor.textureArtifact] } : {}) };
    function draw(image) {
      native.beginFrame();
      const schema = native.scene.schema, values = new Float32Array(schema.valueStride);
      values.set([0.07, 0, 0, 0.07, 5, 5, 0.7]);
      values.set([0, 0, width, height, width, height], 9);
      native.scene.submit(schema.version, new Uint32Array([1, 0xffffffff, image.handle, 0xffffff, 0, 8, 0]), values, 1);
      native.renderScene();
      return Buffer.from(native.canvas.captureSceneRawPremultiplied());
    }
    const ordinary = native.images.loadBytes(bytes), expected = draw(ordinary);
    native.beginFrame();
    native.scene.submit(native.scene.schema.version, new Uint32Array(), new Float32Array(), 0);
    native.renderScene();
    native.images.release(ordinary.handle);
    const packed = await packCache(root, native.assets);
    assert.equal(packed.files, Object.keys(outputs).length);
    const mapping = await loadPackedCache(root, native, { info() {}, warn(message) { assert.fail(message); } });
    assert.equal(mapping.size, packed.files);
    assert.equal(native.assets.installPrepared([entry]), 1);
    const before = native.images.memory();
    const image = await native.images.loadAsync('sheet.png');
    const first = [...mapping.values()].find(item => item.name.endsWith('texture.pmtx'));
    assert(first.offset > 0);
    assert.throws(() => native.assets.installPackedFiles([{ ...first, offset: -1 }]), /range/);
    assert.throws(() => native.assets.installPackedFiles([{ ...first, size: 64 * 1024 * 1024 }]), /range/);
    native.assets.installPackedFiles([]);
    for (const name of fs.readdirSync(root)) if (name.endsWith('.pmpk')) fs.unlinkSync(path.join(root, name));
    assert.deepEqual(draw(image), expected, 'live images retain their pack descriptors after unmount and unlink');
    const after = native.images.memory();
    assert.equal(after.textureArtifactLoads, before.textureArtifactLoads + 1);
    assert.equal(after.textureArtifactFailures, before.textureArtifactFailures);
    assert.equal(after.sourceTextureBuilds, before.sourceTextureBuilds);
    assert(after.textureArtifactStagingBytes <= 1024 * 1024);
    native.images.release(image.handle);
  } finally { native.assets.installPackedFiles([]); }
});

test('normal preparation reuses packed outputs without regenerating loose pages', async () => {
  const { prepareGameAssets } = require('../runner/preparation.cjs');
  const pixels = smallPixels;
  try {
    const options = { gameRoot: root, cacheRoot: path.join(root, 'cache'), native, maps: false,
      pageCodec: 'lz4', fastStartup: true, logger: { info() {}, warn() {} } };
    const first = await prepareGameAssets(options);
    assert.equal(first.images.installed, 1);
    first.releaseCacheLease();
    const packed = await packCache(first.root, native.assets);
    assert(packed.files > 0);
    const second = await prepareGameAssets(options);
    assert.equal(second.images.generated, 0);
    assert.equal(second.images.hits, 1);
    assert.equal(second.images.installed, 1);
    const image = await native.images.loadAsync('img/pictures/test.png');
    assert.equal(image.width, 128);
    const ordinary = native.images.loadBytes(png(128, 128, pixels));
    function canvasPixels(info) {
      const canvas = native.canvas.create(128, 128);
      try {
        native.canvas.drawImage(canvas.handle, info.handle, 0, 0, 128, 128, 0, 0, 128, 128, 1);
        return Buffer.from(native.canvas.readPixels(canvas.handle, 0, 0, 128, 128));
      } finally { native.canvas.release(canvas.handle); }
    }
    assert.deepEqual(canvasPixels(image), canvasPixels(ordinary));
    native.images.release(ordinary.handle); native.images.release(image.handle);
    assert(!fs.existsSync(path.join(second.images.entries[0].directory, second.images.entries[0].descriptor.pages[0].path)));
    second.releaseCacheLease();
    const third = await require('../runner/preparation-catalog.cjs').loadCatalog(options);
    assert(third && third.images.catalogHit);
    const fromCatalog = await native.images.loadAsync('img/pictures/test.png');
    assert.equal(fromCatalog.width, 128); native.images.release(fromCatalog.handle);
    third.releaseCacheLease();
    assert(native.images.memory().packedFileCount > 0);
    const disabledWhileMounted = await prepareGameAssets({ ...options, images: false });
    assert.equal(native.images.memory().packedFileCount, 0);
    disabledWhileMounted.releaseCacheLease();
    const enabledAgain = await prepareGameAssets(options);
    assert.equal(enabledAgain.images.generated, 0);
    assert(native.images.memory().packedFileCount > 0);
    enabledAgain.releaseCacheLease();
    const repacked = await packCache(first.root, native.assets);
    const afterRepack = await prepareGameAssets(options);
    assert.equal(afterRepack.images.generated, 0);
    assert.equal(afterRepack.images.installed, 1);
    assert.equal(native.images.memory().packedFileCount, repacked.files);
    afterRepack.releaseCacheLease();
    for (const damage of ['missing', 'modified']) {
      if (damage === 'modified') {
        await packCache(first.root, native.assets);
        const packedAgain = await prepareGameAssets(options);
        assert.equal(packedAgain.images.generated, 0);
        packedAgain.releaseCacheLease();
      }
      const index = JSON.parse(fs.readFileSync(path.join(first.root, 'packed-images.json'), 'utf8'));
      const pack = path.join(first.root, index.data.packs[0].name);
      if (damage === 'missing') fs.unlinkSync(pack);
      else fs.appendFileSync(pack, 'damage');
      assert.equal(await require('../runner/preparation-catalog.cjs').loadCatalog(options), null);
      const repaired = await prepareGameAssets(options);
      assert.equal(repaired.images.generated, 1);
      assert.equal(repaired.images.installed, 1);
      repaired.releaseCacheLease();
      assert(!fs.existsSync(path.join(first.root, 'packed-images.json')));
      assert(fs.existsSync(path.join(first.root, 'packed-images.invalid.json')));
      for (let launch = 0; launch < 2; ++launch) {
        const recoveredCatalog = await require('../runner/preparation-catalog.cjs').loadCatalog(options);
        assert(recoveredCatalog && recoveredCatalog.images.catalogHit, 'repaired cache must keep fast startup on later launches');
        recoveredCatalog.releaseCacheLease();
      }
    }
    const noImages = { ...options, images: false };
    const disabled = await prepareGameAssets(noImages);
    assert.equal(disabled.images, undefined);
    disabled.releaseCacheLease();
    const disabledCatalog = await require('../runner/preparation-catalog.cjs').loadCatalog(noImages);
    assert(disabledCatalog);
    assert.equal(native.images.memory().packedFileCount, 0);
    disabledCatalog.releaseCacheLease();
  } finally { native.assets.installPackedFiles([]); }
});


test('non-first sparse pages use their own packed header rather than the dense first page', async () => {
  const { spritePacket, drawPacket } = require('./helpers/sparse-palette.cjs');
  const entries = [], results = {};
  for (const [index, name] of ['dense.png', 'sparse.png'].entries()) {
    const relative = 'entries/' + String(index + 5).repeat(64), directory = path.join(root, relative);
    fs.mkdirSync(directory, { recursive: true });
    const descriptor = await native.assets.processImage(name, directory, { grid: [1, 1], backdrop: [0, 0, 0, 0] },
      path.join(root, name), null, { pageCodec: 'lz4' });
    assert(descriptor && descriptor.pages.length === 1);
    const page = fs.readFileSync(path.join(directory, descriptor.pages[0].path));
    assert.equal(page.readUInt32LE(4), index === 0 ? 1 : 2);
    const outputs = Object.fromEntries(fs.readdirSync(directory).map(file => [file, hash(fs.readFileSync(path.join(directory, file)))]));
    results[relative] = { outputs };
    entries.push({ source: name, directory, descriptor, sourceIdentity: native.assets.sourceIdentity(name),
      pageHashes: descriptor.pages.map(page => outputs[page.path]) });
  }
  const data = { files: {}, results, indices: {}, failures: {} };
  fs.writeFileSync(path.join(root, 'preparation-state.json'), JSON.stringify({ version: 1, checksum: hash(JSON.stringify(data)), data }));
  await packCache(root, native.assets);
  const mapping = await loadPackedCache(root, native, { info() {}, warn(message) { assert.fail(message); } });
  assert(mapping.get(path.join(entries[1].directory, entries[1].descriptor.pages[0].path)).offset > 0);
  assert.equal(native.assets.installPrepared(entries), 2);
  let image, reference;
  try {
    image = await native.images.loadAsync('sparse.png'); reference = native.images.loadBytes(sparseSource.bytes);
    const draw = image => drawPacket(native, spritePacket(native, image, { crop: [31, 31, 64, 48] }));
    assert.deepEqual(draw(image), draw(reference));
    const owner = native.images.memory(100).largest.find(entry => entry.handle === image.handle);
    assert.equal(owner.paletteSparse, true, 'a non-first v2 page must retain sparse backing');
  } finally {
    for (const value of [image, reference]) if (value) native.images.release(value.handle);
    native.assets.installPackedFiles([]);
  }
});
