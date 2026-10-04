/* global PIXI, spriteRoundingCases, spriteRoundingPixels */
'use strict';

const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spriteRoundingCases, spriteRoundingPixels } = require('../test/helpers/sprite-rounding-scenario.cjs');
const [pixiFile, browserFile, driverDirectory, outputFile] = process.argv.slice(2);
if (![pixiFile, browserFile, driverDirectory, outputFile].every(Boolean)) {
  throw Error('Usage: generate-pixi5-sprite-rounding-reference.cjs <pixi.js> <chromium> <playwright-package> <output.json.gz>');
}
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pixiSha256 = hash(pixiFile);
if (pixiSha256 !== 'fb291f5fc93ffe857215164c38e15a41bd142703d4e9fa384376e59472a02a0a') {
  throw Error('reference requires the pinned Pixi 5.3.12 source');
}
const { chromium } = require(path.resolve(driverDirectory));

function captureReference() {
  const rows = [];
  for (const spec of spriteRoundingCases()) {
    PIXI.settings.RESOLUTION = spec.settingsResolution;
    const logicalSize = spec.size || 32;
    const renderer = new PIXI.Renderer({ width: logicalSize, height: logicalSize, resolution: spec.resolution,
      transparent: true, antialias: false, preserveDrawingBuffer: true });
    const width = spec.sourceWidth || 8, height = spec.sourceHeight || 8;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(spriteRoundingPixels(width, height)), width, height), 0, 0);
    const base = PIXI.BaseTexture.from(canvas, { resolution: spec.textureResolution,
      mipmap: PIXI.MIPMAP_MODES.OFF, scaleMode: PIXI.SCALE_MODES.NEAREST });
    const extentX = width / spec.textureResolution, extentY = height / spec.textureResolution;
    const swap = (spec.atlasRotation || 0) % 4 === 2;
    const texture = new PIXI.Texture(base, new PIXI.Rectangle(0, 0, extentX, extentY),
      new PIXI.Rectangle(0, 0, spec.logicalWidth || (spec.trim ? 16 : swap ? extentY : extentX),
        spec.logicalHeight || (spec.trim ? 16 : swap ? extentX : extentY)),
      spec.trim ? new PIXI.Rectangle(3, 2, 8, 8) : undefined, spec.atlasRotation || 0);
    if (spec.logicalWidth || spec.logicalHeight) {
      texture.orig = new PIXI.Rectangle(0, 0, spec.logicalWidth || extentX, spec.logicalHeight || extentY);
    }
    const stage = new PIXI.Container(), parent = new PIXI.Container(); stage.addChild(parent);
    if (spec.parent) { parent.position.set(2.25, 3.75); parent.scale.set(1.25, 0.8); parent.rotation = 0.2; }
    if (spec.parentScale) parent.scale.set(spec.parentScale);
    const sprite = new PIXI.Sprite(texture); parent.addChild(sprite);
    sprite.position.set(spec.position); sprite.scale.set(spec.scale); sprite.rotation = spec.rotation;
    sprite.anchor.set(spec.anchor); sprite.roundPixels = spec.rounded;
    sprite.alpha = spec.alpha === undefined ? 1 : spec.alpha;
    if (spec.screen) {
      parent.removeChild(sprite);
      const screen = new PIXI.Container(), graphics = new PIXI.Graphics();
      screen.addChild(graphics); parent.addChild(screen);
      graphics.beginFill(0xff0000).drawRect(-50000, -50000, 100000, 100000);
      if (spec.screen === 'invisible') graphics.visible = false;
      if (spec.screen === 'unrenderable') graphics.renderable = false;
      if (spec.screen === 'alpha') { screen.alpha = 0.5; graphics.alpha = 0.5; }
      if (spec.screen === 'color') graphics.clear().beginFill(0x00ff00).drawRect(-50000, -50000, 100000, 100000);
      if (spec.screen === 'shape' || spec.screen === 'transform') graphics.clear().beginFill(0xff0000).drawRect(4, 5, 16, 17);
      if (spec.screen === 'transform') { graphics.position.set(2.25, 1.75); graphics.scale.set(0.8, 0.7); graphics.rotation = 0.2; }
      if (spec.screen === 'tint') graphics.tint = 0x808080;
      if (spec.screen === 'fill-alpha') graphics.clear().beginFill(0xff0000, 0.5).drawRect(-50000, -50000, 100000, 100000);
      if (spec.screen === 'empty') graphics.clear();
      if (spec.screen === 'removed') screen.removeChild(graphics);
      if (spec.screen === 'filter') { graphics.filters = [new PIXI.filters.AlphaFilter(0.5)]; graphics.filterArea = new PIXI.Rectangle(4, 5, 16, 17); }
    }
    let child;
    if (spec.child) {
      child = new PIXI.Sprite(texture); child.position.set(7.25, -3.75);
      child.scale.set(0.5); child.roundPixels = !!spec.childRounded; sprite.addChild(child);
    }
    if (spec.clip) {
      stage.filters = [new PIXI.filters.AlphaFilter(0.5)];
      stage.filterArea = new PIXI.Rectangle(0, 0, spec.clipSize || 24, spec.clipSize || 24);
    }
    const after = new PIXI.Sprite(texture); after.position.set(1, 27); after.scale.set(0.5); stage.addChild(after);
    let target, snapshot;
    if (spec.snapshot) {
      target = PIXI.RenderTexture.create({ width: logicalSize, height: logicalSize, resolution: spec.resolution });
      renderer.render(stage, target); snapshot = new PIXI.Sprite(target); renderer.render(snapshot);
    } else renderer.render(stage);
    const size = logicalSize * spec.resolution, pixels = new Uint8Array(size * size * 4), top = new Uint8Array(pixels.length);
    const gl = renderer.gl;
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    for (let y = 0; y < size; y++) top.set(pixels.subarray((size - y - 1) * size * 4, (size - y) * size * 4), y * size * 4);
    rows.push({ label: spec.label, pixels: Array.from(top), vertices: Array.from(sprite.vertexData),
      childVertices: child && Array.from(child.vertexData) });
    if (snapshot) snapshot.destroy();
    if (target) target.destroy(true);
    stage.destroy({ children: true }); texture.destroy(true); renderer.destroy();
  }
  return rows;
}

(async () => {
  const browser = await chromium.launch({ headless: false, executablePath: path.resolve(browserFile),
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gles', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ path: path.resolve(pixiFile) });
    await page.addScriptTag({ content: 'globalThis.spriteRoundingCases = ' + spriteRoundingCases.toString() +
      '; globalThis.spriteRoundingPixels = ' + spriteRoundingPixels.toString() });
    const rows = await page.evaluate(captureReference);
    const reference = { pixi: '5.3.12', pixiSha256, pixiSource: 'https://github.com/pixijs/pixi.js/tree/v5.3.12',
      chromium: browser.version(),
      scenarioSha256: hash(path.resolve(__dirname, '../test/helpers/sprite-rounding-scenario.cjs')),
      generatorSha256: hash(__filename),
      vertexFixtureSha256: hash(path.resolve(__dirname, '../test/assets/pixi5/sprite-vertices-5.3.12.cjs')),
      channelTolerance: 1, maxOutlierPixels: 0,
      rows: rows.map(({ pixels, ...row }) => ({ ...row, rgba: Buffer.from(pixels).toString('base64') })) };
    fs.writeFileSync(path.resolve(outputFile), zlib.gzipSync(JSON.stringify(reference)));
    console.log(rows.length + ' stock Pixi 5 sprite rounding frames captured');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
