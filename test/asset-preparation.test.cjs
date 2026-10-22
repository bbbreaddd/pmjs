'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { prepareAssets, validDescriptor, automaticRecipe } = require('../runner/asset-preparation.cjs');
const { acquireLock } = require('../runner/preparation-lifetime.cjs');
const { validate } = require('../runner/index.cjs');
const { parse } = require('../runner/cli.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { preparationLocks } = require('./helpers/preparation-lock.cjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');


function fixture() {
  const root = temporaryDirectory('pmjs-preparation-');
  const gameRoot = path.join(root, 'game');
  fs.mkdirSync(path.join(gameRoot, 'img/pictures'), { recursive: true });
  const source = 'img/pictures/a.png';
  fs.writeFileSync(path.join(gameRoot, source), PNG);
  let jobs = 0;
  let installs = [];
  const processImage = async (name, output) => {
    jobs += 1;
    fs.writeFileSync(path.join(output, 'page-0.png'), PNG);
    return { version: 1, width: 1, height: 1, pages: [{ path: 'page-0.png', width: 1, height: 1 }],
      cells: [{ rect: [0, 0, 1, 1], crop: [0, 0, 1, 1], fill: [0, 0, 0, 0], page: 0, atlas: [0, 0, 1, 1] }] };
  };
  const native = { assets: { ...preparationLocks(), processImage, installPrepared(entries) { installs.push(entries); } } };
  const warnings = [];
  return { root, gameRoot, source, native, pageCodec: 'png', cacheRoot: path.join(root, 'cache'),
    logger: { warn(message) { warnings.push(message); } }, warnings,
    get jobs() { return jobs; }, get installs() { return installs; } };
}
function cachePath(f) {
  return path.join(f.cacheRoot, 'preparation-v1', crypto.createHash('sha256').update(JSON.stringify(path.resolve(f.gameRoot))).digest('hex').slice(0,16));
}
function stateFile(f) { return path.join(cachePath(f), 'preparation-state.json'); }
function manifests(f) {
  if (!fs.existsSync(stateFile(f))) return [];
  return Object.keys(JSON.parse(fs.readFileSync(stateFile(f))).data.results)
    .filter(name => name.startsWith('entries/')).map(name => path.join(cachePath(f), name, 'manifest.json'));
}
function readManifest(f, file) {
  return JSON.parse(fs.readFileSync(stateFile(f))).data.results[path.relative(cachePath(f), path.dirname(file)).split(path.sep).join('/')];
}
function writeManifest(f, file, value) {
  const state = JSON.parse(fs.readFileSync(stateFile(f)));
  state.data.results[path.relative(cachePath(f), path.dirname(file)).split(path.sep).join('/')] = value;
  state.checksum = crypto.createHash('sha256').update(JSON.stringify(state.data)).digest('hex');
  fs.writeFileSync(stateFile(f), JSON.stringify(state));
}

function assertProgress(progress, result, terminalPhase) {
  progress = progress.filter(value => value.phase !== 'wait' || value.total !== 0);
  assert.equal(progress[0].phase, 'discover');
  assert.equal(progress[0].completed, 0);
  assert.equal(progress[0].sourceBytes, 0);
  assert.deepEqual(progress.filter(p => p.terminal).map(p => p.phase), [terminalPhase]);
  const terminal = progress.at(-1);
  assert.equal(terminal.phase, terminalPhase);
  assert.equal(terminal.source, '');
  for (const field of ['completed', 'total', 'generated', 'hits', 'fallback', 'sourceBytes']) {
    assert.equal(terminal[field], result[field], field);
  }
  for (let i = 0; i < progress.length; ++i) {
    const value = progress[i];
    assert.equal(value.remaining, value.total - value.completed);
    assert.ok(Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0);
    if (i) assert.ok(value.elapsedMs >= progress[i - 1].elapsedMs);
  }
}

test('first preparation installs logical backing; unchanged launch reuses verified content without transforms', async () => {
  const f = fixture();
  const processImage = f.native.assets.processImage;
  f.native.assets.preparationWorkspaceVersion = 1;
  f.native.assets.processImage = async (...args) => {
    assert.deepEqual(args[5], { workspaceBytes: 256 * 1024 * 1024, allowAstc: false, astcQuality: 'medium' });
    return processImage(...args);
  };
  const progress = [];
  const first = await prepareAssets({ ...f, onProgress: value => progress.push(value) });
  assert.equal(first.generated, 1);
  assert.equal(first.entries[0].source, f.source);
  assert.equal(first.entries[0].sourceHash, crypto.createHash('sha256').update(PNG).digest('hex'));
  assert.equal(first.completed, 1);
  assert.equal(first.cacheBytes, PNG.length);
  assert.ok(progress.some(p => p.phase === 'prepare'));
  assertProgress(progress, first, 'complete');
  assert.ok(progress.some(p => p.phase === 'prepare' && p.source === f.source && p.remaining === 1 && p.generated === 0));
  assert.ok(progress.some(p => p.phase === 'prepare' && p.source === f.source && p.remaining === 0 && p.generated === 1));
  assert.ok(progress.some(p => p.phase === 'install' && p.completed === 1));
  assert.ok(progress.some(p => p.phase === 'cleanup' && p.completed === 1));
  const warmProgress = [];
  const second = await prepareAssets({ ...f, onProgress: value => warmProgress.push(value) });
  assert.equal(second.generated, 0);
  assert.equal(second.hits, 1);
  assert.equal(f.jobs, 1);
  assert.equal(f.installs.length, 2);
  assertProgress(warmProgress, second, 'complete');
  assert.equal(warmProgress.some(p => p.phase === 'prepare'), false);
  assert.ok(warmProgress.some(p => p.phase === 'validate' && p.source === f.source && p.completed === 1 && p.hits === 1));
});

test('workspace limits reach capable processors without invalidating cached output', async () => {
  const f = fixture(), original = f.native.assets.processImage;
  f.native.assets.preparationWorkspaceVersion = 1;
  f.native.assets.processImage = async (...args) => {
    assert.equal(args[4], null);
    assert.deepEqual(args[5], { workspaceBytes: 0, allowAstc: false, astcQuality: 'medium' });
    return original(...args);
  };
  const cold = await prepareAssets({ ...f, workspaceBytes: 0 });
  assert.equal(cold.generated, 1);
  const warm = await prepareAssets({ ...f, workspaceBytes: 128 * 1024 * 1024 });
  assert.equal(warm.generated, 0);
  assert.equal(warm.hits, 1);
  for (const workspaceBytes of [-1, 1.5, 268435457, NaN, '64'])
    await assert.rejects(prepareAssets({ ...f, workspaceBytes }), /workspaceBytes must be an integer/);
});

test('workspace-constrained cache entries are reconsidered after the budget increases', async () => {
  const f = fixture(), original = f.native.assets.processImage;
  f.native.assets.preparationWorkspaceVersion = 1;
  f.native.assets.processImage = async (...args) => {
    const descriptor = await original(...args);
    return { ...descriptor, workspaceConstrained: args[5].workspaceBytes === 0 };
  };
  assert.equal((await prepareAssets({ ...f, workspaceBytes: 0 })).generated, 1);
  const improved = await prepareAssets({ ...f, workspaceBytes: 128 * 1024 * 1024 });
  assert.equal(improved.generated, 1);
  assert.equal(f.jobs, 2);
  assert.equal((await prepareAssets({ ...f, workspaceBytes: 128 * 1024 * 1024 })).generated, 0);
  assert.equal(f.jobs, 2);
});

test('a failed workspace upgrade keeps and installs the prior validated output', async () => {
  const f = fixture(), processImage = f.native.assets.processImage;
  f.native.assets.preparationWorkspaceVersion = 1;
  f.native.assets.processImage = async (...args) => ({ ...await processImage(...args), workspaceConstrained: args[5].workspaceBytes === 0 });
  const first = await prepareAssets({ ...f, workspaceBytes: 0 });
  const previousDirectory = first.entries[0].directory;
  f.native.assets.processImage = async () => { throw new Error('simulated allocation failure'); };
  const upgrade = await prepareAssets({ ...f, workspaceBytes: 128 * 1024 * 1024 });
  assert.equal(upgrade.failedFiles, 0);
  assert.equal(upgrade.generated, 0);
  assert.equal(upgrade.installed, 1);
  assert.equal(upgrade.entries[0].directory, previousDirectory);
  assert.ok(fs.existsSync(path.join(previousDirectory, 'page-0.png')));
});

test('workspace-limited negative decisions are reconsidered when the budget increases', async () => {
  const f = fixture(), processImage = f.native.assets.processImage;
  f.native.assets.preparationWorkspaceVersion = 1;
  f.native.assets.processImage = async (...args) => args[5].workspaceBytes === 0
    ? { resultVersion: 1, descriptor: null, workspaceConstrained: true }
    : processImage(...args);
  const constrained = await prepareAssets({ ...f, workspaceBytes: 0 });
  assert.equal(constrained.fallback, 1);
  assert.equal(constrained.generated, 1);
  const improved = await prepareAssets({ ...f, workspaceBytes: 128 * 1024 * 1024 });
  assert.equal(improved.installed, 1);
  assert.equal(improved.generated, 1);
  assert.equal(f.jobs, 1);
});

test('portable constrained layouts generated with a larger budget remain reusable on smaller devices', async () => {
  const f = fixture(), original = f.native.assets.processImage, layouts = [];
  f.native.assets.preparationWorkspaceVersion = 1;
  f.native.assets.processImage = async (...args) => { layouts.push(args[4]); return original(...args); };
  const stage = path.join(f.root, 'portable-stage'); fs.mkdirSync(stage);
  const descriptor = await original(f.source, stage);
  descriptor.workspaceConstrained = true;
  const portableIndex = { images: [{ source: f.source,
    sourceHash: crypto.createHash('sha256').update(PNG).digest('hex'), recipe: null,
    encryptionSettingsSha256: null, descriptor, outputs: [],
    resolvedSettings: { allowAstc: false, astcQuality: null, pageCodec: 'png', workspaceBytes: 0 } }] };
  await prepareAssets({ ...f, workspaceBytes: 0, portableIndex });
  assert.equal(layouts[0], descriptor);
});

test('uppercase image directories remain eligible and receive automatic character recipes', async () => {
  const f = fixture();
  fs.rmSync(path.join(f.gameRoot, 'img'), { recursive: true });
  f.source = 'IMG/Characters/$actor.png';
  fs.mkdirSync(path.dirname(path.join(f.gameRoot, f.source)), { recursive: true });
  fs.writeFileSync(path.join(f.gameRoot, f.source), PNG);
  const header = Buffer.alloc(24); header.set(Buffer.from([137,80,78,71,13,10,26,10]));
  header.writeUInt32BE(3, 16); header.writeUInt32BE(4, 20);
  assert.deepEqual((await automaticRecipe(null, f.source, '0'.repeat(64), header)).grid, [3, 4]);
  const result = await prepareAssets(f);
  assert.equal(result.total, 1);
  assert.equal(result.installed, 1);
});

test('explicit runtime policies override portable defaults and change the effective cache key', async () => {
  const f = fixture(), observed = [], original = f.native.assets.processImage;
  f.native.assets.preparationWorkspaceVersion = 1;
  f.native.assets.processImage = async (...args) => { observed.push({ recipe: args[2], options: args[5] }); return original(...args); };
  const packaged = { policies: { [f.source]: { recipe: { grid: [1, 1], backdrop: [0, 0, 0, 0] }, astc: { enabled: true }, lossless: true } }, images: [] };
  await prepareAssets({ ...f, astc: { enabled: false }, losslessPrefixes: [],
    recipes: [{ source: f.source, sourceHash: crypto.createHash('sha256').update(PNG).digest('hex'),
      grid: [1, 1], backdrop: [1, 0, 0, 255] }], portableIndex: packaged });
  assert.deepEqual(observed[0].recipe.grid, [1, 1]);
  assert.deepEqual(observed[0].recipe.backdrop, [1, 0, 0, 255]);
  assert.equal(observed[0].options.allowAstc, false);
  await prepareAssets({ ...f, astc: { enabled: true }, losslessPrefixes: [], recipes: [], portableIndex: packaged });
  assert.equal(observed.length, 2, 'changed effective settings regenerate the prepared result');
  assert.equal(observed[1].options.allowAstc, true);
  assert.deepEqual(observed[1].recipe.grid, [1, 1], 'an omitted per-asset runtime recipe leaves the packaged recipe as its default');
});

test('default LZ4 replaces PNG preparation, reuses warm pages and permits explicit PNG selection', async () => {
  const f = fixture(), original = f.native.assets.processImage;
  const { pageCodec, ...defaults } = f;
  f.native.assets.installPreparedCatalog = entries => entries.length;
  f.native.assets.installDerivedCatalog = () => {};
  const png = await prepareAssets(f);
  const pngFile = manifests(f)[0];
  const pngKey = readManifest(f, pngFile).key;
  assert.equal(png.generated, 1);
  const unavailable = await prepareAssets(defaults);
  assert.equal(unavailable.installed, 0);
  assert.match(f.warnings.at(-1), /LZ4 image preparation is unavailable/);
  f.native.assets.preparationWorkspaceVersion = 1;
  f.native.assets.preparationLz4Version = 'lz4-test-v1';
  f.native.assets.processImage = async (...args) => {
    assert.equal(args[5].pageCodec, 'lz4');
    const descriptor = await original(...args);
    descriptor.pages[0].path = 'page-0.pml4';
    const header = Buffer.alloc(32);
    header.write('PML4'); header.writeUInt32LE(1, 4); header.writeUInt32LE(1, 8); header.writeUInt32LE(1, 12);
    header.writeUInt32LE(4, 16); header.writeUInt32LE(5, 20);
    fs.writeFileSync(path.join(args[1], 'page-0.pml4'), Buffer.concat([header, Buffer.from([0x40,255,0,0,255])]));
    fs.unlinkSync(path.join(args[1], 'page-0.png'));
    return descriptor;
  };
  const cold = await prepareAssets(defaults);
  assert.equal(cold.generated, 1);
  assert.equal(cold.entries[0].descriptor.pages[0].path, 'page-0.pml4');
  const lz4File = manifests(f).find(file => readManifest(f, file).descriptor.pages[0].path.endsWith('.pml4'));
  assert.notEqual(readManifest(f, lz4File).key, pngKey);
  const manifest = readManifest(f, lz4File);
  const portablePath = 'assets/images/' + manifest.key + '/page-0.pml4';
  const portableAssetRoot = path.join(f.root, 'portable');
  fs.mkdirSync(path.dirname(path.join(portableAssetRoot, portablePath)), { recursive: true });
  fs.copyFileSync(path.join(path.dirname(lz4File), 'page-0.pml4'), path.join(portableAssetRoot, portablePath));
  const portableIndex = { images: [{ source: f.source, sourceHash: manifest.sourceHash, recipe: null,
    encryptionSettingsSha256: null, descriptor: manifest.descriptor,
    outputs: [{ path: portablePath, hash: manifest.outputs['page-0.pml4'] }] }] };
  const processImage = f.native.assets.processImage;
  f.native.assets.processImage = () => { throw new Error('portable copy should bypass compression'); };
  const copied = await prepareAssets({ ...f, pageCodec: 'lz4', cacheRoot: path.join(f.root, 'copied'), portableIndex, portableAssetRoot });
  assert.equal(copied.indexedPageCopies, 1);
  assert.equal(copied.installed, 1);
  f.native.assets.processImage = processImage;
  const warm = await prepareAssets({ ...defaults, workspaceBytes: 0 });
  assert.equal(warm.generated, 0);
  assert.equal(warm.hits, 1);
  assert.equal(warm.validation.hashedFiles, 0);
  fs.writeFileSync(path.join(path.dirname(lz4File), 'page-0.pml4'), 'damaged');
  const repaired = await prepareAssets({ ...f, pageCodec: 'lz4', verifyHashes: true });
  assert.equal(repaired.generated, 1);
  f.native.assets.preparationLz4Version = 'lz4-test-v2';
  const upgraded = await prepareAssets({ ...f, pageCodec: 'lz4' });
  assert.equal(upgraded.generated, 1);
  f.native.assets.processImage = original;
  const explicitPng = await prepareAssets({ ...defaults, pageCodec: 'png' });
  assert.equal(explicitPng.installed, 1);
  assert.equal(explicitPng.entries[0].descriptor.pages[0].path, 'page-0.png');
  await assert.rejects(prepareAssets({ ...f, pageCodec: 'lz4hc3' }), /pageCodec must be png or lz4/);
});

test('PML4 v3 indexed pages validate and reuse from cache', async () => {
  const f = fixture();
  f.native.assets.preparationWorkspaceVersion = 1;
  f.native.assets.preparationLz4Version = 'lz4-test-v3';
  f.native.assets.processImage = async (name, output) => {
    fs.writeFileSync(path.join(output, 'page-0.pml4'), Buffer.concat([
      Buffer.from([0x50, 0x4d, 0x4c, 0x34]), (() => {
        const header = Buffer.alloc(28);
        header.writeUInt32LE(3, 0); header.writeUInt32LE(64, 4); header.writeUInt32LE(64, 8);
        header.writeUInt32LE(4 + 4 + 64 * 64, 12); header.writeUInt32LE(1, 16);
        return header;
      })(), Buffer.from([0])
    ]));
    return { version: 1, width: 1, height: 1, pages: [{ path: 'page-0.pml4', width: 64, height: 64 }],
      cells: [{ rect: [0, 0, 1, 1], crop: [0, 0, 1, 1], fill: [0, 0, 0, 0], page: 0, atlas: [0, 0, 1, 1] }] };
  };
  const cold = await prepareAssets({ ...f, pageCodec: 'lz4' });
  assert.equal(cold.generated, 1);
  const warm = await prepareAssets({ ...f, pageCodec: 'lz4' });
  assert.equal(warm.generated, 0);
  assert.equal(warm.hits, 1);
});

test('portable page metadata never mutates a verified manifest during a checkpoint', async () => {
  const f = fixture();
  let result = await prepareAssets(f);
  result.releaseCacheLease?.();
  const descriptor = structuredClone(result.entries[0].descriptor);
  descriptor.pages[0].storage = { version: 1, width: 1, height: 1, channels: 4,
    paletteBits: 0, source: [0, 1, 2, 3], swizzle: [0, 1, 2, 3] };
  const sourceHash = crypto.createHash('sha256').update(PNG).digest('hex');
  f.portableIndex = { images: [{ source: f.source, sourceHash, recipe: null,
    encryptionSettingsSha256: null, descriptor, outputs: [{
      path: 'assets/images/' + 'a'.repeat(64) + '/page-0.png', hash: sourceHash
    }] }] };
  fs.writeFileSync(path.join(f.gameRoot, 'img/pictures/b.png'), PNG);
  result = await prepareAssets(f);
  result.releaseCacheLease?.();
  assert.equal(result.generated, 1, 'the added image forces a durable checkpoint');
  result = await prepareAssets(f);
  result.releaseCacheLease?.();
  assert.equal(result.generated, 0);
  assert.equal(result.hits, 2);
  assert.equal(f.jobs, 2);
});

test('unchanged sources and pages reuse checksums; explicit verification reads them again', async () => {
  const f = fixture();
  await prepareAssets(f);
  const warm = await prepareAssets(f);
  assert.equal(warm.generated, 0);
  assert.equal(warm.validation.hashedFiles, 0);
  assert.ok(warm.validation.reusedFiles >= 2);
  const verified = await prepareAssets({ ...f, verifyHashes: true });
  assert.equal(verified.generated, 0);
  assert.equal(verified.validation.hashedFiles, 2);
  assert.equal(verified.validation.reusedFiles, 0);
});


test('same-size source and page edits with restored mtime invalidate verified checksums', async () => {
  const f = fixture();
  await prepareAssets(f);
  for (const source of [true, false]) {
    const file = source ? path.join(f.gameRoot, f.source) :
      path.join(path.dirname(manifests(f)[0]), 'page-0.png');
    const before = fs.statSync(file);
    const bytes = fs.readFileSync(file);
    bytes[bytes.length - 1] ^= 1;
    fs.writeFileSync(file, bytes);
    fs.utimesSync(file, before.atime, before.mtime);
    const changed = await prepareAssets(f);
    assert.equal(changed.generated, 1);
    assert.ok(changed.validation.hashedFiles > 0);
  }
  assert.equal((await prepareAssets(f)).generated, 0);
});



test('full verification detects edits hidden by unchanged metadata', async t => {
  const f = fixture();
  await prepareAssets(f);
  const file = path.join(f.gameRoot, f.source);
  const before = fs.statSync(file, { bigint: true });
  const bytes = fs.readFileSync(file);
  bytes[bytes.length - 1] ^= 1;
  fs.writeFileSync(file, bytes);
  const lstat = fs.promises.lstat, stat = fs.promises.stat;
  fs.promises.lstat = async (target, options) => target === file ? before : lstat(target, options);
  fs.promises.stat = async (target, options) => target === file ? before : stat(target, options);
  t.after(() => { fs.promises.lstat = lstat; fs.promises.stat = stat; });
  const verified = await prepareAssets({ ...f, verifyHashes: true });
  assert.equal(verified.generated, 1);
  assert.ok(verified.validation.hashedFiles >= 2);
});

test('empty discovery reports install and successful completion without transformation', async () => {
  const f = fixture();
  fs.unlinkSync(path.join(f.gameRoot, f.source));
  const progress = [];
  const result = await prepareAssets({ ...f, onProgress: value => progress.push(value) });
  assertProgress(progress, result, 'complete');
  assert.equal(result.total, 0);
  assert.equal(f.jobs, 0);
  assert.deepEqual(f.installs, [[]]);
  assert.ok(progress.some(p => p.phase === 'install'));
});

test('addon and install errors report a terminal failure after discovery or validation', async () => {
  for (const failInstall of [false, true]) {
    const f = fixture();
    if (failInstall) f.native.assets.installPrepared = () => { throw new Error('install failed'); };
    else delete f.native.assets.processImage;
    const progress = [];
    const result = await prepareAssets({ ...f, onProgress: value => progress.push(value) });
    assertProgress(progress, result, 'error');
    assert.match(result.error, /image preparation is unavailable|install failed/);
    assert.equal(result.completed, failInstall ? 1 : 0);
    assert.equal(f.jobs, failInstall ? 1 : 0);
    assert.equal(result.installed, 0);
  }
});



test('cache pages under img are excluded while original cache-root siblings remain sources', async () => {
  const f = fixture();
  f.cacheRoot = path.join(f.gameRoot, 'img/.asset-cache');
  fs.mkdirSync(f.cacheRoot);
  fs.writeFileSync(path.join(f.cacheRoot, 'original.png'), PNG);
  const first = await prepareAssets(f);
  assert.equal(first.total, 2);
  assert.equal(first.generated, 2);
  const second = await prepareAssets(f);
  assert.equal(second.total, 2);
  assert.equal(second.generated, 0);
  assert.equal(second.hits, 2);
  assert.equal(f.jobs, 2);
});

test('asset directories are discovered regardless of their suffix', async () => {
  const f = fixture();
  const directory = path.join(f.gameRoot, 'img/pictures/story-port');
  fs.mkdirSync(directory);
  fs.renameSync(path.join(f.gameRoot, f.source), path.join(directory, 'portrait.png'));
  const first = await prepareAssets(f);
  assert.equal(first.total, 1);
  assert.equal(first.entries[0].source, 'img/pictures/story-port/portrait.png');
  const second = await prepareAssets(f);
  assert.equal(second.hits, 1);
  assert.equal(f.jobs, 1);
});

test('an img cache root scans originals and excludes owned entries through a game-root alias', async () => {
  const f = fixture();
  f.cacheRoot = path.join(f.gameRoot, 'img');
  const alias = path.join(f.root, 'game-alias');
  fs.symlinkSync(f.gameRoot, alias, 'dir');
  const first = await prepareAssets({ ...f, gameRoot: alias });
  assert.equal(first.total, 1);
  assert.equal(first.generated, 1);
  const second = await prepareAssets({ ...f, gameRoot: alias });
  assert.equal(second.total, 1);
  assert.equal(second.generated, 0);
  assert.equal(second.hits, 1);
  assert.equal(f.jobs, 1);
});

test('source and processor identities invalidate individual entries and remove superseded output', async () => {
  const f = fixture();
  await prepareAssets(f);
  const old = path.dirname(manifests(f)[0]);
  fs.appendFileSync(path.join(f.gameRoot, f.source), 'new source bytes');
  assert.equal((await prepareAssets(f)).generated, 1);
  assert.equal(fs.existsSync(old), false);
  assert.equal((await prepareAssets({ ...f, processorIdentity: { processor: 'next' } })).generated, 1);
  assert.equal(f.jobs, 3);
  assert.equal(manifests(f).length, 1);
});

test('recipe changes regenerate and source checksums do not override explicit settings', async () => {
  const f = fixture();
  const sourceHash = crypto.createHash('sha256').update(PNG).digest('hex');
  const recipe = { source: f.source, sourceHash, grid: [1, 1] };
  await prepareAssets({ ...f, recipes: [recipe] });
  assert.equal((await prepareAssets({ ...f, recipes: [{ ...recipe, backdrop: [0, 0, 0, 0] }] })).generated, 1);
  const result = await prepareAssets({ ...f, recipes: [{ ...recipe, sourceHash: '0'.repeat(64) }] });
  assert.equal(result.fallback, 0);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].sourceHash, sourceHash);
  assert.equal(f.jobs, 3);
});

