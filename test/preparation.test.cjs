'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { preparationLocks } = require('./helpers/preparation-lock.cjs');
const { prepareGameAssets } = require('../runner/preparation.cjs');
const { openPreparation } = require('../runner/preparation-state.cjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture() {
  const root = temporaryDirectory('preparation-'), gameRoot = path.join(root, 'game');
  fs.mkdirSync(path.join(gameRoot, 'img/pictures'), { recursive: true });
  fs.writeFileSync(path.join(gameRoot, 'img/pictures/a.png'), PNG);
  const jobs = [], installed = [], warnings = [];
  const native = { assets: { ...preparationLocks(),
    sourcePath(source) { const file = path.join(gameRoot, source); return fs.existsSync(file) ? file : null; },
    sourceIdentity(source) { const stat = fs.statSync(path.join(gameRoot, source), { bigint: true }); return [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'); },
    async processImage(source, directory, recipe, input) {
      jobs.push(source);
      fs.writeFileSync(path.join(directory, 'page-0.png'), fs.readFileSync(input || path.join(gameRoot, source)));
      return { version: 1, width: 1, height: 1, pages: [{ path: 'page-0.png', width: 1, height: 1 }],
        cells: [{ rect: [0,0,1,1], crop: [0,0,1,1], page: 0, atlas: [0,0,1,1], fill: [0,0,0,0] }] };
    },
    installPrepared(entries) { installed.splice(0, installed.length, ...entries); return entries.length; }
  } };
  const options = { gameRoot, cacheRoot: path.join(root, 'cache'), native, pageCodec: 'png', maps: false,
    logger: { warn(message) { warnings.push(message); } } };
  return { root, gameRoot, jobs, installed, warnings, options,
    async run(extra = {}) { const result = await prepareGameAssets({ ...options, ...extra }); result.releaseCacheLease?.(); return result; } };
}

test('publication relocates only declared image, map and port output receipts', async t => {
  const f = fixture();
  const session = await openPreparation({ ...f.options });
  t.after(() => session.close());
  for (const [parent, key, outputs, declared] of [
    ['entries', 'image', { 'source.png': hash(PNG), 'page-0.png': hash(PNG) }, ['source.png', 'page-0.png']],
    ['maps/entries', 'map', [{ path: 'tiles-0.png', hash: hash(PNG) }], ['tiles-0.png']],
    ['port/sample', 'port', { 'data.pma1': hash(PNG) }, ['data.pma1']],
  ]) {
    const stage = session.newDirectory(parent, key), destination = stage + '-published';
    await fs.promises.mkdir(stage, { recursive: true });
    for (const name of [...declared, 'unlisted.tmp']) fs.writeFileSync(path.join(stage, name), PNG);
    for (const name of [...declared, 'unlisted.tmp']) await session.files.hash(path.join(stage, name));
    session.writeManifest(stage, { key, outputs });
    await fs.promises.rename(stage, destination);
    session.files.publishManifest(stage, destination);
    for (const name of declared) assert.ok(session.files.receipts[path.join(destination, name)]);
    assert.ok(session.files.receipts[path.join(stage, 'unlisted.tmp')], 'unlisted receipt stays outside the published result');
    for (const name of declared) assert.equal(session.files.receipts[path.join(stage, name)], undefined);
  }
});

test('oversized cached state rebuilds without loading its contents', async t => {
  const f = fixture(), first = await openPreparation({ ...f.options });
  const filename = path.join(first.root, 'preparation-state.json');
  first.markDirty();
  await first.checkpoint();
  await first.close();
  fs.truncateSync(filename, 48 * 1024 * 1024 + 1);
  const invalidations = path.join(first.root, 'invalidations');
  fs.mkdirSync(invalidations, { recursive: true });
  fs.writeFileSync(path.join(invalidations, '0'.repeat(64) + '.json'),
    JSON.stringify({ version: 1, request: 'img/pictures/a.png' }));
  const readFile = fs.promises.readFile;
  let stateReads = 0;
  t.mock.method(fs.promises, 'readFile', async (file, ...args) => {
    if (String(file) === filename) ++stateReads;
    return readFile(file, ...args);
  });
  const rebuilt = await openPreparation({ ...f.options });
  t.after(() => rebuilt.close());
  assert.equal(stateReads, 0, 'oversized metadata must be rejected before parsing');
  assert.deepEqual(rebuilt.data.results, {});
  assert.ok(f.warnings.some(message => message.includes('exceeds the memory budget')));
});

test('large state checkpoints use bounded write buffers and preserve Unicode at chunk boundaries', async t => {
  const f = fixture(), session = await openPreparation({ ...f.options });
  t.after(() => session.close());
  session.data.failures.large = '';
  const prefix = JSON.stringify(session.data).indexOf('"large":"') + '"large":"'.length;
  const text = 'x'.repeat(64 * 1024 - prefix - 1) + '😺' + 'y'.repeat(1024 * 1024);
  session.data.failures.large = text;
  session.markDirty();
  const open = fs.promises.open;
  let largestWrite = 0;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).includes('preparation-state.json.stage-')) {
      const writeFile = handle.writeFile.bind(handle);
      handle.writeFile = async value => {
        largestWrite = Math.max(largestWrite, Buffer.byteLength(value));
        return writeFile(value);
      };
    }
    return handle;
  });
  assert.equal(await session.checkpoint(), true);
  const state = JSON.parse(fs.readFileSync(path.join(session.root, 'preparation-state.json')));
  assert.equal(state.data.failures.large, text);
  assert.equal(state.checksum, hash(JSON.stringify(state.data)));
  assert.ok(largestWrite <= 256 * 1024, 'checkpoint writes must not allocate a full-state byte buffer');
});

