'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { createGameFilesystem, createStorage } = require('../runner/storage.cjs');
const native = require(process.env.PMJS_NATIVE_ADDON || path.resolve(__dirname, '../build/pmjs_native.node'));

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-game-files-base-'));
const gameRoot = path.join(base, 'game');
fs.mkdirSync(path.join(gameRoot, 'data'), { recursive: true });
fs.writeFileSync(path.join(gameRoot, 'data/Original.txt'), 'original');
fs.writeFileSync(path.join(gameRoot, 'data/Keep.txt'), 'keep');
native.initialize({ gameRoot, width: 32, height: 32, windowTitle: 'Writable filesystem' });
test.after(() => { native.runtime.quit(); fs.rmSync(base, { recursive: true, force: true }); });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-game-files-'));
  const overlay = path.join(root, 'save/game-files');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const host = createGameFilesystem(native.fs, overlay);
  const context = vm.createContext({ Buffer, TextDecoder, performance: { now: () => 0 },
    PMJS: { config: {} }, NativeHost: { fs: host, storage: createStorage(path.join(root, 'save')) } });
  for (const name of ['events', 'scheduler', 'filesystem', 'requests']) {
    const filename = path.resolve(__dirname, '../js/pmjs-web', name + '.js');
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }
  return { root, gameRoot, overlay, host, context, guest: context.fsModule,
    restart() { return createGameFilesystem(native.fs, overlay); } };
}

test('binary and encoded writes match Node and are visible to fs, fetch and XHR', async t => {
  const { guest, context, host, gameRoot, root } = fixture(t);
  const source = Buffer.from([9, 0, 127, 128, 255, 195, 40, 8]).subarray(1, 7);
  const reference = path.join(root, 'reference');
  fs.writeFileSync(reference, source); guest.writeFileSync('/game/data/Binary.bin', source);
  assert.deepEqual(guest.readFileSync('data/binary.BIN'), fs.readFileSync(reference));
  assert.deepEqual(Buffer.from(host.readBytes('DATA/Binary.bin')), source);
  const promise = context.fetch('data/Binary.bin'); context.PMJS.tasks.drain();
  assert.deepEqual(Buffer.from(await (await promise).arrayBuffer()), source);
  const request = new context.XMLHttpRequest();
  request.open('GET', 'data/Binary.bin', false); request.responseType = 'arraybuffer'; request.send();
  assert.equal(request.status, 200); assert.deepEqual(Buffer.from(request.response), source);
  for (const encoding of ['utf8', 'hex', 'base64']) {
    const value = encoding === 'utf8' ? 'René' : source.toString(encoding);
    fs.writeFileSync(reference, value, encoding);
    guest.writeFileSync('data/Encoded.txt', value, { encoding });
    assert.deepEqual(guest.readFileSync('data/Encoded.txt'), fs.readFileSync(reference));
  }
  assert.equal(fs.existsSync(path.join(gameRoot, 'data/Binary.bin')), false);
});

test('copy-on-write replaces originals, merges listings and preserves case-insensitive aliases', t => {
  const { guest, host, gameRoot, restart } = fixture(t);
  guest.writeFileSync('DATA/original.TXT', 'replacement');
  guest.writeFileSync('data/ORIGINAL.txt', 'latest');
  assert.equal(host.readText('data/Original.txt'), 'latest');
  assert.deepEqual(guest.readdirSync('data').map(value => value.toLowerCase()).sort(), ['keep.txt', 'original.txt']);
  assert.equal(guest.statSync('data/ORIGINAL.txt').isDirectory(), false);
  assert.equal(fs.readFileSync(path.join(gameRoot, 'data/Original.txt'), 'utf8'), 'original');
  assert.equal(restart().readText('DATA/ORIGINAL.TXT'), 'latest');
});

test('unlink hides original and copied-up files persistently, then allows recreation', t => {
  const { guest, host, restart, gameRoot } = fixture(t);
  guest.unlinkSync('data/Original.txt');
  assert.equal(host.exists('data/Original.txt'), false);
  assert.throws(() => guest.readFileSync('data/Original.txt'), { code: 'ENOENT' });
  assert.deepEqual(guest.readdirSync('data'), ['Keep.txt']);
  assert.equal(restart().exists('data/Original.txt'), false);
  guest.writeFileSync('data/Original.txt', 'new');
  assert.equal(host.readText('data/Original.txt'), 'new');
  guest.unlinkSync('data/Original.txt');
  assert.equal(restart().exists('data/Original.txt'), false);
  assert.equal(fs.readFileSync(path.join(gameRoot, 'data/Original.txt'), 'utf8'), 'original');
  assert.throws(() => guest.unlinkSync('missing'), { code: 'ENOENT' });
  assert.throws(() => guest.unlinkSync('data'), { code: 'EISDIR' });
});

