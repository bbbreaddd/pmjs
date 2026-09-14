'use strict';

const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({gameRoot:path.resolve(process.argv[3]),assetRoot:'',width:640,height:480,windowTitle:'pmjs test'});

const canvas = native.canvas.create(20, 20);
native.canvas.fillRadialGradient(canvas.handle, 0, 0, 20, 20,
  10, 10, 0, 10, [0, 1], [0xffffffff, 0x00000000], false);
const center = native.canvas.pixel(canvas.handle, 10, 10);
const corner = native.canvas.pixel(canvas.handle, 0, 0);
if ((center & 255) < 220) throw new Error(`gradient center is too transparent: ${center}`);
if ((corner & 255) !== 0) throw new Error(`gradient corner should be transparent: ${corner}`);

native.canvas.fillRect(canvas.handle, 0, 0, 20, 20, 0x202020ff);
native.canvas.fillRadialGradient(canvas.handle, 0, 0, 20, 20,
  10, 10, 0, 10, [0, 1], [0x80808080, 0x00000000], true);
const additiveCenter = native.canvas.pixel(canvas.handle, 10, 10);
if (((additiveCenter >>> 24) & 255) < 75) {
  throw new Error(`additive gradient did not brighten center: ${additiveCenter}`);
}
native.canvas.release(canvas.handle);
console.log('[pmjs-node-canvas-radial-gradient] ready');
