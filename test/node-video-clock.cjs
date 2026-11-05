'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setTimeout: delay } = require('node:timers/promises');
const native = require(path.resolve(process.argv[2]));

function shortAudio() {
  const bytes = Buffer.alloc(44 + 480 * 4);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(192000, 28);
  bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

async function main() {
  native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 32, height: 32,
    windowTitle: 'video clock' });
  native.images.memory();
  const beforeImages = native.images.memory();
  const beforeAudio = native.media.audioStats();
  const resource = await native.media.loadVideoAsync('fixture-video.mp4');
  if (resource.audio) native.media.releaseAudio(resource.audio);
  const audio = native.media.loadAudioBytes(shortAudio());
  assert.ok(resource.duration > audio.duration * 4);
  let now = 0;
  const calls = [], targets = [];
  const context = {
    NativeHost: { media: { ...native.media,
      playAudio(handle, loop, time) {
        calls.push({ loop, time });
        return native.media.playAudio(handle, loop, time);
      },
      updateVideo(handle, time) {
        targets.push(time);
        return native.media.updateVideo(handle, time);
      },
    } },
    performance: { now: () => now },
    GenericElement: require('./helpers/video-element-stub.cjs').GenericElement,
    EventTarget: { defineEventHandlerProperty() {} },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,
    '../js/pmjs-web/video-element.js'), 'utf8'), context);
  const video = new context.VideoElement();
  video._media = { handle: resource.handle };
  video._audio = { handle: audio.handle };
  video.duration = resource.duration;
  video.loop = true;
  let ended = 0;
  video.dispatchEvent = event => { if (event.type === 'ended') ++ended; };
  try {
    native.media.setAudioSuspended(audio.handle, true);
    await video.play();
    const seek = resource.duration / 2;
    video.currentTime = seek;
    assert.equal(native.media.audioIsPlaying(audio.handle), true);
    assert.equal(native.media.audioPosition(audio.handle), audio.duration);
    assert.equal(video.currentTime, seek, 'native clamp must not rewind the video');
    video._update();
    assert.equal(targets.at(-1), seek);
    video.pause();
    now = 1000;
    await video.play();
    assert.equal(video.currentTime, seek, 'silent-tail resume must preserve its anchor');
    native.media.setAudioSuspended(audio.handle, false);
    const deadline = performance.now() + 2000;
    while (native.media.audioIsPlaying(audio.handle) && performance.now() < deadline) await delay(10);
    assert.equal(native.media.audioIsPlaying(audio.handle), false, 'one-shot audio must reach EOF');
    now += 20;
    assert.ok(Math.abs(video.currentTime - seek - 0.02) < 1e-8);
    video.loop = false;
    video.currentTime = resource.duration;
    assert.equal(context.PMJS.web.video.update(), 0);
    assert.equal(video.ended, true);
    assert.equal(ended, 1);
    context.PMJS.web.video.update();
    assert.equal(ended, 1);
    assert.ok(calls.every(call => call.loop === false), 'video owns loop restarts');
  } finally { video._releaseMedia(); }
  assert.equal(native.images.memory().liveCount, beforeImages.liveCount);
  assert.equal(native.images.memory().gpuBytes, beforeImages.gpuBytes);
  assert.equal(native.media.audioStats().sampleVoices, beforeAudio.sampleVoices);
  assert.equal(native.media.audioStats().streamVoices, beforeAudio.streamVoices);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => { native.runtime.quit(); });
