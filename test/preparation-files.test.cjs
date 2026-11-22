'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { preparationFiles } = require('../runner/preparation-files.cjs');
const copyFiles = () => preparationFiles({ data: { files: {} }, checkpoint: async () => {} });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('concurrent verification owns its read buffers and returned headers survive reuse', async () => {
  const root = temporaryDirectory('concurrent-verification-'), files = await copyFiles();
  const sources = [73, 84, 105].map((value, index) => {
    const name = path.join(root, String(index)), bytes = Buffer.alloc(700 * 1024, value);
    fs.writeFileSync(name, bytes);
    return { name, bytes };
  });
  const checked = await Promise.all(sources.slice(0, 2).map(source => files.inspect(source.name)));
  await files.inspect(sources[2].name);
  checked.forEach((result, index) => {
    assert.equal(result.hash, hash(sources[index].bytes));
    assert.deepEqual(result.header, sources[index].bytes.subarray(0, 32));
    assert.ok(result.header.buffer.byteLength < sources[index].bytes.length);
  });
});

test('failed reads do not publish receipts and a subsequent verification succeeds', async t => {
  const root = temporaryDirectory('failed-verification-'), source = path.join(root, 'source');
  const bytes = Buffer.alloc(700 * 1024, 73);
  fs.writeFileSync(source, bytes);
  const files = await copyFiles(), open = fs.promises.open;
  let interrupt = true;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args), read = handle.read.bind(handle);
    handle.read = async (...values) => {
      if (interrupt) { interrupt = false; throw new Error('read interrupted'); }
      return read(...values);
    };
    return handle;
  });
  await assert.rejects(files.inspect(source), /read interrupted/);
  assert.deepEqual(files.receipts, {});
  assert.equal((await files.inspect(source)).hash, hash(bytes));
});

test('synchronous verification retains an owned small header rather than the source buffer', async () => {
  const root = temporaryDirectory('verified-header-'), source = path.join(root, 'source');
  const bytes = Buffer.alloc(4 * 1024 * 1024, 73);
  fs.writeFileSync(source, bytes);
  const files = await copyFiles(), checked = files.inspectSync(source, bytes);
  assert.equal(checked.hash, hash(bytes));
  assert.equal(checked.header.length, 32);
  assert.ok(checked.header.buffer.byteLength < bytes.byteLength, 'a header must not pin the full source allocation');
  bytes.fill(0);
  const reused = await files.inspect(source);
  assert.equal(reused.reused, true);
  assert.deepEqual(reused.header, Buffer.alloc(32, 73), 'caller mutation must not change the verified header');
});

test('verified copies publish without rereading staged or published bytes and invalidate on edits', async () => {
  const root = temporaryDirectory('verified-copy-'), source = path.join(root, 'source');
  const stage = path.join(root, 'stage'), published = path.join(root, 'published');
  fs.mkdirSync(stage);
  const bytes = Buffer.alloc(700 * 1024, 73); fs.writeFileSync(source, bytes);
  const files = await copyFiles(), expected = hash(bytes);
  const checked = await files.copyVerified(source, path.join(stage, 'page'), expected);
  assert.equal(checked.size, bytes.length);
  assert.equal(await files.hash(path.join(stage, 'page')), expected);
  await files.publish(stage, published);
  assert.equal(await files.hash(path.join(published, 'page')), expected);
  assert.equal(files.stats.hashedBytes, bytes.length, 'one streaming pass across copy and publication');
  assert.equal(files.stats.copiedBytes, bytes.length);
  fs.appendFileSync(path.join(published, 'page'), 'damage');
  assert.notEqual(await files.hash(path.join(published, 'page')), expected);
});

test('replacement of a staged object cannot inherit its verification receipt', async () => {
  const root = temporaryDirectory('copy-replacement-'), source = path.join(root, 'source');
  const stage = path.join(root, 'stage'), published = path.join(root, 'published');
  fs.writeFileSync(source, 'original');
  const files = await copyFiles(), expected = hash('original');
  await files.copyVerified(source, stage, expected);
  fs.writeFileSync(stage + '.replacement', 'replaced'); fs.renameSync(stage + '.replacement', stage);
  await files.publish(stage, published);
  assert.notEqual(await files.hash(published), expected);
  assert.equal(files.stats.publicationReuses, 0);
});

test('an in-root symlink replaced with an escaping target during hashing is rejected', async t => {
  const root = temporaryDirectory('symlink-replacement-'), gameRoot = path.join(root, 'game');
  fs.mkdirSync(gameRoot);
  const target = path.join(gameRoot, 'target'), link = path.join(gameRoot, 'image.png');
  const outside = path.join(root, 'outside');
  fs.writeFileSync(target, 'inside'); fs.writeFileSync(outside, 'outside'); fs.symlinkSync(target, link);
  const session = { gameRoot, data: { files: {} }, checkpoint: async () => {} };
  const files = await preparationFiles(session), realpath = fs.promises.realpath;
  let checks = 0;
  t.mock.method(fs.promises, 'realpath', async (...args) => {
    if (path.resolve(String(args[0])) === link && ++checks === 2) {
      fs.unlinkSync(link); fs.symlinkSync(outside, link);
    }
    return realpath(...args);
  });
  await assert.rejects(files.inspect(link), /preparation input changed while verifying/);
  assert.equal(Object.hasOwn(files.receipts, link), false);
});

