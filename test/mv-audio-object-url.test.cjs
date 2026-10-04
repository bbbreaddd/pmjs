'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const objectUrlSource = fs.readFileSync(
  path.resolve(__dirname, '../js/pmjs-web/object-urls.js'), 'utf8');
const audioSource = fs.readFileSync(
  path.resolve(__dirname, '../js/pmjs-rpgmaker/native-audio.js'), 'utf8');
const mvAudioSource = fs.readFileSync(
  path.resolve(__dirname, '../js/pmjs-mv/audio.js'), 'utf8');
const mainLoopSource = fs.readFileSync(
  path.resolve(__dirname, '../js/pmjs-rpgmaker/main-loop.js'), 'utf8');

function contextFor(decrypter, XMLHttpRequest, clock = Date, streaming = false) {
  const loadedBytes = [];
  const loadedOptions = [];
  const released = [];
  const context = {
    Blob,
    URL: function URL() {},
    console,
    Date: clock,
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
        fadeAudio: function() {},
        setAudioParameters: function() {},
        setAudioEqualPowerPan: function() {},
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
  if (streaming) {
    for (const module of ['pmjs-core/methods', 'pmjs-rpgmaker/lifecycle', 'pmjs-rpgmaker/plugins']) {
      vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../js', module + '.js'), 'utf8'), context);
    }
    context.__pmjsBuiltinRequire = require;
    context.compatHits = [];
    context.PMJS.compat = { hit(...args) { context.compatHits.push(args); } };
    const replacements = {};
    for (const name of ['_load', 'clear', 'isReady', 'isPlaying', 'play', 'stop', 'seek']) {
      replacements[name] = function() { throw new Error('browser streaming voice used'); };
    }
    const pitch = { configurable: true,
      get: function() { return -1; }, set: function() { throw new Error('browser pitch used'); } };
    const functions = { ...replacements, pitchget: pitch.get, pitchset: pitch.set };
    const adapter = fs.readFileSync(path.resolve(__dirname,
      '../js/pmjs-plugins/audio-streaming/native-audio.js'), 'utf8');
    const fixture = adapter.replace(/(\w+): '[a-f0-9]{64}'/g, (entry, name) => {
      if (!functions[name]) return entry;
      const body = Function.prototype.toString.call(functions[name])
        .replace(/^(async )?function(?:\s+[\w$]+)?\s*\(/, '$1function(');
      return name + ": '" + createHash('sha256').update(body).digest('hex') + "'";
    });
    vm.runInContext(fixture, context);
    context.streamingReplacements = replacements;
    context.installStreamingPlugin = function(load) {
      context.PMJS.plugins.execute('AudioStreaming', load || function() {
        for (const [name, method] of Object.entries(replacements)) context.WebAudio.prototype[name] = method;
        Object.defineProperty(context.WebAudio.prototype, 'pitch', pitch);
        vm.runInContext(`
          AudioManager.createBuffer = function(folder, name) {
            return new WebAudio('redirected/' + folder + '/' + name + '.ogg');
          };
          AudioManager.audioFileExt = function() { return '.ogg'; };
        `, context);
      });
    };
  }
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

test('streaming plugin native transport retains guest routing and voice lifecycle', async () => {
  const context = contextFor({ hasEncryptedAudio: false }, undefined, Date, true);
  const paths = [], starts = [], stops = [];
  let playing = false;
  context.NativeHost.media.loadAudio = path => {
    paths.push(path); return { handle: paths.length, duration: 3 };
  };
  context.NativeHost.media.playAudio = (...args) => { starts.push(args); playing = true; return true; };
  context.NativeHost.media.audioIsPlaying = () => playing;
  context.NativeHost.media.audioPosition = () => 0.75;
  context.NativeHost.media.stopAudio = handle => { stops.push(handle); playing = false; };
  context.installStreamingPlugin();
  const routed = context.AudioManager.createBuffer;
  const audio = routed('bgm', 'theme');
  assert.deepEqual(paths, ['redirected/bgm/theme.ogg']);
  assert.equal(audio.isReady(), true);
  audio.play(true, 0.25);
  audio.pitch = 1.2;
  assert.equal(audio.pitch, 1.2);
  assert.equal(audio.isPlaying(), true);
  assert.equal(audio.seek(), 0.75);
  let completion = 0;
  audio.addStopListener(() => completion++);
  audio.stop();
  assert.equal(audio.isPlaying(), false);
  assert.equal(completion, 1);
  audio.clear();
  assert.deepEqual(context.released, [1]);
  assert.equal(audio.isReady(), false);
  assert.equal(context.AudioManager.createBuffer, routed);
  assert.equal(context.AudioManager.audioFileExt(), '.ogg');

  const url = context.URL.createObjectURL(new Blob([Uint8Array.from([1, 2])]));
  const pending = new context.WebAudio(url);
  pending.play(false, 0.5);
  pending.fadeIn(1);
  let loaded = false;
  pending.addLoadListener(() => { loaded = true; });
  await settle();
  assert.equal(loaded, true);
  assert.equal(pending.isReady(), true);
  assert.deepEqual(starts.at(-1), [1, false, 0.5]);
  pending.clear();
  assert.ok(stops.length > 0);
});

test('streaming decoder restores earlier wrappers and leaves unchanged operations intact', () => {
  const context = contextFor({ hasEncryptedAudio: false }, undefined, Date, true);
  const calls = [];
  const before = context.WebAudio.prototype;
  const nativePlay = before.play;
  const play = before.play = function() { calls.push('earlier'); return nativePlay.apply(this, arguments); };
  const seek = before.seek = function() { calls.push('seek'); return 0.5; };
  const pitch = Object.getOwnPropertyDescriptor(before, 'pitch');
  const get = function() { calls.push('pitch'); return pitch.get.call(this); };
  Object.defineProperty(before, 'pitch', { ...pitch, get });
  context.installStreamingPlugin(() => {
    before.play = context.streamingReplacements.play;
    before._load = context.streamingReplacements._load;
  });
  assert.equal(before.play, play);
  assert.equal(before.seek, seek);
  assert.equal(Object.getOwnPropertyDescriptor(before, 'pitch').get, get);
  const laterPlay = before.play;
  before.play = function() { calls.push('later'); return laterPlay.apply(this, arguments); };
  context.NativeHost.media.loadAudio = () => ({ handle: 1, duration: 2 });
  const audio = new context.WebAudio('audio/bgm/theme.ogg');
  audio.play(false, 0);
  assert.equal(audio.seek(), 0.5);
  assert.equal(audio.pitch, 1);
  assert.deepEqual(calls, ['later', 'earlier', 'seek', 'pitch']);
  assert.deepEqual(context.compatHits, []);
});

test('streaming decoder restores the earlier pitch accessor when it replaces it', () => {
  const context = contextFor({ hasEncryptedAudio: false }, undefined, Date, true);
  const prototype = context.WebAudio.prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, 'pitch');
  let writes = 0;
  const set = function(value) { writes++; original.set.call(this, value); };
  Object.defineProperty(prototype, 'pitch', { ...original, set });
  context.installStreamingPlugin();
  assert.equal(Object.getOwnPropertyDescriptor(prototype, 'pitch').set, set);
  context.NativeHost.media.loadAudio = () => ({ handle: 1, duration: 2 });
  const audio = new context.WebAudio('audio/bgm/theme.ogg');
  audio.pitch = 1.25;
  assert.equal(writes, 1);
  assert.equal(audio.pitch, 1.25);
});

test('unknown streaming composition is reported without partially restoring methods', () => {
  const context = contextFor({ hasEncryptedAudio: false }, undefined, Date, true);
  const prototype = context.WebAudio.prototype;
  const unknown = function() { return 'authored seek'; };
  context.installStreamingPlugin(() => {
    prototype._load = context.streamingReplacements._load;
    prototype.seek = unknown;
  });
  assert.equal(prototype._load, context.streamingReplacements._load);
  assert.equal(prototype.seek, unknown);
  assert.deepEqual(context.compatHits, [['plugins.audio-streaming.voice', 'unrecognized seek replacement']]);
});

test('failed streaming load does not run the native composition installer', () => {
  const context = contextFor({ hasEncryptedAudio: false }, undefined, Date, true);
  const prototype = context.WebAudio.prototype;
  assert.throws(() => context.installStreamingPlugin(() => {
    prototype.play = context.streamingReplacements.play;
    throw new Error('plugin failure');
  }), /plugin failure/);
  assert.equal(prototype.play, context.streamingReplacements.play);
  assert.equal(context.PMJS.plugins.dump().guest[0].state, 'failed');
});

test('MV audio supplies its URL to guest load wrappers on initial load and retry', () => {
  const context = contextFor({ hasEncryptedAudio: false });
  const urls = [];
  let retry;
  context.ResourceHandler = { createLoader(url, callback) { retry = callback; return () => {}; } };
  const nativeLoad = context.WebAudio.prototype._load;
  context.WebAudio.prototype._load = function(url) {
    urls.push(url); return nativeLoad.apply(this, arguments);
  };
  context.NativeHost.media.loadAudio = () => ({ handle: 5, duration: 1 });
  const audio = new context.WebAudio('audio/bgm/theme.ogg');
  retry();
  assert.deepEqual(urls, ['audio/bgm/theme.ogg', 'audio/bgm/theme.ogg']);
  audio.clear();
  retry();
  assert.equal(urls.length, 2, 'cleared voices must not execute stale retry callbacks');
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

test('MV fadeOut fades gain without stopping the source', () => {
  const context = contextFor({ hasEncryptedAudio: false });
  const calls = [];
  context.NativeHost.media.loadAudio = () => ({ handle: 5, duration: 1 });
  context.NativeHost.media.fadeAudio = (handle, from, to, duration, stop) => {
    calls.push([handle, from, to, duration, stop]);
  };
  const audio = new context.WebAudio('audio/se/fade.ogg');
  audio.fadeOut(1.5);
  assert.deepEqual(calls, [[5, 1, 0, 1.5, false]]);
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
  assert.deepEqual(calls, [[5, 1, 0.5, 2, false]]);
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

test('MV gain reads and interrupted ramps preserve instantaneous gain and engine volume', () => {
  let now = 0;
  const clock = class extends Date { static now() { return now; } };
  const context = contextFor({ hasEncryptedAudio: false }, undefined, clock);
  context.NativeHost.media.loadAudio = () => ({ handle: 5, duration: 4 });
  const ramps = [];
  context.NativeHost.media.fadeAudio = (...args) => ramps.push(args);
  const audio = new context.WebAudio('audio/bgm/ramp.ogg');
  audio.volume = 0.5;
  audio._fadeTo(0, 2);
  now = 1000;
  assert.equal(audio._gainNode.gain.value, 0.25);
  audio.linearRampToValueAtTime(0.75, 3);
  assert.deepEqual(ramps.at(-1), [5, 0.25, 0.75, 2, false, true]);
  now = 2000;
  assert.equal(audio._gainNode.gain.value, 0.5);
  now = 3000;
  assert.equal(audio._gainNode.gain.value, 0.75);
  assert.equal(audio.volume, 0.5);
});

test('MV pending fade-in uses engine volume after asynchronous loading', async () => {
  const context = contextFor({ hasEncryptedAudio: false });
  const ramps = [];
  context.NativeHost.media.fadeAudio = (...args) => ramps.push(args);
  const url = context.URL.createObjectURL(new Blob([Uint8Array.from([1])]));
  const audio = new context.WebAudio(url);
  audio.volume = 0.5;
  audio.play(true, 0);
  audio.fadeIn(2);
  await settle();
  assert.deepEqual(ramps, [[1, 0, 0.5, 2, false, true]]);
  assert.equal(audio.volume, 0.5);
  context.URL.revokeObjectURL(url);
});


test('MV interrupted gains above one preserve engine volume and native scaling', () => {
  let now = 0;
  const clock = class extends Date { static now() { return now; } };
  const context = contextFor({ hasEncryptedAudio: false }, undefined, clock);
  const parameters = [], ramps = [];
  context.NativeHost.media.loadAudio = () => ({ handle: 5, duration: 4 });
  context.NativeHost.media.setAudioParameters = (...args) => parameters.push(args);
  context.NativeHost.media.fadeAudio = (...args) => ramps.push(args);
  const audio = new context.WebAudio('audio/bgm/ramp.ogg');
  audio.volume = 0.5;
  audio.linearRampToValueAtTime(2, 2);
  assert.deepEqual(parameters.at(-1), [5, 2, 1, 0]);
  assert.deepEqual(ramps.at(-1), [5, 0.25, 1, 2, false, true]);
  now = 1000;
  assert.equal(audio.value, 1.25);
  audio.linearRampToValueAtTime(3, 3);
  assert.deepEqual(parameters.at(-1), [5, 3, 1, 0]);
  assert.deepEqual(ramps.at(-1), [5, 1.25 / 3, 1, 2, false, true]);
  now = 2000;
  assert.equal(audio.value, 2.125);
  assert.equal(audio.volume, 0.5);
});

test('MV repeated clear resets playback parameters and releases only its own voice', () => {
  const context = contextFor({ hasEncryptedAudio: false });
  let nextHandle = 10;
  const starts = [];
  context.NativeHost.media.loadAudio = () => ({ handle: nextHandle++, duration: 4 });
  context.NativeHost.media.playAudio = (...args) => { starts.push(args); return true; };
  const first = new context.WebAudio('audio/se/first.ogg');
  const second = new context.WebAudio('audio/se/second.ogg');
  first.volume = 0.4;
  first.pitch = 1.2;
  first.pan = 0.5;
  let stops = 0;
  first.addStopListener(() => stops++);
  first.clear();
  first.clear();
  assert.equal(stops, 1);
  assert.equal(first.isReady(), false);
  assert.deepEqual([first.volume, first.pitch, first.pan], [1, 1, 0]);
  assert.deepEqual(context.released, [10]);
  second.play(false, 0.25);
  assert.equal(second.isReady(), true);
  assert.deepEqual(starts.at(-1), [11, false, 0.25]);
});


test('MV deferred retries reach exhaustion and recover through the guest load method', () => {
  const context = contextFor({ hasEncryptedAudio: false });
  context.console = { log() {}, error() {} };
  const scheduled = [], starts = [], urls = [];
  let retry, attempts = 0, failures = 0;
  context.ResourceHandler = { createLoader(url, reload, resign) {
    assert.equal(url, 'audio/bgm/retry.ogg');
    retry = reload;
    return () => {
      if (failures++ < 2) scheduled.push(reload);
      else resign();
    };
  } };
  context.NativeHost.media.loadAudio = () => {
    if (++attempts <= 3) throw new Error('temporary decoder failure');
    return { handle: 31, duration: 2 };
  };
  context.NativeHost.media.playAudio = (...args) => { starts.push(args); return true; };
  const nativeLoad = context.WebAudio.prototype._load;
  context.WebAudio.prototype._load = function(url) {
    urls.push(url);
    return nativeLoad.apply(this, arguments);
  };
  const audio = new context.WebAudio('audio/bgm/retry.ogg');
  audio.play(true, 0.25);
  let loaded = 0, wrappedFailures = 0;
  audio.addLoadListener(() => loaded++);
  const loader = audio._loader;
  audio._loader = function() { wrappedFailures++; loader(); };
  for (let index = 0; index < 2; index++) {
    assert.equal(audio.isReady(), false);
    assert.equal(audio.isError(), false);
    assert.equal(audio._poll(), true, 'deferred retries remain maintained');
    scheduled.shift()();
  }
  assert.equal(audio.isError(), true);
  assert.equal(audio._poll(), false);
  assert.equal(wrappedFailures, 2, 'failure dispatch uses the guest-visible loader');
  assert.throws(() => context.AudioManager.checkWebAudioError(audio), /Failed to load: audio\/bgm\/retry.ogg/);
  retry();
  assert.equal(audio.isError(), false);
  assert.equal(audio.isReady(), true);
  assert.equal(loaded, 1);
  assert.deepEqual(urls, Array(4).fill('audio/bgm/retry.ogg'));
  assert.deepEqual(starts, [[31, true, 0.25]]);
  audio.clear();
  assert.deepEqual(context.released, [31]);
});

test('MV clear invalidates delayed retry and resignation before stop listeners run', () => {
  const context = contextFor({ hasEncryptedAudio: false });
  context.console = { log() {}, error() {} };
  let retry, resign, attempts = 0;
  context.ResourceHandler = { createLoader(_url, reload, giveUp) {
    retry = reload;
    resign = giveUp;
    return () => {};
  } };
  context.NativeHost.media.loadAudio = () => { attempts++; throw new Error('missing audio'); };
  const audio = new context.WebAudio('audio/se/clear.ogg');
  assert.equal(audio._poll(), true);
  audio.addStopListener(() => {
    resign();
    assert.equal(audio.isError(), false);
  });
  audio.clear();
  retry();
  resign();
  assert.equal(attempts, 1);
  assert.equal(audio.isError(), false);
  assert.equal(audio.isReady(), false);
  assert.equal(audio._poll(), false);
  assert.doesNotThrow(() => context.AudioManager.checkWebAudioError(audio));
});

test('MV encrypted retry ignores stale completion and failure from the previous attempt', () => {
  const requests = [], scheduled = [], starts = [];
  function Request() {
    this.status = 200;
    this.response = Uint8Array.of(1, 2).buffer;
    requests.push(this);
  }
  Request.prototype.open = function(_method, path) { this.path = path; };
  Request.prototype.send = function() {};
  const context = contextFor({ hasEncryptedAudio: true,
    extToEncryptExt: path => path.replace(/\.ogg$/, '.rpgmvo'),
    decryptArrayBuffer: bytes => bytes }, Request);
  context.console = { log() {}, error() {} };
  let failures = 0;
  context.ResourceHandler = { createLoader(_url, retry) {
    return () => { failures++; scheduled.push(retry); };
  } };
  context.NativeHost.media.playAudio = (...args) => { starts.push(args); return true; };
  const audio = new context.WebAudio('audio/bgm/encrypted.ogg');
  audio.play(true, 0.5);
  let loaded = 0;
  audio.addLoadListener(() => loaded++);
  requests[0].onerror();
  assert.equal(audio.isError(), false);
  assert.equal(audio._poll(), true);
  scheduled.shift()();
  requests[0].onload();
  requests[0].onerror();
  assert.equal(context.loadedBytes.length, 0);
  assert.equal(failures, 1);
  requests[1].onload();
  assert.equal(audio.isReady(), true);
  assert.equal(audio.isError(), false);
  assert.equal(loaded, 1);
  assert.deepEqual(starts, [[1, true, 0.5]]);
  assert.deepEqual(requests.map(request => request.path), Array(2).fill('audio/bgm/encrypted.rpgmvo'));
  assert.equal(context.loadedOptions[0].resourcePath, requests[1].path);
  requests[0].onerror();
  assert.equal(audio.isError(), false);
  assert.equal(failures, 1);
  audio.clear();
});

test('MV standalone failure stays failed until reload succeeds', () => {
  const context = contextFor({ hasEncryptedAudio: false });
  context.console = { log() {}, error() {} };
  const audio = new context.WebAudio('audio/se/reload.ogg');
  assert.equal(audio.isError(), true);
  assert.equal(audio.isReady(), false);
  assert.equal(audio._poll(), false);
  context.NativeHost.media.loadAudio = () => ({ handle: 11, duration: 1 });
  audio._load(audio.url);
  assert.equal(audio.isError(), false);
  assert.equal(audio.isReady(), true);
  audio.clear();
});

test('MV empty paths and an absent media host finish preparation without waiting', () => {
  const context = contextFor({ hasEncryptedAudio: false });
  const empty = new context.WebAudio('');
  assert.equal(empty.isError(), false);
  assert.equal(empty.isReady(), false);
  assert.equal(empty._poll(), false);
  context.NativeHost.media = null;
  const silent = new context.WebAudio('audio/se/tone.ogg');
  assert.equal(silent.isError(), false);
  assert.equal(silent.isReady(), true);
  assert.equal(silent._poll(), false);
});
