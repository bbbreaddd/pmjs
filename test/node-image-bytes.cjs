'use strict';

const fs = require('node:fs');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
const assert = require('node:assert/strict');
const { png } = require('./helpers/png.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const root = path.resolve(process.argv[3]);
native.initialize({gameRoot:root,assetRoot:'',width:640,height:480,windowTitle:'pmjs test'});

async function main() {
  const bytes = fs.readFileSync(path.join(root, 'fixture.png'));
  const sync = native.images.loadBytes(bytes);
  const async = await native.images.loadBytesAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (sync.width !== 2 || sync.height !== 2 || async.width !== 2 || async.height !== 2) {
    throw new Error('byte-loaded image dimensions are incorrect');
  }
  if (sync.handle === async.handle) {
    throw new Error('memory images unexpectedly shared path-cache identity');
  }

  const canvas = native.canvas.create(2, 2);
  const expected = native.images.load('fixture.png');
  native.canvas.drawImage(canvas.handle, expected.handle, 0, 0, 2, 2, 0, 0, 2, 2, 1);
  const expectedPixels = Array.from(native.canvas.readPixels(canvas.handle, 0, 0, 2, 2));
  for (let frame = 0; frame < 65; frame++) native.beginFrame();
  for (const image of [sync, async]) {
    native.canvas.clear(canvas.handle);
    native.canvas.drawImage(canvas.handle, image.handle, 0, 0, 2, 2, 0, 0, 2, 2, 1);
    const actual = Array.from(native.canvas.readPixels(canvas.handle, 0, 0, 2, 2));
    if (JSON.stringify(actual) !== JSON.stringify(expectedPixels)) {
      throw new Error('memory image lost readable pixels after frame aging');
    }
  }

  // Untagged 16-bit samples use the same encoded colors as 8-bit PNGs.
  const colors = Buffer.from([1, 2, 4, 255, 23, 64, 128, 255,
    255, 0, 5, 255, 0, 0, 0, 255]);
  const wide = Buffer.alloc(colors.length * 2);
  colors.forEach((value, index) => wide.writeUInt16BE(value * 257, index * 2));
  const png16 = png(2, 2, wide, { depth: 16 });
  for (const image of [native.images.loadBytes(png16), await native.images.loadBytesAsync(png16)]) {
    try {
      native.canvas.clear(canvas.handle);
      native.canvas.drawImage(canvas.handle, image.handle, 0, 0, 2, 2, 0, 0, 2, 2, 1);
      assert.deepEqual(Buffer.from(native.canvas.readPixels(canvas.handle, 0, 0, 2, 2)), colors);
    } finally { native.images.release(image.handle); }
  }

  for (const [name, fixture] of Object.entries(require('./assets/image-colors.json'))) {
    if (/^(icc-|chrm-)/.test(name) && native.assets.preparationVersion.colorManagement !== 'skia65') continue;
    const bytes = Buffer.from(fixture.bytes, 'base64');
    const { width, height, pixels } = fixture.reference;
    const target = native.canvas.create(width, height);
    for (const image of [native.images.loadBytes(bytes), await native.images.loadBytesAsync(bytes)]) {
      assert.equal(image.width, width, name);
      assert.equal(image.height, height, name);
      native.canvas.clear(target.handle);
      native.canvas.drawImage(target.handle, image.handle, 0, 0, width, height, 0, 0, width, height, 1);
      assert.deepEqual(Array.from(native.canvas.readPixels(target.handle, 0, 0, width, height)), pixels, name);
      native.images.release(image.handle);
    }
    if (name.endsWith('.png')) {
      const directory = temporaryDirectory('image-color-');
      try {
        const source = path.join(directory, name);
        fs.writeFileSync(source, bytes);
        const descriptor = await native.assets.processImage(name, path.join(directory, 'prepared'),
          { grid: [width, height], backdrop: [0, 0, 0, 0] }, source);
        assert.ok(descriptor, name);
        const checkFill = (fill, expected) => {
          assert.equal(fill[3], expected[3], name);
          if (expected[3]) assert.deepEqual(fill, expected, name);
        };
        if (descriptor.uniform) checkFill(descriptor.uniform, pixels.slice(0, 4));
        else {
          assert.equal(descriptor.cells.length, width * height, name);
          descriptor.cells.forEach((cell, index) => checkFill(cell.fill,
            pixels.slice(index * 4, index * 4 + 4)));
        }
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    } else if (name.endsWith('.jpg')) {
      const directory = temporaryDirectory('jpeg-preparation-');
      const source = path.join(directory, name), output = path.join(directory, 'prepared');
      fs.writeFileSync(source, bytes);
      assert.equal(await native.assets.processImage(name, output, { grid: [1, 1] }, source), null,
        'a decodable JPEG must fall back to ordinary loading without publishing PNG preparation output');
      assert.ok(!fs.existsSync(output) || fs.readdirSync(output).length === 0);
    }
    native.canvas.release(target.handle);
  }

  let malformedRejected = false;
  try { await native.images.loadBytesAsync(Uint8Array.from([1, 2, 3, 4])); }
  catch (_) { malformedRejected = true; }
  if (!malformedRejected) throw new Error('malformed image bytes were accepted');

  let oversizedRejected = false;
  try { native.images.loadBytes(new ArrayBuffer(64 * 1024 * 1024 + 1)); }
  catch (_) { oversizedRejected = true; }
  if (!oversizedRejected) throw new Error('oversized image bytes were accepted');

  native.images.release(sync.handle);
  native.images.release(async.handle);
  native.images.release(expected.handle);
  native.canvas.release(canvas.handle);
  console.log('[pmjs-node-image-bytes] ready');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
