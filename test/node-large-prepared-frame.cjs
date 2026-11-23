'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { png } = require('./helpers/png.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const native = require(path.resolve(process.argv[2]));
const root = temporaryDirectory('pmjs-large-prepared-frame-');
const pixels = Buffer.alloc(384 * 128 * 4);
for (let i = 0; i < pixels.length; i += 4) pixels.set([255, 255, 255, 0], i);
for (let y = 40; y < 64; ++y) for (let x = 56; x < 68; ++x)
  pixels.set([43, 101, 199, 128], (y * 384 + x) * 4);
for (let y = 40; y < 72; ++y) for (let x = 168; x < 200; ++x)
  pixels.set([96, 96, 96, 128], (y * 384 + x) * 4);
const sourceBytes = png(384, 128, pixels);
fs.writeFileSync(path.join(root, 'sheet.png'), sourceBytes);

function draw(image, source, effect = 0, scale = 1) {
  const schema = native.scene.schema;
  const values = new Float32Array(schema.valueStride);
  values.set([scale, 0, 0, scale, 4, 4, 1]);
  values.set(source, 9); values.set(source.slice(2), 13);
  if (effect) values.set(effect === 1 ? [1, 1, 1, 0.25] : [0.3, 0.5, 0.7, 0.4], 37);
  if (effect === 2) values.set([0.1, 0, -0.1, 0.4], 33);
  native.beginFrame();
  native.scene.submit(schema.version,
    new Uint32Array([1, 0xffffffff, image.handle, 0xffffff, 0,
      (1 << 17) | (effect ? 1 << 4 : 0), 0]), values, 1);
  native.renderScene();
  return Buffer.from(native.canvas.captureSceneRawPremultiplied());
}

test('large prepared frames fit by trimming only zero exterior pixels', async () => {
  native.initialize({ gameRoot: root, width: 180, height: 180,
    windowTitle: 'large prepared frames', preparedPageSplitThresholdBytes: 4096 });
  assert.equal(native.images.memory().preparedPageSplitThresholdBytes, 4096);
  native.render.setClearColor(0.1, 0.2, 0.3, 1);
  let original, prepared;
  try {
    const directory = path.join(root, 'prepared'); fs.mkdirSync(directory);
    const descriptor = await native.assets.processImage('sheet.png', directory, { grid: [6, 2] });
    assert.ok(descriptor);
    native.assets.installImageStorage([{ source: 'sheet.png', sourceIdentity: native.assets.sourceIdentity('sheet.png'),
      storage: { version: 1, width: 384, height: 128, paletteBits: 0, channels: 4,
        source: [0, 1, 2, 3], swizzle: [0, 1, 2, 3] } }]);
    native.assets.installPrepared([{ source: 'sheet.png', directory, descriptor,
      sourceIdentity: native.assets.sourceIdentity('sheet.png') }]);
    original = native.images.loadBytes(sourceBytes);
    prepared = await native.images.loadAsync('sheet.png');
    assert.deepEqual([prepared.width, prepared.height], [384, 128]);
    const before = native.images.memory();
    for (const source of [[0, 0, 128, 128], [168, 40, 32, 32], [256, 0, 128, 128]]) {
      for (const effect of [0, 1, 2]) for (const scale of [1, 1.25]) {
        const reference = draw(original, source, effect, scale);
        const candidate = draw(prepared, source, effect, scale);
        let delta = 0;
        for (let i = 0; i < reference.length; ++i)
          delta = Math.max(delta, Math.abs(reference[i] - candidate[i]));
        assert.ok(delta <= 1, `trimmed frame changed effect ${effect}, scale ${scale}: ${delta}`);
      }
    }
    const after = native.images.memory();
    assert.equal(after.sourceTextureBuilds, 0);
  } finally {
    if (original) native.images.release(original.handle);
    if (prepared) native.images.release(prepared.handle);
    native.runtime.quit();
  }
});
