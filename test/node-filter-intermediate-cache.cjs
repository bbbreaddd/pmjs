'use strict';
process.env.PMJS_GRAPHICS_DIAGNOSTICS = '1';
const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 32, height: 32, windowTitle: 'filter intermediate cache' });
const source = native.canvas.create(16, 16), snapshot = native.canvas.create(32, 32);
const pixels = Uint8Array.from({ length: 16 * 16 * 4 }, (_, i) =>
  i % 4 === 3 ? 32 + (i % 223) : (i * 13) % 256);
native.canvas.writePixels(source.handle, 0, 0, 16, 16, pixels);
const vertex = 'attribute vec2 aVertexPosition; attribute vec2 aTextureCoord; uniform mat3 projectionMatrix; varying vec2 vTextureCoord; void main(){gl_Position=vec4((projectionMatrix*vec3(aVertexPosition,1.0)).xy,0,1);vTextureCoord=aTextureCoord;}';
const fragment = 'varying vec2 vTextureCoord; uniform sampler2D uSampler; uniform float amount; void main(){vec4 c=texture2D(uSampler,vTextureCoord); gl_FragColor=vec4(c.b,c.r,c.g,c.a)*amount;}';
const program = native.render.createFilterProgram(fragment, vertex);
const schema = native.scene.schema;
function render(enabled, options = {}) {
  const { amount = 0.83, alpha = 1, x = 3, backdrop = 0.25, blend = 0,
    frame = [3, 2, 16, 16], resolution = 1, offscreen = false, image = source, uniformClasses, single = false, layer = 0, animation = [0, 0], clearRect = null } = options;
  const description = { frame, resolutions: [resolution, 1, resolution], passes: [
    { program: program.handle, input: 0, output: 2, clear: true, blend: 0, uniforms: [amount], uniformClasses, samplers: [] },
    { program: program.handle, input: 2, output: 0, clear: true, blend: 0, uniforms: [0.91], samplers: [] },
    { program: program.handle, input: 0, output: 2, clear: true, blend: 0, uniforms: [0.94], samplers: [] },
    { program: program.handle, input: 2, output: 1, clear: false, blend, uniforms: [1], samplers: [] },
  ] };
  if (!uniformClasses) delete description.passes[0].uniformClasses;
  if (single) {
    description.resolutions = [resolution, 1];
    description.passes = [{ program: program.handle, input: 0, output: 1,
      clear: false, blend, uniforms: [amount], samplers: [] }];
  }
  const plan = native.render.createFilterPlan(description);
  const metadata = [], values = [];
  function record(kind, parent, resource, filter = 0) {
    metadata.push(kind, parent, resource, 0xffffff, filter, 0, 0);
    const row = new Array(schema.valueStride).fill(0);
    row.splice(0, 7, 1, 0, 0, 1, 0, 0, 1);
    values.push(...row); return values.length - schema.valueStride;
  }
  let offset = record(3, 0xffffffff, 0);
  metadata[3] = Math.round(backdrop * 255) * 0x010101;
  values.splice(offset + 9, 6, 0, 0, 32, 32, 32, 32);
  offset = record(6, 0xffffffff, plan.handle, 31);
  values[offset + 8] = enabled ? 1 : 0;
  offset = record(layer ? 4 : 1, 1, layer || image.handle);
  values.splice(offset + 4, 3, x, 2, alpha);
  values.splice(offset + 9, 6, 0, 0, 16, 16, 16, 16);
  if (layer) values.splice(offset + 15, 2, ...animation);
  if (clearRect) {
    offset = record(10, 0xffffffff, 0);
    values.splice(offset + 7, 2, ...clearRect.slice(0, 2));
    values.splice(offset + 13, 2, ...clearRect.slice(2));
  }
  record(7, 1, 0);
  const before = native.render.stats(), uploads = native.images.memory().textureUploadBytes;
  native.beginFrame();
  native.scene.submit(schema.version, new Uint32Array(metadata), new Float32Array(values), metadata.length / schema.metadataStride);
  let actual;
  if (offscreen) {
    native.render.renderToCanvas(snapshot.handle);
    actual = native.canvas.readPremultipliedPixels(snapshot.handle, 0, 0, 32, 32);
  } else { native.renderScene(); actual = native.canvas.captureSceneRawPremultiplied(); }
  const after = native.render.stats();
  return { pixels: Buffer.from(actual), hits: after.filterIntermediateCacheHits - before.filterIntermediateCacheHits,
    draws: after.filterDrawCalls - before.filterDrawCalls,
    uploadBytes: native.images.memory().textureUploadBytes - uploads };
}
function paired(label, options = {}, eligible = true) {
  const cold = render(true, options), baseline = render(false, options);
  render(true, options);
  const warm = render(true, options);
  assert.deepEqual(cold.pixels, baseline.pixels, label + ': cold');
  assert.deepEqual(warm.pixels, baseline.pixels, label + ': warm');
  assert.equal(cold.hits, 0, label + ': invalidation');
  if (eligible) assert.ok(warm.hits > 0, label + ': reuse');
  else assert.equal(warm.hits, 0, label + ': ineligible');
  assert.equal(warm.uploadBytes, 0, label + ': uploads');
}
paired('translucent source');
const animationBefore = native.render.stats();
let animated;
for (let frame = 0; frame < 12; frame++) {
  animated = render(true, { amount: 0.5 + frame * 0.01 });
  assert.equal(animated.hits, 0, 'animated input renders live');
}
assert.equal(native.render.stats().rendererTargetCreates, animationBefore.rendererTargetCreates,
  'animated input does not allocate recurring targets');
