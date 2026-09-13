'use strict';

const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({gameRoot:path.resolve(process.argv[3]),assetRoot:'',width:32,height:32,windowTitle:'pmjs test'});

const image = native.images.load('fixture.png');
const stride = native.scene.schema.valueStride;
const end = [7, 0xffffffff, 0, 0xffffff, 0, 0, 0];
const maskMetadata = new Uint32Array([
  6, 0xffffffff, image.handle, 0xffffff, 3, 0, 0,
  1, 0xffffffff, image.handle, 0xffffff, 0, 0, 0,
  ...end
]);
const maskValues = new Float32Array(stride * 3);
for (let index = 0; index < 3; index++) {
  maskValues.set([1, 0, 0, 1, 0, 0, 1], index * stride);
}
maskValues.set([1, 0, 0, 1, 0, 0, 0, 0, 2, 2], 7);
maskValues.set([1, 0, 0, 2, 2], 22);
maskValues.set([0, 0, 2, 2], stride + 9);
maskValues.set([2, 2], stride + 13);
native.beginFrame();
native.scene.submit(native.scene.packetVersion, maskMetadata, maskValues, 3);
native.renderFrame();

const toneMetadata = new Uint32Array([
  1, 0xffffffff, image.handle, 0xffffff, 0, 0, 0,
  5, 0xffffffff, 0, 0xffffff, 0, 0, 0
]);
const toneValues = new Float32Array(stride * 2);
toneValues.set([1, 0, 0, 1, 0, 0, 1], 0);
toneValues.set([0, 0, 2, 2], 9);
toneValues.set([2, 2], 13);
toneValues.set([1, 0, 0, 1, 0, 0, 1], stride);
toneValues.set([1, 0, 0, 0, 0, 0, 1, 0, 0, 0,
  0, 0, 1, 0, 0, 0, 0, 0, 1, 0], stride + 7);
native.beginFrame();
native.scene.submit(native.scene.packetVersion, toneMetadata, toneValues, 2);
native.renderFrame();

const stats = native.render.stats();
if (!Array.isArray(stats.filterApplications) ||
    stats.filterApplications.length !== 30 ||
    stats.filterApplications[3] !== 1) {
  throw new Error('alpha-mask application was not attributed: ' +
    JSON.stringify(stats));
}
if (stats.toneAdjustDrawCalls !== 1 || stats.filterDrawCalls !== 2) {
  throw new Error('filter draw categories are inconsistent: ' +
    JSON.stringify(stats));
}
