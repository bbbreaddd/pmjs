'use strict';

const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const expected = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'assets/reference/mz-sampling.json.gz'))));
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 64, height: 64, windowTitle: 'MZ float UV and sampler lifetimes' });
try {
  const schema = native.scene.schema;
  native.render.setClearColor(0, 0, 0, 0);
  for (const [name, pixels] of Object.entries(expected.frames)) {
    const uv = name.startsWith('uv/');
    const parts = name.split('/');
    const index = uv ? 0 : Number(parts[1]);
    const width = uv ? Number(parts[1]) : 16, height = uv ? 7 : 8;
    const mode = uv ? Number(parts[2]) : index % 3 === 0 ? 1 : 0;
    const image = native.canvas.create(width, height);
    const source = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) source.set(
      x % 2 ? [32, 192, 96, 255] : [224, 32, 64, 255], (y * width + x) * 4);
    native.canvas.writePixels(image.handle, 0, 0, width, height, source);
    const flags = 131072 | (mode === 0 ? 8 : 0) | (!uv && index % 2 === 0 ? 262144 : 0);
    const metadata = Uint32Array.of(1, 0xffffffff, image.handle, 0xffffff, 0, flags, 0);
    const values = new Float32Array(schema.valueStride);
    values.set([uv ? 1.15 : 3, 0, 0, 4, uv ? 4.25 : 3.25, uv ? 6.5 : 4.25, 1]);
    values.set([uv ? 13 : 0, 0, uv ? 43 : width, height], 9);
    values.set([uv ? 43 : width, height], 13);
    native.beginFrame(); native.scene.submit(schema.version, metadata, values, 1); native.renderFrame();
    const actual = native.canvas.captureSceneRawPremultiplied();
    assert.equal(actual.length, pixels.length);
    assert.ok(actual.every((value, i) => Math.abs(value - pixels[i]) <= 1), name + ' differs from stock sampling');
    native.canvas.release(image.handle);
  }
  console.log('MZ stock float UV and sampler replacement pixels passed');
} finally { native.runtime.quit(); }
