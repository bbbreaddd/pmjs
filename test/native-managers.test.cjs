'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { installTextManager, installSoundManager } = require('../runner/native-managers.cjs');

test('text terms follow database edits, method overrides and configurable getters', () => {
  const scope = { $dataSystem: { currencyUnit: 'G', terms: { basic: ['Level'], params: ['HP'], commands: [], messages: { emerge: '%1 appears' } } } };
  installTextManager(scope);
  const text = scope.TextManager;
  assert.equal(text.level, 'Level'); assert.equal(text.param(0), 'HP');
  assert.equal(text.emerge, '%1 appears'); assert.equal(text.currencyUnit, 'G');
  scope.$dataSystem.terms.basic[0] = 'Rank'; assert.equal(text.level, 'Rank');
  const original = text.basic;
  text.basic = function(id) { return original.call(this, id).toUpperCase(); };
  assert.equal(text.level, 'RANK'); assert.equal(text.command(100), '');
  Object.defineProperty(text, 'level', { value: 'Custom', configurable: true });
  assert.equal(text.level, 'Custom');
  scope.$dataSystem = { currencyUnit: 'Coins', terms: { basic: ['Tier'] } };
  assert.equal(text.currencyUnit, 'Coins'); assert.equal(text.levelA, '');
});

test('system sound helpers honor aliases and delegate playback to the native session', () => {
  const calls = [], scope = { $dataSystem: { sounds: Array.from({length: 24}, (_, i) => i) }, AudioManager: { playStaticSe(index) { calls.push(['play', index]); }, loadStaticSe(index) { calls.push(['load', index]); } } };
  installSoundManager(scope, { managerInvoke(...args) { calls.push(args); } }, 'session');
  const sound = scope.SoundManager, original = sound.playSystemSound;
  sound.playSystemSound = function(index) { this.lastIndex = index; return original.call(this, index); };
  sound.playEnemyDamage(); sound.playUseSkill(); sound.preloadImportantSounds();
  assert.equal(sound.lastIndex, 23);
  assert.deepEqual(calls, [['play', 10], ['play', 23], ...[0, 1, 2, 3].map(index => ['load', index])]);
});

test('audio manager uses stock playback hooks and reuses static native buffers', () => {
  const vm = require('node:vm'), channels = {}, calls = [];
  const scope = vm.createContext({ Decrypter: { hasEncryptedAudio: false }, Graphics: { setVideoVolume(value) { calls.push(['video', value]); } } });
  class Voice {
    static canPlayOgg() { return true; }
    static setMasterVolume(value) { calls.push(['master', value]); }
    constructor(url) { this.url = url; this.playing = false; }
    play(loop, pos) { this.playing = true; this.pos = pos; calls.push(['play', this.url, loop, pos]); }
    stop() { this.playing = false; }
    isPlaying() { return this.playing; }
    isError() { return false; }
    seek() { return this.pos; }
    fadeIn() {} fadeOut() {} addStopListener() {}
  }
  scope.WebAudio = Voice;
  const backend = { audioManager(_session, kind, operation, value) {
    const state = channels[kind] ||= { volume: 100, buffer: null, current: null, buffers: [] };
    if (arguments.length > 3) state[operation] = value;
    return state[operation];
  } };
  require('../runner/native-managers.cjs').installAudioManager(scope, backend, null, { wrap: value => value, handle: value => value }, values => values,
    { scope, runScript: source => vm.runInContext(source, scope) });
  const audio = scope.AudioManager, original = audio.updateBufferParameters;
  let updates = 0;
  audio.updateBufferParameters = function(...args) { ++updates; return original.apply(this, args); };
  const sound = { name: 'Tone', volume: 80, pitch: 100, pan: 0 };
  audio.playBgm(sound, 7);
  assert.equal(audio._bgmBuffer.volume, 0.8);
  assert.equal(audio.saveBgm().pos, 7);
  audio.bgmVolume = 125.5;
  assert.equal(audio.bgmVolume, 125.5);
  assert.equal(audio._bgmBuffer.volume, 1.004);
  audio.loadStaticSe(sound); const voice = audio._staticBuffers[0];
  audio.playStaticSe(sound); audio.playStaticSe(sound);
  assert.equal(audio._staticBuffers.length, 1); assert.equal(audio._staticBuffers[0], voice);
  assert.equal(audio.isStaticSe(sound), true);
  audio.masterVolume = 0.4;
  assert.deepEqual(calls.slice(-2), [['master', 0.4], ['video', 0.4]]);
  assert.ok(updates >= 4);
  assert.doesNotThrow(() => audio.checkErrors());
});
