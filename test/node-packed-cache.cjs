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
for (const scenario of ['inode', 'range', 'checksum'])
  fs.writeFileSync(path.join(root, 'drift-' + scenario + '.png'), png(128, 128, smallPixels));
for (let index = 0; index < 3; ++index)
  fs.writeFileSync(path.join(root, 'incremental-' + index + '.png'), png(128, 128, smallPixels));
for (const damage of ['missing', 'modified']) for (let index = 0; index < 3; ++index)
  fs.writeFileSync(path.join(root, 'img', 'pictures', 'recovery-' + damage + '-' + index + '.png'), png(128, 128, smallPixels));
test.before(() => native.initialize(settings));
test.after(() => native.runtime.quit());

function canvasPixels(info) {
  const canvas = native.canvas.create(128, 128);
  try {
    native.canvas.drawImage(canvas.handle, info.handle, 0, 0, 128, 128, 0, 0, 128, 128, 1);
    return Buffer.from(native.canvas.readPixels(canvas.handle, 0, 0, 128, 128));
  } finally { native.canvas.release(canvas.handle); }
}

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
    let mapping = await loadPackedCache(root, native, { info() {}, warn(message) { assert.fail(message); } });
    assert.equal(mapping.size, packed.files);
    const originalPacks = new Set([...mapping.values()].map(item => item.pack));
    await packCache(root, native.assets, { compact: true });
    mapping = await loadPackedCache(root, native, { info() {}, warn(message) { assert.fail(message); } });
    assert.equal(mapping.size, packed.files);
    assert([...mapping.values()].every(item => !originalPacks.has(item.pack)));
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
    const scopedNative = { ...native, fs: { ...native.fs,
      inventory: () => native.fs.inventory().filter(source => !source.startsWith('img/pictures/recovery-')) } };
    const options = { gameRoot: root, cacheRoot: path.join(root, 'cache'), native: scopedNative, maps: false,
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
    assert.equal(owner.palette, false, 'a non-first v2 page decodes into ordinary texture storage');
  } finally {
    for (const value of [image, reference]) if (value) native.images.release(value.handle);
    native.assets.installPackedFiles([]);
  }
});

test('catalog pages tolerate pack inode drift only with matching ranges and verified bytes', async () => {
  const source = 'drift-inode.png', relative = 'entries/' + 'e'.repeat(64), directory = path.join(root, relative);
  fs.mkdirSync(directory, { recursive: true });
  const descriptor = await native.assets.processImage(source, directory,
    { grid: [1, 1], backdrop: [0, 0, 0, 0] }, path.join(root, source), null, { pageCodec: 'lz4' });
  assert(descriptor && descriptor.pages.length);
  const outputs = Object.fromEntries(fs.readdirSync(directory).map(name => [name, hash(fs.readFileSync(path.join(directory, name)))]));
  const data = { files: {}, results: { [relative]: { outputs } }, indices: {}, failures: {} };
  fs.writeFileSync(path.join(root, 'preparation-state.json'), JSON.stringify({ version: 1, checksum: hash(JSON.stringify(data)), data }));
  try {
    await packCache(root, native.assets);
    await loadPackedCache(root, native, { info() {}, warn(message) { assert.fail(message); } });
    const entry = { source, directory, descriptor, sourceIdentity: native.assets.sourceIdentity(source),
      pageHashes: descriptor.pages.map(page => outputs[page.path]) };
    assert.equal(native.assets.installPrepared([entry], true), 1);
    const identities = entry.pageIdentities.map(identity => {
      const marker = identity.indexOf('\npacked:');
      assert(marker > 0);
      const fields = identity.slice(0, marker).split(':');
      fields[fields.length - 6] = String(BigInt(fields[fields.length - 6]) + 1n);
      return fields.join(':') + identity.slice(marker);
    });
    for (const scenario of ['inode', 'range', 'checksum']) {
      const scenarioSource = 'drift-' + scenario + '.png';
      const changed = { ...entry, source: scenarioSource, sourceIdentity: native.assets.sourceIdentity(scenarioSource),
        pageIdentities: identities.slice(), pageHashes: entry.pageHashes.slice() };
      if (scenario === 'range') changed.pageIdentities[0] = changed.pageIdentities[0].replace(
        /\npacked:(\d+):/, (_, offset) => '\npacked:' + (Number(offset) + 1) + ':');
      if (scenario === 'checksum') changed.pageHashes[0] = 'f'.repeat(64);
      assert.equal(native.assets.installPreparedCatalog([changed]), 1);
      const before = native.images.memory().preparedHits;
      const image = await native.images.loadAsync(scenarioSource);
      try {
        assert.equal(native.images.memory().preparedHits - before, scenario === 'inode' ? 1 : 0, scenario);
        const ordinary = native.images.loadBytes(png(128, 128, smallPixels));
        try { assert.deepEqual(canvasPixels(image), canvasPixels(ordinary)); }
        finally { native.images.release(ordinary.handle); }
      } finally { native.images.release(image.handle); }
    }
  } finally { native.assets.installPackedFiles([]); }
});

