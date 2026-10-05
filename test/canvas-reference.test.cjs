'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const { validateFixture } = require('../tools/generate-canvas-regressions-reference.cjs');

const fixturePath = path.join(__dirname, 'assets/reference/canvas-regressions.json.gz');
test('Canvas expectations reject stale runtime, generator, readback, font and capture identities', () => {
  const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(fixturePath)));
  validateFixture(fixture);
  for (const change of [
    value => { value.reference.files.nw = '0'.repeat(64); },
    value => { value.reference.chromiumVersion = '66.0'; },
    value => { value.generatorSha256 = '0'.repeat(64); },
    value => { value.scenarioSha256 = '0'.repeat(64); },
    value => { value.readbackSha256 = '0'.repeat(64); },
    value => { value.fontSha256 = '0'.repeat(64); },
    value => { delete value.driverSha256; },
    value => { value.settings.freshProcessReplays = 1; },
    value => { value.channelTolerance = 3; },
  ]) {
    const stale = structuredClone(fixture); change(stale);
    assert.throws(() => validateFixture(stale));
  }
});