test('checkpoints above the read budget keep the last valid state', async t => {
  const f = fixture(), session = await openPreparation({ ...f.options });
  t.after(() => session.close());
  session.markDirty();
  assert.equal(await session.checkpoint(), true);
  const filename = path.join(session.root, 'preparation-state.json');
  const previous = fs.readFileSync(filename);
  session.data.failures.large = 'x'.repeat(48 * 1024 * 1024);
  session.markDirty();
  assert.equal(await session.checkpoint(), false);
  assert.deepEqual(fs.readFileSync(filename), previous);
  assert.ok(f.warnings.some(message => message.includes('exceeds the storage budget')));
});

test('successful finalization checkpoints once and close does not serialize state again', async t => {
  const f = fixture(), session = await openPreparation({ ...f.options });
  let serializations = 0;
  const data = session.data;
  Object.defineProperty(data, 'toJSON', { value() {
    ++serializations;
    return { files: data.files, results: data.results, indices: data.indices, failures: data.failures };
  } });
  session.markDirty();
  await session.finish();
  await session.close();
  assert.equal(serializations, 1);
});

test('unchanged warm state skips checkpoint serialization', async t => {
  const f = fixture(), session = await openPreparation({ ...f.options });
  t.after(() => session.close());
  let serializations = 0;
  Object.defineProperty(session.data, 'toJSON', { value() { ++serializations; return {}; } });
  assert.equal(await session.checkpoint(), true);
  await session.close();
  assert.equal(serializations, 0);
});

test('one state reuses unchanged inputs and outputs after a fresh inventory', async () => {
  const f = fixture();
  const first = await f.run();
  assert.equal(first.images.error, undefined);
  assert.equal(first.images.installed, 1);
  assert.equal(f.jobs.length, 1);
  const second = await f.run();
  assert.equal(second.inventory.files, 1);
  assert.equal(second.validation.hashedFiles, 0);
  assert.equal(f.jobs.length, 1);
  const state = JSON.parse(fs.readFileSync(path.join(first.root, 'preparation-state.json')));
  assert.equal(state.version, 1);
  assert.equal(Object.keys(state.data.results).length, 1);
  assert.equal(fs.existsSync(path.join(first.images.entries[0].directory, 'manifest.json')), false);
});

