'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { adoptInstalledLease } = require('../runner/preparation-lifetime.cjs');

test('installed lease adoption deduplicates warm loads and protects prior lazy readers', async () => {
  const root = temporaryDirectory('installed-lease-'), assets = {};
  const keys = ['a'.repeat(64), 'b'.repeat(64)];
  const leases = () => fs.readdirSync(root).filter(name => name.startsWith('.lease-'));
  let release;
  for (const generation of [[keys[0]], [keys[0]], [keys[0]], [keys[1]]]) {
    release = await adoptInstalledLease(assets, root, generation);
    assert.equal(leases().length, 1);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, leases()[0]))).keys, keys);
  release();
  assert.equal(leases().length, 0);
});
