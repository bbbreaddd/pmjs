'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { loadAssetIndex, offlineFilesystem, assetIndexArtifacts } = require('../runner/asset-index.cjs');
const { COMPILER_VERSION } = require('../runner/map-demand.cjs');
const identity = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('generated map indexes omit local source metadata without changing cached descriptors', async t => {
  const root = temporaryDirectory('portable-map-index-');
  const output = path.join(root, 'output'), gameRoot = path.join(root, 'game');
  for (const directory of [output, gameRoot, path.join(root, 'lib')]) fs.mkdirSync(directory);
  const addon = path.join(root, 'lib/pmjs_native.node');
  fs.writeFileSync(addon, '');
  const { preparationLocks } = require('./helpers/preparation-lock.cjs');
  require.cache[addon] = { exports: { assets: { ...preparationLocks(), imageStorageVersion: 1,
    classifyImageStorage() { throw new Error('no images expected'); } } } };
  t.after(() => { delete require.cache[addon]; });
  const page = path.join(root, 'tiles-0.png');
  fs.writeFileSync(page, 'prepared page');
  const checksum = crypto.createHash('sha256').update(fs.readFileSync(page)).digest('hex');
  const source = Object.freeze({ source: 'img/tilesets/B.png', sourceHash: 'a'.repeat(64),
    snapshot: path.join(root, 'cache/sources/B.png'), sourceIdentity: 'local-identity',
    width: 48, height: 48, regions: [{ rect: [0, 0, 48, 48], atlas: [1, 1, 48, 48], page: 0 }] });
  const descriptor = Object.freeze({ version: 1, halo: 1,
    pages: [{ path: 'tiles-0.png', width: 50, height: 50 }], sources: Object.freeze([source]) });
  const preparation = require('../runner/preparation.cjs');
  let failure = false;
  t.mock.method(preparation, 'prepareGameAssets', async () => failure ? { images: { failedFiles: 1 } } : ({ maps: {
    selected: 1, index: { 1: { identity: 'map-1' } }, entries: [{ identity: 'map-1', directory: root,
      descriptor, outputs: [{ path: 'tiles-0.png', hash: checksum }] }] } }));
  const modulePath = require.resolve('../runner/asset-index.cjs');
  const originalModule = require.cache[modulePath];
  delete require.cache[modulePath];
  t.after(() => { require.cache[modulePath] = originalModule; });
  const { generateAssetIndex } = require(modulePath);
  await generateAssetIndex({ root, gameRoot, output, includeAssets: true,
    options: { width: 816, height: 624, assetPreparation: { enabled: true, maps: true, recipes: [], pageCodec: 'png' } } });
  const index = JSON.parse(fs.readFileSync(path.join(output, 'asset-index.json')));
  const { snapshot, sourceIdentity, ...portableSource } = source;
  assert.deepEqual(index.maps.entries[0].descriptor, { ...descriptor, sources: [portableSource] });
  assert.equal(descriptor.sources[0].snapshot, snapshot);
  assert.equal(descriptor.sources[0].sourceIdentity, sourceIdentity);
  assert.deepEqual(index.maps.entries[0].outputs,
    [{ path: 'assets/maps/map-1/tiles-0.png', hash: checksum }]);
  assert.equal(fs.readFileSync(path.join(output, index.maps.entries[0].outputs[0].path), 'utf8'), 'prepared page');
  failure = true;
  await assert.rejects(generateAssetIndex({ root, gameRoot, output, includeAssets: false,
    options: { width: 816, height: 624, assetPreparation: { enabled: true, maps: true } } }), /asset index incomplete/);
});

function fixture() {
  const root = temporaryDirectory('asset-index-'), file = path.join(root, 'index.json');
  const native = { assets: { preparationVersion: { processor: 1 }, tilePreparationVersion: 'tiles-1', preparationLz4Version: 'sparse-palette-v2' } };
  const options = { width: 816, height: 624, assetPreparation: { recipes: [], pageCodec: 'lz4' } };
  const index = { schema: 2, kind: 'pmjs-asset-index',
    sections: { images: 1, negativeHints: 1, mapCompilation: 1, tileOutputs: 1 },
    processor: native.assets.preparationVersion, tileProcessor: native.assets.tilePreparationVersion,
    recipesIdentity: identity([]), pageCodec: 'lz4', pageCodecVersion: native.assets.preparationLz4Version, width: 816, height: 624, configSha256: 'old',
    images: [{ source: 'img/pictures/a.png', outputs: [] }], negativeHints: ['img/pictures/b.png'],
    maps: { compiler: COMPILER_VERSION, compilations: { key: 'compilation' }, mapInputs: { name: 'contract' },
      entries: [{ identity: 'entry', outputs: [] }] } };
  const load = () => { fs.writeFileSync(file, JSON.stringify(index)); return loadAssetIndex(file, native, options); };
  return { index, native, options, load };
}

