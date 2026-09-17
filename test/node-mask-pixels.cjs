'use strict';

// Nested alpha-mask composition: a red sprite under two stacked masks must
// render only where both masks are opaque. Covers image masks (red channel)
// and canvas masks (alpha channel), the two mask-source shapes games use.
const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({
  gameRoot: path.resolve(process.argv[3]),
  assetRoot: '',
  width: 64,
  height: 64,
  windowTitle: 'pmjs mask pixels test',
});

const schema = native.scene.schema;
const MS = schema.metadataStride;
const VS = schema.valueStride;

const content = native.images.load('probe-content.png');
const maskA = native.images.load('probe-mask-a.png');
const maskB = native.images.load('probe-mask-b.png');

function canvasMask(solid) {
  const canvas = native.canvas.create(16, 16);
  const rgba = Buffer.alloc(16 * 16 * 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const o = (y * 16 + x) * 4;
      rgba[o] = 255; rgba[o + 1] = 255; rgba[o + 2] = 255;
      rgba[o + 3] = solid(x, y) ? 255 : 0;
    }
  }
  native.canvas.writePixels(canvas.handle, 0, 0, 16, 16, rgba);
  return canvas;
}

function maskGroup(parent, handle, usesRed) {
  const values = new Array(VS).fill(0);
  values[0] = 1; values[3] = 1; values[6] = 1;
  values[7] = 1; values[10] = 1; values[11] = -24; values[12] = -24;
  values[13] = 0; values[14] = 0; values[15] = 16; values[16] = 16;
  values[22] = 1; values[23] = usesRed; values[24] = 0;
  values[25] = 16; values[26] = 16; values[33] = 1;
  return { metadata: [6, parent, handle, 0xffffff, 3, 0, 0], values };
}

function spriteRecord(parent) {
  const values = new Array(VS).fill(0);
  values[0] = 1; values[3] = 1; values[4] = 24; values[5] = 24; values[6] = 1;
  values[9] = 0; values[10] = 0; values[11] = 16; values[12] = 16;
  values[13] = 16; values[14] = 16;
  return { metadata: [1, parent, content.handle, 0xffffff, 0, 0, 0], values };
}

function endRecord(parent) {
  const values = new Array(VS).fill(0);
  values[0] = 1; values[3] = 1; values[6] = 1;
  return { metadata: [7, parent, 0, 0xffffff, 0, 0, 0], values };
}

function submitNested(first, second) {
  const recs = [
    first(0xffffffff), second(0), spriteRecord(1), endRecord(1), endRecord(0),
  ];
  const metadata = new Uint32Array(recs.length * MS);
  const values = new Float32Array(recs.length * VS);
  recs.forEach((rec, i) => {
    metadata.set(rec.metadata, i * MS);
    values.set(rec.values, i * VS);
  });
  native.beginFrame();
  native.scene.submit(schema.version, metadata, values, recs.length);
  native.renderScene();
  return native.canvas.captureScene();
}

function redAt(frame, x, y) {
  return ((native.canvas.pixel(frame.handle, x, y) >>> 0) >>> 24) & 255;
}

function checkQuadrants(frame, label) {
  const seen = {
    inside: redAt(frame, 26, 26),
    right: redAt(frame, 34, 26),
    below: redAt(frame, 26, 34),
    far: redAt(frame, 34, 34),
  };
  assert.ok(seen.inside > 200, `${label}: masked-in quadrant is not red`);
  assert.ok(seen.right < 50, `${label}: leaks past first mask`);
  assert.ok(seen.below < 50, `${label}: leaks past second mask`);
  assert.ok(seen.far < 50, `${label}: leaks past both masks`);
  native.canvas.release(frame.handle);
}

checkQuadrants(submitNested(
  (parent) => maskGroup(parent, maskA.handle, 1),
  (parent) => maskGroup(parent, maskB.handle, 1)), 'image masks');

const canvasA = canvasMask((x) => x < 8);
const canvasB = canvasMask((x, y) => y < 8);
checkQuadrants(submitNested(
  (parent) => maskGroup(parent, canvasA.handle, 0),
  (parent) => maskGroup(parent, canvasB.handle, 0)), 'canvas masks');
native.canvas.release(canvasA.handle);
native.canvas.release(canvasB.handle);
