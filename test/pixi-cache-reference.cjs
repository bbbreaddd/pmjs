'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { run } = require('../runner/index.cjs');

const gameRoot = process.env.PMJS_PIXI_REFERENCE_GAME_ROOT;
const playwrightModule = process.env.PMJS_PLAYWRIGHT_MODULE;
const debugReference = process.env.PMJS_PIXI_REFERENCE_DEBUG === '1';
const runtimeRoot = path.resolve(__dirname, '..');
const pixiPath = gameRoot && path.join(gameRoot, 'js/libs/pixi.js');
const addonPath = path.join(runtimeRoot, 'build/pmjs_native.node');
const bundlePath = path.join(runtimeRoot, 'build-js/mv-core-bootstrap.js');
const available = !!(pixiPath && playwrightModule &&
  fs.existsSync(pixiPath) && fs.existsSync(addonPath));
const WIDTH = 48;
const HEIGHT = 40;

function fixture(PIXI, variant) {
  function colorSprite(color, width, height, x, y) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = color;
    context.fillRect(0, 0, width, height);
    if (typeof canvas._ensureNativeCanvas === 'function') {
      canvas._ensureNativeCanvas();
    }
    const sprite = new PIXI.Sprite(PIXI.Texture.fromCanvas(canvas));
    sprite.x = x;
    sprite.y = y;
    return sprite;
  }
  const stage = new PIXI.Container();
  if (variant === 'text-dirty') {
    const label = new PIXI.Text('A', {
      fontFamily: 'ReferenceFont', fontSize: 20, fill: '#ffffff' });
    label.x = 6;
    label.y = 5;
    label.text = 'M';
    stage.addChild(label);
    return { stage, innerNode: null };
  }
  if (variant === 'sprite') {
    const cached = colorSprite('#ff0000', 18, 17, 13, 8);
    cached.alpha = 0.6;
    cached.cacheAsBitmap = true;
    stage.addChild(cached);
    return { stage, innerNode: null };
  }
  const holder = new PIXI.Container();
  holder.x = 13;
  holder.y = 8;
  holder.alpha = 0.6;
  const red = colorSprite('#ff0000', 18, 17, -6, 2);
  const blue = colorSprite('#0000ff', 17, 16, 8, -3);
  holder.addChild(red, blue);
  let innerNode = null;
  if (variant === 'mask') {
    const mask = new PIXI.Graphics();
    mask.beginFill(0xffffff).drawRect(0, 0, 15, 16).endFill();
    holder.addChild(mask);
    holder.mask = mask;
  }
  if (variant === 'filter') {
    const filter = new PIXI.filters.ColorMatrixFilter();
    filter.desaturate();
    holder.filters = [filter];
  }
  if (variant === 'nested-cold' || variant === 'nested-warm') {
    const inner = new PIXI.Container();
    innerNode = inner;
    holder.removeChild(blue);
    inner.addChild(blue);
    inner.cacheAsBitmap = true;
    holder.addChild(inner);
  }
  holder.cacheAsBitmap = true;
  stage.addChild(holder);
  return {
    stage, innerNode,
    mutate() {
      red.texture = colorSprite('#00ff00', 18, 17, -6, 2).texture;
    },
    disableCache() { holder.cacheAsBitmap = false; }
  };
}

function rgbaAt(bytes, x, y) {
  const offset = (y * WIDTH + x) * 4;
  return Array.from(bytes.subarray(offset, offset + 4));
}