test('installed converter supports initial and repeat batches without initializing a host', () => {
  const cache = temporaryDirectory('packed-tool-'), relative = 'entries/' + 'b'.repeat(64);
  fs.mkdirSync(path.join(cache, relative), { recursive: true });
  const bytes = Buffer.alloc(40, 42);
  fs.writeFileSync(path.join(cache, relative, 'page-0.pml4'), bytes);
  const data = { files: {}, results: { [relative]: { outputs: { 'page-0.pml4': hash(bytes) } } }, indices: {}, failures: {} };
  fs.writeFileSync(path.join(cache, 'preparation-state.json'), JSON.stringify({ version: 1, checksum: hash(JSON.stringify(data)), data }));
  let previousPack;
  for (const extra of [[], [], ['--verify-hashes'], ['--compact'], ['--verify-hashes', '--compact']]) {
    const result = require('node:child_process').spawnSync(process.execPath,
      [path.join(__dirname, '../tools/pack-prepared-cache.cjs'), path.resolve(process.argv[2]), cache, ...extra], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).files, 1);
    assert.equal(fs.readdirSync(cache).filter(name => name.endsWith('.pmpk')).length, 1);
    const index = JSON.parse(fs.readFileSync(path.join(cache, 'packed-images.json'), 'utf8'));
    const entry = index.data.files[0];
    if (previousPack) {
      if (extra.includes('--compact')) assert.notEqual(entry.pack, previousPack);
      else assert.equal(entry.pack, previousPack);
    }
    previousPack = entry.pack;
    assert.deepEqual(fs.readFileSync(path.join(cache, entry.pack)).subarray(entry.offset, entry.offset + entry.size), bytes);
  }
});

test('an interrupted conversion loads a mixture of packed and loose native pages', async t => {
  const entries = [], results = {};
  let pageBytes = 0;
  for (let index = 0; index < 3; ++index) {
    const source = 'incremental-' + index + '.png', relative = 'entries/' + String(index + 7).repeat(64);
    const directory = path.join(root, relative);
    fs.mkdirSync(directory, { recursive: true });
    const descriptor = await native.assets.processImage(source, directory,
      { grid: [1, 1], backdrop: [0, 0, 0, 0] }, path.join(root, source), null, { pageCodec: 'lz4' });
    assert(descriptor && descriptor.pages.length === 1);
    const outputs = Object.fromEntries(fs.readdirSync(directory).map(name => [name, hash(fs.readFileSync(path.join(directory, name)))]));
    assert.equal(Object.keys(outputs).length, 1);
    pageBytes = Math.max(pageBytes, fs.statSync(path.join(directory, descriptor.pages[0].path)).size);
    results[relative] = { outputs };
    entries.push({ source, directory, descriptor, sourceIdentity: native.assets.sourceIdentity(source),
      pageHashes: descriptor.pages.map(page => outputs[page.path]) });
  }
  const data = { files: {}, results, indices: {}, failures: {} };
  fs.writeFileSync(path.join(root, 'preparation-state.json'), JSON.stringify({ version: 1, checksum: hash(JSON.stringify(data)), data }));
  const rename = fs.promises.rename.bind(fs.promises);
  let publications = 0;
  const failure = t.mock.method(fs.promises, 'rename', async (from, to) => {
    if (to === path.join(root, 'packed-images.json') && ++publications === 2) throw new Error('interrupted batch');
    return rename(from, to);
  });
  try {
    await assert.rejects(packCache(root, native.assets, { maximumBytes: pageBytes * 2 }), /interrupted batch/);
    failure.mock.restore();
    const mapping = await loadPackedCache(root, native, { info() {}, warn(message) { assert.fail(message); } });
    assert.equal(mapping.size, 2);
    assert.equal(native.assets.installPrepared(entries), 3);
    for (const entry of entries) {
      const before = native.images.memory().preparedHits;
      const image = await native.images.loadAsync(entry.source);
      const ordinary = native.images.loadBytes(png(128, 128, smallPixels));
      try {
        assert.equal(native.images.memory().preparedHits - before, 1);
        assert.deepEqual(canvasPixels(image), canvasPixels(ordinary));
      } finally { native.images.release(image.handle); native.images.release(ordinary.handle); }
    }
  } finally { failure.mock.restore(); native.assets.installPackedFiles([]); }
});

