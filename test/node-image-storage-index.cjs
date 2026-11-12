'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { png } = require('./helpers/png.cjs');
const { spritePacket, drawPacket } = require('./helpers/sparse-palette.cjs');
const { generateAssetIndex, loadAssetIndex } = require('../runner/asset-index.cjs');
const { prepareAssets } = require('../runner/asset-preparation.cjs');
const addon = path.resolve(process.argv[2]);
const root = temporaryDirectory('image-storage-index-');
const runtime = path.join(root, 'runtime'), gameRoot = path.join(root, 'game');
const output = path.join(root, 'bundle'), cacheRoot = path.join(root, 'cache');
fs.mkdirSync(path.join(runtime, 'lib'), { recursive: true });
fs.symlinkSync(addon, path.join(runtime, 'lib/pmjs_native.node'));
fs.mkdirSync(path.join(gameRoot, 'img/pictures'), { recursive: true });
fs.mkdirSync(output);
const options = { width: 32, height: 24, assetPreparation: {
  enabled: true, pageCodec: 'png', maps: false, recipes: [], losslessPrefixes: [],
  astc: { enabled: false, quality: 'medium' }, workspaceBytes: 128 * 1024 * 1024
} };
const fixtures = [
  { name: 'zero', width: 128, height: 128, count: 1, channels: 4, bits: 8 },
  { name: 'sparse', width: 512, height: 256, count: 256, channels: 4, bits: 8 },
  { name: 'gray', width: 16, height: 16, count: 256, channels: 1, bits: 0 },
  { name: 'rgba', width: 16, height: 16, count: 256, channels: 4, bits: 0 },
  { name: 'palette8', width: 2048, height: 2048, count: 256, channels: 4, bits: 8 },
  { name: 'palette16', width: 2048, height: 2048, count: 257, channels: 4, bits: 16 },
  { name: 'paletteResidual', width: 512, height: 512, count: 8192, channels: 4, bits: 16 }
];
for (const f of fixtures) {
  const pixels = Buffer.alloc(f.width * f.height * 4);
  for (let i = 0; i < pixels.length / 4; i++) {
    const color = i % f.count;
    pixels[i * 4] = color & 255;
    pixels[i * 4 + 1] = f.name === 'gray' ? color : color >> 8;
    pixels[i * 4 + 2] = f.name === 'gray' ? color : (color * 17 + (color >> 8) * 7) & 255;
    pixels[i * 4 + 3] = f.name === 'rgba' ? (color * 31) & 255 : 255;
  }
  if (f.name === 'paletteResidual') for (let i = 0; i < f.width * f.height; ++i) {
    const rare = i % 31 === 0;
    pixels.set([i & 255, rare ? (i >>> 8) & 31 : 97, rare ? 137 : 51, 255], i * 4);
  }
  if (f.name === 'zero') pixels.fill(0);
  if (f.name === 'sparse') {
    pixels.fill(0);
    for (let y = 96; y < 112; ++y) for (let x = 96; x < 112; ++x) {
      const i = (y * f.width + x) * 4;
      pixels[i] = pixels[i+1] = pixels[i+2] = (x+y) & 255;
      pixels[i+3] = 255;
      pixels.copy(pixels, i + 256*4, i, i+4);
    }
  }
  f.source = 'img/pictures/' + f.name + '.png';
  fs.writeFileSync(path.join(gameRoot, f.source), png(f.width, f.height, pixels));
}
const sheet = fixtures.find(f => f.name === 'sparse');
options.assetPreparation.recipes = [{ source: sheet.source,
  sourceHash: createHash('sha256').update(fs.readFileSync(path.join(gameRoot, sheet.source))).digest('hex'), grid: [2, 1] }];
const residualFixture = fixtures.find(f => f.name === 'paletteResidual');
options.assetPreparation.recipes.push({ source: residualFixture.source,
  sourceHash: createHash('sha256').update(fs.readFileSync(path.join(gameRoot, residualFixture.source))).digest('hex'),
  grid: [1, 1], backdrop: [0, 0, 0, 0] });
