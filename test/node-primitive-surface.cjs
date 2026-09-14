'use strict';

const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({
  gameRoot: path.resolve(process.argv[3]), assetRoot: '', width: 32, height: 32,
  windowTitle: 'pmjs primitive surface test',
});

const surface = native.render.createPrimitiveSurface(32, 32);
const schema = native.render.primitiveSurfaceSchema;
if (schema.recordStride !== 26 || schema.maxStops !== 3 ||
    schema.kinds.solidRect !== 0 || schema.kinds.concentricRadialGradient !== 1 ||
    schema.compositions.sourceOver !== 0 || schema.compositions.additive !== 1) {
  throw new Error(`invalid primitive surface schema: ${JSON.stringify(schema)}`);
}
const radial = [
  1, 0, 0, 32, 32, 16, 16, 0, 15, 2,
  0, 1, 0,
  1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0,
  1,
];
native.render.renderPrimitiveSurface(surface.handle, [0, 0, 0, 1], radial);

native.beginFrame();
native.render.image(surface.image.handle, 1, 0, 0, 1, 0, 0,
  0, 0, 32, 32, 1, 0xffffff, 0);
native.renderFrame();
const frame = native.canvas.captureScene();
const center = native.canvas.pixel(frame.handle, 16, 16);
const corner = native.canvas.pixel(frame.handle, 0, 0);
native.canvas.release(frame.handle);
if (((center >>> 24) & 255) < 220) {
  throw new Error(`surface center is unexpectedly dark: ${center.toString(16)}`);
}
if (((corner >>> 24) & 255) > 10) {
  throw new Error(`surface corner is unexpectedly bright: ${corner.toString(16)}`);
}

native.render.renderPrimitiveSurface(surface.handle, [0, 1, 0, 1], []);
native.beginFrame();
native.render.image(surface.image.handle, 1, 0, 0, 1, 0, 0,
  0, 0, 32, 32, 1, 0xffffff, 0);
if (!native.render.releasePrimitiveSurface(surface.handle)) {
  throw new Error('primitive surface release failed');
}
if (native.render.releasePrimitiveSurface(surface.handle)) {
  throw new Error('stale primitive surface handle remained valid');
}
native.renderFrame();
const replacedFrame = native.canvas.captureScene();
const replaced = native.canvas.pixel(replacedFrame.handle, 16, 16);
native.canvas.release(replacedFrame.handle);
if (((replaced >>> 16) & 255) < 240 || ((replaced >>> 24) & 255) > 10) {
  throw new Error(`surface redraw did not replace prior contents: ${replaced.toString(16)}`);
}
console.log('[pmjs-node-primitive-surface] ready');
