'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(
  require('node:path').resolve(__dirname, '../js/pmjs-web/video-element.js'), 'utf8');
function near(a, b) {
  assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
}
function setup({duration = 2, audioDuration = 0.5, audio = true} = {}) {
  let now = 0, offset = 0, start = 0, rate = 1, playing = false, nativeLoop = false,
      suspended = false, eof = false;
  const calls = [], frames = [], events = [], listeners = new Map();
  function position() {
    const value = offset + (suspended ? 0 : (now - start) / 1000 * rate);
    return nativeLoop ? value % audioDuration : Math.min(value, audioDuration);
  }
  const media = {
    audioIsPlaying() {
      return playing && (suspended || nativeLoop || position() < audioDuration);
    },
    audioPosition: position,
    playAudio(handle, loop, time) {
      nativeLoop = loop;
      offset = loop ? time % audioDuration : Math.min(time, audioDuration);
      start = now;
      playing = true;
      calls.push({handle, loop, time});
      return true;
    },
    stopAudio() {
      playing = false;
    },
    setAudioParameters(handle, volume, newRate) {
      offset = position();
      start = now;
      rate = newRate;
    },
    updateVideo(handle, time) {
      frames.push(time);
      return time;
    },
    videoEnded() {
      return eof;
    },
    releaseVideo() {},
    releaseAudio() {
      playing = false;
    }
  };
  const context = {
    NativeHost: {media},
    performance: {now: () => now},
    GenericElement: require('./helpers/video-element-stub.cjs').GenericElement,
    EventTarget: {defineEventHandlerProperty() {}}
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const video = new context.VideoElement();
  video._media = {handle: 1};
  video._audio = audio ? {handle: 2} : null;
  video.duration = duration;
  video.dispatchEvent = event => {
    events.push(event.type);
    if (listeners.has(event.type)) listeners.get(event.type)(event);
  };
  return {
    video,
    calls,
    frames,
    events,
    context,
    at(ms) {
      now = ms;
    },
    suspend(value) {
      suspended = value;
    },
    eof(value) {
      eof = value;
    },
    on(type, fn) {
      listeners.set(type, fn);
    },
    update() {
      return context.PMJS.web.video.update();
    }
  };
}
test('looping startup sends one-shot native audio', async () => {
  const h = setup();
  h.video.loop = true;
  await h.video.play();
  assert.equal(h.calls[0].loop, false);
});
test('playing seek sends one-shot native audio', async () => {
  const h = setup();
  h.video.loop = true;
  await h.video.play();
  h.video.currentTime = 0.2;
  assert.equal(h.calls.at(-1).loop, false);
  near(h.calls.at(-1).time, 0.2);
});
test('short audio does not wrap the video clock before video duration', async () => {
  const h = setup();
  h.video.loop = true;
  await h.video.play();
  for (const ms of [100, 400, 600, 1100, 1900]) {
    h.at(ms);
    h.update();
  }
  near(h.frames.at(-1), 1.9);
  assert.equal(h.calls.length, 1);
});
test('loop false after startup ends at video duration exactly once', async () => {
  const h = setup();
  h.video.loop = true;
  await h.video.play();
  h.at(100);
  h.update();
  h.video.loop = false;
  h.at(2100);
  assert.equal(h.update(), 0);
  near(h.video.currentTime, 2);
  assert.equal(h.video.ended, true);
  h.update();
  assert.equal(h.events.filter(x => x === 'ended').length, 1);
});
test('loop true after startup restarts at video duration without ended', async () => {
  const h = setup();
  await h.video.play();
  h.video.loop = true;
  h.at(2100);
  assert.equal(h.update(), 1);
  near(h.calls.at(-1).time, 0.1);
  assert.equal(h.calls.at(-1).loop, false);
  assert.equal(h.events.filter(x => x === 'ended').length, 0);
  assert.equal(h.events.filter(x => x === 'play').length, 1);
});
test('known duration loop keeps overshoot modulo instead of audio modulo', async () => {
  const h = setup();
  h.video.loop = true;
  await h.video.play();
  h.at(6500);
  h.update();
  near(h.calls.at(-1).time, 0.5);
});
test(
  'longer audio is interrupted at video duration, not allowed to loop independently', async () => {
    const h = setup({audioDuration: 8});
    h.video.loop = true;
    await h.video.play();
    h.at(2100);
    h.update();
    near(h.video.currentTime, 0.1);
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls.every(c => !c.loop));
  });
