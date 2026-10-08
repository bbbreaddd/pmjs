'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '',
  width: 64, height: 64, windowTitle: 'filter coordinate precision' });
native.render.setClearColor(0, 0, 0, 0);
const image = native.canvas.create(48, 48);
native.canvas.writePixels(image.handle, 0, 0, 48, 48, new Uint8Array(48 * 48 * 4).fill(255));
const vertex = 'attribute vec2 aVertexPosition; attribute vec2 aTextureCoord; ' +
  'uniform mat3 projectionMatrix; varying vec2 vTextureCoord; void main(void) {' +
  'gl_Position=vec4((projectionMatrix*vec3(aVertexPosition,1.0)).xy,0.0,1.0);' +
  'vTextureCoord=aTextureCoord;}';
const fragment = 'varying vec2 vTextureCoord; uniform sampler2D uSampler; void main(){' +
  'gl_FragColor=vec4(equal(fract(vTextureCoord*64.0),vec2(0.5)),' +
  'texture2D(uSampler,vTextureCoord).a,1.0);}';
const program = native.render.createFilterProgram(fragment, vertex);
const interpolatedProgram = native.render.createFilterProgram(fragment, vertex + '\n// Authored interpolation reference.');
const plan = native.render.createFilterPlan({ frame: [4, 4, 56, 56], resolutions: [1, 1],
  passes: [{ program: program.handle, input: 0, output: 1, clear: false, blend: 0,
    uniforms: [], samplers: [] }] });
const schema = native.scene.schema;
const metadata = new Uint32Array([
  6, 0xffffffff, plan.handle, 0xffffff, 31, 0, 0,
  1, 0, image.handle, 0xffffff, 0, 0, 0,
  7, 0, 0, 0xffffff, 0, 0, 0,
]);
const values = new Float32Array(schema.valueStride * 3);
for (let index = 0; index < 3; index++) values.set([1, 0, 0, 1, 0, 0, 1], index * schema.valueStride);
values.set([8, 8], schema.valueStride + 4);
values.set([0, 0, 48, 48, 48, 48], schema.valueStride + 9);
function capture(filterPlan) {
  metadata[2] = filterPlan.handle;
  native.beginFrame();
  native.scene.submit(schema.version, metadata, values, 3);
  native.renderScene();
  return Buffer.from(native.canvas.captureSceneRawPremultiplied());
}
const referencePlan = native.render.createFilterPlan({ frame: [4, 4, 56, 56], resolutions: [1, 1],
  passes: [{ program: interpolatedProgram.handle, input: 0, output: 1, clear: false, blend: 0,
    uniforms: [], samplers: [] }] });
assert.deepEqual(capture(plan), capture(referencePlan),
  'coordinate arithmetic must preserve the authored varying');
const samplerProgram = native.render.createFilterProgram(
  'varying vec2 vTextureCoord; uniform sampler2D uSampler; ' +
  'void main(){gl_FragColor=texture2D(uSampler,vTextureCoord);}', vertex);
const samplerPlan = native.render.createFilterPlan({ frame: [4, 4, 56, 56], resolutions: [1, 1],
  passes: [{ program: samplerProgram.handle, input: 0, output: 1, clear: false, blend: 0,
    uniforms: [], samplers: [] }] });
const pixels = capture(samplerPlan);
for (let y = 4; y < 60; y++) for (let x = 4; x < 60; x++) {
  const offset = (y * 64 + x) * 4;
  const value = x >= 8 && x < 56 && y >= 8 && y < 56 ? 255 : 0;
  assert.deepEqual(Array.from(pixels.subarray(offset, offset + 4)), Array(4).fill(value),
    `direct sampler reads must retain texel centers at ${x},${y}`);
}
native.canvas.release(image.handle);
native.runtime.quit();
console.log('Filter arithmetic retains interpolation and direct reads retain texel centers');