test('changed content preserves supplied settings and is subsequently reused', async () => {
  const f = fixture(), seen = [], original = f.options.native.assets.processImage;
  f.options.native.assets.processImage = (...args) => { seen.push(args[2]); return original(...args); };
  const portableIndex = { policies: { 'img/pictures/a.png': { recipe: { grid: [1,1] } } }, images: [] };
  await f.run({ portableIndex });
  fs.appendFileSync(path.join(f.gameRoot, 'img/pictures/a.png'), 'changed');
  const changed = await f.run({ portableIndex });
  assert.equal(changed.images.error, undefined);
  assert.equal(f.jobs.length, 2);
  assert.deepEqual(seen[1].grid, [1,1]);
  assert.equal(seen[1].sourceHash, hash(fs.readFileSync(path.join(f.gameRoot, 'img/pictures/a.png'))));
  assert.equal((await f.run({ portableIndex })).validation.hashedFiles, 0);
  assert.equal(f.jobs.length, 2);
});

test('metadata-only changes hash again without processing and added files are discovered', async () => {
  const f = fixture(); await f.run();
  const source = path.join(f.gameRoot, 'img/pictures/a.png');
  const contents = fs.readFileSync(source); fs.writeFileSync(source, contents);
  const same = await f.run();
  assert.equal(same.validation.hashedFiles, 1);
  assert.equal(f.jobs.length, 1);
  fs.writeFileSync(path.join(f.gameRoot, 'img/pictures/b.png'), PNG);
  assert.equal((await f.run()).inventory.files, 2);
  assert.equal(f.jobs.length, 2);
});

test('a corrupt output is repaired without rebuilding an unrelated result', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.gameRoot, 'img/pictures/b.png'), PNG);
  const first = await f.run(), directory = first.images.entries[0].directory;
  fs.appendFileSync(path.join(directory, 'page-0.png'), 'damage');
  const repaired = await f.run();
  assert.equal(repaired.images.installed, 2);
  assert.equal(f.jobs.length, 3);
  assert.notEqual(repaired.images.entries[0].directory, directory);
  assert.equal(fs.existsSync(directory), false);
});

test('a phase-wide image capability failure retains prior cache entries', async () => {
  const f = fixture(), first = await f.run(), directory = first.images.entries[0].directory;
  const processImage = f.options.native.assets.processImage;
  delete f.options.native.assets.processImage;
  const unavailable = await f.run();
  assert.match(unavailable.images.error, /image preparation is unavailable/);
  assert.equal(fs.existsSync(directory), true);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(first.root, 'preparation-state.json'))).data.results).length, 1);
  f.options.native.assets.processImage = processImage;
  const recovered = await f.run();
  assert.equal(recovered.images.generated, 0);
  assert.equal(recovered.images.hits, 1);
  assert.equal(f.jobs.length, 1);
});

test('VFS-authorized in-root symlinks are prepared while escaping targets are rejected', async () => {
  const f = fixture(), source = path.join(f.gameRoot, 'img/pictures/linked.png');
  fs.symlinkSync('a.png', source);
  fs.symlinkSync(path.join(f.root, 'outside.png'), path.join(f.gameRoot, 'img/pictures/escape.png'));
  fs.writeFileSync(path.join(f.root, 'outside.png'), PNG);
  f.options.native.fs = { inventory: () => ['img/pictures/a.png', 'img/pictures/linked.png', 'img/pictures/escape.png'] };
  const result = await f.run();
  assert.equal(result.images.installed, 2);
  assert.equal(result.images.failedFiles, 1);
  assert.ok(f.warnings.some(message => message.includes('outside game root')));
});

test('uppercase VFS inventory paths are preserved and prepared', async () => {
  const f = fixture();
  fs.renameSync(path.join(f.gameRoot, 'img'), path.join(f.gameRoot, 'IMG'));
  fs.renameSync(path.join(f.gameRoot, 'IMG/pictures'), path.join(f.gameRoot, 'IMG/Pictures'));
  fs.renameSync(path.join(f.gameRoot, 'IMG/Pictures/a.png'), path.join(f.gameRoot, 'IMG/Pictures/A.png'));
  f.options.native.fs = { inventory: () => ['IMG/Pictures/A.png'] };
  const result = await f.run();
  assert.equal(result.images.total, 1);
  assert.equal(result.images.installed, 1);
  assert.equal(f.jobs[0], 'IMG/Pictures/A.png');
});