test('audio-free looping still uses video modulo', async () => {
  const h = setup({audio: false});
  h.video.loop = true;
  await h.video.play();
  h.at(2100);
  h.update();
  near(h.video.currentTime, 0.1);
  assert.equal(h.calls.length, 0);
});
test('explicit backward seek replaces the previous cycle anchor', async () => {
  const h = setup();
  h.video.loop = true;
  await h.video.play();
  h.at(1400);
  h.update();
  h.video.currentTime = 0.2;
  near(h.video.currentTime, 0.2);
  h.at(1500);
  near(h.video.currentTime, 0.3);
});
test('looping seek beyond shorter audio retains anchor during native clamp', async () => {
  const h = setup();
  h.video.loop = true;
  await h.video.play();
  h.suspend(true);
  h.video.currentTime = 1.75;
  near(h.video.currentTime, 1.75);
  h.update();
  near(h.frames.at(-1), 1.75);
  h.suspend(false);
  h.at(20);
  near(h.video.currentTime, 1.77);
});
test('looping silent-tail pause/resume retains anchor during native clamp', async () => {
  const h = setup();
  h.video.loop = true;
  await h.video.play();
  h.at(1400);
  h.video.pause();
  near(h.video.currentTime, 1.4);
  h.at(9000);
  h.suspend(true);
  await h.video.play();
  near(h.video.currentTime, 1.4);
  h.update();
  near(h.frames.at(-1), 1.4);
  h.suspend(false);
  h.at(9100);
  near(h.video.currentTime, 1.5);
});
test('rate change in looping silent tail uses new slope without restarting audio', async () => {
  const h = setup();
  h.video.loop = true;
  await h.video.play();
  h.at(600);
  h.video.playbackRate = 2;
  h.at(1100);
  near(h.video.currentTime, 1.6);
  assert.equal(h.calls.length, 1);
});
test('unknown duration waits for native EOF even after shorter audio ends', async () => {
  const h = setup({duration: 0});
  h.video.loop = true;
  await h.video.play();
  h.at(1000);
  assert.equal(h.update(), 1);
  assert.equal(h.calls.length, 1);
  near(h.frames.at(-1), 1);
});
test('unknown duration restarts from zero only on native EOF', async () => {
  const h = setup({duration: 0});
  h.video.loop = true;
  await h.video.play();
  h.at(1000);
  h.eof(true);
  assert.equal(h.update(), 1);
  near(h.video.currentTime, 0);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls.at(-1).loop, false);
  assert.equal(h.events.includes('ended'), false);
  h.eof(false);
  h.at(1100);
  h.update();
  near(h.frames.at(-1), 0.1);
});
test('unknown duration loop disabled before EOF ends exactly once', async () => {
  const h = setup({duration: 0});
  h.video.loop = true;
  await h.video.play();
  h.at(1000);
  h.video.loop = false;
  h.eof(true);
  assert.equal(h.update(), 0);
  assert.equal(h.video.ended, true);
  h.update();
  assert.equal(h.events.filter(x => x === 'ended').length, 1);
});
test('ended callback replay remains registered and emits a new play once', async () => {
  const h = setup();
  h.video.loop = true;
  await h.video.play();
  h.video.loop = false;
  h.on('ended', () => h.video.play());
  h.at(2100);
  assert.equal(h.update(), 1);
  near(h.video.currentTime, 0);
  assert.equal(h.video.ended, false);
  assert.equal(h.events.filter(x => x === 'play').length, 2);
  assert.equal(h.calls.length, 2);
});
test('ended callback release removes resources and avoids future native work', async () => {
  const h = setup();
  await h.video.play();
  h.on('ended', () => h.video._releaseMedia());
  h.at(2100);
  assert.equal(h.update(), 0);
  assert.equal(h.video._media, null);
  assert.equal(h.update(), 0);
});
test(
  'repeated play while already playing does not restart audio or dispatch extra play', async () => {
    const h = setup();
    h.video.loop = true;
    await h.video.play();
    await h.video.play();
    assert.equal(h.calls.length, 1);
    assert.equal(h.events.filter(x => x === 'play').length, 1);
  });
