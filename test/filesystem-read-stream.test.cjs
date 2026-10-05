'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { temporaryDirectory } = require('./helpers/temp.cjs');

const filename = path.resolve(__dirname, '../js/pmjs-web/filesystem.js');
function fixture(contents = Buffer.from('René')) {
  const tasks = [], reads = [], chunks = [];
  let started = false, closed = 0;
  function openRead(file, start) {
    reads.push(file);
    if (contents === null) return null;
    let offset = start, destroyed = false;
    return {
      read(size) {
        assert.equal(destroyed, false);
        chunks.push(size);
        const result = contents.subarray(offset, offset + size); offset += result.length; return result;
      },
      close() { assert.equal(destroyed, false); destroyed = true; closed++; }
    };
  }
  const context = vm.createContext({ Buffer, Error, __pmjsBuiltinRequire: require,
    NativeHost: { fs: { openRead }, storage: { openRead(file, start) { return openRead('save:' + file, start); } } },
    PMJS: { config: { virtualFiles: { extensionAliases: { '.txt': '.data' } } },
      tasks: { enqueue(callback) { if (started) setImmediate(callback); else tasks.push(callback); } } } });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context);
  return { guest: context.fsModule, paths: context.pathModule, reads, chunks, context,
    get closed() { return closed; },
    drain() { started = true; tasks.splice(0).forEach(task => task()); } };
}

const turn = () => new Promise(resolve => setImmediate(resolve));

async function observe(makeStream, start, destroyAt) {
  const events = [], stream = makeStream();
  for (const event of ['open', 'ready', 'data', 'end', 'error', 'close']) {
    stream.on(event, function(value) {
      assert.equal(this, stream);
      events.push(event === 'data' ? [event, String(value)] :
        event === 'error' ? [event, value.code || value.message] : [event]);
      if (event === destroyAt) { stream.destroy(); stream.destroy(); }
    });
  }
  await turn();
  start();
  await new Promise(resolve => stream.closed ? resolve() : stream.once('close', resolve));
  await turn();
  return { events, destroyed: stream.destroyed, readable: stream.readable };
}

test('read streams preserve virtual routing, encoding and normal Node event order', async () => {
  const root = temporaryDirectory('pmjs-read-stream-'), file = path.join(root, 'input');
  fs.writeFileSync(file, 'René');
  const reference = await observe(() => fs.createReadStream(file, { encoding: 'utf8' }), () => {});
  for (const route of ['/game/input.txt', '/save/input.txt']) {
    const f = fixture();
    assert.deepEqual(await observe(() => f.guest.createReadStream(route, { encoding: 'utf8' }), f.drain), reference);
    assert.deepEqual(f.reads, [route.startsWith('/save') ? 'save:input.txt' : 'input.data']);
  }
});

test('destruction in open, ready or data stops subsequent events and closes only once', async () => {
  const root = temporaryDirectory('pmjs-read-destroy-'), file = path.join(root, 'input');
  fs.writeFileSync(file, 'René');
  for (const event of ['open', 'ready', 'data']) {
    const reference = await observe(() => fs.createReadStream(file), () => {}, event);
    const f = fixture();
    const actual = await observe(() => f.guest.createReadStream('input'), f.drain, event);
    assert.deepEqual(actual, reference);
    assert.equal(actual.destroyed, true);
    assert.equal(actual.readable, false);
  }
});

test('destruction before the scheduled read prevents I/O and reports an optional error once', async () => {
  const f = fixture(), stream = f.guest.createReadStream('input');
  const events = [], failure = new Error('cancelled');
  stream.on('error', error => { assert.equal(error, failure); events.push('error'); });
  stream.on('close', () => events.push('close'));
  stream.destroy(failure); stream.destroy(failure);
  f.drain(); await turn();
  assert.deepEqual(f.reads, []);
  assert.deepEqual(events, ['error', 'close']);
});

