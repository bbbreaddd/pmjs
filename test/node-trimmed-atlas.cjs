'use strict';

process.env.PMJS_GRAPHICS_DIAGNOSTICS = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { png } = require('./helpers/png.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const native = require(path.resolve(process.argv[2]));

const root = temporaryDirectory('pmjs-trimmed-atlas-');

function writePng(name, width, height, fillFn) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) {
      pixels.set(fillFn(x, y), (y * width + x) * 4);
    }
  }
  fs.writeFileSync(path.join(root, name), png(width, height, pixels));
}

const specs = {
  safe: [192, 64, [3, 2], (x, y) => {
    const cellX = Math.floor(x / 64), cellY = Math.floor(y / 32);
    if (cellX === 1 && cellY === 0) return [0, 0, 0, 0];
    const lx = x % 64, ly = y % 32;
    if (lx >= 6 && lx < 58 && ly >= 5 && ly < 27) {
      return [(lx * 7) % 256, (ly * 11) % 256, ((lx + ly) * 5) % 256, 200];
    }
    return [0, 0, 0, 0];
  }],
  'unsafe-border': [128, 32, [2, 1], (x, y) => {
    if (x >= 5 && x < 64 && y >= 5 && y < 27) return [200, 40, 40, 255];
    if (x >= 64 && x < 120 && y >= 5 && y < 27) return [40, 200, 40, 255];
    return [0, 0, 0, 0];
  }],
  'empty-adj': [128, 32, [2, 1], (x, y) => {
    if (x === 64 && y >= 4 && y < 28) return [255, 80, 20, 255];
    return [0, 0, 0, 0];
  }],
  'hidden-rgb': [128, 32, [2, 1], (x, y) => {
    const lx = x % 64;
    if (lx >= 6 && lx < 58 && y >= 5 && y < 27) return [50, 150, 220, 255];
    return [120, 40, 200, 0];
  }],
  legacy: [128, 32, [2, 1], (x, y) => {
    const lx = x % 64;
    if (lx >= 6 && lx < 58 && y >= 5 && y < 27) return [30, 180, 90, 255];
    return [0, 0, 0, 0];
  }],
  uniform: [64, 32, [1, 1], () => [40, 120, 200, 180]],
};

for (const [name, [w, h, , fn]] of Object.entries(specs)) {
  writePng(`${name}-orig.png`, w, h, fn);
  fs.copyFileSync(path.join(root, `${name}-orig.png`), path.join(root, `${name}-prep.png`));
}

native.initialize({ gameRoot: root, assetRoot: '', width: 128, height: 96, windowTitle: 'trimmed atlas',
  imageWarmCacheBytes: 0, preparedFrameCacheBytes: 0 });
native.render.setClearColor(0.08, 0.12, 0.16, 1);
const schema = native.scene.schema;

function renderSprite(image, source, transform, { blendColor = [1, 1, 1], blendAlpha = 0, colorTone = false } = {}) {
  const flags = (blendAlpha > 0 || colorTone) ? (1 << 4) : 0;
  const metadata = new Uint32Array([1, 0xffffffff, image.handle, 0xffffff, 0, flags, 0]);
  const values = new Float32Array(schema.valueStride);
  values.set([...transform, 1]);
  values.set(source, 9);
  values.set([source[2], source[3]], 13);
  if (flags) {
    values.set(colorTone ? [20, -10, 15, 0] : [0, 0, 0, 0], 33);
    values.set([...blendColor, blendAlpha], 37);
  }
  native.beginFrame();
  native.scene.submit(schema.version, metadata, values, 1);
  native.renderScene();
  return Buffer.from(native.canvas.captureSceneRawPremultiplied());
}

function maxDiff(a, b) {
  assert.equal(a.length, b.length);
  let max = 0;
  for (let i = 0; i < a.length; ++i) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
  }
  return max;
}

async function prepareCase(name, mutateDescriptor, recipeOverride) {
  const [, , grid] = specs[name];
  const rawName = `${name}-orig.png`;
  const prepName = `${name}-prep.png`;
  const dir = path.join(root, `${name}-dir`);
  fs.mkdirSync(dir);
  const descriptor = await native.assets.processImage(prepName, dir,
    recipeOverride === undefined ? { grid } : recipeOverride);
  assert.ok(descriptor, `${name}: expected prepared descriptor`);
  const installed = mutateDescriptor ? mutateDescriptor({ ...descriptor }) : descriptor;
  native.assets.installPrepared([{
    source: prepName, directory: dir, descriptor: installed,
    sourceIdentity: native.assets.sourceIdentity(prepName),
  }]);
  const orig = await native.images.loadAsync(rawName);
  const prep = await native.images.loadAsync(prepName);
  return { orig, prep, descriptor: installed };
}

