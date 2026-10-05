'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const native = require(path.resolve(process.argv[2]));
const [width, height] = (process.env.PMJS_TEST_GAME || '32x24').split('x').map(Number);
native.initialize({ gameRoot: path.resolve(process.argv[3]), width, height,
  windowTitle: 'presentation orientation' });

// The 10 fps fixture reverses its four corner colors starting at frame 2.
const firstVideo = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
const laterVideo = [...firstVideo].reverse();
const upperColors = [firstVideo[2], firstVideo[3], firstVideo[0], firstVideo[1]];
const sceneColors = [[0, 255, 255], [255, 0, 255], [255, 255, 255], [64, 64, 64]];
const corners = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];

function writeCorners(canvas, colors, alpha = 255) {
  const bytes = new Uint8Array(canvas.width * canvas.height * 4);
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const corner = (y >= canvas.height / 2 ? 2 : 0) + (x >= canvas.width / 2 ? 1 : 0);
      bytes.set([...colors[corner], alpha], (y * canvas.width + x) * 4);
    }
  }
  native.canvas.writePixels(canvas.handle, 0, 0, canvas.width, canvas.height, bytes);
}

function drawScene() {
  native.beginFrame();
  for (let corner = 0; corner < 4; corner++) {
    native.render.quad((corner % 2) * width / 2, Math.floor(corner / 2) * height / 2,
      width / 2, height / 2,
      ...sceneColors[corner].map(channel => channel / 255), 1);
  }
}

function checkDrawable(expected, label) {
  const geometry = native.render.presentation();
  const shot = native.canvas.captureDrawable();
  try {
    corners.forEach(([x, y], corner) => {
      const pixel = Array.from(native.canvas.readPixels(shot.handle,
        Math.floor(geometry.viewportX + x * geometry.viewportWidth),
        Math.floor(geometry.viewportY + y * geometry.viewportHeight), 1, 1));
      const target = [...expected[corner], 255];
      assert.ok(pixel.every((channel, index) => Math.abs(channel - target[index]) <= 5),
        `${label}, corner ${corner}: ${pixel} versus ${target}`);
    });
    if (geometry.letterboxed) {
      const [x, y] = geometry.viewportY > 0 ? [Math.floor(shot.width / 2), 0] :
        [0, Math.floor(shot.height / 2)];
      assert.deepEqual(Array.from(native.canvas.readPixels(shot.handle, x, y, 1, 1)),
        [0, 0, 0, 255], `${label}: letterbox`);
    }
  } finally { native.canvas.release(shot.handle); }
}

function releaseVideo(video) {
  native.media.releaseVideo(video.handle);
  if (video.audio) native.media.releaseAudio(video.audio);
}

test('decoded video preserves both axes on initial display and texture updates', async () => {
  const video = await native.media.loadVideoAsync('fixture-video.mp4');
  try {
    drawScene();
    native.render.setPresentationLayers(0, video.image, 1, 0, 0);
    native.renderFrame();
    checkDrawable(firstVideo, 'first video frame');

    const before = native.images.memory().textureFullUpdates;
    native.media.updateVideo(video.handle, 0.25);
    await new Promise(resolve => setTimeout(resolve, 100));
    const pts = native.media.updateVideo(video.handle, 0.25);
    assert.ok(pts >= 0.2 && pts <= 0.25, `updated frame timestamp: ${pts}`);
    assert.ok(native.images.memory().textureFullUpdates > before);
    drawScene();
    native.renderFrame();
    checkDrawable(laterVideo, 'updated video frame');
  } finally {
    native.render.setPresentationLayers(1, 0, 0, 0, 0);
    releaseVideo(video);
  }
});

test('upper canvas preserves both axes and displays dirty pixels immediately', () => {
  const upper = native.canvas.create(8, 8);
  try {
    writeCorners(upper, upperColors);
    drawScene();
    native.render.setPresentationLayers(0, 0, 0, upper.handle, 1);
    native.renderFrame();
    checkDrawable(upperColors, 'first upper canvas');

    writeCorners(upper, firstVideo);
    drawScene();
    native.render.setPresentationLayers(0, 0, 0, upper.handle, 1);
    native.renderFrame();
    checkDrawable(firstVideo, 'dirty upper canvas');
  } finally {
    native.render.setPresentationLayers(1, 0, 0, 0, 0);
    native.canvas.release(upper.handle);
  }
});

test('upper canvas preserves single-pixel rows at native resolution', {
  skip: process.env.PMJS_WINDOW_SIZE !== `${width}x${height}`
}, () => {
  const upper = native.canvas.create(width, height);
  const expected = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const shade = y % 2 * 255;
      expected.set([shade, shade, shade, 255], (y * width + x) * 4);
    }
  }
  try {
    native.canvas.writePixels(upper.handle, 0, 0, width, height, expected);
    drawScene();
    native.render.setPresentationLayers(0, 0, 0, upper.handle, 1);
    native.renderFrame();
    const shot = native.canvas.captureDrawable();
    try {
      const pixels = native.canvas.readPixels(shot.handle, 0, 0, width, height);
      const mismatch = pixels.findIndex((channel, index) => Math.abs(channel - expected[index]) > 1);
      assert.equal(mismatch, -1, `single-pixel row mismatch at byte ${mismatch}`);
    } finally { native.canvas.release(shot.handle); }
  } finally {
    native.render.setPresentationLayers(1, 0, 0, 0, 0);
    native.canvas.release(upper.handle);
  }
});

test('scene, video, and translucent upper canvas retain orientation and stacking', async () => {
  const video = await native.media.loadVideoAsync('fixture-video.mp4');
  const upper = native.canvas.create(8, 8);
  try {
    drawScene();
    native.render.setPresentationLayers(0.5, 0, 0, 0, 0);
    native.renderFrame();
    checkDrawable(sceneColors.map(color => color.map(channel => channel * 0.5)),
      'scene through compositor');

    writeCorners(upper, upperColors, 128);
    drawScene();
    native.render.setPresentationLayers(1, video.image, 0.5, upper.handle, 0.5);
    native.renderFrame();
    const alpha = 128 / 255 * 0.5;
    checkDrawable(upperColors.map((color, corner) => color.map((channel, index) =>
      channel * alpha + (firstVideo[corner][index] * 0.5 +
        sceneColors[corner][index] * 0.5) * (1 - alpha))), 'composed layers');
    const scene = native.canvas.captureScene();
    try {
      corners.forEach(([x, y], corner) => {
        assert.deepEqual(Array.from(native.canvas.readPixels(scene.handle,
          Math.floor(x * scene.width), Math.floor(y * scene.height), 1, 1)),
        [...sceneColors[corner], 255], 'scene capture excludes presentation layers');
      });
    } finally { native.canvas.release(scene.handle); }
  } finally {
    native.render.setPresentationLayers(1, 0, 0, 0, 0);
    native.canvas.release(upper.handle);
    releaseVideo(video);
  }
});
