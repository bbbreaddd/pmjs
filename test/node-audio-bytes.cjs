'use strict';

const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({gameRoot:path.resolve(process.argv[3]),assetRoot:'',width:640,height:480,windowTitle:'pmjs test'});

function wavBytes() {
  const frames = 480;
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

console.log('[pmjs-node-audio-bytes] ready');
