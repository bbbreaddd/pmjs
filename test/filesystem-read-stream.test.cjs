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
  const tasks = [], reads = [];
  const context = vm.createContext({ Buffer, Error, __pmjsBuiltinRequire: require,
    NativeHost: {
      fs: { readBytes(file) { reads.push(file); return contents; } },
      storage: { readBytes(file) { reads.push('save:' + file); return contents; } }
    }, PMJS: { config: { virtualFiles: { extensionAliases: { '.txt': '.data' } } },
      tasks: { enqueue(callback) { tasks.push(callback); } } } });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context);
  return { guest: context.fsModule, reads, drain() { tasks.splice(0).forEach(task => task()); } };
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
            NativeHost: { fs: { readBytes() { return ${mode === 'missing' ? 'null' : "Buffer.from('data')"}; } } },
            PMJS: { config: {}, tasks: { enqueue(fn) { tasks.push(fn); } } } });
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