test('corrupt PNG outputs and descriptor edits are regenerated independently', async () => {
  const f = fixture();
  await prepareAssets(f);
  let file = manifests(f)[0];
  fs.appendFileSync(path.join(path.dirname(file), 'page-0.png'), 'corruption');
  assert.equal((await prepareAssets(f)).generated, 1);
  file = manifests(f)[0];
  const manifest = readManifest(f, file);
  manifest.descriptor.cells[0].fill = [255, 0, 0, 255];
  writeManifest(f, file, manifest);
  assert.equal((await prepareAssets(f)).generated, 1);
  assert.equal(f.jobs, 3);
});

test('unsupported images reuse a negative entry; transient failures retry next launch', async () => {
  const f = fixture();
  let calls = 0;
  f.native.assets.processImage = async () => { calls += 1; return null; };
  assert.equal((await prepareAssets(f)).fallback, 1);
  assert.equal((await prepareAssets(f)).negativeHits, 1);
  assert.equal(calls, 1);
  fs.appendFileSync(path.join(f.gameRoot, f.source), 'changed');
  f.native.assets.processImage = async () => { calls += 1; throw new Error('decode failed'); };
  assert.equal((await prepareAssets(f)).fallback, 1);
  assert.equal((await prepareAssets(f)).fallback, 1);
  assert.equal(calls, 3);
});

