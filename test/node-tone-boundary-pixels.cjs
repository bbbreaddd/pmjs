'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { matrix, colors, cases } = require('./filter-boundary-cases.cjs');

const native = require(path.resolve(process.argv[2]));
const size = 16;
native.initialize({
  gameRoot: path.resolve(process.argv[3]),
  assetRoot: '',
  width: size,
  height: size,
  windowTitle: 'pmjs tone boundary pixels',
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

function tone(values, alpha = 1) {
  const entry = record(5, 0, 0, alpha);
  entry.values.set(values, 7);
  return entry;
}

function filterBegin(values) {
  const entry = record(6, 0, 25);
  entry.values.set(values.slice(0, 10), 7);
  entry.values.set(values.slice(10), 22);
  entry.values[32] = 1;
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
  const placement = native.render.presentation();
  const drawable = native.canvas.captureDrawable();
  let drawableCenter;
  try {
    const packed = native.canvas.pixel(drawable.handle,
      Math.floor(placement.viewportX + placement.viewportWidth / 2),
      Math.floor(placement.viewportY + placement.viewportHeight / 2)) >>> 0;
    drawableCenter = [(packed >>> 24) & 255, (packed >>> 16) & 255,
      (packed >>> 8) & 255, packed & 255];
  } finally {
    native.canvas.release(drawable.handle);
  }
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
    pixels,
    sceneCenter: Array.from(pixels.subarray(centerOffset, centerOffset + 4)),
    drawableCenter,
    deferred: after.toneComposedPresentationFrames -
      before.toneComposedPresentationFrames,
    materialized: after.toneAdjustDrawCalls - before.toneAdjustDrawCalls,
    matrixPasses: after.filterApplications[25] - before.filterApplications[25],
  };
}

const transparent = canvas([0, 0, 0, 0], 1, 1);
const white = canvas(colors.white);
const red = canvas(colors.red);
const pictures = { white, red };

for (const item of cases) {
  const background = canvas(item.source);
  try {
    const scene = [sprite(background), tone(item.tone, item.toneAlpha ?? 1),
      ...item.pictures.map(([name, alpha]) => sprite(pictures[name], alpha))];
    const deferred = render(scene);
    const materialized = render([...scene, sprite(transparent, 1, 1)]);
    assert.equal(deferred.deferred, 1, `${item.name}: deferred path not used`);
    assert.equal(deferred.materialized, 0, `${item.name}: tone was materialized`);
    assert.equal(materialized.deferred, 0,
      `${item.name}: deferred path used for reference`);
    assert.equal(materialized.materialized, 1,
      `${item.name}: reference tone was not materialized`);
    let maxDelta = 0;
    for (let index = 0; index < deferred.pixels.length; index++) {
      maxDelta = Math.max(maxDelta, Math.abs(deferred.pixels[index] -
        materialized.pixels[index]));
    }
    assert.ok(maxDelta <= 2, `${item.name}: max channel delta ${maxDelta}`);
    const drawableDelta = Math.max(...deferred.drawableCenter.slice(0, 3).map((value, index) =>
      Math.abs(value - materialized.drawableCenter[index])));
    assert.ok(drawableDelta <= 2,
      `${item.name}: drawable center delta ${drawableDelta}, deferred ` +
      `${deferred.drawableCenter}, materialized ${materialized.drawableCenter}`);
    if (item.expected) {
      const offset = (8 * size + 8) * 4;
      for (const [label, result] of [['deferred', deferred],
        ['materialized', materialized]]) {
        const actual = Array.from(result.pixels.subarray(offset, offset + 4));
        assert.ok(actual.every((value, index) =>
          Math.abs(value - item.expected[index]) <= 2),
        `${item.name} ${label}: ${actual} expected ${item.expected}`);
        assert.ok(result.drawableCenter.slice(0, 3).every((value, index) =>
          Math.abs(value - item.expected[index]) <= 2),
        `${item.name} ${label} drawable: ${result.drawableCenter} expected ${item.expected}`);
      }
    }
    if (item.expectedDrawable) {
      for (const [label, result] of [['deferred', deferred],
        ['materialized', materialized]]) {
        assert.ok(result.drawableCenter.slice(0, 3).every((value, index) =>
          Math.abs(value - item.expectedDrawable[index]) <= 2),
        `${item.name} ${label} drawable: ${result.drawableCenter} expected ${item.expectedDrawable}`);
      }
    }
    console.log(`${item.name}: scene delta ${maxDelta}, drawable delta ${drawableDelta}`);
    if (process.env.PMJS_TONE_BOUNDARY_JSON) {
      console.log('PMJS_TONE_BOUNDARY_RESULT=' + JSON.stringify({
        name: item.name,
        deferred: deferred.drawableCenter,
        materialized: materialized.drawableCenter,
        deferredScene: deferred.sceneCenter,
        materializedScene: materialized.sceneCenter,
      }));
    }
  } finally {
    native.canvas.release(background.handle);
  }
}

const backdrop = canvas([200, 100, 50, 255]);
const foreground = canvas([102, 153, 204, 128]);
const inlineMatrix = matrix([-1, -1, -1]);
const inlineScene = [sprite(backdrop), filterBegin(inlineMatrix),
  sprite(foreground), record(7), sprite(white, 0.5)];
const inline = render(inlineScene);
const separate = render([sprite(backdrop), filterBegin(inlineMatrix),
  sprite(foreground), sprite(transparent), record(7), sprite(white, 0.5)]);
assert.equal(inline.matrixPasses, 0);
assert.equal(separate.matrixPasses, 1);
let inlineDelta = 0;
for (let index = 0; index < inline.pixels.length; index++) {
  inlineDelta = Math.max(inlineDelta, Math.abs(inline.pixels[index] -
    separate.pixels[index]));
}
assert.ok(inlineDelta <= 2, `inline color matrix scene delta ${inlineDelta}`);
const inlineDrawableDelta = Math.max(...inline.drawableCenter.slice(0, 3)
  .map((value, index) => Math.abs(value - separate.drawableCenter[index])));
assert.ok(inlineDrawableDelta <= 2,
  `inline color matrix drawable delta ${inlineDrawableDelta}`);
console.log(`inline color matrix: scene delta ${inlineDelta}, drawable delta ${inlineDrawableDelta}, pixel ${inline.drawableCenter}`);
if (process.env.PMJS_TONE_BOUNDARY_JSON) {
  console.log('PMJS_TONE_BOUNDARY_RESULT=' + JSON.stringify({
    name: 'inline color matrix',
    deferred: inline.drawableCenter,
    materialized: separate.drawableCenter,
    deferredScene: inline.sceneCenter,
    materializedScene: separate.sceneCenter,
  }));
}
native.canvas.release(backdrop.handle);
native.canvas.release(foreground.handle);

native.canvas.release(transparent.handle);
native.canvas.release(white.handle);
native.canvas.release(red.handle);
