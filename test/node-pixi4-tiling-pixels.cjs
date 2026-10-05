'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { makeHarness } = require('./helpers/scene-encoder-harness.cjs');
const native = require(path.resolve(process.argv[2]));
const width = 32, height = 24;
native.initialize({ gameRoot: path.resolve(process.argv[3]), width, height,
  windowTitle: 'Pixi 4 anchored tiling' });
native.render.setClearColor(0, 0, 0, 0);
const canvases = [];
try {
  const { sandbox, makeTexture } = makeHarness();
  sandbox.nativeScenePacketVersion = native.scene.schema.version;
  sandbox.NativeHost.scene.submit = native.scene.submit;
  class PictureTilingSprite extends sandbox.PIXI.extras.TilingSprite {}
  sandbox.PIXI.extras.PictureTilingSprite = PictureTilingSprite;
  const canvas = native.canvas.create(width, height);
  canvases.push(canvas);
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    pixels.set([x * 7, y * 9, (x < width / 2 ? 32 : 160) + (y < height / 2 ? 0 : 64), 255],
      (y * width + x) * 4);
  }
  native.canvas.writePixels(canvas.handle, 0, 0, width, height, pixels);
  const texture = makeTexture(width, height);
  texture.baseTexture.source._nativeImage.handle = canvas.handle;
  for (const nearest of [true, false]) for (const picture of [true, false]) {
    for (const respectAnchor of [false, true]) {
      texture.baseTexture.scaleMode = nearest ? sandbox.PIXI.SCALE_MODES.NEAREST : sandbox.PIXI.SCALE_MODES.LINEAR;
      const stage = new sandbox.PIXI.Container();
      const SpriteType = picture ? PictureTilingSprite : sandbox.PIXI.extras.TilingSprite;
      const node = new SpriteType(texture, width, height);
      node.anchor = { x: 0.5, y: 0.5 };
      node.origin = { x: -width / 2, y: -height / 2 };
      node.x = width / 2; node.y = height / 2;
      node.uvRespectAnchor = respectAnchor;
      stage.addChild(node);
      native.beginFrame();
      assert.equal(sandbox.submitNativeScene(stage), true);
      native.renderFrame(); native.swapFrame();
      const actual = native.canvas.captureSceneRawPremultiplied();
      const expected = new Uint8Array(pixels.length);
      const shift = picture || respectAnchor ? 0 : 1;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const source = (((y + shift * height / 2) % height) * width +
          (x + shift * width / 2) % width) * 4;
        expected.set(pixels.subarray(source, source + 4), (y * width + x) * 4);
      }
      assert.deepEqual(Buffer.from(actual), Buffer.from(expected),
        `picture=${picture} respectAnchor=${respectAnchor} nearest=${nearest}`);
      assert.equal(node.uvRespectAnchor, respectAnchor);
      assert.deepEqual(node.origin, { x: -width / 2, y: -height / 2 });
    }
  }
  console.log('eight anchored tiling pixel cases match exactly');
} finally {
  for (const canvas of canvases) native.canvas.release(canvas.handle);
  native.runtime.quit();
}
