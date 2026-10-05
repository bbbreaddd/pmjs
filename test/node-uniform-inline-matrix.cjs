'use strict';

process.env.PMJS_GRAPHICS_DIAGNOSTICS = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { png } = require('./helpers/png.cjs');
const native = require(path.resolve(process.argv[2]));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-uniform-matrix-'));
const width = 96, height = 72;
const uniformFixtures = [
  ['black', 816, 624, [0, 0, 0, 255]],
  ['colour', 192, 96, [37, 83, 129, 255]],
  ['translucent', 192, 96, [37, 83, 129, 117]],
  ['hidden-rgb', 192, 96, [37, 83, 129, 0]],
  ['transparent', 192, 96, [0, 0, 0, 0]],
];
for (const [name, imageWidth, imageHeight, rgba, grid] of [
  ...uniformFixtures, ['nonuniform', 256, 128, [37, 83, 129, 255], [2, 1]],
]) {
  const pixels = Buffer.alloc(imageWidth * imageHeight * 4);
  for (let y = 0; y < imageHeight; ++y) for (let x = 0; x < imageWidth; ++x) {
    const inside = !grid || (x % (imageWidth / grid[0]) >= 5 &&
      x % (imageWidth / grid[0]) < 30 && y >= 3 && y < 25);
    if (inside) pixels.set(grid && x >= imageWidth / 2 ? [83, 37, 129, 255] : rgba,
      (y * imageWidth + x) * 4);
  }
  fs.writeFileSync(path.join(root, name + '.png'), png(imageWidth, imageHeight, pixels));
}

native.initialize({ gameRoot: root, assetRoot: '', width, height,
  windowTitle: 'uniform inline matrix pixels' });
const schema = native.scene.schema;
const noParent = 0xffffffff;
const matrices = [
  [0.8, 0, 0, 0, 0.1, 0, 0.9, 0, 0, 0.05, 0, 0, 0.7, 0, 0.03, 0, 0, 0, 1, 0],
  [0, 0, 1.3, 0, -0.1, 1.2, 0, 0, 0, 0.2, 0, 0.7, 0, 0, -0.05, 0, 0, 0, 1, 0],
];

function record(kind, parent = noParent, image = 0, flags = 0) {
  const values = new Float32Array(schema.valueStride);
  values.set([1, 0, 0, 1, 0, 0, 1]);
  return { metadata: [kind, parent, image, 0xc3e7af, 0, flags, 0], values };
}

function draw(image, { source, transform, nearest = true, alpha = 0.63,
  matrix = null, matrixAlpha = 1, clip = null, offscreen = false }) {
  const child = record(1, matrix ? 0 : noParent, image.handle, nearest ? 8 : 0);
  child.values.set([...transform, alpha]);
  child.values.set(source, 9);
  child.values.set([source[2], source[3]], 13);
  let entries = [child];
  if (matrix) {
    const filter = record(6, noParent, 0, clip ? 1 : 0);
    filter.metadata[4] = 25;
    filter.values.set(matrix.slice(0, 10), 7);
    filter.values.set(matrix.slice(10), 22);
    filter.values[32] = matrixAlpha;
    filter.values[33] = 1;
    if (clip) filter.values.set(clip, 17);
    entries = [filter, child, record(7, 0)];
  }
  const metadata = new Uint32Array(entries.length * schema.metadataStride);
  const values = new Float32Array(entries.length * schema.valueStride);
  entries.forEach((entry, index) => {
    metadata.set(entry.metadata, index * schema.metadataStride);
    values.set(entry.values, index * schema.valueStride);
  });
  const before = native.render.stats();
  native.beginFrame();
  native.scene.submit(schema.version, metadata, values, entries.length);
  let pixels;
  if (offscreen) {
    const target = native.canvas.create(width, height);
    try {
      native.render.renderToCanvas(target.handle);
      pixels = Buffer.from(native.canvas.readPixels(target.handle, 0, 0, width, height));
    } finally { native.canvas.release(target.handle); }
  } else {
    native.renderScene();
    pixels = Buffer.from(native.canvas.captureSceneRawPremultiplied());
  }
  const after = native.render.stats();
  return { pixels, effects: after.effectSpriteDrawCalls - before.effectSpriteDrawCalls,
    passes: after.filterApplications[25] - before.filterApplications[25] };
}

async function fixture(name, imageWidth, imageHeight, grid = null) {
  const source = name + '.png', directory = path.join(root, name);
  const bytes = fs.readFileSync(path.join(root, source));
  fs.mkdirSync(directory);
  const descriptor = await native.assets.processImage(source, directory,
    grid ? { grid, backdrop: [0, 0, 0, 0] } : null);
  assert.ok(descriptor);
  const ordinary = native.images.loadBytes(bytes);
  native.assets.installPrepared([{ source, directory, descriptor,
    sourceIdentity: native.assets.sourceIdentity(source) }]);
  const prepared = await native.images.loadAsync(source);
  assert.deepEqual([prepared.width, prepared.height], [imageWidth, imageHeight]);
  return { ordinary, prepared, descriptor };
}

