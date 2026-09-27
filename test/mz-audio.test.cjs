'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const audioSource = fs.readFileSync(
  path.resolve(__dirname, '../js/pmjs-rpgmaker/native-audio.js'), 'utf8');
const mzAudioSource = fs.readFileSync(
  path.resolve(__dirname, '../js/pmjs-mz/audio.js'), 'utf8');

function mediaStub() {
  const calls = { plays: 0, releases: [], fades: [] };
  return {
    calls,
    loadAudio: function(audioPath) {
      return { handle: audioPath.length, duration: 2.5 };
    },
    loadAudioBytes: function() {
      return { handle: 29, duration: 1 };
    },
    playAudio: function() { calls.plays++; return true; },
    stopAudio: function() {},
    setAudioParameters: function() {},
    audioIsPlaying: function() { return true; },
    audioPosition: function() { return 0; },
    releaseAudio: function(handle) { calls.releases.push(handle); },
    fadeAudio: function(handle, from, to, duration, stop) {
      calls.fades.push([handle, from, to, duration, stop]);
    }
  };
}

function contextFor(options) {
  const opts = options || {};
  const pendingRequests = [];
  function Request() {
    this.status = opts.requestStatus || 200;
    this.response = new ArrayBuffer(8);
    pendingRequests.push(this);
  }
  Request.prototype.open = function() {};
  Request.prototype.send = function() {};
  const context = {
    console,
    Date,
    gamePath: function(value) { return value; },
    Graphics: { frameCount: 42 },
    Utils: {
      encodeURI: function(name) { return encodeURI(name); },
      hasEncryptedAudio: function() { return !!opts.encrypted; },
      decryptArrayBuffer: function(buffer) { return buffer; }
    },
    AudioManager: {
      _path: 'audio/',
      _seVolume: 100,
      audioFileExt: function() { return '.ogg'; },
      updateSeParameters: function(buffer, se) {
        buffer.volume = se.volume / 100;
        buffer.pitch = se.pitch / 100;
        buffer.pan = (se.pan || 0) / 100;
      }
    },
    SceneManager: {},
    XMLHttpRequest: Request,
    NativeHost: { media: mediaStub() }
  };
  vm.createContext(context);
  vm.runInContext(audioSource, context, { filename: 'pmjs-rpgmaker/native-audio.js' });
  vm.runInContext(mzAudioSource, context, { filename: 'pmjs-mz/audio.js' });
  context.pendingRequests = pendingRequests;
  context.playSe = function(se) {
    const buffer = context.AudioManager.createBuffer('se/', se.name);
    context.AudioManager.updateSeParameters(buffer, se);
    buffer.play(false);
    return buffer;
  };
  context.cleanupSe = function(buffers) {
    for (const buffer of buffers) {
      if (!buffer.isPlaying()) buffer.destroy();
    }
    return buffers.filter(buffer => buffer.isPlaying());
  };
  return context;
}

test('MZ wiring composes a voice behind MZ WebAudio semantics', () => {
  const context = contextFor();
  assert.equal(context.WebAudio.name, 'MzNativeWebAudio');
  const buffer = context.AudioManager.createBuffer('bgm/', 'Town Theme');
  assert.ok(buffer instanceof context.WebAudio);
  assert.equal(buffer.name, 'Town Theme');
  assert.equal(buffer.frameCount, 42);
  assert.equal(buffer.url, 'audio/bgm/Town%20Theme.ogg');
  assert.equal(typeof buffer.destroy, 'function');
  assert.equal(typeof buffer.retry, 'function');
  assert.ok(Number.isFinite(context.WebAudio._currentTime()));
  assert.equal(context.SceneManager.initAudio(), undefined);
});

test('MZ play-before-load reports logical playback immediately', () => {
  const context = contextFor({ encrypted: true });
  const buffer = context.playSe({ name: 'Hit', volume: 90, pitch: 100, pan: 0 });
  assert.equal(buffer.isPlaying(), true);
  assert.equal(context.NativeHost.media.calls.plays, 0);
});

test('MZ encrypted SE survives cleanupSe and plays after decryption', () => {
  const context = contextFor({ encrypted: true });
  const buffer = context.playSe({ name: 'Hit', volume: 90, pitch: 100, pan: 0 });
  const survivors = context.cleanupSe([buffer]);
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0], buffer);
  assert.equal(context.pendingRequests.length, 1);
  context.pendingRequests[0].onload();
  assert.equal(buffer.isPlaying(), true);
  assert.equal(context.NativeHost.media.calls.plays, 1);
});

test('MZ stop-before-load prevents later playback', () => {
  const context = contextFor({ encrypted: true });
  const buffer = context.playSe({ name: 'Hit', volume: 90, pitch: 100, pan: 0 });
  let stops = 0;
  buffer.addStopListener(() => { stops++; });
  buffer.stop();
  assert.equal(buffer.isPlaying(), false);
  assert.equal(stops, 1);
  context.pendingRequests[0].onload();
  assert.equal(context.NativeHost.media.calls.plays, 0);
  assert.equal(buffer.isPlaying(), false);
});

