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
    setAudioContextSuspended() {}, bindAudioContext() {}, audioContextTime() { return 0; },
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
  const tasks = [], eventErrors = [];
  let stopped = false;
  function Request() {
    this.status = opts.requestStatus || 200;
    this.response = new ArrayBuffer(8);
    pendingRequests.push(this);
  }
  Request.prototype.open = function(_method, path) { this.path = path; };
  Request.prototype.send = function() {};
  const context = {
    console, __pmjsBuiltinRequire: require,
    PMJS: { config: {}, tasks: {
      enqueue(callback, options) {
        if (stopped) { options.discard(); return false; }
        tasks.push({ callback, options });
        return true;
      }
    } },
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
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../js/pmjs-web/filesystem.js'), 'utf8'), context);
  vm.runInContext(audioSource, context, { filename: 'pmjs-rpgmaker/native-audio.js' });
  vm.runInContext(mzAudioSource, context, { filename: 'pmjs-mz/audio.js' });
  context.pendingRequests = pendingRequests;
  context.eventErrors = eventErrors;
  context.flushLoads = function() {
    while (tasks.length) {
      const { callback, options } = tasks.shift();
      try { callback(); } catch (error) {
        if (options.errorMode !== 'event') throw error;
        eventErrors.push(error);
      }
    }
  };
  context.stopLoads = function() {
    stopped = true;
    tasks.splice(0).forEach(task => task.options.discard());
  };
  context.playSe = function(se) {
    const buffer = context.AudioManager.createBuffer('se/', se.name);
    context.AudioManager.updateSeParameters(buffer, se);
    buffer.play(false);
    context.flushLoads();
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

test('MZ plaintext audio overrides encrypted loading without masking missing files', () => {
  const context = contextFor({ encrypted: true });
  const paths = [];
  context.NativeHost.fs = { exists: value => value === 'audio/se/plain.ogg' };
  context.NativeHost.media.loadAudio = value => { paths.push(value); return { handle: 81, duration: 1 }; };
  const plain = context.AudioManager.createBuffer('se/', 'plain');
  assert.equal(plain.isReady(), false);
  context.flushLoads();
  assert.equal(plain.isReady(), true);
  assert.deepEqual(paths, ['audio/se/plain.ogg']);
  assert.equal(context.pendingRequests.length, 0);
  const encrypted = context.AudioManager.createBuffer('se/', 'encrypted');
  assert.equal(encrypted.isReady(), false);
  assert.equal(context.pendingRequests[0].path, 'audio/se/encrypted.ogg_');
  context.pendingRequests[0].onload();
  context.flushLoads();
  assert.equal(encrypted.isReady(), true);
  plain.destroy(); encrypted.destroy();
});

test('MZ play-before-load reports logical playback immediately', () => {
  const context = contextFor({ encrypted: true });
  const buffer = context.playSe({ name: 'Hit', volume: 90, pitch: 100, pan: 0 });
  assert.equal(buffer.isPlaying(), true);
  assert.equal(context.NativeHost.media.calls.plays, 0);
});

for (const encrypted of [false, true]) {
  test(`MZ ${encrypted ? 'encrypted' : 'plaintext'} readiness preserves listener and playback order`, () => {
    const context = contextFor({ encrypted });
    const events = [];
    context.NativeHost.media.playAudio = (_handle, loop, offset) => {
      events.push(['play', loop, offset]); return true;
    };
    const audio = new context.WebAudio('audio/bgs/room.ogg');
    events.push(['constructed', audio.isReady()]);
    audio.addLoadListener(() => events.push(['first', audio.isReady()]));
    audio.play(true, 0.75);
    audio.addLoadListener(() => events.push(['last']));
    assert.equal(audio.isPlaying(), true);
    if (encrypted) context.pendingRequests[0].onload();
    assert.deepEqual(events, [['constructed', false]]);
    context.flushLoads();
    assert.deepEqual(events, [['constructed', false], ['first', true], ['play', true, 0.75], ['last']]);
    audio.addLoadListener(() => events.push(['late']));
    context.flushLoads();
    assert.equal(events.length, 4, 'stock MZ does not immediately invoke late listeners');
    audio.clear();
  });
}

test('MZ stop before notification clears playback and listeners but retains loaded audio', () => {
  const context = contextFor();
  const audio = new context.WebAudio('audio/se/tone.ogg');
  audio.addLoadListener(() => assert.fail('stopped listener'));
  audio.play(false);
  audio.stop();
  context.flushLoads();
  assert.equal(audio.isReady(), true);
  assert.equal(audio.isPlaying(), false);
  assert.equal(context.NativeHost.media.calls.plays, 0);
  audio.play(false);
  assert.equal(context.NativeHost.media.calls.plays, 1);
  audio.clear();
});

test('MZ clear and destroy cancel queued notifications and release only their own handles', () => {
  const context = contextFor();
  let handle = 1;
  context.NativeHost.media.loadAudio = () => ({ handle: handle++, duration: 1 });
  for (const method of ['clear', 'destroy']) {
    const audio = new context.WebAudio('audio/se/tone.ogg');
    audio.addLoadListener(() => assert.fail('obsolete listener'));
    audio.play(false);
    audio[method]();
    context.flushLoads();
    assert.equal(audio.isReady(), false);
    assert.equal(audio.isPlaying(), false);
  }
  assert.deepEqual(context.NativeHost.media.calls.releases, [1, 2]);
  assert.equal(context.NativeHost.media.calls.plays, 0);
});

test('MZ retry supersedes a queued notification without replaying the released handle', () => {
  const context = contextFor();
  let handle = 1;
  const events = [];
  context.NativeHost.media.loadAudio = () => ({ handle: handle++, duration: 1 });
  context.NativeHost.media.playAudio = value => { events.push(['play', value]); return true; };
  const audio = new context.WebAudio('audio/se/tone.ogg');
  audio.addLoadListener(() => events.push(['loaded']));
  audio.retry();
  audio.play(false);
  context.flushLoads();
  assert.deepEqual(events, [['loaded'], ['play', 2]]);
  assert.deepEqual(context.NativeHost.media.calls.releases, [1]);
  audio.clear();
});

test('MZ a load listener can retry without draining listeners against the superseded source', () => {
  const context = contextFor();
  const audio = new context.WebAudio('audio/se/tone.ogg');
  const events = [];
  audio.addLoadListener(() => { events.push(['first', audio.isReady()]); audio.retry(); });
  audio.addLoadListener(() => events.push(['replacement', audio.isReady()]));
  context.flushLoads();
  assert.deepEqual(events, [['first', true], ['replacement', true]]);
  audio.clear();
});

test('MZ load listener errors remain event errors rather than decode failures', () => {
  const context = contextFor();
  const audio = new context.WebAudio('audio/se/tone.ogg');
  const error = new Error('guest callback');
  audio.addLoadListener(() => { throw error; });
  context.flushLoads();
  assert.equal(audio.isReady(), true);
  assert.equal(audio.isError(), false);
  assert.deepEqual(context.eventErrors, [error]);
  audio.clear();
});

test('MZ shutdown discards pending notifications and late installations without guest callbacks', async () => {
  const context = contextFor();
  const plain = new context.WebAudio('audio/se/tone.ogg');
  const url = context.URL.createObjectURL(new Blob([Uint8Array.of(1)]));
  const blob = new context.WebAudio(url);
  for (const audio of [plain, blob]) {
    audio.addLoadListener(() => assert.fail('callback after shutdown'));
    audio.addStopListener(() => assert.fail('stop callback after shutdown'));
    audio.play(false);
  }
  context.stopLoads();
  await new Promise(resolve => setImmediate(resolve));
  context.flushLoads();
  for (const audio of [plain, blob]) {
    assert.equal(audio.isReady(), false);
    assert.equal(audio.isPlaying(), false);
  }
  assert.deepEqual(context.NativeHost.media.calls.releases, [17, 29]);
  assert.equal(context.NativeHost.media.calls.plays, 0);
  context.URL.revokeObjectURL(url);
});

test('MZ encrypted SE survives cleanupSe and plays after decryption', () => {
  const context = contextFor({ encrypted: true });
  const buffer = context.playSe({ name: 'Hit', volume: 90, pitch: 100, pan: 0 });
  const survivors = context.cleanupSe([buffer]);
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0], buffer);
  assert.equal(context.pendingRequests.length, 1);
  context.pendingRequests[0].onload();
  context.flushLoads();
  assert.equal(buffer.isPlaying(), true);
  assert.equal(context.NativeHost.media.calls.plays, 1);
});

