'use strict';

const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
process.env.PMJS_AUDIO_DIAGNOSTICS = '0';
const native = require(path.resolve(process.argv[2]));
fs.writeFileSync(path.join(path.resolve(process.argv[3]), 'fixture-encrypted.rpgmvo'),
  Buffer.concat([Buffer.from('encrypted-fixture'), wavBytes()]));
native.initialize({gameRoot:path.resolve(process.argv[3]),assetRoot:'',width:640,height:480,windowTitle:'pmjs test'});

function wavBytes(frames = 480) {
  const dataSize = frames * 2 * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(48000, 24); buffer.writeUInt32LE(48000 * 4, 28);
  buffer.writeUInt16LE(4, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

const audio = native.media.loadAudioBytes(wavBytes());
if (!audio.handle || audio.duration <= 0) throw new Error('audio bytes did not decode');
assert.equal(native.media.audioStats().sampleVoices, 0);
assert.equal(native.media.audioStats().streamVoices, 1);
assert.equal(native.media.audioStats().diagnostics, false);
assert.equal('workerCpuUs' in native.media.audioStats(), false);
assert.equal(typeof native.media.setSampleCacheLimits, 'undefined');
native.media.releaseAudio(audio.handle);

let malformedRejected = false;
try { native.media.loadAudioBytes(Uint8Array.from([1, 2, 3, 4])); }
catch (error) {
  malformedRejected = /cannot open media bytes:/.test(error.message);
}
if (!malformedRejected) throw new Error('malformed audio bytes were accepted');

let oversizedRejected = false;
try { native.media.loadAudioBytes(new ArrayBuffer(64 * 1024 * 1024 + 1)); }
catch (_) { oversizedRejected = true; }
if (!oversizedRejected) throw new Error('oversized audio bytes were accepted');

const options = { intent: 'effect', resourcePath: 'fixture-encrypted.rpgmvo' };
const initial = native.media.audioStats();
const first = native.media.loadAudioBytes(wavBytes(), options);
const second = native.media.loadAudioBytes(wavBytes(), options);
assert.notEqual(first.handle, second.handle);
const shared = native.media.audioStats();
assert.equal(shared.hits - initial.hits, 1);
assert.equal(shared.sampleVoices, 2);
assert.equal(shared.cacheBytes, 480 * 2 * 4, 'identified bytes retain PCM only');
assert.equal(first.duration, second.duration);
assert.throws(() => native.media.loadAudioBytes(wavBytes(), { intent: 'unsupported' }), /audio intent/);
fs.writeFileSync(path.join(path.resolve(process.argv[3]), 'replacement.rpgmvo'), wavBytes(960));
fs.renameSync(path.join(path.resolve(process.argv[3]), 'replacement.rpgmvo'),
  path.join(path.resolve(process.argv[3]), 'fixture-encrypted.rpgmvo'));
const replacement = native.media.loadAudioBytes(wavBytes(960), options);
assert.notEqual(replacement.duration, first.duration);
assert.equal(native.media.audioStats().entries, 2);
const anonymous = native.media.loadAudioBytes(wavBytes(), { intent: 'effect' });
assert.equal(native.media.audioStats().streamVoices, 1, 'anonymous effect bytes stream');
assert.equal(native.media.audioStats().entries, 2);
for (const handle of [first.handle, second.handle, replacement.handle, anonymous.handle])
  native.media.releaseAudio(handle);
const released = native.media.audioStats();
assert.equal(released.sampleVoices, 0);
assert.equal(released.streamVoices, 0);
assert.equal(released.livePcmBytes, released.cacheBytes);
console.log('[pmjs-node-audio-bytes] ready');
