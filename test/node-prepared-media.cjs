'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const path = require('node:path');
const { png } = require('./helpers/png.cjs');
const { prepareAssets } = require('../runner/asset-preparation.cjs');
const { createGameFilesystem } = require('../runner/storage.cjs');
const native = require(path.resolve(process.argv[2]));
const engine = process.argv[3] || 'MZ';
assert.ok(engine === 'MV' || engine === 'MZ');
const imageSource = 'img/characters/!$actor.' + (engine === 'MV' ? 'rpgmvp' : 'png_');
const audioExtension = engine === 'MV' ? '.rpgmvo' : '.ogg_';
const root = temporaryDirectory('pmjs-prepared-media-');
const gameRoot = path.join(root, 'game');
for (const directory of ['data', 'img/characters', 'img/pictures', 'audio/bgm', 'audio/se']) {
  fs.mkdirSync(path.join(gameRoot, directory), { recursive: true });
}
const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
function encrypt(bytes) {
  const body = Buffer.from(bytes);
  for (let i = 0; i < 16; ++i) body[i] ^= key[i];
  return Buffer.concat([Buffer.from('5250474d560000000003010000000000', 'hex'), body]);
}
const systemFile = path.join(gameRoot, 'data/System.json');
fs.writeFileSync(systemFile, JSON.stringify({ hasEncryptedImages: true, hasEncryptedAudio: true,
  encryptionKey: key.toString('hex') }));
const width = 96, height = 128;
const pixels = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; ++y) for (let x = 0; x < width; ++x) {
  if (x % 32 >= 8 && x % 32 < 24 && y % 32 >= 10 && y % 32 < 22) {
    pixels.set([x % 32 * 7, y % 32 * 5, 93, 255], (y * width + x) * 4);
  }
}
const imageBytes = png(width, height, pixels);
fs.writeFileSync(path.join(gameRoot, imageSource), encrypt(imageBytes));
const dense = Buffer.alloc(90 * 60 * 4);
for (let y = 0; y < 60; ++y) for (let x = 0; x < 90; ++x) {
  dense.set([x * 13 % 256, y * 17 % 256, (x + y) % 256, 255], (y * 90 + x) * 4);
}
fs.writeFileSync(path.join(gameRoot, 'img/pictures/dense.png'), png(90, 60, dense));
const wav = Buffer.alloc(44 + 480 * 4);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28);
wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
wav.writeUInt32LE(wav.length - 44, 40);
for (const folder of ['bgm', 'se']) {
  fs.writeFileSync(path.join(gameRoot, 'audio', folder, 'tone' + audioExtension), encrypt(wav));
}
native.initialize({ gameRoot, assetRoot: '', width: 128, height: 128, windowTitle: 'prepared media' });

