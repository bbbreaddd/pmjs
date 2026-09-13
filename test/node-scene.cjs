'use strict';

const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({
  gameRoot: path.resolve(process.argv[3]),
  assetRoot: '',
  width: 64,
  height: 64,
  windowTitle: 'pmjs test',
});

const schema = native.scene.schema;
if (schema.version !== native.scene.packetVersion ||
    schema.metadataStride !== 7 || schema.valueStride !== 41 ||
    schema.transactionalSubmit !== true) {
  throw new Error('native scene schema is incomplete');
}

native.input.inject(1 << 2);
if ((native.input.state() & (1 << 2)) === 0) {
  throw new Error('injected input was not visible');
}
native.input.inject(0);

const canvas = native.canvas.create(1, 1);
const rgba = new Uint8ClampedArray([12, 34, 56, 255]);
native.canvas.writePixels(canvas.handle, 0, 0, 1, 1, rgba);
const readback = native.canvas.readPixels(canvas.handle, 0, 0, 1, 1);
if (!readback.every((value, index) => value === rgba[index])) {
  throw new Error('canvas pixel round trip failed');
}
native.canvas.release(canvas.handle);

const image = native.images.load('fixture.png');
const metadata = new Uint32Array([
  1, 0xffffffff, image.handle, 0xffffff, 0, 0, 0,
]);
const values = new Float32Array(schema.valueStride);
values.set([1, 0, 0, 1, 8, 8, 1], 0);
values.set([0, 0, 2, 2], 9);
values.set([2, 2], 13);

native.beginFrame();
native.scene.submit(schema.version, metadata, values, 1);
native.renderFrame();
const frame = native.canvas.captureScene();
if ((native.canvas.pixel(frame.handle, 8, 8) >>> 8) === 0) {
  throw new Error('submitted sprite was not rendered');
}
native.canvas.release(frame.handle);

const stats1 = native.render.stats();
if (stats1.frames !== 1 || stats1.commands !== 1 || stats1.drawCalls !== 1 || stats1.retainedFrames !== 0) {
  throw new Error(`unexpected renderer statistics frame 1: ${JSON.stringify(stats1)}`);
}

// Frame 2: begin and render without submitting scene packet -> should retain previous scene
native.beginFrame();
native.renderFrame();
const frame2 = native.canvas.captureScene();
if ((native.canvas.pixel(frame2.handle, 8, 8) >>> 8) === 0) {
  throw new Error('previous scene frame was not retained when no scene submitted');
}
native.canvas.release(frame2.handle);

// Frame 3: queue a scene that fails validation during build() -> sceneSubmittedThisFrame must be restored to false
const invalidMetadata = new Uint32Array([
  1, 0xffffffff, image.handle, 0xffffff, 0, 0, 0,
  1, 1, image.handle, 0xffffff, 0, 0, 0,
]);
const invalidValues = new Float32Array(schema.valueStride * 2);
invalidValues.set([1, 0, 0, 1, 8, 8, 1], 0);
invalidValues.set([0, 0, 2, 2], 9);
invalidValues.set([2, 2], 13);
invalidValues.set([1, 0, 0, 1, 8, 8, 1], schema.valueStride);
invalidValues.set([0, 0, 2, 2], schema.valueStride + 9);
invalidValues.set([2, 2], schema.valueStride + 13);

native.beginFrame();
let rejected = false;
try {
  native.scene.submit(schema.version, invalidMetadata, invalidValues, 2);
} catch {
  rejected = true;
}
if (!rejected) {
  throw new Error('invalid scene packet was unexpectedly accepted');
}
native.renderFrame();
const frame3 = native.canvas.captureScene();
if ((native.canvas.pixel(frame3.handle, 8, 8) >>> 8) === 0) {
  throw new Error('frame was cleared to black after rejected scene submission');
}
native.canvas.release(frame3.handle);

// Frame 4: explicitly submit empty scene (nodeCount = 0) -> should clear scene to black
native.beginFrame();
native.scene.submit(schema.version, new Uint32Array(0), new Float32Array(0), 0);
native.renderFrame();
const frame4 = native.canvas.captureScene();
if ((native.canvas.pixel(frame4.handle, 8, 8) >>> 8) !== 0) {
  throw new Error('explicitly submitted empty scene was not cleared to black');
}
native.canvas.release(frame4.handle);
native.images.release(image.handle);

const stats = native.render.stats();
if (stats.frames !== 4 || stats.retainedFrames !== 2 || stats.commands !== 1 || stats.drawCalls !== 1) {
  throw new Error(`unexpected renderer statistics: ${JSON.stringify(stats)}`);
}
