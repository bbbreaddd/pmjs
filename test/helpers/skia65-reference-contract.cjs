'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { cases } = require('./skia65-text-scenario.cjs');
const root = path.resolve(__dirname, '../..');
const sources = {
  generatorSha256: 'tools/generate-skia65-reference.cjs',
  readbackSha256: 'tools/skia65/reference-readback.cjs',
  scenarioSha256: 'test/helpers/skia65-text-scenario.cjs',
};
function validate(fixture) {
  assert.equal(fixture.reference.chromium, '65.0.3325.146');
  assert.equal(fixture.reference.nwVersion, '0.29.0');
  assert.equal(fixture.reference.archiveSha256, 'f6b759cbe0f2b57082ff08d63350be2e73bbf1a44717137fece0c13d048ff14b');
  assert.equal(fixture.reference.referenceFiles.nw, '0c99f7355109513384f386bd6bff014d9c89d011b3eeb5690cae4da56b2aca73');
  assert.equal(fixture.freshProcessReplays, 2);
  assert.equal(fixture.frozenFramesEqual, true);
  for (const [key, file] of Object.entries(sources)) {
    const current = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
    assert.equal(fixture[key], current, 'Stale Skia65 reference: ' + file + '; regenerate explicitly');
  }
  assert.deepEqual(fixture.cases, cases, 'Skia65 reference scenario changed; regenerate explicitly');
  const expected = cases.flatMap(item => ['fill', 'outline', 'full'].map(layer => item.name + '/' + layer)).sort();
  assert.deepEqual(fixture.records.map(row => row.name + '/' + row.layer).sort(), expected,
    'Skia65 reference must contain every layer exactly once');
  for (const row of fixture.records) {
    const item = cases.find(item => item.name === row.name);
    assert.equal(Buffer.from(row.pixels, 'base64').length, item.width * item.height * 4);
    assert.ok(Number.isFinite(row.width));
  }
}
module.exports = { validate };