test('portable index reuses independent sections across configuration, viewport and processor changes', () => {
  const f = fixture();
  assert.equal(f.load().images.length, 1, 'unrelated config checksum does not discard decisions');
  f.native.assets.tilePreparationVersion = 'tiles-2';
  let loaded = f.load();
  assert.equal(loaded.images.length, 1); assert.deepEqual(loaded.maps.entries, []);
  assert.deepEqual(loaded.maps.compilations, f.index.maps.compilations);
  f.native.assets.tilePreparationVersion = 'tiles-1'; f.options.width = 1280;
  loaded = f.load();
  assert.equal(loaded.images.length, 1); assert.deepEqual(loaded.maps.entries, []);
  f.options.width = 816; f.native.assets.preparationVersion = { processor: 2 };
  loaded = f.load();
  assert.deepEqual(loaded.images, []); assert.equal(loaded.maps.entries.length, 1);
  assert.deepEqual(loaded.negativeHints, f.index.negativeHints);
  f.index.maps.compiler = 'unsupported';
  assert.equal(f.load().maps, null);
});

test('recipe, codec and section versions only invalidate the affected index sections', () => {
  for (const field of ['recipes', 'pageCodec', 'losslessPrefixes', 'astc', 'astcQuality', 'images', 'mapCompilation', 'tileOutputs', 'negativeHints']) {
    const f = fixture();
    if (field === 'astc') f.options.assetPreparation.astc = { enabled: true };
    else if (field === 'astcQuality') f.options.assetPreparation.astc = { enabled: false, quality: 'thorough' };
    else if (field === 'losslessPrefixes') f.options.assetPreparation.losslessPrefixes = ['img/masks/'];
    else if (field === 'recipes') f.options.assetPreparation.recipes = [{ changed: true }];
    else if (field === 'pageCodec') f.options.assetPreparation.pageCodec = 'png';
    else f.index.sections[field] = 99;
    const loaded = f.load();
    if (['recipes', 'pageCodec', 'losslessPrefixes', 'astc', 'astcQuality', 'images'].includes(field)) {
      assert.deepEqual(loaded.images, []); assert.equal(loaded.maps.entries.length, 1);
    } else if (field === 'mapCompilation') assert.equal(loaded.maps, null);
    else if (field === 'tileOutputs') assert.deepEqual(loaded.maps.entries, []);
    else assert.deepEqual(loaded.negativeHints, []);
  }
});

test('legacy indexes retain strict content decisions without gaining unverified negative hints', () => {
  const f = fixture(); f.index.schema = 1;
  const loaded = f.load();
  assert.equal(loaded.images.length, 1); assert.equal(loaded.maps.entries.length, 1);
  assert.deepEqual(loaded.negativeHints, []);
});

test('an invalid image section does not discard valid map compilation or tile outputs', () => {
  const f = fixture(); f.index.images = null;
  const loaded = f.load();
  assert.deepEqual(loaded.images, []); assert.equal(loaded.maps.entries.length, 1);
});

test('storage decisions require their own supported version and valid layout', () => {
  const f = fixture();
  const storage = { version: 1, width: 2048, height: 2048, channels: 4,
    paletteBits: 8, source: [0, 1, 2, 3], swizzle: [0, 1, 2, 3] };
  f.index.sections.imageStorage = 1;
  f.index.imageStorageVersion = f.native.assets.imageStorageVersion = 1;
  f.index.images[0].storage = storage;
  assert.deepEqual(f.load().images[0].storage, storage);
  const facts = { ...storage, pixelFactsVersion: 1, opaque: true, allZero: false };
  f.index.images[0].storage = facts;
  assert.deepEqual(f.load().images[0].storage, facts);
  f.index.images[0].storage = { ...facts, sparseRegions: [[0, 0, 32, 32]] };
  assert.deepEqual(f.load().images[0].storage, f.index.images[0].storage);
  for (const invalid of [{ ...facts, allZero: true }, { ...facts, pixelFactsVersion: 2 }]) {
    f.index.images[0].storage = invalid;
    assert.equal(f.load().images[0].storage, undefined);
  }
  f.index.images[0].storage = storage;
  f.index.imageStorageVersion = 2;
  assert.equal(f.load().images[0].storage, undefined);
  f.index.imageStorageVersion = 1;
  f.index.images[0].storage = { ...storage, paletteBits: 12 };
  assert.equal(f.load().images[0].storage, undefined);
  f.index.images[0].storage = { ...storage, channels: 1, swizzle: [0, 1, 0, 5] };
  assert.equal(f.load().images[0].storage, undefined);
  assert.equal(f.load().images.length, 1, 'bad storage metadata does not discard preparation layout');
});