async function main() {
  let comparisons = 0;
  const storage = [];
  // Diagnostic fallback storage is independent of the sources measured below.
  native.images.memory();
  for (const [name, imageWidth, imageHeight, rgba] of uniformFixtures) {
    const { ordinary, prepared, descriptor } = await fixture(name, imageWidth, imageHeight);
    assert.deepEqual(descriptor.uniform, rgba);
    const full = [0, 0, imageWidth, imageHeight];
    const fit = [width / imageWidth, 0, 0, height / imageHeight, 0, 0];
    const first = { source: full, transform: fit, matrix: matrices[0], alpha: 150 / 255 };
    native.render.setClearColor(0.08, 0.15, 0.2, 1);
    const control = draw(ordinary, first);
    const before = native.images.memory();
    const candidate = draw(prepared, first);
    const compact = native.images.memory();
    assert.deepEqual(candidate.pixels, control.pixels, name + ': first filtered frame');
    assert.equal(candidate.effects, 1, 'colour matrix must stay inline');
    assert.equal(candidate.passes, 0, 'colour matrix allocated a filter pass');
    assert.equal(compact.preparedMaterializations, before.preparedMaterializations,
      name + ': inline matrix expanded the source');
    const pixelBytes = rgba.slice(0, 3).some(channel => Math.round(channel * rgba[3] / 255) !== channel) ? 8 : 4;
    assert.equal(compact.gpuBytes - before.gpuBytes, pixelBytes, name + ': source texture bytes');
    assert.equal(compact.textureUploadBytes - before.textureUploadBytes, pixelBytes);
    ++comparisons;
    const sources = [full, [5.25, 3.5, 25.5, 19.5]];
    const transforms = [fit, [1.31, 0.17, -0.2, 1.19, 28.25, 15.5], [-1.75, 0, 0, 1.5, 94, 20]];
    for (const backgroundAlpha of [0, 1]) {
      native.render.setClearColor(0.08, 0.15, 0.2, backgroundAlpha);
      for (const nearest of [true, false]) for (const source of sources) {
        for (const transform of transforms) for (const clip of [null, [9, 6, 80, 62]]) {
          for (const [index, matrix] of matrices.entries()) {
            const options = { source, transform, nearest, matrix, clip,
              alpha: index ? 0.37 : 150 / 255, matrixAlpha: index ? 0.41 : 1 };
            assert.deepEqual(draw(prepared, options).pixels, draw(ordinary, options).pixels,
              JSON.stringify({ name, backgroundAlpha, ...options }));
            ++comparisons;
          }
        }
      }
    }
    const snapshot = { ...first, clip: [9, 6, 80, 62], offscreen: true };
    assert.deepEqual(draw(prepared, snapshot).pixels, draw(ordinary, snapshot).pixels,
      name + ': offscreen filtered frame');
    assert.deepEqual(draw(prepared, { ...first, matrix: null }).pixels,
      draw(ordinary, { ...first, matrix: null }).pixels, name + ': filter removal');
    const after = native.images.memory();
    assert.equal(after.preparedMaterializations, before.preparedMaterializations);
    assert.equal(after.textureUploadBytes, compact.textureUploadBytes,
      name + ': reuse uploaded source pixels again');
    storage.push({ name, sourceBytes: pixelBytes, materializations: 0 });
    comparisons += 2;
    native.images.release(ordinary.handle);
    native.images.release(prepared.handle);
  }
  const { ordinary, prepared, descriptor } = await fixture('nonuniform', 256, 128, [2, 1]);
  assert.equal(descriptor.uniform, undefined);
  const options = { source: [0, 0, 128, 128], transform: [0.5, 0, 0, 0.5, 8, 4], matrix: matrices[0] };
  const beforePlain = native.images.memory();
  assert.deepEqual(draw(prepared, { ...options, matrix: null }).pixels,
    draw(ordinary, { ...options, matrix: null }).pixels);
  assert.equal(native.images.memory().preparedMaterializations, beforePlain.preparedMaterializations,
    'ordinary nonuniform sprite should use its compact region');
  assert.ok(native.images.memory().preparedRegions > beforePlain.preparedRegions);
  const control = draw(ordinary, options);
  const before = native.images.memory();
  assert.deepEqual(draw(prepared, options).pixels, control.pixels);
  assert.equal(native.images.memory().preparedMaterializations, before.preparedMaterializations + 1,
    'nonuniform inline filtering must retain compatible source sampling');
  native.images.release(ordinary.handle);
  native.images.release(prepared.handle);
  console.log(JSON.stringify({ comparisons: comparisons + 2, storage }));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  native.runtime.quit();
  fs.rmSync(root, { recursive: true, force: true });
});
