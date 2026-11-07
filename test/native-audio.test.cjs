'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const audioSource = fs.readFileSync(
  path.resolve(__dirname, '../js/pmjs-rpgmaker/native-audio.js'), 'utf8');

function contextFor(prepare) {
  const calls = { plays: [], releases: [], fades: [], params: [], pans: [], master: [], suspensions: [], bindings: [] };
  let nextHandle = 1;
  const context = {
    PMJS: { config: {} },
    console, __pmjsBuiltinRequire: require,
    Date,
    gamePath: function(value) { return value; },
    NativeHost: {
      media: {
        setAudioContextSuspended(value) { calls.suspensions.push(value); },
        bindAudioContext(handle) { calls.bindings.push(handle); },
        audioContextTime() { return 2.5; },
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
        setAudioEqualPowerPan: function(...args) { calls.pans.push(args); },
        audioIsPlaying: function() { return true; },
        audioPosition: function(handle) { return handle * 0.5; },
        releaseAudio: function(handle) { calls.releases.push(handle); },
        fadeAudio: function(...args) {
          calls.fades.push(args);
        },
        setMasterVolume: function(value) { calls.master.push(value); }
      }
    }
  };
  if (prepare) prepare(context);
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../js/pmjs-web/filesystem.js'), 'utf8'), context);
  vm.runInContext(audioSource, context, { filename: 'pmjs-rpgmaker/native-audio.js' });
  context.calls = calls;
  return context;
}

test('prepared encrypted views install through the ordinary voice lifecycle', () => {
  const context = contextFor();
  let fetches = 0;
  context.NativeHost.media.loadAudioView = (logical, options) => {
    assert.equal(logical, 'audio/bgm/theme.ogg');
    assert.equal(options.intent, 'music');
    return { handle: 12, duration: 4 };
  };
  const voice = context.PMJS.rpgmaker.audio.createVoice('music');
  voice.fetchEncrypted = () => { ++fetches; };
  assert.equal(voice.loadSource('audio/bgm/theme.ogg', () => ({ path: 'audio/bgm/theme.ogg_', decrypt() {} })), true);
  assert.equal(voice.handle, 12);
  assert.equal(voice.duration, 4);
  assert.equal(fetches, 0);
  voice.release();
  assert.deepEqual(context.calls.releases, [12]);
});

test('missing and rejected encrypted views retain the original encrypted path', () => {
  const context = contextFor();
  const voice = context.PMJS.rpgmaker.audio.createVoice('music');
  const fetched = [];
  const decrypt = () => {};
  voice.fetchEncrypted = (source, fn) => fetched.push([source, fn]);
  for (const loader of [() => null, () => { throw new Error('invalid header'); }]) {
    context.NativeHost.media.loadAudioView = loader;
    assert.equal(voice.loadSource('audio/bgm/theme.ogg', () => ({ path: 'audio/bgm/theme.ogg_', decrypt })), true);
  }
  assert.deepEqual(fetched, [['audio/bgm/theme.ogg_', decrypt], ['audio/bgm/theme.ogg_', decrypt]]);
  context.NativeHost.media.loadAudioView = () => { throw new Error('plaintext must bypass the view'); };
  voice.loadSource('audio/bgm/plain.ogg', () => null);
  assert.equal(voice.handle, 1);
});

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

