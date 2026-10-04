'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '',
  width: 16, height: 16, imageWarmCacheBytes: 0, windowTitle: 'pmjs custom filter ownership' });
native.render.setClearColor(0, 0, 0, 0);

const vertex = 'attribute vec2 aVertexPosition; attribute vec2 aTextureCoord; uniform mat3 projectionMatrix; varying vec2 vTextureCoord; void main(){gl_Position=vec4((projectionMatrix*vec3(aVertexPosition,1.0)).xy,0,1);vTextureCoord=aTextureCoord;}';
const fragment = 'varying vec2 vTextureCoord; uniform sampler2D uSampler; uniform sampler2D second; void main(){gl_FragColor=texture2D(second,vTextureCoord);}';
const program = native.render.createFilterProgram(fragment, vertex);
const image = native.images.load('fixture.png');
const description = { frame: [0, 0, 16, 16], resolutions: [1, 1], passes: [
  { program: program.handle, input: 0, output: 1, clear: false, blend: 0,
    uniforms: [], samplers: [{ image: image.handle, target: 0 }] },
] };
let plan = native.render.createFilterPlan(description);
const { schema } = native.scene;
const metadata = new Uint32Array([
  6, 0xffffffff, plan.handle, 0xffffff, 31, 0, 0,
  7, 0xffffffff, 0, 0xffffff, 0, 0, 0,
]);
const values = new Float32Array(schema.valueStride * 2);
values.set([1, 0, 0, 1, 0, 0, 1]);
values.set([1, 0, 0, 1, 0, 0, 1], schema.valueStride);

async function main() {
  native.beginFrame();
  native.scene.submit(schema.version, metadata, values, 2);
  // A submitted scene owns sampler images independently of the JavaScript plan.
  native.images.release(image.handle);
  plan = null;
  assert.equal(typeof global.gc, 'function', 'run this regression with --expose-gc');
  global.gc();
  await new Promise(resolve => setImmediate(resolve));
  const retained = native.images.memory(20).largest.find(entry => entry.handle === image.handle);
  assert.ok(retained && retained.references === 0 && retained.inFlight > 0,
    'submitted filter did not retain its released sampler');
  native.renderScene();
  const pixels = Array.from(native.canvas.captureSceneRawPremultiplied());
  assert.ok(pixels.some(value => value !== 0), 'released sampler drew an empty frame');
  assert.equal(native.images.memory(20).largest.find(entry => entry.handle === image.handle).inFlight, 0,
    'completed filter kept its sampler lease');
  native.beginFrame();
  assert.equal(native.images.memory(20).largest.some(entry => entry.handle === image.handle), false,
    'completed filter kept a sampler with no remaining owners');
  native.renderScene();
  assert.deepEqual(Array.from(native.canvas.captureSceneRawPremultiplied()), pixels,
    'sampler cleanup changed the retained presentation');

  const invalid = JSON.parse(JSON.stringify(description));
  invalid.passes[0].input = invalid.passes[0].output;
  assert.throws(() => native.render.createFilterPlan(invalid), /filter pass targets/);
  invalid.passes[0].input = 0;
  invalid.resolutions[0] = 0;
  assert.throws(() => native.render.createFilterPlan(invalid), /filter resolution/);
  invalid.resolutions[0] = 1;
  invalid.passes[0].uniforms = [NaN];
  assert.throws(() => native.render.createFilterPlan(invalid), /filter plan number/);
  native.renderScene();
  assert.deepEqual(Array.from(native.canvas.captureSceneRawPremultiplied()), pixels,
    'rejected plan changed the retained presentation');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