test('missing-file errors match Node and retain the original error', async () => {
  const root = temporaryDirectory('pmjs-read-missing-');
  const reference = await observe(() => fs.createReadStream(path.join(root, 'missing')), () => {});
  const f = fixture(null);
  assert.deepEqual(await observe(() => f.guest.createReadStream('missing'), f.drain), reference);
});

test('empty files and paused streams use Node completion and buffering semantics', async () => {
  const f = fixture(Buffer.alloc(0));
  assert.deepEqual((await observe(() => f.guest.createReadStream('empty'), f.drain)).events,
    [['open'], ['ready'], ['end'], ['close']]);
  const paused = fixture(), stream = paused.guest.createReadStream('input');
  paused.drain(); await turn();
  assert.equal(stream.readableEnded, false);
  const data = [];
  stream.setEncoding('utf8');
  stream.on('data', chunk => data.push(chunk));
  await new Promise(resolve => stream.on('close', resolve));
  assert.deepEqual(data, ['René']);
});

test('unhandled read errors and guest callback exceptions surface as they do in Node', () => {
  for (const mode of ['missing', 'listener']) {
    const outcomes = [];
    for (const implementation of ['node', 'guest']) {
      const script = `
        const fs = require('node:fs'), vm = require('node:vm');
        const tasks = [];
        process.once('uncaughtException', error => {
          console.log(JSON.stringify({ message: error.code || error.message, fileErrors }));
          process.exit(0);
        });
        let fileErrors = 0, stream;
        if (${JSON.stringify(implementation)} === 'guest') {
          const c = vm.createContext({ Buffer, Error, __pmjsBuiltinRequire: require,
            NativeHost: { fs: { openRead() { return ${mode === 'missing' ? 'null' : "{ read() { return Buffer.from('data'); }, close() {} }"}; } } },
            PMJS: { config: {}, tasks: { enqueue(fn) { setImmediate(fn); } } } });
          vm.runInContext(fs.readFileSync(${JSON.stringify(filename)}, 'utf8'), c);
          stream = c.fsModule.createReadStream('missing');
        } else stream = fs.createReadStream(${mode === 'missing' ? JSON.stringify(path.join(__dirname, 'missing-stream-fixture')) : JSON.stringify(filename)});
        if (${JSON.stringify(mode)} === 'listener') {
          stream.on('error', () => fileErrors++);
          stream.on('data', () => { throw new Error('guest listener'); });
        } else stream.resume();
        setImmediate(() => tasks.forEach(task => task()));
      `;
      const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      outcomes.push(JSON.parse(result.stdout));
    }
    assert.deepEqual(outcomes[1], outcomes[0]);
    assert.equal(outcomes[0].fileErrors, 0);
  }
});

test('guest POSIX paths match Node with a virtual working directory', () => {
  const f = fixture();
  for (const parts of [[], [''], ['../img'], ['/save', 'file.rpgsave'], ['a', '/save', 'b'],
    ['/save', '../game/img'], ['a', '..', 'b'], ['/game', '/save/', './file'], ['a\\b']]) {
    assert.equal(f.paths.resolve(...parts), path.posix.resolve('/game', ...parts));
    assert.equal(f.paths.posix.resolve(...parts), path.posix.resolve('/game', ...parts));
    assert.equal(f.paths.join(...parts), path.posix.join(...parts));
  }
  for (const value of ['', '../img', '../../img/', '/', 'a/../../b', '.profile', 'a/b/', 'a\\b', 'a/../b'])
    for (const method of ['normalize', 'dirname', 'basename', 'extname'])
      assert.equal(f.paths[method](value), path.posix[method](value), method + ': ' + value);
  assert.equal(f.paths.relative('img', '/save/file'), '../../save/file');
  assert.throws(() => f.paths.normalize(1), error => error.code === 'ERR_INVALID_ARG_TYPE');
});

