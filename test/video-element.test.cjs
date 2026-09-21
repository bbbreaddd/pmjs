'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const eventsSource = fs.readFileSync(
  path.resolve(__dirname, '../js/pmjs-web/events.js'), 'utf8');
const elementsSource = fs.readFileSync(
  path.resolve(__dirname, '../js/pmjs-web/elements.js'), 'utf8');

function makeHarness(videoResource) {
  const calls = { loadVideo: [], releaseVideo: [], updateVideo: [] };
  let nextVideo = 10;
  const context = {
    console,
    pendingTasks: [],
    performance: { now() { return 1000; } },
    pmjsGameConfig: {},
    nativeWindowState: { focused: true, visible: true },
    CanvasContext2D: function CanvasContext2D() {},
    releaseNativeResource() {},
    trackNativeResource(resource) { return resource; },
    NativeHost: {
      runtime: { env() { return ''; } },
      canvas: {},
      media: {
        loadVideo(source) {
          calls.loadVideo.push(source);
          const handle = nextVideo++;
          const result = { handle, width: 960, height: 720, duration: 12 };
          result[videoResource || 'image'] = 500 + handle;
          return result;
        },
        releaseVideo(handle) { calls.releaseVideo.push(handle); },
        loadAudio() { throw new Error('no audio stream'); },
        releaseAudio() {},
        updateVideo(handle, time) {
          calls.updateVideo.push([handle, time]);
          return time;
        },
        audioIsPlaying() { return false; },
        stopAudio() {},
        setAudioParameters() {},
        playAudio() {}
      }
    }
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(eventsSource, context);
  vm.runInContext(elementsSource, context);
  return { context, calls };
}

function pixi4TextureFromVideo(video) {
  const texture = { valid: false, frame: { width: 0, height: 0 } };
  const baseTexture = {
    autoPlay: true,
    hasLoaded: false,
    width: video.videoWidth,
    height: video.videoHeight
  };
  texture.baseTexture = baseTexture;
  function onCanPlay() {
    video.removeEventListener('canplay', onCanPlay);
    video.removeEventListener('canplaythrough', onCanPlay);
    baseTexture.hasLoaded = true;
    baseTexture.width = video.videoWidth;
    baseTexture.height = video.videoHeight;
    texture.frame.width = baseTexture.width;
    texture.frame.height = baseTexture.height;
    texture.valid = texture.frame.width > 0 && texture.frame.height > 0;
    if (baseTexture.autoPlay) video.play();
  }
  if (video.readyState === video.HAVE_FUTURE_DATA ||
      video.readyState === video.HAVE_ENOUGH_DATA) onCanPlay();
  else {
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('canplaythrough', onCanPlay);
  }
  return texture;
}

test('video src selection loads after listeners can be installed', () => {
  const { context, calls } = makeHarness();
  const video = context.document.createElement('video');
  const events = [];

  video.preload = 'auto';
  video.src = 'movies/Opening.mp4';
  video.addEventListener('loadedmetadata', () => events.push('loadedmetadata'));
  video.addEventListener('loadeddata', () => events.push('loadeddata'));
  video.addEventListener('canplay', () => events.push('canplay'));

  assert.equal(video.readyState, video.HAVE_NOTHING);
  assert.equal(calls.loadVideo.length, 0);
  context.pendingTasks.splice(0).forEach(task => task());

  assert.deepEqual(calls.loadVideo, ['movies/Opening.mp4']);
  assert.equal(video.readyState, video.HAVE_ENOUGH_DATA);
  assert.equal(video.videoWidth, 960);
  assert.equal(video.videoHeight, 720);
  assert.deepEqual(events, ['loadedmetadata', 'loadeddata', 'canplay']);
});

test('Pixi 4 VideoBaseTexture becomes valid without autoplay in the YSP sequence', () => {
  const { context, calls } = makeHarness();
  const video = context.document.createElement('video');
  video.preload = 'auto';
  video.src = 'movies/Opening.mp4';

  const texture = pixi4TextureFromVideo(video);
  texture.baseTexture.autoPlay = false;
  assert.equal(texture.baseTexture.hasLoaded, false);
  assert.equal(texture.valid, false);
  context.pendingTasks.splice(0).forEach(task => task());

  assert.equal(texture.baseTexture.hasLoaded, true);
  assert.equal(texture.valid, true);
  assert.deepEqual(texture.frame, { width: 960, height: 720 });
  assert.equal(video.paused, true);
  assert.equal(calls.loadVideo.length, 1);
});

test('video exposes one stable native image while decoded frames advance', () => {
  const { context, calls } = makeHarness();
  const video = context.document.createElement('video');
  video.src = 'movies/Opening.mp4';
  context.pendingTasks.splice(0).forEach(task => task());
  const source = video._pmjsNativeTextureSource();

  video.play();
  video._startedAt = 890;
  video._update();
  video._startedAt = 777;
  video._update();

  assert.equal(video._pmjsNativeTextureSource(), source);
  assert.equal(video._pmjsNativeTextureSource().handle, 510);
  assert.equal(calls.updateVideo.length, 2);
  assert.ok(Math.abs(calls.updateVideo[0][1] - 0.11) < 0.000001);
  assert.ok(Math.abs(calls.updateVideo[1][1] - 0.223) < 0.000001);
  assert.equal(calls.loadVideo.length, 1);
});

test('video accepts the legacy native canvas contract', () => {
  const { context } = makeHarness('canvas');
  const video = context.document.createElement('video');
  video.src = 'movies/Opening.mp4';
  context.pendingTasks.splice(0).forEach(task => task());

  assert.equal(video._pmjsNativeTextureSource().handle, 510);
  assert.equal(video._nativeImage, null);
  assert.equal(video._nativeCanvas.handle, 510);
});

test('removing video src releases media and load with no source stays empty', () => {
  const { context, calls } = makeHarness();
  const video = context.document.createElement('video');
  video.src = 'movies/Opening.mp4';
  context.pendingTasks.splice(0).forEach(task => task());

  video.pause();
  video.removeAttribute('src');
  video.load();

  assert.equal(video.getAttribute('src'), null);
  assert.equal(video.readyState, video.HAVE_NOTHING);
  assert.equal(video._pmjsNativeTextureSource(), null);
  assert.deepEqual(calls.releaseVideo, [10]);
  assert.equal(calls.loadVideo.length, 1);
});

test('a replaced src cannot run its stale deferred load', () => {
  const { context, calls } = makeHarness();
  const video = context.document.createElement('video');
  video.src = 'movies/first.mp4';
  video.src = 'movies/second.mp4';
  context.pendingTasks.splice(0).forEach(task => task());
  assert.deepEqual(calls.loadVideo, ['movies/second.mp4']);
});
