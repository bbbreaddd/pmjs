'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 16, height: 16,
  windowTitle: 'filter target projection' });
native.render.setClearColor(0, 0, 0, 0);
const source = native.canvas.create(8, 8);
const pixels = Uint8Array.from({ length: 8 * 8 * 4 }, (_, i) =>
  (i < 8 * 4 * 4 ? [255, 0, 0, 255] : [0, 0, 255, 255])[i % 4]);
native.canvas.writePixels(source.handle, 0, 0, 8, 8, pixels);
const vertex = 'attribute vec2 aVertexPosition; attribute vec2 aTextureCoord; uniform mat3 projectionMatrix; varying vec2 vTextureCoord; void main(){gl_Position=vec4((projectionMatrix*vec3(aVertexPosition,1.0)).xy,0,1);vTextureCoord=aTextureCoord;}';
const fragment = 'varying vec2 vTextureCoord; uniform sampler2D uSampler; void main(){gl_FragColor=texture2D(uSampler,vTextureCoord);}';
const program = native.render.createFilterProgram(fragment, vertex);
function plan(frame, resolution) {
  return native.render.createFilterPlan({ frame, resolutions: [resolution, 1], passes: [
    { program: program.handle, input: 0, output: 1, clear: false, blend: 0,
      uniforms: [], samplers: [] },
  ] });
}
const outer = plan([1, 1, 12, 12], 1);
const schema = native.scene.schema;
for (const resolution of [1, 2]) {
  const inner = plan([3, 2, 8, 8], resolution);
  for (const nested of [false, true]) {
    for (const snapshot of [false, true]) {
      const metadata = [], values = [];
      function record(kind, parent, resource, filter, flags, x = 0, y = 0) {
        const data = new Array(schema.valueStride).fill(0);
        data.splice(0, 7, 1, 0, 0, 1, x, y, 1);
        if (kind === 1) { data.splice(9, 4, 0, 0, 8, 8); data.splice(13, 2, 8, 8); }
        metadata.push(kind, parent, resource, 0xffffff, filter, flags, 0);
        values.push(...data);
      }
      if (nested) record(6, 0xffffffff, outer.handle, 31, 0);
      record(6, nested ? 0 : 0xffffffff, inner.handle, 31, 0);
      record(1, nested ? 1 : 0, source.handle, 0, 8, 3, 2);
      record(7, nested ? 1 : 0, 0, 0, 0);
      if (nested) record(7, 0, 0, 0, 0);
      native.beginFrame();
      native.scene.submit(schema.version, new Uint32Array(metadata), new Float32Array(values),
        metadata.length / schema.metadataStride);
      let target;
      if (snapshot) {
        target = native.canvas.create(16, 16);
        native.render.renderToCanvas(target.handle);
      } else { native.renderScene(); target = native.canvas.captureScene(); }
      const actual = native.canvas.readPixels(target.handle, 0, 0, 16, 16);
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const expected = x >= 3 && x < 11 && y >= 2 && y < 10 ?
            y < 6 ? [255, 0, 0, 255] : [0, 0, 255, 255] : [0, 0, 0, 0];
          assert.deepEqual(Array.from(actual.slice((y * 16 + x) * 4, (y * 16 + x + 1) * 4)),
            expected, `resolution=${resolution}, nested=${nested}, snapshot=${snapshot}, pixel=${x},${y}`);
        }
      }
      native.canvas.release(target.handle);
    }
  }
}
native.canvas.release(source.handle);
native.runtime.quit();
