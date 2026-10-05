'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { createGameFilesystem, createStorage } = require('../runner/storage.cjs');
const native = require(process.env.PMJS_NATIVE_ADDON || path.resolve(__dirname, '../build/pmjs_native.node'));

const base = temporaryDirectory('pmjs-game-files-base-');
const gameRoot = path.join(base, 'game');
fs.mkdirSync(path.join(gameRoot, 'data'), { recursive: true });
fs.writeFileSync(path.join(gameRoot, 'data/Original.txt'), 'original');
fs.writeFileSync(path.join(gameRoot, 'data/Keep.txt'), 'keep');
native.initialize({ gameRoot, width: 32, height: 32, windowTitle: 'Writable filesystem' });
test.after(() => { native.runtime.quit(); fs.rmSync(base, { recursive: true, force: true }); });

function fixture(t) {
  const root = temporaryDirectory('pmjs-game-files-');
  const overlay = path.join(root, 'save/game-files');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const host = createGameFilesystem(native.fs, overlay);
  const context = vm.createContext({ Buffer, TextDecoder, __pmjsBuiltinRequire: require, performance: { now: () => 0 },
    PMJS: { config: {} }, NativeHost: { fs: host, storage: createStorage(path.join(root, 'save')) } });
  for (const name of ['events', 'scheduler', 'filesystem', 'requests']) {
    const filename = path.resolve(__dirname, '../js/pmjs-web', name + '.js');
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }
  return { root, gameRoot, overlay, host, context, guest: context.fsModule,
    restart() { return createGameFilesystem(native.fs, overlay); } };
}

test('native readers capture originals and overlays and close descriptors', t => {
  const { host } = fixture(t), files = () => fs.readdirSync('/proc/self/fd').length;
  const before = files(), original = host.openRead('DATA/Original.TXT', 2);
  host.writeBytes('data/Original.txt', Buffer.from('changed'));
  const overlay = host.openRead('data/original.txt', 1);
  assert.equal(files(), before + 2);
  host.writeBytes('data/Original.txt', Buffer.from('replacement')); host.remove('data/Original.txt');
  assert.equal(Buffer.from(original.read(3)).toString(), 'igi');
  assert.equal(Buffer.from(overlay.read(2)).toString(), 'ha');
  assert.equal(Buffer.from(overlay.read(100)).toString(), 'nged');
  assert.equal(overlay.read(1).length, 0);
  original.close(); overlay.close(); overlay.close();
  assert.equal(files(), before);
  assert.equal(host.openRead('data/Original.txt'), null);
  assert.equal(host.openRead('../escape'), null);
  assert.throws(() => host.openRead('data'), error => error.code === 'EISDIR');
  assert.throws(() => overlay.read(1), error => error.code === 'EBADF');
});

