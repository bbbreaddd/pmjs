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
  const video = await native.media.loadVideoAsync('fixture-video.mp4');
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

  native.beginFrame();
  native.render.quad(0, 0, 640, 480, 1, 0, 0, 1);
  native.render.setPresentationLayers(0.5, 0, 0, 0, 0);
  native.renderFrame();
  const scene = native.canvas.captureScene();
  const drawable = native.canvas.captureDrawable();
  try {
    const scenePixel = native.canvas.pixel(scene.handle, 320, 240);
    const drawablePixel = native.canvas.pixel(drawable.handle,
      Math.floor(drawable.width / 2), Math.floor(drawable.height / 2));
    if ((scenePixel & 0xff) < 240) {
      throw new Error('DOM composition changed the game scene capture');
    }
    if ((drawablePixel & 0xff) < 240 ||
        ((drawablePixel >>> 24) & 0xff) < 100 ||
        ((drawablePixel >>> 24) & 0xff) > 160 ||
        ((drawablePixel >>> 16) & 0xff) > 20 ||
        ((drawablePixel >>> 8) & 0xff) > 20) {
      throw new Error('canvas opacity was not composited over the black page');
    }
  } finally {
    native.canvas.release(scene.handle);
    native.canvas.release(drawable.handle);
  }

  const imagesBeforeUpperCanvas = native.images.memory();
  const upperCanvas = native.canvas.create(1, 1);
  native.canvas.writePixels(upperCanvas.handle, 0, 0, 1, 1,
    new Uint8Array([255, 0, 0, 128]));
  native.beginFrame();
  native.render.quad(0, 0, 640, 480, 0, 0, 1, 1);
  for (let frame = 0; frame < 4; frame++) {
    native.render.setPresentationLayers(1, 0, 0,
      upperCanvas.handle, 1);
  }
  native.renderFrame();
  const sameFrameUpper = native.canvas.captureDrawable();
  try {
    const pixel = native.canvas.pixel(sameFrameUpper.handle,
      Math.floor(sameFrameUpper.width / 2),
      Math.floor(sameFrameUpper.height / 2));
    const red = (pixel >>> 24) & 0xff;
    const blue = (pixel >>> 8) & 0xff;
    if (red < 100 || red > 155 || blue < 100 || blue > 155) {
      throw new Error('dirty upper-canvas pixels missed their first presentation frame');
    }
  } finally {
    native.canvas.release(sameFrameUpper.handle);
  }
  native.canvas.release(upperCanvas.handle);
  native.beginFrame();
  native.renderFrame();
  const sceneUnderUpperCanvas = native.canvas.captureScene();
  const drawableWithUpperCanvas = native.canvas.captureDrawable();
  try {
    const scenePixel = native.canvas.pixel(sceneUnderUpperCanvas.handle, 320, 240);
    const drawablePixel = native.canvas.pixel(drawableWithUpperCanvas.handle,
      Math.floor(drawableWithUpperCanvas.width / 2),
      Math.floor(drawableWithUpperCanvas.height / 2));
    if ((scenePixel & 0xff) < 240) {
      throw new Error('upper canvas leaked into game scene capture');
    }
    const red = (drawablePixel >>> 24) & 0xff;
    const green = (drawablePixel >>> 16) & 0xff;
    const blue = (drawablePixel >>> 8) & 0xff;
    if (red < 100 || red > 155 || green > 20 || blue < 100 || blue > 155) {
      throw new Error('50%-alpha upper canvas was not source-over composited: ' +
        drawablePixel.toString(16));
    }
    const geometry = native.render.presentation();
    if (!geometry.letterboxed) {
      throw new Error('expected this game/display pair to be letterboxed');
    }
    const topBar = native.canvas.pixel(drawableWithUpperCanvas.handle,
      Math.floor(drawableWithUpperCanvas.width / 2), 0);
    if (((topBar >>> 24) & 0xff) > 20 ||
        ((topBar >>> 16) & 0xff) > 20 || ((topBar >>> 8) & 0xff) > 20) {
      throw new Error('upper canvas was drawn over the letterbox bars');
    }
  } finally {
    native.canvas.release(sceneUnderUpperCanvas.handle);
    native.canvas.release(drawableWithUpperCanvas.handle);
    native.render.setPresentationLayers(1, 0, 0, 0, 0);
  }
  if (native.images.memory().liveCount !== imagesBeforeUpperCanvas.liveCount) {
    throw new Error('repeated presentation updates leaked upper-canvas references');
  }

  const resizedUpperCanvas = native.canvas.create(1, 1);
  native.canvas.writePixels(resizedUpperCanvas.handle, 0, 0, 1, 1,
    new Uint8Array([0, 255, 0, 255]));
  native.render.setPresentationLayers(1, 0, 0,
    resizedUpperCanvas.handle, 1);
  native.renderFrame();
  native.canvas.release(resizedUpperCanvas.handle);
  native.beginFrame();
  native.renderFrame();
  const resizedUpperShot = native.canvas.captureDrawable();
  try {
    const pixel = native.canvas.pixel(resizedUpperShot.handle,
      Math.floor(resizedUpperShot.width / 2),
      Math.floor(resizedUpperShot.height / 2));
    if (((pixel >>> 16) & 0xff) < 240 ||
        ((pixel >>> 24) & 0xff) > 20 || ((pixel >>> 8) & 0xff) > 20) {
      throw new Error('replacement upper-canvas image was not retained');
    }
  } finally {
    native.canvas.release(resizedUpperShot.handle);
    native.render.setPresentationLayers(1, 0, 0, 0, 0);
  }
  if (native.images.memory().liveCount !== imagesBeforeUpperCanvas.liveCount) {
    throw new Error('replacement presentation image was not released');
  }

  const compositorVideo = native.images.load('fixture.png');
  const stride = native.scene.schema.valueStride;
  const toneMetadata = new Uint32Array([
    3, 0xffffffff, 0, 0xff0000, 0, 0, 0,
    5, 0xffffffff, 0, 0xffffff, 0, 0, 0,
    3, 0xffffffff, 0, 0x0000ff, 0, 0, 0
  ]);
  const toneMatrix = [0.5, 0, 0, 0, 0, 0, 1, 0, 0, 0,
    0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
  const identityMatrix = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0,
    0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
  const renderToneWithVideo = matrix => {
    const values = new Float32Array(stride * 3);
    values.set([1, 0, 0, 1, 0, 0, 1], 0);
    values.set([0, 0, 2, 2], 9);
    values.set([2, 2], 13);
    values.set([1, 0, 0, 1, 0, 0, 1], stride);
    values.set(matrix, stride + 7);
    values.set([1, 0, 0, 1, 0, 0, 0.5], stride * 2);
    values.set([0, 0, 2, 2], stride * 2 + 9);
    values.set([2, 2], stride * 2 + 13);
    native.beginFrame();
    native.scene.submit(native.scene.packetVersion, toneMetadata, values, 3);
    native.render.setPresentationLayers(1, compositorVideo.handle, 0.5, 0, 0);
    native.renderFrame();
    const shot = native.canvas.captureDrawable();
    const logicalScene = native.canvas.captureScene();
    try {
      const pixel = native.canvas.pixel(shot.handle,
        Math.floor(shot.width / 2), Math.floor(shot.height / 2));
      const scenePixel = native.canvas.pixel(logicalScene.handle,
        Math.floor(logicalScene.width / 2),
        Math.floor(logicalScene.height / 2));
      return {
        drawable: [(pixel >>> 24) & 0xff, (pixel >>> 16) & 0xff,
          (pixel >>> 8) & 0xff],
        scene: [(scenePixel >>> 24) & 0xff, (scenePixel >>> 16) & 0xff,
          (scenePixel >>> 8) & 0xff]
      };
    } finally {
      native.canvas.release(shot.handle);
      native.canvas.release(logicalScene.handle);
    }
  };
  const tonedVideoPixel = renderToneWithVideo(toneMatrix);
  const identityVideoPixel = renderToneWithVideo(identityMatrix);
  if (identityVideoPixel.drawable[0] - tonedVideoPixel.drawable[0] < 20) {
    throw new Error('active MV tone was skipped when composing the video layer: ' +
      `${tonedVideoPixel.drawable} versus ${identityVideoPixel.drawable}`);
  }
  if (tonedVideoPixel.drawable.every((channel, index) =>
      channel === tonedVideoPixel.scene[index])) {
    throw new Error('captureScene incorrectly included the video layer');
  }
  native.render.setPresentationLayers(1, 0, 0, 0, 0);
  native.images.release(compositorVideo.handle);

  const beforeVideoPresentation = native.images.memory();
  native.render.setPresentationLayers(1, video.image, 1, 0, 0);
  native.media.releaseVideo(video.handle);
  if (video.audio) native.media.releaseAudio(video.audio);
  native.beginFrame();
  native.renderFrame();
  const retainedImages = native.images.memory();
  if (retainedImages.liveCount !== beforeVideoPresentation.liveCount) {
    throw new Error('presentation did not retain the selected video texture');
  }
  native.render.setPresentationLayers(1, 0, 0, 0, 0);
  const imagesReleased = native.images.memory();
  if (imagesReleased.liveCount !== beforeVideoPresentation.liveCount - 1) {
    throw new Error('video texture was not released');
  }

  console.log('[pmjs-node-video-texture] ready');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
