'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { checksum, publishCatalog, readCatalog } = require('../runner/preparation-catalog.cjs');

test('catalog publication validates integrity, version, binding and cache paths', async () => {
  const root = temporaryDirectory('pmjs-catalog-');
  const key = 'a'.repeat(64), file = path.join(root, 'catalog.json'), binding = { processor: 'v1' };
  const payload = { keys: [key], summary: { installed: 1 }, maps: [], index: {}, entries: [{ directory: path.join(root, 'entries', key),
    descriptor: { pages: [], cells: [], sources: [{ snapshot: path.join(root, 'maps/sources', key+'.png') }] } }] };
  await publishCatalog(file, binding, root, payload);
  assert.deepEqual(await readCatalog(file, binding, root), payload);
  assert.equal(await readCatalog(file, { processor: 'v2' }, root), null);
  const original = JSON.parse(await fs.readFile(file));
  for (const mutate of [c => { c.version++; }, c => { c.checksum = 'bad'; },
    c => { c.payload.entries[0].directory = '../outside'; c.checksum = checksum(c.payload); },
    c => { c.payload.entries[0].descriptor.sources[0].snapshot = '/tmp/page.png'; c.checksum = checksum(c.payload); }]) {
    const changed = structuredClone(original); mutate(changed);
    await fs.writeFile(file, JSON.stringify(changed));
    assert.equal(await readCatalog(file, binding, root), null);
  }
  await fs.writeFile(file+'.stage-'+process.pid, 'interrupted');
  await publishCatalog(file, binding, root, payload);
  assert.deepEqual(await readCatalog(file, binding, root), payload);
  assert.equal((await fs.readdir(root)).some(name => name.includes('.stage-')), false);
});