test('a deliberate original decision is remembered for unchanged inputs', async () => {
  const f = fixture();
  f.options.native.assets.processImage = () => { f.jobs.push('declined'); return null; };
  assert.equal((await f.run()).images.installed, 0);
  const warm = await f.run();
  assert.equal(warm.images.failedFiles, 0);
  assert.equal(warm.validation.hashedFiles, 0);
  assert.equal(f.jobs.length, 1);
});

test('processing failure preserves other assets and retries on the next launch', async () => {
  const f = fixture(), process = f.options.native.assets.processImage;
  fs.writeFileSync(path.join(f.gameRoot, 'img/pictures/b.png'), PNG);
  f.options.native.assets.processImage = (...args) => {
    if (args[0].endsWith('/a.png')) { f.jobs.push(args[0]); throw new Error('fixture decode failed'); }
    return process(...args);
  };
  const failed = await f.run();
  assert.equal(failed.images.failedFiles, 1);
  assert.equal(failed.images.installed, 1);
  assert.equal(f.installed[0].source, 'img/pictures/b.png');
  await f.run();
  assert.equal(f.jobs.filter(source => source.endsWith('/b.png')).length, 1);
  assert.equal(f.jobs.filter(source => source.endsWith('/a.png')).length, 2);
  assert.ok(f.warnings.some(message => message.includes('fixture decode failed')));
});

for (const permanent of [false, true]) test('native rejection repairs once and isolates fallback: permanent=' + permanent, async () => {
  const f = fixture(), install = f.options.native.assets.installPrepared;
  fs.writeFileSync(path.join(f.gameRoot, 'img/pictures/b.png'), PNG);
  let calls = 0;
  f.options.native.assets.installPrepared = entries => {
    const rejected = entries.filter(entry => entry.source.endsWith('/a.png') && (permanent || calls === 0));
    const accepted = entries.filter(entry => !rejected.includes(entry));
    calls++; install(accepted);
    return { accepted: accepted.map(entry => entry.source), rejected: rejected.map(entry => ({ id: entry.source, reason: 'fixture rejection' })) };
  };
  const result = await f.run();
  assert.equal(calls, 2);
  assert.equal(f.jobs.length, 3);
  assert.equal(result.images.installed, permanent ? 1 : 2);
  assert.ok(f.installed.some(entry => entry.source.endsWith('/b.png')));
});

test('damaged local state rebuilds without relying on old cache receipts', async () => {
  const f = fixture(), first = await f.run();
  fs.writeFileSync(path.join(first.root, 'preparation-state.json'), '{');
  const repaired = await f.run();
  assert.equal(repaired.images.installed, 1);
  assert.equal(f.jobs.length, 2);
  assert.ok(f.warnings.some(message => message.includes('state unavailable')));
});

for (const mode of ['rename-failure', 'interrupted-after-rename']) test('image publication recovers from ' + mode, async t => {
  const f = fixture();
  await f.run();
  fs.appendFileSync(path.join(f.gameRoot, 'img/pictures/a.png'), 'changed');
  const rename = fs.promises.rename;
  const stub = t.mock.method(fs.promises, 'rename', async (from, to) => {
    if (path.basename(String(from)).startsWith('.stage-') && path.dirname(String(to)).endsWith(path.sep + 'entries')) {
      if (mode === 'interrupted-after-rename') await rename(from, to);
      throw Object.assign(new Error(mode), { code: 'EIO' });
    }
    return rename(from, to);
  });
  const interrupted = await f.run();
  stub.mock.restore();
  assert.equal(interrupted.images.installed, 0);
  assert.equal(f.installed.length, 0, 'failed publication never installs a partial entry');
  const recovered = await f.run();
  assert.equal(recovered.images.installed, 1);
  assert.equal(f.jobs.length, 3, 'the interrupted generation is safely rebuilt');
});

