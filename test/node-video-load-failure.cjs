'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '',
  width: 64, height: 64, windowTitle: 'Video load failure' });

native.images.release(native.images.fallbackImage().handle);
const before = native.images.memory();
assert.throws(() => native.media.loadVideo('video-matrix-601.ts'), /Resource temporarily unavailable/);
const after = native.images.memory();
assert.equal(after.liveCount, before.liveCount, 'failed worker construction retained its image');
assert.equal(after.gpuBytes, before.gpuBytes, 'failed worker construction retained texture memory');
const healthy = native.media.loadVideo('video-matrix-601.ts');
assert.ok(healthy.image);
native.media.releaseVideo(healthy.handle);
assert.equal(native.images.memory().liveCount, before.liveCount);
console.log('[pmjs-node-video-load-failure] ready');
