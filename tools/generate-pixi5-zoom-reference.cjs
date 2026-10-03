/* global PIXI, zoomBlurScenario */
'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { zoomBlurScenario: scenario } = require('../test/helpers/zoom-blur-scenario.cjs');
const [pixiFile, browserFile, driverDirectory, outputFile] = process.argv.slice(2);
if (![pixiFile, browserFile, driverDirectory, outputFile].every(Boolean)) {
  throw Error('Usage: generate-pixi5-zoom-reference.cjs <pixi.js> <chromium> <playwright-package> <output.json>');
}
const { chromium } = require(path.resolve(driverDirectory));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const plugin = path.resolve(__dirname, '../test/assets/pixi-filters/zoom-blur-3.1.0.js');
async function captureReference() {
  const renderer = new PIXI.Renderer({ width: 32, height: 24, transparent: true,
    antialias: false, preserveDrawingBuffer: true });
  function read() {
    const bottom = new Uint8Array(32 * 24 * 4), top = new Uint8Array(bottom.length);
    renderer.gl.readPixels(0, 0, 32, 24, renderer.gl.RGBA, renderer.gl.UNSIGNED_BYTE, bottom);
    for (let y = 0; y < 24; y++) top.set(bottom.subarray((23 - y) * 128, (24 - y) * 128), y * 128);
    return Array.from(top);
  }
  const rows = zoomBlurScenario({ capture(rgba, options, snapshot) {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), 32, 24), 0, 0);
    const texture = PIXI.Texture.from(canvas);
    const stage = new PIXI.Container(); stage.addChild(new PIXI.Sprite(texture));
    stage.filterArea = new PIXI.Rectangle(0, 0, 32, 24);
    stage.filters = [new PIXI.filters.ZoomBlurFilter(options)];
    if (options.alpha !== undefined) stage.filters.unshift(new PIXI.filters.AlphaFilter(options.alpha));
    if (snapshot) {
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
    await page.addScriptTag({ path: plugin });
    await page.addScriptTag({ content: 'globalThis.zoomBlurScenario = ' + scenario.toString() });
    const result = await page.evaluate(captureReference);
    const reference = { ...result, rows: result.rows.map(row => ({ label: row.label,
      rgba: Buffer.from(row.pixels).toString('base64'),
      channelTolerance: row.label === 'fullscreen-3' ? 3 : 1 })), chromium: browser.version(),
      pixiSha256: hash(pixiFile), pluginSha256: hash(plugin),
      pluginSource: 'https://registry.npmjs.org/@pixi/filter-zoom-blur/-/filter-zoom-blur-3.1.0.tgz',
      pluginGitCommit: 'f4fb8729c0c5a7c35dcb60cbe6d096d5d8947c94',
      scenarioSha256: hash(path.resolve(__dirname, '../test/helpers/zoom-blur-scenario.cjs')),
      generatorSha256: hash(__filename), channelTolerance: 1, maxOutlierPixels: 0 };
    fs.writeFileSync(path.resolve(outputFile), JSON.stringify(reference, null, 2) + '\n');
    console.log(reference.rows.length + ' stock Pixi 5 ZoomBlur frames captured');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