test('portable negative image decisions skip processing without reading pages', async () => {
  const f = fixture();
  const sourceHash = crypto.createHash('sha256').update(PNG).digest('hex');
  const options = { ...f, portableAssetRoot: f.root,
    portableIndex: { images: [{ source: f.source, sourceHash, recipe: null,
      encryptionSettingsSha256: null, descriptor: null, outputs: [] }] } };
  const result = await prepareAssets(options);
  assert.equal(result.fallback, 1);
  assert.equal(result.indexedNegative, 1);
  assert.equal(result.unindexedProcessed, 0);
  assert.equal(result.generated, 1, 'the ordinary decision is recorded in local state');
  assert.equal(manifests(f).length, 1);
  assert.equal(f.jobs, 0);
  assert.deepEqual(f.warnings, []);
  fs.appendFileSync(path.join(f.gameRoot, f.source), 'changed');
  const changed = await prepareAssets(options);
  assert.equal(changed.indexedNegative, 0);
  assert.equal(changed.generated, 1);
  assert.equal(f.jobs, 1);
});


test('progress callback throws during indexed-negative handling without duplicate completion or fallback', async () => {
  const f = fixture();
  const sourceHash = crypto.createHash('sha256').update(PNG).digest('hex');
  let thrown = false;
  const options = { ...f,
    portableIndex: { images: [{ source: f.source, sourceHash, recipe: null,
      encryptionSettingsSha256: null, descriptor: null, outputs: [] }] },
    onProgress(value) {
      if (value.source === f.source && value.completed === 1 && !thrown) {
        thrown = true;
        throw new Error('progress failed');
      }
    }
  };
  const result = await prepareAssets(options);
  assert.equal(result.completed, 1);
  assert.equal(result.fallback, 1);
  assert.ok(!f.warnings.some(w => w.includes('asset preparation fallback')));
  assert.ok(f.warnings.some(w => w.includes('asset preparation unavailable: progress failed')));
});

test('valid local calculated results remain reusable when a supplied ordinary decision differs', async () => {
  const f = fixture();
  const sourceHash = crypto.createHash('sha256').update(PNG).digest('hex');
  const cold = await prepareAssets(f);
  assert.equal(cold.generated, 1);
  assert.equal(cold.installed, 1);
  assert.equal(manifests(f).length, 1);

  const options = { ...f, portableAssetRoot: f.root,
    portableIndex: { images: [{ source: f.source, sourceHash, recipe: null,
      encryptionSettingsSha256: null, descriptor: null, outputs: [] }] } };
  const transition = await prepareAssets(options);
  assert.equal(transition.fallback, 0);
  assert.equal(transition.indexedNegative, 0);
  assert.equal(transition.installed, 1);
  assert.equal(transition.generated, 0);
  assert.equal(f.jobs, 1);
  assert.equal(manifests(f).length, 1);
});

