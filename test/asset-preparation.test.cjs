'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { prepareAssets } = require('../runner/asset-preparation.cjs');
const { validate } = require('../runner/index.cjs');
const { parse } = require('../runner/cli.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');

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
  const native = { assets: { processImage, installPrepared(entries) { installs.push(entries); } } };
  const warnings = [];
  return { root, gameRoot, source, native, cacheRoot: path.join(root, 'cache'),
    logger: { warn(message) { warnings.push(message); } }, warnings,
    get jobs() { return jobs; }, get installs() { return installs; } };
}
function manifests(f) {
  return fs.readdirSync(path.join(f.cacheRoot, 'entries')).filter(n => !n.startsWith('.'))
    .map(n => path.join(f.cacheRoot, 'entries', n, 'manifest.json'));
}
function assertProgress(progress, result, terminalPhase) {
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

test('warm manifests and page headers reuse completed validation; edited manifests revalidate dimensions', async t => {
  const f = fixture(), first = await prepareAssets(f);
  const originalRead = fs.promises.readFile, originalOpen = fs.promises.open;
  let manifestReads = 0, pageOpens = 0;
  fs.promises.readFile = async (file, ...args) => {
    if (String(file).endsWith('/manifest.json')) manifestReads++;
    return originalRead(file, ...args);
  };
  fs.promises.open = async (file, ...args) => {
    if (String(file).endsWith('/page-0.png')) pageOpens++;
    return originalOpen(file, ...args);
  };
  t.after(() => { fs.promises.readFile = originalRead; fs.promises.open = originalOpen; });
  const warm = await prepareAssets(f);
  assert.equal(manifestReads, 0); assert.equal(pageOpens, 0);
  assert.equal(warm.validation.jsonReuses, 1);
  assert.deepEqual(warm.entries[0].descriptor, first.entries[0].descriptor);
  const file = manifests(f)[0], manifest = JSON.parse(fs.readFileSync(file));
  manifest.descriptor.pages[0].width = 2;
  const stable = value => Array.isArray(value) ? value.map(stable) :
    value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
  manifest.descriptorHash = crypto.createHash('sha256').update(JSON.stringify(stable(manifest.descriptor))).digest('hex');
  fs.writeFileSync(file, JSON.stringify(manifest));
  const repaired = await prepareAssets(f);
  assert.equal(repaired.generated, 1);
  assert.ok(manifestReads > 0); assert.ok(pageOpens > 0);
  assert.deepEqual(repaired.entries[0].descriptor, first.entries[0].descriptor);
});

test('unchanged validation preserves the published file receipt', async () => {
  const f = fixture();
  await prepareAssets(f);
  await prepareAssets(f);
  const file = path.join(f.cacheRoot, 'verified-files.json'), before = fs.statSync(file, { bigint: true });
  const warm = await prepareAssets(f), after = fs.statSync(file, { bigint: true });
  assert.equal(warm.generated, 0); assert.equal(warm.installed, 1);
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs);
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

test('damaged verification receipts require full checks without regenerating valid entries', async () => {
  const f = fixture();
  await prepareAssets(f);
  fs.writeFileSync(path.join(f.cacheRoot, 'verified-files.json'), '{');
  const repaired = await prepareAssets(f);
  assert.equal(repaired.validation.hashedFiles, 2);
  assert.equal(repaired.generated, 0);
  assert.equal((await prepareAssets(f)).validation.hashedFiles, 0);
});

test('full verification detects edits hidden by unchanged metadata', async t => {
  const f = fixture();
  await prepareAssets(f);
  const file = path.join(f.gameRoot, f.source);
  const before = fs.statSync(file, { bigint: true });
  const bytes = fs.readFileSync(file);
  bytes[bytes.length - 1] ^= 1;
  fs.writeFileSync(file, bytes);
  const lstat = fs.promises.lstat;
  fs.promises.lstat = async (target, options) => target === file ? before : lstat(target, options);
  t.after(() => { fs.promises.lstat = lstat; });
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
  assert.deepEqual(progress.map(p => p.phase), ['discover', 'discover', 'install', 'complete']);
});

test('addon and install errors report a terminal failure after discovery or validation', async () => {
  for (const failInstall of [false, true]) {
    const f = fixture();
    if (failInstall) f.native.assets.installPrepared = () => { throw new Error('install failed'); };
    else delete f.native.assets.processImage;
    const progress = [];
    const result = await prepareAssets({ ...f, onProgress: value => progress.push(value) });
    assertProgress(progress, result, 'error');
    assert.equal(result.completed, failInstall ? 1 : 0);
    assert.equal(f.jobs, failInstall ? 1 : 0);
    assert.equal(result.installed, 0);
  }
});

test('cancellation before scanning or after discovery does not install or report success', async () => {
  for (const afterDiscovery of [false, true]) {
    const f = fixture();
    const progress = [];
    let cancel = !afterDiscovery;
    const result = await prepareAssets({ ...f, shouldCancel: () => cancel, onProgress(value) {
      progress.push(value);
      if (value.phase === 'discover' && value.total === 1) cancel = true;
    } });
    assertProgress(progress, result, 'cancelled');
    assert.equal(result.total, afterDiscovery ? 1 : 0);
    assert.equal(result.completed, 0);
    assert.equal(f.jobs, 0);
    assert.equal(f.installs.length, 0);
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

test('recipe changes regenerate; mismatching source hashes fall back without processing', async () => {
  const f = fixture();
  const sourceHash = crypto.createHash('sha256').update(PNG).digest('hex');
  const recipe = { source: f.source, sourceHash, grid: [1, 1] };
  await prepareAssets({ ...f, recipes: [recipe] });
  assert.equal((await prepareAssets({ ...f, recipes: [{ ...recipe, backdrop: [0, 0, 0, 0] }] })).generated, 1);
  const result = await prepareAssets({ ...f, recipes: [{ ...recipe, sourceHash: '0'.repeat(64) }] });
  assert.equal(result.fallback, 1);
  assert.equal(result.entries.length, 0);
  assert.equal(f.jobs, 2);
});

test('corrupt PNG outputs and descriptor edits are regenerated independently', async () => {
  const f = fixture();
  await prepareAssets(f);
  let file = manifests(f)[0];
  fs.appendFileSync(path.join(path.dirname(file), 'page-0.png'), 'corruption');
  assert.equal((await prepareAssets(f)).generated, 1);
  file = manifests(f)[0];
  const manifest = JSON.parse(fs.readFileSync(file));
  manifest.descriptor.cells[0].fill = [255, 0, 0, 255];
  fs.writeFileSync(file, JSON.stringify(manifest));
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

test('concurrent preparers serialize and reuse completed output', async () => {
  const f = fixture();
  const original = f.native.assets.processImage;
  let releaseProcessing;
  const processing = new Promise(resolve => { releaseProcessing = resolve; });
  f.native.assets.processImage = async (...args) => {
    await processing;
    return original(...args);
  };
  const progress = [[], []];
  const results = await Promise.all(progress.map(events => prepareAssets({ ...f, onProgress(value) {
    events.push(value);
    if (value.phase === 'wait') releaseProcessing();
  } })));
  assert.equal(results.reduce((sum, r) => sum + r.generated, 0), 1);
  assert.equal(results.reduce((sum, r) => sum + r.hits, 0), 1);
  assert.equal(f.jobs, 1);
  assert.ok(progress.some(events => events.some(p => p.phase === 'wait' && p.remaining === 1 && p.source === '')));
  progress.forEach((events, i) => assertProgress(events, results[i], 'complete'));
});

test('lock-wait cancellation reports remaining sources and leaves the active lock intact', async () => {
  const f = fixture();
  const lock = path.join(f.cacheRoot, '.prepare-lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, hostname: require('node:os').hostname() }));
  const progress = [];
  let cancel = false;
  const result = await prepareAssets({ ...f, shouldCancel: () => cancel, onProgress(value) {
    progress.push(value);
    if (value.phase === 'wait') cancel = true;
  } });
  assertProgress(progress, result, 'cancelled');
  assert.equal(progress.at(-1).remaining, 1);
  assert.equal(f.jobs, 0);
  assert.equal(f.installs.length, 0);
  assert.equal(fs.existsSync(lock), true);
});

test('stale locks and interrupted staging directories are repaired', async () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.cacheRoot, '.prepare-lock'), { recursive: true });
  fs.writeFileSync(path.join(f.cacheRoot, '.prepare-lock/owner.json'), JSON.stringify({ pid: 2147483647, hostname: require('node:os').hostname() }));
  fs.mkdirSync(path.join(f.cacheRoot, 'entries/.stage-abandoned'), { recursive: true });
  assert.equal((await prepareAssets(f)).generated, 1);
  assert.equal(fs.existsSync(path.join(f.cacheRoot, '.prepare-lock')), false);
  assert.equal(fs.existsSync(path.join(f.cacheRoot, 'entries/.stage-abandoned')), false);
});

test('an aged foreign-host lock remains intact and falls back after a bounded wait', async () => {
  const f = fixture();
  const lock = path.join(f.cacheRoot, '.prepare-lock');
  fs.mkdirSync(lock, { recursive: true });
  const owner = JSON.stringify({ pid: 1234, hostname: require('node:os').hostname() + '-other' });
  fs.writeFileSync(path.join(lock, 'owner.json'), owner);
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(lock, old, old);
  const started = performance.now();
  const result = await prepareAssets(f);
  assert.ok(performance.now() - started < 20000, 'foreign lock wait exceeded its bound');
  assert.equal(result.fallback, 1);
  assert.equal(f.jobs, 0);
  assert.equal(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'), owner);
  assert.ok(f.warnings.some(message => message.includes('locked by another host')));
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
  assert.deepEqual(fs.readdirSync(path.join(f.cacheRoot, 'entries')), []);
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
  assert.equal(fs.existsSync(path.join(f.cacheRoot, '.prepare-lock')), false);
  assert.equal((await prepareAssets(f)).generated, 0, 'completed cache entries remain reusable after cancellation');
});

test('unwritable cache falls back; source changes during preparation never publish', async () => {
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
  assert.equal((await prepareAssets(f)).fallback, 1);
  assert.deepEqual(fs.readdirSync(path.join(f.cacheRoot, 'entries')), []);
});

test('invalid coverage and unsafe page paths never install or publish', async () => {
  const f = fixture();
  const original = f.native.assets.processImage;
  f.native.assets.processImage = async (...args) => { const d = await original(...args); d.width = 2; return d; };
  assert.equal((await prepareAssets(f)).fallback, 1);
  f.native.assets.processImage = async (...args) => { const d = await original(...args); d.pages[0].path = '../outside.png'; return d; };
  assert.equal((await prepareAssets(f)).fallback, 1);
  assert.equal(f.installs.at(-1).length, 0);
  assert.deepEqual(fs.readdirSync(path.join(f.cacheRoot, 'entries')), []);
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

test('source metadata snapshots accompany install and detect changes during hashing', async () => {
  const f = fixture();
  f.native.assets.sourceIdentity = () => 'captured-source-version';
  await prepareAssets(f);
  assert.equal(f.installs[0][0].sourceIdentity, 'captured-source-version');
  let checks = 0;
  f.native.assets.sourceIdentity = () => ++checks === 1 ? 'before' : 'after';
  const result = await prepareAssets(f);
  assert.equal(result.fallback, 1);
  assert.equal(result.entries.length, 0);
  assert.equal(f.jobs, 1);
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

test('a shared cache retains entries referenced by another game index', async () => {
  const first = fixture();
  const second = fixture();
  second.cacheRoot = first.cacheRoot;
  await prepareAssets(first);
  await prepareAssets(second);
  const shared = manifests(first)[0];
  fs.appendFileSync(path.join(first.gameRoot, first.source), 'new first game asset');
  await prepareAssets(first);
  assert.equal(fs.existsSync(shared), true);
  assert.equal((await prepareAssets(second)).hits, 1);
  assert.equal(second.jobs, 0);
});

test('linked decoder identities invalidate cache reuse without changes to source pixels', async () => {
  const f = fixture();
  f.native.assets.preparationVersion = { processor: 'lossless-images-v1', decoder: 'decoder-1', pageSize: 2048 };
  await prepareAssets(f);
  f.native.assets.preparationVersion = { ...f.native.assets.preparationVersion, decoder: 'decoder-2' };
  assert.equal((await prepareAssets(f)).generated, 1);
  assert.equal(f.jobs, 2);
});

test('live index leases protect unloaded entries until shutdown or explicit release', async () => {
  const f = fixture();
  const first = await prepareAssets(f);
  const oldDirectory = first.entries[0].directory;
  fs.appendFileSync(path.join(f.gameRoot, f.source), 'new version while first game is alive');
  const other = { ...f, native: { assets: { ...f.native.assets } } };
  await prepareAssets(other);
  assert.equal(fs.existsSync(oldDirectory), true);
  first.releaseCacheLease();
  await prepareAssets(other);
  assert.equal(fs.existsSync(oldDirectory), false);
});

test('quit requests retain cache ownership; explicit release and dead lease pruning work', async () => {
  const f = fixture();
  let closed = false;
  f.native.runtime = { quit() { closed = true; } };
  const first = await prepareAssets(f);
  const leases = () => fs.readdirSync(f.cacheRoot).filter(n => n.startsWith('.lease-'));
  assert.equal(leases().length, 1);
  f.native.runtime.quit();
  assert.equal(closed, true);
  assert.equal(leases().length, 1);
  first.releaseCacheLease();
  assert.equal(leases().length, 0);
  fs.writeFileSync(path.join(f.cacheRoot, '.lease-2147483647-dead.json'), JSON.stringify({
    pid: 2147483647, hostname: require('node:os').hostname(), keys: ['0'.repeat(64)]
  }));
  await prepareAssets(f);
  assert.equal(fs.existsSync(path.join(f.cacheRoot, '.lease-2147483647-dead.json')), false);
  f.native.runtime.quit();
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

test('torn positive and negative cache manifests regenerate without changing sources', async () => {
  for (const negative of [false, true]) {
    const f = fixture();
    if (negative) f.native.assets.processImage = async () => null;
    const first = await prepareAssets(f);
    assert.equal(first.generated, 1);
    const [manifest] = manifests(f);
    const bytes = fs.readFileSync(path.join(f.gameRoot, f.source));
    fs.writeFileSync(manifest, '{"version":1,"key":');
    const repaired = await prepareAssets(f);
    assert.equal(repaired.generated, 1);
    assert.equal(repaired.hits, 0);
    assert.deepEqual(fs.readFileSync(path.join(f.gameRoot, f.source)), bytes);
    assert.equal(repaired.installed, negative ? 0 : 1);
    const warm = await prepareAssets(f);
    assert.equal(warm.generated, 0);
    assert.equal(warm.hits, 1);
    assert.equal(warm.negativeHits, negative ? 1 : 0);
  }
});

test('warm catalogs install without discovery or source checks and verification bypasses reuse', async () => {
  const f = fixture();
  f.native.assets.sourceIdentity = () => 'source-identity';
  f.native.assets.installPrepared = entries => {
    for (const entry of entries) entry.pageIdentities = entry.descriptor.pages.map(() => 'page-identity');
    return entries.length;
  };
  f.native.assets.installPreparedCatalog = entries => entries.length;
  f.native.assets.installDerivedCatalog = () => {};
  const cold = await prepareAssets(f);
  assert.equal(cold.installed, 1);
  const originals = new Map();
  for (const name of ['readdir', 'lstat', 'stat']) {
    originals.set(name, fs.promises[name]);
    fs.promises[name] = async () => { throw new Error('unexpected warm '+name); };
  }
  const sourceIdentity = f.native.assets.sourceIdentity;
  f.native.assets.sourceIdentity = () => { throw new Error('unexpected warm source identity'); };
  try {
    const warm = await prepareAssets(f);
    assert.equal(warm.catalogHit, true);
    assert.equal(warm.generated, 0);
    assert.equal(warm.installed, 1);
    assert.equal(warm.entries[0].sourceIdentity, 'source-identity');
    warm.releaseCacheLease();
  } finally {
    for (const [name, original] of originals) fs.promises[name] = original;
    f.native.assets.sourceIdentity = sourceIdentity;
  }
  const verified = await prepareAssets({ ...f, verifyHashes: true });
  assert.equal(verified.catalogHit, undefined);
  assert.ok(verified.validation.hashedFiles > 0);
  verified.releaseCacheLease(); cold.releaseCacheLease();
});

test('observed stale image catalogs regenerate on the following preparation run', async () => {
  const f = fixture();
  f.native.assets.sourceIdentity = () => 'source-identity';
  f.native.assets.installPrepared = entries => {
    for (const entry of entries) entry.pageIdentities = entry.descriptor.pages.map(() => 'page-identity');
    return entries.length;
  };
  f.native.assets.installPreparedCatalog = entries => entries.length;
  f.native.assets.installDerivedCatalog = () => {};
  const cold = await prepareAssets(f);
  const warm = await prepareAssets(f);
  assert.equal(warm.catalogHit, true);
  assert.equal(warm.invalidateCatalog(), true);
  assert.equal(warm.invalidateCatalog(), true, 'repeated invalidation is harmless');
  const refreshed = await prepareAssets(f);
  assert.equal(refreshed.catalogHit, undefined);
  assert.equal(refreshed.installed, 1);
  const next = await prepareAssets(f);
  assert.equal(next.catalogHit, true, 'a repaired catalog returns to the fast path');
  for (const result of [cold, warm, refreshed, next]) result.releaseCacheLease();
});

test('damaged or rejected catalogs rebuild and release failed installation leases', async () => {
  const f = fixture();
  f.native.assets.sourceIdentity = () => 'source-identity';
  f.native.assets.installPrepared = entries => {
    for (const entry of entries) entry.pageIdentities = ['page-identity'];
    return entries.length;
  };
  f.native.assets.installPreparedCatalog = () => 0;
  f.native.assets.installDerivedCatalog = () => {};
  const cold = await prepareAssets(f);
  const refused = await prepareAssets(f);
  assert.equal(refused.catalogHit, undefined);
  assert.equal(refused.installed, 1);
  const file = fs.readdirSync(f.cacheRoot).find(name => name.startsWith('catalog-'));
  fs.writeFileSync(path.join(f.cacheRoot, file), '{');
  const repaired = await prepareAssets(f);
  assert.equal(repaired.installed, 1);
  assert.equal(repaired.generated, 0);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(f.cacheRoot, file))));
  repaired.releaseCacheLease(); refused.releaseCacheLease(); cold.releaseCacheLease();
});

test('map catalogs and live map leases protect shared decrypted entries during image cleanup', async () => {
  const f = fixture(), key = 'b'.repeat(64);
  const directory = path.join(f.cacheRoot, 'entries', key), mapRoot = path.join(f.cacheRoot, 'maps');
  fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(mapRoot);
  fs.writeFileSync(path.join(directory, 'source.png'), PNG);
  const { publishCatalog } = require('../runner/preparation-catalog.cjs');
  const { createLease } = require('../runner/preparation-lifetime.cjs');
  const catalog = path.join(mapRoot, 'catalog-'+key+'.json');
  await publishCatalog(catalog, {}, f.cacheRoot, { keys: [key], entries: [] });
  await prepareAssets(f);
  assert.ok(fs.existsSync(directory));
  const release = await createLease(mapRoot, [key]);
  fs.unlinkSync(catalog);
  await prepareAssets(f);
  assert.ok(fs.existsSync(directory));
  release();
  await prepareAssets(f);
  assert.equal(fs.existsSync(directory), false);
});

test('cancelled warm installation releases its lease and clears partial indexes', async () => {
  const f = fixture(); let cancelled = false;
  f.native.assets.sourceIdentity = () => 'source-identity';
  f.native.assets.installPrepared = entries => {
    for (const entry of entries) entry.pageIdentities = ['page'];
    return entries.length;
  };
  f.native.assets.installPreparedCatalog = entries => { cancelled = true; return entries.length; };
  f.native.assets.installDerivedCatalog = () => {};
  const cold = await prepareAssets(f);
  const before = fs.readdirSync(f.cacheRoot).filter(name => name.startsWith('.lease-'));
  const warm = await prepareAssets({ ...f, shouldCancel: () => cancelled });
  assert.equal(warm.cancelled, true);
  assert.equal(warm.installed, 0);
  assert.equal(warm.releaseCacheLease, undefined);
  assert.deepEqual(fs.readdirSync(f.cacheRoot).filter(name => name.startsWith('.lease-')), before);
  cold.releaseCacheLease();
});
