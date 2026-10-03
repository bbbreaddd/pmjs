'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { cases } = require('./filter-boundary-cases.cjs');

const runtimeRoot = path.resolve(__dirname, '..');
const addon = process.env.PMJS_NATIVE_ADDON ||
  path.join(runtimeRoot, 'build/pmjs_native.node');
const assets = process.env.PMJS_TEST_ASSET_ROOT ||
  path.join(runtimeRoot, 'build/test-assets');

test('Pixi 4 filter boundaries match optimized and materialized native pixels',
  { timeout: 120000 }, () => {
    const reference = JSON.parse(fs.readFileSync(
      path.join(__dirname, 'assets/reference/pixi-filter-boundary.json'), 'utf8'));
    assert.equal(reference.version, '4.8.9');
    const result = spawnSync('xvfb-run',
      ['-a', process.execPath, path.join(__dirname, 'node-tone-boundary-pixels.cjs'), addon, assets],
      { encoding: 'utf8', env: { ...process.env,
        PMJS_TONE_BOUNDARY_JSON: '1', PMJS_WINDOW_SIZE: '64x64',
        LIBGL_ALWAYS_SOFTWARE: '1' } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const native = new Map();
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.startsWith('PMJS_TONE_BOUNDARY_RESULT=')) {
        const entry = JSON.parse(line.slice('PMJS_TONE_BOUNDARY_RESULT='.length));
        native.set(entry.name, entry);
      }
    }
    assert.equal(native.size, cases.length + 1);
    for (const [name, expected] of Object.entries(reference.cases)) {
      const entry = native.get(name);
      assert(entry, `missing native case: ${name}`);
      for (const pathName of ['deferred', 'materialized']) {
        const actual = entry[pathName];
        const delta = Math.max(...actual.slice(0, 3).map((value, index) =>
          Math.abs(value - expected[index])));
        assert.ok(delta <= 3,
          `${name} ${pathName}: Pixi ${expected}, native ${actual}, max delta ${delta}`);
        const scene = entry[pathName + 'Scene'];
        const premultiplied = scene.map((value, index) =>
          index === 3 ? value : Math.round(value * scene[3] / 255));
        const rgbaDelta = Math.max(...premultiplied.map((value, index) =>
          Math.abs(value - expected[index])));
        assert.ok(rgbaDelta <= 3,
          `${name} ${pathName} RGBA: Pixi ${expected}, native ` +
          `${premultiplied}, max delta ${rgbaDelta}`);
      }
    }
  });