test('cancellation keeps completed results and discards the unfinished stage', async () => {
  const f = fixture(), process = f.options.native.assets.processImage;
  fs.writeFileSync(path.join(f.gameRoot, 'img/pictures/b.png'), PNG);
  let cancelled = false, once = true;
  f.options.native.assets.processImage = async (...args) => {
    const value = await process(...args);
    if (once && args[0].endsWith('/b.png')) { cancelled = true; once = false; }
    return value;
  };
  const first = await f.run({ shouldCancel: () => cancelled });
  assert.equal(first.cancelled, true);
  assert.equal(f.installed.length, 0);
  cancelled = false;
  const resumed = await f.run();
  assert.equal(resumed.images.installed, 2);
  assert.equal(f.jobs.filter(source => source.endsWith('/a.png')).length, 1);
  assert.equal(f.jobs.filter(source => source.endsWith('/b.png')).length, 2);
});

test('precise deferred invalidation repairs only the reported result', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.gameRoot, 'img/pictures/b.png'), PNG);
  const first = await f.run();
  await first.invalidate('img/pictures/a.png');
  assert.equal((await f.run()).images.installed, 2);
  assert.equal(f.jobs.length, 3);
  assert.equal(f.jobs.filter(source => source.endsWith('/b.png')).length, 1);
});