assert.equal(native.render.stats().rendererTargetDestroys, animationBefore.rendererTargetDestroys,
  'animated input does not destroy recurring targets');
assert.deepEqual(animated.pixels, render(false, { amount: 0.61 }).pixels);
render(true); render(true);
// Destination content is deliberately excluded: the final blend stays live.
const changedBackdrop = render(true, { backdrop: 0.7 });
assert.equal(changedBackdrop.hits, 1);
assert.deepEqual(changedBackdrop.pixels, render(false, { backdrop: 0.7 }).pixels);
for (const [label, options] of Object.entries({ uniform: { amount: 0.44 },
  opacity: { alpha: 0.5 }, position: { x: 4 }, frame: { frame: [2, 1, 18, 20] },
  blend: { blend: 1 }, resolution: { resolution: 2 }, offscreen: { offscreen: true } })) {
  paired(label, options, !['resolution', 'offscreen'].includes(label));
}
render(true); render(true);
native.canvas.fillRect(source.handle, 2, 2, 3, 4, 0xff0000ff);
paired('source mutation');
for (const classification of [1, 2, 3]) {
  paired('uniform classification ' + classification, { amount: 0, uniformClasses: [classification] });
}
const replacement = native.canvas.create(16, 16);
native.canvas.writePixels(replacement.handle, 0, 0, 16, 16, pixels);
paired('source replacement', { image: replacement });
native.beginFrame(); native.render.quad(0, 0, 16, 16, 0, 0, 1, 0.5);
const generated = native.render.renderToImage(32, 32);
paired('untracked framebuffer source', { image: generated }, false);
native.images.release(generated.handle);
render(true); render(true);
// A frame with no eligible chain releases the retained intermediate storage.
const before = native.render.stats().rendererTargetBytes;
native.beginFrame(); native.render.quad(0, 0, 32, 32, 1, 0, 0, 1); native.renderScene();
assert.ok(native.render.stats().rendererTargetBytes < before, 'ineligible frame releases retained intermediate storage');
paired('re-entry');
function singlePair(label, options = {}) {
  const state = { ...options, single: true };
  render(false, state);
  const cold = render(true, state), warm = render(true, state);
  assert.equal(cold.hits, 0, label + ': cold');
  assert.equal(warm.hits, 1, label + ': warm');
  assert.deepEqual(cold.pixels, warm.pixels, label + ': stable pixels');
  assert.deepEqual(warm.pixels, render(false, state).pixels, label + ': ordinary rendering');
}
singlePair('single-pass input');
singlePair('single-pass rectangle clear', { clearRect: [5, 5, 4, 4] });
render(true, { single: true, clearRect: [5, 5, 4, 4] });
render(true, { single: true, clearRect: [5, 5, 4, 4] });
const movedClear = render(true, { single: true, clearRect: [8, 5, 4, 4] });
assert.equal(movedClear.hits, 0, 'changed rectangle clear must invalidate input');
assert.deepEqual(movedClear.pixels, render(false, { single: true, clearRect: [8, 5, 4, 4] }).pixels);
render(true, { single: true }); render(true, { single: true });
const animatedFinal = render(true, { single: true, amount: 0.37 });
assert.equal(animatedFinal.hits, 1, 'final uniforms must not invalidate retained input');
assert.deepEqual(animatedFinal.pixels, render(false, { single: true, amount: 0.37 }).pixels);
render(true, { single: true }); render(true, { single: true });
const changedDestination = render(true, { single: true, backdrop: 0.7, blend: 1 });
assert.equal(changedDestination.hits, 1, 'destination and final blending must remain live');
assert.deepEqual(changedDestination.pixels, render(false, { single: true, backdrop: 0.7, blend: 1 }).pixels);
render(true, { single: true, x: 3 }); render(true, { single: true, x: 4 });
const allocated = native.render.stats();
for (let frame = 0; frame < 8; frame++) render(true, { single: true, x: 3 + frame % 2 });
assert.equal(native.render.stats().rendererTargetCreates, allocated.rendererTargetCreates,
  'changing inputs must recycle the two source targets');
