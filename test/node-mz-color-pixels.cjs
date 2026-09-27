'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const native = require(path.resolve(process.argv[2]));
const size = 16;
native.initialize({
  gameRoot: path.resolve(process.argv[3]),
  assetRoot: '',
  width: size,
  height: size,
  windowTitle: 'pmjs MZ color pixels',
});
native.render.setClearColor(0, 0, 0, 0);

const schema = native.scene.schema;
const noParent = 0xffffffff;

function canvas(rgba, width = size, height = size) {
  const image = native.canvas.create(width, height);
  const pixels = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels.set(rgba, offset);
  }
  native.canvas.writePixels(image.handle, 0, 0, width, height, pixels);
  return image;
}

function record(kind, resource = 0, blend = 0, alpha = 1) {
  const values = new Float32Array(schema.valueStride);
  values.set([1, 0, 0, 1, 0, 0, alpha]);
  return { metadata: [kind, noParent, resource, 0xffffff, blend, 0, 0], values };
}

function sprite(image, alpha = 1, blend = 0) {
  const entry = record(1, image.handle, blend, alpha);
  entry.values.set([0, 0, image.width, image.height], 9);
  entry.values.set([image.width, image.height], 13);
  return entry;
}

function filterBegin(values) {
  const entry = record(6, 0, 30);
  entry.values.set(values.slice(0, 10), 7);
  entry.values[33] = 1;
  return entry;
}

function render(entries) {
  const metadata = new Uint32Array(entries.length * schema.metadataStride);
  const values = new Float32Array(entries.length * schema.valueStride);
  entries.forEach((entry, index) => {
    metadata.set(entry.metadata, index * schema.metadataStride);
    values.set(entry.values, index * schema.valueStride);
  });
  const before = native.render.stats();
  native.beginFrame();
  native.scene.submit(schema.version, metadata, values, entries.length);
  native.renderFrame();
  const capture = native.canvas.captureScene();
  let pixels;
  try {
    pixels = Uint8Array.from(native.canvas.readPixels(
      capture.handle, 0, 0, size, size));
  } finally {
    native.canvas.release(capture.handle);
  }
  const after = native.render.stats();
  const centerOffset = (8 * size + 8) * 4;
  return {
    sceneCenter: Array.from(pixels.subarray(centerOffset, centerOffset + 4)),
    filterPasses: after.filterApplications[30] - before.filterApplications[30],
  };
}

const neutral = [0, 0, 0, 0, 0, 0, 0, 0, 0, 255];
const fixtures = [
  { color: [255, 0, 0, 255], params: [120, ...neutral.slice(1)], expected: [0, 255, 0, 255] },
  { color: [255, 0, 0, 255], params: [-120, ...neutral.slice(1)], expected: [0, 0, 255, 255] },
  { color: [255, 0, 0, 255], params: [0, 0, 0, 0, 255, 0, 0, 0, 0, 255], expected: [128, 128, 128, 255] },
  { color: [100, 120, 140, 255], params: [0, -20, 30, 40, 0, 0, 0, 0, 0, 255], expected: [80, 150, 180, 255] },
  { color: [255, 0, 0, 128], params: [120, ...neutral.slice(1)], expected: [0, 255, 0, 128] },
  { color: [0, 0, 0, 128], params: [0, 0, 0, 0, 0, 255, 128, 0, 255, 255], expected: [255, 128, 0, 128] },
  { color: [200, 100, 50, 255], params: [0, 0, 0, 0, 0, 0, 0, 0, 0, 128], expected: [100, 50, 25, 255] },
  { color: [0, 0, 0, 0], params: [120, 255, 255, 255, 0, 255, 255, 255, 255, 255], expected: [0, 0, 0, 0] },
];
for (const fixture of fixtures) {
  const image = canvas(fixture.color);
  try {
    const result = render([filterBegin(fixture.params), sprite(image), record(7)]);
    result.sceneCenter.forEach((value, channel) => {
      assert.ok(Math.abs(value - fixture.expected[channel]) <= 2,
        JSON.stringify({ fixture, actual: result.sceneCenter, channel }));
    });
    assert.equal(result.filterPasses, 1);
  } finally {
    native.canvas.release(image.handle);
  }
}
console.log('MZ ColorFilter native pixel fixtures passed');