test('inclusive stream byte ranges and decoding match Node on both virtual backends', async () => {
  const root = temporaryDirectory('pmjs-stream-ranges-'), file = path.join(root, 'input');
  const bytes = Buffer.from('abé🌙cd'); fs.writeFileSync(file, bytes);
  for (const options of [{ start: 2, end: 3 }, { start: 0, end: 0 }, { start: 2 },
    { end: 0 }, { start: 100 }, { end: 100 }, { start: 3, end: 5, encoding: 'utf8' },
    { start: 2, end: 7, encoding: 'utf8', highWaterMark: 1 }]) {
    const reference = await observe(() => fs.createReadStream(file, options), () => {});
    for (const route of ['/game/input.txt', '/save/input.txt']) {
      const f = fixture(bytes);
      assert.deepEqual(await observe(() => f.guest.createReadStream(route, options), f.drain), reference);
      assert.equal(f.closed, 1);
    }
  }
  const f = fixture(Buffer.from('abcdef'));
  const route = f.paths.resolve('/save', 'input.txt');
  assert.deepEqual((await observe(() => f.guest.createReadStream(route, { start: 2, end: 3 }), f.drain)).events,
    [['open'], ['ready'], ['data', 'cd'], ['end'], ['close']]);
  assert.deepEqual(f.reads, ['save:input.txt']);
});

test('invalid stream ranges fail synchronously before opening a file', () => {
  const f = fixture();
  for (const options of [{ start: -1 }, { end: -1 }, { start: 1.5 }, { end: NaN },
    { start: Infinity }, { start: Number.MAX_SAFE_INTEGER + 1 }, { start: '2' },
    { end: null }, { start: 4, end: 3 }]) {
    let reference;
    try { fs.createReadStream('unused', options); } catch (error) { reference = error; }
    assert.ok(reference, JSON.stringify(options));
    assert.throws(() => f.guest.createReadStream('unused', options), error => error.code === reference.code);
  }
  assert.deepEqual(f.reads, []);
});

test('stream demand and backpressure bound reads and close the captured reader once', async () => {
  const f = fixture(Buffer.alloc(1024 * 1024, 97));
  const stream = f.guest.createReadStream('large', { highWaterMark: 16384 });
  assert.equal(stream.readableHighWaterMark, 16384);
  f.drain(); await turn();
  assert.deepEqual(f.chunks, [], 'opening a paused stream must not read the file');
  stream.read(1); await turn(); await turn();
  assert.ok(f.chunks.length > 0 && f.chunks.length <= 2);
  assert.ok(f.chunks.every(size => size <= 16384));
  assert.ok(stream.readableLength <= 16384);
  const closed = new Promise(resolve => stream.once('close', resolve));
  stream.destroy(); stream.destroy(); await closed; await turn();
  assert.equal(f.closed, 1);
  const defaultStream = f.guest.createReadStream('large');
  assert.equal(defaultStream.readableHighWaterMark, 65536);
  defaultStream.destroy();
});

test('configured missing text files retain byte ranges without ordinary full-file reads', async () => {
  const f = fixture(null); f.context.PMJS.config.missingTextFiles = { 'config.txt': 'abcdef' };
  assert.deepEqual((await observe(() => f.guest.createReadStream('/save/config.txt', { start: 2, end: 3 }), f.drain)).events,
    [['open'], ['ready'], ['data', 'cd'], ['end'], ['close']]);
});

test('chunk failures close the captured reader and report the original error', async () => {
  const f = fixture(); let closes = 0;
  const failure = Object.assign(new Error('read failed'), { code: 'EIO' });
  f.context.NativeHost.fs.openRead = () => ({ read() { throw failure; }, close() { closes++; } });
  assert.deepEqual((await observe(() => f.guest.createReadStream('input'), f.drain)).events,
    [['open'], ['ready'], ['error', 'EIO'], ['close']]);
  assert.equal(closes, 1);
});
