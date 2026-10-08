'use strict';

process.env.PMJS_GRAPHICS_DIAGNOSTICS = '1';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
const size = 32;
native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '',
  width: size, height: size, windowTitle: 'custom filter input pixels' });
native.render.setClearColor(0, 0, 0, 0);
const schema = native.scene.schema;
const noParent = 0xffffffff;
const image = native.canvas.create(size, size);
const empty = native.canvas.create(size, size);
const snapshot = native.canvas.create(size, size);
const pixels = new Uint8Array(size * size * 4);
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    pixels.set([x < 16 ? 192 : 32, y < 16 ? 64 : 160, (x + y) % 3 * 64, 255],
      (y * size + x) * 4);
  }
}
native.canvas.writePixels(image.handle, 0, 0, size, size, pixels);

const vertex = 'attribute vec2 aVertexPosition; attribute vec2 aTextureCoord; uniform mat3 projectionMatrix; varying vec2 vTextureCoord; void main(){gl_Position=vec4((projectionMatrix*vec3(aVertexPosition,1.0)).xy,0,1);vTextureCoord=aTextureCoord;}';
function program(body, copy) {
  const auxiliary = copy ? 'uniform sampler2D second; uniform float weight;' : '';
  const output = copy ? 'mix(result,texture2D(second,vTextureCoord),weight)' : 'result';
  return native.render.createFilterProgram(`varying vec2 vTextureCoord; uniform sampler2D uSampler; uniform vec4 filterArea; uniform vec4 filterClamp; ${auxiliary} void main(){${body} gl_FragColor=${output};}`, vertex);
}
const bodies = {
  identity: 'vec4 result=texture2D(uSampler,vTextureCoord);',
  color: 'vec4 c=texture2D(uSampler,vTextureCoord); vec4 result=vec4(c.b,c.r,c.g,c.a)*0.75;',
  padding: 'vec4 c=texture2D(uSampler,vec2(0.96875)); vec4 result=vec4(c.r,c.g,0.25,1.0);',
  bounds: 'vec4 c=texture2D(uSampler,clamp(vTextureCoord,filterClamp.xy,filterClamp.zw)); vec4 result=vec4(c.rg,mod(abs(filterArea.z+filterArea.w),8.0)/8.0,c.a);',
};
const programs = {};
for (const [name, body] of Object.entries(bodies)) {
  programs[name] = [program(body, false), program(body, true)];
}

function pass(name, copy, options = {}) {
  return { program: programs[name][copy ? 1 : 0].handle, input: 0, output: 1,
    clear: false, blend: 0, uniforms: copy ? [0] : [],
    samplers: copy ? [{ image: 0, target: 0 }] : [], ...options };
}

function plan(frame, resolution, passes, extraTargets = []) {
  return native.render.createFilterPlan({ frame, resolutions: [resolution, 1, ...extraTargets], passes });
}

function record(kind, resource = 0, parent = noParent, filter = 0, clip) {
  const values = new Float32Array(schema.valueStride);
  values.set([1, 0, 0, 1, 0, 0, 1]);
  if (clip) values.set(clip, 17);
  return { metadata: [kind, parent, resource, 0xffffff, filter, clip ? 1 : 0, 0], values };
}

function entries(inner, outer, source, clip, position = [0, 0]) {
  const result = [];
  if (outer) result.push(record(6, outer.handle, noParent, 31));
  const parent = result.length;
  result.push(record(6, inner.handle, outer ? 0 : noParent, 31, clip));
  const sprite = record(1, source.handle, parent);
  sprite.values.set([position[0], position[1]], 4);
  sprite.values.set([0, 0, size, size], 9);
  sprite.values.set([size, size], 13);
  result.push(sprite, record(7, 0, parent));
  if (outer) result.push(record(7, 0, 0));
  return result;
}

