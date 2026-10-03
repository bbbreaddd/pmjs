'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const addon = process.env.PMJS_NATIVE_ADDON || path.join(root, 'build/pmjs_native.node');
const assets = process.env.PMJS_TEST_ASSET_ROOT || path.join(root, 'build/test-assets');

test('legacy FreeType layout stays within the historical explicit-font reference bounds',
  { timeout: 60000 }, () => {
    const probe = spawnSync('xvfb-run', ['-a', process.execPath,
      path.join(__dirname, 'node-text-layout.cjs'), addon, assets, '--report'],
    { encoding: 'utf8', env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1', PMJS_TEXT_BACKEND: 'freetype' } });
    assert.equal(probe.status, 0, probe.stdout + probe.stderr);
    const lines = probe.stdout.trim().split('\n');
    const native = JSON.parse(lines.at(-1));
    const fixture = JSON.parse(fs.readFileSync(
      path.join(__dirname, 'assets/reference/text-layout.json'), 'utf8'));
    const font = fs.readFileSync(path.join(assets, 'text-shaping.ttf'));
    assert.equal(crypto.createHash('sha256').update(font).digest('hex'), fixture.fontSha256,
      'reference metrics require the same explicit font');
    const reference = fixture.cases;
    assert.deepEqual(Object.keys(native), Object.keys(reference));
    for (const [text, metrics] of Object.entries(reference)) {
      // Native shaping uses 26.6 positions; browser design metrics keep finer precision.
      assert.ok(Math.abs(native[text].width - metrics.width) <= 0.125,
        `${JSON.stringify(text)} width: native ${native[text].width}, browser ${metrics.width}`);
      for (const key of ['actualBoundingBoxLeft', 'actualBoundingBoxRight',
        'actualBoundingBoxAscent', 'actualBoundingBoxDescent']) {
        // FreeType's native hinter and Chromium's rasterizer differ by up to 2px
        // on this font's precomposed accent, independently of shaping.
        assert.ok(Math.abs(native[text][key] - metrics[key]) <= 2,
          `${JSON.stringify(text)} ${key}: native ${native[text][key]}, browser ${metrics[key]}`);
      }
      for (let i = 0; i < 4; i++) {
        assert.ok(Math.abs(native[text].inkBounds[i] - metrics.inkBounds[i]) <= 2,
          `${JSON.stringify(text)} ink bounds: native ${native[text].inkBounds}, browser ${metrics.inkBounds}`);
      }
    }
    console.log(`[text-reference] ${fixture.browser}; contained explicit-font fixture`);
  });