test('MZ prepared encrypted music and effects use logical file paths without XHR', () => {
  const context = contextFor({ encrypted: true });
  const paths = [];
  context.NativeHost.assets = { hasDecrypted: source => source !== 'audio/se/Missing.ogg' };
  const ordinary = context.NativeHost.media.loadAudio;
  context.NativeHost.media.loadAudio = (source, options) => {
    paths.push(source);
    return ordinary(source, options);
  };
  const music = context.AudioManager.createBuffer('bgm/', 'Town Theme');
  const effect = context.playSe({ name: 'Hit', volume: 90, pitch: 100, pan: 0 });
  assert.equal(music.isReady(), true);
  assert.equal(effect.isPlaying(), true);
  assert.deepEqual(paths, ['audio/bgm/Town Theme.ogg', 'audio/se/Hit.ogg']);
  assert.equal(context.pendingRequests.length, 0);
  context.AudioManager.createBuffer('se/', 'Missing');
  assert.equal(context.pendingRequests.length, 1);
  assert.equal(context.pendingRequests[0].path, 'audio/se/Missing.ogg_');
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
  context.flushLoads();
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
  context.flushLoads();
  assert.equal(buffer.isError(), false);
  assert.equal(buffer.isPlaying(), true);
  assert.equal(context.NativeHost.media.calls.plays, 2, 'stock retry queues another play listener');
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
  context.flushLoads();
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


test('MZ object URLs bypass encryption and preserve listener and playback order', async () => {
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
  context.flushLoads();
  assert.deepEqual(loads, [[[1, 2, 3], url]]);
  assert.deepEqual(events, [['loaded'], ['play', 77, true, 0.5]]);
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
  context.flushLoads();
  assert.deepEqual(loads, ['audio/se/Town Bell.ogg_']);
  assert.deepEqual(events, ['loaded']);
  assert.equal(context.NativeHost.media.calls.plays, 2, 'stock retry queues another play listener');
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


test('MZ load hooks drain live callbacks and honor reentrant cancellation', async () => {
  const context = contextFor();
  const events = [];
  const original = context.WebAudio.prototype._onLoad;
  context.WebAudio.prototype._onLoad = function() {
    events.push('hook');
    return original.apply(this, arguments);
  };
  const url = context.URL.createObjectURL(new Blob([Uint8Array.from([1, 2])]));
  const audio = new context.WebAudio(url);
  audio.addLoadListener(() => { events.push('first'); audio.clear(); });
  audio.addLoadListener(() => events.push('obsolete'));
  await new Promise(resolve => setImmediate(resolve));
  context.flushLoads();
  assert.deepEqual(events, ['hook', 'first']);

  events.length = 0;
  const next = new context.WebAudio(url);
  next.addLoadListener(() => {
    events.push('first');
    next.addLoadListener(() => events.push('appended'));
  });
  next.addLoadListener(() => events.push('second'));
  await new Promise(resolve => setImmediate(resolve));
  context.flushLoads();
  assert.deepEqual(events, ['hook', 'first', 'second', 'appended']);
  next.clear();
  context.URL.revokeObjectURL(url);
});

test('MZ stop callbacks appended during dispatch run in the same stop', () => {
  const context = contextFor();
  context.NativeHost.media.loadAudio = () => ({ handle: 1, duration: 1 });
  const audio = new context.WebAudio('audio/se/test.ogg');
  const events = [];
  audio.addStopListener(() => {
    events.push('first');
    audio.addStopListener(() => events.push('appended'));
  });
  audio.addStopListener(() => events.push('second'));
  audio.stop();
  assert.deepEqual(events, ['first', 'second', 'appended']);
  audio.clear();
});

test('MZ guest volume and pan wrappers use the engine clock and effective playback parameters', () => {
  const context = contextFor();
  const prototype = context.WebAudio.prototype;
  Object.defineProperty(prototype, 'volume', { configurable: true,
    get() { return this._volume; }, set(value) {
      this._volume = value;
      this._gainNode.gain.setValueAtTime(value, context.WebAudio._context.currentTime);
    } });
  Object.defineProperty(prototype, 'pan', { configurable: true,
    get() { return this.guestPan * 2 - 1; }, set(value) { this.guestPan = (value + 1) / 2; } });
  const audio = context.AudioManager.createBuffer('se/', 'Cursor');
  audio.volume = 0.3; audio.pan = -0.5; audio.play(false);
  context.flushLoads();
  assert.equal(audio._voice.volume, 0.3);
  assert.equal(audio._voice.pan, -0.5);
  assert.equal(context.NativeHost.media.calls.fades.at(-1)[2], 0.3);
});

test('native voice stereo balance uses the effective pan and leaves the ordinary panner inactive', () => {
  const context = contextFor(); const balances = [];
  context.NativeHost.media.setAudioStereoBalance = (...args) => balances.push(args);
  const audio = context.AudioManager.createBuffer('se/', 'Cursor');
  audio._voice.stereoBalance = true; audio.pan = 0.6;
  assert.equal(balances.at(-1)[1], 0.6);
  assert.deepEqual(context.NativeHost.media.calls.parameters.at(-1).slice(1), [1, 1, 0]);
});
