'use strict';

process.env.PMJS_GRAPHICS_DIAGNOSTICS = '1';
const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '',
  width: 32, height: 32, windowTitle: 'bitmap region batching' });
native.render.setClearColor(0, 0, 0, 0);
const schema = native.scene.schema;
const image = native.canvas.create(16, 8);
const bytes = new Uint8Array(16 * 8 * 4);
for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) {
  bytes.set([x * 13, y * 29, (x + y) * 10, 80 + (x % 4) * 55], (y * 16 + x) * 4);
}
native.canvas.writePixels(image.handle, 0, 0, 16, 8, bytes);
const mask = native.canvas.create(32, 32);
native.canvas.fillRect(mask.handle, 0, 0, 32, 32, 0xffffffff);

function sprite(index, options) {
  const flags = (1 << 13) | (1 << 10) | (options.nearest ? 8 : 0) | (options.flash ? 16 : 0) |
    (options.blur ? 2 : 0) | (options.mask ? 4 : 0);
  const values = new Float32Array(schema.valueStride);
  values.set([0.93, 0.14, -0.12, 1.1, 4 + index * 3, 3 + index * 2, 0.75]);
  values.set([index * 4, 0, 4, 8], 9);
  values.set([15, 18], 13);
  values[21] = Number(options.blur) || 0;
  values.set([1, 0, 0, 1, 0, 0], 22);
  if (options.flash) values.set([1, 60 / 255, 20 / 255, 113 / 255], 37);
  return { metadata: [1, 0xffffffff, image.handle, 0xffffff, 0, flags, options.mask ? mask.handle : 0], values };
}

function render(entries, split, offscreen = false) {
  const metadata = new Uint32Array(entries.length * schema.metadataStride);
  const values = new Float32Array(entries.length * schema.valueStride);
  entries.forEach((entry, index) => {
    const data = entry.metadata.slice(), floats = new Float32Array(entry.values);
    // Full-screen scissor alternation prevents merging without changing coverage.
    if (split && index % 2 && data[0] === 1) { data[5] |= 1; floats.set([0, 0, 32, 32], 17); }
    metadata.set(data, index * schema.metadataStride);
    values.set(floats, index * schema.valueStride);
  });
  const before = native.render.stats();
  native.beginFrame();
  native.scene.submit(schema.version, metadata, values, entries.length);
  let pixels;
  if (offscreen) {
    const target = native.canvas.create(32, 32);
    try {
      native.render.renderToCanvas(target.handle);
      pixels = Buffer.from(native.canvas.readPixels(target.handle, 0, 0, 32, 32));
    } finally { native.canvas.release(target.handle); }
  } else {
    native.renderScene();
    pixels = Buffer.from(native.canvas.captureSceneRawPremultiplied());
  }
  return { pixels, draws: native.render.stats().drawCalls - before.drawCalls };
}

for (const options of [{}, { nearest: true }, { flash: true }, { mask: true },
  { flash: true, nearest: true }, { blur: true }, { blur: 1e-12 }, { blur: true, flash: true }]) {
  const entries = [0, 1, 2].map(index => sprite(index, options));
  const batched = render(entries), separate = render(entries, true);
  assert.deepEqual(batched.pixels, separate.pixels, 'overlapping regions must preserve order and sampling');
  assert.equal(batched.draws, options.blur || options.flash ? 3 : 1, 'blur and color effects retain their separate frame uniforms');
  assert.equal(separate.draws, 3);
}
for (const offscreen of [false, true]) {
  const begin = { metadata: [6, 0xffffffff, 0, 0xffffff, 25, 0, 0],
    values: new Float32Array(schema.valueStride) };
  begin.values.set([1, 0, 0, 1, 0, 0, 1]);
  const matrix = [0.8, 0.1, 0, 0, 0.03, 0, 0.9, 0, 0, 0, 0, 0, 0.7, 0, 0, 0, 0, 0, 1, 0];
  begin.values.set(matrix.slice(0, 10), 7); begin.values.set(matrix.slice(10), 22);
  begin.values[32] = 1; begin.values[33] = 1;
  const entries = [0, 1, 2].map(index => sprite(index, {}));
  entries.forEach(entry => { entry.metadata[1] = 0; });
  const end = { metadata: [7, 0, 0, 0xffffff, 0, 0, 0], values: new Float32Array(schema.valueStride) };
  const records = [begin, ...entries, end];
  assert.deepEqual(render(records, false, offscreen).pixels, render(records, true, offscreen).pixels,
    'matrix composition and target projection must preserve batched region pixels');
}
const changedFlash = [sprite(0, { flash: true }), sprite(1, { flash: true })];
changedFlash[1].values[40] = 57 / 255;
assert.equal(render(changedFlash).draws, 2, 'different flash uniforms must split');
assert.equal(render([sprite(0, {}), sprite(1, { nearest: true })]).draws, 2,
  'sampling changes must split');
const ordinary = sprite(1, {});
ordinary.metadata[5] &= ~(1 << 13);
assert.equal(render([sprite(0, {}), ordinary]).draws, 2, 'ordinary and bitmap coordinates must remain separate');
native.canvas.release(image.handle);
native.canvas.release(mask.handle);
native.runtime.quit();
