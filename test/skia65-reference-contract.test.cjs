'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');
const { validate } = require('./helpers/skia65-reference-contract.cjs');
const read = () => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'assets/reference/skia65-text.json.gz'))));
test('Skia65 fixtures enforce current owned source identities and complete scenarios', () => {
  validate(read());
  for (const key of ['generatorSha256', 'readbackSha256', 'scenarioSha256']) {
    const fixture = read(); fixture[key] = 'stale';
    assert.throws(() => validate(fixture), /Stale Skia65 reference/);
  }
  const changed = read(); changed.cases[0].x++;
  assert.throws(() => validate(changed), /scenario changed/);
  const missing = read(); missing.records.pop();
  assert.throws(() => validate(missing), /every layer exactly once/);
  const duplicate = read(); duplicate.records[0] = duplicate.records[1];
  assert.throws(() => validate(duplicate), /every layer exactly once/);
});
