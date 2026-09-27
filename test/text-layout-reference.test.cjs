'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const playwrightModule = process.env.PMJS_PLAYWRIGHT_MODULE;
const addon = process.env.PMJS_NATIVE_ADDON || path.join(root, 'build/pmjs_native.node');
const assets = process.env.PMJS_TEST_ASSET_ROOT || path.join(root, 'build/test-assets');

test('native text layout matches explicit-font Chromium Canvas reference',
  { skip: !playwrightModule, timeout: 60000 }, async () => {
    const probe = spawnSync('xvfb-run', ['-a', process.execPath,
      path.join(__dirname, 'node-text-layout.cjs'), addon, assets, '--report'],
    { encoding: 'utf8', env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1' } });
    assert.equal(probe.status, 0, probe.stdout + probe.stderr);
    const lines = probe.stdout.trim().split('\n');
    const native = JSON.parse(lines.at(-1));
    const browser = await require(playwrightModule).chromium.launch({
      headless: true,
      ...(process.env.PMJS_CHROMIUM_EXECUTABLE ?
        { executablePath: process.env.PMJS_CHROMIUM_EXECUTABLE } : {}),
      args: ['--no-sandbox'],
    });
    try {
      if (process.env.PMJS_TEXT_REFERENCE_VERSION) {
        assert.equal(browser.version(), process.env.PMJS_TEXT_REFERENCE_VERSION);
      }
      const page = await browser.newPage();
      const reference = await page.evaluate(async ({ font, texts }) => {
        const face = new globalThis.FontFace('TextTest', `url(data:font/ttf;base64,${font})`);
        globalThis.document.fonts.add(await face.load());
        const canvas = globalThis.document.createElement('canvas');
        canvas.width = 320; canvas.height = 128;
        const ctx = canvas.getContext('2d');
        ctx.font = '28px TextTest';
        ctx.fontKerning = 'normal';
        const output = {};
        for (const text of texts) {
          const metrics = ctx.measureText(text);
          output[text] = Object.fromEntries(['width', 'actualBoundingBoxLeft',
            'actualBoundingBoxRight', 'actualBoundingBoxAscent',
            'actualBoundingBoxDescent'].map(key => [key, metrics[key]]));
          ctx.clearRect(0, 0, 320, 128);
          ctx.fillText(text, 16, 64);
          const pixels = ctx.getImageData(0, 0, 320, 128).data;
          let left = 320, top = 128, right = 0, bottom = 0;
          for (let y = 0; y < 128; y++) {
            for (let x = 0; x < 320; x++) {
              if (!pixels[(y * 320 + x) * 4 + 3]) continue;
              left = Math.min(left, x); top = Math.min(top, y);
              right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
            }
          }
          output[text].inkBounds = right ?
            [left - 16, top - 64, right - 16, bottom - 64] : [0, 0, 0, 0];
        }
        function pixels(text, stroke) {
          ctx.clearRect(0, 0, 320, 128);
          ctx.lineWidth = 4;
          if (stroke) ctx.strokeText(text, 16, 64);
          else ctx.fillText(text, 16, 64);
          return Array.from(ctx.getImageData(0, 0, 320, 128).data);
        }
        for (const stroke of [false, true]) {
          const x = pixels('X', stroke);
          const lrm = pixels('X\u200E', stroke);
          if (x.some((value, i) => value !== lrm[i])) throw Error('LRM changed pixels');
          const spaces = pixels('A B', stroke);
          const newline = pixels('A\nB', stroke);
          if (spaces.some((value, i) => value !== newline[i])) throw Error('whitespace pixels');
        }
        return output;
      }, { font: fs.readFileSync(path.join(assets, 'text-shaping.ttf')).toString('base64'),
        texts: Object.keys(native) });
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
      console.log(`[text-reference] Chromium ${browser.version()}; explicit licensed font`);
    } finally {
      await browser.close();
    }
  });