test('concurrent preparers serialize and reuse completed output', async () => {
  const f = fixture();
  const original = f.native.assets.processImage;
  let releaseProcessing;
  const processing = new Promise(resolve => { releaseProcessing = resolve; });
  f.native.assets.processImage = async (...args) => {
    await processing;
    return original(...args);
  };
  const progress = Array.from({ length: 12 }, () => []);
  const results = await Promise.all(progress.map(events => prepareAssets({ ...f, onProgress(value) {
    events.push(value);
    if (value.phase === 'wait') releaseProcessing();
  } })));
  assert.equal(results.reduce((sum, r) => sum + r.generated, 0), 1);
  assert.equal(results.reduce((sum, r) => sum + r.hits, 0), progress.length - 1);
  assert.equal(f.jobs, 1);
  assert.ok(progress.some(events => events.some(p => p.phase === 'wait')));
  progress.forEach((events, i) => assertProgress(events, results[i], 'complete'));
});

test('a native preparation owner cannot cause an unbounded wait or lose its lock', async () => {
  const f = fixture();
  const token = f.native.assets.tryAcquirePreparationLock(f.cacheRoot);
  assert.ok(token);
  try {
    let waits = 0;
    await assert.rejects(acquireLock(f.cacheRoot, () => false, () => { waits++; }, f.native.assets, 20),
      /preparation cache lock wait timed out/);
    assert.ok(waits > 0);
    assert.equal(f.native.assets.tryAcquirePreparationLock(f.cacheRoot), null);
    assert.equal(f.jobs, 0);
  } finally { f.native.assets.releasePreparationLock(token); }
});


test('cancellation waits for current processor, discards its output and prevents install', async () => {
  const f = fixture();
  let cancel = false;
  const original = f.native.assets.processImage;
  f.native.assets.processImage = async (...args) => { const result = await original(...args); cancel = true; return result; };
  const progress = [];
  const result = await prepareAssets({ ...f, shouldCancel: () => cancel, onProgress: value => progress.push(value) });
  assert.equal(result.cancelled, true);
  assert.equal(result.generated, 0);
  assertProgress(progress, result, 'cancelled');
  assert.equal(progress.at(-1).remaining, 1);
  assert.equal(progress.at(-1).completed, 0);
  assert.equal(f.installs.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(cachePath(f), 'entries')), []);
  f.native.assets.processImage = original;
  assert.equal((await prepareAssets(f)).generated, 1);
});

test('cancellation during final cleanup never reports assets ready', async () => {
  const f = fixture();
  let cancel = false;
  const progress = [];
  const result = await prepareAssets({ ...f, shouldCancel: () => cancel, onProgress(value) {
    progress.push(value);
    if (value.phase === 'cleanup') cancel = true;
  } });
  assert.equal(result.cancelled, true);
  assertProgress(progress, result, 'cancelled');
  assert.equal((await prepareAssets(f)).generated, 0, 'completed cache entries remain reusable after cancellation');
});

test('unwritable cache falls back; full verification rejects source changes during preparation', async () => {
  const f = fixture();
  fs.writeFileSync(f.cacheRoot, 'a file blocks the cache directory');
  const progress = [];
  const result = await prepareAssets({ ...f, onProgress: value => progress.push(value) });
  assert.equal(f.jobs, 0);
  assert.ok(f.warnings.some(s => s.includes('unavailable')));
  assertProgress(progress, result, 'error');
  assert.equal(progress.at(-1).remaining, 1);
  fs.unlinkSync(f.cacheRoot);
  const original = f.native.assets.processImage;
  f.native.assets.processImage = async (...args) => {
    const descriptor = await original(...args);
    fs.appendFileSync(path.join(f.gameRoot, f.source), 'changed during preparation');
    return descriptor;
  };
  assert.equal((await prepareAssets({ ...f, verifyHashes: true })).fallback, 1);
  assert.deepEqual(fs.readdirSync(path.join(cachePath(f), 'entries')), []);
});

test('invalid coverage and unsafe page paths never install or publish', async () => {
  const f = fixture();
  const original = f.native.assets.processImage;
  f.native.assets.processImage = async (...args) => { const d = await original(...args); d.width = 2; return d; };
  assert.equal((await prepareAssets(f)).fallback, 1);
  f.native.assets.processImage = async (...args) => { const d = await original(...args); d.pages[0].path = '../outside.png'; return d; };
  assert.equal((await prepareAssets(f)).fallback, 1);
  assert.equal(f.installs.at(-1).length, 0);
  assert.deepEqual(fs.readdirSync(path.join(cachePath(f), 'entries')), []);
});

test('runner resolves default cache, config-relative recipes and explicit CLI overrides', () => {
  const f = fixture();
  const cfg = path.join(f.root, 'config.json');
  const recipesFile = path.join(f.root, 'recipes.json');
  fs.writeFileSync(recipesFile, '[]');
  fs.writeFileSync(cfg, JSON.stringify({ assetPreparation: { enabled: false, cacheRoot: 'cache-near-config', recipes: 'recipes.json' } }));
  const base = { addon: 'a', bootstrap: 'b', gameRoot: f.gameRoot, saveRoot: path.join(f.root, 'save') };
  assert.equal(validate(base).assetPreparation.cacheRoot, path.join(f.root, 'save/asset-cache'));
  assert.equal(validate(base).assetPreparation.verifyHashes, false);
  assert.equal(validate({ ...base, assetPreparation: { verifyHashes: true } }).assetPreparation.verifyHashes, true);
  assert.throws(() => validate({ ...base, assetPreparation: { verifyHashes: 'yes' } }), /verifyHashes must be a boolean/);
  const configured = validate({ ...base, config: cfg });
  assert.equal(configured.assetPreparation.enabled, false);
  assert.equal(configured.assetPreparation.cacheRoot, path.join(f.root, 'cache-near-config'));
  const cli = parse(['--asset-preparation', 'on', '--asset-cache-root', f.cacheRoot, '--asset-recipes', recipesFile]);
  assert.equal(validate({ ...base, config: cfg, ...cli }).assetPreparation.enabled, true);
  assert.equal(validate({ ...base, config: cfg, ...cli }).assetPreparation.cacheRoot, f.cacheRoot);
  assert.throws(() => validate({ ...base, assetPreparation: 'maybe' }), /on or off/);
});

test('partial installation is counted separately from ordinary unprepared assets', async () => {
  const f = fixture();
  f.native.assets.installPrepared = () => 0;
  const partial = await prepareAssets(f);
  assert.equal(partial.prepared, 1);
  assert.equal(partial.installed, 0);
  assert.equal(partial.installFailures, 1);
  assert.equal(partial.failedFiles, 0);
  const ordinary = fixture();
  ordinary.native.assets.processImage = async () => null;
  const fallback = await prepareAssets(ordinary);
  assert.equal(fallback.fallback, 1);
  assert.equal(fallback.failedFiles, 0);
  assert.equal(fallback.installFailures, 0);
});

test('source metadata snapshots accompany install and detect changes during hashing', async () => {
  const f = fixture();
  f.native.assets.sourceIdentity = () => 'captured-source-version';
  await prepareAssets(f);
  assert.equal(f.installs[0][0].sourceIdentity, 'captured-source-version');
  let checks = 0;
  f.native.assets.sourceIdentity = () => ++checks === 1 ? 'before' : 'after';
  const result = await prepareAssets(f);
  assert.equal(result.fallback, 1);
  assert.equal(result.failedFiles, 1);
  assert.equal(result.entries.length, 0);
  assert.equal(f.jobs, 1);
});

test('ordinary preparation reads a stable source once and still hashes each generated page', async t => {
  const f = fixture(), createReadStream = fs.createReadStream;
  const reads = [];
  fs.createReadStream = function(file, ...args) {
    reads.push(String(file));
    return createReadStream.call(this, file, ...args);
  };
  t.after(() => { fs.createReadStream = createReadStream; });
  const result = await prepareAssets(f);
  assert.equal(result.installed, 1);
  assert.equal(reads.filter(file => file === path.join(f.gameRoot, f.source)).length, 1);
  assert.equal(reads.filter(file => file.endsWith('/page-0.png')).length, 1);
  assert.equal(result.entries[0].pageHashes[0], crypto.createHash('sha256').update(PNG).digest('hex'));
});

test('native activation rejects a prepared page changed after atomic publication', async t => {
  const f = fixture(), rename = fs.promises.rename;
  fs.promises.rename = async function(from, to) {
    await rename.call(this, from, to);
    if (path.basename(String(from)).startsWith('.stage-'))
      fs.appendFileSync(path.join(to, 'page-0.png'), 'damaged after staging');
  };
  f.native.assets.installPrepared = entries => {
    const accepted = entries.filter(entry => entry.pageHashes.every((expected, index) => {
      const page = entry.descriptor.pages[index];
      return crypto.createHash('sha256').update(fs.readFileSync(path.join(entry.directory, page.path))).digest('hex') === expected;
    }));
    f.installs.push(accepted);
    return { accepted: accepted.map(entry => entry.source), rejected: entries.filter(entry => !accepted.includes(entry)) };
  };
  t.after(() => { fs.promises.rename = rename; });
  const result = await prepareAssets(f);
  assert.equal(result.installed, 0);
  assert.ok(f.warnings.some(message => message.includes('prepared image index installed 0/1')));
});

test('uniform RGBA descriptors preserve all channels and reuse without PNG pages', async () => {
  const f = fixture();
  let calls = 0;
  f.native.assets.processImage = async () => {
    calls += 1;
    return { version: 1, width: 1, height: 1, halo: 3, uniform: [42, 17, 8, 0], pages: [], cells: [] };
  };
  const cold = await prepareAssets(f);
  assert.equal(cold.generated, 1);
  assert.equal(cold.cacheBytes, 0);
  assert.deepEqual(cold.entries[0].descriptor.uniform, [42, 17, 8, 0]);
  const warm = await prepareAssets(f);
  assert.equal(warm.hits, 1);
  assert.equal(calls, 1);
});



test('linked decoder identities invalidate cache reuse without changes to source pixels', async () => {
  const f = fixture();
  f.native.assets.preparationVersion = { processor: 'lossless-images-v1', decoder: 'decoder-1', pageSize: 2048 };
  await prepareAssets(f);
  f.native.assets.preparationVersion = { ...f.native.assets.preparationVersion, decoder: 'decoder-2' };
  assert.equal((await prepareAssets(f)).generated, 1);
  assert.equal(f.jobs, 2);
});


