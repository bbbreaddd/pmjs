'use strict';

process.env.PMJS_GRAPHICS_DIAGNOSTICS = '1';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
const size = 16;
native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '',
  width: size, height: size, windowTitle: 'empty sprite pixels' });
native.render.setClearColor(0, 0, 1, 1);
const schema = native.scene.schema;
const noParent = 0xffffffff;
const canvases = [];

function canvas() {
  const image = native.canvas.create(size, size);
  canvases.push(image);
  return image;
}

function record(kind, resource = 0, flags = 0, blend = 0, parent = noParent) {
  const values = new Float32Array(schema.valueStride);
  values.set([1, 0, 0, 1, 0, 0, 1]);
  return { metadata: [kind, parent, resource, 0xffffff, blend, flags, 0], values };
}

function sprite(image, flags = 0, blend = 0, parent = noParent) {
  const entry = record(1, image.handle, flags, blend, parent);
  entry.values.set([0, 0, image.width, image.height], 9);
  entry.values.set([image.width, image.height], 13);
  return entry;
}

function render(entries, target) {
  const metadata = new Uint32Array(entries.length * schema.metadataStride);
  const values = new Float32Array(entries.length * schema.valueStride);
  entries.forEach((entry, index) => {
    metadata.set(entry.metadata, index * schema.metadataStride);
    values.set(entry.values, index * schema.valueStride);
  });
  const before = native.render.stats();
  native.beginFrame();
  native.scene.submit(schema.version, metadata, values, entries.length);
  let pixels;
  if (target) {
    native.render.renderToCanvas(target.handle);
    pixels = Buffer.from(native.canvas.readPremultipliedPixels(target.handle, 0, 0, size, size));
  } else {
    native.renderScene();
    pixels = Buffer.from(native.canvas.captureSceneRawPremultiplied());
  }
  return { pixels, draws: native.render.stats().drawCalls - before.drawCalls };
}

function pixel(frame, x, y) {
  const offset = (y * size + x) * 4;
  return Array.from(frame.pixels.subarray(offset, offset + 4));
}

const empty = canvas();
const blank = render([]);
const skipped = render([sprite(empty)]);
assert.deepEqual(skipped.pixels, blank.pixels);
assert.equal(skipped.draws, 0, 'empty ordinary sprite must issue no draw');
assert.deepEqual(render([sprite(empty), sprite(empty)]).pixels, blank.pixels,
  'shared empty texture must preserve pixels');
assert.equal(render([sprite(empty), sprite(empty)]).draws, 0);

native.canvas.fillRect(empty.handle, 0, 0, size, size, 0xff0000ff);
const filled = render([sprite(empty)]);
assert.equal(filled.draws, 1);
assert.deepEqual(pixel(filled, 8, 8), [255, 0, 0, 255], 'deferred write must render next frame');
native.canvas.clearRect(empty.handle, 0, 0, 1, 1);
const partial = render([sprite(empty)]);
assert.equal(partial.draws, 1);
assert.deepEqual(pixel(partial, 0, 0), [0, 0, 255, 255]);
assert.deepEqual(pixel(partial, 8, 8), [255, 0, 0, 255]);
native.canvas.clear(empty.handle);
assert.equal(render([sprite(empty)]).draws, 0, 'full clear restores empty content');
native.canvas.writePixels(empty.handle, 8, 8, 1, 1, new Uint8Array([0, 255, 0, 255]));
const written = render([sprite(empty)]);
assert.equal(written.draws, 1);
assert.deepEqual(pixel(written, 8, 8), [0, 255, 0, 255], 'one nonzero pixel must render');
native.canvas.clearRect(empty.handle, 0, 0, size, size);
assert.equal(render([sprite(empty)]).draws, 0);

const hiddenRgb = canvas();
const rgba = new Uint8Array(size * size * 4);
for (let offset = 0; offset < rgba.length; offset += 4) rgba[offset] = 37;
native.canvas.writePremultipliedPixels(hiddenRgb.handle, 0, 0, size, size, rgba);
const hidden = render([sprite(hiddenRgb)]);
assert.equal(hidden.draws, 1, 'zero alpha with nonzero premultiplied RGB is not empty');
assert.deepEqual(pixel(hidden, 8, 8), [37, 0, 255, 255]);

const child = canvas();
native.canvas.fillRect(child.handle, 0, 0, size, size, 0x00ff00ff);
const parented = render([sprite(empty), sprite(child, 0, 0, 0)]);
assert.deepEqual(parented.pixels, render([sprite(child)]).pixels,
  'visible children must survive an empty parent sprite');
assert.equal(parented.draws, 1);

const source = canvas();
const capturedEmpty = canvas();
native.canvas.drawImage(capturedEmpty.handle, source.handle, 0, 0, size, size, 0, 0, size, size, 1);
native.canvas.fillRect(source.handle, 0, 0, size, size, 0xff0000ff);
assert.equal(render([sprite(capturedEmpty)]).draws, 0,
  'captured source version must remain empty after source mutation');
const capturedRed = canvas();
native.canvas.drawImage(capturedRed.handle, source.handle, 0, 0, size, size, 0, 0, size, size, 1);
native.canvas.clear(source.handle);
assert.deepEqual(render([sprite(capturedRed)]).pixels, filled.pixels,
  'captured nonempty version must render after source clear');

const target = canvas();
assert.deepEqual(render([sprite(empty), sprite(child)], target).pixels,
  render([sprite(child)], target).pixels, 'offscreen rendering must preserve pixels');
native.beginFrame();
native.render.quad(0, 0, size, size, 0, 0, 0, 0);
const gpuImage = native.render.renderToImage(size, size, { alphaMode: 'premultiplied' });
assert.equal(render([sprite(gpuImage)]).draws, 1, 'GPU target content is not CPU-proven empty');
native.images.release(gpuImage.handle);

for (const blend of [1, 2, 3]) {
  assert.equal(render([sprite(empty, 0, blend)]).draws, 1,
    'non-normal blend must use ordinary rendering');
}
const tinted = sprite(empty, 1 << 4);
tinted.values.set([0, 0, 0, 0], 28);
tinted.values.set([255, 0, 0, 128], 32);
assert.equal(render([tinted]).draws, 1, 'sprite color effects must use ordinary rendering');
const blurred = sprite(empty, 1 << 1);
blurred.values[21] = 1;
assert.ok(render([blurred]).draws > 0, 'blur must use ordinary rendering');
const masked = sprite(empty, 1 << 2);
masked.metadata[6] = child.handle;
masked.values.set([1, 0, 0, 1, 0, 0], 22);
assert.ok(render([masked]).draws > 0, 'mask must use ordinary rendering');
assert.equal(render([sprite(empty, (1 << 13) | (1 << 10))]).draws, 1,
  'standalone bitmap material must use ordinary rendering');

const matrix = record(6, 0, 0, 25);
matrix.values.set([1, 0, 0, 0, 0.25, 0, 1, 0, 0, 0], 7);
matrix.values.set([0, 0, 1, 0, 0, 0, 0, 0, 1, 0], 22);
matrix.values[32] = matrix.values[33] = 1;
const end = record(7);
assert.ok(render([matrix, sprite(empty), end]).draws > 0,
  'inline matrix filters must retain their ordinary draw');
matrix.values[30] = 0;
matrix.values[31] = 1;
assert.equal(render([matrix, sprite(empty), end]).draws, 2,
  'filters that create alpha from empty content must render');

for (const image of canvases) native.canvas.release(image.handle);
native.runtime.quit();
console.log('Empty sprite pixels, later writes, captured versions, children and effect fallbacks agree');
