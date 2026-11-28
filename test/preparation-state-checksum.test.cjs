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

test('valid preparation state is reused and unchanged state is not rewritten', async () => {
  const { filename, options } = fixture({
    files: {}, results: {}, indices: { marker: 'kept' }, failures: {},
  });
  const original = fs.readFileSync(filename);
  const beforeStat = fs.statSync(filename, { bigint: true });
  const session = await openPreparation(options);
  try {
    assert.equal(session.data.indices.marker, 'kept');
    session.markDirty();
    assert.equal(await session.checkpoint(), true);
    const afterStat = fs.statSync(filename, { bigint: true });
    assert.equal(afterStat.ino, beforeStat.ino, 'unchanged state must not be rewritten');
    assert.equal(afterStat.mtimeNs, beforeStat.mtimeNs, 'unchanged state must not be rewritten');
    assert.deepEqual(fs.readFileSync(filename), original, 'unchanged state must not be rewritten');
    session.data.indices.marker = 'changed';
    session.markDirty();
    assert.equal(await session.checkpoint(), true);
    const changed = JSON.parse(fs.readFileSync(filename));
    assert.equal(changed.data.indices.marker, 'changed');
    assert.equal(changed.checksum, hash(changed.data));
  } finally {
    await session.close();
  }
});

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