function render(records, offscreen = false) {
  const metadata = new Uint32Array(records.length * schema.metadataStride);
  const values = new Float32Array(records.length * schema.valueStride);
  records.forEach((entry, index) => {
    metadata.set(entry.metadata, index * schema.metadataStride);
    values.set(entry.values, index * schema.valueStride);
  });
  const before = native.render.stats();
  native.beginFrame();
  native.scene.submit(schema.version, metadata, values, records.length);
  let actual;
  if (offscreen) {
    native.render.renderToCanvas(snapshot.handle);
    actual = native.canvas.readPremultipliedPixels(snapshot.handle, 0, 0, size, size);
  } else {
    native.renderScene();
    actual = native.canvas.captureSceneRawPremultiplied();
  }
  const after = native.render.stats();
  return { pixels: Buffer.from(actual), copies: after.framebufferCopies - before.framebufferCopies,
    clears: after.filterTargetClears - before.filterTargetClears,
    draws: after.filterDrawCalls - before.filterDrawCalls };
}

function paired(label, options = {}) {
  const { frame = [0, 0, size, size], resolution = 1, name = 'identity',
    offscreen = false, nested = false, source = image, clip, position,
    passOptions = {}, extraTargets = [] } = options;
  const outputs = [false, true].map(copy => {
    const inner = plan(frame, resolution, [pass(name, copy, passOptions)], extraTargets);
    const outer = nested ? plan([-1, -1, 34, 34], 1, [pass('identity', copy)]) : null;
    return render(entries(inner, outer, source, clip, position), offscreen);
  });
  assert.deepEqual(outputs[0].pixels, outputs[1].pixels, label);
  assert.equal(outputs[0].draws, nested ? 2 : 1, `${label}: original shader still executes`);
  const eligible = extraTargets.length === 0;
  assert.equal(outputs[0].copies, eligible ? 0 : 1, `${label}: input transfer`);
  assert.equal(outputs[1].copies, nested ? 2 : 1, `${label}: forced-copy control`);
  assert.equal(outputs[1].clears - outputs[0].clears,
    eligible ? nested ? 2 : 1 : 0, `${label}: redundant input clear`);
  return outputs[0].pixels;
}

assert.deepEqual(paired('integer identity'), Buffer.from(pixels),
  'identity input must retain the asymmetric source image');
for (const resolution of [0.5, 1, 2]) {
  for (const nested of [false, true]) {
    for (const offscreen of [false, true]) {
      paired(`fractional negative origin resolution=${resolution} nested=${nested} offscreen=${offscreen}`,
        { frame: [-2.25, -1.5, 23.75, 21.25], resolution, nested, offscreen });
    }
  }
}
paired('nonidentity color shader', { name: 'color' });
paired('shader observes frame and clamp uniforms',
  { frame: [-2.25, -1.5, 23.75, 21.25], resolution: 2, name: 'bounds' });
for (const offscreen of [false, true]) {
  const clipped = paired(`transformed clipped additive composition offscreen=${offscreen}`,
    { frame: [1, 2, 23, 21], name: 'color', clip: [5, 6, 18, 19], position: [0.25, 0.5],
      passOptions: { transform: [0.75, 0, 0, 1, 2.25, 1.5], blend: 1 }, offscreen });
  assert.deepEqual(Array.from(clipped.subarray(0, 4)), [0, 0, 0, 0], 'clipping excludes outside pixels');
  assert.ok(clipped.some(value => value !== 0), 'clipped transformed filter remains visible');
}
paired('final pass clear', { passOptions: { clear: true } });

// Populate the complete reused backing, then sample beyond a smaller active raster.
paired('dirty prior backing');
const padded = paired('transparent reused padding', { frame: [0, 0, 23, 21], name: 'padding' });
assert.deepEqual(Array.from(padded.subarray((10 * size + 10) * 4, (10 * size + 10) * 4 + 4)),
  [0, 0, 64, 255], 'both input layouts expose cleared POT padding');