for (const damage of ['missing', 'modified']) test('preparation regenerates only assets in a ' + damage + ' pack', async () => {
  const { prepareGameAssets } = require('../runner/preparation.cjs');
  const { loadCatalog } = require('../runner/preparation-catalog.cjs');
  const prefix = 'img/pictures/recovery-' + damage + '-';
  const scopedNative = { ...native, fs: { ...native.fs,
    inventory: () => native.fs.inventory().filter(source => source.startsWith(prefix)) } };
  const options = { gameRoot: root, cacheRoot: path.join(root, 'selective-' + damage), native: scopedNative,
    maps: false, pageCodec: 'lz4', fastStartup: true, logger: { info() {}, warn() {} } };
  try {
    const first = await prepareGameAssets(options);
    assert.equal(first.images.installed, 3);
    first.releaseCacheLease();
    const maximumBytes = Math.max(...first.images.entries.map(entry =>
      fs.statSync(path.join(entry.directory, entry.descriptor.pages[0].path)).size)) * 2;
    await packCache(first.root, native.assets, { maximumBytes });
    const warm = await prepareGameAssets(options);
    assert.equal(warm.images.generated, 0);
    warm.releaseCacheLease();
    const indexPath = path.join(first.root, 'packed-images.json');
    const before = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    assert.equal(before.data.packs.length, 2);
    const healthyPack = before.data.packs[0].name, broken = path.join(first.root, before.data.packs[1].name);
    if (damage === 'missing') fs.unlinkSync(broken);
    else fs.appendFileSync(broken, 'damaged');
    assert.equal(await loadCatalog(options), null);
    assert.equal(native.images.memory().packedFileCount, 2);
    const repaired = await prepareGameAssets(options);
    assert.equal(repaired.images.generated, 1);
    assert.equal(repaired.images.hits, 2);
    assert.equal(repaired.images.installed, 3);
    assert.equal(repaired.catalogSaved, true);
    repaired.releaseCacheLease();
    const after = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    assert.deepEqual(after.data.packs.map(pack => pack.name), [healthyPack]);
    assert.equal(after.data.files.length, 2);
    for (let launch = 0; launch < 2; ++launch) {
      const catalog = await loadCatalog(options);
      assert(catalog?.images.catalogHit);
      catalog.releaseCacheLease();
    }
    for (let index = 0; index < 3; ++index) {
      const image = await native.images.loadAsync(prefix + index + '.png');
      const ordinary = native.images.loadBytes(png(128, 128, smallPixels));
      try { assert.deepEqual(canvasPixels(image), canvasPixels(ordinary)); }
      finally { native.images.release(image.handle); native.images.release(ordinary.handle); }
    }
  } finally { native.assets.installPackedFiles([]); }
});