test('guarded trimmed atlas safety and highlighting', async () => {
  try {
    // 1. Safe cropped frames with >= 2px {0,0,0,0} border + empty frame with safe border.
    const safe = await prepareCase('safe');
    assert.equal(safe.descriptor.safeLinearTrimmedSampling, true);
    const beforeSafe = native.images.memory();
    const outSafe = renderSprite(safe.prep, [0, 0, 64, 32], [0.875, 0, 0, 0.875, 10.375, 8.625]);
    const refSafe = renderSprite(safe.orig, [0, 0, 64, 32], [0.875, 0, 0, 0.875, 10.375, 8.625]);
    assert.ok(maxDiff(outSafe, refSafe) <= 1);
    const afterSafe = native.images.memory();
    assert.ok(afterSafe.preparedRegions > beforeSafe.preparedRegions, 'safe trimmed atlas should use preparedRegions');
    assert.equal(afterSafe.sourceTextureBuilds, beforeSafe.sourceTextureBuilds);

    // Arbitrary subrectangle, rotation/mirroring, and cross-cell fallback.
    for (const [label, source, transform, expectFallback] of [
      ['subrect', [8, 6, 36, 18], [1.125, 0, 0, 1.125, 14.25, 9.75], false],
      ['rotated-mirrored', [0, 0, 64, 32], [-0.875, 0.25, -0.25, -0.875, 90.25, 50.5], false],
      ['cross-cell', [32, 0, 64, 32], [1, 0, 0, 1, 10, 8], true],
    ]) {
      const mBefore = native.images.memory();
      const out = renderSprite(safe.prep, source, transform);
      const ref = renderSprite(safe.orig, source, transform);
      assert.ok(maxDiff(out, ref) <= 1, `${label} pixel mismatch`);
      const mAfter = native.images.memory();
      if (expectFallback) assert.equal(mAfter.preparedRegions, mBefore.preparedRegions, `${label} should fall back`);
      else assert.ok(mAfter.preparedRegions > mBefore.preparedRegions, `${label} should use preparedRegions`);
    }

    // Enemy highlighting (appliesSpriteColor) on safe trimmed atlas must not materialize full source.
    const beforeFlash = native.images.memory();
    const outFlash = renderSprite(safe.prep, [0, 0, 64, 32], [1, 0, 0, 1, 10, 8],
      { blendColor: [1, 1, 1], blendAlpha: 160 / 255 });
    const refFlash = renderSprite(safe.orig, [0, 0, 64, 32], [1, 0, 0, 1, 10, 8],
      { blendColor: [1, 1, 1], blendAlpha: 160 / 255 });
    assert.equal(maxDiff(outFlash, refFlash), 0, 'sprite color blend must match original exactly');
    const afterFlash = native.images.memory();
    assert.equal(afterFlash.sourceTextureBuilds, beforeFlash.sourceTextureBuilds,
      'enemy highlighting must not force full-source build');
    assert.deepEqual(afterFlash.preparedFallbacks, beforeFlash.preparedFallbacks);
    native.images.release(safe.orig.handle);
    native.images.release(safe.prep.handle);

    // Uniform 1x1 sprite with blendColor.
    const uniformCase = await prepareCase('uniform', null, null);
    assert.ok(uniformCase.descriptor.uniform, 'expected uniform descriptor');
    const outUniform = renderSprite(uniformCase.prep, [0, 0, 64, 32], [1, 0, 0, 1, 12, 10],
      { blendColor: [1, 1, 1], blendAlpha: 0.5 });
    const refUniform = renderSprite(uniformCase.orig, [0, 0, 64, 32], [1, 0, 0, 1, 12, 10],
      { blendColor: [1, 1, 1], blendAlpha: 0.5 });
    assert.equal(maxDiff(outUniform, refUniform), 0, 'uniform sprite blendColor must match original');
    native.images.release(uniformCase.orig.handle);
    native.images.release(uniformCase.prep.handle);

    // 2. Zero-fill frame touching opaque neighboring cell border must be rejected.
    const unsafeBorder = await prepareCase('unsafe-border');
    assert.equal(unsafeBorder.descriptor.safeLinearTrimmedSampling || false, false);
    native.images.release(unsafeBorder.orig.handle);
    native.images.release(unsafeBorder.prep.handle);

    // 3. Empty frame adjacent to opaque artwork must not be marked safe or lose neighbor sampling.
    const emptyAdj = await prepareCase('empty-adj');
    assert.equal(emptyAdj.descriptor.safeLinearTrimmedSampling || false, false);
    const outEmpty = renderSprite(emptyAdj.prep, [0, 0, 64, 32], [1, 0, 0, 1, 10, 8]);
    const refEmpty = renderSprite(emptyAdj.orig, [0, 0, 64, 32], [1, 0, 0, 1, 10, 8]);
    assert.equal(maxDiff(outEmpty, refEmpty), 0);
    native.images.release(emptyAdj.orig.handle);
    native.images.release(emptyAdj.prep.handle);

    // 4. Transparent border with hidden RGB must be rejected.
    const hiddenRgb = await prepareCase('hidden-rgb');
    assert.equal(hiddenRgb.descriptor.safeLinearTrimmedSampling || false, false);
    native.images.release(hiddenRgb.orig.handle);
    native.images.release(hiddenRgb.prep.handle);

    // 5. Legacy descriptor without safeLinearTrimmedSampling must fall back.
    const legacy = await prepareCase('legacy', desc => { delete desc.safeLinearTrimmedSampling; return desc; });
    const beforeLegacy = native.images.memory();
    const outLegacy = renderSprite(legacy.prep, [0, 0, 64, 32], [0.875, 0, 0, 0.875, 10.375, 8.625]);
    const refLegacy = renderSprite(legacy.orig, [0, 0, 64, 32], [0.875, 0, 0, 0.875, 10.375, 8.625]);
    assert.ok(maxDiff(outLegacy, refLegacy) <= 1);
    const afterLegacy = native.images.memory();
    assert.equal(afterLegacy.preparedRegions, beforeLegacy.preparedRegions,
      'legacy descriptor without safeLinearTrimmedSampling must fall back');
    native.images.release(legacy.orig.handle);
    native.images.release(legacy.prep.handle);
  } finally {
    native.runtime.quit();
  }
});