function encryptedFixture(engine = 'MZ') {
  const f = fixture();
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const systemFile = path.join(f.gameRoot, 'data/System.json');
  fs.mkdirSync(path.dirname(systemFile), { recursive: true });
  fs.writeFileSync(systemFile, JSON.stringify({ hasEncryptedImages: true, hasEncryptedAudio: true,
    encryptionKey: key.toString('hex') }));
  const encrypt = bytes => {
    const body = Buffer.from(bytes);
    for (let i = 0; i < 16; ++i) body[i] ^= key[i];
    return Buffer.concat([Buffer.from('5250474d560000000003010000000000', 'hex'), body]);
  };
  const encryptedImage = engine === 'MV' ? f.source.replace(/\.png$/, '.rpgmvp') : f.source + '_';
  const encryptedAudio = 'audio/bgm/theme.' + (engine === 'MV' ? 'rpgmvo' : 'ogg_');
  fs.renameSync(path.join(f.gameRoot, f.source), path.join(f.gameRoot, encryptedImage));
  fs.writeFileSync(path.join(f.gameRoot, encryptedImage), encrypt(PNG));
  const audio = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(28), Buffer.from('LOOPSTART=12\0LOOPLENGTH=96')]);
  fs.mkdirSync(path.join(f.gameRoot, 'audio/bgm'), { recursive: true });
  fs.writeFileSync(path.join(f.gameRoot, encryptedAudio), encrypt(audio));
  let aliases = new Map();
  const id = file => {
    if (!fs.existsSync(file)) return null;
    const stat = fs.statSync(file, { bigint: true });
    return [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs,
      crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')].join(':');
  };
  const assets = f.native.assets;
  const originalProcess = assets.processImage;
  assets.processImage = (source, output, recipe, file) => {
    assert.deepEqual(fs.readFileSync(file), PNG, 'processor receives plaintext');
    return originalProcess(source, output, recipe);
  };
  assets.hasDecrypted = source => {
    const entry = aliases.get(source);
    return !!entry && id(path.join(f.gameRoot, entry.source)) === entry.sourceIdentity &&
      id(systemFile) === entry.settingsIdentity && id(entry.file) === entry.fileIdentity;
  };
  assets.sourcePath = source => assets.hasDecrypted(source) ? aliases.get(source).file :
    (fs.existsSync(path.join(f.gameRoot, source)) ? path.join(f.gameRoot, source) : null);
  assets.sourceIdentity = source => {
    const file = assets.sourcePath(source);
    return file ? id(file) : null;
  };
  assets.installDecrypted = entries => {
    aliases = new Map(entries.map(entry => [entry.logicalSource, { ...entry, fileIdentity: id(entry.file) }]));
  };
  return { ...f, encrypt, audio, encryptedImage, encryptedAudio, systemFile, get jobs() { return f.jobs; }, get installs() { return f.installs; } };
}

for (const engine of ['MV', 'MZ']) test(engine + ' audio views prepare without materializing or hashing the audio payload', async () => {
  const f = encryptedFixture(engine);
  fs.rmSync(path.join(f.gameRoot, 'img'), { recursive: true });
  const installed = [];
  f.native.media = { installAudioViews(entries) { installed.push(entries); return entries.length; } };
  f.native.assets.installPreparedCatalog = () => 0;
  f.native.assets.installDerivedCatalog = () => {};
  const cold = await prepareAssets(f);
  assert.equal(cold.error, undefined);
  assert.equal(cold.total, 1);
  assert.equal(cold.audioViews, 1);
  assert.equal(cold.generated, 0);
  assert.equal(cold.decrypted, 0);
  assert.equal(cold.cacheBytes, 0);
  assert.equal(cold.validation.hashedBytesByCategory.source || 0, 0);
  assert.equal(installed.at(-1)[0].source, f.encryptedAudio);
  const warm = await prepareAssets(f);
  assert.equal(warm.validation.hashedFiles, 0);
  assert.equal(warm.audioViews, 1);
  const system = JSON.parse(fs.readFileSync(f.systemFile));
  system.hasEncryptedAudio = false;
  fs.writeFileSync(f.systemFile, JSON.stringify(system));
  const changed = await prepareAssets(f);
  assert.equal(changed.audioViews, 0);
  assert.equal(installed.at(-1).length, 0);
});