for (const width of [17, 9, 31, 23, 17]) {
  paired(`alternating storage populated width=${width}`, { frame: [0, 0, width, width - 1] });
  const actual = paired(`alternating storage empty width=${width}`,
    { frame: [0, 0, width, width - 1], source: empty });
  assert.ok(actual.every(value => value === 0), 'previous contents must not survive an empty group');
}
paired('unused auxiliary target falls back', { extraTargets: [2] });

// A live auxiliary target-zero sampler must keep the owned working-input path.
const auxiliary = plan([0, 0, size, size], 1, [pass('identity', true, { uniforms: [1] })]);
const sampled = render(entries(auxiliary, null, image));
assert.equal(sampled.copies, 1);
assert.deepEqual(sampled.pixels, paired('auxiliary input pixel control'));

// Longer chains may explicitly write target zero before using it again.
const chain = plan([0, 0, size, size], 1, [
  pass('identity', false, { output: 2, clear: true }),
  pass('color', false, { input: 2, output: 0, clear: true }),
  pass('identity', false),
], [1]);
const chained = render(entries(chain, null, image));
assert.equal(chained.copies, 1, 'target-zero write chain must use independent input storage');
assert.equal(chained.draws, 3);
assert.deepEqual(chained.pixels, paired('target-zero write pixel control', { name: 'color' }));
paired('eligible after target-zero write');

function tonedGroup(frame, name, copy) {
  const filter = plan(frame, 1, [pass(name, copy)]);
  const records = entries(filter, null, image);
  const tone = record(5, 0, 0);
  tone.values.set([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0], 7);
  records.splice(records.length - 1, 0, tone);
  return render(records);
}

// Tone composition exchanges the group with an independently reused full-scene
// target. Its untouched padding must not become an input to a custom shader.
const tonePadding = [false, true].map(copy => {
  tonedGroup([0, 0, size, size], 'identity', true);
  return tonedGroup([0, 0, 23, 21], 'padding', copy);
});
assert.deepEqual(tonePadding[0].pixels, tonePadding[1].pixels,
  'tone-swapped backing must preserve copied-input padding');
assert.equal(tonePadding[0].copies, 1, 'tone-swapped input must retain independent storage');
assert.equal(tonePadding[1].copies, 1);

const nestedTone = [false, true].map(copy => {
  tonedGroup([0, 0, size, size], 'identity', true);
  const inner = plan([0, 0, 23, 21], 1, [pass('identity', true)]);
  const outer = plan([0, 0, 23, 21], 1, [pass('padding', copy)]);
  const records = entries(inner, outer, image);
  const tone = record(5, 0, 1);
  tone.values.set([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0], 7);
  records.splice(3, 0, tone);
  return render(records);
});
assert.deepEqual(nestedTone[0].pixels, nestedTone[1].pixels,
  'unsafe descendant must preserve ancestor input pixels');
assert.equal(nestedTone[0].copies, 2, 'unsafe descendant invalidates borrowing for active ancestors');
assert.equal(nestedTone[1].copies, 2);

// Scratch storage can contain a prior plan's pixels. Reads before the first
// write must still see transparent contents, through either sampler binding.
for (const auxiliaryRead of [false, true]) {
  render(entries(chain, null, image));
  const unread = plan([0, 0, size, size], 1, [
    pass('identity', auxiliaryRead, auxiliaryRead ?
      { uniforms: [1], samplers: [{ image: 0, target: 2 }] } : { input: 2 }),
  ], [1]);
  const actual = render(entries(unread, null, image));
  assert.ok(actual.pixels.every(value => value === 0),
    `unwritten scratch ${auxiliaryRead ? 'auxiliary' : 'primary'} sampler must be transparent`);
}

const translucent = native.canvas.create(size, size);
const translucentPixels = Uint8Array.from(pixels);
for (let index = 3; index < translucentPixels.length; index += 4)
  translucentPixels[index] = 96;
