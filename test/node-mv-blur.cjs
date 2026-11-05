'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 32, height: 32,
  windowTitle: 'MV blur ownership' });
const handles = new Set();
function canvas(width, height) {
  const value = native.canvas.create(width, height);
  handles.add(value.handle);
  return value;
}
function read(value) {
  return Array.from(native.canvas.readPremultipliedPixels(value.handle, 0, 0, value.width, value.height));
}
function referenceBlur(input, width, height) {
  for (let pass = 0; pass < 2; pass++) {
    const output = new Uint8Array(input.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const sx = x + dx, sy = y + dy;
          if ((sx < 0 || sx >= width) && (sy < 0 || sy >= height)) continue;
          const sample = (Math.max(0, Math.min(height - 1, sy)) * width +
            Math.max(0, Math.min(width - 1, sx))) * 4 + channel;
          sum += (input[sample] * 29) >> 8;
        }
        output[index + channel] = Math.min(255, sum);
      }
      output[index + 3] = 255;
    }
    input = output;
  }
  return Array.from(input);
}
try {
  for (const [width, height] of [[1, 9], [9, 1], [2, 7], [7, 2], [3, 3], [17, 13], [64, 48]]) {
    const value = canvas(width, height), input = new Uint8Array(width * height * 4);
    for (let i = 0; i < input.length; i += 4) {
      const alpha = (i * 71 + 37) & 255;
      input[i] = (i * 13) % (alpha + 1);
      input[i + 1] = (i * 19 + 7) % (alpha + 1);
      input[i + 2] = (i * 23 + 9) % (alpha + 1);
      input[i + 3] = alpha;
    }
    native.canvas.writePremultipliedPixels(value.handle, 0, 0, width, height, input);
    assert.equal(native.canvas.blurMv(value.handle), true);
    assert.deepEqual(read(value), referenceBlur(input, width, height), `${width}x${height} padded blur`);
  }
  const source = canvas(1, 1), retained = canvas(1, 1);
  native.canvas.fillRect(source.handle, 0, 0, 1, 1, 0xff0000ff);
  native.canvas.drawImage(retained.handle, source.handle, 0, 0, 1, 1, 0, 0, 1, 1, 1);
  assert.equal(native.canvas.blurMv(source.handle), true);
  assert.deepEqual(read(source), [75, 0, 0, 255]);
  native.canvas.release(source.handle);
  handles.delete(source.handle);
  assert.deepEqual(read(retained), [255, 0, 0, 255], 'queued source snapshot survives blur and release');
  assert.throws(() => native.canvas.blurMv(source.handle), /invalid canvas/);
  assert.throws(() => native.canvas.blurMv(0), /invalid canvas/);

  const white = canvas(2, 2);
  native.canvas.fillRect(white.handle, 0, 0, 2, 2, 0xffffffff);
  assert.equal(native.canvas.blurMv(white.handle), true);
  assert.deepEqual(read(white), Array(4).fill([200, 200, 200, 255]).flat());
  const clear = canvas(8, 8);
  assert.equal(native.canvas.blurMv(clear.handle), true);
  assert.deepEqual(read(clear), Array(64).fill([0, 0, 0, 255]).flat());

  const raw = canvas(1, 1), bytes = new Uint8Array([255, 2, 3, 0]);
  native.canvas.writePremultipliedPixels(raw.handle, 0, 0, 1, 1, bytes);
  assert.equal(native.canvas.blurMv(raw.handle), false);
  assert.deepEqual(read(raw), Array.from(bytes), 'unsupported raw content remains unchanged');
} finally {
  for (const handle of handles) native.canvas.release(handle);
  native.runtime.quit();
}
