'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const zlib = require('node:zlib');

test('guest zlib aliases inflate real buffers and preserve decompression errors', () => {
  const context = vm.createContext({ PMJS: { config: {} }, Buffer, __pmjsBuiltinRequire: require,
    nativePlatform: { platform: 'linux', arch: process.arch }, NativeHost: { runtime: {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web/modules.js'), 'utf8'), context);
  const source = Buffer.from('globalThis.loadedFromCompressedScript = true;');
  for (const name of ['zlib', 'node:zlib']) {
    const guest = context.require(name);
    assert.deepEqual(guest.inflateSync(zlib.deflateSync(source)), source);
    assert.throws(() => guest.inflateSync(Buffer.from('invalid')), { code: 'Z_DATA_ERROR' });
  }
});