test('checksum mismatch and failed publication never create a verified published object', async () => {
  const root = temporaryDirectory('copy-failure-'), source = path.join(root, 'source');
  const stage = path.join(root, 'stage'); fs.writeFileSync(source, 'original');
  const files = await copyFiles();
  await assert.rejects(files.copyVerified(source, stage, hash('wrong')), /checksum differs/);
  assert.equal(fs.existsSync(stage), false);
  await files.copyVerified(source, stage, hash('original'));
  await assert.rejects(files.publish(stage, path.join(root, 'missing', 'published')), /ENOENT/);
  assert.equal(fs.existsSync(stage), true);
  const destination = path.join(root, 'destination'); fs.writeFileSync(destination, 'keep');
  await assert.rejects(files.copyVerified(source, destination, hash('original')), /EEXIST/);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'keep');
});

for (const mode of ['mutate', 'replace', 'interrupt', 'replace-output']) test('copy rejects ' + mode + ' during streaming', async t => {
  const root = temporaryDirectory('copy-mutation-'), source = path.join(root, 'source'), target = path.join(root, 'stage');
  const bytes = Buffer.alloc(700 * 1024, 73); fs.writeFileSync(source, bytes);
  const files = await copyFiles(), open = fs.promises.open;
  let changed = false;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args);
    if (args[0] === target) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async chunk => {
        await write(chunk);
        if (changed) return;
        changed = true;
        if (mode === 'interrupt') throw new Error('interrupted');
        if (mode === 'mutate') fs.appendFileSync(source, 'mutation');
        else {
          const file = mode === 'replace' ? source : target;
          fs.writeFileSync(file + '.replacement', bytes); fs.renameSync(file + '.replacement', file);
        }
      };
    }
    return handle;
  });
  await assert.rejects(files.copyVerified(source, target, hash(bytes)), /changed|differs|interrupted/);
  assert.equal(fs.existsSync(target), false);
});

for (const mode of ['async', 'sync']) for (const scenario of [
  { name: 'FUSE inode drift', field: 'ino', type: 0x65735546, reused: true },
  { name: 'ordinary filesystem inode change', field: 'ino', type: 0xef53 },
  { name: 'FUSE modification time change', field: 'mtimeNs', type: 0x65735546 },
  { name: 'FUSE change time change', field: 'ctimeNs', type: 0x65735546 },
  { name: 'FUSE birth time change', field: 'birthtimeNs', type: 0x65735546 },
  { name: 'FUSE size change', field: 'size', type: 0x65735546 },
  { name: 'FUSE device change', field: 'dev', type: 0x65735546 },
  { name: 'FUSE full verification', field: 'ino', type: 0x65735546, verify: true },
  { name: 'unavailable filesystem type', field: 'ino', type: null },
  { name: 'malformed saved inode', field: 'ino', type: 0x65735546, malformed: true },
]) test(mode + ' receipt reuse: ' + scenario.name, async t => {
  const root = temporaryDirectory('receipt-inode-'), file = path.join(root, 'source');
  const bytes = Buffer.from('unchanged asset');
  fs.writeFileSync(file, bytes);
  let dirty = 0;
  const session = { data: { files: {} }, markDirty() { dirty++; }, checkpoint: async () => {} };
  const initial = await preparationFiles(session);
  await initial.inspect(file);
  const receipt = session.data.files[file];
  dirty = 0;
  if (scenario.malformed) {
    const fields = receipt.identity.split(':'); fields[1] = 'invalid';
    receipt.identity = fields.join(':');
  }
  const stat = fs.lstatSync(file, { bigint: true });
  const changed = { ...stat, [scenario.field]: stat[scenario.field] + 1n, isFile: () => true, isSymbolicLink: () => false };
  t.mock.method(fs.promises, 'lstat', async () => changed);
  t.mock.method(fs.promises, 'stat', async () => changed);
  t.mock.method(fs, 'lstatSync', () => changed);
  t.mock.method(fs, 'statfsSync', () => {
    if (scenario.type === null) throw new Error('unavailable');
    return { type: scenario.type };
  });
  const files = await preparationFiles(session, scenario.verify);
  const checked = mode === 'sync' ? files.inspectSync(file, bytes) : await files.inspect(file);
  assert.equal(checked.hash, hash(bytes));
  assert.equal(files.stats.hashedFiles, scenario.reused ? 0 : 1);
  assert.equal(files.stats.reusedFiles, scenario.reused ? 1 : 0);
  if (scenario.reused) {
    assert.equal(session.data.files[file], receipt, 'inode drift must not rewrite the state');
    assert.equal(dirty, 0);
  }
});

for (const mode of ['async', 'sync']) test(mode + ' symlink receipts retain strict inode checks on FUSE', async t => {
  const root = temporaryDirectory('receipt-symlink-'), file = path.join(root, 'source'), link = path.join(root, 'link');
  const bytes = Buffer.from('unchanged asset'); fs.writeFileSync(file, bytes); fs.symlinkSync(file, link);
  const session = { gameRoot: root, data: { files: {} }, checkpoint: async () => {} };
  await (await preparationFiles(session)).inspect(link);
  const before = fs.statSync(file, { bigint: true });
  const changed = { ...before, ino: before.ino + 1n, isFile: () => true };
  t.mock.method(fs.promises, 'stat', async () => changed);
  t.mock.method(fs, 'statSync', () => changed);
  t.mock.method(fs, 'statfsSync', () => ({ type: 0x65735546 }));
  const files = await preparationFiles(session);
  if (mode === 'sync') files.inspectSync(link, bytes);
  else await files.inspect(link);
  assert.equal(files.stats.hashedFiles, 1);
  assert.equal(files.stats.reusedFiles, 0);
});
