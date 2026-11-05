'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(
  require('node:path').resolve(__dirname, '../js/pmjs-web/video-element.js'), 'utf8');

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
}
function setup({audioDuration = 4, duration = 6, audio = true} = {}) {
  let now = 0, position = 0, playing = false, canPlay = true;
  let eof = false, releasedAudio = false, releasedVideo = false;
  const calls = [], listeners = new Map();
  const context = {
    performance: {now: () => now},
    GenericElement: require('./helpers/video-element-stub.cjs').GenericElement,
    EventTarget: {defineEventHandlerProperty() {}},
    NativeHost: {
      media: {
        audioIsPlaying() {
          assert.ok(!releasedAudio);
          return playing;
        },
        audioPosition() {
          assert.ok(!releasedAudio);
          return position;
        },
        playAudio(handle, loop, time) {
          assert.ok(!releasedAudio);
          // Mirrors MediaService::play: clamp to audio duration while playing remains
          // true until the mixer/decoder observes EOF, even at/beyond that duration.
          position = Math.max(0, Math.min(loop ? time % audioDuration : time, audioDuration));
          playing = canPlay;
          calls.push(['play', handle, loop, time, position]);
          return canPlay;
        },
        setAudioParameters(...args) {
          assert.ok(!releasedAudio);
          calls.push(['params', ...args]);
        },
        stopAudio(handle) {
          assert.ok(!releasedAudio);
          playing = false;
          calls.push(['stop', handle]);
        },
        updateVideo(handle, time) {
          assert.ok(!releasedVideo);
          calls.push(['frame', handle, time]);
          return time;
        },
        videoEnded() {
          assert.ok(!releasedVideo);
          return eof;
        },
        releaseVideo(handle) {
          assert.ok(!releasedVideo);
          releasedVideo = true;
          calls.push(['releaseVideo', handle]);
        },
        releaseAudio(handle) {
          assert.ok(!releasedAudio);
          releasedAudio = true;
          playing = false;
          calls.push(['releaseAudio', handle]);
        }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const video = new context.VideoElement();
  video._media = {handle: 1};
  video._audio = audio ? {handle: 2} : null;
  video.duration = duration;
  video.dispatchEvent = event => {
    calls.push(['event', event.type]);
    const listener = listeners.get(event.type);
    if (listener) listener(event);
  };
  return {
    video,
    calls,
    context,
    on(type, fn) {
      listeners.set(type, fn);
    },
    state(timeMs, audioPosition = position, audioPlaying = playing) {
      now = timeMs;
      position = audioPosition;
      playing = audioPlaying;
    },
    setEof(value) {
      eof = value;
    },
    setCanPlay(value) {
      canPlay = value;
    },
    update() {
      return context.PMJS.web.video.update();
    },
    async start() {
      await video.play();
    }
  };
}

test('seeking beyond shorter audio EOF retains the requested fallback position', async () => {
  const h = setup();
  await h.start();
  h.state(1000, 1.1, true);
  near(h.video.currentTime, 1.1);
  h.video.currentTime = 5;
  // Do not expose the native audio's clamped time as the video time.
  near(h.video.currentTime, 5);
  h.state(1020, 4, false);
  near(h.video.currentTime, 5.02);
});

test('pause and resume in a silent tail does not permanently rewind to audio EOF', async () => {
  const h = setup();
  await h.start();
  h.state(3900, 3.9, true);
  near(h.video.currentTime, 3.9);
  h.state(5000, 4, false);
  h.video.pause();
  near(h.video.currentTime, 5);
  h.state(10000, 4, false);
  await h.video.play();
  near(h.video.currentTime, 5);
  h.state(10010, 4, false);
  near(h.video.currentTime, 5.01);
});

test(
  'fractional seek below one audio sample does not replace the requested fallback offset',
  async () => {
    const h = setup();
    await h.start();
    h.state(10, 0, true);
    h.video.currentTime = 1.00001;
    h.state(10, 1, true);
    near(h.video.currentTime, 1.00001);
    h.state(30, 1, false);
    near(h.video.currentTime, 1.02001);
  });

test('pause after an early audio stop freezes the audio-anchored fallback', async () => {
  const h = setup();
  await h.start();
  h.state(1000, 1.7, true);
  near(h.video.currentTime, 1.7);
  h.state(1020, 1.7, false);
  h.video.pause();
  near(h.video.currentTime, 1.72);
  h.state(2000, 1.7, false);
  near(h.video.currentTime, 1.72);
  await h.video.play();
  near(h.video.currentTime, 1.72);
  h.state(2020, 1.72, false);
  near(h.video.currentTime, 1.74);
});

test('rate changes immediately after early stop preserve audio anchor and new slope', async () => {
  const h = setup();
  await h.start();
  h.state(1000, 1.3, true);
  near(h.video.currentTime, 1.3);
  h.state(1020, 1.3, false);
  h.video.playbackRate = 2;
  near(h.video.currentTime, 1.32);
  h.state(1220, 1.3, false);
  near(h.video.currentTime, 1.72);
  h.video.pause();
  h.video.playbackRate = 0.5;
  h.state(5000, 1.3, false);
  near(h.video.currentTime, 1.72);
  await h.video.play();
  near(h.video.currentTime, 1.72);
  h.state(5200, 1.72, false);
  near(h.video.currentTime, 1.82);
});

test('explicit backward seek after fallback still replaces the audio anchor', async () => {
  const h = setup();
  await h.start();
  h.state(1000, 3, true);
  near(h.video.currentTime, 3);
  h.state(1050, 3, false);
  near(h.video.currentTime, 3.05);
  h.video.currentTime = 0.75;
  near(h.video.currentTime, 0.75);
  h.state(1100, 0.75, false);
  near(h.video.currentTime, 0.8);
});

test('short one-shot audio cannot loop the video before its own cycle ends', async () => {
  const h = setup();
  h.video.loop = true;
  await h.start();
  h.state(3900, 3.99, true);
  near(h.video.currentTime, 3.99);
  h.state(4100, 4, false);
  h.update();
  near(h.video.currentTime, 4.19);
  assert.equal(h.calls.filter(call => call[0] === 'play').length, 1);
  h.state(6000, 4, false);
  assert.equal(h.update(), 1);
  near(h.video.currentTime, 0.09);
  const plays = h.calls.filter(call => call[0] === 'play');
  assert.equal(plays.length, 2);
  assert.ok(plays.every(call => call[2] === false));
  near(plays[1][3], 0.09);
  assert.equal(h.calls.filter(call => call[0] === 'event' && call[1] === 'ended').length, 0);
});

test(
  'fallback video-duration loop does not emit ended and restarts audio at modulo time',
  async () => {
    const h = setup({duration: 6, audioDuration: 8});
    h.video.loop = true;
    await h.start();
    h.state(5800, 5.9, true);
    near(h.video.currentTime, 5.9);
    h.state(6000, 5.9, false);
    assert.equal(h.update(), 1);
    near(h.video.currentTime, 0.1);
    assert.equal(h.video.ended, false);
    assert.equal(h.calls.filter(call => call[0] === 'event' && call[1] === 'ended').length, 0);
    near(h.calls.filter(call => call[0] === 'play').at(-1)[3], 0.1);
  });

test('near-duration handoff emits ended exactly once and removes active video', async () => {
  const h = setup({duration: 4});
  await h.start();
  h.state(3800, 3.98, true);
  h.update();
  h.state(3820, 4, false);
  assert.equal(h.update(), 0);
  assert.equal(h.video.ended, true);
  assert.equal(h.video.paused, true);
  near(h.video.currentTime, 4);
  h.state(10000, 4, false);
  assert.equal(h.update(), 0);
  assert.equal(h.calls.filter(call => call[0] === 'event' && call[1] === 'ended').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'stop').length, 1);
});

test('ended handler replay survives registry update and uses fresh zero clock', async () => {
  const h = setup({duration: 4});
  await h.start();
  h.on('ended', () => {
    h.video.play();
  });
  h.state(3800, 3.98, true);
  h.update();
  h.state(3820, 4, false);
  assert.equal(h.update(), 1);
  assert.equal(h.video.paused, false);
  assert.equal(h.video.ended, false);
  near(h.video.currentTime, 0);
  h.state(3840, 0, false);
  near(h.video.currentTime, 0.02);
  assert.equal(h.update(), 1);
});

test(
  'release inside ended handler removes resources once without later native access', async () => {
    const h = setup({duration: 4});
    await h.start();
    h.on('ended', () => h.video._releaseMedia());
    h.state(3800, 3.98, true);
    h.update();
    h.state(3820, 4, false);
    assert.equal(h.update(), 0);
    near(h.video.currentTime, 0);
    assert.equal(h.update(), 0);
    assert.equal(h.calls.filter(call => call[0] === 'releaseVideo').length, 1);
    assert.equal(h.calls.filter(call => call[0] === 'releaseAudio').length, 1);
  });

test('unknown duration waits for native EOF after audio stop', async () => {
  const h = setup({duration: 0});
  await h.start();
  h.state(1000, 1.2, true);
  h.update();
  h.state(1100, 1.2, false);
  assert.equal(h.update(), 1);
  assert.equal(h.video.ended, false);
  h.setEof(true);
  h.state(1200, 1.2, false);
  assert.equal(h.update(), 0);
  near(h.video.currentTime, 1.4);
  assert.equal(h.video.ended, true);
});

test(
  'no audio and unavailable audio device retain ordinary time, rate, seek, and pause semantics',
  async () => {
    for (const hasAudio of [false, true]) {
      const h = setup({audio: hasAudio});
      h.setCanPlay(false);
      await h.start();
      h.state(1000, 0, false);
      near(h.video.currentTime, 1);
      h.video.playbackRate = 2;
      h.state(1250, 0, false);
      near(h.video.currentTime, 1.5);
      h.video.currentTime = 0.5;
      h.state(1500, 0, false);
      near(h.video.currentTime, 1);
      h.video.pause();
      h.state(5000, 0, false);
      near(h.video.currentTime, 1);
      await h.video.play();
      h.state(5250, 0, false);
      near(h.video.currentTime, 1.5);
    }
  });

test(
  'audio stopping between isPlaying and position keeps final native sample as anchor', async () => {
    const h = setup();
    await h.start();
    h.state(1000, 1.1, true);
    const original = h.context.NativeHost.media.audioIsPlaying;
    h.context.NativeHost.media.audioIsPlaying = () => {
      const result = original();
      h.state(1000, 1.2, false);
      return result;
    };
    near(h.video.currentTime, 1.2);
    h.context.NativeHost.media.audioIsPlaying = original;
    h.state(1020, 1.2, false);
    near(h.video.currentTime, 1.22);
  });


test('delayed native start after rounded seek does not hand back a lower clock', async () => {
  const h = setup({audioDuration: 8});
  await h.start();
  h.video.currentTime = 5.00001;
  h.state(0, 5, true);
  const immediate = h.video.currentTime;
  h.state(50, 5, true);
  const waiting = h.video.currentTime;
  h.state(70, 5.02, true);
  const restarted = h.video.currentTime;
  assert.ok(waiting >= immediate, `${waiting} < ${immediate}`);
  assert.ok(restarted >= waiting, `audio restart rewound ${waiting} to ${restarted}`);
});

test(
  'rate change during native clamped hold retains requested seek and new fallback slope',
  async () => {
    const h = setup();
    await h.start();
    h.video.currentTime = 5;
    near(h.video.currentTime, 5);
    h.state(50, 4, true);
    h.video.playbackRate = 2;
    near(h.video.currentTime, 5);
    h.state(100, 4, false);
    near(h.video.currentTime, 5.1);
  });

test(
  'immediate update after a forward seek in the silent tail does not target an earlier frame',
  async () => {
    const h = setup();
    await h.start();
    h.state(5000, 4, false);
    h.update();
    near(h.calls.filter(call => call[0] === 'frame').at(-1)[2], 5);
    h.video.currentTime = 5.5;
    h.update();
    near(h.calls.filter(call => call[0] === 'frame').at(-1)[2], 5.5);
    h.state(5020, 4, false);
    h.update();
    near(h.calls.filter(call => call[0] === 'frame').at(-1)[2], 5.52);
  });

test(
  'explicit seek to video end ends once even while shorter native audio is clamped and playing',
  async () => {
    const h = setup();
    await h.start();
    h.video.currentTime = 6;
    assert.equal(h.update(), 0);
    assert.equal(h.video.ended, true);
    near(h.video.currentTime, 6);
    assert.equal(h.calls.filter(call => call[0] === 'event' && call[1] === 'ended').length, 1);
    assert.equal(h.update(), 0);
  });


test(
  'loop=true seeks beyond shorter audio hold requested video time during and after clamp',
  async () => {
    const h = setup();
    h.video.loop = true;
    await h.start();
    h.state(1000, 1.1, true);
    h.update();
    h.video.currentTime = 5;
    near(h.video.currentTime, 5);
    h.update();
    near(h.calls.filter(call => call[0] === 'frame').at(-1)[2], 5);
    assert.equal(h.calls.filter(call => call[0] === 'play').at(-1)[2], false);
    h.state(1020, 4, false);
    near(h.video.currentTime, 5.02);
  });

test(
  'loop=true pause/resume in silent tail does not restore native looping or rewind', async () => {
    const h = setup();
    h.video.loop = true;
    await h.start();
    h.state(5000, 4, false);
    h.video.pause();
    near(h.video.currentTime, 5);
    h.state(10000, 4, false);
    await h.video.play();
    near(h.video.currentTime, 5);
    h.update();
    near(h.calls.filter(call => call[0] === 'frame').at(-1)[2], 5);
    h.state(10020, 4, false);
    near(h.video.currentTime, 5.02);
    assert.ok(h.calls.filter(call => call[0] === 'play').every(call => call[2] === false));
  });

test(
  'turning loop off during playback ends at video duration, not shorter audio duration',
  async () => {
    const h = setup();
    h.video.loop = true;
    await h.start();
    h.state(2000, 2, true);
    h.update();
    h.video.loop = false;
    h.state(4000, 4, false);
    assert.equal(h.update(), 1);
    h.state(6000, 4, false);
    assert.equal(h.update(), 0);
    assert.equal(h.video.ended, true);
    near(h.video.currentTime, 6);
    assert.equal(h.calls.filter(call => call[0] === 'play').length, 1);
    assert.equal(h.calls.filter(call => call[0] === 'event' && call[1] === 'ended').length, 1);
  });

test('turning loop on after short audio ends restarts exactly once at video boundary', async () => {
  const h = setup();
  await h.start();
  h.state(4000, 4, false);
  h.update();
  h.video.loop = true;
  h.state(6200, 4, false);
  assert.equal(h.update(), 1);
  near(h.video.currentTime, 0.2);
  const plays = h.calls.filter(call => call[0] === 'play');
  assert.equal(plays.length, 2);
  near(plays[1][3], 0.2);
  assert.equal(plays[1][2], false);
  assert.equal(h.calls.filter(call => call[0] === 'event' && call[1] === 'play').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'event' && call[1] === 'ended').length, 0);
});

test('longer audio restarts only when video duration ends and uses video modulo', async () => {
  const h = setup({duration: 3, audioDuration: 8});
  h.video.loop = true;
  await h.start();
  h.state(3050, 3.05, true);
  assert.equal(h.update(), 1);
  near(h.video.currentTime, 0.05);
  const plays = h.calls.filter(call => call[0] === 'play');
  assert.equal(plays.length, 2);
  near(plays[1][3], 0.05);
  assert.equal(plays[1][2], false);
});

test('unknown-duration video owns EOF restart, and clearing loop ends the next cycle', async () => {
  const h = setup({duration: 0});
  h.video.loop = true;
  await h.start();
  h.state(5000, 4, false);
  assert.equal(h.update(), 1);
  assert.equal(h.calls.filter(call => call[0] === 'play').length, 1);
  h.setEof(true);
  h.state(5500, 4, false);
  assert.equal(h.update(), 1);
  near(h.video.currentTime, 0);
  assert.equal(h.video._decodedTime, undefined);
  const plays = h.calls.filter(call => call[0] === 'play');
  assert.equal(plays.length, 2);
  assert.equal(plays[1][2], false);
  h.setEof(false);
  h.state(5600, 0.1, true);
  assert.equal(h.update(), 1);
  h.video.loop = false;
  h.setEof(true);
  h.state(6000, 0.5, true);
  assert.equal(h.update(), 0);
  assert.equal(h.video.ended, true);
  assert.equal(h.calls.filter(call => call[0] === 'event' && call[1] === 'ended').length, 1);
});

test('overshoot across several video cycles uses video modulo even beyond audio EOF', async () => {
  const h = setup();
  h.video.loop = true;
  await h.start();
  h.video.currentTime = 20;
  near(h.video.currentTime, 20);
  h.update();
  near(h.video.currentTime, 2);
  const plays = h.calls.filter(call => call[0] === 'play');
  near(plays.at(-1)[3], 2);
  assert.ok(plays.every(call => call[2] === false));
});

test('audio-free video cycles and loop-off end retain prior wall-clock semantics', async () => {
  const h = setup({audio: false});
  h.video.loop = true;
  await h.start();
  h.state(6200);
  assert.equal(h.update(), 1);
  near(h.video.currentTime, 0.2);
  h.video.loop = false;
  h.state(12000);
  assert.equal(h.update(), 0);
  assert.equal(h.video.ended, true);
  near(h.video.currentTime, 6);
  assert.equal(h.calls.filter(call => call[0] === 'play').length, 0);
});