assert.equal(native.render.stats().rendererTargetDestroys, allocated.rendererTargetDestroys,
  'changing inputs must not destroy a source target each frame');
for (const options of [{ x: 4 }, { alpha: 0.5 }, { frame: [2, 1, 18, 20] }]) {
  render(true, { single: true }); render(true, { single: true });
  const changed = render(true, { single: true, ...options });
  assert.equal(changed.hits, 0, 'changed source geometry must render live');
  assert.deepEqual(changed.pixels, render(false, { single: true, ...options }).pixels);
}
render(true, { single: true }); render(true, { single: true });
native.canvas.fillRect(source.handle, 1, 1, 4, 4, 0x00ff00bf);
assert.equal(render(true, { single: true }).hits, 0, 'source pixels must invalidate retained input');
singlePair('mutated single-pass input');
const layer = native.render.createTileLayer(new Float32Array([0, 0, 0, 0, 8, 8, 1, 0, 0]), [source.handle]);
const otherLayer = native.render.createTileLayer(new Float32Array([0, 0, 1, 1, 8, 8, 1, 0, 0]), [source.handle]);
try {
  singlePair('tile input', { layer });
  render(true, { single: true, layer }); render(true, { single: true, layer });
  const animatedTiles = render(true, { single: true, layer, animation: [4, 0] });
  assert.equal(animatedTiles.hits, 0, 'tile animation must invalidate retained input');
  assert.deepEqual(animatedTiles.pixels, render(false, { single: true, layer, animation: [4, 0] }).pixels);
  render(true, { single: true, layer }); render(true, { single: true, layer });
  assert.equal(render(true, { single: true, layer: otherLayer }).hits, 0, 'replacement tile geometry must invalidate input');
  singlePair('replacement tile geometry', { layer: otherLayer });
  render(true, { single: true, layer }); render(true, { single: true, layer });
  native.canvas.fillRect(source.handle, 3, 3, 4, 4, 0xff000080);
  assert.equal(render(true, { single: true, layer }).hits, 0, 'tile texture pixels must invalidate input');
  singlePair('mutated tile texture', { layer });
} finally {
  native.render.releaseTileLayer(layer); native.render.releaseTileLayer(otherLayer);
}
for (const canvas of [source, replacement, snapshot]) native.canvas.release(canvas.handle);
native.runtime.quit();