const native = require(addon);
let initialized = false;
const handles = [];
(async () => {
  try {
    const result = await generateAssetIndex({ root: runtime, gameRoot, config: null,
      options, output, includeAssets: false });
    assert.equal(result.warningCount, 0, JSON.stringify(result));
    assert.deepEqual(fs.readdirSync(output), ['asset-index.json'], 'default bundle contains metadata only');
    const index = loadAssetIndex(path.join(output, 'asset-index.json'), native, options);
    for (const f of fixtures) {
      const record = index.images.find(record => record.source === f.source);
      assert.equal(record.storage.paletteBits, f.bits, f.name);
      assert.equal(record.storage.channels, f.channels, f.name);
      assert.equal(record.storage.width, f.width);
      assert.equal(record.storage.height, f.height);
      assert.equal(record.storage.pixelFactsVersion, 1);
      assert.equal(record.storage.allZero, f.name === 'zero');
      assert.equal(record.storage.opaque, !['zero', 'sparse', 'rgba'].includes(f.name));
      if (f.name === 'zero') record.storage.sparseRegions = [];
      if (f.name === 'sparse') {
        assert.ok(record.descriptor.pages.length > 0);
        assert.ok(record.descriptor.pages.every(p => p.storage?.pixelFactsVersion === 1));
      }
    }
    native.initialize({ gameRoot, width: 32, height: 24, windowTitle: 'Image storage index', imageWarmCacheBytes: 0 });
    initialized = true;
    for (const f of fixtures.filter(f => f.name.startsWith('palette'))) {
      const raw = native.images.loadBytes(fs.readFileSync(path.join(gameRoot, f.source)));
      assert.equal(native.images.memory(100).largest.find(entry => entry.handle === raw.handle).palette, false,
        'ordinary image loading must not construct a palette');
      native.images.release(raw.handle);
    }
    const preparation = { gameRoot, cacheRoot, native, portableIndex: index,
      pageCodec: 'png', recipes: options.assetPreparation.recipes, workspaceBytes: options.assetPreparation.workspaceBytes };
    const cold = await prepareAssets(preparation);
    assert.equal(cold.error, undefined);
    assert.equal(cold.storageEntries.length, fixtures.length);
    assert.ok(cold.entries.find(e => e.source === sheet.source).descriptor.pages.every(p => p.storage),
      'regenerated pages preserve hash-bound offline layouts');
    for (const f of fixtures.filter(f => f.name.startsWith('palette'))) {
      const before = native.images.memory().storageDecisionHits;
      const image = native.images.load(f.source);
      handles.push(image.handle);
      const m = new Uint32Array([1, 0xffffffff, image.handle, 0xffffff, 0, 0, 0]);
      m[5] = 1 << 3; // Scene packet nearest-sampling flag.
      const v = new Float32Array(41);
      v[0] = 32 / f.width; v[3] = 24 / f.height; v[6] = 1;
      v[11] = v[13] = f.width; v[12] = v[14] = f.height;
      native.beginFrame();
      native.scene.submit(native.scene.schema.version, m, v, 1);
      native.renderScene();
      const memory = native.images.memory(100);
      const owner = memory.largest.find(owner => owner.handle === image.handle);
      const compiled = cold.entries.find(entry => entry.source === f.source)?.descriptor.textureArtifact;
      assert.equal(owner.paletteIndexBits, compiled ? f.bits : 0);
      assert.equal(memory.sourceTextureBuilds, 0, 'storage metadata must not trigger gameplay compilation');
      assert.ok(compiled ? memory.textureArtifactLoads > 0 : memory.storageDecisionHits > before,
        'draw loads prepared data or uses the ordinary metadata path');
    }
    for (const f of fixtures.filter(f => !f.name.startsWith('palette'))) {
      const image = native.images.load(f.source);
      handles.push(image.handle);
      assert.equal(native.images.isOpaque(image.handle), !['zero', 'sparse', 'rgba'].includes(f.name));
    }
    const warm = await prepareAssets(preparation);
    assert.equal(warm.validation.hashedFiles, 0);
    assert.equal(warm.storageEntries.length, fixtures.length);
    assert.ok(warm.entries.find(e => e.source === sheet.source).descriptor.pages.every(p => p.storage),
      'warm catalogs preserve page layouts');
    for (const handle of handles.splice(0)) native.images.release(handle);
    drawPacket(native, spritePacket(native, { handle: 0 }, { count: 0 }), false);
    const gray = fixtures.find(f => f.name === 'gray');
    const record = cold.storageEntries.find(entry => entry.source === gray.source);
    const changedField = (identity, fromEnd) => {
      const fields = identity.split(':');
      fields[fields.length - fromEnd] = String(BigInt(fields[fields.length - fromEnd]) + 1n);
      return fields.join(':');
    };
    const drifted = { ...record, sourceIdentity: changedField(record.sourceIdentity, 6) };
    const legacy = { ...drifted };
    delete legacy.backingHash;
    assert.equal(native.assets.installImageStorage([legacy]), 0, 'inode recovery requires a checksum');
    assert.equal(native.assets.installImageStorage([{ ...drifted, backingHash: '0'.repeat(64) }]), 0,
      'inode recovery rejects a content mismatch');
    assert.equal(native.assets.installImageStorage([{ ...drifted, backingHash: 'invalid' }]), 0);
    assert.equal(native.assets.installImageStorage([{ ...record,
      sourceIdentity: changedField(record.sourceIdentity, 5) }]), 0, 'size changes cannot use inode recovery');
    assert.equal(native.assets.installImageStorage([drifted]), 1, 'verified inode drift preserves storage decisions');
    const before = native.images.memory().storageDecisionHits;
    const recovered = native.images.load(gray.source);
    handles.push(recovered.handle);
    assert.equal(native.images.memory().storageDecisionHits, before + 1,
      'recovered decisions bind to the current file identity');
    console.log('Image storage identity recovery passed');
    const lz4Output = path.join(root, 'lz4-bundle');
    fs.mkdirSync(lz4Output);
    const lz4Options = { ...options, assetPreparation: { ...options.assetPreparation, pageCodec: 'lz4' } };
    const lz4 = await generateAssetIndex({ root: runtime, gameRoot, config: null, options: lz4Options, output: lz4Output, includeAssets: true });
    assert.equal(lz4.warningCount, 0);
    const lz4Index = loadAssetIndex(path.join(lz4Output, 'asset-index.json'), native, lz4Options);
    const pages = lz4Index.images.find(r => r.source === sheet.source).descriptor.pages;
    assert.ok(pages.length && pages.every(p => p.path.endsWith('.pml4') && p.storage.channels === 2));
    assert.equal(lz4Index.pageCodecVersion, native.assets.preparationLz4Version);
    const bootstrap = path.join(lz4Output, 'bootstrap.js');
    fs.writeFileSync(bootstrap, '// fixture bootstrap\n');
    fs.mkdirSync(path.join(lz4Output, 'gamedata'));
    const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    fs.writeFileSync(path.join(lz4Output, 'pmjs.json'), JSON.stringify({
      schema: 1, kind: 'pmjs-game-bundle', game: 'gamedata', patches: [],
      bootstrap: 'bootstrap.js', bootstrapSha256: sha256(bootstrap),
      assetIndex: 'asset-index.json', assetIndexSha256: sha256(path.join(lz4Output, 'asset-index.json')),
      assets: 'assets', portPreparation: []
    }));
    const verifyBundle = 'import sys; from pathlib import Path; sys.path.insert(0, sys.argv[2]); ' +
      'import portmaster; portmaster.checked_bundle(Path(sys.argv[1]))';
    execFileSync('python3', ['-c', verifyBundle, lz4Output, path.resolve(__dirname, '../tools')],
      { stdio: 'pipe' });
    const residual = lz4Index.images.find(r => r.source.endsWith('/paletteResidual.png'));
    assert.ok(residual.descriptor.pages.some(page => {
      const outputPage = residual.outputs.find(o => o.path.endsWith('/' + page.path));
      const file = path.join(lz4Output, outputPage.path);
      const bytes = fs.readFileSync(file);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), outputPage.hash);
      return bytes.toString('ascii', 0, 4) === 'PML4' && bytes.readUInt32LE(4) === 2 && page.storage.paletteBits === 16;
    }), 'portable index did not include a sparse palette page with valid storage metadata');
    native.beginFrame();
    for (const handle of handles) native.images.release(handle);
    handles.length = 0;
    native.beginFrame();
    const installed = await prepareAssets({ ...preparation, pageCodec: 'lz4',
      portableIndex: lz4Index, portableAssetRoot: lz4Output, cacheRoot: path.join(root, 'bundled-cache') });
    assert.equal(installed.error, undefined);
    assert.ok(installed.indexedPageCopies > 0, 'bundled sparse pages were not reused');
    const entry = installed.entries.find(e => e.source === residual.source);
    assert.ok(entry && entry.descriptor.pages.every(page => page.storage));
    const image = await native.images.loadAsync(residual.source);
    handles.push(image.handle);
    console.error(JSON.stringify({ beforeDraw: native.images.memory(100).largest.find(o => o.handle === image.handle) }));
    const spriteOptions = { crop: [0, 0, image.width, image.height], scale: 32 / image.width };
    const actual = drawPacket(native, spritePacket(native, image, spriteOptions));
    const reference = native.images.loadBytes(fs.readFileSync(path.join(gameRoot, residual.source)));
    try {
      assert.deepEqual(actual, drawPacket(native, spritePacket(native, reference, spriteOptions)));
    } finally { native.images.release(reference.handle); }
    const indexedOwner = native.images.memory(100).largest.find(o => o.handle === image.handle);
    if (!indexedOwner.paletteSparse) console.error(JSON.stringify({ indexedOwner, cells: entry.descriptor.cells }));
    assert.ok(indexedOwner.paletteSparse || (indexedOwner.sceneryBacking && !indexedOwner.sceneryFullMaterialized),
      'prepared page lost compact backing');
    assert.equal(indexedOwner.fullTextureResident, false, 'prepared draw materialized the full source');
    const reused = await prepareAssets({ ...preparation, pageCodec: 'lz4',
      portableIndex: lz4Index, portableAssetRoot: lz4Output, cacheRoot: path.join(root, 'bundled-cache') });
    assert.equal(reused.validation.hashedFiles, 0, 'unchanged pages were hashed again');
    console.log('Offline channel/8-bit/16-bit/RGBA decisions, native activation and warm catalog passed');
  } finally {
    for (const handle of handles) native.images.release(handle);
    if (initialized) native.runtime.quit();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
