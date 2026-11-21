'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { preparationLocks } = require('./helpers/preparation-lock.cjs');
const { openPreparation } = require('../runner/preparation-state.cjs');

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fixture(data, checksum = hash(data)) {
  const root = temporaryDirectory('state-checksum-');
  const gameRoot = path.join(root, 'game'), cacheRoot = path.join(root, 'cache');
  fs.mkdirSync(gameRoot);
  const directory = path.join(cacheRoot, 'preparation-v1', hash(gameRoot).slice(0, 16));
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, 'preparation-state.json');
  fs.writeFileSync(filename, JSON.stringify({ version: 1, checksum, data }));
  return { filename, options: {
    gameRoot, cacheRoot, native: { assets: preparationLocks(), fs: { inventory: () => [] } },
    offline: true,
  } };
}

for (const [name, make, expectedHashes] of [
  ['canonical', () => ({ files: {}, results: {}, indices: { marker: 'kept' }, failures: {} }), 1],
  ['legacy missing failures', () => ({ files: {}, results: {}, indices: { marker: 'kept' } }), 2],
  ['reordered keys', () => ({ indices: { marker: 'kept' }, files: {}, results: {}, failures: {} }), 2],
  ['extra field', () => ({ files: {}, results: {}, indices: { marker: 'kept' }, failures: {}, extra: 'ignored' }), 2],
  ['falsy failures', () => ({ files: {}, results: {}, indices: { marker: 'kept' }, failures: null }), 2],
  ['truthy primitive failures', () => ({ files: {}, results: {}, indices: { marker: 'kept' }, failures: 'legacy' }), 1],
]) {
  test('state checksum reuse: ' + name, async () => {
    const { filename, options } = fixture(make());
    const original = fs.readFileSync(filename), createHash = crypto.createHash;
    let calls = 0;
    // Count only hashes of the fixture state, excluding cache-path and file hashes.
    crypto.createHash = function(...args) {
      const hash = createHash.apply(this, args), update = hash.update;
      hash.update = function(value, ...rest) {
        if (typeof value === 'string' && value.includes('"marker":"kept"')) ++calls;
        return update.call(this, value, ...rest);
      };
      return hash;
    };
    let session;
    try {
      session = await openPreparation(options);
      assert.equal(calls, expectedHashes);
      assert.equal(session.data.indices.marker, 'kept');
      crypto.createHash = createHash;
      session.markDirty();
      assert.equal(await session.checkpoint(), true);
      assert.deepEqual(fs.readFileSync(filename), original, 'unchanged state must not be rewritten');
      session.data.indices.marker = 'changed';
      session.markDirty();
      assert.equal(await session.checkpoint(), true);
      const changed = JSON.parse(fs.readFileSync(filename));
      assert.equal(changed.data.indices.marker, 'changed');
      assert.equal(changed.checksum, hash(changed.data));
    } finally {
      crypto.createHash = createHash;
      await session?.close();
    }
  });
}

test('canonical shape does not bypass invalid checksum rejection', async () => {
  const data = { files: {}, results: {}, indices: { marker: 'tampered' }, failures: {} };
  const { options } = fixture(data, '0'.repeat(64));
  const session = await openPreparation(options);
  try { assert.equal(session.data.indices.marker, undefined); }
  finally { await session.close(); }
});

test('inventory includes declared prepared sources while excluding generated cache outputs', async () => {
  const { inventory } = require('../runner/preparation-state.cjs');
  const root = temporaryDirectory('prepared-source-inventory-');
  const game = path.join(root, 'game'), cache = path.join(root, 'cache');
  const metadata = path.join(cache, 'metadata');
  const sources = new Map([
    ['data/System.json', path.join(metadata, 'data/System.json')],
    ['img/source.png', path.join(game, 'img/source.png')],
    ['img/cached.png', path.join(cache, 'entries/cached.png')]
  ]);
  const native = { fs: { inventory: () => [...sources.keys()] }, assets: { sourcePath: name => sources.get(name) } };
  assert.deepEqual(await inventory(game, native, cache, [game, metadata]), ['data/System.json', 'img/source.png']);
});
