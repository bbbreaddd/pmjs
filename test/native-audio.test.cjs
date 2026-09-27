'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const audioSource = fs.readFileSync(
  path.resolve(__dirname, '../js/pmjs-rpgmaker/native-audio.js'), 'utf8');

function contextFor() {
  const calls = { plays: [], releases: [], fades: [], params: [], master: [] };
  let nextHandle = 1;
  const context = {
    console,
    Date,
    gamePath: function(value) { return value; },
    NativeHost: {
      media: {
        loadAudio: function() { return { handle: nextHandle++, duration: 2 }; },
        loadAudioBytes: function() { return { handle: nextHandle++, duration: 1 }; },
        playAudio: function(handle, loop, offset) {
          calls.plays.push([handle, loop, offset]);
          return true;
        },
        stopAudio: function() {},
        setAudioParameters: function(handle, volume, pitch, pan) {
          calls.params.push([handle, volume, pitch, pan]);
        },
        audioIsPlaying: function() { return true; },
        audioPosition: function(handle) { return handle * 0.5; },
        releaseAudio: function(handle) { calls.releases.push(handle); },
        fadeAudio: function(handle, from, to, duration, stop) {
          calls.fades.push([handle, from, to, duration, stop]);
        },
        setMasterVolume: function(value) { calls.master.push(value); }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(audioSource, context, { filename: 'pmjs-rpgmaker/native-audio.js' });
  context.calls = calls;
  return context;
}

test('audio capability owns voices without leaking the constructor', () => {
  const context = contextFor();
  const audio = context.PMJS.rpgmaker.audio;
  assert.equal(typeof audio.createVoice, 'function');
  assert.equal(context.NativeAudioVoice, undefined);
  const voice = audio.createVoice();
  assert.equal(voice.handle, 0);
  assert.equal(voice.loading, false);
  assert.equal(voice.error, false);
});

test('loadPath installs the native handle and autoplays when requested', () => {
  const context = contextFor();
  const voice = context.PMJS.rpgmaker.audio.createVoice();
  voice.volume = 0.5;
  voice.play(true, 0.25);
  voice.loadPath('audio/bgm/theme.ogg');
  assert.equal(voice.handle, 1);
  assert.deepEqual(context.calls.params, [[1, 0.5, 1, 0]]);
  assert.deepEqual(context.calls.plays, [[1, true, 0.25]]);
  assert.equal(voice.position(), 0.5);
});

test('fadeTo forwards target, duration, and the stop decision', () => {
  const context = contextFor();
  const voice = context.PMJS.rpgmaker.audio.createVoice();
  voice.loadPath('audio/se/hit.ogg');
  voice.fadeTo(0.25, 2, true);
  voice.fadeTo(0.75, 1, false);
  assert.deepEqual(context.calls.fades, [
    [1, -1, 0.25, 2, true],
    [1, -1, 0.75, 1, false]
  ]);
});

test('resetForReload releases the stale handle exactly once', () => {
  const context = contextFor();
  const voice = context.PMJS.rpgmaker.audio.createVoice();
  voice.loadPath('audio/bgm/theme.ogg');
  voice.resetForReload();
  assert.deepEqual(context.calls.releases, [1]);
  assert.equal(voice.handle, 0);
  assert.equal(voice.error, false);
  voice.loadPath('audio/bgm/theme.ogg');
  assert.equal(voice.handle, 2);
  assert.deepEqual(context.calls.releases, [1]);
});

test('master volume clamps and reaches the host', () => {
  const context = contextFor();
  const audio = context.PMJS.rpgmaker.audio;
  audio.setMasterVolume(1.5);
  assert.equal(audio.masterVolume, 1);
  assert.deepEqual(context.calls.master, [1]);
  audio.setMasterVolume(-2);
  assert.equal(audio.masterVolume, 0);
  assert.deepEqual(context.calls.master, [1, 0]);
  assert.ok(Number.isFinite(audio.now()));
});

test('path helpers follow PMJS conventions without engine knowledge', () => {
  const context = contextFor();
  const audio = context.PMJS.rpgmaker.audio;
  assert.equal(audio.resolvePath('audio/bgm/theme.ogg?v=2'), 'audio/bgm/theme.ogg');
  assert.equal(audio.isObjectUrl('blob:fake'), false);
});

test('update keeps replayed buffers and drops finished ones', () => {
  const context = contextFor();
  const audio = context.PMJS.rpgmaker.audio;
  let polls = 0;
  const retained = { _playGeneration: 0, _poll: () => { polls++; return true; } };
  const replayed = {
    _playGeneration: 0,
    _poll: function() { this._playGeneration++; return false; }
  };
  const finished = { _playGeneration: 0, _poll: () => false };
  audio.track(retained);
  audio.track(replayed);
  audio.track(finished);
  audio.track(retained);
  assert.equal(audio.update(), 2);
  assert.equal(polls, 1);
});

test('intent hints and the rollback reach independent native loads', () => {
  const context = contextFor();
  const loads = [];
  context.NativeHost.media.loadAudio = (path, options) => {
    loads.push({ path, intent: options.intent });
    return { handle: loads.length, duration: 1 };
  };
  context.PMJS.rpgmaker.audio.createVoice('effect').loadPath('audio/se/cursor.ogg');
  context.PMJS.rpgmaker.audio.createVoice('music').loadPath('audio/bgm/theme.ogg');
  assert.deepEqual(loads.map(load => load.intent), ['effect', 'music']);
  context.PMJS.optimizations = { isEnabled: () => false };
  context.PMJS.rpgmaker.audio.createVoice('effect').loadPath('audio/se/cursor.ogg');
  assert.equal(loads[2].intent, 'unknown');
});


test('installing a replacement source releases only the replaced voice', () => {
  const context = contextFor();
  const first = context.PMJS.rpgmaker.audio.createVoice('effect');
  const second = context.PMJS.rpgmaker.audio.createVoice('effect');
  first.loadPath('audio/se/tone.ogg');
  second.loadPath('audio/se/tone.ogg');
  first.loadPath('audio/se/other.ogg');
  assert.deepEqual(context.calls.releases, [1]);
  assert.equal(first.handle, 3);
  assert.equal(second.handle, 2);
});
