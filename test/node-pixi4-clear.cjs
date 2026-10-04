'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHostContext } = require('./helpers/mz-host-context.cjs');
const { makeHarness } = require('./helpers/scene-encoder-harness.cjs');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 16, height: 12,
  windowTitle: 'Pixi 4 immediate clearing' });
try {
  const c = createHostContext(native, { graphics: false });
  c.PIXI = makeHarness().sandbox.PIXI;
  c.PIXI.RENDERER_TYPE = { WEBGL: 1 };
  c.PIXI.Texture.EMPTY = { baseTexture: {} };
  c.PIXI.Matrix = class {
    identity() { this.a = this.d = 1; this.b = this.c = this.tx = this.ty = 0; return this; }
  };
  c.PIXI.WebGLRenderer = class {};
  c.PIXI.WebGLRenderer.__plugins = {};
  for (const name of ['renderer-managers', 'renderer-facade']) {
    const file = path.resolve(__dirname, '../js/pmjs-pixi4', name + '.js');
    vm.runInContext(fs.readFileSync(file, 'utf8'), c, { filename: file });
  }
  const renderer = c.createNativePixiRenderer(16, 12);
  const screenPixel = (x = 8, y = 6) => {
    const capture = native.canvas.captureScene();
    try { return Array.from(native.canvas.readPixels(capture.handle, x, y, 1, 1)); }
    finally { native.canvas.release(capture.handle); }
  };
  native.beginFrame();
  native.render.setClearColor(0, 0, 1, 1);
  native.render.quad(0, 0, 16, 12, 0, 1, 0, 1);
  native.renderScene();
  assert.deepEqual(screenPixel(), [0, 255, 0, 255]);
  const mask = { name: 'retained mask' };
  renderer.maskManager.pushStencilMask(mask);
  renderer.clear([1, 0, 0, 1]);
  assert.deepEqual(screenPixel(), [255, 0, 0, 255], 'clear is visible before another render');
  native.renderFrame();
  assert.deepEqual(screenPixel(), [255, 0, 0, 255], 'cleared commands cannot replay');
  assert.equal(renderer.maskManager.maskStack[0].mask, mask);
  renderer.maskManager.popStencilMask();

  const root = renderer.rootRenderTarget;
  const destination = new c.PIXI.Rectangle(2, 3, 4, 5);
  root.setFrame(destination, new c.PIXI.Rectangle(0, 0, 4, 5));
  renderer.clear([0, 1, 0, 1]);
  assert.deepEqual(screenPixel(3, 5), [0, 255, 0, 255], 'clear respects the target frame');
  assert.deepEqual(screenPixel(0, 0), [255, 0, 0, 255], 'clear retains pixels outside the target frame');
  assert.equal(root.destinationFrame, destination);
  root.setFrame(root.defaultFrame, root.defaultFrame);

  renderer.backgroundColor = 0xffff00;
  root.clear();
  assert.deepEqual(screenPixel(), [255, 255, 0, 255], 'root clear uses the current background');
  renderer.clear();
  assert.deepEqual(screenPixel(), [255, 255, 0, 255], 'default clear uses renderer background');
  const texture = { width: 8, height: 6, baseTexture: { width: 8, height: 6, resolution: 1 } };
  const sibling = { width: 8, height: 6, baseTexture: { width: 8, height: 6, resolution: 1 } };
  renderer.clearRenderTexture(sibling, [0, 0, 1, 1]);
  const texturePixel = (t, x = 4, y = 3) => Array.from(native.canvas.readPixels(
    t.baseTexture.__pmjsRenderCanvas._ensureNativeCanvas().handle, x, y, 1, 1));
  renderer.bindRenderTexture(texture);
  renderer.clear([1, 0, 0, 1]);
  assert.deepEqual(texturePixel(texture), [255, 0, 0, 255]);
  assert.deepEqual(texturePixel(sibling), [0, 0, 255, 255]);
  assert.deepEqual(screenPixel(), [255, 255, 0, 255], 'offscreen clear preserves the screen');
  const offscreen = renderer._activeRenderTarget;
  offscreen.setFrame(new c.PIXI.Rectangle(1, 1, 2, 2), new c.PIXI.Rectangle(0, 0, 2, 2));
  renderer.clear([0, 1, 0, 1]);
  assert.deepEqual(texturePixel(texture, 1, 1), [0, 255, 0, 255]);
  assert.deepEqual(texturePixel(texture, 4, 3), [255, 0, 0, 255]);
  offscreen.setFrame(offscreen.defaultFrame, offscreen.defaultFrame);
  renderer.renderTexture.clear();
  assert.deepEqual(texturePixel(texture), [0, 0, 0, 0], 'offscreen default is transparent');
  assert.equal(renderer._activeRenderTarget, offscreen);
  root.clear([1, 0, 1, 1]);
  assert.deepEqual(screenPixel(), [255, 0, 255, 255], 'root target clear selects the root');
  assert.equal(renderer._activeRenderTarget, offscreen, 'target clearing preserves the active binding');
  renderer.bindRenderTexture(null);
  offscreen.clear([0, 1, 1, 1]);
  assert.deepEqual(texturePixel(texture), [0, 255, 255, 255]);
  assert.deepEqual(screenPixel(), [255, 0, 255, 255]);
  const view = { width: 8, height: 6, baseTexture: texture.baseTexture };
  renderer.bindRenderTexture(view);
  view.baseTexture = null;
  renderer.renderTexture.clear([0, 1, 0, 1]);
  assert.deepEqual(texturePixel(texture), [0, 255, 0, 255],
    'clearing retains the shared base after a view is destroyed');
  renderer.bindRenderTexture(null);
  renderer.renderTexture.clear([0, 1, 0, 1]);
  assert.deepEqual(screenPixel(), [0, 255, 0, 255]);

  c.prepareNativeBitmapCaches = function() {};
  c.PMJS.pixi4.getStageRenderOptions = function() { return {}; };
  c.renderNativeStage = function() { native.render.quad(0, 0, 8, 6, 1, 0, 0, 1); };
  native.beginFrame();
  renderer.render({}, texture);
  assert.equal(renderer._activeRenderTarget._pmjsBaseTexture, texture.baseTexture);
  renderer.clear([0, 1, 1, 1]);
  assert.deepEqual(texturePixel(texture), [0, 255, 255, 255],
    'clear after render selects its offscreen backing');
  assert.deepEqual(screenPixel(), [0, 255, 0, 255]);
  renderer.render({}, null);
  assert.equal(renderer._activeRenderTarget, root);
  renderer.clear([1, 0, 1, 1]);
  assert.deepEqual(screenPixel(), [255, 0, 255, 255]);
  assert.deepEqual(texturePixel(texture), [0, 255, 255, 255]);

  // Immediate clear leaves the color for future automatic clears unchanged.
  native.beginFrame();
  native.render.quad(0, 0, 1, 1, 1, 1, 1, 1);
  native.renderScene();
  assert.deepEqual(screenPixel(), [0, 0, 255, 255]);
  native.beginFrame();
  native.render.quad(0, 0, 16, 12, 0, 1, 0, 1);
  renderer.clear([1, 0, 0, 1]);
  native.renderFrame();
  assert.deepEqual(screenPixel(), [255, 0, 0, 255], 'clear orders after queued drawing');
  texture.baseTexture.__pmjsRenderCanvas._releaseNativeCanvas();
  sibling.baseTexture.__pmjsRenderCanvas._releaseNativeCanvas();
  renderer.destroy();
  console.log('Pixi 4 immediate screen/offscreen clearing, frames, ordering and isolation passed');
} finally { native.runtime.quit(); }
