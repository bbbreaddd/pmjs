'use strict';

const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
process.env.PMJS_AUDIO_DIAGNOSTICS = '0';
const native = require(path.resolve(process.argv[2]));
fs.writeFileSync(path.join(path.resolve(process.argv[3]), 'fixture-encrypted.rpgmvo'),
  Buffer.concat([Buffer.from('encrypted-fixture'), wavBytes()]));
const emptyPacketBytes = Buffer.from(fs.readFileSync(path.join(__dirname, 'assets/empty-packet.ogg.b64'), 'utf8'), 'base64');
fs.writeFileSync(path.join(path.resolve(process.argv[3]), 'empty-packet.ogg'), emptyPacketBytes);
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
assert.equal(shared.hits, 0, 'cache hit instrumentation is disabled');
assert.equal(shared.misses, 0, 'cache miss instrumentation is disabled');
assert.equal(shared.entries - initial.entries, 1, 'identified bytes share one cache entry');
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
const fromFile = native.media.loadAudio('empty-packet.ogg', { intent: 'effect' });
const fromBytes = native.media.loadAudioBytes(emptyPacketBytes,
  { intent: 'effect', resourceIdentity: 'empty-packet-regression' });
assert.ok(fromFile.duration > 0.09 && fromFile.duration < 0.15, 'empty final packet preserves audible samples');
assert.equal(fromBytes.duration, fromFile.duration);
for (const handle of [fromFile.handle, fromBytes.handle]) native.media.releaseAudio(handle);
assert.equal(native.media.audioStats().sampleVoices, 0);
async function contextContracts() {
  const mutedLoop = native.media.loadAudioBytes(wavBytes());
  try {
    assert.equal(native.media.playAudio(mutedLoop.handle, true, 0), true);
    assert.equal(native.media.fadeAudio(mutedLoop.handle, 0, 0, 0, false), true);
    assert.equal(native.media.fadeAudio(mutedLoop.handle, -1, 0, 0.01, true), true);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(native.media.audioIsPlaying(mutedLoop.handle), false);
  } finally { native.media.releaseAudio(mutedLoop.handle); }
  native.media.setAudioContextSuspended(true);
  const time = native.media.audioContextTime();
  const intrinsic = native.media.createAudioGain(1);
  native.media.scheduleAudioGain(intrinsic, false, Math.fround(0.3), time, true);
  native.media.scheduleAudioGain(intrinsic, true, 0.8, time + 1);
  native.media.cancelAudioGain(intrinsic, 0);
  assert.equal(native.media.audioGainValue(intrinsic), Math.fround(0.3),
    'cancellation retains the intrinsic value through the production binding');
  native.media.releaseAudioGain(intrinsic);
  const gain = native.media.createAudioGain(0.2);
  native.media.scheduleAudioGain(gain, false, 0.2, time);
  native.media.scheduleAudioGain(gain, true, 0.8, time + 0.1);
  const voice = native.media.loadAudioBytes(wavBytes(48000), { intent: 'effect', resourceIdentity: 'clock-contract' });
  assert.equal(native.media.bindAudioGain(voice.handle, gain), true);
  native.media.playAudio(voice.handle, false, 0);
  const position = native.media.audioPosition(voice.handle);
  const separate = native.media.loadAudioBytes(wavBytes(48000));
  native.media.playAudio(separate.handle, true, 0);
  const contextOnly = native.media.loadAudioBytes(wavBytes(48000));
  assert.equal(native.media.bindAudioContext(contextOnly.handle), true);
  native.media.playAudio(contextOnly.handle, true, 0);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(native.media.audioContextTime(), time, 'suspension freezes output time');
  assert.equal(native.media.audioPosition(voice.handle), position, 'suspension freezes source consumption');
  assert.equal(native.media.audioPosition(contextOnly.handle), 0, 'context ownership does not require gain automation');
  assert.ok(native.media.audioPosition(separate.handle) > 0, 'independent media consumes PCM while context time is frozen');
  assert.ok(Math.abs(native.media.audioGainValue(gain) - 0.2) < 1e-6);
  native.media.setAudioContextSuspended(false);
  await new Promise(resolve => setTimeout(resolve, 60));
  native.media.setAudioContextSuspended(true);
  const elapsed = native.media.audioContextTime() - time;
  assert.ok(elapsed > 0 && native.media.audioPosition(voice.handle) > position, 'resume advances context and source together');
  assert.ok(native.media.audioPosition(contextOnly.handle) > 0, 'context-owned media resumes without automation');
  const value = native.media.audioGainValue(gain);
  assert.ok(Math.abs(value - (0.2 + 0.6 * Math.min(1, (elapsed - 1 / 48000) / 0.1))) < 1e-6,
    'gain reads expose the last mixed sample on the context clock');
  native.media.scheduleAudioGain(gain, false, Math.fround(0.6), time + elapsed, true);
  assert.equal(native.media.audioGainValue(gain), Math.fround(0.6), 'property assignment is immediately readable');
  native.media.scheduleAudioGain(gain, false, value, time + elapsed, true);
  native.media.stopAudio(voice.handle);
  assert.equal(native.media.audioGainValue(gain), value, 'stopping a voice preserves automation');
  native.media.playAudio(voice.handle, false, 0);
  assert.equal(native.media.audioGainValue(gain), value, 'replay preserves automation');
  assert.equal(native.media.releaseAudioGain(gain), true);
  assert.equal(native.media.releaseAudioGain(gain), false, 'automation owner releases once');
  native.media.setAudioContextSuspended(false);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(native.media.audioPosition(voice.handle) > 0, 'bound voice retains automation after owner release');
  native.media.releaseAudio(voice.handle);
  native.media.releaseAudio(contextOnly.handle);
  native.media.releaseAudio(separate.handle);
  native.runtime.quit();
  console.log('[pmjs-node-audio-bytes] ready');
}
contextContracts().catch(error => { console.error(error); native.runtime.quit(); process.exitCode = 1; });
