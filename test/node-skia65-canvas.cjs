'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '',
  width: 64, height: 64, windowTitle: 'Skia65 Canvas ownership and uploads' });
assert.equal(native.canvas.glyphStats().backend, 'skia65');
native.render.setClearColor(0, 0, 0, 0);
native.render.configurePixiFragmentPrecision('highp');
const pixels = canvas => Buffer.from(native.canvas.readPixels(canvas.handle, 0, 0, 64, 64));
const draw = canvas => native.canvas.drawText(canvas.handle, 'text-shaping.ttf', 'AV é',
  3.25, 35.75, 24.375, 0x628ed080, 2.75, { lineJoin: 'round', italic: true });
function mutations(canvas) {
  draw(canvas);
  native.canvas.clearRect(canvas.handle, 12, 17, 3, 6);
  native.canvas.fillRect(canvas.handle, 1, 1, 2, 2, 0x2543679d);
  draw(canvas);
}
const deferred = native.canvas.create(64, 64);
const immediate = native.canvas.create(64, 64);
pixels(immediate);
mutations(deferred); mutations(immediate);
assert.equal(native.canvas.memory().deferredCanvasCount, 1);
const expected = pixels(immediate);
assert.deepEqual(pixels(deferred), expected, 'Interleaved commands preserve fractional styles and source-over order');
assert.deepEqual(Array.from(expected.subarray((1 * 64 + 1) * 4, (1 * 64 + 1) * 4 + 4)),
  [37, 67, 103, 157], 'Text must preserve untouched straight-alpha Canvas pixels');
const retained = native.canvas.create(64, 64);
native.canvas.drawImage(retained.handle, deferred.handle, 0, 0, 64, 64, 0, 0, 64, 64, 1);
native.canvas.clear(deferred.handle);
draw(deferred);
native.canvas.release(deferred.handle);
assert.deepEqual(pixels(retained), expected, 'Retained content survives source mutation and release');
native.canvas.release(retained.handle); native.canvas.release(immediate.handle);

const source = native.canvas.create(1, 1);
native.canvas.writePixels(source.handle, 0, 0, 1, 1, new Uint8Array([32, 96, 160, 128]));
const vertices = [0, 0, 64, 0, 64, 64, 0, 64], uv = [0, 0, 1, 0, 1, 1, 0, 1], indices = [0, 1, 2, 0, 2, 3];
const mesh = native.render.createMesh(source.handle, vertices, uv, indices, 1);
const bitmapMesh = native.mv.createBitmapMesh(source.handle, vertices, uv, indices, 1, { texelBounds: [0, 0, 0, 0] });
const schema = native.scene.schema;
function render(kind, resource) {
  const values = new Float32Array(schema.valueStride);
  values.set([kind === 1 ? 64 : 1, 0, 0, kind === 1 ? 64 : 1, 0, 0, 1]);
  if (kind === 1) { values.set([0, 0, 1, 1], 9); values.set([1, 1], 13); }
  native.beginFrame();
  native.scene.submit(schema.version, new Uint32Array([kind, 0xffffffff, resource, 0xffffff, 0, 8, 0]), values, 1);
  native.renderScene();
  const raw = Buffer.from(native.canvas.captureSceneRawPremultiplied());
  assert.deepEqual(Buffer.from(native.canvas.captureSceneRawPremultiplied()), raw, 'Repeated frame readback is frozen');
  return Array.from(raw.subarray((32 * 64 + 32) * 4, (32 * 64 + 32) * 4 + 4));
}
for (const [kind, resource] of [[1, source.handle], [8, mesh], [8, bitmapMesh]])
  assert.deepEqual(render(kind, resource), [16, 48, 80, 128], 'Canvas alpha metadata reaches each sprite/mesh consumer');
const uploads = native.images.memory(0);
native.canvas.writePixels(source.handle, 0, 0, 1, 1, new Uint8Array([64, 128, 192, 128]));
assert.deepEqual(render(1, source.handle), [32, 64, 96, 128]);
assert.equal(native.images.memory(0).textureRegionUpdates, uploads.textureRegionUpdates + 1);
assert.equal(native.images.memory(0).textureFullUpdates, uploads.textureFullUpdates);
native.canvas.release(source.handle);
for (const resource of [mesh, bitmapMesh]) {
  assert.deepEqual(render(8, resource), [32, 64, 96, 128], 'Meshes retain their uploaded Canvas image after its owner releases');
  native.render.releaseMesh(resource);
}
assert.equal(native.canvas.memory().liveCount, 0);
const large = native.canvas.create(816, 624);
native.canvas.readPixels(large.handle, 0, 0, 1, 1);
const scratchBefore = native.canvas.glyphStats().scratchPeakBytes;
for (const [text, x, color] of [['', 10, 0xffffffff], ['AV', -1000, 0xffffffff], ['AV', 10, 0]]) {
  native.canvas.drawText(large.handle, 'text-shaping.ttf', text, x, 40, 24.75, color, 2.75);
  assert.equal(native.canvas.glyphStats().scratchPeakBytes, scratchBefore, 'Empty, invisible and offscreen text allocate no pixel scratch');
}
native.canvas.drawText(large.handle, 'text-shaping.ttf', 'AV To', 3.75, 40.25, 24.75, 0xffffffff, 2.75);
assert.ok(native.canvas.glyphStats().scratchPeakBytes < 816 * 624 * 4 / 4,
  'Small text scratch must be bounded by ink, rather than Canvas area');
native.canvas.release(large.handle);
const stats = native.canvas.glyphStats();
assert.ok(stats.cacheBytes <= stats.cacheLimit && stats.cacheEntries <= 256 && stats.fontStacks <= 16);
assert.ok(!('freetypeRenderUs' in stats), 'Skia timing must not be reported as legacy FreeType timing');
if (process.env.PMJS_FONT_TELEMETRY !== '1' && process.env.PMJS_GLYPH_TELEMETRY !== '1') {
  assert.equal(stats.shapeNs, 0, 'Detailed shaping timing is opt-in');
  assert.equal(stats.drawNs, 0, 'Detailed draw timing is opt-in');
} else {
  assert.ok(stats.shapeNs > 0 && stats.drawNs > 0, 'Explicit telemetry measures Skia work');
}
console.log(JSON.stringify({ stats, memory: native.canvas.memory() }));