native.canvas.writePixels(translucent.handle, 0, 0, size, size, translucentPixels);
for (const resolution of [0.5, 1, 2]) {
  for (const offscreen of [false, true]) {
    for (const nested of [false, true]) {
      const outputs = [false, true].map(clear => {
        render(entries(chain, null, image));
        const inner = plan([-1.25, -0.5, 23.75, 21.25], resolution, [
          pass('color', false, { output: 2, clear, transform: [0.75, 0, 0, 1, 1.25, 0.5] }),
          pass('identity', false, { output: 2, clear: false }),
          pass('identity', false, { input: 2 }),
        ], [resolution]);
        const outer = nested ? plan([0, 0, size, size], 1,
          [pass('identity', false)]) : null;
        return render(entries(inner, outer, translucent), offscreen).pixels;
      });
      assert.ok(outputs[0].some(value => value !== 0), 'translucent chain must remain visible');
      assert.deepEqual(outputs[0], outputs[1],
        `first scratch write must blend over zero, later writes retain contents: resolution=${resolution} offscreen=${offscreen} nested=${nested}`);
    }
  }
}
native.canvas.release(translucent.handle);

for (const clear of [false, true]) {
  render(entries(chain, null, image));
  const padding = plan([0, 0, 23, 21], 1, [
    pass('identity', false, { output: 2, clear }),
    pass('padding', false, { input: 2 }),
  ], [1]);
  const actual = render(entries(padding, null, image));
  assert.deepEqual(Array.from(actual.pixels.subarray((10 * size + 10) * 4,
    (10 * size + 10) * 4 + 4)), [0, 0, 64, 255],
    'initial scratch write must clear padding outside the active viewport');
}

const stockQuadVertex = 'attribute vec2 aVertexPosition; attribute vec2 aTextureCoord; ' +
  'uniform mat3 projectionMatrix; varying vec2 vTextureCoord; void main(void) {' +
  'gl_Position=vec4((projectionMatrix*vec3(aVertexPosition,1.0)).xy,0.0,1.0);' +
  'vTextureCoord=aTextureCoord;}';
const texelCenterProgram = native.render.createFilterProgram(
  'varying vec2 vTextureCoord; void main(){' +
  'vec2 fraction=fract(vTextureCoord*32.0);' +
  'gl_FragColor=vec4(equal(fraction,vec2(0.5)),0.0,1.0);}', stockQuadVertex);
const interpolatedCenterProgram = native.render.createFilterProgram(
  'varying vec2 vTextureCoord; void main(){' +
  'vec2 fraction=fract(vTextureCoord*32.0);' +
  'gl_FragColor=vec4(equal(fraction,vec2(0.5)),0.0,1.0);}',
  stockQuadVertex + '\n// Authored interpolation reference.');
for (const offscreen of [false, true]) {
  const centerPlan = plan([4, 4, 24, 24], 1, [{
    program: texelCenterProgram.handle, input: 0, output: 1,
    clear: false, blend: 0, uniforms: [], samplers: [],
  }]);
  const actual = render(entries(centerPlan, null, image), offscreen).pixels;
  const referencePlan = plan([4, 4, 24, 24], 1, [{
    program: interpolatedCenterProgram.handle, input: 0, output: 1,
    clear: false, blend: 0, uniforms: [], samplers: [],
  }]);
  const reference = render(entries(referencePlan, null, image), offscreen).pixels;
  assert.deepEqual(actual, reference,
    `coordinate arithmetic must preserve authored interpolation, offscreen=${offscreen}`);
}

const translatedCenterPlan = plan([4, 4, 24, 24], 1, [{
  program: texelCenterProgram.handle, input: 0, output: 1,
  clear: false, blend: 0, uniforms: [], samplers: [], transform: [1, 0, 0, 1, 0.25, 0],
}]);
const translatedCenters = render(entries(translatedCenterPlan, null, image)).pixels;
assert.equal(translatedCenters[(10 * size + 10) * 4], 0,
  'translated stock quads must retain fractional authored UVs');

for (const canvas of [image, empty, snapshot]) native.canvas.release(canvas.handle);
native.runtime.quit();
console.log('Custom filter borrowed input and copied input pixels agree across layout, effects and reuse');
