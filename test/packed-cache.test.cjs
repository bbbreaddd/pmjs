'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { packCache, loadPackedCache, inspectPacked, repairPackedCache } = require('../runner/packed-cache.cjs');
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
async function fragmentedFixture() {
  const f = fixture();
  for (const [directory, record] of Object.entries(f.data.results)) {
    const bytes = fs.readFileSync(path.join(f.root, directory, 'page-0.pml4'));
    fs.writeFileSync(path.join(f.root, directory, 'page-1.pml4'), bytes);
    record.outputs['page-1.pml4'] = hash(bytes);
  }
  f.save();
  await packCache(f.root, f.assets, { maximumBytes: 80 });
  for (const record of Object.values(f.data.results)) delete record.outputs['page-1.pml4'];
  f.save();
  return f;
}

async function compactionFixture() {
  const f = fixture();
  for (let index = 0; index < 6; ++index) {
    const directory = 'entries/' + String(index).repeat(64), file = path.join(f.root, directory, 'page-0.pml4');
    const bytes = Buffer.alloc(20, index + 1);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    f.data.results[directory] = { outputs: { 'page-0.pml4': hash(bytes) } };
    f.originals.set(file, bytes);
  }
  f.save();
  await packCache(f.root, f.assets, { maximumBytes: 40 });
  return f;
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
  await assert.rejects(packCache(f.root, f.assets, { maximumBytes: 80 }), /publication failed/);
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

for (const scenario of [
  { name: 'FUSE inode drift', field: 'ino', type: 0x65735546, accepted: true },
  { name: 'ordinary filesystem inode change', field: 'ino', type: 0xef53 },
  { name: 'unknown filesystem inode change', field: 'ino', type: null },
  { name: 'FUSE timestamp change', field: 'mtimeNs', type: 0x65735546 }
]) test('packed index reuse: ' + scenario.name, async t => {
  const f = fixture();
  await packCache(f.root, f.assets);
  const indexPath = path.join(f.root, 'packed-images.json'), saved = fs.readFileSync(indexPath);
  const lstat = fs.promises.lstat.bind(fs.promises);
  t.mock.method(fs.promises, 'lstat', async (file, ...args) => {
    const stat = await lstat(file, ...args);
    if (String(file).endsWith('.pmpk')) stat[scenario.field] += 1n;
    return stat;
  });
  t.mock.method(fs, 'statfsSync', () => {
    if (scenario.type === null) throw new Error('unavailable');
    return { type: scenario.type };
  });
  const entries = await loadPackedCache(f.root, { assets: f.assets }, quiet);
  if (scenario.accepted) {
    assert.equal(entries.size, 3);
    for (const entry of entries.values()) await inspectPacked(entry, true);
  } else {
    assert.equal(entries, null);
    assert.deepEqual(f.assets.installed, []);
  }
  assert.deepEqual(fs.readFileSync(indexPath), saved, 'reading must not rewrite pack identities');
});

test('FUSE inode drift during mounting still rejects the mapping', async t => {
  const f = fixture();
  await packCache(f.root, f.assets);
  const lstat = fs.promises.lstat.bind(fs.promises);
  let drift = 1n;
  t.mock.method(fs.promises, 'lstat', async (file, ...args) => {
    const stat = await lstat(file, ...args);
    if (String(file).endsWith('.pmpk')) stat.ino += drift;
    return stat;
  });
  t.mock.method(fs, 'statfsSync', () => ({ type: 0x65735546 }));
  f.assets.installPackedFiles = files => { f.assets.installed = files; drift++; };
  assert.equal(await loadPackedCache(f.root, { assets: f.assets }, quiet), null);
  assert.deepEqual(f.assets.installed, []);
});

for (const repack of [false, true]) test((repack ? 'repacking' : 'conversion') + ' bounds temporary payload to one batch', async t => {
  const f = repack ? await fragmentedFixture() : fixture(), maximumBytes = 80;
  function payloadBytes() {
    let size = 0;
    for (const file of f.originals.keys()) if (fs.existsSync(file)) size += fs.statSync(file).size;
    for (const name of fs.readdirSync(f.root)) if (name.endsWith('.pmpk')) size += fs.statSync(path.join(f.root, name)).size;
    return size;
  }
  const baseline = payloadBytes();
  let peak = baseline, publications = 0;
  const open = fs.promises.open.bind(fs.promises), rename = fs.promises.rename.bind(fs.promises);
  t.mock.method(fs.promises, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (!String(file).endsWith('.pmpk') || args[0] !== 'wx') return handle;
    return { close: () => handle.close(), sync: () => handle.sync(), writeFile: async bytes => {
      await handle.writeFile(bytes);
      peak = Math.max(peak, payloadBytes());
    } };
  });
  t.mock.method(fs.promises, 'rename', async (from, to) => {
    await rename(from, to);
    if (to === path.join(f.root, 'packed-images.json')) publications++;
  });
  assert.equal((await packCache(f.root, f.assets, { maximumBytes })).files, 3);
  assert.equal(publications, 2);
  assert.ok(peak <= baseline + maximumBytes, `temporary payload grew by ${peak - baseline} bytes`);
  const entries = await loadPackedCache(f.root, { assets: f.assets }, quiet);
  for (const entry of entries.values()) await inspectPacked(entry, true);
  assert.equal(payloadBytes(), 114);
});

