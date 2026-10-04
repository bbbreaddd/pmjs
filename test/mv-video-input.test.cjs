'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function makeHarness(withUnlockHook = true) {
  const calls = [];
  const context = vm.createContext({
    console, Utils: {}, PMJS: {},
    performance: { now: () => 1000 },
    CanvasContext2D: function CanvasContext2D() {},
    releaseNativeResource() {},
    trackNativeResource: resource => resource,
    NativeHost: {
      runtime: { env: () => '' },
      media: {
        loadVideoAsync(source) {
          calls.push(source);
          return Promise.resolve({ handle: 1, image: 2, width: 32,
            height: 24, duration: 1, audio: null });
        },
        releaseVideo() {},
        releaseAudio() {}
      }
    }
  });
  const modules = ['pmjs-core/methods.js', 'pmjs-web/scheduler.js',
    'pmjs-web/events.js', 'pmjs-web/elements.js'];
  if (withUnlockHook) modules.push('pmjs-mv/platform.js');
  for (const relative of modules) {
    const filename = path.resolve(__dirname, '../js', relative);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }
  context.Graphics = {
    _video: context.document.createElement('video'),
    _videoUnlocked: false,
    _isVideoVisible() { return this._video.style.opacity === 1; },
    _onTouchEnd() {
      if (!this._videoUnlocked) {
        this._video.play();
        this._videoUnlocked = true;
      }
      if (this._isVideoVisible() && this._video.paused) this._video.play();
    }
  };
  return { context, calls };
}

async function firstInputProbe(type) {
  const { context, calls } = makeHarness(process.argv[4] !== '--without-unlock-hook');
  context.PMJS.methods.install();
  const graphics = context.Graphics;
  context.document.addEventListener(type, graphics._onTouchEnd.bind(graphics));
  context.document.dispatchEvent({ type });
  // Let an ignored rejected play promise reach Node's strict rejection handling.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(graphics._videoUnlocked, true);
  assert.equal(graphics._video.paused, true);
  assert.deepEqual(calls, []);

  // The unlock shim must leave explicit failed requests and real decode errors intact.
  await assert.rejects(graphics._video.play(), /No video source is available/);
  const failedVideo = context.document.createElement('video');
  context.NativeHost.media.loadVideoAsync = () => Promise.reject(new Error('decode failed'));
  failedVideo.src = 'movies/missing.webm';
  const failedPlay = failedVideo.play();
  const errorEvents = [];
  failedVideo.addEventListener('error', event => errorEvents.push(event.error.message));
  context.PMJS.tasks.drain();
  await assert.rejects(failedPlay, /decode failed/);
  assert.deepEqual(errorEvents, ['decode failed']);
}

if (process.argv[2] === '--first-input-probe') {
  firstInputProbe(process.argv[3]).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  test('stock MV empty-video unlock reproduces the strict Node rejection', () => {
    const result = spawnSync(process.execPath,
      ['--unhandled-rejections=strict', __filename, '--first-input-probe',
        'keydown', '--without-unlock-hook'],
      { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No video source is available/);
  });

  for (const type of ['keydown', 'mousedown', 'touchend']) {
    test('MV first ' + type + ' survives an empty video under strict Node rejections', () => {
      const result = spawnSync(process.execPath,
        ['--unhandled-rejections=strict', __filename, '--first-input-probe', type],
        { encoding: 'utf8', timeout: 10000 });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    });
  }

  test('MV input unlock wraps the final guest handler and preserves visible-video resume', async () => {
    const { context } = makeHarness();
    const graphics = context.Graphics;
    const original = graphics._onTouchEnd;
    const events = [];
    graphics._onTouchEnd = function(event) {
      events.push(event);
      original.call(this, event);
      return 'guest result';
    };
    context.PMJS.methods.install();
    graphics._video.src = 'movies/opening.webm';
    context.PMJS.tasks.drain();
    await Promise.resolve();
    graphics._video.style.opacity = 1;
    const event = { type: 'keydown' };
    assert.equal(graphics._onTouchEnd(event), 'guest result');
    assert.equal(graphics._video.paused, false);
    assert.deepEqual(events, [event]);
    graphics._video.pause();
    graphics._videoUnlocked = false;
    graphics._onTouchEnd(event);
    assert.equal(graphics._video.paused, false);
  });
}
