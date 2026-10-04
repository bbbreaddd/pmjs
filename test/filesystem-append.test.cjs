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
  const context = vm.createContext({ Buffer, NativeHost: { storage }, PMJS: { config: {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web/filesystem.js'), 'utf8'), context);
  return { root, storage, guest: context.fsModule };
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

test('append propagates read/write failures without erasing existing data', () => {
  const { storage, guest } = fixture();
  guest.writeFileSync('/save/log', 'retained');
  const failure = Object.assign(new Error('storage failed'), { code: 'EIO' });
  const read = storage.readBytes;
  storage.readBytes = () => { throw failure; };
  assert.throws(() => guest.appendFileSync('/save/log', 'new'), error => error === failure);
  storage.readBytes = read;
  const write = storage.writeBytes;
  storage.writeBytes = () => { throw failure; };
  assert.throws(() => guest.appendFileSync('/save/log', 'new'), error => error === failure);
  storage.writeBytes = write;
  assert.equal(storage.readText('log'), 'retained');
});