test('a decoder failure reports once and delivers the ordinary stopped transition', () => {
  const context = contextFor();
  const warnings = [];
  context.console = { warn(message) { warnings.push(message); } };
  const voice = context.PMJS.rpgmaker.audio.createVoice();
  voice.loadPath('audio/bgm/theme.ogg');
  voice.play(true, 0);
  context.NativeHost.media.audioIsPlaying = () => false;
  context.NativeHost.media.audioError = () => 'audio loop produced no samples after restart';
  assert.equal(voice.pollNative(), 'stopped');
  assert.equal(voice.pollNative(), 'idle');
  assert.equal(voice.error, false, 'playback failure must not turn into a loading retry');
  assert.deepEqual(warnings, ['[pmjs-audio] playback failed: audio loop produced no samples after restart']);
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


test('voice initialization selects equal-power pan and absolute gain without changing defaults', () => {
  const context = contextFor();
  const audio = context.PMJS.rpgmaker.audio;
  const ordinary = audio.createVoice('effect');
  ordinary.volume = 0.5;
  ordinary.pan = 0.25;
  ordinary.loadSource('audio/se/tone.ogg');
  ordinary.play(false, 0);
  const absolute = audio.createVoice('music', { equalPowerPan: true, absoluteGain: 0.8 });
  absolute.pan = -0.5;
  absolute.loadSource('audio/bgm/theme.ogg');
  absolute.play(true, 0.25);
  assert.deepEqual(context.calls.params, [[1, 0.5, 1, 0.25], [2, 1, 1, 0], [2, 1, 1, 0]]);
  assert.deepEqual(context.calls.pans, [[2, -0.5], [2, -0.5]]);
  assert.deepEqual(context.calls.fades, [[2, 0.8, 0.8, 0, false, true]]);
});

test('source routing preserves normalized paths, intent, and independent replacement', () => {
  const context = contextFor();
  const loads = [];
  context.NativeHost.media.loadAudio = (path, options) => {
    loads.push([path, options.intent]);
    return { handle: loads.length, duration: 1 };
  };
  const first = context.PMJS.rpgmaker.audio.createVoice('effect');
  const second = context.PMJS.rpgmaker.audio.createVoice('music');
  first.loadSource('file:///game/audio/se/Town%20Bell.ogg?v=2', () => null);
  second.loadSource('audio/bgm/theme.ogg');
  first.loadSource('audio/se/other.ogg');
  assert.deepEqual(loads, [['audio/se/Town Bell.ogg', 'effect'], ['audio/bgm/theme.ogg', 'music'], ['audio/se/other.ogg', 'effect']]);
  assert.deepEqual(context.calls.releases, [1]);
  second.play(true, 0.5);
  assert.deepEqual(context.calls.plays, [[2, true, 0.5]]);
});

test('empty sources and an absent media host do not select encryption or attempt loading', () => {
  const context = contextFor();
  const voice = context.PMJS.rpgmaker.audio.createVoice();
  const unexpected = () => { throw new Error('source operation used'); };
  context.NativeHost.media.loadAudio = unexpected;
  assert.equal(voice.loadSource('', unexpected), false);
  context.NativeHost.media = null;
  assert.equal(voice.loadSource('audio/se/tone.ogg', unexpected), false);
});

test('explicit and target gain envelopes preserve their separate parameter scales', () => {
  const context = contextFor();
  const voice = context.PMJS.rpgmaker.audio.createVoice();
  voice.loadSource('audio/se/tone.ogg');
  voice.rampAbsoluteGain(2, 3, 0.5);
  assert.deepEqual(context.calls.params.at(-1), [1, 3, 1, 0]);
  assert.deepEqual(context.calls.fades.at(-1), [1, 2 / 3, 1, 0.5, false, true]);
  voice.setAbsoluteGain(2);
  assert.deepEqual(context.calls.params.at(-1), [1, 1, 1, 0]);
  assert.deepEqual(context.calls.fades.at(-1), [1, 2, 2, 0, false, true]);
  voice.setAbsoluteGain(3, 0.5);
  assert.deepEqual(context.calls.fades.at(-1), [1, -1, 3, 0.5, false, true]);
});


test('clear cancels deferred failure callbacks while retaining an independent voice', () => {
  const context = contextFor();
  context.console = { log() {}, error() {} };
  const audio = context.PMJS.rpgmaker.audio;
  const cleared = audio.createVoice('effect');
  const retained = audio.createVoice('music');
  retained.loadSource('audio/bgm/theme.ogg');
  let retries = 0;
  const resign = cleared.configureLoadRetry(() => retries++);
  const deferredFailure = cleared.onLoadError;
  context.NativeHost.media.loadAudio = () => { throw new Error('missing audio'); };
  cleared.reloadSource('audio/se/missing.ogg');
  assert.equal(cleared.pollNative(), 'loading');
  assert.equal(cleared.error, false);
  assert.equal(retries, 1);
  cleared.resetForClear({ duration: 0, offset: 0 });
  deferredFailure();
  resign();
  assert.equal(cleared.error, false);
  assert.equal(cleared.pollNative(), 'idle');
  assert.equal(retries, 1);
  retained.play(true, 0);
  assert.deepEqual(context.calls.plays, [[1, true, 0]]);
  assert.deepEqual(context.calls.releases, []);
});

for (const api of ['setAudioContextSuspended', 'bindAudioContext', 'audioContextTime']) {
  test('missing ' + api + ' rejects the add-on before audio initialization', () => {
    assert.throws(() => contextFor(context => { delete context.NativeHost.media[api]; }),
      new RegExp('missing media.' + api + '; install the matching native add-on'));
  });
}

test('context suspension is idempotent and new voices bind while suspended', async () => {
  const context = contextFor(), audio = context.PMJS.rpgmaker.audio;
  await audio.clock.suspend(); await audio.clock.suspend();
  const voice = audio.createVoice();
  voice.loadPath('audio/se/one.ogg');
  voice.loadPath('audio/se/two.ogg');
  assert.deepEqual(context.calls.bindings, [1, 2]);
  assert.deepEqual(context.calls.releases, [1]);
  assert.deepEqual(context.calls.suspensions, [true]);
  assert.equal(audio.clock.currentTime, 2.5);
  assert.equal(audio.clock.state, 'suspended');
  await audio.clock.resume(); await audio.clock.resume();
  assert.deepEqual(context.calls.suspensions, [true, false]);
  assert.equal(audio.clock.state, 'running');
  voice.release();
  assert.deepEqual(context.calls.releases, [1, 2]);
});

test('replacement and explicit release unregister finalization while abandoned voices release their handle', () => {
  let finalize;
  const registrations = new Map();
  const context = contextFor(context => {
    context.FinalizationRegistry = class {
      constructor(callback) { if (!finalize) finalize = callback; }
      register(target, handle) { registrations.set(target, handle); }
      unregister(target) { registrations.delete(target); }
    };
  });
  const voice = context.PMJS.rpgmaker.audio.createVoice();
  voice.loadPath('audio/se/one.ogg');
  voice.loadPath('audio/se/two.ogg');
  assert.equal(registrations.get(voice), 2);
  assert.deepEqual(context.calls.releases, [1]);
  voice.release();
  assert.equal(registrations.size, 0);
  assert.deepEqual(context.calls.releases, [1, 2]);
  const abandoned = context.PMJS.rpgmaker.audio.createVoice();
  abandoned.loadPath('audio/se/three.ogg');
  finalize(registrations.get(abandoned));
  assert.deepEqual(context.calls.releases, [1, 2, 3]);
});

test('audio path policy remains outside the shared URL decoder', () => {
  const context = contextFor(), paths = [];
  context.NativeHost.media.loadAudio = path => { paths.push(path); return { handle: paths.length, duration: 1 }; };
  const voice = context.PMJS.rpgmaker.audio.createVoice();
  voice.loadSource('file%3A%2F%2F%2Fgame%2Faudio%2Fname%2520.ogg?ignored');
  voice.loadSource('./audio/100%.ogg');
  assert.deepEqual(paths, ['audio/name%20.ogg', 'audio/100%.ogg']);
  assert.throws(() => voice.loadSource('audio/%FF.ogg'), /URI malformed/);
  assert.equal(paths.length, 2);
});
