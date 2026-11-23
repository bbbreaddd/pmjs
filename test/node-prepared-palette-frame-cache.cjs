'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { png } = require('./helpers/png.cjs');
const { spritePacket, drawPacket } = require('./helpers/sparse-palette.cjs');
const native = require(path.resolve(process.argv[2]));
const root = temporaryDirectory('palette-frame-cache-');
const warmAliases = process.argv.includes('--warm-aliases');
const width = 960, height = 256;
const pixels = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const color = (x + y * 13) % 512;
  pixels.set([color % 256, (color * 7) % 256, color < 256 ? 43 : 173,
    [0, 85, 170, 255][color % 4]], (y * width + x) * 4);
}
const encoded = png(width, height, pixels);
for (const name of ['sheet.png', 'alias.png', 'corrupt.png']) fs.writeFileSync(path.join(root, name), encoded);
native.initialize({ imagePalettization: true, gameRoot: root, width: 112, height: 96, windowTitle: 'Palette frame cache',
  imageWarmCacheBytes: warmAliases ? 8 * 1024 * 1024 : 0, preparedFrameCacheBytes: warmAliases ? 0 : 8 * 1024 * 1024 });

(async () => {
  let image, reference; const aliases = [];
  try {
    const directory = path.join(root, 'prepared'); fs.mkdirSync(directory);
    const descriptor = await native.assets.processImage('sheet.png', directory,
      { grid: [3, 1], framePages: true }, path.join(root, 'sheet.png'), null, { pageCodec: 'lz4', allowPalettes: true });
    const storage = await native.assets.classifyImageStorage(path.join(root, 'sheet.png'));
    assert.ok(storage.paletteBits, 'fixture must exercise palette decoding');
    const sourceIdentity = native.assets.sourceIdentity('sheet.png');
    native.assets.installImageStorage([{ source: 'sheet.png', sourceIdentity, storage }]);
    assert.ok(descriptor.textureArtifact);
    const textureHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, descriptor.textureArtifact))).digest('hex');
    native.assets.installPrepared([{ source: 'sheet.png', sourceIdentity, directory, descriptor, textureHash }]);
    image = await native.images.loadAsync('sheet.png');
    reference = native.canvas.create(width, height);
    native.canvas.writePixels(reference.handle, 0, 0, width, height, pixels);
    function draw(source, crop, nearest, packed) {
      const packet = spritePacket(native, source, { crop, nearest, scale: 0.31,
        premultiplied: source === reference });
      if (packed) packet.metadata[5] &= ~(1 << 17);
      packet.values[4] = 0.25; packet.values[5] = 0.5;
      return drawPacket(native, packet);
    }
    async function loadAlias(source, corrupt = false) {
      const aliasDirectory = path.join(root, source + '.prepared'); fs.mkdirSync(aliasDirectory);
      for (const file of [...descriptor.pages.map(page => page.path), descriptor.textureArtifact])
        fs.copyFileSync(path.join(directory, file), path.join(aliasDirectory, file));
      if (corrupt) {
        const file = path.join(aliasDirectory, descriptor.textureArtifact), bytes = fs.readFileSync(file);
        bytes[bytes.length - 1] ^= 1; fs.writeFileSync(file, bytes);
      }
      assert.equal(native.assets.installPrepared([{ source, sourceIdentity: native.assets.sourceIdentity(source),
        directory: aliasDirectory, descriptor, textureHash }]), 1);
      const alias = await native.images.loadAsync(source); aliases.push(alias);
      assert.notEqual(alias.handle, image.handle);
      return alias;
    }
    if (warmAliases) {
      const alias = await loadAlias('alias.png');
      const expected = draw(image,[0, 0, 64, 64], true, false);
      assert.deepEqual(draw(alias,[0, 0, 64, 64], true, false), expected);
      const owner = native.images.memory(100).largest.find(owner => owner.handle === image.handle);
      native.images.release(image.handle);image = null; native.beginFrame();
      assert.equal(native.images.memory().warmBytes, 0, 'active palette storage was charged to its warm alias');
      assert.deepEqual(draw(alias,[0, 0, 64, 64], true, false), expected);
      native.images.release(alias.handle); aliases.pop(); native.beginFrame();
      assert.equal(native.images.memory().warmCount, 2);
      assert.equal(native.images.memory().warmBytes, owner.gpuBytes + owner.cpuBytes, 'warm prepared storage counted twice');
      return;
    }
    draw(image,[0, 0, 64, 64], true, false);
    assert.equal(native.images.memory(100).largest.find(owner => owner.handle === image.handle).palette, true);
    for (const crop of [[0, 0, width, height], [0, 0, 320, height],
      [320, 0, 320, height], [640, 0, 320, height]]) {
      const before = native.images.memory();
      for (const nearest of [true, false]) for (const packed of [true, false]) {
        const expected = draw(reference, crop, nearest, packed);
        const actual = draw(image, crop, nearest, packed);
        let maximum = 0;
        for (let i = 0; i < actual.length; i++) maximum = Math.max(maximum, Math.abs(actual[i] - expected[i]));
        assert.ok(maximum <= 2, `crop ${crop}, nearest=${nearest}, packed=${packed}: delta ${maximum}`);
      }
      native.beginFrame();
      const warm = native.images.memory();
      assert.equal(warm.sourceTextureBuilds, 0);
      for (let repeat = 0; repeat < 3; repeat++) draw(image, crop, true, false);
      const after = native.images.memory();
      assert.equal(after.textureUploadBytes, warm.textureUploadBytes);
      assert.equal(after.renderReadbacks, 0);
    }
    const expected = draw(image,[0, 0, 64, 64], true, false);
    const conversionState = native.images.memory();
    assert.equal(conversionState.sourceTextureBuilds, 0);
    for (const name of ['alias.png', 'corrupt.png']) {
      const alias = await loadAlias(name, name === 'corrupt.png');
      const before = native.images.memory();
      assert.deepEqual(draw(alias,[0, 0, 64, 64], true, false), expected);
      const after = native.images.memory();
      if (name === 'alias.png') {
        assert.equal(after.textureUploadBytes, before.textureUploadBytes, 'identical prepared texture uploaded twice');
        assert.ok(after.preparedSharedTextureHits > before.preparedSharedTextureHits);
      } else assert.equal(after.textureArtifactFailures, before.textureArtifactFailures + 1, 'sharing skipped artifact verification');
    }
    const changed = Buffer.from(pixels);
    for (let i = 0; i < changed.length; i += 4) changed[i] ^= 32;
    fs.writeFileSync(path.join(root, 'alias.png'), png(width, height, changed));
    const replacementDirectory = path.join(root, 'replacement'); fs.mkdirSync(replacementDirectory);
    const replacement = await native.assets.processImage('alias.png', replacementDirectory,
      { grid: [3, 1], framePages: true }, path.join(root, 'alias.png'), null, { pageCodec: 'lz4', allowPalettes: true });
    const replacementHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(replacementDirectory, replacement.textureArtifact))).digest('hex');
    assert.notEqual(replacementHash, textureHash);
    native.assets.installPrepared([{ source: 'alias.png', sourceIdentity: native.assets.sourceIdentity('alias.png'),
      directory: replacementDirectory, descriptor: replacement, textureHash: replacementHash }]);
    const replaced = await native.images.loadAsync('alias.png'); aliases.push(replaced);
    assert.notEqual(replaced.handle, aliases[0].handle);
    const changedReference = native.canvas.create(width, height);
    try {
      native.canvas.writePixels(changedReference.handle, 0, 0, width, height, changed);
      assert.deepEqual(draw(replaced,[0, 0, 64, 64], true, false), draw(changedReference,[0, 0, 64, 64], true, false));
      assert.deepEqual(draw(aliases[0],[0, 0, 64, 64], true, false), expected,'source replacement changed an existing palette alias');
      assert.deepEqual(draw(image,[0, 0, 64, 64], true, false), expected);
    } finally { native.canvas.release(changedReference.handle); }
    native.images.release(image.handle);image = null; native.beginFrame();
    assert.deepEqual(draw(aliases[0],[0, 0, 64, 64], true, false), expected,'releasing one palette owner invalidated its alias');
    const recovered = native.canvas.create(width, height);
    try {
      native.canvas.drawImage(recovered.handle, aliases[0].handle, 0, 0, width, height, 0, 0, width, height, 1);
      const actual = Buffer.from(native.canvas.readPremultipliedPixels(recovered.handle, 0, 0, width, height));
      native.canvas.clear(recovered.handle);
      native.canvas.drawImage(recovered.handle, reference.handle, 0, 0, width, height, 0, 0, width, height, 1);
      assert.deepEqual(actual, Buffer.from(native.canvas.readPremultipliedPixels(recovered.handle, 0, 0, width, height)),
        'prepared texture reuse changed CPU pixel access');
    } finally { native.canvas.release(recovered.handle); }
  } finally {
    for (const alias of aliases) native.images.release(alias.handle);
    if (reference) native.canvas.release(reference.handle);
    if (image) native.images.release(image.handle);
    native.beginFrame();
    native.runtime.quit(); fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
