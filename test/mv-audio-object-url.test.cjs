'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const objectUrlSource = fs.readFileSync(
  path.resolve(__dirname, '../js/pmjs-web/object-urls.js'), 'utf8');
const audioSource = fs.readFileSync(
  path.resolve(__dirname, '../js/pmjs-rpgmaker/native-audio.js'), 'utf8');
const mvAudioSource = fs.readFileSync(
  path.resolve(__dirname, '../js/pmjs-mv/audio.js'), 'utf8');
const mainLoopSource = fs.readFileSync(
  path.resolve(__dirname, '../js/pmjs-rpgmaker/main-loop.js'), 'utf8');

function contextFor(decrypter, XMLHttpRequest) {
  const loadedBytes = [];
  const loadedOptions = [];
  const released = [];
  const context = {
    Blob,
    URL: function URL() {},
    console,
    Date,
    AudioManager: { _path: 'audio/', audioFileExt: function() { return '.ogg'; } },
    SceneManager: {},
    Decrypter: decrypter,
    XMLHttpRequest,
    gamePath: function(value) { return value; },
    NativeHost: {
      media: {
        loadAudio: function() { throw new Error('path loader used'); },
        loadAudioBytes: function(buffer, options) {
          loadedOptions.push(options);
          loadedBytes.push(new Uint8Array(buffer));
          return { handle: loadedBytes.length, duration: 1.5 };
        },
        playAudio: function() { return true; },
        stopAudio: function() {},
        setAudioParameters: function() {},
        audioIsPlaying: function() { return false; },
        releaseAudio: function(handle) { released.push(handle); },
        setMasterVolume: function() {}
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(objectUrlSource, context);
  vm.runInContext(audioSource, context);
  vm.runInContext(mvAudioSource, context);
  context.loadedBytes = loadedBytes;
  context.loadedOptions = loadedOptions;
  context.released = released;
  return context;
}

function settle() {
  return new Promise(resolve => setImmediate(resolve));
}

test('MV WebAudio consumes a PMJS object URL and queues early playback', async () => {
  const context = contextFor({ hasEncryptedAudio: false });
  const starts = [];
  context.NativeHost.media.playAudio = (handle, loop, offset) => {
    starts.push([handle, loop, offset]);
    return true;
  };
  const url = context.URL.createObjectURL(new Blob([Uint8Array.from([1, 2, 3])]));
  const audio = new context.WebAudio(url);
  audio.play(true, 0.25);
  assert.equal(audio._poll(), true, 'loading audio must remain in the maintenance list');
  await settle();
  assert.equal(context.loadedBytes.length, 1);
  assert.deepEqual(Array.from(context.loadedBytes[0]), [1, 2, 3]);
  assert.equal(audio.isReady(), true);
  assert.equal(context.loadedOptions[0].resourceIdentity, url);
  assert.deepEqual(starts, [[1, true, 0.25]]);
  context.URL.revokeObjectURL(url);
  assert.equal(audio.isReady(), true);
});

test('MV WebAudio delegates encrypted audio to the MV Decrypter', async () => {
  let requestedPath = '';
  let objectUrlsCreated = 0;
  function Request() {
    this.status = 200;
    this.response = Uint8Array.from([9, 8, 7]).buffer;
  }
  Request.prototype.open = function(_method, path) { requestedPath = path; };
  Request.prototype.send = function() { this.onload(); };
  const decrypter = {
    hasEncryptedAudio: true,
    extToEncryptExt: function(path) { return path.replace(/\.ogg$/, '.rpgmvo'); },
    decryptArrayBuffer: function(buffer) { return buffer; }
  };
  const context = contextFor(decrypter, Request);
  const originalCreate = context.URL.createObjectURL;
  context.URL.createObjectURL = function(blob) {
    objectUrlsCreated++;
    return originalCreate(blob);
  };
  const audio = new context.WebAudio('audio/se/cursor.ogg');
  await settle();
  assert.equal(requestedPath, 'audio/se/cursor.rpgmvo');
  assert.equal(context.loadedOptions[0].resourcePath, requestedPath);
  assert.deepEqual(Array.from(context.loadedBytes[0]), [9, 8, 7]);
  assert.equal(audio.isReady(), true);
  assert.equal(objectUrlsCreated, 0, 'MV decrypted bytes should go directly to native audio');
});

test('clearing an in-flight object URL load skips native decoding', async () => {
  const context = contextFor({ hasEncryptedAudio: false });
  const url = context.URL.createObjectURL(new Blob([Uint8Array.from([1])]));
  const audio = new context.WebAudio(url);
  audio.clear();
  await settle();
  assert.equal(context.loadedBytes.length, 0, 'cancelled bytes must not enter native decoding');
  assert.deepEqual(context.released, []);
  assert.equal(audio.isReady(), false);
});

test('a stop listener can restart audio without losing completion polling', () => {
  const context = contextFor({ hasEncryptedAudio: false });
  let playing = false;
  let nextHandle = 100;
  context.NativeHost.media.loadAudio = () => ({ handle: nextHandle++, duration: 1 });
  context.NativeHost.media.playAudio = () => { playing = true; return true; };
  context.NativeHost.media.audioIsPlaying = () => playing;
  vm.runInContext(mainLoopSource, context);
  const tracked = () => context.PMJS.rpgmaker.audio.update();
  const audio = new context.WebAudio('audio/se/restart.ogg');
  let completions = 0;
  audio.addStopListener(() => {
    completions++;
    audio.play(false, 0);
    audio.addStopListener(() => { completions++; });
  });
  audio.play(false, 0);
  playing = false;
  context.pmjsRunRpgMakerTick(1);
  assert.equal(playing, true);
  assert.equal(audio.isPlaying(), true);
  assert.equal(tracked(), 1);
  playing = false;
  context.pmjsRunRpgMakerTick(2);
  assert.equal(completions, 2);
  assert.equal(tracked(), 0);
});

test('fade-out cancels autoplay while an object URL is loading', async () => {
  const context = contextFor({ hasEncryptedAudio: false });
  const calls = [];
  context.NativeHost.media.playAudio = () => { calls.push('play'); return true; };
  const url = context.URL.createObjectURL(new Blob([Uint8Array.from([1])]));
  const audio = new context.WebAudio(url);
  audio.play(false, 0);
  audio.fadeOut(1);
  await settle();
  assert.equal(audio.isReady(), true);
  assert.deepEqual(calls, []);
  assert.equal(audio._autoPlay, false);
});

test('pending fade-in starts after native play and before load listeners', async () => {
  const context = contextFor({ hasEncryptedAudio: false });
  const calls = [];
  context.NativeHost.media.playAudio = () => { calls.push('play'); return true; };
  context.NativeHost.media.fadeAudio = (_handle, from, to, duration) => {
    calls.push(['fade', from, to, duration]);
  };
  const url = context.URL.createObjectURL(new Blob([Uint8Array.from([1])]));
  const audio = new context.WebAudio(url);
  audio.play(false, 0);
  audio.fadeIn(2);
  audio.addLoadListener(() => calls.push('loaded'));
  await settle();
  assert.deepEqual(calls, ['play', ['fade', 0, 1, 2], 'loaded']);
});

test('stop before load drains listeners and cancels later playback', async () => {
  const context = contextFor({ hasEncryptedAudio: false });
  let starts = 0;
  context.NativeHost.media.playAudio = () => { starts++; return true; };
  const url = context.URL.createObjectURL(new Blob([Uint8Array.from([1])]));
  const audio = new context.WebAudio(url);
  let stops = 0;
  audio.addStopListener(() => { stops++; });
  audio.play(false, 0);
  audio.stop();
  assert.equal(stops, 1);
  assert.equal(audio._stopListeners.length, 0);
  await settle();
  assert.equal(starts, 0);
  audio.play(false, 0);
  audio.stop();
  assert.equal(stops, 1, 'cancelled listener must not fire during later playback');
});

test('MV play-before-load keeps native playback truth until loaded', async () => {
  const context = contextFor({ hasEncryptedAudio: false });
  const url = context.URL.createObjectURL(new Blob([Uint8Array.from([1])]));
  const audio = new context.WebAudio(url);
  audio.play(false, 0);
  assert.equal(audio.isPlaying(), false);
  await settle();
  assert.equal(audio.isPlaying(), false);
  assert.equal(audio.isReady(), true);
});

test('MV master volume mirrors through the engine-visible field', () => {
  const context = contextFor({ hasEncryptedAudio: false });
  let hosted = null;
  context.NativeHost.media.setMasterVolume = (value) => { hosted = value; };
  context.WebAudio._masterVolume = 0.5;
  assert.equal(context.WebAudio.masterVolume, 0.5);
  assert.equal(hosted, 0.5);
  context.WebAudio.setMasterVolume(
    Math.min(context.WebAudio._masterVolume + 0.25, 1));
  assert.equal(context.WebAudio._masterVolume, 0.75);
});

test('MV fadeOut hands the native voice a stop at fade end', () => {
  const context = contextFor({ hasEncryptedAudio: false });
  const calls = [];
  context.NativeHost.media.loadAudio = () => ({ handle: 5, duration: 1 });
  context.NativeHost.media.fadeAudio = (handle, from, to, duration, stop) => {
    calls.push([handle, from, to, duration, stop]);
  };
  const audio = new context.WebAudio('audio/se/fade.ogg');
  audio.fadeOut(1.5);
  assert.deepEqual(calls, [[5, -1, 0, 1.5, true]]);
});

test('MV fadeTo reaches native audio without stopping', () => {
  const context = contextFor({ hasEncryptedAudio: false });
  const calls = [];
  context.NativeHost.media.loadAudio = () => ({ handle: 5, duration: 1 });
  context.NativeHost.media.fadeAudio = (handle, from, to, duration, stop) => {
    calls.push([handle, from, to, duration, stop]);
  };
  const audio = new context.WebAudio('audio/se/fade.ogg');
  audio._fadeTo(0.5, 2);
  assert.deepEqual(calls, [[5, -1, 0.5, 2, false]]);
});

test('MV clear drains a stop listener before releasing', () => {
  const context = contextFor({ hasEncryptedAudio: false });
  context.NativeHost.media.loadAudio = () => ({ handle: 5, duration: 1 });
  const audio = new context.WebAudio('audio/se/clear.ogg');
  let stops = 0;
  audio.addStopListener(() => { stops++; });
  audio.clear();
  assert.equal(stops, 1);
  assert.equal(audio._stopListeners.length, 0);
  assert.equal(audio._loadListeners.length, 0);
  assert.deepEqual(context.released, [5]);
});


test('MV provides engine intent without native path classification', () => {
  const context = contextFor({ hasEncryptedAudio: false });
  const intents = [];
  context.NativeHost.media.loadAudio = (_path, options) => {
    intents.push(options.intent);
    return { handle: intents.length, duration: 1 };
  };
  for (const folder of ['se', 'bgm', 'bgs', 'me']) context.AudioManager.createBuffer(folder, 'tone');
  assert.deepEqual(intents, ['effect', 'music', 'ambient', 'jingle']);
});