test('a later publication failure preserves completed batches and remaining loose inputs', async t => {
  const f = fixture(), rename = fs.promises.rename.bind(fs.promises);
  let publications = 0;
  const failure = t.mock.method(fs.promises, 'rename', async (from, to) => {
    if (to === path.join(f.root, 'packed-images.json') && ++publications === 2) throw new Error('later publication failed');
    return rename(from, to);
  });
  await assert.rejects(packCache(f.root, f.assets, { maximumBytes: 80 }), /later publication failed/);
  failure.mock.restore();
  const entries = await loadPackedCache(f.root, { assets: f.assets }, quiet);
  assert.equal(entries.size, 2);
  for (const [name, original] of f.originals) {
    if (entries.has(name)) {
      await inspectPacked(entries.get(name), true);
      assert.equal(fs.existsSync(name), false);
    } else assert.deepEqual(fs.readFileSync(name), original);
  }
  assert.equal(fs.readdirSync(f.root).filter(name => name.endsWith('.pmpk')).length, 1);
  assert.equal((await packCache(f.root, f.assets, { maximumBytes: 80 })).files, 3);
  const retried = await loadPackedCache(f.root, { assets: f.assets }, quiet);
  for (const entry of retried.values()) await inspectPacked(entry, true);
});

test('later repacking failure preserves unconverted old packs and completed replacements', async t => {
  const f = await fragmentedFixture();
  const before = await loadPackedCache(f.root, { assets: f.assets }, quiet);
  const oldPacks = new Set([...before.values()].map(item => item.pack));
  const rename = fs.promises.rename.bind(fs.promises);
  let publications = 0;
  const failure = t.mock.method(fs.promises, 'rename', async (from, to) => {
    if (to === path.join(f.root, 'packed-images.json') && ++publications === 2) throw new Error('later publication failed');
    return rename(from, to);
  });
  await assert.rejects(packCache(f.root, f.assets, { maximumBytes: 80 }), /later publication failed/);
  failure.mock.restore();
  const entries = await loadPackedCache(f.root, { assets: f.assets }, quiet);
  assert.equal(entries.size, 3);
  assert.equal([...oldPacks].filter(file => fs.existsSync(file)).length, 1);
  assert.equal(fs.readdirSync(f.root).filter(name => name.endsWith('.pmpk')).length, 2);
  for (const entry of entries.values()) await inspectPacked(entry, true);
  assert.equal((await packCache(f.root, f.assets, { maximumBytes: 80 })).files, 3);
});