test('uppercase Audio inventory paths retain encrypted audio view preparation', async () => {
  const f = encryptedFixture();
  fs.renameSync(path.join(f.gameRoot, 'audio'), path.join(f.gameRoot, 'Audio'));
  f.encryptedAudio = f.encryptedAudio.replace(/^audio\//, 'Audio/');
  fs.rmSync(path.join(f.gameRoot, 'img'), { recursive: true });
  const installed = [];
  f.native.media = { installAudioViews(entries) { installed.push(entries); return entries.length; } };
  const result = await prepareAssets(f);
  assert.equal(result.audioViews, 1);
  assert.equal(installed.at(-1)[0].source, f.encryptedAudio);
});

for (const engine of ['MV', 'MZ']) test(engine + ' default audio views replace materialized audio while retaining prepared images', async () => {
  const f = encryptedFixture(engine);
  const legacy = await prepareAssets(f);
  assert.equal(legacy.decrypted, 2);
  const oldAudio = legacy.decryptedEntries.find(entry => entry.source === f.encryptedAudio).file;
  let views = [];
  f.native.media = { installAudioViews(entries) { views = entries; return entries.length; } };
  f.native.assets.installPreparedCatalog = entries => entries.length;
  f.native.assets.installDerivedCatalog = entries => f.native.assets.installDecrypted(entries);
  const upgraded = await prepareAssets(f);
  assert.equal(upgraded.error, undefined);
  assert.equal(upgraded.generated, 0, 'existing image cache is retained');
  assert.equal(upgraded.decrypted, 1);
  assert.equal(upgraded.installed, 1);
  assert.equal(upgraded.audioViews, 1);
  assert.equal(fs.existsSync(oldAudio), false, 'unreferenced duplicate audio is removed');
  assert.equal(views[0].source, f.encryptedAudio);
  const warm = await prepareAssets(f);
  assert.equal(warm.validation.hashedFiles, 0);
  assert.equal(warm.audioViews, 1);
  assert.equal(warm.decrypted, 1);
  fs.rmSync(path.join(f.gameRoot, 'img'), { recursive: true });
  fs.rmSync(path.join(f.gameRoot, 'audio'), { recursive: true });
  await prepareAssets({ ...f, verifyHashes: true });
  assert.deepEqual(views, [], 'successful empty preparation clears audio registrations');
});

test('audio view registrations and counts clear after installation failure or cancellation', async () => {
  for (const fail of [true, false]) {
    const f = encryptedFixture();
    fs.rmSync(path.join(f.gameRoot, 'img'), { recursive: true });
    let views = [], cancel = false;
    f.native.media = { installAudioViews(entries) { views = entries; return entries.length; } };
    if (fail) f.native.assets.installPrepared = () => { throw new Error('install failed'); };
    const result = await prepareAssets({ ...f, shouldCancel: () => cancel,
      onProgress(progress) { if (!fail && progress.phase === 'cleanup') cancel = true; } });
    assert.equal(result.audioViews, fail ? 1 : 0);
    assert.equal(views.length, fail ? 1 : 0);
    if (fail) assert.match(result.error, /install failed/);
    else assert.equal(result.cancelled, true);
  }
});

test('audio view preparation retains a mapping when a plaintext original takes precedence', async () => {
  const f = encryptedFixture();
  fs.rmSync(path.join(f.gameRoot, 'img'), { recursive: true });
  fs.writeFileSync(path.join(f.gameRoot, 'audio/bgm/theme.ogg'), f.audio);
  f.native.media = { installAudioViews(entries) { return entries.length; } };
  const result = await prepareAssets(f);
  assert.equal(result.audioViews, 1);
  assert.equal(result.decrypted, 0);
  assert.equal(result.error, undefined);
});

test('encrypted character index decisions use the recipe found after decryption', async () => {
  const f = encryptedFixture('MV');
  const source = 'img/characters/$indexed.rpgmvp';
  const logicalSource = 'img/characters/$indexed.png';
  fs.mkdirSync(path.join(f.gameRoot, 'img/characters'), { recursive: true });
  fs.renameSync(path.join(f.gameRoot, f.encryptedImage), path.join(f.gameRoot, source));
  const png = Buffer.from(PNG);
  png.writeUInt32BE(3, 16); png.writeUInt32BE(4, 20);
  const encrypted = f.encrypt(png);
  fs.writeFileSync(path.join(f.gameRoot, source), encrypted);
  const sourceHash = crypto.createHash('sha256').update(encrypted).digest('hex');
  const settingsHash = crypto.createHash('sha256').update(fs.readFileSync(f.systemFile)).digest('hex');
  let calls = 0;
  f.native.assets.processImage = async () => { ++calls; return null; };
  const result = await prepareAssets({ ...f, portableIndex: { images: [{ source, sourceHash,
    recipe: { source: logicalSource, sourceHash, grid: [3, 4] },
    encryptionSettingsSha256: settingsHash, descriptor: null, outputs: [] }] } });
  assert.equal(result.indexedNegative, 1);
  assert.equal(result.decrypted, 2);
  assert.equal(calls, 0);
});

for (const engine of ['MV', 'MZ']) {
  test(engine + ': unchanged hard-linked encryption inputs refresh identities while changed settings refuse installation', async () => {
    for (const changeContent of [false,true]) {
      const f = encryptedFixture(engine), processImage = f.native.assets.processImage;
      f.native.assets.processImage = async (...args) => {
        const descriptor = await processImage(...args);
        fs.linkSync(f.systemFile, path.join(f.root,'system-link.json'));
        fs.linkSync(path.join(f.gameRoot,f.encryptedImage),path.join(f.root,'image-link'));
        if (changeContent) fs.writeFileSync(f.systemFile, JSON.stringify({hasEncryptedImages:true,
          hasEncryptedAudio:true,encryptionKey:'ff'.repeat(16)}));
        return descriptor;
      };
      const result = await prepareAssets(f);
      assert.equal(result.decrypted,changeContent?0:2);
      assert.equal(f.native.assets.hasDecrypted(f.source),!changeContent);
      if (!changeContent) assert.deepEqual(fs.readFileSync(f.native.assets.sourcePath(f.source)),PNG);
    }
  });

  test(engine + ': encrypted extension case preserves logical source naming', async () => {
    const f = encryptedFixture(engine);
    for (const source of [f.encryptedImage, f.encryptedAudio]) {
      fs.renameSync(path.join(f.gameRoot, source),
        path.join(f.gameRoot, source.replace(/\.[^.]+$/, extension => extension.toUpperCase())));
    }
    const result = await prepareAssets(f);
    assert.equal(result.decrypted, 2);
    const image = engine === 'MV' ? f.source : f.source.replace(/\.png$/, '.PNG');
    const audio = 'audio/bgm/theme.' + (engine === 'MV' ? 'ogg' : 'OGG');
    assert.equal(result.entries[0].source, image);
    assert.deepEqual(fs.readFileSync(f.native.assets.sourcePath(image)), PNG);
    assert.deepEqual(fs.readFileSync(f.native.assets.sourcePath(audio)), f.audio);
  });

  test(engine + ': encrypted images and audio prepare once, preserve plaintext bytes and reuse on warm launch', async () => {
    const f = encryptedFixture(engine);
    const originals = [f.encryptedImage, f.encryptedAudio, 'data/System.json']
      .map(source => [source, fs.readFileSync(path.join(f.gameRoot, source))]);
    const cold = await prepareAssets(f);
    assert.equal(cold.generated, 2);
    assert.equal(cold.decrypted, 2);
    assert.equal(cold.fallback, 0);
    assert.equal(cold.installed, 1);
    assert.equal(f.jobs, 1);
    assert.deepEqual(fs.readFileSync(f.native.assets.sourcePath('img/pictures/a.png')), PNG);
    assert.deepEqual(fs.readFileSync(f.native.assets.sourcePath('audio/bgm/theme.ogg')), f.audio);
    const warm = await prepareAssets(f);
    assert.equal(warm.generated, 0);
    assert.equal(warm.hits, 2);
    assert.equal(warm.negativeHits, 0);
    assert.equal(warm.decrypted, 2);
    assert.equal(f.jobs, 1);
    for (const [source, bytes] of originals) assert.deepEqual(fs.readFileSync(path.join(f.gameRoot, source)), bytes);
  });

  test(engine + ': decrypted media corruption regenerates only its source; key changes never reuse stale output', async () => {
    const f = encryptedFixture(engine);
    const cold = await prepareAssets(f);
    fs.appendFileSync(cold.decryptedEntries.find(entry => entry.source.startsWith('audio/')).file, 'corrupt');
    const repaired = await prepareAssets(f);
    assert.equal(repaired.generated, 1);
    assert.equal(repaired.hits, 1);
    const settings = JSON.parse(fs.readFileSync(f.systemFile));
    settings.encryptionKey = 'ff'.repeat(16);
    fs.writeFileSync(f.systemFile, JSON.stringify(settings));
    const changed = await prepareAssets(f);
    assert.equal(changed.hits, 0);
    assert.equal(changed.decrypted, 0);
    assert.equal(changed.fallback, 2);
    assert.equal(f.native.assets.hasDecrypted('img/pictures/a.png'), false);
  });

  test(engine + ': encrypted ordinary images still get a plaintext cache when compact preparation is unnecessary', async () => {
    const f = encryptedFixture(engine);
    f.native.assets.processImage = async () => null;
    const cold = await prepareAssets(f);
    assert.equal(cold.decrypted, 2);
    assert.equal(cold.installed, 0);
    assert.equal(cold.fallback, 0);
    const warm = await prepareAssets(f);
    assert.equal(warm.hits, 2);
    assert.equal(warm.negativeHits, 0);
  });

  test(engine + ': truncated or invalid encrypted headers fall back independently of valid audio', async () => {
    for (const bytes of [Buffer.alloc(8), Buffer.alloc(64)]) {
      const f = encryptedFixture(engine);
      fs.writeFileSync(path.join(f.gameRoot, f.encryptedImage), bytes);
      const result = await prepareAssets(f);
      assert.equal(result.decrypted, 1);
      assert.equal(result.fallback, 1);
      assert.equal(f.native.assets.hasDecrypted('img/pictures/a.png'), false);
      assert.equal(f.native.assets.hasDecrypted('audio/bgm/theme.ogg'), true);
      assert.equal(f.jobs, 0);
    }
  });

  test(engine + ': WAV bytes with an ogg extension retain their exact data and logical filename', async () => {
    const f = encryptedFixture(engine);
    const wav = Buffer.alloc(44); wav.write('RIFF'); wav.write('WAVE', 8);
    fs.writeFileSync(path.join(f.gameRoot, f.encryptedAudio), f.encrypt(wav));
    const result = await prepareAssets(f);
    assert.equal(result.decrypted, 2);
    assert.deepEqual(fs.readFileSync(f.native.assets.sourcePath('audio/bgm/theme.ogg')), wav);
  });

  test(engine + ': cancelling encrypted preparation publishes no plaintext aliases or prepared images', async () => {
    const f = encryptedFixture(engine);
    let cancel = false;
    const result = await prepareAssets({ ...f, shouldCancel: () => cancel,
      onProgress(progress) { if (progress.completed === 1) cancel = true; } });
    assert.equal(result.cancelled, true);
    assert.equal(result.decrypted, 0);
    assert.equal(f.installs.length, 0);
    assert.equal(f.native.assets.hasDecrypted('img/pictures/a.png'), false);
  });
}

test('MV M4A detection keeps the logical extension and validates the decrypted media header', async () => {
  const f = encryptedFixture('MV');
  const m4a = Buffer.alloc(32); m4a.writeUInt32BE(24); m4a.write('ftypM4A ', 4);
  const source = 'audio/bgm/theme.rpgmvm';
  fs.writeFileSync(path.join(f.gameRoot, source), f.encrypt(m4a));
  const cold = await prepareAssets(f);
  assert.equal(cold.total, 3);
  assert.equal(cold.decrypted, 3);
  assert.deepEqual(fs.readFileSync(f.native.assets.sourcePath('audio/bgm/theme.m4a')), m4a);
  const warm = await prepareAssets(f);
  assert.equal(warm.hits, 3);
  assert.equal(warm.generated, 0);
  fs.writeFileSync(path.join(f.gameRoot, source), f.encrypt(f.audio));
  const invalid = await prepareAssets(f);
  assert.equal(invalid.decrypted, 2);
  assert.equal(invalid.fallback, 1);
  assert.equal(f.native.assets.hasDecrypted('audio/bgm/theme.m4a'), false);
});

test('MV encryption flags gate preparation and existing plaintext images take precedence', async () => {
  const f = encryptedFixture('MV');
  const settings = JSON.parse(fs.readFileSync(f.systemFile));
  settings.hasEncryptedImages = false;
  fs.writeFileSync(f.systemFile, JSON.stringify(settings));
  const disabled = await prepareAssets(f);
  assert.equal(disabled.total, 2);
  assert.equal(disabled.decrypted, 1);
  assert.equal(disabled.fallback, 1);
  assert.equal(f.native.assets.hasDecrypted(f.source), false);
  settings.hasEncryptedImages = true;
  fs.writeFileSync(f.systemFile, JSON.stringify(settings));
  fs.writeFileSync(path.join(f.gameRoot, f.source), PNG);
  f.native.assets.processImage = async () => null;
  const plaintext = await prepareAssets(f);
  assert.equal(plaintext.total, 3);
  assert.equal(plaintext.decrypted, 1);
  assert.equal(f.native.assets.hasDecrypted(f.source), false);
  assert.deepEqual(fs.readFileSync(f.native.assets.sourcePath(f.source)), PNG);
});

test('automatic character grids retain ordinary and single-character logical layouts', async () => {
  for (const [name, width, height, grid] of [['ordinary.png', 12, 8, [12, 8]], ['!$single.png', 3, 4, [3, 4]]]) {
    const f = fixture();
    fs.unlinkSync(path.join(f.gameRoot, f.source));
    fs.mkdirSync(path.join(f.gameRoot, 'img/characters'));
    const png = Buffer.from(PNG); png.writeUInt32BE(width, 16); png.writeUInt32BE(height, 20);
    fs.writeFileSync(path.join(f.gameRoot, 'img/characters', name), png);
    let observed;
    f.native.assets.processImage = async (_source, _output, recipe) => { observed = recipe.grid; return null; };
    await prepareAssets(f);
    assert.deepEqual(observed, grid);
  }
});

test('automatic battler grids prefer standard frames, then divisible alternatives', async () => {
  for (const [width, height, expected] of [
    [360, 600, [9, 6]], [3376, 3624, [4, 6]], [400, 800, [4, 8]],
    [400, 101, [4, 1]], [303, 404, [3, 4]], [301, 401, undefined],
    [0, 600, undefined]
  ]) {
    const header = Buffer.from(PNG);
    header.writeUInt32BE(width, 16);
    header.writeUInt32BE(height, 20);
    const recipe = await automaticRecipe(null, 'img/sv_actors/battler.png', '0'.repeat(64), header);
    assert.deepEqual(recipe?.grid, expected, `${width}x${height}`);
  }
  const header = Buffer.from(PNG);
  header.writeUInt32BE(360, 16);
  header.writeUInt32BE(600, 20);
  const explicit = await automaticRecipe(null, 'img/sv_actors/battler[4x1].png', '0'.repeat(64), header);
  assert.deepEqual(explicit.grid, [4, 1]);
  header.writeUInt32BE(301, 16);
  assert.equal(await automaticRecipe(null, 'img/sv_actors/battler[4x1].png', '0'.repeat(64), header), undefined);
});

function sideviewFixture(f = fixture(), encrypted = false) {
  const source = 'img/sv_actors/custom.png';
  const diskSource = encrypted ? source.replace(/\.png$/, '.rpgmvp') : source;
  fs.mkdirSync(path.join(f.gameRoot, 'img/sv_actors'), { recursive: true });
  fs.renameSync(path.join(f.gameRoot, encrypted ? f.encryptedImage : f.source), path.join(f.gameRoot, diskSource));
  const png = Buffer.from(PNG); png.writeUInt32BE(360, 16); png.writeUInt32BE(600, 20);
  fs.writeFileSync(path.join(f.gameRoot, diskSource), encrypted ? f.encrypt(png) : png);
  fs.mkdirSync(path.join(f.gameRoot, 'js'), { recursive: true });
  fs.mkdirSync(path.join(f.gameRoot, 'data'), { recursive: true });
  const manifest = path.join(f.gameRoot, 'js/plugins.js');
  const plugin = { name: 'YED_SideviewBattler', status: true, parameters: {} };
  const writePlugin = () => fs.writeFileSync(manifest, 'var $plugins = '+JSON.stringify([plugin])+';');
  writePlugin();
  const database = path.join(f.gameRoot, 'data/Enemies.json');
  const writeSize = height => fs.writeFileSync(database, JSON.stringify([null,
    { note: '<Sideview Battler: custom>\n<Sideview Battler Frames: 4>\n<Sideview Battler Size: 90, '+height+'>' }
  ]));
  writeSize(100);
  const observed = [];
  const process = f.native.assets.processImage;
  f.native.assets.processImage = async (name, output, recipe, input, ...args) => {
    observed.push(recipe?.grid);
    // Use the existing one-pixel output fixture; only recipe selection is under test.
    if (encrypted) return null;
    return process(name, output, recipe, input, ...args);
  };
  return { ...f, source, diskSource, png, plugin, writePlugin, writeSize, observed };
}

test('sideview metadata changes invalidate saved decisions and disabling the plugin restores standard grids', async () => {
  const f = sideviewFixture();
  f.native.assets.installPreparedCatalog = entries => entries.length;
  f.native.assets.installDerivedCatalog = () => {};
  const cold = await prepareAssets(f);
  assert.deepEqual(f.observed, [[4, 6]]);
  const warm = await prepareAssets(f);
  assert.equal(warm.validation.hashedFiles, 0);
  f.writeSize(75);
  const changed = await prepareAssets(f);
  assert.equal(changed.generated, 1);
  assert.deepEqual(f.observed, [[4, 6], [4, 8]]);
  f.plugin.status = false; f.writePlugin();
  const disabled = await prepareAssets(f);
  assert.equal(disabled.generated, 1);
  assert.deepEqual(f.observed.at(-1), [9, 6]);
  for (const result of [cold, warm, changed, disabled]) result.releaseCacheLease();
  assert.deepEqual(f.warnings, []);
});

test('YED metadata lookup and cache identity normalize mixed-case VFS paths', async () => {
  const f = sideviewFixture();
  fs.renameSync(path.join(f.gameRoot, 'img'), path.join(f.gameRoot, 'IMG'));
  fs.renameSync(path.join(f.gameRoot, 'IMG/sv_actors'), path.join(f.gameRoot, 'IMG/SV_Actors'));
  f.source = 'IMG/SV_Actors/custom.png';
  const first = await prepareAssets(f);
  assert.deepEqual(f.observed, [[4, 6]]);
  f.writeSize(75);
  const changed = await prepareAssets(f);
  assert.equal(changed.generated, 1);
  assert.deepEqual(f.observed, [[4, 6], [4, 8]]);
});

test('explicit recipes override YED grids and metadata overrides portable negative hints', async () => {
  const f = sideviewFixture();
  const sourceHash = crypto.createHash('sha256').update(f.png).digest('hex');
  const hinted = await prepareAssets({ ...f, portableIndex: { negativeHints: [f.source], images: [{
    source: f.source, sourceHash, recipe: { source: f.source, sourceHash, grid: [9, 6] },
    encryptionSettingsSha256: null, descriptor: null, outputs: []
  }] } });
  assert.equal(hinted.indexedNegative, 0);
  assert.deepEqual(f.observed, [[4, 6]]);
  hinted.releaseCacheLease();
  const explicit = await prepareAssets({ ...f, recipes: [{ source: f.source, sourceHash, grid: [3, 4] }] });
  assert.deepEqual(f.observed.at(-1), [3, 4]);
  explicit.releaseCacheLease();
});

test('offline preparation reads YED metadata through the virtual filesystem', async () => {
  const f = sideviewFixture();
  const database = fs.readFileSync(path.join(f.gameRoot, 'data/Enemies.json'));
  fs.unlinkSync(path.join(f.gameRoot, 'data/Enemies.json'));
  f.native.fs = { readBytes(source) {
    if (source === 'data/Enemies.json') return database;
    const file = path.join(f.gameRoot, source);
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  } };
  const result = await prepareAssets({ ...f, preparationContext: 'offline' });
  assert.deepEqual(f.observed, [[4, 6]]);
  assert.equal(result.prepared, 1);
  assert.deepEqual(f.warnings, []);
});

test('encrypted sideview recipes follow metadata changes even when encrypted source bytes are unchanged', async () => {
  const f = sideviewFixture(encryptedFixture('MV'), true);
  const first = await prepareAssets(f);
  assert.deepEqual(f.observed, [[4, 6]]);
  assert.equal(first.decrypted, 2);
  const indexed = await prepareAssets({ ...f, preparationContext: 'offline' });
  assert.equal(indexed.generated, 0);
  assert.deepEqual(indexed.decisions.find(d => d.source === f.diskSource).recipe.grid, [4, 6]);
  f.writeSize(75);
  const changed = await prepareAssets(f);
  assert.deepEqual(f.observed, [[4, 6], [4, 8]]);
  assert.equal(changed.generated, 1, 'only the sideview source needs regeneration');
  first.releaseCacheLease(); changed.releaseCacheLease();
  assert.deepEqual(f.warnings, []);
});

test('large parallax images receive a bounded preparation layout', async () => {
  const f = fixture();
  fs.unlinkSync(path.join(f.gameRoot, f.source));
  const source = 'img/parallaxes/scenery.png';
  const file = path.join(f.gameRoot, source);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const png = Buffer.from(PNG);
  png.writeUInt32BE(3240, 16);
  png.writeUInt32BE(3240, 20);
  fs.writeFileSync(file, png);
  let observed;
  f.native.assets.processImage = async (_input, _output, recipe) => {
    observed = recipe;
    return null;
  };
  const result = await prepareAssets(f);
  assert.equal(result.completed, 1);
  assert.deepEqual(observed.grid, [3, 3]);
  assert.equal(observed.source, source);
  const generated = await automaticRecipe(file, source,
    crypto.createHash('sha256').update(png).digest('hex'));
  assert.deepEqual(generated.grid, [3, 3]);
  assert.equal(generated.source, source);
  const tooSmall = Buffer.from(png);
  tooSmall.writeUInt32BE(2047, 16);
  tooSmall.writeUInt32BE(3240, 20);
  fs.writeFileSync(file, tooSmall);
  assert.equal(await automaticRecipe(file, source, '0'.repeat(64)), undefined);
});

test('block-grid descriptors preserve whole block crops and merged fills within authored frames', () => {
  const cells = [];
  for (let row=0;row<2;++row) for (let column=0;column<4;++column)
    cells.push({ rect:[column*64,row*64,64,64], crop:[0,0,64,64], fill:[0,0,0,0],
      page:0, atlas:[column*66+1,row*66+1,64,64] });
  const descriptor = { version:1, width:256, height:128, halo:1, blockGrid:[64,128,128],
    pages:[{path:'page-0.png',width:264,height:132}], cells };
  assert.equal(validDescriptor(descriptor),true);
  const merged={...descriptor,pages:[],cells:[
    {rect:[0,0,128,128],crop:[0,0,0,0],fill:[255,255,255,0],page:-1,atlas:[0,0,0,0]},
    {rect:[128,0,128,128],crop:[0,0,0,0],fill:[255,255,255,0],page:-1,atlas:[0,0,0,0]}
  ]};
  assert.equal(validDescriptor(merged),true);
  const overlapping={...descriptor,cells:structuredClone(descriptor.cells)};
  overlapping.cells[1].rect=[...overlapping.cells[0].rect];
  assert.equal(validDescriptor(overlapping),false,'fixed-grid validation rejects duplicate block coverage');
  const partialFrameCells=[];
  for (const frameX of [0,100]) for (const [x,y,w,h] of [[0,0,64,64],[64,0,36,64],[0,64,64,36],[64,64,36,36]])
    partialFrameCells.push({rect:[frameX+x,y,w,h],crop:[0,0,0,0],fill:[0,0,0,0],page:-1,atlas:[0,0,0,0]});
  const partialFrames={version:1,width:200,height:100,blockGrid:[64,100,100],pages:[],cells:partialFrameCells};
  assert.equal(validDescriptor(partialFrames),true,'partial edge blocks remain distinct across authored frames');
  partialFrameCells[4].rect=[...partialFrameCells[0].rect];
  assert.equal(validDescriptor(partialFrames),false);
  for (const change of [
    d=>{d.blockGrid=[32,128,128];},
    d=>{d.blockGrid=[64,127,128];},
    d=>{d.blockGrid=[64,128];},
    d=>{d.cells[0].rect[0]=1;},
    d=>{d.cells[0].crop=[1,0,63,64];},
    d=>{d.cells[0].rect[2]=128;},
    d=>{d.uniform=[0,0,0,0];}
  ]) {
    const invalid=structuredClone(descriptor);change(invalid);
    assert.equal(validDescriptor(invalid),false);
  }
  assert.equal(validDescriptor({...merged,width:256*65537,blockGrid:[64,128,128]}),false);
  assert.equal(validDescriptor({...merged,cells:[{...merged.cells[0],rect:[0,0,256,128]}]}),false);
});

test('prepared block-grid metadata survives verified cache reuse', async () => {
  const f=fixture();
  f.native.assets.processImage=async ()=>({version:1,width:128,height:64,halo:1,blockGrid:[64,64,64],
    pages:[],cells:[
      {rect:[0,0,64,64],crop:[0,0,0,0],fill:[255,255,255,0],page:-1,atlas:[0,0,0,0]},
      {rect:[64,0,64,64],crop:[0,0,0,0],fill:[255,255,255,0],page:-1,atlas:[0,0,0,0]}
    ]});
  const cold=await prepareAssets(f);
  assert.deepEqual(cold.entries[0].descriptor.blockGrid,[64,64,64]);
  const warm=await prepareAssets(f);
  assert.equal(warm.generated,0);
  assert.deepEqual(warm.entries[0].descriptor.blockGrid,[64,64,64]);
});

test('filename grids preserve divisible animation frames and reject invalid or unrelated suffixes', async () => {
  for (const [name, width, height, expected] of [
    ['animation[2x2].png', 1632, 2708, [2, 2]],
    ['animation[3X1].PNG', 2448, 624, [3, 1]],
    ['animation[64x64].png', 64, 64, [64, 64]],
    ['animation[2x2].png', 5, 8, undefined],
    ['animation[2x2].png', 0, 8, undefined],
    ['animation[0x2].png', 8, 8, undefined],
    ['animation[65x64].png', 65, 64, undefined],
    ['animation[9007199254740992x1].png', 8, 8, undefined],
    ['animation[2x2]copy.png', 8, 8, undefined],
    ['animation[Japanese].png', 8, 8, undefined]
  ]) {
    const f = fixture();
    fs.unlinkSync(path.join(f.gameRoot, f.source));
    const png = Buffer.from(PNG); png.writeUInt32BE(width, 16); png.writeUInt32BE(height, 20);
    fs.writeFileSync(path.join(f.gameRoot, 'img/pictures', name), png);
    let observed;
    f.native.assets.processImage = async (_source, _output, recipe) => { observed = recipe?.grid; return null; };
    await prepareAssets(f);
    assert.deepEqual(observed, expected, name);
  }
});

test('explicit recipes override filename grids', async () => {
  const f = fixture();
  const source = 'img/pictures/animation[2x2].png';
  fs.renameSync(path.join(f.gameRoot, f.source), path.join(f.gameRoot, source));
  const png = Buffer.from(PNG); png.writeUInt32BE(8, 16); png.writeUInt32BE(8, 20);
  fs.writeFileSync(path.join(f.gameRoot, source), png);
  const sourceHash = crypto.createHash('sha256').update(png).digest('hex');
  let observed;
  f.native.assets.processImage = async (_source, _output, recipe) => { observed = recipe.grid; return null; };
  await prepareAssets({ ...f, recipes: [{ source, sourceHash, grid: [4, 1] }] });
  assert.deepEqual(observed, [4, 1]);
});

for (const engine of ['MV', 'MZ']) {
  test(engine + ': filename grids are recognized after image decryption', async () => {
    const f = encryptedFixture(engine);
    const source = 'img/pictures/animation[2x2].' + (engine === 'MV' ? 'rpgmvp' : 'png_');
    fs.renameSync(path.join(f.gameRoot, f.encryptedImage), path.join(f.gameRoot, source));
    const png = Buffer.from(PNG); png.writeUInt32BE(8, 16); png.writeUInt32BE(8, 20);
    fs.writeFileSync(path.join(f.gameRoot, source), f.encrypt(png));
    let observed;
    f.native.assets.processImage = async (_source, _output, recipe) => { observed = recipe.grid; return null; };
    const result = await prepareAssets(f);
    assert.deepEqual(observed, [2, 2]);
    assert.equal(result.decrypted, 2);
  });
}






test('portable image lookup keeps ordered candidates for the same source', async () => {
  const f = fixture();
  const sourceHash = crypto.createHash('sha256').update(PNG).digest('hex');
  const matching = { source: f.source, sourceHash, recipe: null,
    encryptionSettingsSha256: null, descriptor: null, outputs: [] };
  const result = await prepareAssets({ ...f, portableAssetRoot: f.root, portableIndex: { images: [
    { ...matching, source: 'img/unrelated.png' },
    { ...matching, sourceHash: '0'.repeat(64) },
    matching,
    { ...matching, get descriptor() { throw new Error('later duplicate must not be inspected'); } }
  ] } });
  assert.equal(result.indexedNegative, 1);
  assert.equal(f.jobs, 0);
});


test('ASTC descriptors validate padded block payloads through the cache and functional-image policy changes its key', async () => {
  const f = fixture();
  f.native.assets.preparationWorkspaceVersion = 1;
  const calls = [];
  f.native.assets.processImage = async (name, output, recipe, input, layout, options) => {
    calls.push([options.allowAstc, options.astcQuality]);
    if (!options.allowAstc) return null;
    const header = Buffer.from([0x13, 0xab, 0xa1, 0x5c, 4, 4, 1, 5, 0, 0, 3, 0, 0, 1, 0, 0]);
    fs.writeFileSync(path.join(output, 'page-0.astc'), Buffer.concat([header, Buffer.alloc(32)]));
    return { version: 1, width: 5, height: 3, halo: 1, compression: 'astc-4x4', cells: [],
      pages: [{ path: 'page-0.astc', width: 5, height: 3 }] };
  };
  const lossless = await prepareAssets(f);
  assert.deepEqual(calls, [[false, 'medium']]);
  assert.equal(lossless.entries.length, 0);
  const enabled = { ...f, astc: { enabled: true } };
  let result = await prepareAssets(enabled);
  assert.equal(result.generated, 1); assert.deepEqual(calls, [[false, 'medium'], [true, 'medium']]);
  result = await prepareAssets(enabled);
  assert.equal(result.hits, 1); assert.equal(calls.length, 2);
  const descriptor = result.entries[0].descriptor;
  await prepareAssets({ ...f, astc: { enabled: true, quality: 'thorough' } });
  assert.deepEqual(calls.at(-1), [true, 'thorough']);
  assert.equal(calls.length, 3);
  await prepareAssets({ ...enabled, losslessPrefixes: ['img/pictures/a'] });
  assert.deepEqual(calls.at(-1), [false, 'medium']);
  const disabled = await prepareAssets(f);
  assert.equal(disabled.entries.some(entry => entry.descriptor?.compression), false);
  await assert.rejects(prepareAssets({ ...f, astc: { quality: 'bad' } }), /assetPreparation.astc/);
  await assert.rejects(prepareAssets({ ...f, astc: { enabled: 'yes' } }), /assetPreparation.astc/);
  assert.equal(validDescriptor(descriptor), true);
  assert.equal(validDescriptor({ ...descriptor, compression: 'other' }), false);
  assert.equal(validDescriptor({ ...descriptor, pages: [{ ...descriptor.pages[0], path: '../page-0.astc' }] }), false);
  await assert.rejects(prepareAssets({ ...f, losslessPrefixes: ['../unsafe'] }), /losslessPrefixes/);
});

test('storage decisions bind to source hashes and survive saved-state reuse', async () => {
  const f = fixture();
  f.native.assets.sourceIdentity = () => 'current-source';
  f.native.assets.installPrepared = entries => entries.length;
  f.native.assets.installPreparedCatalog = entries => entries.length;
  f.native.assets.installDerivedCatalog = () => {};
  let installed = [];
  f.native.assets.installImageStorage = entries => { installed = entries; return entries.length; };
  const storage = { version: 1, width: 1280, height: 720, channels: 4,
    paletteBits: 8, source: [0, 1, 2, 3], swizzle: [0, 1, 2, 3] };
  const portableIndex = { negativeHints: [f.source], images: [{
    source: f.source, sourceHash: crypto.createHash('sha256').update(PNG).digest('hex'),
    recipe: null, encryptionSettingsSha256: null, descriptor: null, outputs: [], storage
  }] };
  const cold = await prepareAssets({ ...f, portableIndex });
  assert.equal(cold.error, undefined);
  assert.equal(f.jobs, 0, 'verified negative layout skips image preparation');
  assert.ok(cold.validation.hashedBytes > 0, 'unverified negative hints cannot authorize storage');
  assert.deepEqual(installed, [{ source: f.source, sourceIdentity: 'current-source',
    backingHash: crypto.createHash('sha256').update(PNG).digest('hex'), storage }]);
  installed = [];
  const warm = await prepareAssets({ ...f, portableIndex });
  assert.equal(warm.validation.hashedFiles, 0);
  assert.deepEqual(installed, cold.storageEntries);
  // Changed content cannot authorize the previously calculated storage decision.
  fs.appendFileSync(path.join(f.gameRoot, f.source), 'changed');
  let rejectCatalog = true;
  f.native.assets.installImageStorage = entries => {
    if (entries.length && rejectCatalog) { rejectCatalog = false; return 0; }
    installed = entries; return entries.length;
  };
  const changed = await prepareAssets({ ...f, portableIndex });
  assert.equal(changed.error, undefined);
  assert.deepEqual(installed, [], 'changed content cannot reuse the old storage decision');
  assert.equal(f.jobs, 1);
});

for (const engine of ['MV', 'MZ']) test(engine + ' storage decisions bind to the installed plaintext image', async () => {
  const f = encryptedFixture(engine);
  let installed;
  f.native.assets.installImageStorage = entries => { installed = entries; return entries.length; };
  const storage = { version: 1, width: 1, height: 1, channels: 4,
    paletteBits: 0, source: [0, 1, 2, 3], swizzle: [0, 1, 2, 3] };
  const portableIndex = { images: [{
    source: f.encryptedImage,
    sourceHash: crypto.createHash('sha256').update(fs.readFileSync(path.join(f.gameRoot, f.encryptedImage))).digest('hex'),
    recipe: null, encryptionSettingsSha256: crypto.createHash('sha256').update(fs.readFileSync(f.systemFile)).digest('hex'),
    descriptor: null, outputs: [], storage
  }] };
  const result = await prepareAssets({ ...f, portableIndex });
  assert.equal(result.error, undefined);
  assert.equal(installed.length, 1);
  assert.equal(installed[0].source, f.source);
  assert.equal(installed[0].sourceIdentity, f.native.assets.sourceIdentity(f.source));
  assert.equal(installed[0].backingHash, crypto.createHash('sha256').update(PNG).digest('hex'),
    'storage recovery verifies plaintext rather than the encrypted source');
});
