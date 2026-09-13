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
native.images.release(image.handle);

const stats = native.render.stats();
if (stats.frames !== 1 || stats.commands !== 1 || stats.drawCalls !== 1) {
  throw new Error(`unexpected renderer statistics: ${JSON.stringify(stats)}`);
}