test('live invalidation writes a small marker without reading or changing preparation state', async () => {
  const f = fixture(), first = await f.run();
  const stateFile = path.join(first.root, 'preparation-state.json');
  const original = fs.readFileSync(stateFile, 'utf8');
  const readFile = fs.promises.readFile;
  fs.promises.readFile = function(file, ...args) {
    assert.notEqual(String(file), stateFile, 'live invalidation must not parse the full state');
    return readFile.call(this, file, ...args);
  };
  try { await first.invalidate('img/pictures/a.png'); }
  finally { fs.promises.readFile = readFile; }
  assert.equal(fs.readFileSync(stateFile, 'utf8'), original);
  const directory = path.join(first.root, 'invalidations');
  const files = fs.readdirSync(directory);
  assert.equal(files.length, 1);
  assert.ok(fs.statSync(path.join(directory, files[0])).size < 256);
  assert.equal(f.warnings.length, 0);
  await f.run();
  assert.equal(f.jobs.length, 2, 'the failed result is repaired at startup');
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('concurrent and repeated live invalidations preserve every failed result', async () => {
  const f = fixture(); fs.writeFileSync(path.join(f.gameRoot, 'img/pictures/b.png'), PNG);
  const first = await f.run();
  await Promise.all([first.invalidate('img/pictures/a.png'), first.invalidate('img/pictures/b.png')]);
  await first.invalidate('img/pictures/a.png');
  assert.equal(fs.readdirSync(path.join(first.root, 'invalidations')).length, 2);
  await f.run();
  assert.equal(f.jobs.length, 4);
  assert.equal(f.warnings.length, 0);
});

test('a deleted asset leaves the inventory and its unused result is reclaimed', async () => {
  const f = fixture(), first = await f.run(), directory = first.images.entries[0].directory;
  fs.rmSync(path.join(f.gameRoot, 'img/pictures/a.png'));
  const next = await f.run();
  assert.equal(next.inventory.files, 0);
  assert.equal(next.images.installed, 0);
  assert.equal(fs.existsSync(directory), false);
});

function portProcessor(f, { decline = false } = {}) {
  const file = path.join(f.root, 'fixture.pmjs-processor.cjs'), calls = path.join(f.root, 'port-calls');
  fs.writeFileSync(file, `'use strict';
const fs = require('node:fs');
module.exports = { id: 'fixture', version: 1,
  discover({files}) { return files.filter(name => name.endsWith('.png')); },
  generate(bytes, {source}) { fs.appendFileSync(${JSON.stringify(calls)}, source + '\\n'); return ${decline ? 'null' : 'bytes'}; }
};`);
  f.options.native.assets.compressPortArtifact = bytes => Buffer.from(bytes);
  f.options.native.assets.decompressPortArtifact = bytes => Buffer.from(bytes);
  return { adapters: [file], calls, file };
}

test('images and discovered port data share checksums and discover new files on every launch', async () => {
  const f = fixture(), processor = portProcessor(f);
  const first = await f.run(processor);
  assert.equal(first.portArtifacts.size, 1);
  assert.deepEqual(fs.readFileSync(first.portArtifacts.get('fixture/a')), PNG);
  const warm = await f.run(processor);
  assert.equal(warm.validation.hashedFiles, 0);
  assert.equal(fs.readFileSync(processor.calls, 'utf8').trim().split('\n').length, 1);
  fs.writeFileSync(path.join(f.gameRoot, 'img/pictures/b.png'), PNG);
  const added = await f.run(processor);
  assert.equal(added.portArtifacts.size, 2);
  assert.equal(fs.readFileSync(processor.calls, 'utf8').trim().split('\n').length, 2);
  assert.equal(added.images.installed, 2);
});

test('port declines persist and processor changes invalidate only its derivations', async () => {
  const f = fixture(), processor = portProcessor(f, { decline: true });
  await f.run(processor); await f.run(processor);
  assert.equal(fs.readFileSync(processor.calls, 'utf8').trim().split('\n').length, 1);
  fs.appendFileSync(processor.file, '\n');
  await f.run(processor);
  assert.equal(fs.readFileSync(processor.calls, 'utf8').trim().split('\n').length, 2);
  assert.equal(f.jobs.length, 1);
});


test('an interrupted state publication keeps the previous committed state and live outputs', async t => {
  const f = fixture(), first = await f.run();
  const file = path.join(first.root, 'preparation-state.json'), committed = fs.readFileSync(file);
  fs.appendFileSync(path.join(f.gameRoot, 'img/pictures/a.png'), 'changed');
  const rename = fs.promises.rename;
  const stub = t.mock.method(fs.promises, 'rename', async (from, to) => {
    if (to === file) throw Object.assign(new Error('interrupted state write'), { code: 'EIO' });
    return rename(from, to);
  });
  const failedSave = await f.run();
  assert.equal(failedSave.images.installed, 1);
  assert.deepEqual(fs.readFileSync(file), committed);
  assert.ok(fs.existsSync(first.images.entries[0].directory));
  assert.ok(fs.existsSync(failedSave.images.entries[0].directory));
  assert.ok(f.warnings.some(message => message.includes('could not be saved')));
  stub.mock.restore();
  assert.equal((await f.run()).images.installed, 1);
  assert.equal((await f.run()).validation.hashedFiles, 0);
});

test('runtime recipes override packaged defaults and invalid choices affect only their asset', async () => {
  const f = fixture(), seen = [], processImage = f.options.native.assets.processImage;
  f.options.native.assets.processImage = (...args) => { seen.push(args[2]); return processImage(...args); };
  fs.writeFileSync(path.join(f.gameRoot, 'img/pictures/b.png'), PNG);
  const result = await f.run({ recipes: [{ source: 'img/pictures/a.png', sourceHash: hash(PNG), grid: [1,1] }],
    portableIndex: { policies: { 'img/pictures/a.png': { recipe: { grid: [2,2] } },
      'img/pictures/b.png': { recipe: { grid: [0,1] } } }, images: [] } });
  assert.equal(result.images.installed, 1);
  assert.equal(result.images.failedFiles, 1);
  assert.deepEqual(seen[0].grid, [1,1]);
  assert.ok(f.warnings.some(message => message.includes('b.png')));
});


test('rejection of one image does not invalidate an accepted map result', async () => {
  const { fixture: mapFixture } = require('./helpers/map-preparation.cjs');
  const f = mapFixture();
  let imageJobs = 0;
  f.native.assets.processImage = (source, directory) => {
    ++imageJobs;
    fs.writeFileSync(path.join(directory, 'page-0.png'), PNG);
    return { version: 1, width: 512, height: 512, pages: [{ path: 'page-0.png', width: 1, height: 1 }],
      cells: [{ rect: [0,0,512,512], crop: [0,0,1,1], page: 0, atlas: [0,0,1,1], fill: [0,0,0,0] }] };
  };
  const install = f.native.assets.installPrepared = entries => ({ accepted: entries.map(entry => entry.source), rejected: [] });
  const first = await prepareGameAssets({ ...f, maps: true, pageCodec: 'png' }); first.releaseCacheLease?.();
  f.native.assets.installPrepared = entries => ({ accepted: entries.filter(entry => entry.source.endsWith('C.png')).map(entry => entry.source),
    rejected: entries.filter(entry => entry.source.endsWith('B.png')).map(entry => ({ id: entry.source, reason: 'fixture rejection' })) });
  const rejected = await prepareGameAssets({ ...f, maps: true, pageCodec: 'png' }); rejected.releaseCacheLease?.();
  assert.equal(rejected.maps.generated, 0);
  assert.equal(rejected.maps.installed, 1);
  assert.equal(rejected.outcomeCounts['ordinary-failure'], 1);
  assert.equal(imageJobs, 3);
  f.native.assets.installPrepared = install;
});


test('deleting every map removes its registrations and unused results', async () => {
  const { fixture: mapFixture } = require('./helpers/map-preparation.cjs');
  const f = mapFixture();
  const first = await prepareGameAssets({ ...f, images: false, maps: true }); first.releaseCacheLease?.();
  assert.equal(first.maps.installed, 1);
  fs.unlinkSync(path.join(f.gameRoot, 'data/Map001.json'));
  const deleted = await prepareGameAssets({ ...f, images: false, maps: true }); deleted.releaseCacheLease?.();
  assert.equal(deleted.maps.installed, 0);
  assert.equal(f.installed.length, 0);
  assert.deepEqual(Object.values(deleted.records), []);
  assert.equal(fs.existsSync(first.maps.entries[0].directory), false);
});


test('legacy generated outputs are reclaimed only after their live leases release them', async () => {
  const { createLease } = require('../runner/preparation-lifetime.cjs');
  const f = fixture(), key = 'a'.repeat(64), directory = path.join(f.options.cacheRoot, 'entries', key);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'page-0.png'), PNG);
  const release = await createLease(f.options.cacheRoot, [key]);
  await f.run();
  assert.equal(fs.existsSync(directory), true);
  release();
  await f.run();
  assert.equal(fs.existsSync(directory), false);
});