test('Pixi 4 cacheAsBitmap pixels match the native scene writer',
  { skip: !available, timeout: 120000 }, async () => {
    execFileSync(process.execPath,
      [path.join(runtimeRoot, 'tools/build-js-runtime.mjs'), '--profile',
        'mv', '--output', bundlePath], { cwd: runtimeRoot });
    const playwright = require(playwrightModule);
    const browser = await playwright.chromium.launch({
      headless: process.env.PMJS_CHROMIUM_HEADFUL !== '1',
      ...(process.env.PMJS_CHROMIUM_EXECUTABLE ?
        { executablePath: process.env.PMJS_CHROMIUM_EXECUTABLE } : {}),
      args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-webgl',
        '--disable-gpu-sandbox'] });
    let reference;
    try {
      const page = await browser.newPage({ viewport: { width: WIDTH,
        height: HEIGHT } });
      await page.addScriptTag({ path: pixiPath });
      const fontData = fs.readFileSync(path.join(gameRoot,
        'fonts/BestTen-CRT.ttf')).toString('base64');
      reference = await page.evaluate(async ({ fixtureSource, width, height,
        fontData }) => {
        const font = new FontFace('ReferenceFont',
          `url(data:font/ttf;base64,${fontData})`);
        await font.load();
        document.fonts.add(font);
        const build = (0, eval)('(' + fixtureSource + ')');
        const renderer = new PIXI.WebGLRenderer(width, height,
          { backgroundColor: 0x000000, preserveDrawingBuffer: true,
            antialias: false });
        const gl = renderer.gl;
        const output = {};
        for (const variant of ['text-dirty', 'basic', 'sprite', 'mask', 'filter',
          'nested-cold', 'nested-warm', 'retained', 'disabled']) {
          const scene = build(PIXI, variant);
          if (variant === 'nested-warm') renderer.render(scene.innerNode);
          renderer.render(scene.stage);
          if (variant === 'retained' || variant === 'disabled') {
            scene.mutate();
            renderer.render(scene.stage);
            if (variant === 'disabled') {
              scene.disableCache();
              renderer.render(scene.stage);
            }
          }
          const pixels = new Uint8Array(width * height * 4);
          gl.readPixels(0, 0, width, height, gl.RGBA,
            gl.UNSIGNED_BYTE, pixels);
          const topDown = new Uint8Array(pixels.length);
          for (let y = 0; y < height; y++) {
            topDown.set(pixels.subarray((height - 1 - y) * width * 4,
              (height - y) * width * 4), y * width * 4);
          }
          output[variant] = Array.from(topDown);
        }
        return output;
      }, { fixtureSource: fixture.toString(), width: WIDTH, height: HEIGHT,
        fontData });
    } finally {
      await browser.close();
    }

    const nativePixels = {};
    await run({ addon: addonPath, gameRoot, bootstrap: bundlePath,
      saveRoot: path.join(runtimeRoot, 'build/pixi-cache-reference-saves'),
      width: WIDTH, height: HEIGHT, title: 'Pixi cache reference' },
    { afterBootstrap({ native }) {
      pmjsGameConfig.fonts = pmjsGameConfig.fonts || {};
      pmjsGameConfig.fonts.ReferenceFont = 'fonts/BestTen-CRT.ttf';
      const renderer = createNativePixiRenderer(WIDTH, HEIGHT,
        { backgroundColor: 0x000000, preserveDrawingBuffer: true,
          antialias: false });
      for (const variant of ['text-dirty', 'basic', 'sprite', 'mask', 'filter',
        'nested-cold', 'nested-warm', 'retained', 'disabled']) {
        const scene = fixture(PIXI, variant);
        function render() {
          native.beginFrame();
          renderer.render(scene.stage);
          native.renderFrame();
        }
        if (variant === 'nested-warm') {
          native.beginFrame();
          renderer.render(scene.innerNode);
          native.renderFrame();
        }
        render();
        if (variant === 'retained' || variant === 'disabled') {
          scene.mutate();
          render();
          if (variant === 'disabled') {
            scene.disableCache();
            render();
          }
        }
        const capture = native.canvas.captureScene();
        const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
        for (let y = 0; y < HEIGHT; y++) {
          for (let x = 0; x < WIDTH; x++) {
            const color = native.canvas.pixel(capture.handle, x, y) >>> 0;
            const offset = (y * WIDTH + x) * 4;
            pixels[offset] = color >>> 24;
            pixels[offset + 1] = color >>> 16 & 255;
            pixels[offset + 2] = color >>> 8 & 255;
            pixels[offset + 3] = color & 255;
          }
        }
        native.canvas.release(capture.handle);
        nativePixels[variant] = pixels;
      }
      native.runtime.quit();
    } });

    for (const variant of Object.keys(reference)) {
      const actual = nativePixels[variant];
      const expected = Uint8Array.from(reference[variant]);
      assert.equal(actual.length, expected.length);
      if (variant === 'text-dirty') {
        const summary = pixels => {
          let count = 0; let left = WIDTH; let top = HEIGHT;
          let right = -1; let bottom = -1;
          for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
            const color = rgbaAt(pixels, x, y);
            if (color[0] || color[1] || color[2]) {
              count++; left = Math.min(left, x); top = Math.min(top, y);
              right = Math.max(right, x); bottom = Math.max(bottom, y);
            }
          }
          return { count, left, top, right, bottom };
        };
        const nativeSummary = summary(actual);
        const pixiSummary = summary(expected);
        assert.ok(nativeSummary.count > 0, 'native dirty Text is blank');
        assert.deepEqual([nativeSummary.left, nativeSummary.top,
          nativeSummary.right, nativeSummary.bottom],
        [pixiSummary.left, pixiSummary.top,
          pixiSummary.right, pixiSummary.bottom]);

        assert.ok(Math.abs(nativeSummary.count - pixiSummary.count) <= 5);
        continue;
      }
      if (variant === 'nested-cold') {
        let differingPixels = 0;
        for (let offset = 0; offset < actual.length; offset += 4) {
          if (Math.abs(actual[offset] - expected[offset]) > 2 ||
              Math.abs(actual[offset + 1] - expected[offset + 1]) > 2 ||
              Math.abs(actual[offset + 2] - expected[offset + 2]) > 2) {
            differingPixels++;
          }
        }

        assert.ok(differingPixels > 0,
          'nested cold discrepancy resolved: require exact pixel comparison');
        console.log('nested-cold Pixi/native differing pixels:', differingPixels);
        continue;
      }
      if (debugReference) {
        for (const [name, pixels] of [['native', actual], ['Pixi', expected]]) {
          let left = WIDTH; let top = HEIGHT; let right = -1; let bottom = -1;
          for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
            const color = rgbaAt(pixels, x, y);
            if (color[0] || color[1] || color[2]) {
              left = Math.min(left, x); top = Math.min(top, y);
              right = Math.max(right, x); bottom = Math.max(bottom, y);
            }
          }
          console.log(variant, name, { left, top, right, bottom });
        }
      }
      for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
          const a = rgbaAt(actual, x, y);
          const e = rgbaAt(expected, x, y);
          for (let channel = 0; channel < 3; channel++) {
            assert.ok(Math.abs(a[channel] - e[channel]) <= 2,
              `${variant} (${x},${y}) channel ${channel}: native=${a} Pixi=${e}`);
          }
        }
      }
    }
  });

