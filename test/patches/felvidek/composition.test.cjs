'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { temporaryDirectory } = require('../../helpers/temp.cjs');
const { buildPortPreparation, discoverAdapterProcessors, verifyPortDescriptor } = require('../../../runner/port-preparation.cjs');
const directory = path.resolve(__dirname, '../../../patches/felvidek');
const inventory = require('../../../patches/felvidek/entry.json').modules;
const adapters = inventory.map(file => path.join(directory, file));

test('the collision processor is discovered and packaged through the existing adapter mechanism', () => {
  const processor = path.join(directory, 'collision-map.pmjs-processor.cjs');
  assert.deepEqual(discoverAdapterProcessors([]), []);
  assert.deepEqual(discoverAdapterProcessors(adapters), [processor]);
  const bundleRoot = temporaryDirectory('pmjs-felvidek-processor-');
  const records = buildPortPreparation({ bundleRoot, adapters });
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'felvidek-collision');
  assert.deepEqual(fs.readFileSync(path.join(bundleRoot, records[0].processor)), fs.readFileSync(processor));
  assert.equal(verifyPortDescriptor(bundleRoot, records).size, 0);
});
