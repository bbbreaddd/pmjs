/* global PIXI, tilingScenario */
'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { tilingScenario: scenario } = require('../test/helpers/tiling-scenario.cjs');
const [pixiFile, browserFile, driverDirectory, outputFile] = process.argv.slice(2);
if (![pixiFile, browserFile, driverDirectory, outputFile].every(Boolean)) {
  throw Error('Usage: generate-pixi5-tiling-reference.cjs <pixi.js> <chromium> <playwright-package> <output.json>');
}
const { chromium } = require(path.resolve(driverDirectory));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if (hash(pixiFile) !== 'fb291f5fc93ffe857215164c38e15a41bd142703d4e9fa384376e59472a02a0a') throw Error('reference requires the pinned Pixi 5.3.12 source');
async function captureReference() {
  let renderer;
  function read() {
    const bottom = new Uint8Array(32 * 24 * 4), top = new Uint8Array(bottom.length);
    renderer.gl.readPixels(0, 0, 32, 24, renderer.gl.RGBA, renderer.gl.UNSIGNED_BYTE, bottom);
    for (let y = 0; y < 24; y++) top.set(bottom.subarray((23 - y) * 128, (24 - y) * 128), y * 128);
    return Array.from(top);
  }
  const rows = tilingScenario({ capture(rgba, width, height, options) {
    // Stock's shared tiling quad retains anchor UVs. Isolate authored cases.
    if (renderer) renderer.destroy();
    renderer = new PIXI.Renderer({ width: 32, height: 24, transparent: true,
      antialias: false, preserveDrawingBuffer: true });
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    const base = PIXI.BaseTexture.from(canvas, { mipmap: PIXI.MIPMAP_MODES.OFF, scaleMode: options.linear ? PIXI.SCALE_MODES.LINEAR : PIXI.SCALE_MODES.NEAREST });
    const texture = new PIXI.Texture(base, options.atlas ? new PIXI.Rectangle(2, 2, 3, 3) : undefined);
    const stage = new PIXI.Container(), tiling = new PIXI.TilingSprite(texture, 20, 16);
    tiling.position.set(8, 6);
    tiling.anchor.set(...(options.anchor || [0, 0]));
    tiling.tilePosition.set(...(options.tilePosition || [0, 0]));
    tiling.tileScale.set(...(options.tileScale || [1, 1]));
    tiling.tileTransform.pivot.set(...(options.pivot || [0, 0]));
    tiling.uvRespectAnchor = !!options.uvRespectAnchor;
    stage.addChild(tiling);
    if (options.alpha !== undefined) {
      stage.filters = [new PIXI.filters.AlphaFilter(options.alpha)];
      stage.filterArea = new PIXI.Rectangle(0, 0, options.clip ? 18 : 32, options.clip ? 14 : 24);
    }
    if (options.repaint || options.reframe) {
      renderer.render(stage);
      if (options.repaint) {
        context.fillStyle = '#2850a0'; context.fillRect(0, 0, width, height); base.update();
      } else texture.frame = new PIXI.Rectangle(3, 1, 3, 3);
    }
    if (options.snapshot) {
      const target = PIXI.RenderTexture.create({ width: 32, height: 24 });
      renderer.render(stage, target);
      const result = new PIXI.Sprite(PIXI.Texture.from(renderer.extract.canvas(target)));
      renderer.render(result); target.destroy(true); result.destroy({ texture: true, baseTexture: true });
    } else renderer.render(stage);
    const pixels = read(); stage.destroy({ children: true }); texture.destroy(true);
    return pixels;
  } });
  const gl = renderer.gl, debug = gl.getExtension('WEBGL_debug_renderer_info');
  return { rows, pixi: PIXI.VERSION, precision: PIXI.settings.PRECISION_FRAGMENT,
    graphics: debug && gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) };
}
(async () => {
  const browser = await chromium.launch({ headless: false, executablePath: path.resolve(browserFile),
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gles', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ path: path.resolve(pixiFile) });
    await page.addScriptTag({ content: 'globalThis.tilingScenario = ' + scenario.toString() });
    const result = await page.evaluate(captureReference);
    const reference = { ...result, rows: result.rows.map(row => ({ label: row.label,
      rgba: Buffer.from(row.pixels).toString('base64'),
      channelTolerance: 1 })), chromium: browser.version(),
      pixiSha256: hash(pixiFile), pixiSource: 'https://github.com/pixijs/pixi.js/tree/v5.3.12',
      scenarioSha256: hash(path.resolve(__dirname, '../test/helpers/tiling-scenario.cjs')),
      generatorSha256: hash(__filename), mipmap: 'OFF', channelTolerance: 1, maxOutlierPixels: 0 };
    fs.writeFileSync(path.resolve(outputFile), JSON.stringify(reference, null, 2) + '\n');
    console.log(reference.rows.length + ' stock Pixi 5 tiling frames captured');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
