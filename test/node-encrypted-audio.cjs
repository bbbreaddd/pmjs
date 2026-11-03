'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { createGameFilesystem } = require('../runner/storage.cjs');
const { prepareAssets } = require('../runner/asset-preparation.cjs');
const native = require(path.resolve(process.argv[2]));
const root = temporaryDirectory('node-audio-views-');
const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
function wav(frames) {
  const b = Buffer.alloc(44 + frames * 4);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(48000, 24); b.writeUInt32LE(192000, 28); b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(b.length - 44, 40); return b;
}
function encrypt(bytes) {
  const b = Buffer.concat([Buffer.from('5250474d560000000003010000000000', 'hex'), bytes]);
  for (let i = 0; i < 16; ++i) b[16 + i] ^= key[i]; return b;
}
fs.mkdirSync(path.join(root, 'audio/bgm'), { recursive: true });
fs.writeFileSync(path.join(root, 'audio/bgm/test.ogg_'), encrypt(wav(4800)));
fs.writeFileSync(path.join(root, 'audio/bgm/original.ogg_'), encrypt(wav(4800)));
fs.writeFileSync(path.join(root, 'audio/bgm/original.ogg'), wav(19200));
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
fs.writeFileSync(path.join(root, 'data/System.json'), JSON.stringify({
  hasEncryptedAudio: true, encryptionKey: key.toString('hex') }));
native.initialize({ gameRoot: root, width: 64, height: 64, windowTitle: 'audio views' });
const host = createGameFilesystem(native.fs, path.join(root, 'save/game-files'));
const entry = { source: 'audio/bgm/test.ogg_', logicalSource: 'audio/bgm/test.ogg', key: key.toString('hex') };
assert.equal(native.media.installAudioViews([entry]), 1);
const first = native.media.loadAudioView(entry.logicalSource, { intent: 'music' });
assert.equal(first.duration, 0.1);
host.writeBytes(entry.source, encrypt(wav(9600)));
const replaced = native.media.loadAudioView(entry.logicalSource, { intent: 'music' });
assert.equal(replaced.duration, 0.2, 'new opens use the current encrypted overlay');
assert.equal(native.media.audioIsPlaying(first.handle), false);
assert.equal(native.media.playAudio(first.handle, true, 0.05), true, 'the earlier decoder retains its open file');
host.writeBytes(entry.logicalSource, wav(14400));
const plain = native.media.loadAudioView(entry.logicalSource, { intent: 'music' });
assert.equal(plain.duration, 0.3, 'plaintext overlay has precedence');
host.remove(entry.logicalSource);
const originalEntry = { ...entry, source: 'audio/bgm/original.ogg_', logicalSource: 'audio/bgm/original.ogg' };
assert.equal(native.media.installAudioViews([entry, originalEntry]), 2);
const originalPlain = native.media.loadAudioView(originalEntry.logicalSource, { intent: 'music' });
assert.equal(originalPlain.duration, 0.4, 'plaintext original has precedence');
host.writeBytes(entry.source, Buffer.alloc(32));
assert.throws(() => native.media.loadAudioView(entry.logicalSource), /signature|header/);
assert.equal(native.media.installAudioViews([entry]), 0, 'unsupported views remain eligible for the legacy loader');
assert.equal(native.media.loadAudioView(entry.logicalSource), null);
assert.throws(() => native.media.installAudioViews([{ ...entry, source: '../outside' }]), /mapping/);
for (const audio of [first, replaced, plain, originalPlain]) native.media.releaseAudio(audio.handle);
assert.equal(native.media.audioStats().streamVoices, 0);
native.media.installAudioViews([]);
console.log('audio view binding, encrypted overlay, plaintext precedence, open-file lifetime and rejection passed');

async function preparation() {
  host.writeBytes(entry.source, encrypt(wav(4800)));
  const options = { gameRoot: root, cacheRoot: path.join(root, 'cache'), native };
  const cold = await prepareAssets(options);
  assert.equal(cold.error, undefined);
  assert.equal(cold.audioViews, 2);
  assert.equal(cold.decrypted, 0);
  assert.equal(cold.validation.hashedBytes, fs.statSync(path.join(root, 'data/System.json')).size);
  const preparationRoot = path.join(options.cacheRoot, 'preparation-v1');
  const entryRoot = path.join(preparationRoot, fs.readdirSync(preparationRoot)[0], 'entries');
  assert.deepEqual(fs.readdirSync(entryRoot), []);
  const warm = await prepareAssets(options);
  assert.equal(warm.validation.hashedFiles, 0);
  assert.equal(warm.generated, 0);
  assert.equal(warm.audioViews, 2);
  const audio = native.media.loadAudioView(entry.logicalSource, { intent: 'music' });
  assert.equal(audio.duration, first.duration);
  native.media.releaseAudio(audio.handle);
  console.log('default preparation and warm reuse register playable views without audio payload output');
}
preparation().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => native.runtime.quit());
