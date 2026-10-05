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
const mainLoopSource = fs.readFileSync(
  path.resolve(__dirname, '../js/pmjs-rpgmaker/main-loop.js'), 'utf8');
const mvMainLoopSource = fs.readFileSync(
  path.resolve(__dirname, '../js/pmjs-mv/main-loop.js'), 'utf8');

function makeHarness(videoResource, runtimeEnv) {
  const calls = { loadVideo: [], loadVideoProfiles: [], releaseVideo: [], updateVideo: [] };
  const telemetry = [];
  let nextVideo = 10;
  const context = {
    console: { log(line) { telemetry.push(String(line)); } },
    PMJS: { images: { preparedTileSet: '' } },
    performance: { now() { return 1000; } },
    pmjsGameConfig: {},
    nativeWindowState: { focused: true, visible: true },
    CanvasContext2D: function CanvasContext2D() {},
    releaseNativeResource() {},
    trackNativeResource(resource) { return resource; },
    NativeHost: {
      runtime: { env() { return runtimeEnv || ''; } },
      canvas: {},
      media: {
        loadVideoAsync(source, profile) {
          calls.loadVideo.push(source);
          calls.loadVideoProfiles.push(profile);
          const handle = nextVideo++;
          const result = { handle, width: 960, height: 720, duration: 12 };
          result[videoResource || 'image'] = 500 + handle;
          return Promise.resolve(Object.assign(result, { audio: null }));
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
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,
    '../js/pmjs-web/scheduler.js'), 'utf8'), context);
  vm.runInContext(eventsSource, context);
  vm.runInContext(elementsSource, context);
  return { context, calls, telemetry };
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

function loadRenderer(context) {
  const { sandbox } = require('./helpers/scene-encoder-harness.cjs').makeHarness();
  context.PIXI = sandbox.PIXI;
  context.PIXI.RENDERER_TYPE = { WEBGL: 1 };
  context.PIXI.Texture = { EMPTY: { baseTexture: {} } };
  context.PIXI.Matrix = class {
    identity() { this.a = this.d = 1; this.b = this.c = this.tx = this.ty = 0; return this; }
  };
  context.PIXI.WebGLRenderer = class {};
  context.PIXI.WebGLRenderer.__plugins = {};
  for (const name of ['scene-primitives', 'renderer-managers', 'renderer-facade']) {
    const filename = path.resolve(__dirname, '../js/pmjs-pixi4', name + '.js');
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }
  const renderer = context.createNativePixiRenderer(816, 624);
  assert.equal(context.PMJS.pixi4.isNativeRenderer(renderer), true);
  assert.equal(context.PMJS.pixi4.isNativeRenderer(Object.assign({}, renderer)), false);
  assert.equal(context.PMJS.pixi4.isNativeRenderer(Object.create(Object.getPrototypeOf(renderer))), false);
  return renderer;
}

function makeRendererHarness() {
  const { context } = makeHarness();
  const calls = [];
  const video = {
    style: { opacity: 0.4 },
    videoWidth: 816,
    videoHeight: 624,
    _pmjsNativePresentationSource() { return { handle: 42 }; }
  };
  context.Graphics = {
    _canvas: { style: { opacity: 0 } },
    _video: video
  };
  context.prepareNativeBitmapCaches = () => {};
  context.nativeComposeTransform = (_left, right) => right;
  context.renderNativeStage = () => calls.push(['stage']);
  context.NativeHost.render = {
    setScreenRenderSize() {},
    quad(...args) { calls.push(['quad', ...args]); },
    image(...args) { calls.push(['image', ...args]); },
    setPresentationLayers(...args) { calls.push(['presentation', ...args]); }
  };
  const renderer = loadRenderer(context);
  return { calls, context, render: renderer.render,
    syncPresentation: renderer._pmjsSyncPresentation, renderer };
}

test('native renderer allows guest extension queries without advertising unsupported extensions', () => {
  const { renderer } = makeRendererHarness();
  assert.equal(renderer.gl.getExtension('WEBGL_lose_context'), null);
  assert.equal(renderer.gl.getExtension('PMJS_unknown_extension'), null);
  assert.equal(renderer.gl.isContextLost(), false);
});

test('video src selection loads asynchronously after listeners can be installed', async () => {
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
  context.PMJS.tasks.drain();
  await Promise.resolve();

  assert.deepEqual(calls.loadVideo, ['movies/Opening.mp4']);
  assert.equal(video.readyState, video.HAVE_ENOUGH_DATA);
  assert.equal(video.videoWidth, 960);
  assert.equal(video.videoHeight, 720);
  assert.deepEqual(events, ['loadedmetadata', 'loadeddata', 'canplay']);
});

test('media property handlers keep their registration order with listeners', async () => {
  const { context } = makeHarness();
  const video = context.document.createElement('video');
  const events = [];
  video.src = 'movies/Opening.mp4';
  video.onloadedmetadata = () => events.push('property-metadata');
  video.addEventListener('loadedmetadata', () => events.push('listener-metadata'));
  video.addEventListener('loadeddata', () => events.push('listener-data'));
  video.onloadeddata = () => events.push('property-data');

  context.PMJS.tasks.drain();
  await Promise.resolve();

  assert.deepEqual(events, [
    'property-metadata', 'listener-metadata',
    'listener-data', 'property-data'
  ]);
});

test('video lifecycle telemetry measures queued-to-frame readiness when enabled', async () => {
  const { context, telemetry } = makeHarness(undefined, '1');
  const video = context.document.createElement('video');
  video.src = 'movies/Opening.mp4';
  context.PMJS.tasks.drain();
  await Promise.resolve();

  const records = telemetry.filter(line =>
    line.startsWith('[pmjs-video-lifecycle] ')).map(line =>
    JSON.parse(line.slice('[pmjs-video-lifecycle] '.length)));
  assert.deepEqual(records.map(record => record.event), [
    'load-queued', 'native-load-start', 'first-frame-ready',
    'loadeddata-dispatched'
  ]);
  assert.ok(records[2].queueMs >= 0);
  assert.ok(records[2].nativeMs >= 0);
});

test('MV load returns before loadeddata and video-playing state clears on end', async () => {
  const { context } = makeHarness();
  const video = context.document.createElement('video');
  const graphics = {
    _video: video,
    _videoLoading: false,
    _onVideoLoad() {
      video.play();
      video.style.opacity = 1;
      graphics._videoLoading = false;
    },
    _playVideo(source) {
      video.src = source;
      video.onloadeddata = graphics._onVideoLoad;
      video.onerror = () => {};
      video.onended = graphics._onVideoEnd;
      video.load();
      graphics._videoLoading = true;
    },
    _onVideoEnd() { video.style.opacity = 0; },
    isVideoPlaying() { return graphics._videoLoading || !video.ended; }
  };

  graphics._playVideo('movies/Opening.mp4');
  assert.equal(graphics._videoLoading, true);
  assert.equal(video.style.opacity, undefined);
  assert.equal(graphics.isVideoPlaying(), true);
  context.PMJS.tasks.drain();
  await Promise.resolve();

  assert.equal(graphics._videoLoading, false);
  assert.equal(video.style.opacity, 1);
  assert.equal(graphics.isVideoPlaying(), true);
  video._startedAt = -12000;
  video._update();
  assert.equal(video.style.opacity, 0);
  assert.equal(graphics.isVideoPlaying(), false);
});

test('src followed by play queues one asynchronous native load', async () => {
  const { context, calls } = makeHarness();
  const video = context.document.createElement('video');
  video.src = 'movies/Opening.mp4';
  const playback = video.play();
  assert.equal(video._loading, true);
  context.PMJS.tasks.drain();
  await Promise.resolve();
  assert.deepEqual(calls.loadVideo, ['movies/Opening.mp4']);
  assert.equal(video.paused, false);
  await playback;
});

test('load followed by play reuses queued work and pause cancels play intent', async () => {
  const { context, calls } = makeHarness();
  const video = context.document.createElement('video');
  video.preload = 'none';
  video.src = 'movies/Opening.mp4';
  video.load();
  const playback = video.play();
  const interrupted = assert.rejects(playback, { name: 'AbortError' });
  assert.equal(video._loading, true);
  video.pause();
  await interrupted;
  context.PMJS.tasks.drain();
  await Promise.resolve();
  assert.deepEqual(calls.loadVideo, ['movies/Opening.mp4']);
  assert.equal(video.paused, true);
  assert.equal(video._playRequested, false);
  assert.equal(context.PMJS.web.video.diagnostics().length, 0);
});

test('Pixi 4 VideoBaseTexture becomes valid after asynchronous data readiness', async () => {
  const { context, calls } = makeHarness();
  const video = context.document.createElement('video');
  video.preload = 'auto';
  video.src = 'movies/Opening.mp4';

  const texture = pixi4TextureFromVideo(video);
  texture.baseTexture.autoPlay = false;
  assert.equal(texture.baseTexture.hasLoaded, false);
  assert.equal(texture.valid, false);
  context.PMJS.tasks.drain();
  await Promise.resolve();

  assert.equal(texture.baseTexture.hasLoaded, true);
  assert.equal(texture.valid, true);
  assert.deepEqual(texture.frame, { width: 960, height: 720 });
  assert.equal(video.paused, true);
  assert.equal(calls.loadVideo.length, 1);
});

test('video exposes one stable native image while decoded frames advance', async () => {
  const { context, calls } = makeHarness();
  const video = context.document.createElement('video');
  video.src = 'movies/Opening.mp4';
  context.PMJS.tasks.drain();
  await Promise.resolve();
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

test('presentation layers synchronize separately after scene render', () => {
  const { calls, context, render, syncPresentation, renderer } = makeRendererHarness();

  render.call(renderer, {});

  assert.deepEqual(calls.map(call => call[0]), ['stage']);
  syncPresentation.call(renderer);
  assert.deepEqual(calls[1], ['presentation', 0, 42, 0.4, 0, 1]);

  calls.length = 0;
  context.Graphics._video._pmjsNativePresentationSource = () => null;
  context.Graphics._video.style.opacity = 1;
  render.call(renderer, {});
  assert.deepEqual(calls.map(call => call[0]), ['stage']);
  syncPresentation.call(renderer);
  assert.deepEqual(calls[1], ['presentation', 0, 0, 1, 0, 1]);

  calls.length = 0;
  context.Graphics._canvas.style.opacity = 0.25;
  context.Graphics._video.style.opacity = '';
  context.Graphics._video._pmjsNativePresentationSource = () => ({ handle: 42 });
  render.call(renderer, {});
  assert.deepEqual(calls.map(call => call[0]), ['stage']);
  syncPresentation.call(renderer);
  assert.deepEqual(calls[1], ['presentation', 0.25, 42, 1, 0, 1]);

  context.Graphics._upperCanvas = {
    style: { opacity: 0.5 },
    _ensureNativeCanvas() { return { handle: 88 }; }
  };
  render.call(renderer, {});
  syncPresentation.call(renderer);
  assert.deepEqual(calls.at(-1), ['presentation', 0.25, 42, 1, 88, 0.5]);
});

test('MV movie visibility transitions preserve separate presentation layers', () => {
  const { calls, context, render, syncPresentation, renderer } = makeRendererHarness();
  const setVisibility = (canvasOpacity, videoOpacity, hasFrame) => {
    context.Graphics._canvas.style.opacity = canvasOpacity;
    context.Graphics._video.style.opacity = videoOpacity;
    context.Graphics._video._pmjsNativePresentationSource = () =>
      hasFrame ? { handle: 42 } : null;
    calls.length = 0;
    render.call(renderer, {});
    syncPresentation.call(renderer);
    return calls.at(-1);
  };

  assert.deepEqual(setVisibility(1, 0, true), ['presentation', 1, 0, 0, 0, 1]);
  assert.deepEqual(setVisibility(0, 1, true), ['presentation', 0, 42, 1, 0, 1]);
  assert.deepEqual(setVisibility(0, 1, false), ['presentation', 0, 0, 1, 0, 1]);
  assert.deepEqual(setVisibility(1, 0, true), ['presentation', 1, 0, 0, 0, 1]);
});

test('MV synchronizes presentation after the final game update', () => {
  const { calls, context, syncPresentation, renderer } = makeRendererHarness();
  context.Graphics._renderer = Object.assign(renderer, {
    _pmjsSyncPresentation: syncPresentation
  });
  context.Graphics._canvas.style.opacity = 1;
  context.Graphics._video.style.opacity = 0;
  vm.runInContext(mvMainLoopSource, context);
  context.pmjsMvRender(100);
  assert.deepEqual(calls.at(-1), ['presentation', 1, 0, 0, 0, 1]);
});

test('video exposes its async native image texture contract', async () => {
  const { context } = makeHarness();
  const video = context.document.createElement('video');
  video.src = 'movies/Opening.mp4';
  context.PMJS.tasks.drain();
  await Promise.resolve();

  assert.equal(video._pmjsNativeTextureSource().handle, 510);
  assert.equal(video._nativeImage.handle, 510);
  assert.equal(video._nativeCanvas, null);
});

test('an ended handler can start another source without losing video updates', async () => {
  const { context, calls } = makeHarness();
  vm.runInContext(mainLoopSource, context);
  const video = context.document.createElement('video');
  video.src = 'movies/one.webm';
  context.PMJS.tasks.drain();
  await Promise.resolve();
  let completions = 0;
  video.onended = () => {
    completions++;
    if (completions === 1) {
      video.src = 'movies/two.webm';
      video.play();
    }
  };
  video.play();
  video._startedAt = -12000;
  context.pmjsRunRpgMakerTick(1);
  context.PMJS.tasks.drain();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(video.src, 'movies/two.webm');
  assert.equal(video.paused, false);
  assert.equal(context.PMJS.web.video.diagnostics().length, 1);
  context.pmjsRunRpgMakerTick(2);
  assert.equal(calls.updateVideo.at(-1)[0], 11);
  video._startedAt = -12000;
  context.pmjsRunRpgMakerTick(3);
  assert.equal(completions, 2);
});

test('extract.image exposes a native canvas handle and releases it on src changes', () => {
  const { context } = makeHarness();
  const released = [];
  let nextHandle = 70;
  context.NativeHost.canvas.create = () => ({ handle: ++nextHandle });
  context.NativeHost.canvas.encodePng = () => Uint8Array.from([1]);
  context.releaseNativeResource = (resource, kind) => {
    if (resource) released.push([resource.handle, kind]);
  };
  context.NativeHost.render = { setScreenRenderSize() {} };
  const extract = loadRenderer(context).extract;
  const canvas = context.document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 3;
  const image = extract.image.call({ canvas: () => canvas });
  assert.equal(image._nativeCanvas.handle, 71);
  assert.equal(image._pmjsCanvasOwner, canvas);
  assert.equal(image.width, 4);
  assert.equal(image.complete, true);
  image.src = '';
  assert.equal(image._nativeCanvas, null);
  assert.equal(image._pmjsCanvasOwner, null);
  assert.deepEqual(released, [[71, 'canvas']]);

  const replacement = extract.image.call({ canvas: () => context.document.createElement('canvas') });
  const replacementHandle = replacement._nativeCanvas.handle;
  replacement.src = 'other.png';
  assert.equal(replacement._nativeCanvas, null);
  assert.deepEqual(released.at(-1), [replacementHandle, 'canvas']);
});

test('removing video src releases media and load with no source stays empty', async () => {
  const { context, calls } = makeHarness();
  const video = context.document.createElement('video');
  video.src = 'movies/Opening.mp4';
  context.PMJS.tasks.drain();
  await Promise.resolve();

  video.pause();
  video.removeAttribute('src');
  video.load();

  assert.equal(video.getAttribute('src'), null);
  assert.equal(video.readyState, video.HAVE_NOTHING);
  assert.equal(video._pmjsNativeTextureSource(), null);
  assert.deepEqual(calls.releaseVideo, [10]);
  assert.equal(calls.loadVideo.length, 1);
});

test('a replaced src cannot run its stale deferred load', async () => {
  const { context, calls } = makeHarness();
  const video = context.document.createElement('video');
  video.src = 'movies/first.mp4';
  video.src = 'movies/second.mp4';
  context.PMJS.tasks.drain();
  await Promise.resolve();
  assert.deepEqual(calls.loadVideo, ['movies/second.mp4']);
});

test('a source replaced by a readiness handler receives no stale readiness events', async () => {
  for (const replacementEvent of ['loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough']) {
    const { context, calls } = makeHarness();
    const video = context.document.createElement('video');
    const events = [];
    const readinessEvents = ['loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough'];
    for (const type of readinessEvents) {
      video.addEventListener(type, () => {
        events.push([type, video.src, video.readyState]);
        if (type === replacementEvent && video.src === 'movies/first.mp4') {
          video.src = 'movies/second.mp4';
          video.play();
        }
      });
    }
    video.src = 'movies/first.mp4';
    context.PMJS.tasks.drain();
    await Promise.resolve();
    assert.deepEqual(events.map(event => event[0]),
      readinessEvents.slice(0, readinessEvents.indexOf(replacementEvent) + 1));
    assert.ok(events.every(event => event[1] === 'movies/first.mp4' && event[2] === video.HAVE_ENOUGH_DATA));
    assert.equal(video.readyState, video.HAVE_NOTHING);
    context.PMJS.tasks.drain();
    await Promise.resolve();
    assert.deepEqual(calls.loadVideo, ['movies/first.mp4', 'movies/second.mp4']);
    assert.deepEqual(calls.releaseVideo, [10]);
    assert.deepEqual(events.slice(-4).map(event => event.slice(0, 2)),
      readinessEvents.map(type => [type, 'movies/second.mp4']));
    assert.equal(video.paused, false);
  }
});

test('a stale async media completion is released after source replacement', async () => {
  const { context, calls } = makeHarness();
  const resolveLoads = [];
  context.NativeHost.media.loadVideoAsync = source => {
    calls.loadVideo.push(source);
    return new Promise(resolve => resolveLoads.push(resolve));
  };
  const video = context.document.createElement('video');
  video.src = 'movies/first.mp4';
  const playback = video.play();
  const interrupted = assert.rejects(playback, { name: 'AbortError' });
  context.PMJS.tasks.drain();
  video.src = 'movies/second.mp4';
  await interrupted;
  context.PMJS.tasks.drain();

  resolveLoads[0]({ handle: 30, image: 130, width: 960, height: 720,
    duration: 12, audio: null });
  resolveLoads[1]({ handle: 31, image: 131, width: 960, height: 720,
    duration: 12, audio: null });
  await Promise.resolve();

  assert.deepEqual(calls.releaseVideo, [30]);
  assert.equal(video._media.handle, 31);
  assert.equal(video._nativeImage.handle, 131);
});

test('play rejects when loading fails or no source is available', async () => {
  const { context } = makeHarness();
  const video = context.document.createElement('video');
  video.src = 'movies/Opening.mp4';
  context.NativeHost.media.loadVideoAsync = () =>
    Promise.reject(new Error('decode failed'));
  const playback = video.play();
  context.PMJS.tasks.drain();
  await assert.rejects(playback, /decode failed/);

  const emptyVideo = context.document.createElement('video');
  await assert.rejects(emptyVideo.play(), /No video source is available/);
});

test('video owner snapshots diagnostics and removes finished playback without exposing its list', async () => {
  const { context } = makeHarness();
  const video = context.document.createElement('video');
  video.src = 'movies/Opening.mp4';
  context.PMJS.tasks.drain();
  await Promise.resolve();
  await video.play();
  assert.equal(context.nativeVideos, undefined);
  const snapshot = context.PMJS.web.video.diagnostics();
  assert.deepEqual(Object.assign({}, snapshot[0]), {
    media: 10, image: 510, readyState: video.readyState, paused: false,
  });
  snapshot[0].paused = true;
  snapshot.length = 0;
  assert.equal(context.PMJS.web.video.diagnostics()[0].paused, false);
  assert.equal(context.PMJS.web.video.update(), 1);
  video._startedAt = -12000;
  assert.equal(context.PMJS.web.video.update(), 0);
  assert.equal(video.ended, true);
});

test('video owner keeps a same-source replay started by its ended handler', async () => {
  const { context, calls } = makeHarness();
  const video = context.document.createElement('video');
  video.src = 'movies/Opening.mp4';
  context.PMJS.tasks.drain();
  await Promise.resolve();
  await video.play();
  video.onended = () => { video.currentTime = 0; video.play(); };
  video._startedAt = -12000;
  assert.equal(context.PMJS.web.video.update(), 1);
  assert.equal(video.paused, false);
  context.PMJS.web.video.update();
  assert.equal(calls.updateVideo.at(-1)[0], 10);
});


test('video routes canvas and presentation separately without changing playback', async () => {
  const { context, calls } = makeHarness();
  context.NativeHost.media.videoCanvasImage = handle => handle + 900;
  const video = context.document.createElement('video');
  video.src = 'movies/Opening.mp4';
  context.PMJS.tasks.drain();
  await Promise.resolve();
  assert.deepEqual(calls.loadVideoProfiles, ['chromium65']);
  const presentation = video._pmjsNativePresentationSource();
  const canvas = video._pmjsNativeTextureSource();
  assert.equal(presentation.handle, 510);
  assert.equal(canvas.handle, 910);
  assert.equal(video._pmjsNativeTextureSource(), canvas);
  assert.equal(video._pmjsNativePresentationSource(), presentation);
  assert.equal(video.currentTime, 0);
  assert.equal(video.paused, true);
  video.src = '';
  assert.equal(video._pmjsNativeTextureSource(), null);
  assert.equal(video._pmjsNativePresentationSource(), null);
  assert.deepEqual(calls.releaseVideo, [10]);
});

test('video honours the explicit ordinary colour profile', async () => {
  const { context, calls } = makeHarness();
  context.PMJS.config = { videoColorProfile: 'ffmpeg' };
  const video = context.document.createElement('video');
  video.src = 'movies/Opening.mp4';
  context.PMJS.tasks.drain();
  await Promise.resolve();
  assert.deepEqual(calls.loadVideoProfiles, ['ffmpeg']);
});