test('native and save reader finalizers close abandoned descriptors', () => {
  const script = `
    const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const native = require(${JSON.stringify(process.env.PMJS_NATIVE_ADDON || path.resolve(__dirname, '../build/pmjs_native.node'))});
    const { createStorage } = require(${JSON.stringify(path.resolve(__dirname, '../runner/storage.cjs'))});
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-reader-gc-'));
    fs.writeFileSync(path.join(root, 'input'), 'abcdef');
    native.initialize({ gameRoot: root, assetRoot: '', width: 16, height: 16, windowTitle: 'reader finalizers' });
    const storage = createStorage(root), files = () => fs.readdirSync('/proc/self/fd').length;
    async function main() {
      for (const host of [native.fs, storage]) {
        const before = files();
        for (let i = 0; i < 8; i++) host.openRead('input').read(1);
        assert.equal(files(), before + 8);
        global.gc(); await new Promise(setImmediate);
        global.gc(); await new Promise(setImmediate);
        assert.equal(files(), before);
      }
    }
    main().catch(error => { console.error(error); process.exitCode = 1; })
      .finally(() => { native.runtime.quit(); fs.rmSync(root, { recursive: true, force: true }); });
  `;
  const result = spawnSync(process.execPath, ['--expose-gc', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('guest streams range and decode captured game and save files with bounded reads', async t => {
  const { context, guest } = fixture(t);
  context.PMJS.tasks.enqueue = callback => setImmediate(callback);
  const bytes = Buffer.concat([Buffer.from('abé🌙cd'), Buffer.alloc(256 * 1024, 97)]);
  for (const route of ['/game/data/stream', '/save/stream']) {
    guest.writeFileSync(route, bytes);
    const stream = guest.createReadStream(route, { start: 2, end: 7, encoding: 'utf8', highWaterMark: 1 });
    stream.on('open', () => guest.writeFileSync(route, 'replacement'));
    let output = '';
    for await (const chunk of stream) output += chunk;
    assert.equal(output, 'é🌙');
    assert.equal(guest.readFileSync(route, 'utf8'), 'replacement');
    guest.writeFileSync(route, bytes);
    const sizes = [];
    for await (const chunk of guest.createReadStream(route)) sizes.push(chunk.length);
    assert.equal(sizes.reduce((sum, size) => sum + size, 0), bytes.length);
    assert.ok(sizes.every(size => size <= 65536));
  }
});

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

test('file and directory stat predicates match Node for game files, overlays and saves', t => {
  const { guest, gameRoot, root } = fixture(t);
  guest.writeFileSync('data/new.txt', 'overlay');
  const overlayReference = path.join(root, 'node-overlay.txt');
  fs.writeFileSync(overlayReference, 'overlay');
  guest.mkdirSync('/save/nested', { recursive: true });
  guest.writeFileSync('/save/nested/save.txt', 'save');
  for (const [name, physical] of [
    ['data/Keep.txt', path.join(gameRoot, 'data/Keep.txt')],
    ['data/new.txt', overlayReference],
    ['data', path.join(gameRoot, 'data')],
    ['/save', path.join(root, 'save')],
    ['/save/nested', path.join(root, 'save/nested')],
    ['/save/nested/save.txt', path.join(root, 'save/nested/save.txt')]
  ]) {
    const actual = guest.statSync(name), expected = fs.statSync(physical);
    assert.equal(actual.isFile(), expected.isFile(), name);
    assert.equal(actual.isDirectory(), expected.isDirectory(), name);
  }
  assert.throws(() => guest.statSync('/save/missing'), { code: 'ENOENT' });
  assert.throws(() => guest.statSync('data/missing'), { code: 'ENOENT' });
});

test('append copies up original files and preserves the merged contents across restart', t => {
  const { guest, host, gameRoot, restart } = fixture(t);
  guest.appendFileSync('data/Original.txt', '\nfirst');
  guest.appendFileSync('DATA/ORIGINAL.TXT', Buffer.from([0, 255]));
  const expected = Buffer.concat([Buffer.from('original\nfirst'), Buffer.from([0, 255])]);
  assert.deepEqual(guest.readFileSync('data/Original.txt'), expected);
  assert.deepEqual(Buffer.from(restart().readBytes('data/Original.txt')), expected);
  assert.equal(fs.readFileSync(path.join(gameRoot, 'data/Original.txt'), 'utf8'), 'original');
  guest.appendFileSync('data/new.log', 'created');
  assert.equal(host.readText('data/new.log'), 'created');
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

test('a rename interrupted after destination installation recovers on remount', t => {
  const { guest, overlay, restart, host } = fixture(t);
  const original = fs.renameSync;
  fs.renameSync = function(from, to) {
    original(from, to);
    if (path.basename(from) === 'value' && to.endsWith('/moved')) {
      throw new Error('simulated interruption after destination rename');
    }
  };
  try { assert.throws(() => guest.renameSync('data', 'moved'), /simulated interruption/); }
  finally { fs.renameSync = original; }
  assert.equal(fs.existsSync(path.join(overlay, 'rename.json')), true);
  restart();
  assert.equal(host.exists('data'), false);
  assert.equal(host.readText('moved/Original.txt'), 'original');
  assert.equal(host.readText('moved/Keep.txt'), 'keep');
  assert.equal(fs.existsSync(path.join(overlay, 'rename.json')), false);
});

test('remount removes orphan staging and preserves the journaled rename until recovery', t => {
  const { overlay, restart, host } = fixture(t);
  for (const name of ['rename-Orphan', 'rename-Partial', 'rename-Active']) {
    fs.mkdirSync(path.join(overlay, name));
    fs.writeFileSync(path.join(overlay, name, 'value'), name);
  }
  fs.mkdirSync(path.join(overlay, 'other-work'));
  fs.writeFileSync(path.join(overlay, 'rename.json'), JSON.stringify({
    source: 'data/Original.txt', destination: 'recovered', directory: false, staging: 'rename-Active'
  }));
  restart();
  assert.equal(host.readText('recovered'), 'rename-Active');
  assert.equal(host.exists('data/Original.txt'), false);
  assert.equal(fs.existsSync(path.join(overlay, 'rename.json')), false);
  assert.equal(fs.existsSync(path.join(overlay, 'other-work')), true);
  assert.equal(fs.readdirSync(overlay).some(name => /^rename-/.test(name)), false);
  fs.mkdirSync(path.join(overlay, 'rename-WithoutJournal'));
  restart();
  assert.equal(fs.existsSync(path.join(overlay, 'rename-WithoutJournal')), false);
});

test('invalid rename intent fails visibly before orphan cleanup', t => {
  const { overlay, restart } = fixture(t);
  fs.mkdirSync(path.join(overlay, 'rename-Retained'));
  fs.writeFileSync(path.join(overlay, 'rename.json'), JSON.stringify({
    source: 'data', destination: 'moved', directory: true, staging: '../escape'
  }));
  assert.throws(restart, /invalid game filesystem rename journal/);
  assert.equal(fs.existsSync(path.join(overlay, 'rename-Retained')), true);
  for (const intent of [null, false, {}, { source: 'data', destination: 'moved', staging: 'rename-Retained' }]) {
    fs.writeFileSync(path.join(overlay, 'rename.json'), JSON.stringify(intent));
    assert.throws(restart, /invalid game filesystem rename journal/);
    assert.equal(fs.existsSync(path.join(overlay, 'rename-Retained')), true);
  }
});

test('long logical paths remain deletable and deleted after remount', t => {
  const { guest, host, restart } = fixture(t);
  const directory = 'x'.repeat(80), name = directory + '/' + 'y'.repeat(80);
  guest.mkdirSync(directory);
  guest.writeFileSync(name, 'long path');
  guest.unlinkSync(name);
  assert.equal(restart().exists(name), false);
  guest.writeFileSync(name, 'recreated');
  assert.equal(host.readText(name), 'recreated');
});

test('failed atomic file replacement keeps the previous content and removes its temporary file', t => {
  const { guest, host, overlay } = fixture(t);
  guest.writeFileSync('result', 'previous');
  const original = fs.renameSync;
  fs.renameSync = function(from, to) {
    if (to === path.join(overlay, 'files/result')) throw new Error('simulated write failure');
    return original(from, to);
  };
  try { assert.throws(() => guest.writeFileSync('result', 'lost'), /simulated write failure/); }
  finally { fs.renameSync = original; }
  assert.equal(host.readText('result'), 'previous');
  assert.deepEqual(fs.readdirSync(path.join(overlay, 'files')), ['result']);
});

function coloredPng(width, color) {
  return require('./helpers/png.cjs').png(width, 1,
    Buffer.from(Array.from({ length: width * 4 }, (_, i) => color[i % 4])));
}
function imagePixel(image, x = 0) {
  const canvas = native.canvas.create(image.width, image.height);
  try {
    native.canvas.drawImage(canvas.handle, image.handle, 0, 0, image.width, image.height,
      0, 0, image.width, image.height, 1);
    return Array.from(native.canvas.readPixels(canvas.handle, x, 0, 1, 1));
  } finally { native.canvas.release(canvas.handle); }
}

test('image replacement admits current pixels and preserves retained and lazy old owners', async t => {
  const { guest } = fixture(t);
  guest.writeFileSync('versioned.png', coloredPng(1, [255, 0, 0, 255]));
  const old = native.images.load('versioned.png');
  const retained = await native.images.loadAsync('versioned.png', true);
  assert.equal(retained.handle, old.handle);
  guest.writeFileSync('versioned.png', coloredPng(2, [0, 0, 255, 255]));
  const current = await native.images.loadAsync('versioned.png', true);
  try {
    assert.notEqual(current.handle, old.handle);
    assert.equal(current.width, 2); assert.equal(old.width, 1);
    assert.deepEqual(imagePixel(old), [255, 0, 0, 255]);
    assert.deepEqual(imagePixel(retained), [255, 0, 0, 255]);
    assert.deepEqual(imagePixel(current, 1), [0, 0, 255, 255]);
  } finally { for (const image of [old, retained, current]) native.images.release(image.handle); }
});

test('lazy image CPU pixels retain their upload after replacement, deletion and recreation', t => {
  const { guest } = fixture(t);
  guest.writeFileSync('lazy.png', coloredPng(1, [255, 0, 0, 255]));
  const old = native.images.load('lazy.png');
  guest.writeFileSync('lazy.png', coloredPng(2, [0, 0, 255, 255]));
  const second = native.images.load('lazy.png');
  guest.unlinkSync('lazy.png');
  assert.throws(() => native.images.load('lazy.png'), /cannot load image/);
  guest.writeFileSync('lazy.png', coloredPng(3, [0, 255, 0, 255]));
  const current = native.images.load('lazy.png');
  try {
    assert.equal(current.width, 3);
    assert.deepEqual(imagePixel(old), [255, 0, 0, 255]);
    assert.deepEqual(imagePixel(second, 1), [0, 0, 255, 255]);
    assert.deepEqual(imagePixel(current, 2), [0, 255, 0, 255]);
    for (let frame = 0; frame < 62; frame++) { native.beginFrame(); native.renderScene(); }
    assert.deepEqual(imagePixel(old), [255, 0, 0, 255], 'expiration of the CPU cache cannot reopen the replaced file');
  } finally { for (const image of [old, second, current]) native.images.release(image.handle); }
});

test('replacement during pending image loads preserves each file version and coalesces only matching sources', async t => {
  const { guest } = fixture(t);
  guest.writeFileSync('pending.png', coloredPng(1, [255, 0, 0, 255]));
  const before = native.images.memory(0);
  const first = native.images.loadAsync('pending.png');
  const alias = native.images.loadAsync('PENDING.png', true);
  guest.writeFileSync('pending.png', coloredPng(2, [0, 0, 255, 255]));
  const replacement = native.images.loadAsync('pending.png');
  const queued = native.images.memory(0);
  assert.equal(queued.decodeJobs - before.decodeJobs, 2);
  assert.equal(queued.coalescedRequests - before.coalescedRequests, 1);
  const [old, shared, current] = await Promise.all([first, alias, replacement]);
  try {
    assert.equal(old.handle, shared.handle); assert.notEqual(old, shared);
    assert.notEqual(old.handle, current.handle);
    assert.equal(old.width, 1); assert.equal(current.width, 2);
    assert.deepEqual(imagePixel(old), [255, 0, 0, 255]);
    assert.deepEqual(imagePixel(current, 1), [0, 0, 255, 255]);
  } finally { for (const image of [old, shared, current]) native.images.release(image.handle); }
});