test('MZ fadeOut clears logical playback while the native fade runs on', () => {
  const context = contextFor();
  context.NativeHost.media.loadAudio = () => ({ handle: 33, duration: 9 });
  const buffer = context.playSe({ name: 'Hit', volume: 90, pitch: 100, pan: 0 });
  assert.equal(buffer.isPlaying(), true);
  buffer.fadeOut(1.5);
  assert.equal(buffer.isPlaying(), false);
  assert.deepEqual(context.NativeHost.media.calls.fades,
    [[33, -1, 0, 1.5, false]]);
});

test('MZ failed load keeps logical playback across poll and retry', () => {
  const context = contextFor({ encrypted: true });
  const buffer = context.playSe({ name: 'Hit', volume: 90, pitch: 100, pan: 0 });
  assert.equal(buffer.isPlaying(), true);
  context.pendingRequests[0].status = 400;
  context.pendingRequests[0].onload();
  assert.equal(buffer.isError(), true);
  assert.equal(buffer._poll(), true);
  assert.equal(buffer.isPlaying(), true);
  buffer.retry();
  context.pendingRequests[1].onload();
  assert.equal(buffer.isError(), false);
  assert.equal(buffer.isPlaying(), true);
  assert.equal(context.NativeHost.media.calls.plays, 1);
});

test('MZ faded voice fires its stop listener at natural end', () => {
  const context = contextFor();
  let playing = true;
  context.NativeHost.media.audioIsPlaying = () => playing;
  context.NativeHost.media.loadAudio = () => ({ handle: 33, duration: 9 });
  const buffer = context.playSe({ name: 'Hit', volume: 90, pitch: 100, pan: 0 });
  let resumed = 0;
  buffer.addStopListener(() => { resumed++; });
  buffer.fadeOut(1.5);
  assert.equal(buffer.isPlaying(), false);
  assert.equal(buffer._poll(), true);
  playing = false;
  assert.equal(buffer._poll(), false);
  assert.equal(resumed, 1);
  assert.equal(buffer.isPlaying(), false);
});

test('MZ retry releases the stale handle before reloading', () => {
  const context = contextFor();
  let nextHandle = 1000;
  context.NativeHost.media.loadAudio = () => ({ handle: nextHandle++, duration: 1 });
  const buffer = context.playSe({ name: 'Hit', volume: 90, pitch: 100, pan: 0 });
  buffer.retry();
  assert.deepEqual(context.NativeHost.media.calls.releases, [1000]);
  assert.equal(buffer.isPlaying(), true);
  assert.equal(context.NativeHost.media.calls.plays, 2);
});

test('MZ clear releases state back to stock defaults', () => {
  const context = contextFor({ encrypted: true, requestStatus: 400 });
  context.NativeHost.media.loadAudio = () => ({ handle: 33, duration: 9 });
  const buffer = context.playSe({ name: 'Hit', volume: 50, pitch: 120, pan: 20 });
  context.pendingRequests[0].onload();
  assert.equal(buffer.isError(), true);
  let stops = 0;
  buffer.addStopListener(() => { stops++; });
  buffer.clear();
  assert.equal(stops, 1);
  assert.equal(buffer.isPlaying(), false);
  assert.equal(buffer.isError(), false);
  assert.deepEqual(context.NativeHost.media.calls.releases, []);
  assert.equal(buffer.volume, 1);
  assert.equal(buffer.pitch, 1);
  assert.equal(buffer.pan, 0);
  assert.equal(buffer._loadListeners.length, 0);
  assert.equal(buffer._stopListeners.length, 0);
});

test('MZ master volume mirrors through the engine-visible field', () => {
  const context = contextFor();
  let hosted = null;
  context.NativeHost.media.setMasterVolume = (value) => { hosted = value; };
  context.WebAudio._masterVolume = 0.5;
  assert.equal(context.WebAudio._masterVolume, 0.5);
  assert.equal(hosted, 0.5);
  context.WebAudio.setMasterVolume(
    Math.min(context.WebAudio._masterVolume + 0.25, 1));
  assert.equal(context.WebAudio._masterVolume, 0.75);
});

test('MUSH volumeTransition drives the facade gain automation', () => {
  const context = contextFor();
  context.NativeHost.media.loadAudio = () => ({ handle: 33, duration: 9 });
  vm.runInContext(
    'WebAudio.prototype.volumeTransition = function(startVolume, endVolume, time) {' +
    'if (this.isReady()) {' +
    'if (this._gainNode) {' +
    'const gain = this._gainNode.gain;' +
    'const currentTime = WebAudio._currentTime();' +
    'gain.setValueAtTime(startVolume, currentTime);' +
    'gain.linearRampToValueAtTime(endVolume, currentTime + time);' +
    '} } else {' +
    'this.addLoadListener(() => this.volumeTransition(startVolume, endVolume, time));' +
    '} };', context);
  const buffer = context.playSe({ name: 'Cursor', volume: 90, pitch: 100, pan: 0 });
  buffer.volumeTransition(0.9, 0.5, 0.1);
  assert.equal(buffer.isPlaying(), true);
  assert.equal(buffer.volume, 0.9);
  const fades = context.NativeHost.media.calls.fades;
  assert.equal(fades.length, 1);
  assert.equal(fades[0][0], 33);
  assert.equal(fades[0][1], -1);
  assert.equal(fades[0][2], 0.5);
  assert.equal(fades[0][4], false);
  assert.ok(fades[0][3] >= 0 && fades[0][3] <= 0.5);
});
