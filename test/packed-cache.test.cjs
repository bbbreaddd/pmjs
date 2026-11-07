'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { packCache, loadPackedCache, inspectPacked } = require('../runner/packed-cache.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const quiet = { warn() {}, info() {} };
function fixture() {
  const root = temporaryDirectory('packed-images-'), data = { files: {}, results: {}, indices: {}, failures: {} };
  const originals = new Map();
  for (let i = 0; i < 3; i++) {
    const directory = 'entries/' + String(i).repeat(64), name = directory + '/page-0.pml4';
    fs.mkdirSync(path.join(root, directory), { recursive: true });
    const bytes = Buffer.alloc(37 + i, 30 + i); fs.writeFileSync(path.join(root, name), bytes);
    data.results[directory] = { outputs: { 'page-0.pml4': hash(bytes) } }; originals.set(path.join(root, name), bytes);
  }
  const save = () => fs.writeFileSync(path.join(root, 'preparation-state.json'), JSON.stringify({ version: 1, checksum: hash(JSON.stringify(data)), data }));
  save();
  let locked = false;
  const assets = { tryAcquirePreparationLock() { if (locked) return null; locked = true; return {}; },
    releasePreparationLock() { locked = false; }, installPackedFiles(files) { this.installed = files; } };
  return { root, data, originals, assets, save };
}
test('packing preserves exact ranged bytes, bounded packs, and verification headers', async () => {
  const f = fixture();
  const result = await packCache(f.root, f.assets, { maximumBytes: 80 });
  assert.equal(result.files, 3); assert.equal(result.packs, 2);
  const entries = await loadPackedCache(f.root, { assets: f.assets }, quiet);
  assert.equal(entries.size, 3);
  for (const [name, original] of f.originals) {
    assert(!fs.existsSync(name)); assert(!fs.existsSync(path.dirname(name)));
    const entry = entries.get(name), bytes = fs.readFileSync(entry.pack).subarray(entry.offset, entry.offset + entry.size);
    assert.deepEqual(bytes, original);
    const checked = await inspectPacked(entry, true);
    assert.equal(checked.hash, hash(original)); assert.deepEqual(checked.header, original.subarray(0, 32));
  }
  assert.equal(f.assets.installed.length, 3);
});
test('failed packing leaves originals intact, removes partial packs and releases its lock', async () => {
  const f = fixture(); Object.values(f.data.results)[1].outputs['page-0.pml4'] = 'f'.repeat(64); f.save();
  await assert.rejects(packCache(f.root, f.assets, { maximumBytes: 80 }), /changed/);
  for (const [name, bytes] of f.originals) assert.deepEqual(fs.readFileSync(name), bytes);
  assert(!fs.readdirSync(f.root).some(name => name.startsWith('pack-')));
  assert(!fs.existsSync(path.join(f.root, 'packed-images.json')));
  assert(f.assets.tryAcquirePreparationLock());
});
test('conversion refuses live readers and damaged packs fall back without mounting partial indices', async () => {
  const f = fixture();
  const { createLease } = require('../runner/preparation-lifetime.cjs');
  const release = await createLease(f.root, ['a'.repeat(64)]);
  try { await assert.rejects(packCache(f.root, f.assets), /live readers/); } finally { release(); }
  await packCache(f.root, f.assets);
  let entries = await loadPackedCache(f.root, { assets: f.assets }, quiet);
  assert.equal(entries.size, 3);
  fs.appendFileSync(entries.values().next().value.pack, 'damage');
  entries = await loadPackedCache(f.root, { assets: f.assets }, quiet);
  assert.equal(entries, null); assert.deepEqual(f.assets.installed, []);
});

test('repacking merges loose changes, drops obsolete entries and reclaims abandoned packs', async () => {
  const f = fixture();
  await packCache(f.root, f.assets);
  const old = await loadPackedCache(f.root, { assets: f.assets }, quiet);
  const oldPack = old.values().next().value.pack;
  const [removed, changed] = [...f.originals.keys()];
  delete f.data.results[path.relative(f.root, path.dirname(removed)).split(path.sep).join('/')];
  const replacement = Buffer.alloc(45, 90);
  fs.mkdirSync(path.dirname(changed), { recursive: true }); fs.writeFileSync(changed, replacement);
  f.data.results[path.relative(f.root, path.dirname(changed)).split(path.sep).join('/')].outputs['page-0.pml4'] = hash(replacement);
  f.originals.set(changed, replacement); f.save();
  const abandoned = 'pack-' + 'f'.repeat(16) + '-0.pmpk';
  fs.writeFileSync(path.join(f.root, abandoned), 'interrupted conversion');
  fs.writeFileSync(path.join(f.root, 'packed-images.json.stage-' + 'f'.repeat(16)), 'partial index');
  const result = await packCache(f.root, f.assets);
  assert.equal(result.files, 2);
  const current = await loadPackedCache(f.root, { assets: f.assets }, quiet);
  assert(!current.has(removed)); assert(!fs.existsSync(oldPack));
  assert(!fs.existsSync(path.join(f.root, abandoned)));
  assert(!fs.readdirSync(f.root).some(name => name.includes('.stage-')));
  for (const [name, entry] of current) {
    const bytes = fs.readFileSync(entry.pack).subarray(entry.offset, entry.offset + entry.size);
    assert.deepEqual(bytes, f.originals.get(name));
    await inspectPacked(entry, true);
  }
});

