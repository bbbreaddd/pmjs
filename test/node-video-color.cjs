'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const native = require(path.resolve(process.argv[2]));
const root = path.resolve(process.argv[3]);
const reference = JSON.parse(zlib.gunzipSync(fs.readFileSync(
  path.join(__dirname, 'assets/reference/video-color.json.gz'))));
assert.equal(reference.chromium, '65.0.3325.146');
assert.equal(reference.freshProcessReplays, 2);
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(
  path.join(root, 'video-color.webm'))).digest('hex'), reference.movieSha256);
native.initialize({ gameRoot: root, width: 64, height: 64,
  windowTitle: 'Video colour test' });

function readImage(image) {
  const canvas = native.canvas.create(64, 64);
  try {
    native.canvas.drawImage(canvas.handle, image, 0, 0, 64, 64, 0, 0, 64, 64, 1, false);
    return Buffer.from(native.canvas.readPremultipliedPixels(canvas.handle, 0, 0, 64, 64));
  } finally { native.canvas.release(canvas.handle); }
}
async function seek(video, time, expected) {
  const limit = Date.now() + 5000;
  do {
    const pts = native.media.updateVideo(video.handle, time);
    if (Math.abs(pts - expected) < 1e-6) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < limit);
  throw new Error('Video seek timed out');
}
async function main() {
  native.images.memory();
  const before = native.images.memory().liveCount;
  const video = await native.media.loadVideoAsync('video-color.webm', 'chromium65');
  assert.equal(native.images.memory().liveCount, before + 1, 'Movie needs only one image');
  let canvasImage;
  for (const [index, row] of reference.records.entries()) {
    await seek(video, row.time, index * 0.5);
    const presented = readImage(video.image);
    assert.deepEqual(presented, Buffer.from(row.presented, 'base64'), 'Displayed frame ' + index);
    const image = native.media.videoCanvasImage(video.handle);
    canvasImage ||= image;
    assert.equal(image, canvasImage, 'Canvas texture handle must stay stable');
    assert.notEqual(image, video.image, 'Consumer conversions have separate backing');
    assert.equal(native.images.memory().liveCount, before + 2, 'Only one lazy canvas image');
    const pixels = readImage(image);
    assert.deepEqual(pixels, Buffer.from(row.canvas, 'base64'), 'Canvas frame ' + index);
    assert.deepEqual(pixels, Buffer.from(row.texture, 'base64'), 'Texture frame ' + index);
    assert.deepEqual(readImage(video.image), presented, 'Canvas access cannot modify presentation');
  }
  await seek(video, reference.records[0].time, 0);
  assert.deepEqual(readImage(video.image), Buffer.from(reference.records[0].presented, 'base64'));
  assert.deepEqual(readImage(canvasImage), Buffer.from(reference.records[0].canvas, 'base64'));
  native.render.setPresentationLayers(0, canvasImage, 1, 0, 0);
  native.media.releaseVideo(video.handle);
  if (video.audio) native.media.releaseAudio(video.audio);
  assert.equal(native.images.memory().liveCount, before + 1, 'Renderer retains canvas texture');
  native.render.setPresentationLayers(1, 0, 0, 0, 0);
  assert.equal(native.images.memory().liveCount, before, 'Both owned textures released');
  assert.throws(() => native.media.videoCanvasImage(video.handle), /invalid video handle/);
  assert.throws(() => native.media.loadVideo('video-color.webm', 'unknown'), /unknown video color profile/);
  const ordinary = native.media.loadVideo('video-color.webm', 'ffmpeg');
  assert.equal(native.media.videoCanvasImage(ordinary.handle), ordinary.image, 'Ordinary conversion needs no second image');
  native.media.releaseVideo(ordinary.handle);
  assert.equal(native.images.memory().liveCount, before);
  const fallback = native.media.loadVideo('video-color-fallback.webm', 'chromium65');
  const unmodified = native.media.loadVideo('video-color-fallback.webm', 'ffmpeg');
  assert.equal(native.media.videoCanvasImage(fallback.handle), fallback.image,
    'Full-range BT.709 remains on the ordinary converter');
  assert.deepEqual(readImage(fallback.image), readImage(unmodified.image));
  native.media.releaseVideo(fallback.handle);
  native.media.releaseVideo(unmodified.handle);
  assert.equal(native.images.memory().liveCount, before);
  console.log('[pmjs-node-video-color] ready');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