test('splitting an old pack publishes all its replacement ranges before reclaiming it', async t => {
  const f = fixture();
  await packCache(f.root, f.assets);
  const previous = await loadPackedCache(f.root, { assets: f.assets }, quiet);
  const oldPack = previous.values().next().value.pack;
  const rename = fs.promises.rename.bind(fs.promises);
  let publications = 0;
  t.mock.method(fs.promises, 'rename', async (from, to) => {
    if (to === path.join(f.root, 'packed-images.json')) {
      assert.equal(fs.existsSync(oldPack), true);
      const record = JSON.parse(fs.readFileSync(from, 'utf8'));
      assert.equal(record.data.files.length, 3);
      assert.equal(record.data.packs.length, 3);
      publications++;
    }
    return rename(from, to);
  });
  const result = await packCache(f.root, f.assets, { maximumBytes: 40 });
  assert.equal(publications, 1);
  assert.equal(result.packs, 3);
  assert.equal(fs.existsSync(oldPack), false);
  const current = await loadPackedCache(f.root, { assets: f.assets }, quiet);
  for (const entry of current.values()) await inspectPacked(entry, true);
});

test('retry removes unreferenced crash output before staging another batch', async t => {
  const f = fixture();
  const orphan = path.join(f.root, 'pack-' + 'f'.repeat(16) + '-0.pmpk');
  const staged = path.join(f.root, 'packed-images.json.stage-' + 'f'.repeat(16));
  fs.writeFileSync(orphan, Buffer.alloc(80));
  fs.writeFileSync(staged, 'interrupted index');
  const open = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, 'open', async (file, ...args) => {
    if (String(file).endsWith('.pmpk') && args[0] === 'wx') {
      assert.equal(fs.existsSync(orphan), false);
      assert.equal(fs.existsSync(staged), false);
    }
    return open(file, ...args);
  });
  assert.equal((await packCache(f.root, f.assets, { maximumBytes: 80 })).files, 3);
});

test('unchanged conversion uses metadata without reading or rewriting payloads', async t => {
  const f = fixture();
  await packCache(f.root, f.assets, { maximumBytes: 80 });
  const before = fs.readFileSync(path.join(f.root, 'packed-images.json'));
  const open = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, 'open', async (file, ...args) => {
    assert.notEqual(args[0], 'wx', 'unchanged conversion must not stage pack or index output');
    assert.equal(String(file).endsWith('.pmpk'), false, 'unchanged conversion must not open packed payloads');
    return open(file, ...args);
  });
  assert.equal((await packCache(f.root, f.assets, { maximumBytes: 80 })).files, 3);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'packed-images.json')), before);
});

test('retry retains completed packs while converting only remaining loose files', async t => {
  const f = fixture(), rename = fs.promises.rename.bind(fs.promises);
  let publications = 0;
  const failure = t.mock.method(fs.promises, 'rename', async (from, to) => {
    if (to === path.join(f.root, 'packed-images.json') && ++publications === 2) throw new Error('interrupted');
    return rename(from, to);
  });
  await assert.rejects(packCache(f.root, f.assets, { maximumBytes: 80 }), /interrupted/);
  failure.mock.restore();
  const completed = JSON.parse(fs.readFileSync(path.join(f.root, 'packed-images.json'), 'utf8')).data.packs[0].name;
  const open = fs.promises.open.bind(fs.promises);
  let written = 0;
  t.mock.method(fs.promises, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (!String(file).endsWith('.pmpk') || args[0] !== 'wx') return handle;
    return { close: () => handle.close(), sync: () => handle.sync(), writeFile: async bytes => {
      written += bytes.length; await handle.writeFile(bytes);
    } };
  });
  await packCache(f.root, f.assets, { maximumBytes: 80 });
  assert.equal(written, 39);
  assert.equal(fs.existsSync(path.join(f.root, completed)), true);
});

