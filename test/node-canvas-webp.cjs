'use strict';
// Lossless-WebP canvas encoding: valid container, declared dimensions,
// non-empty payload, PNG path untouched, invalid handles rejected.
const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 32, height: 24, windowTitle: 'Canvas WebP encoding' });
const handles = [];
function webpDimensions(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return { width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
      height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) };
  }
  if (chunk === 'VP8L') {
    assert.equal(bytes[20], 0x2f);
    const b1 = bytes[21], b2 = bytes[22], b3 = bytes[23], b4 = bytes[24];
    return { width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)) };
  }
  throw new Error('Unexpected WebP chunk: ' + chunk);
}
try {
  const canvas = native.canvas.create(64, 48);
  handles.push(canvas.handle);
  native.canvas.fillRect(canvas.handle, 0, 0, 64, 48, 0xff0000ff);
  native.canvas.fillRect(canvas.handle, 8, 8, 16, 16, 0x00ff00ff);
  const encoded = Buffer.from(native.canvas.encodeWebP(canvas.handle));
  assert.ok(encoded.length > 0, 'WebP payload is non-empty');
  assert.ok(encoded.length < 64 * 48 * 4, 'Flat fills compress below raw RGBA');
  assert.deepStrictEqual(webpDimensions(encoded), { width: 64, height: 48 });
  const again = Buffer.from(native.canvas.encodeWebP(canvas.handle));
  assert.deepStrictEqual(again, encoded, 'Lossless encoding is deterministic');
  const png = Buffer.from(native.canvas.encodePng(canvas.handle));
  assert.deepStrictEqual(png.subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'PNG path unchanged');
  assert.throws(() => native.canvas.encodeWebP(0xffffffff), /invalid canvas/);
} finally {
  for (const handle of handles) native.canvas.release(handle);
  native.runtime.quit();
}
console.log('[canvas-webp] lossless encoding, dimensions and errors agree');
