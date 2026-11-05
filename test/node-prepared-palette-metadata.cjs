'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { png } = require('./helpers/png.cjs');
const { fixture, spritePacket, drawPacket } = require('./helpers/sparse-palette.cjs');
const native = require(path.resolve(process.argv[2]));

test('prepared page palette metadata survives direct and catalog installs', async t => {
  const root = temporaryDirectory('prepared-palette-metadata-');
  const sparse = fixture(root);
  const colors = Buffer.alloc(128 * 128 * 4);
  for (let i = 0; i < colors.length / 4; i++) {
    const color = i % 64;
    colors.set([color * 3, (color * 53) % 255, 37, 255], i * 4);
  }
  const small = { width: 128, height: 128, bytes: png(128, 128, colors) };
  const cases = [{ name: 'palette16', bits: 16, image: sparse },
    { name: 'palette8', bits: 8, image: small },
    { name: 'legacy-zero', bits: 0, image: sparse },
    { name: 'legacy-missing', image: sparse }];
  const invalid = [-1, 7, 8.5, 16.5, NaN, Infinity, 4294967304, '8', null];
  for (let i = 0; i < invalid.length; i++) cases.push({ name: 'invalid-' + i, bits: invalid[i], image: sparse, invalid: true });
  for (const mode of ['direct', 'catalog']) for (const item of cases) {
    fs.writeFileSync(path.join(root, mode + '-' + item.name + '.png'), item.image.bytes);
    fs.mkdirSync(path.join(root, mode + '-' + item.name));
  }
  native.initialize({ gameRoot: root, width: 64, height: 48,
    windowTitle: 'Prepared palette metadata', imageWarmCacheBytes: 0 });
  try {
    for (const mode of ['direct', 'catalog']) for (const item of cases) {
      await t.test(mode + '/' + item.name, async () => {
        const source = mode + '-' + item.name + '.png', directory = path.join(root, mode + '-' + item.name);
        const descriptor = await native.assets.processImage(source, directory,
          { grid: [1, 1], backdrop: [0, 0, 0, 0] }, path.join(root, source), null, { pageCodec: 'lz4' });
        assert.ok(descriptor.pages.length > 0);
        const entry = { source, directory, descriptor,
          sourceIdentity: native.assets.sourceIdentity(source) };
        if (mode === 'catalog') assert.equal(native.assets.installPrepared([entry], true), 1);
        for (const page of descriptor.pages) {
          page.storage = { width: page.width, height: page.height, channels: 4,
            source: [0, 1, 2, 3], swizzle: [0, 1, 2, 3] };
          if (item.name !== 'legacy-missing') page.storage.paletteBits = item.bits;
        }
        const installed = mode === 'catalog' ? native.assets.installPreparedCatalog([entry]) : native.assets.installPrepared([entry]);
        assert.equal(installed, item.invalid ? 0 : 1, 'metadata validation');
        if (item.invalid) return;
        let prepared, reference;
        try {
          const before = native.images.memory();
          prepared = await native.images.loadAsync(source);
          reference = native.images.loadBytes(item.image.bytes);
          const draw = (image, options) => drawPacket(native, spritePacket(native, image, options));
          assert.deepEqual(draw(prepared), draw(reference), 'nearest pixels');
          const owner = () => native.images.memory(100).largest.find(value => value.handle === prepared.handle);
          const after = native.images.memory();
          console.log(JSON.stringify({ mode, fixture: item.name, gpuBytes: owner().gpuBytes,
            cpuBytes: owner().cpuBytes, reconstructions: after.preparedRegionReads - before.preparedRegionReads }));
          if (item.bits) {
            assert.equal(owner().palette, true, 'indexed page lost its palette storage decision');
            if (item.bits === 16) {
              assert.equal(owner().paletteSparse, true, 'sparse page reconstructed a dense backing');
              assert.equal(after.preparedRegionReads, before.preparedRegionReads);
            }
          }
          const steady = native.images.memory();
          draw(prepared); draw(prepared);
          const repeated = native.images.memory();
          assert.equal(repeated.preparedPageDecodes, steady.preparedPageDecodes);
          assert.equal(repeated.textureUploadBytes, steady.textureUploadBytes);
          const options = { nearest: false, crop: [0.25, 0.5, 63, 47], scale: 0.9 };
          const actual = draw(prepared, options), expected = draw(reference, options);
          assert.equal(actual.length, expected.length);
          for (let i = 0; i < actual.length; ++i) {
            assert.ok(Math.abs(actual[i] - expected[i]) <= 1,
              `linear pixels: byte ${i}: ${actual[i]} != ${expected[i]}`);
          }
        } finally {
          native.beginFrame();
          for (const image of [prepared, reference]) if (image) native.images.release(image.handle);
        }
      });
    }
  } finally { native.runtime.quit(); }
});