test('failed index publication preserves the previous readable pack and supports retry', async t => {
  const f = fixture(); await packCache(f.root, f.assets);
  const before = fs.readFileSync(path.join(f.root, 'packed-images.json'));
  const rename = t.mock.method(fs.promises, 'rename', async () => { throw new Error('publication failed'); });
  await assert.rejects(packCache(f.root, f.assets), /publication failed/);
  rename.mock.restore();
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'packed-images.json')), before);
  const entries = await loadPackedCache(f.root, { assets: f.assets }, quiet);
  for (const entry of entries.values()) await inspectPacked(entry, true);
  assert.equal(fs.readdirSync(f.root).filter(name => name.endsWith('.pmpk')).length, 1);
  assert.equal((await packCache(f.root, f.assets)).files, 3);
});

test('conversion interrupted after publication leaves a usable index and can finish on retry', async t => {
  const f = fixture();
  const unlink = fs.promises.unlink.bind(fs.promises);
  const failure = t.mock.method(fs.promises, 'unlink', async file => {
    if (f.originals.has(file)) throw new Error('cleanup failed');
    return unlink(file);
  });
  await assert.rejects(packCache(f.root, f.assets), /cleanup failed/);
  failure.mock.restore();
  const entries = await loadPackedCache(f.root, { assets: f.assets }, quiet);
  assert.equal(entries.size, 3);
  for (const entry of entries.values()) await inspectPacked(entry, true);
  assert.equal((await packCache(f.root, f.assets)).files, 3);
  for (const name of f.originals.keys()) assert(!fs.existsSync(name));
});

test('directory sync failures never remove the original representation', async t => {
  for (const failAt of [1, 2]) {
    const f = fixture(), open = fs.promises.open.bind(fs.promises);
    let syncs = 0;
    const failure = t.mock.method(fs.promises, 'open', async (file, ...args) => {
      const handle = await open(file, ...args);
      if (file !== f.root) return handle;
      return { close: () => handle.close(), sync: async () => {
        if (++syncs === failAt) throw new Error('directory sync failed');
        await handle.sync();
      } };
    });
    await assert.rejects(packCache(f.root, f.assets), /directory sync failed/);
    failure.mock.restore();
    for (const [name, bytes] of f.originals) assert.deepEqual(fs.readFileSync(name), bytes);
    if (failAt === 2) {
      const entries = await loadPackedCache(f.root, { assets: f.assets }, quiet);
      assert.equal(entries.size, 3);
      for (const entry of entries.values()) await inspectPacked(entry, true);
    } else assert(!fs.existsSync(path.join(f.root, 'packed-images.json')));
    assert.equal((await packCache(f.root, f.assets)).files, 3);
  }
});

test('writer rejects reader-incompatible index sizes before publication or deletion', async t => {
  const f = fixture(), stringify = JSON.stringify;
  const oversized = t.mock.method(JSON, 'stringify', (value, ...args) => {
    const serialized = stringify(value, ...args);
    return value?.version === 1 && Array.isArray(value.data?.packs) ? serialized + ' '.repeat(16 * 1024 * 1024) : serialized;
  });
  await assert.rejects(packCache(f.root, f.assets), /index exceeds limit/);
  oversized.mock.restore();
  assert(!fs.existsSync(path.join(f.root, 'packed-images.json')));
  assert(!fs.readdirSync(f.root).some(name => name.endsWith('.pmpk')));
  for (const [name, bytes] of f.originals) assert.deepEqual(fs.readFileSync(name), bytes);
  fs.writeFileSync(path.join(f.root, 'packed-images.json'), ' '.repeat(16 * 1024 * 1024 + 1));
  assert.equal(await loadPackedCache(f.root, { assets: f.assets }, quiet), null);
});

test('writer enforces the reader entry limit before opening outputs', async () => {
  const f = fixture(), outputs = {};
  for (let i = 0; i <= 100000; i++) outputs[`page-${i}.pml4`] = 'a'.repeat(64);
  f.data.results = { ['entries/' + 'a'.repeat(64)]: { outputs } }; f.save();
  await assert.rejects(packCache(f.root, f.assets), /too many packed images/);
  assert(!fs.existsSync(path.join(f.root, 'packed-images.json')));
  for (const [name, bytes] of f.originals) assert.deepEqual(fs.readFileSync(name), bytes);
});

test('pack replacement during native mounting rejects stale index metadata and clears the mapping', async () => {
  const f = fixture(); await packCache(f.root, f.assets);
  f.assets.installPackedFiles = files => {
    f.assets.installed = files;
    if (!files.length) return;
    const pack = files[0].pack, bytes = fs.readFileSync(pack);
    bytes[bytes.length - 1] ^= 1;
    fs.renameSync(pack, pack + '.old');
    fs.writeFileSync(pack, bytes);
  };
  const warnings = [];
  const result = await loadPackedCache(f.root, { assets: f.assets }, { info() {}, warn(message) { warnings.push(message); } });
  assert.equal(result, null);
  assert.deepEqual(f.assets.installed, []);
  assert(warnings.some(message => message.includes('changed during mounting')));
});
