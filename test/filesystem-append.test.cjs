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

test('XHR resolves runtime file URLs to real filesystem paths in both modes', async t => {
  const { context } = fixture(), reads = [];
  Object.assign(context, { performance, console, TextDecoder });
  context.PMJS.config.virtualFiles = { extensionAliases: { '.json': '.dat' } };
  const read = file => { reads.push(file); return file === 'data/a b.json' ? '{"found":true}' : null; };
  context.NativeHost.fs = {
    readText: read,
    readBytesAsync: file => { const text = read(file); return Promise.resolve(text === null ? null : Buffer.from(text)); }
  };
  for (const module of ['scheduler', 'events', 'requests']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web', module + '.js'), 'utf8'), context);
  }
  t.after(() => context.PMJS.tasks.stop());
  for (const async of [false, true]) {
    const request = new context.XMLHttpRequest();
    const done = new Promise((resolve, reject) => { request.onload = resolve; request.onerror = reject; });
    request.open('GET', 'file:///game/data/a%20b.json?ignored#fragment', async);
    request.send();
    await done;
    assert.equal(request.status, 200);
    assert.deepEqual(JSON.parse(request.responseText), { found: true });
  }
  assert.deepEqual(reads, ['data/a b.json', 'data/a b.json']);
});


test('map filename fallback preserves reads, responses and events in both XHR modes', async t => {
  const { context } = fixture(), reads = [];
  Object.assign(context, { performance, console, TextDecoder });
  let available;
  const read = file => { reads.push(file); return file === available ? '{"found":true}' : null; };
  context.NativeHost.fs = {
    readText: read,
    readBytes: file => { const value = read(file); return value === null ? null : Buffer.from(value); },
    readBytesAsync: file => Promise.resolve(context.NativeHost.fs.readBytes(file))
  };
  for (const module of ['scheduler', 'events', 'requests'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web', module + '.js'), 'utf8'), context);
  t.after(() => context.PMJS.tasks.stop());
  for (const async of [false, true]) for (const binary of [false, true]) for (const entry of [
    { url: 'root/maps/Map001.json', available: 'root/maps/Map001.json', paths: ['root/maps/Map001.json'] },
    { url: 'root/maps/Map001.json', available: 'root/maps/map001.json', paths: ['root/maps/Map001.json', 'root/maps/map001.json'] },
    { url: 'root/MAPS/MAP001.JSON', available: 'root/maps/map001.json', paths: ['root/MAPS/MAP001.JSON', 'root/maps/map001.json'] },
    { url: 'root/maps/Map001.json', paths: ['root/maps/Map001.json', 'root/maps/map001.json'] },
    { url: 'root/maps/map001.json', paths: ['root/maps/map001.json', 'root/maps/map001.json'] },
    { url: 'data/missing.json', paths: ['data/missing.json'] }
  ]) {
    reads.length = 0;
    available = entry.available;
    const request = new context.XMLHttpRequest(), events = [];
    const done = new Promise(resolve => { request.onloadend = () => { events.push('end'); resolve(); }; });
    request.onreadystatechange = () => events.push(request.readyState);
    request.onload = () => events.push('load');
    request.onerror = () => events.push('error');
    request.open('GET', entry.url, async);
    if (binary) request.responseType = 'arraybuffer';
    request.send();
    await done;
    assert.deepEqual(reads, entry.paths);
    const found = entry.available !== undefined;
    assert.equal(request.status, found ? 200 : 404);
    assert.deepEqual(events, [1, ...(async && found ? [2, 3] : []), 4, found ? 'load' : 'error', 'end']);
    if (found) assert.equal(binary ? new TextDecoder().decode(request.response) : request.responseText, '{"found":true}');
  }
});

test('an aborted map read cannot retry or overwrite a reused XHR', async t => {
  const { context } = fixture(), reads = [];
  Object.assign(context, { performance, console, TextDecoder });
  let resolveRead, notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  context.NativeHost.fs = {
    readBytesAsync(file) {
      reads.push(file);
      return new Promise(resolve => { resolveRead = resolve; notifyStarted(); });
    },
    readText(file) { reads.push(file); return 'replacement'; }
  };
  for (const module of ['scheduler', 'events', 'requests'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web', module + '.js'), 'utf8'), context);
  t.after(() => context.PMJS.tasks.stop());
  const request = new context.XMLHttpRequest(), events = [];
  request.onabort = () => events.push('abort');
  request.onload = () => events.push('load');
  request.onerror = () => events.push('error');
  request.onloadend = () => events.push('end');
  request.open('GET', 'root/maps/Map001.json', true); request.send();
  await started;
  request.abort();
  request.open('GET', 'data/replacement.json', false); request.send();
  resolveRead(null);
  await new Promise(setImmediate);
  assert.deepEqual(reads, ['root/maps/Map001.json', 'data/replacement.json']);
  assert.deepEqual(events, ['abort', 'end', 'load', 'end']);
  assert.equal(request.status, 200);
  assert.equal(request.readyState, request.DONE);
  assert.equal(request.responseText, 'replacement');
});

test('empty fetch returns a complete empty response without reading the filesystem', async () => {
  const { context } = fixture();
  Object.assign(context, { performance, console, TextDecoder });
  context.NativeHost.fs = { readBytesAsync() { throw new Error('unexpected file read'); } };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web/events.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web/requests.js'), 'utf8'), context);
  const response = await context.fetch('');
  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.equal(response.statusText, 'OK');
  assert.equal(response.url, '');
  assert.equal(response.headers.get('content-type'), null);
  assert.equal(await response.text(), '');
  assert.equal((await response.arrayBuffer()).byteLength, 0);
  await assert.rejects(response.json(), { name: 'SyntaxError' });
});