for (const damage of ['missing', 'modified']) test('one ' + damage + ' pack preserves healthy mappings and repairs its index', async t => {
  const f = fixture();
  await packCache(f.root, f.assets, { maximumBytes: 80 });
  const indexPath = path.join(f.root, 'packed-images.json'), saved = fs.readFileSync(indexPath);
  const index = JSON.parse(saved), broken = path.join(f.root, index.data.packs[1].name);
  if (damage === 'missing') fs.unlinkSync(broken);
  else fs.appendFileSync(broken, 'damaged');
  const entries = await loadPackedCache(f.root, { assets: f.assets }, quiet);
  assert.equal(entries.size, 2);
  assert.equal(entries.damagedPacks.length, 1);
  assert.equal(f.assets.installed.length, 2);
  for (const entry of entries.values()) await inspectPacked(entry, true);
  const failure = t.mock.method(fs.promises, 'rename', async () => { throw new Error('repair interrupted'); });
  await assert.rejects(repairPackedCache(f.root, entries), /repair interrupted/);
  failure.mock.restore();
  assert.deepEqual(fs.readFileSync(indexPath), saved);
  await repairPackedCache(f.root, entries);
  const repaired = await loadPackedCache(f.root, { assets: f.assets }, quiet);
  assert.equal(repaired.size, 2);
  assert.equal(repaired.damagedPacks.length, 0);
});

test('pack damage during mounting preserves other packs', async () => {
  const f = fixture();
  await packCache(f.root, f.assets, { maximumBytes: 80 });
  const index = JSON.parse(fs.readFileSync(path.join(f.root, 'packed-images.json'), 'utf8'));
  let damaged = false;
  f.assets.installPackedFiles = files => {
    f.assets.installed = files;
    if (!damaged && files.length) {
      damaged = true;
      fs.unlinkSync(path.join(f.root, index.data.packs[1].name));
      throw new Error('cannot open prepared pack');
    }
  };
  const entries = await loadPackedCache(f.root, { assets: f.assets }, quiet);
  assert.equal(entries.size, 2);
  assert.equal(f.assets.installed.length, 2);
});

test('an installation error without pack damage is reported and clears the mapping', async () => {
  const f = fixture();
  await packCache(f.root, f.assets);
  const warnings = [];
  f.assets.installPackedFiles = files => {
    if (files.length) throw new Error('installation failed');
    f.assets.installed = files;
  };
  assert.equal(await loadPackedCache(f.root, { assets: f.assets }, { warn: message => warnings.push(message) }), null);
  assert.deepEqual(f.assets.installed, []);
  assert(warnings.some(message => message.includes('installation failed')));
});

test('explicit conversion verification reads all retained payloads and detects checksum failures', async t => {
  const f = fixture();
  await packCache(f.root, f.assets, { maximumBytes: 80 });
  const saved = fs.readFileSync(path.join(f.root, 'packed-images.json'));
  const open = fs.promises.open.bind(fs.promises);
  let readBytes = 0, corrupt = false;
  t.mock.method(fs.promises, 'open', async (file, ...args) => {
    assert.notEqual(args[0], 'wx', 'verification of intact packs must not rewrite them');
    const handle = await open(file, ...args);
    if (!String(file).endsWith('.pmpk')) return handle;
    const read = handle.read.bind(handle);
    handle.read = async (...input) => {
      const result = await read(...input);
      readBytes += result.bytesRead;
      if (corrupt && result.bytesRead) result.buffer[0] ^= 1;
      return result;
    };
    return handle;
  });
  await packCache(f.root, f.assets, { maximumBytes: 80, verifyHashes: true });
  assert.equal(readBytes, 114);
  corrupt = true;
  await assert.rejects(packCache(f.root, f.assets, { maximumBytes: 80, verifyHashes: true }), /checksum differs/);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'packed-images.json')), saved);
});

for (const compact of [false, true]) test((compact ? 'compaction rebuilds from' : 'duplicate cleanup protects') + ' a good loose copy when the pack is corrupt', async t => {
  const f = fixture();
  await packCache(f.root, f.assets);
  const entries = await loadPackedCache(f.root, { assets: f.assets }, quiet);
  const [file, bytes] = f.originals.entries().next().value;
  const damagedPack = entries.get(file).pack;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  const saved = fs.readFileSync(path.join(f.root, 'packed-images.json'));
  const open = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, 'open', async (name, ...args) => {
    const handle = await open(name, ...args);
    if (name !== damagedPack) return handle;
    const read = handle.read.bind(handle);
    handle.read = async (...input) => {
      const result = await read(...input);
      if (input[3] === 0 && result.bytesRead) result.buffer[0] ^= 1;
      return result;
    };
    return handle;
  });
  if (compact) {
    await packCache(f.root, f.assets, { compact: true });
    const after = await loadPackedCache(f.root, { assets: f.assets }, quiet);
    for (const entry of after.values()) await inspectPacked(entry, true);
    assert.equal(fs.existsSync(file), false);
  } else {
    await assert.rejects(packCache(f.root, f.assets), /checksum differs/);
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'packed-images.json')), saved);
  }
});

