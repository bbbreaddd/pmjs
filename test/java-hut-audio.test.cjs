'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
function setup(unknown = false) {
  const calls = [], hits = [];
  function Audio() { this._voice = { applyParameters() { calls.push(['pan', this.pan]); } }; }
  Audio.prototype.play = function(loop, offset) { calls.push(['native', loop, offset]); };
  const nativePlay = Audio.prototype.play;
  let install;
  const c = vm.createContext({ WebAudio: Audio, MzNativeWebAudio: Audio,
    __pmjsBuiltinRequire: require, NativeHost: { media: { setAudioStereoBalance() {} } },
    JavaHut: { AudioManagerEx: { Param: { AMEXdamp: true } } },
    PMJS: { compat: { hit(...args) { hits.push(args); } }, phases: { on(phase, owner, fn) { install = fn; } } } });
  const play = function(loop, offset) { this._loop = loop; return this._startPlaying(offset || 0); };
  const start = function() { throw new Error('browser audio nodes'); };
  const panner = function() { throw new Error('browser panner'); };
  const functions = { play, _startPlaying: start, _updatePanner: panner };
  const source = fs.readFileSync(require.resolve('../js/pmjs-mz/java-hut-audio.js'), 'utf8')
    .replace(/(\w+): '[a-f0-9]{64}'/g, (text, name) => name + ": '" + crypto.createHash('sha256')
      .update(functions[name].toString()).digest('hex') + "'");
  require('./helpers/runtime-context.cjs').runModule(c, 'js/pmjs-core/methods.js');
  vm.runInContext(source, c);
  Audio.prototype.play = play; Audio.prototype._startPlaying = start; Audio.prototype._updatePanner = panner;
  if (unknown) Audio.prototype._startPlaying = function() { return 'unreviewed'; };
  install();
  return { Audio, calls, hits, play, nativePlay, panner };
}
test('reviewed graph startup retains public routing and reaches native playback and live panning', () => {
  const { Audio, calls, hits, play } = setup();
  assert.equal(Audio.prototype.play, play);
  const audio = new Audio(); audio.pan = -0.5;
  const effective = audio.play; audio.play = function() { calls.push(['later']); return effective.apply(this, arguments); };
  audio.play(true, 0.25); audio._updatePanner();
  assert.equal(audio._voice.stereoBalance, true);
  assert.deepEqual(calls, [['later'], ['native', true, 0.25], ['pan', -0.5]]);
  assert.deepEqual(hits, []);
});
test('unreviewed graph methods retain guest behavior without partial replacement', () => {
  const { Audio, hits, panner } = setup(true);
  assert.equal(new Audio()._startPlaying(), 'unreviewed');
  assert.equal(Audio.prototype._updatePanner, panner); assert.equal(hits.length, 1);
});
test('unavailable graph effects fail explicitly before native playback', () => {
  const { Audio, calls, hits } = setup();
  const audio = new Audio(); audio._convRef = 'impulse';
  assert.throws(() => audio.play(false, 0), /unsupported native audio graph/);
  assert.deepEqual(calls, []); assert.equal(hits[0][0], 'plugins.java-hut.audio-graph');
});
