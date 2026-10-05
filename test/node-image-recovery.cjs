'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { png } = require('./helpers/png.cjs');
const native = require(path.resolve(process.argv[2]));

function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function psd(pixels, rle) {
  const header = Buffer.alloc(40);
  header.write('8BPS'); header.writeUInt16BE(1, 4); header.writeUInt16BE(4, 12);
  header.writeUInt32BE(2, 14); header.writeUInt32BE(2, 18);
  header.writeUInt16BE(8, 22); header.writeUInt16BE(3, 24); header.writeUInt16BE(rle ? 1 : 0, 38);
  const planes = [0, 1, 2, 3].map(channel => Buffer.from([0, 1, 2, 3].map(pixel => pixels[pixel * 4 + channel])));
  if (!rle) return Buffer.concat([header, ...planes]);
  const lengths = Buffer.alloc(16);
  for (let row = 0; row < 8; row++) lengths.writeUInt16BE(3, row * 2);
  return Buffer.concat([header, lengths, ...planes.flatMap(plane =>
    [Buffer.from([1, plane[0], plane[1]]), Buffer.from([1, plane[2], plane[3]])])]);
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-image-recovery-'));
  try {
    const pixels = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255];
    const original = png(2, 2, pixels);
    const damagedPrefix = Buffer.from(original); damagedPrefix.fill(71, 0, 16);
    const damagedChecksum = Buffer.from(original);
    let idat;
    for (let offset = 8; offset < original.length;) {
      const size = original.readUInt32BE(offset);
      if (original.toString('ascii', offset + 4, offset + 8) === 'IDAT') { idat = { offset, size }; break; }
      offset += size + 12;
    }
    damagedChecksum[idat.offset + idat.size + 7] ^= 1;
    damagedChecksum.writeUInt32BE(crc(damagedChecksum.subarray(idat.offset + 4,
      idat.offset + idat.size + 8)), idat.offset + idat.size + 8);
    const files = { png: original, prefix: damagedPrefix,
      checksum: damagedChecksum, psd: psd(pixels, false), rle: psd(pixels, true) };
    for (const [name, bytes] of Object.entries(files)) {
      fs.writeFileSync(path.join(directory, name + '.png'), bytes);
    }
    native.initialize({ gameRoot: directory, assetRoot: '', width: 2, height: 2, windowTitle: 'image recovery' });
    const canvas = native.canvas.create(2, 2);
    for (const [name, bytes] of Object.entries(files)) {
      for (const load of [() => native.images.load(name + '.png'),
        () => native.images.loadBytes(bytes), () => native.images.loadBytesAsync(bytes),
        () => native.images.loadAsync(name + '.png')]) {
        let image;
        try { image = await load(); }
        catch (error) { throw new Error(name + ': ' + error.message, { cause: error }); }
        assert.equal(image.width, 2); assert.equal(image.height, 2);
        native.canvas.clear(canvas.handle);
        native.canvas.drawImage(canvas.handle, image.handle, 0, 0, 2, 2, 0, 0, 2, 2, 1);
        assert.deepEqual(Array.from(native.canvas.readPixels(canvas.handle, 0, 0, 2, 2)), pixels, name);
        native.images.release(image.handle);
      }
    }
    const badChunk = Buffer.from(damagedPrefix); badChunk[16] ^= 1;
    const badStream = Buffer.from(damagedChecksum); badStream[idat.offset + 10] ^= 127;
    badStream.writeUInt32BE(crc(badStream.subarray(idat.offset + 4,
      idat.offset + idat.size + 8)), idat.offset + idat.size + 8);
    const badWindow = Buffer.from(damagedPrefix);
    badWindow[idat.offset + 8] = 0x88;
    badWindow[idat.offset + 9] = (31 - (0x8800 % 31)) % 31;
    badWindow.writeUInt32BE(crc(badWindow.subarray(idat.offset + 4,
      idat.offset + idat.size + 8)), idat.offset + idat.size + 8);
    const oversized = Buffer.from(psd(pixels, false)); oversized.writeUInt32BE(8193, 18);
    for (const bytes of [badChunk, badStream, badWindow, original.subarray(0, 36),
      psd(pixels, false).subarray(0, 40), oversized]) {
      assert.throws(() => native.images.loadBytes(bytes));
      await assert.rejects(native.images.loadBytesAsync(bytes));
    }
    native.canvas.release(canvas.handle);
    console.log('[pmjs-node-image-recovery] ready');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
