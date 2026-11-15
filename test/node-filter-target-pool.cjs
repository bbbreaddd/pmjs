'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
const width = 1024, height = 512;
native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '',
  width, height, windowTitle: 'exact filter target pixels' });
native.render.setClearColor(0, 0, 0, 0);
const canvas = native.canvas.create(width, height);
const pixels = new Uint8Array(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  pixels.set([x % 251, y % 239, (x + 3 * y) % 241, 255], (y * width + x) * 4);
}
const vertex = 'attribute vec2 aVertexPosition; attribute vec2 aTextureCoord; uniform mat3 projectionMatrix; varying vec2 vTextureCoord; void main(){gl_Position=vec4((projectionMatrix*vec3(aVertexPosition,1.0)).xy,0,1);vTextureCoord=aTextureCoord;}';
const fragments = {
  identity: 'texture2D(uSampler,vTextureCoord)',
  auxiliary: 'texture2D(second,vTextureCoord)',
  bias: 'texture2D(uSampler /* input */,vTextureCoord,0.0)',
  neighbor: 'texture2D(uSampler,vTextureCoord+vec2(1.0/filterArea.x,0.0))',
  padding: 'texture2D(uSampler,vec2(1.5))',
};
const schema = native.scene.schema;
const metadata = new Uint32Array([
  6, 0xffffffff, 0, 0xffffff, 31, 0, 0,
  1, 0, canvas.handle, 0xffffff, 0, 0, 0,
  7, 0, 0, 0xffffff, 0, 0, 0,
]);
const values = new Float32Array(schema.valueStride * 3);
for (let i = 0; i < 3; i++) values.set([1, 0, 0, 1, 0, 0, 1], i * schema.valueStride);
values.set([0, 0, width, height, width, height], schema.valueStride + 9);
function capture(plan, empty) {
  native.canvas.writePixels(canvas.handle, 0, 0, width, height,
    empty ? new Uint8Array(pixels.length) : pixels);
  metadata[2] = plan.handle;
  native.beginFrame();
  native.scene.submit(schema.version, metadata, values, 3);
  native.renderScene();
  return Buffer.from(native.canvas.captureSceneRawPremultiplied());
}
for (const [name, expression] of Object.entries(fragments)) {
  const program = native.render.createFilterProgram(
    'varying vec2 vTextureCoord; uniform sampler2D uSampler; uniform sampler2D second; uniform vec4 filterArea; void main(){gl_FragColor=' + expression + ';}', vertex);
  const sizes = [[1024, 512], [512, 128], [512, 8], [61, 29], [1024, 512]];
  for (const [w, h] of sizes) {
    const plan = native.render.createFilterPlan({ frame: [0, 0, w, h], resolutions: [1, 1],
      passes: [{ program: program.handle, input: 0, output: 1, clear: false, blend: 0,
        uniforms: [], samplers: name === 'auxiliary' ? [{ image: 0, target: 0 }] : [] }] });
    const expected = Buffer.alloc(pixels.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let sourceX = name === 'neighbor' ? x + 1 : x, sourceY = y;
      if (name === 'padding') {
        sourceX = 2 ** Math.ceil(Math.log2(w)) - 1;
        sourceY = 2 ** Math.ceil(Math.log2(h)) - 1;
      } else if (name === 'neighbor' && (w & (w - 1)) === 0) {
        sourceX = Math.min(sourceX, w - 1);
      }
      if (sourceX < w && sourceY < h) {
        const start = (sourceY * width + sourceX) * 4;
        expected.set(pixels.subarray(start, start + 4), (y * width + x) * 4);
      }
    }
    assert.deepEqual(capture(plan, false), expected, `${name} ${w}x${h}: populated`);
    assert.ok(capture(plan, true).every(value => value === 0), `${name} ${w}x${h}: stale backing`);
    assert.deepEqual(capture(plan, false), expected, `${name} ${w}x${h}: return`);
    plan.dispose();
  }
}
native.canvas.release(canvas.handle);
native.runtime.quit();
console.log('Full-size filter targets preserve coordinates, edges, padding and source replacement');
