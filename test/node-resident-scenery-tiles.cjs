'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createContext, runModule } = require('./helpers/pixi5-context.cjs');
const { png } = require('./helpers/png.cjs');
const native = require(path.resolve(process.argv[2]));
const assets = path.resolve(process.argv[3]);
const root = fs.mkdtempSync(path.join(assets, 'pmjs-resident-scenery-'));
const source = 'img/overlays/scenery.png';
const sourceFile = path.join(root, source);
const tileDirectory = path.join(root, 'prepared-scenery');
const tileSetId = 'resident-scenery-test';
let image = null;
let initialized = false;

async function main() {
  try {
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, png(2049, 2049, Buffer.alloc(2049 * 2049 * 4, 255)));
    native.initialize({ gameRoot: root, width: 32, height: 24,
      windowTitle: 'prepared resident scenery' });
    initialized = true;
    fs.mkdirSync(tileDirectory, { recursive: true });

    const rectangles = [];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
      rectangles.push([x * 683, y * 683, 683, 683]);
    }
    const descriptor = await native.assets.processTiles([
      { file: sourceFile, rectangles },
    ], tileDirectory);
    Object.assign(descriptor.sources[0], {
      source,
      snapshot: sourceFile,
      sourceIdentity: native.assets.sourceIdentity(source),
    });
    const tileSet = { identity: tileSetId, directory: tileDirectory, descriptor };
    assert.equal(native.assets.installTileSets([tileSet], true), 1);
    image = await native.images.loadAsync(source, false, tileSetId);

    const { context } = createContext();
    context.NativeHost.render = native.render;
    context.NativeHost.scene.submit = native.scene.submit;
    Object.assign(context.NativeHost.scene.schema, native.scene.schema);
    context.PIXI.Texture = class {
      constructor(baseTexture, frame) { Object.assign(this, { baseTexture, frame, valid: true }); }
    };
    context.PIXI.filters = { AlphaFilter: class {} };
    runModule(context, 'js/pmjs-core/methods.js');
    runModule(context, 'js/pmjs-pixi5/scene.js');
    runModule(context, 'js/pmjs-pixi5/filters.js');
    runModule(context, 'js/pmjs-pixi5/renderer.js');
    context.PMJS.methods.install();

    const renderer = new context.PIXI.Renderer({ width: 32, height: 24, transparent: true });
    const baseTexture = { resource: { source: { _nativeImage: image } },
      width: 2049, height: 2049, resolution: 1,
      scaleMode: context.PIXI.SCALE_MODES.LINEAR };
    const texture = new context.PIXI.Texture(baseTexture,
      { x: 0, y: 0, width: 2049, height: 2049 });
    const stage = new context.PIXI.Container();
    const parallax = new context.PIXI.TilingSprite(texture, 32, 24);
    parallax.tilePosition.x = -1320;
    parallax.tilePosition.y = -624;
    stage.addChild(parallax);

    native.beginFrame();
    renderer.render(stage);
    native.renderScene();
    const after = native.images.memory();
    const owners = native.images.memory(100).largest;
    const owner = owners.find(entry => entry.handle === image.handle);
    assert.ok(owner.fullTextureResident, 'large tiling images remain fully resident');
    assert.deepEqual(Array.from(native.canvas.captureSceneRawPremultiplied().subarray(0, 4)),
      [255, 255, 255, 255], 'full-resident scenery preserves source pixels');
    for (const position of [-1321, -1824, 0, -2049]) {
      parallax.tilePosition.x = position;
      native.beginFrame();
      renderer.render(stage);
      native.renderScene();
      assert.deepEqual(Array.from(native.canvas.captureSceneRawPremultiplied().subarray(0, 4)),
        [255, 255, 255, 255], 'scrolling preserves full-resident pixels');
    }
    const scrolled = native.images.memory();
    assert.equal(scrolled.textureUploadBytes, after.textureUploadBytes,
      'scrolling a resident texture never replaces or uploads a window');
  } finally {
    if (image) native.images.release(image.handle);
    if (initialized) native.runtime.quit();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