test('mkdir and file errors match the Node scenarios; writes cannot escape the overlay', t => {
  const { guest, host, root, gameRoot } = fixture(t);
  for (const operation of [
    api => api.writeFileSync('missing/file', 'x'),
    api => api.mkdirSync('missing/child'),
    api => api.mkdirSync('data'),
    api => api.writeFileSync('data', 'x'),
    api => api.mkdirSync('data/Original.txt/child', { recursive: true })
  ]) {
    const reference = {
      writeFileSync: (name, ...args) => fs.writeFileSync(path.join(gameRoot, name), ...args),
      mkdirSync: (name, ...args) => fs.mkdirSync(path.join(gameRoot, name), ...args)
    };
    let expected; try { operation(reference); } catch (error) { expected = error.code; }
    assert.ok(expected); assert.throws(() => operation(guest), { code: expected });
  }
  guest.mkdirSync('new/nested', { recursive: true });
  guest.mkdirSync('new/nested', { recursive: true });
  guest.writeFileSync('new/nested/result', 'okay');
  assert.equal(host.readText('new/nested/result'), 'okay');
  assert.throws(() => host.writeBytes('../../escape', Buffer.from('x')), /invalid game write path/);
  assert.equal(fs.existsSync(path.join(root, 'escape')), false);
  assert.throws(() => guest.renameSync('data/Keep.txt', '/save/moved'), { code: 'EXDEV' });
});

test('rename copies the merged directory tree and persists source deletion without modifying originals', t => {
  const { guest, host, restart, gameRoot } = fixture(t);
  guest.writeFileSync('data/Original.txt', 'updated');
  guest.writeFileSync('data/Extra.txt', 'extra');
  guest.unlinkSync('data/Keep.txt');
  guest.renameSync('data', 'moved');
  assert.equal(host.exists('data'), false);
  assert.deepEqual(guest.readdirSync('moved'), ['Extra.txt', 'Original.txt']);
  assert.equal(host.readText('moved/Original.txt'), 'updated');
  assert.equal(restart().exists('data'), false);
  assert.equal(host.readText('moved/Extra.txt'), 'extra');
  guest.renameSync('moved/Original.txt', 'moved/Extra.txt');
  assert.equal(host.readText('moved/Extra.txt'), 'updated');
  assert.equal(host.exists('moved/Original.txt'), false);
  guest.mkdirSync('data');
  assert.deepEqual(guest.readdirSync('data'), [], 'recreated deleted directory stays opaque');
  assert.equal(fs.readFileSync(path.join(gameRoot, 'data/Original.txt'), 'utf8'), 'original');
  assert.equal(fs.readFileSync(path.join(gameRoot, 'data/Keep.txt'), 'utf8'), 'keep');
});

test('rename validation preserves the source on invalid destination and matches Node errors', t => {
  const { guest, host, gameRoot } = fixture(t);
  for (const [from, to] of [['missing', 'destination'], ['data', 'data/child'],
    ['data/Original.txt', 'data'], ['data', 'data/Original.txt']]) {
    let expected; try { fs.renameSync(path.join(gameRoot, from), path.join(gameRoot, to)); }
    catch (error) { expected = error.code; }
    assert.ok(expected); assert.throws(() => guest.renameSync(from, to), { code: expected });
  }
  assert.equal(host.readText('data/Original.txt'), 'original');
  guest.renameSync('data/Original.txt', 'result');
  assert.equal(host.readText('result'), 'original');
  assert.equal(host.exists('data/Original.txt'), false);
});

test('native image decoding reads a generated file through the shared VFS', async t => {
  const { guest } = fixture(t);
  const png = Buffer.from(fs.readFileSync(path.join(__dirname, 'assets/fixture.png.b64'), 'utf8'), 'base64');
  guest.writeFileSync('generated.png', png);
  const image = await native.images.loadAsync('generated.png');
  assert.equal(image.width, 2); assert.equal(image.height, 2);
  native.images.release(image.handle);
});

test('async writes preserve callback ordering and report failures without losing the previous file', t => {
  const { guest, context, host } = fixture(t);
  const calls = [];
  guest.writeFile('result', 'success', error => calls.push(error));
  assert.deepEqual(calls, []); context.PMJS.tasks.drain(); assert.deepEqual(calls, [null]);
  guest.writeFile('missing/result', 'failure', error => calls.push(error.code));
  context.PMJS.tasks.drain(); assert.deepEqual(calls, [null, 'ENOENT']);
  assert.equal(host.readText('result'), 'success');
});