test('LZ4 container versions invalidate image outputs without discarding independent sections', () => {
  const f = fixture();
  assert.equal(f.load().images.length, 1);
  for (const version of [undefined, 'rgba-v1', 'future-v3']) {
    f.index.pageCodecVersion = version;
    const loaded = f.load();
    assert.deepEqual(loaded.images, []);
    assert.equal(loaded.maps.entries.length, 1);
    assert.deepEqual(loaded.negativeHints, f.index.negativeHints);
  }
  f.index.pageCodecVersion = f.native.assets.preparationLz4Version;
  assert.equal(f.load().images.length, 1);
  f.index.pageCodec = f.options.assetPreparation.pageCodec = 'png';
  delete f.index.pageCodecVersion;
  assert.equal(f.load().images.length, 1, 'PNG outputs do not depend on the LZ4 container');
});

test('offline asset lookup follows native VFS case folding and rejects path collisions', () => {
  const root = temporaryDirectory('offline-vfs-');
  fs.mkdirSync(path.join(root, 'Img', 'Characters'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Img', 'Characters', 'Hero.png'), 'hero');
  fs.mkdirSync(path.join(root, 'LinkedDirectory'));
  fs.writeFileSync(path.join(root, 'LinkedDirectory', 'hidden.png'), 'hidden');
  fs.symlinkSync(path.join(root, 'LinkedDirectory'), path.join(root, 'DirectoryAlias'), 'dir');
  const offline = offlineFilesystem(root, new Map());
  assert.equal(offline.assets.sourcePath('img/characters/hero.PNG'),
    path.join(root, 'Img', 'Characters', 'Hero.png'));
  assert.equal(offline.assets.sourcePath('IMG//characters/./Hero.png'),
    path.join(root, 'Img', 'Characters', 'Hero.png'));
  assert.deepEqual(offline.fs.readDirectory('IMG/characters'), ['Hero.png']);
  assert.equal(offline.assets.sourcePath('../Hero.png'), null);
  assert.equal(offline.fs.exists('directoryalias'), true);
  assert.equal(offline.fs.isDirectory('DIRECTORYALIAS'), true);
  assert.equal(offline.assets.sourcePath('directoryalias/hidden.png'), null,
    'directory symlinks are indexed without traversing their contents');
  const outside = temporaryDirectory('offline-vfs-outside-');
  fs.writeFileSync(path.join(outside, 'Outside.png'), 'outside');
  fs.symlinkSync(path.join(outside, 'Outside.png'), path.join(root, 'Img', 'Characters', 'Outside.png'));
  assert.equal(offlineFilesystem(root, new Map()).assets.sourcePath('img/characters/outside.png'), null);

  fs.writeFileSync(path.join(root, 'Img', 'Characters', 'hero.PNG'), 'hero');
  assert.equal(offlineFilesystem(root, new Map()).assets.sourcePath('img/characters/HERO.png'),
    path.join(root, 'Img', 'Characters', 'Hero.png'));
  fs.writeFileSync(path.join(root, 'Img', 'Characters', 'hero.PNG'), 'collision');
  assert.throws(() => offlineFilesystem(root, new Map()), /case-insensitive path collision/);
});

test('identical aliases compare complete files and never merge directories', () => {
  const root = temporaryDirectory('offline-aliases-');
  const contents = Buffer.alloc(32769, 73);
  fs.writeFileSync(path.join(root, 'Alias.png'), contents);
  fs.writeFileSync(path.join(root, 'alias.png'), contents);
  assert.equal(offlineFilesystem(root, new Map()).assets.sourcePath('ALIAS.PNG'), path.join(root, 'Alias.png'));
  contents[32768] ^= 1;
  fs.writeFileSync(path.join(root, 'alias.png'), contents);
  assert.throws(() => offlineFilesystem(root, new Map()), /case-insensitive path collision/);
  fs.unlinkSync(path.join(root, 'alias.png'));
  fs.mkdirSync(path.join(root, 'Folder')); fs.mkdirSync(path.join(root, 'folder'));
  assert.throws(() => offlineFilesystem(root, new Map()), /case-insensitive path collision/);
});

test('offline VFS ignores special filesystem entries', { skip: process.platform !== 'linux' }, () => {
  const root = temporaryDirectory('offline-vfs-special-');
  execFileSync('mkfifo', [path.join(root, 'blocked.pipe')]);
  const offline = offlineFilesystem(root, new Map());
  assert.equal(offline.assets.sourcePath('blocked.pipe'), null);
  assert.deepEqual(offline.fs.readDirectory('.'), []);
});

test('offline VFS normalizes derived paths and matches native file precedence and listings', () => {
  const root = temporaryDirectory('offline-vfs-derived-');
  const directory = path.join(root, 'Img', 'Pictures');
  fs.mkdirSync(directory, { recursive: true });
  const original = path.join(directory, 'Hero.png');
  fs.writeFileSync(original, 'original');
  const cache = temporaryDirectory('offline-vfs-derived-cache-');
  const originalOverride = path.join(cache, 'hero-derived.png');
  const generated = path.join(cache, 'generated.png');
  fs.writeFileSync(originalOverride, 'derived');
  fs.writeFileSync(generated, 'generated');

  const offline = offlineFilesystem(root, new Map([
    ['IMG/Pictures/HERO.PNG', originalOverride]
  ]));
  offline.assets.addDerived('IMG/Pictures/Generated.PNG', generated);
  assert.equal(offline.assets.sourcePath('img/pictures/hero.png'), original,
    'an original file takes precedence over a derived file');
  assert.equal(offline.assets.sourcePath('img/pictures/generated.png'), generated,
    'mixed-case derived keys normalize on insertion and lookup');
  assert.deepEqual(offline.fs.readDirectory('img/pictures'), ['Generated.PNG', 'HERO.PNG']);
});

test('asset index artifact extraction understands schema 3 calculated image outputs', () => {
  const hash = 'a'.repeat(64);
  assert.deepEqual(assetIndexArtifacts({ schema: 3, kind: 'pmjs-asset-index', images: [
    { source: 'img/a.png', calculated: { outputs: [{ path: 'assets/images/a/page.png', hash }] } }
  ], maps: { entries: [{ outputs: [{ path: 'assets/maps/b/page.png', hash }] }] } }), [
    { path: 'assets/images/a/page.png', hash }, { path: 'assets/maps/b/page.png', hash }
  ]);
});

test('asset index artifact extraction retains schema 1 and 2 support', () => {
  const hash = 'b'.repeat(64);
  for (const schema of [1, 2]) {
    assert.deepEqual(assetIndexArtifacts({ schema, kind: 'pmjs-asset-index',
      images: [{ outputs: [{ path: `assets/schema-${schema}.png`, hash }] }],
      maps: { entries: [] } }), [{ path: `assets/schema-${schema}.png`, hash }]);
  }
});


test('portable settings survive incompatible calculated image data', () => {
  const f = fixture();
  f.index.schema = 3;
  const settings = { recipe: { grid: [3,4] }, lossless: true, astc: { enabled: false } };
  f.index.images = [{ source: 'img/pictures/a.png', settings, calculated: { sourceHash: 'old', outputs: [] } }];
  assert.deepEqual(f.load().policies['img/pictures/a.png'], settings);
  assert.equal(f.load().images[0].sourceHash, 'old');
  f.options.assetPreparation.recipes = [{ source: 'img/pictures/other.png', grid: [1,1] }];
  assert.equal(f.load().images.length, 1, 'unrelated settings do not invalidate all calculated records');
  f.native.assets.preparationVersion = { processor: 2 };
  const loaded = f.load();
  assert.deepEqual(loaded.images, []);
  assert.deepEqual(loaded.policies['img/pictures/a.png'], settings);
});

test('game preparation supplies the same metadata to offline indexing and live reads', () => {
  const { prepareGameFiles } = require('../runner/game-preparation.cjs');
  const root = temporaryDirectory('prepared-index-metadata-');
  const gameRoot = path.join(root, 'game'), cacheRoot = path.join(root, 'cache');
  fs.mkdirSync(path.join(gameRoot, 'data'), { recursive: true });
  fs.mkdirSync(path.join(gameRoot, 'img'));
  fs.mkdirSync(path.join(gameRoot, 'js'));
  fs.mkdirSync(path.join(gameRoot, 'maps'));
  const key = 'a'.repeat(32), iv = Buffer.alloc(16, 9);
  fs.writeFileSync(path.join(gameRoot, 'js/main.js'), `const key = '${key}';`);
  const contents = Buffer.from('{"hasEncryptedImages":true}');
  const encrypt = bytes => {
    const cipher = crypto.createCipheriv('aes-256-ctr', key, iv);
    return Buffer.concat([iv, cipher.update(bytes), cipher.final()]);
  };
  const original = encrypt(contents);
  const malformed = '{"name":"embedded\nnewline"}';
  fs.writeFileSync(path.join(gameRoot, 'maps/Bad.AUBREY'), encrypt(Buffer.from(malformed)));
  fs.writeFileSync(path.join(gameRoot, 'data/System.KEL'), original);
  fs.writeFileSync(path.join(gameRoot, 'data/Map001.KEL'), '{"tilesetId":1}');
  fs.writeFileSync(path.join(gameRoot, 'img/original.rpgmvp'), 'original media');
  const options = { gameRoot, gamePreparation: 'patches/omori/oneloader.cjs', assetPreparation: { cacheRoot } };
  for (const phase of ['prepareAssetIndex', 'prepare']) {
    const offline = offlineFilesystem(gameRoot, new Map());
    const native = { runtime: {}, ...offline };
    const roots = prepareGameFiles(options, native, phase);
    assert.equal(roots.length, 1);
    assert.equal(native.fs.readBytes('data/System.json').toString(), contents.toString());
    assert.deepEqual(native.fs.readBytes('data/System.KEL'), original);
    assert.equal(native.runtime.gameFiles.resolve('data/System.KEL'), 'data/System.json');
    assert.equal(native.fs.readBytes('img/original.rpgmvp').toString(), 'original media');
    assert.equal(native.fs.readBytes('maps/Bad.json').toString(), malformed);
    assert.throws(() => JSON.parse(native.fs.readBytes('maps/Bad.json')), SyntaxError);
    assert.ok(native.fs.readDirectory('data').includes('Map001.json'));
    assert.ok(native.assets.sourcePath('data/System.json').startsWith(roots[0] + path.sep));
    assert.deepEqual(fs.readFileSync(path.join(gameRoot, 'data/System.KEL')), original);
  }
});

test('offline overlays preserve spelling, merge new directories and leave source files intact', () => {
  const root = temporaryDirectory('offline-overlay-');
  const game = path.join(root, 'game'), overlay = path.join(root, 'overlay');
  fs.mkdirSync(game);
  fs.mkdirSync(path.join(overlay, 'New'), { recursive: true });
  fs.writeFileSync(path.join(game, 'Existing.json'), 'original');
  fs.writeFileSync(path.join(overlay, 'Existing.json'), 'prepared');
  fs.writeFileSync(path.join(overlay, 'New/Map001.json'), 'map');
  const offline = offlineFilesystem(game, new Map());
  offline.fs.mountReadOnlyOverlay(overlay);
  assert.equal(offline.fs.readBytes('existing.JSON').toString(), 'prepared');
  assert.deepEqual(offline.fs.readDirectory('.'), ['Existing.json', 'New']);
  assert.deepEqual(offline.fs.readDirectory('new'), ['Map001.json']);
  assert.equal(offline.fs.readBytes('new/map001.JSON').toString(), 'map');
  assert.equal(fs.readFileSync(path.join(game, 'Existing.json'), 'utf8'), 'original');
  const replacement = path.join(root, 'replacement'); fs.mkdirSync(replacement);
  fs.writeFileSync(path.join(replacement, 'Second.json'), 'second');
  offline.fs.mountReadOnlyOverlay(replacement);
  assert.deepEqual(offline.fs.readDirectory('.'), ['Existing.json', 'Second.json']);
  assert.equal(offline.fs.isDirectory('New'), false);
  assert.equal(offline.fs.readBytes('Existing.json').toString(), 'original');
});
