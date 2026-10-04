'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const objectUrlSource = fs.readFileSync(
  path.resolve(__dirname, '../js/pmjs-web/object-urls.js'), 'utf8');
const audioSource = fs.readFileSync(
  path.resolve(__dirname, '../js/pmjs-rpgmaker/native-audio.js'), 'utf8');
const mzAudioSource = fs.readFileSync(
  path.resolve(__dirname, '../js/pmjs-mz/audio.js'), 'utf8');

function mediaStub() {
  const calls = { plays: 0, releases: [], fades: [], intents: [], parameters: [], pans: [] };
  return {
    calls,
    loadAudio: function(audioPath, options) {
      calls.intents.push(options.intent);
      return { handle: audioPath.length, duration: 2.5 };
    },
    loadAudioBytes: function() {
      return { handle: 29, duration: 1 };
    },
    playAudio: function() { calls.plays++; return true; },
    stopAudio: function() {},
    setAudioParameters: function(...args) { calls.parameters.push(args); },
    setAudioEqualPowerPan: function(...args) { calls.pans.push(args); },
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
  Request.prototype.open = function(_method, path) { this.path = path; };
  Request.prototype.send = function() {};
  const context = {
    console,
    Date,
    Blob,
    URL: function URL() {},
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
  vm.runInContext(objectUrlSource, context, { filename: 'pmjs-web/object-urls.js' });
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
  for (const folder of ['se/', 'bgs/', 'me/']) context.AudioManager.createBuffer(folder, 'tone');
  assert.deepEqual(context.NativeHost.media.calls.intents, ['music', 'effect', 'ambient', 'jingle']);
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
  assert.deepEqual(context.NativeHost.media.calls.fades.at(-1), [33, -1, 0, 1.5, false]);
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

test('MZ absolute gain automation keeps logical volume and avoids double scaling', () => {
  const context = contextFor();
  context.NativeHost.media.loadAudio = () => ({ handle: 33, duration: 9 });
  const buffer = context.playSe({ name: 'Cursor', volume: 80, pitch: 100, pan: 50 });
  const currentTime = context.WebAudio._currentTime();
  buffer._gainNode.gain.setValueAtTime(0.2, currentTime);
  buffer._gainNode.gain.linearRampToValueAtTime(0.8, currentTime + 0.1);
  assert.equal(buffer.volume, 0.8);
  assert.equal(buffer.isPlaying(), true);
  assert.deepEqual(context.NativeHost.media.calls.parameters.at(-1), [33, 1, 1, 0]);
  assert.deepEqual(context.NativeHost.media.calls.pans.at(-1), [33, 0.5]);
  const fades = context.NativeHost.media.calls.fades;
  assert.deepEqual(fades.at(-2), [33, 0.2, 0.2, 0, false]);
  assert.equal(fades.at(-1)[1], -1);
  assert.equal(fades.at(-1)[2], 0.8);
  assert.ok(Math.abs(fades.at(-1)[3] - 0.1) < 0.02);
  buffer._gainNode.gain.setValueAtTime(1.5, currentTime);
  assert.equal(buffer.volume, 0.8);
  assert.equal(fades.at(-1)[2], 1.5);
});

test('MZ fadeIn targets logical volume and replay recreates authored gain', () => {
  const context = contextFor();
  const buffer = context.playSe({ name: 'tone', volume: 40, pitch: 100, pan: -100 });
  buffer.fadeIn(2);
  assert.equal(context.NativeHost.media.calls.fades.at(-1)[2], 0.4);
  buffer.setValueAtTime(0.1, 0);
  buffer.stop();
  buffer.play(false, 0);
  assert.equal(context.NativeHost.media.calls.fades.at(-1)[2], 0.4);
});


test('MZ object URLs bypass encryption and notify listeners after queued playback', async () => {
  const context = contextFor({ encrypted: true });
  const events = [], loads = [];
  context.NativeHost.media.loadAudioBytes = (bytes, options) => {
    loads.push([Array.from(new Uint8Array(bytes)), options.resourceIdentity]);
    return { handle: 77, duration: 1 };
  };
  context.NativeHost.media.playAudio = (...args) => { events.push(['play', ...args]); return true; };
  const url = context.URL.createObjectURL(new Blob([Uint8Array.of(1, 2, 3)]));
  const audio = new context.WebAudio(url);
  audio.addLoadListener(() => events.push(['loaded']));
  audio.play(true, 0.5);
  assert.equal(audio.isPlaying(), true);
  assert.equal(audio.isReady(), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(loads, [[[1, 2, 3], url]]);
  assert.deepEqual(events, [['play', 77, true, 0.5], ['loaded']]);
  assert.equal(context.pendingRequests.length, 0);
  context.URL.revokeObjectURL(url);
  assert.equal(audio.isReady(), true);
  audio.clear();
  assert.deepEqual(context.NativeHost.media.calls.releases, [77]);
});

test('MZ clearing a pending object URL suppresses native decoding and callbacks', async () => {
  const context = contextFor({ encrypted: true });
  const unexpected = () => { throw new Error('cancelled source used'); };
  context.NativeHost.media.loadAudioBytes = unexpected;
  const url = context.URL.createObjectURL(new Blob([Uint8Array.of(1)]));
  const audio = new context.WebAudio(url);
  audio.addLoadListener(unexpected);
  audio.play(false, 0);
  audio.clear();
  audio.clear();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(audio.isReady(), false);
  assert.equal(audio.isPlaying(), false);
  assert.equal(audio.isError(), false);
  assert.equal(context.NativeHost.media.calls.plays, 0);
  assert.deepEqual(context.NativeHost.media.calls.releases, []);
  context.URL.revokeObjectURL(url);
});

test('MZ retry ignores superseded encrypted loads and clear invalidates the replacement', () => {
  const context = contextFor({ encrypted: true });
  const loads = [], events = [];
  context.NativeHost.media.loadAudioBytes = (_bytes, options) => {
    loads.push(options.resourcePath);
    return { handle: 77, duration: 1 };
  };
  const audio = context.playSe({ name: 'Town Bell', volume: 80, pitch: 100, pan: 0 });
  audio.addLoadListener(() => events.push('loaded'));
  audio.retry();
  assert.equal(audio.isPlaying(), true);
  assert.equal(context.pendingRequests[0].path, 'audio/se/Town Bell.ogg_');
  context.pendingRequests[0].onload();
  context.pendingRequests[0].status = 400;
  context.pendingRequests[0].onload();
  assert.equal(audio.isError(), false);
  assert.equal(audio.isReady(), false);
  assert.deepEqual(loads, []);
  context.pendingRequests[1].onload();
  assert.deepEqual(loads, ['audio/se/Town Bell.ogg_']);
  assert.deepEqual(events, ['loaded']);
  assert.equal(context.NativeHost.media.calls.plays, 1);
  audio.retry();
  audio.clear();
  context.pendingRequests[2].onload();
  assert.equal(loads.length, 1);
  assert.equal(audio.isPlaying(), false);
  assert.equal(audio.isReady(), false);
  assert.deepEqual(context.NativeHost.media.calls.releases, [77]);
});

test('MZ repeated clear resets parameters without releasing an independent voice', () => {
  const context = contextFor();
  let nextHandle = 10;
  context.NativeHost.media.loadAudio = () => ({ handle: nextHandle++, duration: 4 });
  const first = context.playSe({ name: 'First', volume: 40, pitch: 120, pan: 50 });
  const second = context.playSe({ name: 'Second', volume: 80, pitch: 100, pan: 0 });
  let stops = 0;
  first.addStopListener(() => stops++);
  first.clear();
  first.clear();
  assert.equal(stops, 1);
  assert.deepEqual([first.volume, first.pitch, first.pan], [1, 1, 0]);
  assert.equal(first.isReady(), false);
  assert.equal(first.isPlaying(), false);
  assert.deepEqual(context.NativeHost.media.calls.releases, [10]);
  assert.equal(second.isReady(), true);
  assert.equal(second.isPlaying(), true);
  second.pitch = 1.2;
  assert.equal(context.NativeHost.media.calls.plays, 3, 'a changed pitch restarts active playback');
});