test('explicit compaction consolidates healthy packs while ordinary conversion retains them', async () => {
  const f = fixture();
  await packCache(f.root, f.assets, { maximumBytes: 40 });
  const saved = fs.readFileSync(path.join(f.root, 'packed-images.json'));
  assert.equal((await packCache(f.root, f.assets, { maximumBytes: 80 })).packs, 3);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'packed-images.json')), saved);
  const result = await packCache(f.root, f.assets, { maximumBytes: 80, compact: true });
  assert.equal(result.packs, 2);
  assert.equal(result.bytes, 114);
  const entries = await loadPackedCache(f.root, { assets: f.assets }, quiet);
  for (const entry of entries.values()) await inspectPacked(entry, true);
});

test('cross-pack compaction consolidates entries within one pack of temporary payload', async t => {
  const f = await compactionFixture();
  const payloadBytes = () => fs.readdirSync(f.root).filter(name => name.endsWith('.pmpk'))
    .reduce((sum, name) => sum + fs.statSync(path.join(f.root, name)).size, 0);
  const baseline = payloadBytes();
  let peak = baseline;
  const open = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, 'open', async (file, ...args) => {
    const handle = await open(file, ...args);
    if (!String(file).endsWith('.pmpk') || args[0] !== 'wx') return handle;
    return { close: () => handle.close(), sync: () => handle.sync(), writeFile: async bytes => {
      await handle.writeFile(bytes);
      peak = Math.max(peak, payloadBytes());
    } };
  });
  const result = await packCache(f.root, f.assets, { maximumBytes: 60, compact: true });
  assert.equal(result.packs, 2);
  assert.equal(result.bytes, 120);
  assert.ok(peak <= baseline + 60, `extra payload reached ${peak - baseline} bytes`);
  const entries = await loadPackedCache(f.root, { assets: f.assets }, quiet);
  for (const entry of entries.values()) await inspectPacked(entry, true);
});

test('interrupted tail relocation retains readable data and completed output', async t => {
  const f = await compactionFixture();
  const before = JSON.parse(fs.readFileSync(path.join(f.root, 'packed-images.json'), 'utf8'));
  const oldNames = new Set(before.data.packs.map(pack => pack.name));
  const rename = fs.promises.rename.bind(fs.promises);
  let publications = 0;
  const failure = t.mock.method(fs.promises, 'rename', async (from, to) => {
    if (to === path.join(f.root, 'packed-images.json') && ++publications === 2) throw new Error('tail publication failed');
    return rename(from, to);
  });
  await assert.rejects(packCache(f.root, f.assets, { maximumBytes: 60, compact: true }), /tail publication failed/);
  failure.mock.restore();
  const entries = await loadPackedCache(f.root, { assets: f.assets }, quiet);
  assert.equal(entries.size, 6);
  for (const entry of entries.values()) await inspectPacked(entry, true);
  const partial = JSON.parse(fs.readFileSync(path.join(f.root, 'packed-images.json'), 'utf8'));
  const completed = partial.data.packs.find(pack => !oldNames.has(pack.name)).name;
  await packCache(f.root, f.assets, { maximumBytes: 60 });
  assert.equal(fs.existsSync(path.join(f.root, completed)), true);
  assert.equal((await packCache(f.root, f.assets, { maximumBytes: 60, compact: true })).packs, 2);
  const repaired = await loadPackedCache(f.root, { assets: f.assets }, quiet);
  for (const entry of repaired.values()) await inspectPacked(entry, true);
});
