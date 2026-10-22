'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { createStorage } = require('../runner/storage.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');

function fixture() {
  const root = temporaryDirectory('pmjs-append-');
  const storage = createStorage(root);
  const context = vm.createContext({ Buffer, __pmjsBuiltinRequire: require, NativeHost: { storage }, PMJS: { config: {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web/filesystem.js'), 'utf8'), context);
  return { root, storage, guest: context.fsModule, context };
}

test('append creates missing files and preserves bytes across encoded and binary appends', () => {
  const { root, storage, guest } = fixture();
  const reference = path.join(root, 'reference');
  const operations = [['René\n', 'utf8'], ['ff0080', { encoding: 'hex' }],
    [Uint8Array.from([8, 7, 6, 5]).subarray(1, 3)], ['fin', 'latin1']];
  for (const args of operations) {
    fs.appendFileSync(reference, ...args);
    guest.appendFileSync('/save/log.txt', ...args);
    assert.deepEqual(guest.readFileSync('/save/log.txt'), fs.readFileSync(reference));
  }
  assert.deepEqual(Buffer.from(storage.readBytes('log.txt')), fs.readFileSync(reference));
});

test('append propagates direct write failures without erasing existing data', () => {
  const { storage, guest } = fixture();
  guest.writeFileSync('/save/log', 'retained');
  const failure = Object.assign(new Error('storage failed'), { code: 'EIO' });
  const write = storage.writeBytes;
  storage.writeBytes = () => { throw failure; };
  assert.throws(() => guest.appendFileSync('/save/log', 'new'), error => error === failure);
  storage.writeBytes = write;
  assert.equal(storage.readText('log'), 'retained');
});

test('append avoids reading existing save files and preserves virtual initial contents', () => {
  const { storage, guest, context } = fixture();
  guest.writeFileSync('/save/existing', 'large existing value');
  const read = storage.readBytes;
  storage.readBytes = () => { throw new Error('existing file should use direct append'); };
  guest.appendFileSync('/save/existing', '+tail');
  storage.readBytes = read;
  assert.equal(storage.readText('existing'), 'large existing value+tail');

  context.PMJS.config.missingTextFiles = { 'virtual.txt': 'configured initial value' };
  guest.appendFileSync('/save/virtual.txt', '+tail');
  assert.equal(storage.readText('virtual.txt'), 'configured initial value+tail');
});


test('resource URL decoding preserves path policy and decodes exactly once', () => {
  const { context } = fixture();
  for (const [url, expected] of [
    ['audio/Town%20Bell.ogg?v=2', 'audio/Town Bell.ogg'],
    ['img/%E6%97%A5.png', 'img/日.png'],
    ['100%.png', '100%.png'], ['bad%2.png', 'bad%2.png'],
    ['bad%ZZ.png', 'bad%ZZ.png'], ['%25.png', '%.png'],
    ['%2520.png', '%20.png'], ['a+b.png', 'a+b.png'],
    ['a%3Fb.png?ignored', 'a?b.png'], ['a.png?%FF', 'a.png'],
    ['a.png#fragment', 'a.png#fragment'],
    ['file%3A%2F%2F%2Fgame%2Fa.png', 'file:///game/a.png'],
    ['../a.png', '../a.png'], ['/game/a.png', '/game/a.png'],
    ['./a.png', './a.png']
  ]) assert.equal(context.decodeResourceUrlPath(url), expected, url);
  for (const url of ['%FF', '%C3', '%C3%28', '%ED%A0%80']) {
    assert.throws(() => context.decodeResourceUrlPath(url), /URI malformed/);
  }
});

test('fetch and XMLHttpRequest preserve their separate URL and alias policies', async t => {
  const { context } = fixture(), reads = [];
  Object.assign(context, { performance, console, TextDecoder });
  context.PMJS.config.virtualFiles = { extensionAliases: { '.json': '.dat' } };
  context.NativeHost.fs = {
    readBytesAsync(file) { reads.push(file); return Promise.resolve(Buffer.from('{}')); },
    readText(file) { reads.push(file); return '{}'; }
  };
  for (const module of ['scheduler', 'events', 'requests']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web', module + '.js'), 'utf8'), context);
  }
  t.after(() => context.PMJS.tasks.stop());
  assert.equal((await context.fetch('file:///game/data/a%20b.json?ignored')).status, 200);
  assert.equal((await context.fetch('file%3A%2F%2F%2Fgame%2Fdata%2Fa.json')).status, 200);
  const request = new context.XMLHttpRequest();
  request.open('GET', './data/a%2520b.json?ignored', false);
  request.send();
  assert.equal(request.status, 200);
  assert.deepEqual(reads, ['data/a b.dat', 'file:/game/data/a.dat', 'data/a%20b.json']);
  await assert.rejects(context.fetch('data/%FF.json'), /URI malformed/);
  await assert.rejects(context.fetch('https://example.test/%FF'), /network fetch is unavailable/);
  let errors = 0;
  request.onerror = () => { errors++; };
  request.open('GET', 'data/%FF.json', false); request.send();
  assert.equal(request.status, 404);
  assert.equal(errors, 1);
  assert.equal(reads.length, 3);
});
