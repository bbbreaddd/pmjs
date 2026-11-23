'use strict';

const path = require('node:path');
const assert = require('node:assert/strict');
const native = require(path.resolve(process.argv[2]));
const root = path.resolve(process.argv[3]);
native.initialize({
  gameRoot: root,
  assetRoot: '',
  width: 640,
  height: 480,
  windowTitle: 'pmjs video texture test'
});

async function waitForTextureUpdate(video, previousUpdates, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    native.media.updateVideo(video.handle, 0.25);
    const memory = native.images.memory();
    if (memory.textureFullUpdates > previousUpdates) return memory;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`video decoder did not upload a frame within ${timeoutMs}ms`);
}

async function main() {
  let video, scene, drawable, upperCanvas, sameFrameUpper, sceneUnderUpperCanvas, drawableWithUpperCanvas, resizedUpperCanvas, resizedUpperShot, compositorVideo;
  try {
    native.images.release(native.images.fallbackImage().handle);
    const imagesBefore = native.images.memory();
    const canvasesBefore = native.canvas.memory();
    video = await native.media.loadVideoAsync('fixture-video.mp4');
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

    await waitForTextureUpdate(video, imagesLoaded.textureFullUpdates);

    native.beginFrame();
    native.render.quad(0, 0, 640, 480, 1, 0, 0, 1);
    native.render.setPresentationLayers(0.5, 0, 0, 0, 0);
    native.renderFrame();
    scene = native.canvas.captureScene();
    drawable = native.canvas.captureDrawable();
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
      native.canvas.release(scene.handle); scene = null;
      native.canvas.release(drawable.handle); drawable = null;
    }

    const imagesBeforeUpperCanvas = native.images.memory();
    upperCanvas = native.canvas.create(1, 1);
    native.canvas.writePixels(upperCanvas.handle, 0, 0, 1, 1,
      new Uint8Array([255, 0, 0, 128]));
    native.beginFrame();
    native.render.quad(0, 0, 640, 480, 0, 0, 1, 1);
    for (let frame = 0; frame < 4; frame++) {
      native.render.setPresentationLayers(1, 0, 0,
        upperCanvas.handle, 1);
    }
    native.renderFrame();
    sameFrameUpper = native.canvas.captureDrawable();
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
      native.canvas.release(sameFrameUpper.handle); sameFrameUpper = null;
    }
    native.canvas.release(upperCanvas.handle); upperCanvas = null;
    native.beginFrame();
    native.renderFrame();
    sceneUnderUpperCanvas = native.canvas.captureScene();
    drawableWithUpperCanvas = native.canvas.captureDrawable();
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
      native.canvas.release(sceneUnderUpperCanvas.handle); sceneUnderUpperCanvas = null;
      native.canvas.release(drawableWithUpperCanvas.handle); drawableWithUpperCanvas = null;
      native.render.setPresentationLayers(1, 0, 0, 0, 0);
    }
    if (native.images.memory().liveCount !== imagesBeforeUpperCanvas.liveCount) {
      throw new Error('repeated presentation updates leaked upper-canvas references');
    }

    resizedUpperCanvas = native.canvas.create(1, 1);
    native.canvas.writePixels(resizedUpperCanvas.handle, 0, 0, 1, 1,
      new Uint8Array([0, 255, 0, 255]));
    native.render.setPresentationLayers(1, 0, 0,
      resizedUpperCanvas.handle, 1);
    native.renderFrame();
    native.canvas.release(resizedUpperCanvas.handle); resizedUpperCanvas = null;
    native.beginFrame();
    native.renderFrame();
    resizedUpperShot = native.canvas.captureDrawable();
    try {
      const pixel = native.canvas.pixel(resizedUpperShot.handle,
        Math.floor(resizedUpperShot.width / 2),
        Math.floor(resizedUpperShot.height / 2));
      if (((pixel >>> 16) & 0xff) < 240 ||
          ((pixel >>> 24) & 0xff) > 20 || ((pixel >>> 8) & 0xff) > 20) {
        throw new Error('replacement upper-canvas image was not retained');
      }
    } finally {
      native.canvas.release(resizedUpperShot.handle); resizedUpperShot = null;
      native.render.setPresentationLayers(1, 0, 0, 0, 0);
    }
    if (native.images.memory().liveCount !== imagesBeforeUpperCanvas.liveCount) {
      throw new Error('replacement presentation image was not released');
    }

    compositorVideo = native.images.load('fixture.png');
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
      let logicalScene;
      try {
        logicalScene = native.canvas.captureScene();
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
        if (logicalScene) native.canvas.release(logicalScene.handle);
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
    native.images.release(compositorVideo.handle); compositorVideo = null;

    const beforeVideoPresentation = native.images.memory();
    native.render.setPresentationLayers(1, video.image, 1, 0, 0);
    native.media.releaseVideo(video.handle);
    if (video.audio) native.media.releaseAudio(video.audio);
    video = null;
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

    // Releasing while work is queued must join the worker and drop its owned image.
    const lifecycleBaseline = native.images.memory().liveCount;
    for (let attempt = 0; attempt < 4; attempt++) {
      const pending = await native.media.loadVideoAsync('fixture-video.mp4');
      try {
        native.media.updateVideo(pending.handle, 0.5);
        native.media.updateVideo(pending.handle, 0);
        native.media.updateVideo(pending.handle, 0.25);
        if (!native.media.releaseVideo(pending.handle) || native.media.releaseVideo(pending.handle)) {
          throw new Error('video release is not idempotent');
        }
      } finally {
        native.media.releaseVideo(pending.handle);
        if (pending.audio) native.media.releaseAudio(pending.audio);
      }
      if (native.images.memory().liveCount !== lifecycleBaseline) {
        throw new Error('queued video work retained its image after release');
      }
    }

    for (const direction of ['shrink', 'expand']) {
      const changing = await native.media.loadVideoAsync('fixture-video-' + direction + '.ts');
      try {
        const dimensions = [changing.width, changing.height];
        assert.deepEqual(dimensions, direction === 'shrink' ? [32, 24] : [16, 12]);
        const limit = Date.now() + 5000;
        let rejected = false;
        while (Date.now() < limit) {
          try { native.media.updateVideo(changing.handle, 0.75); }
          catch (error) {
            assert.match(error.message, /video frame dimensions changed/);
            rejected = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(rejected, true, direction + ' must fail before uploading mismatched pixels');
      } finally {
        native.media.releaseVideo(changing.handle);
        if (changing.audio) native.media.releaseAudio(changing.audio);
      }
      assert.equal(native.images.memory().liveCount, lifecycleBaseline);
    }

  } finally {
    native.render.setPresentationLayers(1, 0, 0, 0, 0);
    if (video) {
      native.media.releaseVideo(video.handle);
      if (video.audio) native.media.releaseAudio(video.audio);
    }
    if (compositorVideo) native.images.release(compositorVideo.handle);
    for (const canvas of [scene, drawable, upperCanvas, sameFrameUpper,
      sceneUnderUpperCanvas, drawableWithUpperCanvas, resizedUpperCanvas, resizedUpperShot]) {
      if (canvas) native.canvas.release(canvas.handle);
    }
  }
  console.log('[pmjs-node-video-texture] ready');
}

main().finally(() => native.runtime.quit()).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
