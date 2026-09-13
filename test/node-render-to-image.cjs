'use strict';

const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({
  gameRoot: path.resolve(process.argv[3]),
  assetRoot: '',
  width: 16,
  height: 16,
  windowTitle: 'pmjs render-to-image test',
});

native.beginFrame();
native.render.quad(0, 0, 16, 16, 0, 1, 0, 1);
native.renderFrame();

native.beginFrame();
native.render.quad(0, 0, 16, 8, 1, 0, 0, 0.5);
native.render.quad(0, 8, 16, 8, 0, 0, 1, 1);
const rendered = native.render.renderToImage(16, 16);
if (!rendered || !rendered.handle || rendered.width !== 16 ||
    rendered.height !== 16) {
  throw new Error('renderToImage did not return a native image');
}

// Offscreen generation must not replace the last valid presentation frame.
native.renderFrame();
const retainedFrame = native.canvas.captureScene();
const retainedPixel = native.canvas.pixel(retainedFrame.handle, 8, 8);
native.canvas.release(retainedFrame.handle);
if (((retainedPixel >>> 16) & 0xff) < 240 ||
    ((retainedPixel >>> 24) & 0xff) > 15 ||
    ((retainedPixel >>> 8) & 0xff) > 15) {
  throw new Error('offscreen generation overwrote the retained scene');
}

native.beginFrame();
native.render.image(rendered.handle,
  1, 0, 0, 1, 0, 0,
  0, 0, 16, 16,
  1, 0xffffff, 0);
native.renderFrame();
const frame = native.canvas.captureScene();
const topPixel = native.canvas.pixel(frame.handle, 8, 2);
const bottomPixel = native.canvas.pixel(frame.handle, 8, 13);
native.canvas.release(frame.handle);
native.images.release(rendered.handle);
const topRed = (topPixel >>> 24) & 0xff;
if (topRed < 112 || topRed > 144 || ((topPixel >>> 16) & 0xff) > 15 ||
    ((topPixel >>> 8) & 0xff) > 15 || (topPixel & 0xff) < 240) {
  throw new Error('GPU render image did not preserve straight alpha: ' +
    topPixel.toString(16));
}
if (((bottomPixel >>> 8) & 0xff) < 240 ||
    ((bottomPixel >>> 24) & 0xff) > 15 ||
    ((bottomPixel >>> 16) & 0xff) > 15 || (bottomPixel & 0xff) < 240) {
  throw new Error('GPU render image orientation is inverted: ' +
    bottomPixel.toString(16));
}
