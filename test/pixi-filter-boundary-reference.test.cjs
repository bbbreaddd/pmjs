'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { matrix, colors, cases } = require('./filter-boundary-cases.cjs');

const runtimeRoot = path.resolve(__dirname, '..');
const pixiScript = process.env.PMJS_PIXI4_SCRIPT;
const playwrightModule = process.env.PMJS_PLAYWRIGHT_MODULE;
const addon = process.env.PMJS_NATIVE_ADDON ||
  path.join(runtimeRoot, 'build/pmjs_native.node');
const assets = process.env.PMJS_TEST_ASSET_ROOT ||
  path.join(runtimeRoot, 'build/test-assets');
const available = !!(pixiScript && playwrightModule &&
  fs.existsSync(pixiScript) && fs.existsSync(addon) && fs.existsSync(assets));

function referenceScene(PIXI, item, palette) {
  function sprite(rgba) {
    const canvas = globalThis.document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const context = canvas.getContext('2d');
    const pixels = context.createImageData(16, 16);
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
      pixels.data.set(rgba, offset);
    }
    context.putImageData(pixels, 0, 0);
    return new PIXI.Sprite(PIXI.Texture.fromCanvas(canvas));
  }
  function filtered(rgba, coefficients, alpha = 1) {
    const holder = new PIXI.Container();
    const filter = new PIXI.filters.ColorMatrixFilter();
    filter.matrix = coefficients;
    filter.alpha = alpha;
    holder.filters = [filter];
    holder.addChild(sprite(rgba));
    return holder;
  }
  const stage = new PIXI.Container();
  if (item.name === 'inline color matrix') {
    stage.addChild(sprite([200, 100, 50, 255]));
    stage.addChild(filtered([102, 153, 204, 128], item.tone));
    const picture = sprite(palette.white);
    picture.alpha = 0.5;
    stage.addChild(picture);
    return stage;
  }
  stage.addChild(filtered(item.source, item.tone, item.toneAlpha ?? 1));
  for (const [name, alpha] of item.pictures) {
    const picture = sprite(palette[name]);
    picture.alpha = alpha;
    stage.addChild(picture);
  }
  return stage;
}

test('Pixi 4 filter boundaries match optimized and materialized native pixels',
  { skip: !available, timeout: 120000 }, async () => {
    const playwright = require(playwrightModule);
    const browser = await playwright.chromium.launch({
      headless: process.env.PMJS_CHROMIUM_HEADFUL !== '1',
      ...(process.env.PMJS_CHROMIUM_EXECUTABLE ?
        { executablePath: process.env.PMJS_CHROMIUM_EXECUTABLE } : {}),
      args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-webgl',
        '--disable-gpu-sandbox'],
    });
    let reference;
    try {
      const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
      await page.addScriptTag({ path: pixiScript });
      reference = await page.evaluate(({ sceneSource, table, palette }) => {
        const make = (0, eval)('(' + sceneSource + ')');
        const pixi = globalThis.PIXI;
        const renderer = new pixi.WebGLRenderer(16, 16,
          { backgroundColor: 0, transparent: true,
            preserveDrawingBuffer: true, antialias: false });
        const output = { version: pixi.VERSION, cases: {} };
        for (const item of table) {
          renderer.render(make(pixi, item, palette));
          const pixel = new Uint8Array(4);
          renderer.gl.readPixels(8, 7, 1, 1, renderer.gl.RGBA,
            renderer.gl.UNSIGNED_BYTE, pixel);
          output.cases[item.name] = Array.from(pixel);
        }
        return output;
      }, { sceneSource: referenceScene.toString(),
        table: [...cases, { name: 'inline color matrix',
          tone: matrix([-1, -1, -1]) }], palette: colors });
    } finally {
      await browser.close();
    }
    assert.equal(reference.version, '4.8.9');
    const result = spawnSync(process.execPath,
      [path.join(__dirname, 'node-tone-boundary-pixels.cjs'), addon, assets],
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
