'use strict';
process.env.PMJS_GRAPHICS_DIAGNOSTICS = '1';
const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '',
  width: 32, height: 32, windowTitle: 'filter target allocation reuse' });
native.render.setClearColor(0, 0, 0, 0);
const schema = native.scene.schema;
const canvas = native.canvas.create(32, 32);
const pixels = new Uint8Array(32 * 32 * 4);
for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
  pixels.set([x * 7, y * 7, (x + y) * 3, 255], (y * 32 + x) * 4);
}
native.canvas.writePixels(canvas.handle, 0, 0, 32, 32, pixels);
const program = native.render.createFilterProgram(
  'varying vec2 vTextureCoord; uniform sampler2D uSampler; void main(){gl_FragColor=texture2D(uSampler,vTextureCoord);}',
  'attribute vec2 aVertexPosition; attribute vec2 aTextureCoord; uniform mat3 projectionMatrix; varying vec2 vTextureCoord; void main(){gl_Position=vec4((projectionMatrix*vec3(aVertexPosition,1.0)).xy,0,1);vTextureCoord=aTextureCoord;}');
function plan(width, height, targets = 3) {
  return native.render.createFilterPlan({ frame: [0, 0, width, height],
    resolutions: Array(targets).fill(1), passes: [
      { program: program.handle, input: 0, output: 2, clear: true, blend: 0, uniforms: [], samplers: [] },
      { program: program.handle, input: 2, output: 1, clear: false, blend: 0, uniforms: [], samplers: [] },
    ] });
}
const large = plan(32, 24), small = plan(16, 12);
function render(plans) {
  const records = [];
  function add(kind, parent, resource, filter = 0) {
    const values = new Float32Array(schema.valueStride);
    values.set([1, 0, 0, 1, 0, 0, 1]);
    if (kind === 1) { values.set([0, 0, 32, 32], 9); values.set([32, 32], 13); }
    records.push({ metadata: [kind, parent, resource, 0xffffff, filter, 0, 0], values });
  }
  for (const plan of plans) {
    const group = records.length;
    add(6, 0xffffffff, plan.handle, 31);
    add(1, group, canvas.handle);
    add(7, group, 0);
  }
  const metadata = new Uint32Array(records.length * schema.metadataStride);
  const values = new Float32Array(records.length * schema.valueStride);
  records.forEach((r, i) => {
    metadata.set(r.metadata, i * schema.metadataStride);
    values.set(r.values, i * schema.valueStride);
  });
  const before = native.render.stats();
  native.beginFrame(); native.scene.submit(schema.version, metadata, values, records.length);
  native.renderScene();
  const actual = Buffer.from(native.canvas.captureSceneRawPremultiplied());
  const after = native.render.stats();
  const delta = Object.fromEntries(['rendererTargetCreates', 'rendererTargetDestroys',
    'filterTargetReuses', 'rendererTargetCacheHits', 'filterDrawCalls', 'framebufferCopies',
    'filterTargetClears'].map(k => [k, after[k] - before[k]]));
  assert.ok(after.rendererTargetCacheBytes <= 32 * 1024 * 1024);
  assert.ok(after.rendererTargetBytes >= after.rendererTargetCacheBytes);
  assert.ok(after.rendererTargetPeakBytes >= after.rendererTargetBytes);
  return { actual, after, delta };
}
function clipped(width, height) {
  const result = Buffer.from(pixels);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    if (x >= width || y >= height) result.fill(0, (y * 32 + x) * 4, (y * 32 + x + 1) * 4);
  }
  return result;
}
render([large, large]);
const sameSize = render([large, large]);
assert.equal(sameSize.delta.rendererTargetCreates, 0);
assert.equal(sameSize.delta.rendererTargetDestroys, 0);
assert.ok(sameSize.delta.filterTargetReuses > 0, 'steady-state filter rendering reuses targets');
render([large, small]);
for (let i = 0; i < 4; i++) {
  const mixed = render([large, small]);
  assert.deepEqual(mixed.actual, sameSize.actual);
  assert.equal(mixed.delta.rendererTargetCreates, 0);
  assert.equal(mixed.delta.rendererTargetDestroys, 0);
  assert.ok(mixed.delta.rendererTargetCacheHits > 0);
}
const cycles = [
  [[large, 32, 24], [plan(16, 8), 16, 8], [plan(8, 16), 8, 16], [small, 16, 12]],
  [[1024, 512], [512, 128], [512, 8], [64, 32]].map(([width, height]) =>
    [plan(width, height), width, height]),
];
for (const cycle of cycles) {
  for (const [filter] of cycle) render([filter]);
  const beforeCycle = native.render.stats();
  for (const [filter, width, height] of cycle) {
    assert.deepEqual(render([filter]).actual, clipped(width, height));
  }
  const afterCycle = native.render.stats();
  assert.equal(afterCycle.rendererTargetCreates - beforeCycle.rendererTargetCreates, 0,
    'warmed size cycle must not allocate');
  assert.equal(afterCycle.rendererTargetDestroys - beforeCycle.rendererTargetDestroys, 0,
    'warmed size cycle must not evict');
}
const beforeCapacity = native.render.stats();
for (const width of [1, 2, 4, 8, 16, 32]) {
  for (const height of [1, 2, 4, 8, 16, 32]) {
    assert.deepEqual(render([plan(width, height)]).actual, clipped(width, height));
  }
}
assert.ok(native.render.stats().rendererTargetCacheEvictions > beforeCapacity.rendererTargetCacheEvictions,
  'many small sizes must respect the cache entry limit');
// Eleven displaced 4-MiB backings exceed the shared 32-MiB cache budget.
const pressureLarge = plan(1024, 1024, 11), pressureSmall = plan(16, 12, 11);
const beforePressure = native.render.stats();
assert.deepEqual(render([pressureLarge]).actual, Buffer.from(pixels));
const evicted = render([pressureSmall]);
assert.deepEqual(evicted.actual, clipped(16, 12));
assert.ok(evicted.after.rendererTargetCacheEvictions > beforePressure.rendererTargetCacheEvictions);
assert.ok(evicted.after.rendererTargetCacheBytes <= 32 * 1024 * 1024);
for (let i = 0; i < 3; i++) {
  assert.deepEqual(render([pressureLarge]).actual, Buffer.from(pixels));
  assert.deepEqual(render([pressureSmall]).actual, clipped(16, 12));
}
native.canvas.release(canvas.handle);
native.runtime.quit();
console.log('Exact-size filter targets reuse allocations, preserve pixels and obey the cache budget');
