'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { png } = require('./helpers/png.cjs');
const { prepareGameAssets } = require('../runner/preparation.cjs');
const { loadCatalog } = require('../runner/preparation-catalog.cjs');
const { reader } = require('../runner/port-preparation.cjs');
const native = require(path.resolve(process.argv[2]));
const root = temporaryDirectory('node-preparation-catalog-');
const gameRoot = path.join(root, 'game');
const source = 'img/pictures/sparse.png';
fs.mkdirSync(path.dirname(path.join(gameRoot, source)), { recursive: true });
const pixels = Buffer.alloc(128 * 128 * 4);
for (let y = 48; y < 64; ++y) for (let x = 48; x < 64; ++x)
  pixels.set([x * 3, y * 3, x + y, 255], (y * 128 + x) * 4);
const image = png(128, 128, pixels);
fs.writeFileSync(path.join(gameRoot, source), image);
const jpeg = Buffer.from(fs.readFileSync(path.join(__dirname, 'assets/fixture.jpg.b64'), 'utf8'), 'base64');
fs.writeFileSync(path.join(gameRoot, 'img/pictures/jpeg.png'), jpeg);
const recovered = Buffer.from(image);
for (let offset = 8; offset < recovered.length;) {
  const length = recovered.readUInt32BE(offset);
  if (recovered.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
    recovered[offset + 8 + length - 1] ^= 1;
    let crc = 0xffffffff;
    for (const byte of recovered.subarray(offset + 4, offset + 8 + length)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; ++bit) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    recovered.writeUInt32BE((crc ^ 0xffffffff) >>> 0, offset + 8 + length);
  }
  offset += length + 12;
}
fs.writeFileSync(path.join(gameRoot, 'img/pictures/recovered.png'), recovered);
const encryptionKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const encrypted = Buffer.from(image);
for (let i = 0; i < 16; ++i) encrypted[i] ^= encryptionKey[i];
const encryptedSource = 'img/pictures/secret.png_';
fs.writeFileSync(path.join(gameRoot, encryptedSource), Buffer.concat([
  Buffer.from('5250474d560000000003010000000000', 'hex'), encrypted ]));
fs.mkdirSync(path.join(gameRoot, 'data'), { recursive: true });
fs.writeFileSync(path.join(gameRoot, 'data/System.json'), JSON.stringify({
  hasEncryptedImages: true, encryptionKey: encryptionKey.toString('hex') }));
const processorDir = path.join(root, 'processors');
fs.mkdirSync(processorDir);
const processor = path.join(processorDir, 'fixture.pmjs-processor.cjs');
fs.writeFileSync(processor, "module.exports={id:'fixture',version:1,outputs:[{id:'data',source:'data/System.json',generate(){return Buffer.from('correct')}}]}");
native.initialize({ gameRoot, width: 64, height: 64, windowTitle: 'catalog test' });

async function run() {
  const options = { gameRoot, cacheRoot: path.join(root, 'cache'), native, maps: false,
    fastStartup: true, pageCodec: 'png', adapters: [processor], recipes: [{ source,
      sourceHash: crypto.createHash('sha256').update(image).digest('hex'),
      grid: [1, 1], backdrop: [0, 0, 0, 0] }] };
  const cold = await prepareGameAssets(options);
  assert.equal(cold.images.failedFiles, 0);
  assert.equal(cold.catalogSaved, true);
  assert.equal(cold.images.entries.length, 2);
  assert.equal(cold.images.decryptedEntries.length, 1);
  assert.ok(cold.images.decryptedEntries[0].fileIdentity);
  assert.ok(cold.images.entries[0].pageIdentities.length);
  cold.releaseCacheLease();
  const reused = await prepareGameAssets(options);
  assert.equal(reused.images.negativeHits, 2);
  assert.equal(reused.images.generated, 0);
  reused.releaseCacheLease();
  const warm = await loadCatalog(options);
  assert.ok(warm?.images.catalogHit);
  assert.equal(warm.images.installed, 2);
  assert.ok(native.assets.hasDecrypted('img/pictures/secret.png'));
  for (const filename of ['jpeg.png', 'recovered.png']) {
    const loaded = native.images.load('img/pictures/' + filename);
    assert.ok(loaded.handle);
    assert.ok(loaded.width > 0 && loaded.height > 0);
    native.images.release(loaded.handle);
  }
  native.assets.consumePreparationInvalidations();
  native.assets.consumePreparationFailures();
  fs.unlinkSync(warm.images.decryptedEntries[0].file);
  assert.equal(native.assets.hasDecrypted('img/pictures/secret.png'), false);
  assert.equal(native.assets.consumePreparationInvalidations(), 3);
  assert.deepEqual(native.assets.consumePreparationFailures(), []);
  await warm.invalidateCatalog();
  const artifact = warm.portArtifacts.get('fixture/data');
  assert.equal(reader(warm.portArtifacts, native.assets.decompressPortArtifact,
    { hashes: warm.portArtifactHashes })('fixture/data').toString(), 'correct');
  fs.writeFileSync(artifact, native.assets.compressPortArtifact(Buffer.from('altered')));
  let invalidation;
  assert.equal(reader(warm.portArtifacts, native.assets.decompressPortArtifact, { hashes: warm.portArtifactHashes,
    onInvalid: id => { invalidation = warm.invalidate(id); } })('fixture/data'), null);
  await invalidation;
  warm.releaseCacheLease();
  assert.equal(await loadCatalog(options), null);
  const broken = 'img/pictures/jpeg.png';
  fs.writeFileSync(path.join(gameRoot, broken), image.subarray(0, 40));
  const failed = await prepareGameAssets(options);
  assert.equal(failed.images.failedFiles, 1);
  assert.equal(failed.catalogSaved, false);
  failed.releaseCacheLease();
  fs.writeFileSync(path.join(gameRoot, broken), jpeg);
  const retried = await prepareGameAssets(options);
  assert.equal(retried.images.failedFiles, 0);
  assert.equal(retried.catalogSaved, true);
  retried.releaseCacheLease();
  console.log('native prepared image catalog restored successfully');
}
run().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => native.runtime.quit());
