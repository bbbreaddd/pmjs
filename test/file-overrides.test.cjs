'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function fixture(t) {
  const files = new Map([
    ['js/plugins/example.js', 'globalThis.pluginVersion = "base";'],
    ['js/plugins/example.mod', 'globalThis.pluginVersion = "mod";'],
    ['data/example.json', '{"version":"base"}'],
    ['data/example.pack', '{"version":"mod"}'],
  ]);
  const reads = [];
  const bytes = name => {
    reads.push(name);
    const value = files.get(name.toLowerCase());
    return value === undefined ? null : Buffer.from(value);
  };
  const context = vm.createContext({ Buffer, performance, TextDecoder, console,
    __pmjsBuiltinRequire: require, document: {}, PMJS: { config: { virtualFiles: {
      extensionAliases: { '.pack': '.json' },
      directoryEntryAliases: { data: { '.json': '.pack' } },
      overrides: { 'js/plugins': { '.js': '.mod' }, data: { '.json': '.pack', '.pack': '.pack' } },
    } } }, NativeHost: {
      fs: {
        exists: name => files.has(name.toLowerCase()),
        readBytes: bytes,
        readText: name => { const value = bytes(name); return value === null ? null : value.toString(); },
        readBytesAsync: name => Promise.resolve(bytes(name)),
      },
      runtime: { scheduling: require('node:timers'),
        loadScript(name) { vm.runInContext(bytes(name).toString(), context, { filename: name }); },
        runScript(source) { vm.runInContext(source, context); },
      },
    } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../runner/file-overrides.cjs'), 'utf8'), context);
  for (const name of ['filesystem', 'scheduler', 'events', 'requests', 'script-loader']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web', name + '.js'), 'utf8'), context);
  }
  t.after(() => context.PMJS.tasks.stop());
  return { context, files, reads };
}

test('configured overrides win without replacing base files or rewriting script contents', t => {
  const { context: c, files, reads } = fixture(t);
  c.NativeHost.runtime.loadScript('js/plugins/Example.js');
  assert.equal(c.pluginVersion, 'mod');
  assert.equal(reads.at(-1), 'js/plugins/Example.mod');
  assert.equal(JSON.parse(c.fsModule.readFileSync('/game/data/Example.pack', 'utf8')).version, 'mod');
  assert.equal(JSON.parse(c.fsModule.readFileSync('/game/data/Example.json', 'utf8')).version, 'mod');
  assert.equal(files.get('data/example.json'), '{"version":"base"}');
  files.delete('data/example.pack');
  assert.equal(JSON.parse(c.fsModule.readFileSync('/game/data/Example.pack', 'utf8')).version, 'base');
  files.delete('js/plugins/example.mod');
  c.NativeHost.runtime.loadScript('js/plugins/Example.js');
  assert.equal(c.pluginVersion, 'base');
});

test('a failing override reports its error instead of executing the base script', t => {
  const { context: c, files } = fixture(t);
  files.set('js/plugins/example.mod', 'throw new Error("broken mod");');
  assert.throws(() => c.NativeHost.runtime.loadScript('js/plugins/Example.js'), /broken mod/);
  assert.equal(c.pluginVersion, undefined);
  assert.equal(c.document.currentScript, null);
});

test('fetch, synchronous XHR and asynchronous XHR select the same override', async t => {
  const { context: c } = fixture(t);
  assert.equal((await (await c.fetch('file:///game/data/Example.json')).json()).version, 'mod');
  for (const async of [false, true]) for (const binary of [false, true]) {
    const xhr = new c.XMLHttpRequest();
    const loaded = new Promise((resolve, reject) => { xhr.onload = resolve; xhr.onerror = reject; });
    xhr.open('GET', 'file:///game/data/Example.json', async);
    if (binary) xhr.responseType = 'arraybuffer';
    xhr.send(); await loaded;
    assert.equal(xhr.status, 200);
    assert.equal(JSON.parse(binary ? Buffer.from(xhr.response).toString() : xhr.responseText).version, 'mod');
  }
});

test('directory aliases do not expose a base file and its override twice', t => {
  const { context: c } = fixture(t);
  assert.deepEqual(Array.from(c.gameDirectoryEntries('/game/data',
    ['Example.json', 'Example.pack', 'Other.json'])), ['Example.pack', 'Other.pack']);
  assert.equal(c.gameReadPath('other/Example.json'), 'other/Example.json');
  assert.equal(c.gameReadPath('data/../other/Example.json'), 'other/Example.json');
});

test('file selection preserves opaque bytes independently of their extension', t => {
  const { context: c, files } = fixture(t);
  const encoded = Buffer.from([0, 255, 128, 1, 2, 3]);
  files.set('data/example.pack', encoded);
  assert.deepEqual(c.fsModule.readFileSync('/game/data/Example.json'), encoded);
  assert.deepEqual(c.fsModule.readFileSync('/game/data/Example.pack'), encoded);
});
