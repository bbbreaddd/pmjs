'use strict';

const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
const root = path.resolve(process.argv[3]);
native.initialize({
  gameRoot: root,
  assetRoot: '',
  width: 640,
  height: 480,
  windowTitle: 'pmjs video texture test'
});

async function main() {
  native.images.memory();
  const imagesBefore = native.images.memory();
  const canvasesBefore = native.canvas.memory();
  const video = native.media.loadVideo('fixture-video.mp4');
  const imagesLoaded = native.images.memory();
  const canvasesLoaded = native.canvas.memory();

  if (!video.image || video.canvas !== undefined) {
    throw new Error('video did not expose a dedicated image texture');
  }
  if (imagesLoaded.liveCount !== imagesBefore.liveCount + 1) {
    throw new Error('video texture was not registered as an image');
  }
  if (canvasesLoaded.liveCount !== canvasesBefore.liveCount ||
      canvasesLoaded.cpuPixelBytes !== canvasesBefore.cpuPixelBytes) {
    throw new Error('video allocated CPU canvas storage');
  }

  native.media.updateVideo(video.handle, 0.25);
  await new Promise(resolve => setTimeout(resolve, 100));
  native.media.updateVideo(video.handle, 0.25);
  const imagesUpdated = native.images.memory();
  if (imagesUpdated.textureFullUpdates <= imagesLoaded.textureFullUpdates) {
    throw new Error('decoded video frame did not update its image texture');
  }

  native.media.releaseVideo(video.handle);
  const imagesReleased = native.images.memory();
  if (imagesReleased.liveCount !== imagesBefore.liveCount) {
    throw new Error('video texture was not released');
  }

  console.log('[pmjs-node-video-texture] ready');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