async function main() {
  const pageCodec = process.argv[4] || 'png';
  // Materialized aliases remain supported for addons without audio-view capability.
  const options = { gameRoot, cacheRoot: path.join(root, 'cache'),
    native: { assets: native.assets, fs: native.fs }, pageCodec,
    workspaceBytes: engine === 'MV' ? 0 : 64 * 1024 * 1024 };
  assert.match(native.assets.preparationLz4Version, /^lz4-1\.10\.0-indexed-palette-v3$/);
  assert.equal(native.assets.preparationWorkspaceVersion, 1);
  for (const workspaceBytes of [-1, 0.5, 268435457])
    assert.throws(() => native.assets.processImage(imageSource, path.join(root, 'invalid-workspace'), null,
      path.join(gameRoot, imageSource), null, { workspaceBytes }), /workspaceBytes must be an integer/);
  const cold = await prepareAssets(options);
  assert.ok(cold.entries[0].descriptor.pages.every(page => page.path.endsWith(pageCodec === 'lz4' ? '.pml4' : '.png')));
  assert.throws(() => native.assets.processImage(imageSource, path.join(root, 'invalid-codec'), null,
    path.join(gameRoot, imageSource), null, { pageCodec: 'lz4hc3' }), /pageCodec must be png or lz4/);
  assert.equal(native.assets.preparationVersion.processor, 'images-v25-auto-texture-chunks-astcenc4.7');
  assert.equal(cold.decrypted, 3);
  const partial = native.assets.installDecrypted([{ ...cold.decryptedEntries[0], source: 'invalid', fileHash: 'bad' }, ...cold.decryptedEntries], false, true);
  assert.equal(partial.accepted.length, 3);
  assert.equal(partial.rejected.length, 1);
  assert.equal(partial.rejected[0].id, 'invalid');
  assert.equal(cold.installed, pageCodec === 'lz4' ? 2 : 1);
  assert.equal(cold.fallback, pageCodec === 'lz4' ? 0 : 1, 'LZ4 retains standalone pages; PNG requires a layout saving');
  const stateRoot = path.join(options.cacheRoot, 'preparation-v1', fs.readdirSync(path.join(options.cacheRoot, 'preparation-v1'))[0]);
  const records = Object.entries(JSON.parse(fs.readFileSync(path.join(stateRoot, 'preparation-state.json'))).data.results);
  const negative = records.find(([, record]) => record.descriptor === null && !record.decrypted);
  if (pageCodec === 'png') {
    assert.ok(negative, 'unprofitable image decision was not cached');
    assert.deepEqual(fs.readdirSync(path.join(stateRoot, negative[0])), [], 'rejected pages and temporary tiles leaked');
  } else assert.equal(negative, undefined, 'LZ4 standalone page was negatively cached');
  assert.equal(cold.entries[0].descriptor.cells.length, 12, 'all character cells retained');
  assert.deepEqual(Buffer.from(native.fs.readBytes('audio/bgm/tone.ogg')), wav);
  const original = native.images.loadBytes(imageBytes);
  const prepared = await native.images.loadAsync('img/characters/!$actor.png');
  assert.deepEqual([prepared.width, prepared.height], [width, height]);
  const canvas = native.canvas.create(width, height);
  native.canvas.drawImage(canvas.handle, original.handle, 0, 0, width, height, 0, 0, width, height, 1);
  const expected = Buffer.from(native.canvas.readPixels(canvas.handle, 0, 0, width, height));
  native.canvas.clear(canvas.handle);
  native.canvas.drawImage(canvas.handle, prepared.handle, 0, 0, width, height, 0, 0, width, height, 1);
  assert.deepEqual(Buffer.from(native.canvas.readPixels(canvas.handle, 0, 0, width, height)), expected);
  const music = native.media.loadAudio('audio/bgm/tone.ogg', { intent: 'music' });
  const effect = native.media.loadAudio('audio/se/tone.ogg', { intent: 'effect' });
  assert.equal(music.duration, effect.duration);
  assert.ok(music.duration > 0);
  assert.equal(native.media.playAudio(music.handle, true, 0), true);
  assert.equal(native.media.playAudio(effect.handle, false, 0), true);
  const warm = await prepareAssets(options);
  assert.equal(warm.validation.hashedFiles, 0);
  assert.equal(warm.generated, 0);
  assert.equal(warm.hits, 4);
  assert.equal(warm.negativeHits, pageCodec === 'lz4' ? 0 : 1);
  assert.equal(warm.decrypted, 3);
  native.assets.installDecrypted(warm.decryptedEntries, true);
  const drifted = warm.decryptedEntries.map(entry => {
    const drift = identity => { if (!identity) return identity; const parts = identity.split(':'); parts[parts.length - 6] = String(BigInt(parts[parts.length - 6]) + 1n); return parts.join(':'); };
    return { ...entry, sourceIdentity: drift(entry.sourceIdentity), settingsIdentity: drift(entry.settingsIdentity), fileIdentity: drift(entry.fileIdentity) };
  });
  native.assets.installDerivedCatalog(drifted);
  assert.deepEqual(Buffer.from(native.fs.readBytes('audio/bgm/tone.ogg')), wav,
    'encrypted source/settings/output inode drift must retain verified plaintext');
  const failed = drifted.map(entry => ({ ...entry, fileHash: '0'.repeat(64) }));
  native.assets.installDerivedCatalog(failed);
  assert.equal(native.assets.hasDecrypted('audio/bgm/tone.ogg'), false, 'wrong decrypted content hash must refuse inode recovery');
  native.assets.installDerivedCatalog(warm.decryptedEntries);
  native.assets.consumePreparationInvalidations();
  native.fs = createGameFilesystem(native.fs, path.join(root, 'writable'));
  const replacementPixels = Buffer.alloc(16, 255);
  native.fs.writeBytes('img/characters/!$actor.png', png(2, 2, replacementPixels));
  const overridden = await prepareAssets(options);
  assert.ok(overridden.validation.hashedFiles > 0, 'new overlay files are inventoried before preparation');
  const changedImage = await native.images.loadAsync('img/characters/!$actor.png');
  assert.deepEqual([changedImage.width, changedImage.height], [2, 2]);
  native.images.release(changedImage.handle);
  fs.writeFileSync(systemFile, JSON.stringify({ hasEncryptedImages: true, hasEncryptedAudio: true,
    encryptionKey: 'ff'.repeat(16) }));
  native.assets.consumePreparationInvalidations();
  assert.equal(native.assets.hasDecrypted('audio/bgm/tone.ogg'), false);
  assert.equal(native.assets.consumePreparationInvalidations(), 3, 'changed encryption settings invalidate affected prepared resources');
  assert.equal(native.assets.hasDecrypted('img/characters/!$actor.png'), true,
    'explicit plaintext replacements remain readable independently of encryption settings');
  fs.rmSync(options.cacheRoot, { recursive: true, force: true });
  for (let frame = 0; frame < 61; ++frame) native.beginFrame();
  native.canvas.clear(canvas.handle);
  native.canvas.drawImage(canvas.handle, prepared.handle, 0, 0, width, height, 0, 0, width, height, 1);
  assert.deepEqual(Buffer.from(native.canvas.readPixels(canvas.handle, 0, 0, width, height)), expected,
    'retained prepared image survives invalidation, cache removal and page eviction');
  assert.equal(native.media.audioIsPlaying(music.handle), true, 'retained music voice survives cache removal');
  native.media.releaseAudio(music.handle); native.media.releaseAudio(effect.handle);
  native.images.release(original.handle); native.images.release(prepared.handle); native.canvas.release(canvas.handle);
  console.log('[pmjs-prepared-media] ' + engine + ' images, audio, warm reuse, pixel identity and retained owners passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  native.runtime.quit(); fs.rmSync(root, { recursive: true, force: true });
});