test('lease publication failure falls back before prepared files can be used without protection', async t => {
  const f = fixture(), open = fs.promises.open;
  t.mock.method(fs.promises, 'open', async (file, ...args) => {
    if (String(file).includes('.lease-')) throw new Error('fixture lease failure');
    return open(file, ...args);
  });
  const result = await f.run();
  assert.equal(result.images.installed, 0);
  assert.match(result.images.error, /fixture lease failure/);
  assert.deepEqual(f.installed, []);
  assert.equal(result.portArtifacts.size, 0);
});


test('runtime compression and lossless settings override packaged defaults', async () => {
  const f = fixture(), settings = [], processImage = f.options.native.assets.processImage;
  f.options.native.assets.preparationWorkspaceVersion = 1;
  f.options.native.assets.processImage = (...args) => { settings.push(args[5]); return processImage(...args); };
  const invalid = await f.run({ portableIndex: { policies: { 'img/pictures/a.png': { astc: 'invalid' } }, images: [] } });
  assert.equal(invalid.images.installed, 0);
  assert.equal(f.jobs.length, 0);
  const valid = await f.run({ astc: { enabled: true }, losslessPrefixes: [],
    portableIndex: { policies: { 'img/pictures/a.png': { lossless: false } }, images: [] } });
  assert.equal(valid.images.installed, 1);
  assert.equal(settings[0].allowAstc, true);
});
