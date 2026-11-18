'use strict';

process.env.PMJS_GRAPHICS_DIAGNOSTICS = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { png } = require('./helpers/png.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const native = require(path.resolve(process.argv[2]));
const root = temporaryDirectory('pmjs-prepared-frame-effects-');
const pixels = Buffer.alloc(96 * 48 * 4);
for (let frame = 0; frame < 3; ++frame) {
  for (let y = 8; y < 16; ++y) for (let x = 0; x < 32; ++x) {
    if ((x >= 6 && x < 10) || (x >= 22 && x < 26)) continue;
    pixels.set([40 + frame * 70, 180 - frame * 40, 75 + y * 3,
      (x + y) % 3 === 0 ? 255 : 128], (y * 96 + frame * 32 + x) * 4);
  }
}
for (let y = 32; y < 40; ++y) for (let x = 32; x < 64; ++x) {
  if (x < 38 || x >= 58) continue;
  pixels.set([220, 50, 90, 255], (y * 96 + x) * 4);
}
const sourceBytes = png(96, 48, pixels);
fs.writeFileSync(path.join(root, 'sheet.png'), sourceBytes);
const oversizedPixels = Buffer.alloc(2400 * 1000 * 4);
for (let y = 400; y < 600; ++y) for (let x = 500; x < 700; ++x)
  oversizedPixels.set([190, 70, 130, (x + y) % 3 === 0 ? 255 : 128], (y * 2400 + x) * 4);
const oversizedBytes = png(2400, 1000, oversizedPixels);
fs.writeFileSync(path.join(root, 'oversized.png'), oversizedBytes);
const schema = native.scene.schema;

function draw(image, { frame = 1, height = 24, tone = [0, 0, 0, 0],
  flash = [1, 1, 1, 0.25], blend = 0, alpha = 1, nearest = false,
  packedUv = false, scaled = false, colored = true, mipmap = false, source, transform } = {}) {
  const flags = (colored ? 1 << 4 : 0) | (nearest ? 8 : 0) | (packedUv ? 0 : 1 << 17) | (mipmap ? 1 << 16 : 0);
  const values = new Float32Array(schema.valueStride);
  values.set(transform || (scaled ? [1.25, 0, 0, 1.25, 12.5, 8.5, alpha] :
    [1, 0, 0, 1, 12, 8, alpha]));
  const rectangle = source || [frame * 32, 0, 32, height];
  values.set(rectangle, 9);
  values.set(rectangle.slice(2), 13);
  values.set(tone, 33);
  values.set(flash, 37);
  native.beginFrame();
  native.scene.submit(schema.version,
    new Uint32Array([1, 0xffffffff, image.handle, 0xffffff, blend, flags, 0]), values, 1);
  native.renderScene();
  return Buffer.from(native.canvas.captureSceneRawPremultiplied());
}

function compare(candidate, reference, label) {
  let delta = 0;
  for (let index = 0; index < candidate.length; ++index)
    delta = Math.max(delta, Math.abs(candidate[index] - reference[index]));
  assert.ok(delta <= 1, `${label}: maximum channel difference ${delta}`);
}

test('prepared frames preserve sprite color effects and packed-UV fallback', async () => {
  native.initialize({ gameRoot: root, width: 80, height: 56,
    windowTitle: 'prepared frame effects', imageWarmCacheBytes: 0 });
  native.render.setClearColor(0.17, 0.23, 0.31, 1);
  let original, prepared, oversizedOriginal, oversizedPrepared;
  try {
    const directory = path.join(root, 'prepared');
    fs.mkdirSync(directory);
    const descriptor = await native.assets.processImage('sheet.png', directory,
      { grid: [3, 2], backdrop: [0, 0, 0, 0] });
    assert.ok(descriptor, 'fixture must use prepared storage');
    native.assets.installPrepared([{ source: 'sheet.png', directory, descriptor,
      sourceIdentity: native.assets.sourceIdentity('sheet.png') }]);
    original = native.images.loadBytes(sourceBytes);
    draw(original, { mipmap: true }); // Force an ordinary RGBA reference.
    prepared = await native.images.loadAsync('sheet.png');
    const before = native.images.memory();
    for (const effect of [
      { name: 'selection', flash: [1, 1, 1, 64 / 255] },
      { name: 'collapse', frame: 2, height: 13, flash: [1, 0.5, 0.5, 0.5] },
      { name: 'boss-collapse', frame: 0, height: 9, flash: [1, 1, 1, 0.8] },
      { name: 'tone-gray', tone: [0.13, -0.07, 0.04, 0.65], flash: [0.3, 0.7, 0.2, 0.3] },
    ]) for (const blend of [0, 1, 2]) for (const alpha of [1, 0.41]) {
      for (const nearest of [false, true]) {
        const options = { ...effect, blend, alpha, nearest };
        const reference = draw(original, options);
        compare(draw(prepared, options), reference,
          `${effect.name}: blend=${blend}, alpha=${alpha}, nearest=${nearest}`);
      }
    }
    assert.equal(native.images.memory().preparedFrameConversions, 0);
    // Colored frame edges need neighboring source pixels from the halo.
    for (const packedUv of [false, true]) for (const tone of [[0, 0, 0, 0], [0.1, 0, 0, 0.3]]) {
      const options = { frame: 1, scaled: true, packedUv, tone };
      compare(draw(prepared, options), draw(original, options), `halo: packed=${packedUv}, tone=${tone}`);
    }
    for (const packedUv of [false,true]) for (const nearest of [false,true])
      for (const tone of [[0,0,0,0],[0.1,0,0,0.3]]) {
        const options = { source: [32, 24, 32, 24], packedUv, nearest, tone };
        compare(draw(prepared, options), draw(original, options),
          `lower sheet row: packed=${packedUv}, nearest=${nearest}, tone=${tone}`);
      }
    const cached = native.images.memory(100);
    assert.equal(cached.preparedFrameConversions, 0);
    assert.equal(cached.preparedFrameCacheBytes, 0);
    assert.equal(cached.sourceTextureBuilds, 0);
    const options = { frame: 1, flash: [1, 1, 1, 0.25] };
    draw(prepared, options);
    const warmed = native.images.memory();
    draw(prepared, options);
    assert.equal(native.images.memory().textureUploadBytes, warmed.textureUploadBytes,
      'sprite color effects uploaded the same cached frame again');
    compare(draw(prepared, { colored: false }), draw(original, { colored: false }),
      'ordinary sprite after color effects');
    const oversizedDirectory = path.join(root, 'oversized-prepared');
    fs.mkdirSync(oversizedDirectory);
    const oversizedDescriptor = await native.assets.processImage('oversized.png', oversizedDirectory,
      { grid: [4, 2], backdrop: [0, 0, 0, 0] });
    assert.ok(oversizedDescriptor);
    native.assets.installPrepared([{ source: 'oversized.png', directory: oversizedDirectory,
      descriptor: oversizedDescriptor, sourceIdentity: native.assets.sourceIdentity('oversized.png') }]);
    oversizedOriginal = native.images.loadBytes(oversizedBytes);
    draw(oversizedOriginal, { mipmap: true });
    oversizedPrepared = await native.images.loadAsync('oversized.png');
    const beforeOversized = native.images.memory();
    for (const tone of [[0, 0, 0, 0], [0.13, -0.07, 0.04, 0.65]]) {
      const oversizedOptions = { source: [0, 0, 1200, 1000],
        transform: [0.05, 0, 0, 0.05, 8, 3, 1], tone };
      compare(draw(oversizedPrepared, oversizedOptions), draw(oversizedOriginal, oversizedOptions),
        `zero exterior after frame trimming: tone=${tone}`);
    }
    const afterOversized = native.images.memory();
    assert.equal(afterOversized.preparedFrameConversions, 0);
    assert.equal(afterOversized.preparedFrameCacheBytes, 0);
  } finally {
    if (original) native.images.release(original.handle);
    if (prepared) native.images.release(prepared.handle);
    if (oversizedOriginal) native.images.release(oversizedOriginal.handle);
    if (oversizedPrepared) native.images.release(oversizedPrepared.handle);
    native.runtime.quit();
  }
});
