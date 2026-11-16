'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { png } = require('./helpers/png.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const native = require(path.resolve(process.argv[2]));
const root = temporaryDirectory('pmjs-frame-pages-');
const pageCodec = process.argv[3] || 'png';
const palette = process.argv[4] === 'palette';
const width = 1200, height = 768, cellWidth = 300, cellHeight = 256;
const pixels = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; ++y) for (let x = 0; x < width; ++x) {
  const n = (y * width + x) * 2654435761 >>> 0;
  const color = n >>> 8 & 31;
  const edge = x % cellWidth < 7 || x % cellWidth >= cellWidth - 7 ||
    y % cellHeight < 9 || y % cellHeight >= cellHeight - 9;
  pixels.set(palette ? (edge ? [255, 255, 255, 0] :
    [color * 7, color * 3, color * 5, 80 + color * 5]) :
    [n & 255, n >>> 8 & 255, n >>> 16 & 255,
      x % cellWidth < 7 || y % cellHeight < 9 ? 0 : 80 + (n >>> 24) % 176], (y * width + x) * 4);
}
fs.writeFileSync(path.join(root, 'sheet.png'), png(width, height, pixels));
const edgePixels = Buffer.alloc(width * height * 4);
for (const y of [100, cellHeight]) for (let x = 100; x < 106; ++x)
  edgePixels.set([255, 0, 0, 255], (y * width + x) * 4);
for (let y = cellHeight * 2; y < height; ++y) for (let x = cellWidth * 3; x < width; ++x)
  edgePixels.set([255, 255, 255, 0], (y * width + x) * 4);
const edgeBytes = png(width, height, edgePixels);
fs.writeFileSync(path.join(root, 'edge.png'), edgeBytes);
const sparseFixtures = [true, false].map(extended => {
  const name = extended ? 'sparse.png' : 'gray-sparse.png';
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 11) {
    const color = extended ? i / 11 + 1 : (i / 11) % 60000 + 1;
    pixels.set(extended ? [color & 255, color >>> 8 & 255, color >>> 16 & 255, color % 256] :
      [color & 255, color & 255, color & 255, color >>> 8], i * 4);
  }
  const bytes = png(width, height, pixels), file = path.join(root, name);
  fs.writeFileSync(file, bytes);
  return { name, pixels, bytes, file, extended };
});
{
  const name = 'sparse16.png', pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 17) {
    const color = (i / 17) % 1024 + 1;
    pixels.set([color & 255, color >>> 8, 35, color % 255], i * 4);
  }
  const bytes = png(width, height, pixels), file = path.join(root, name);
  fs.writeFileSync(file, bytes);
  sparseFixtures.push({ name, pixels, bytes, file, extended: false, sparse16: true });
}
{
  const name = 'channel-blocks.png', pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; ++y) for (let x = 0; x < width; ++x)
    pixels.set([x % 251, x < width / 2 ? x % 251 : y % 251, x < width / 2 ? x % 251 : (x + y) % 251,
      (Math.floor(x / 8) + Math.floor(y / 8)) % 3 ? 96 + x % 8 * 19 : 0], (y * width + x) * 4);
  const bytes = png(width, height, pixels), file = path.join(root, name);
  fs.writeFileSync(file, bytes);
  sparseFixtures.push({ name, pixels, bytes, file, extended: false, planar: true });
}
native.initialize({ gameRoot: root, width: 320, height: 280, windowTitle: 'frame pages',
  imageWarmCacheBytes: 0, preparedFrameCacheBytes: 8 * 1024 * 1024 });
const schema = native.scene.schema;
function draw(image, frame, whole = false, effect = false, boundary = false, nearest = false, transform) {
  const rect = whole ? [0, 0, width, height] : [frame % 4 * cellWidth, Math.floor(frame / 4) * cellHeight, cellWidth, cellHeight];
  const values = new Float32Array(schema.valueStride);
  const scale = whole ? 0.25 : boundary ? 1 : 0.87;
  values.set([...(transform || [scale, boundary ? 0 : 0.01, boundary ? 0 : -0.01, scale, 2.25, 2.5]), 1]);
  values.set(rect, 9); values.set(rect.slice(2), 13);
  if (effect) { values.set([0.1, -0.1, 0.05, 0.3], 33); values.set([0.2, 0.5, 0.1, 0.25], 37); }
  native.beginFrame();
  native.scene.submit(schema.version, new Uint32Array([1, 0xffffffff, image.handle, 0xffffff, 0, effect ? 16 : nearest ? 8 : 0, 0]), values, 1);
  native.renderScene();
  return Buffer.from(native.canvas.captureSceneRawPremultiplied());
}
function drawMany(image, frames) {
  const metadata = new Uint32Array(schema.metadataStride * frames.length);
  const values = new Float32Array(schema.valueStride * frames.length);
  frames.forEach((frame, i) => {
    metadata.set([1, 0xffffffff, image.handle, 0xffffff, 0, 0, 0], i * schema.metadataStride);
    values.set([0.15, 0, 0, 0.15, i * 50 + 0.25, 0.25, 1], i * schema.valueStride);
    values.set([frame % 4 * cellWidth, Math.floor(frame / 4) * cellHeight, cellWidth, cellHeight], i * schema.valueStride + 9);
    values.set([cellWidth, cellHeight], i * schema.valueStride + 13);
  });
  native.beginFrame(); native.scene.submit(schema.version, metadata, values, frames.length); native.renderScene();
  return Buffer.from(native.canvas.captureSceneRawPremultiplied());
}
function clear() {
  native.beginFrame(); native.scene.submit(schema.version, new Uint32Array(0), new Float32Array(0), 0); native.renderScene();
}
function assertPixels(actual, expected, tolerance = 0) {
  assert.equal(actual.length, expected.length);
  let maxDelta = 0;
  for (let i = 0; i < actual.length; ++i) maxDelta = Math.max(maxDelta, Math.abs(actual[i] - expected[i]));
  assert.ok(maxDelta <= tolerance, `source sampling delta ${maxDelta}, allowed ${tolerance}`);
}
async function main() {
  const directory = path.join(root, 'normal'), framesDirectory = path.join(root, 'frames');
  fs.mkdirSync(directory); fs.mkdirSync(framesDirectory);
  const normal = await native.assets.processImage('sheet.png', directory, { grid: [4, 3] }, path.join(root, 'sheet.png'), null, { pageCodec });
  const frames = await native.assets.processImage('sheet.png', framesDirectory, { grid: [4, 3], framePages: true }, path.join(root, 'sheet.png'), null, { pageCodec });
  assert.equal(frames.framePages, true);
  assert.equal(frames.pages.length, 12);
  assert.deepEqual(frames.cells.map(c => [c.rect, c.crop, c.fill]), normal.cells.map(c => [c.rect, c.crop, c.fill]));
  for (const page of frames.pages)
    page.storage = await native.assets.classifyImageStorage(path.join(framesDirectory, page.path));
  const storage = await native.assets.classifyImageStorage(path.join(root, 'sheet.png'));
  if (palette) assert.equal(storage.paletteBits, 8);
  const sourceIdentity = native.assets.sourceIdentity('sheet.png');
  assert.equal(native.assets.installImageStorage([{ source: 'sheet.png', sourceIdentity, storage }]), 1);
  const install = (descriptor, output) => assert.equal(native.assets.installPrepared([{ source: 'sheet.png', sourceIdentity, directory: output, descriptor }]), 1);
  const control = native.images.loadBytes(fs.readFileSync(path.join(root, 'sheet.png')));
  const expected = [];
  for (let frame = 0; frame < 12; ++frame) expected.push([draw(control, frame), draw(control, frame, false, true)]);
  const whole = draw(control, 0, true);
  const wholeEffects = draw(control, 0, true, true);
  const batches = [[0, 1, 2, 3, 4, 5], [0, 1, 0, 6, 7, 2]];
  const expectedBatches = batches.map(batch => drawMany(control, batch));
  native.images.release(control.handle); clear();
  install(frames, framesDirectory);
  const hitsBefore = native.images.memory().preparedHits;
  const image = await native.images.loadAsync('sheet.png');
  const retained = await native.images.loadAsync('sheet.png');
  native.images.release(image.handle);
  assert.equal(image.handle, retained.handle);
  assert.equal(native.images.memory().preparedHits, hitsBefore + 2);
  const maxPageBytes = Math.max(...frames.pages.map(page => page.width * page.height * 4));
  const totalPageBytes = frames.pages.reduce((bytes, page) => bytes + page.width * page.height * 4, 0);
  assert.ok(native.images.memory().cpuBytes <= maxPageBytes * 4);
  const blocksBeforeRetained = native.images.memory().blockRegions;
  for (let repeat = 0; repeat < 2; ++repeat) for (let frame = 0; frame < 12; ++frame) {
    assertPixels(draw(retained, frame), expected[frame][0], 1);
    if (!palette && repeat === 0 && frame === 0) {
      const state = native.images.memory(20);
      const owner = state.largest.find(entry => entry.handle === retained.handle);
      assert.ok(owner && (owner.fullTextureResident || state.blockRegions > blocksBeforeRetained),
        'zero-fill pages must preserve logical-source sampling');
      assert.ok(state.preparedFrameCacheBytes > 0 &&
        state.preparedFrameCacheBytes <= state.preparedFrameCacheBudget);
    }
    assertPixels(draw(retained, frame, false, true), expected[frame][1], 1);
    const memory = native.images.memory();
    assert.ok(memory.cpuBytes <= totalPageBytes, `decoded pages exceeded their total size: ${memory.cpuBytes}`);
    if (palette) {
      assert.ok(memory.preparedPageTextureBytes <= totalPageBytes * 2,
        'straight and premultiplied pages exceeded their total size');
      assert.ok(memory.preparedFrameCacheBytes <= memory.preparedFrameCacheBudget,
        'reconstructed cell textures exceeded the frame cache budget');
      assert.ok(memory.gpuBytes <= totalPageBytes * 2 + memory.preparedFrameCacheBytes + 64,
        'GPU storage exceeded page textures, reconstructed frames and the fallback image');
    }
  }
  const nearestReference = native.images.loadBytes(png(width, height, pixels));
  try {
    for (let frame = 0; frame < 12; ++frame) {
      const expectedNearest = draw(nearestReference, frame, false, false, false, true);
      const actualNearest = draw(retained, frame, false, false, false, true);
      let maxDelta = 0;
      for (let i = 0; i < actualNearest.length; ++i) maxDelta = Math.max(maxDelta, Math.abs(actualNearest[i] - expectedNearest[i]));
      assert.equal(maxDelta, 0, `nearest frame changed source samples: ${maxDelta}`);
    }
  } finally { native.images.release(nearestReference.handle); }
  batches.forEach((batch, i) => assertPixels(drawMany(retained, batch), expectedBatches[i], 1));
  assertPixels(draw(retained, 0, true), whole, 1);
  assertPixels(draw(retained, 0, true, true), wholeEffects, 1);
  native.images.release(retained.handle); clear();
  assert.equal(native.images.memory().cpuBytes, 0);
  assert.equal(native.images.memory().gpuBytes, 64);
  // A bad late page must fail validation before publishing a prepared handle.
  fs.writeFileSync(path.join(framesDirectory, frames.pages[9].path), 'invalid page');
  install(frames, framesDirectory);
  const preparedHits = native.images.memory().preparedHits;
  const fallback = await native.images.loadAsync('sheet.png');
  assert.equal(native.images.memory().preparedHits, preparedHits);
  const ordinary = native.images.loadBytes(fs.readFileSync(path.join(root, 'sheet.png')));
  assert.deepEqual(draw(fallback, 9, false, true), draw(ordinary, 9, false, true));
  native.images.release(ordinary.handle); native.images.release(fallback.handle); clear();
  assert.equal(native.images.memory().cpuBytes, 0);
  assert.equal(native.images.memory().gpuBytes, 64);
  const edgeDirectory = path.join(root, 'edge'); fs.mkdirSync(edgeDirectory);
  const edgeDescriptor = await native.assets.processImage('edge.png', edgeDirectory,
    { grid: [4, 3], framePages: true }, path.join(root, 'edge.png'), null, { pageCodec });
  for (const page of edgeDescriptor.pages) page.storage = await native.assets.classifyImageStorage(path.join(edgeDirectory, page.path));
  const edgeIdentity = native.assets.sourceIdentity('edge.png');
  const edgeStorage = await native.assets.classifyImageStorage(path.join(root, 'edge.png'));
  native.assets.installImageStorage([{ source: 'edge.png', sourceIdentity: edgeIdentity, storage: edgeStorage }]);
  native.assets.installPrepared([{ source: 'edge.png', sourceIdentity: edgeIdentity, directory: edgeDirectory, descriptor: edgeDescriptor }]);
  const edgeOriginal = native.images.loadBytes(edgeBytes), edgePrepared = await native.images.loadAsync('edge.png');
  try {
    const expectedEdge = draw(edgeOriginal, 0, false, false, true);
    assert.ok(expectedEdge[(258 * 320 + 102) * 4] > 20, 'reference must sample the neighboring frame');
    const actualEdge = draw(edgePrepared, 0, false, false, true);
    let maxDelta = 0;
    for (let i = 0; i < actualEdge.length; ++i) maxDelta = Math.max(maxDelta, Math.abs(actualEdge[i] - expectedEdge[i]));
    assert.ok(maxDelta <= 1, `cropped frame lost neighboring boundary sample: ${maxDelta}`);
    assert.deepEqual(draw(edgePrepared, 11), draw(edgeOriginal, 11));
    assert.deepEqual(draw(edgePrepared, 0, false, false, true, true),
      draw(edgeOriginal, 0, false, false, true, true), 'nearest sampling changed at a cell boundary');
  } finally { native.images.release(edgeOriginal.handle); native.images.release(edgePrepared.handle); clear(); }
  assert.equal(native.images.memory().cpuBytes, 0); assert.equal(native.images.memory().gpuBytes, 64);
  assert.equal(native.assets.installPrepared([{ source: 'edge.png', sourceIdentity: edgeIdentity,
    directory: edgeDirectory, descriptor: { ...edgeDescriptor, width: 9000 } }]), 0);
  if (!palette) for (const { name, pixels: sparsePixels, bytes: sparseBytes, file: sparseFile, extended, planar, sparse16 } of sparseFixtures) {
    const sparseDirectory = path.join(root, name + '-prepared'); fs.mkdirSync(sparseDirectory);
    const sparseDescriptor = await native.assets.processImage(name, sparseDirectory,
      { source: name, grid: [4, 3], framePages: true }, sparseFile, null, { pageCodec });
    const sparseIdentity = native.assets.sourceIdentity(name);
    const sparseStorage = await native.assets.classifyImageStorage(sparseFile);
    assert.equal(sparseStorage.paletteBits, sparse16 ? 16 : 0);
    for (const page of sparseDescriptor.pages) page.storage = {
      version: 1, width: page.width, height: page.height, paletteBits: 0, channels: 4,
      source: [0, 1, 2, 3], swizzle: [0, 1, 2, 3]
    };
    assert.equal(native.assets.installImageStorage([{ source: name, sourceIdentity: sparseIdentity,
      storage: { ...sparseStorage, paletteBits: 0 } }]), 1);
    const pageHashes = sparseDescriptor.pages.map(page => crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(sparseDirectory, page.path))).digest('hex'));
    const registryDescriptors = fs.existsSync('/proc/self/fd') ? fs.readdirSync('/proc/self/fd').length : null;
    assert.equal(native.assets.installPrepared([{ source: name, sourceIdentity: sparseIdentity,
      directory: sparseDirectory, descriptor: sparseDescriptor, pageHashes,
      textureHash: crypto.createHash('sha256').update(fs.readFileSync(path.join(sparseDirectory, sparseDescriptor.textureArtifact))).digest('hex') }]), 1);
    if (registryDescriptors !== null) assert.equal(fs.readdirSync('/proc/self/fd').length, registryDescriptors);
    const sparseOriginal = native.images.loadBytes(sparseBytes);
    const decodesBefore = native.images.memory().preparedPageDecodes;
    const sparsePrepared = await native.images.loadAsync(name);
    assert.equal(native.images.memory().preparedPageDecodes, decodesBefore,
      'hashed artifact-backed loads must not decode recovery pages');
    assert.equal(sparseDescriptor.textureArtifact, 'texture.pmtx');
    const artifactBefore = native.images.memory();
    const blocksBefore = native.images.memory().blockTextureUploads;
    try {
      assertPixels(draw(sparsePrepared, 0, true), draw(sparseOriginal, 0, true), 1);
      const artifactOwner = native.images.memory(20).largest.find(entry => entry.handle === sparsePrepared.handle);
      const channelBlocks = native.images.memory().blockTextureUploads > blocksBefore;
      assert.ok(artifactOwner && artifactOwner.cpuBytes + artifactOwner.gpuBytes < sparsePixels.length,
        JSON.stringify({ name, artifactOwner }));
      for (let frame = 0; frame < 12; ++frame) for (const nearest of [false, true]) {
        assertPixels(draw(sparsePrepared, frame, false, false, false, nearest),
          draw(sparseOriginal, frame, false, false, false, nearest), nearest ? 0 : 1);
        const actual = draw(sparsePrepared, frame, false, true, false, nearest);
        const expected = draw(sparseOriginal, frame, false, true, false, nearest);
        let maxDelta = 0;
        for (let i = 0; i < actual.length; ++i) maxDelta = Math.max(maxDelta, Math.abs(actual[i] - expected[i]));
        assert.ok(maxDelta <= 1, `sparse effect sampling changed source pixels: ${maxDelta}`);
      }
      assertPixels(draw(sparsePrepared, 0, true), draw(sparseOriginal, 0, true), 1);
      const artifactAfter = native.images.memory();
      assert.equal(artifactAfter.textureArtifactLoads, artifactBefore.textureArtifactLoads + 1);
      if (!channelBlocks) assert.ok(artifactAfter.preparedPageDecodes <= decodesBefore + sparseDescriptor.pages.length,
        'filtered draws decoded recovery pages more than once');
      assert.equal(artifactAfter.sourceTextureBuilds, artifactBefore.sourceTextureBuilds);
      assert.equal(artifactAfter.textureArtifactFailures, artifactBefore.textureArtifactFailures);
      assert.ok(artifactAfter.textureArtifactStagingBytes <= 1024 * 1024);
      const owner = native.images.memory(20).largest.find(entry => entry.handle === sparsePrepared.handle);
      assert.ok(owner);
      assert.equal(owner.paletteSparse, extended || !!sparse16);
      assert.equal(owner.paletteIndexBits, extended ? 24 : sparse16 ? 16 : 0);
      if (planar) assert.ok(channelBlocks);
      if (channelBlocks) {
        assert.equal(owner.sceneryFullMaterialized, false);
        for (const translation of [[0, 0], [0.25, 0], [0, 0.5], [0.25, 0.5]]) {
          const transform = [1, 0, 0, 1, ...translation];
          for (const frame of [0, 5, 11]) for (const effect of [false, true]) {
            assertPixels(draw(sparsePrepared, frame, false, effect, false, false, transform),
              draw(sparseOriginal, frame, false, effect, false, false, transform), 1);
          }
        }
        const warm = native.images.memory();
        for (const frame of [0, 5, 11]) draw(sparsePrepared, frame);
        const reused = native.images.memory();
        assert.ok(reused.preparedFrameCacheHits > warm.preparedFrameCacheHits);
        assert.equal(reused.preparedPageDecodes, warm.preparedPageDecodes);
        assert.equal(reused.textureUploadBytes, warm.textureUploadBytes);
      }
      const recoveryBytes = sparseDescriptor.pages.reduce((bytes, page) => bytes + page.width * page.height * 4, 0);
      assert.ok(owner.cpuBytes <= recoveryBytes);
      assert.ok(owner.gpuBytes <= sparsePixels.length + recoveryBytes * 2 + artifactAfter.preparedFrameCacheBudget);
      const canvas = native.canvas.create(width, height);
      const referenceCanvas = native.canvas.create(width, height);
      const recoveryPath = sparse16 ? path.join(sparseDirectory, sparseDescriptor.pages[0].path) : null;
      if (recoveryPath) {
        fs.renameSync(recoveryPath, recoveryPath + '.retained');
        fs.writeFileSync(recoveryPath, Buffer.alloc(32));
      }
      try {
        for (const [target, source] of [[canvas, sparsePrepared], [referenceCanvas, sparseOriginal]])
          native.canvas.drawImage(target.handle, source.handle, 0, 0, width, height, 0, 0, width, height, 1);
        assert.deepEqual(Buffer.from(native.canvas.readPixels(canvas.handle, 0, 0, width, height)),
          Buffer.from(native.canvas.readPixels(referenceCanvas.handle, 0, 0, width, height)));
      } finally {
        native.canvas.release(canvas.handle); native.canvas.release(referenceCanvas.handle);
        if (recoveryPath) {
          fs.unlinkSync(recoveryPath); fs.renameSync(recoveryPath + '.retained', recoveryPath);
        }
      }
      assert.ok(native.images.memory().preparedPageDecodes > decodesBefore,
        'CPU access must recover pixels on demand');
    } finally { native.images.release(sparseOriginal.handle); native.images.release(sparsePrepared.handle); clear(); }
    assert.equal(native.images.memory().cpuBytes, 0); assert.equal(native.images.memory().gpuBytes, 64);
    if (sparse16) {
      const artifact = path.join(sparseDirectory, sparseDescriptor.textureArtifact);
      const pristine = fs.readFileSync(artifact);
      const register = () => assert.equal(native.assets.installPrepared([{ source: name,
        sourceIdentity: sparseIdentity, directory: sparseDirectory, descriptor: sparseDescriptor, pageHashes,
        textureHash: crypto.createHash('sha256').update(pristine).digest('hex') }]), 1);
      const pagePath = path.join(sparseDirectory, sparseDescriptor.pages[0].path);
      const pristinePage = fs.readFileSync(pagePath);
      const damagedPage = Buffer.from(pristinePage); damagedPage[damagedPage.length - 1] ^= 1;
      fs.writeFileSync(pagePath, damagedPage); register();
      const hits = native.images.memory().preparedHits;
      const badRecovery = await native.images.loadAsync(name);
      assert.equal(native.images.memory().preparedHits, hits, 'recovery hash mismatch must reject preparation');
      const badReference = native.images.loadBytes(sparseBytes);
      assertPixels(draw(badRecovery, 0, true), draw(badReference, 0, true), 1);
      native.images.release(badRecovery.handle); native.images.release(badReference.handle); clear();
      fs.writeFileSync(pagePath, pristinePage); register();
      const cpuDecodes = native.images.memory().preparedPageDecodes;
      const cpuRetained = await native.images.loadAsync(name, true);
      assert.ok(native.images.memory().preparedPageDecodes > cpuDecodes);
      native.images.release(cpuRetained.handle); clear();
      const expected = native.images.loadBytes(sparseBytes);
      const reference = draw(expected, 0, true);
      native.images.release(expected.handle); clear();
      const descriptorCount = () => fs.existsSync('/proc/self/fd') ? fs.readdirSync('/proc/self/fd').length : null;
      const initialDescriptors = descriptorCount();
      const results = [];
      for (const fault of ['header', 'truncated', 'last-chunk', 'missing']) for (let repeat = 0; repeat < 3; ++repeat) {
        fs.writeFileSync(artifact, pristine);
        if (fault === 'missing') fs.unlinkSync(artifact);
        register();
        if (fault !== 'missing') {
          const damaged = Buffer.from(pristine);
          if (fault === 'header') damaged[0] ^= 1;
          if (fault === 'last-chunk') damaged[damaged.length - 1] ^= 1;
          fs.writeFileSync(artifact, fault === 'truncated' ? damaged.subarray(0, damaged.length - 11) : damaged);
        }
        const before = native.images.memory();
        const recovered = await native.images.loadAsync(name);
        const started = performance.now();
        assertPixels(draw(recovered, 0, true), reference, 1);
        const elapsedMs = performance.now() - started;
        const after = native.images.memory();
        assert.equal(after.textureArtifactFailures, before.textureArtifactFailures + 1);
        assert.equal(after.sourceTextureBuilds, before.sourceTextureBuilds + 1);
        assertPixels(draw(recovered, 0, true), reference, 1);
        assert.equal(native.images.memory().sourceTextureBuilds, after.sourceTextureBuilds);
        native.images.release(recovered.handle); clear();
        assert.equal(native.images.memory().cpuBytes, 0); assert.equal(native.images.memory().gpuBytes, 64);
        results.push({ fault, repeat, elapsedMs, reason: after.textureArtifactFailureReason });
      }
      fs.writeFileSync(artifact, pristine); register();
      const retainedArtifact = await native.images.loadAsync(name);
      fs.renameSync(artifact, artifact + '.retained');
      fs.writeFileSync(artifact, Buffer.alloc(32));
      const before = native.images.memory();
      assertPixels(draw(retainedArtifact, 0, true), reference, 1);
      assert.equal(native.images.memory().textureArtifactLoads, before.textureArtifactLoads + 1);
      assert.equal(native.images.memory().sourceTextureBuilds, before.sourceTextureBuilds);
      native.images.release(retainedArtifact.handle); clear();
      fs.unlinkSync(artifact); fs.renameSync(artifact + '.retained', artifact); register();
      const replacementPixels = Buffer.from(sparsePixels);
      for (let i = 0; i < replacementPixels.length; i += 4) replacementPixels[i] ^= 32;
      const replacementFile = path.join(root, 'replacement.png');
      fs.writeFileSync(replacementFile, png(width, height, replacementPixels));
      const replacementDirectory = path.join(root, 'replacement-prepared'); fs.mkdirSync(replacementDirectory);
      const replacement = await native.assets.processImage('replacement.png', replacementDirectory,
        { grid: [4, 3], framePages: true }, replacementFile, null, { pageCodec });
      assert.equal(replacement.textureArtifact, 'texture.pmtx');
      fs.copyFileSync(path.join(replacementDirectory, replacement.textureArtifact), artifact);
      register();
      const beforeSwap = native.images.memory();
      const substituted = await native.images.loadAsync(name);
      assertPixels(draw(substituted, 0, true), reference, 1);
      assert.equal(native.images.memory().textureArtifactFailures, beforeSwap.textureArtifactFailures + 1);
      assert.equal(native.images.memory().sourceTextureBuilds, beforeSwap.sourceTextureBuilds + 1);
      native.images.release(substituted.handle); clear();
      fs.writeFileSync(artifact, pristine); register();
      if (initialDescriptors !== null) assert.equal(descriptorCount(), initialDescriptors);
      console.log('artifact fault and retained-file trials: ' + JSON.stringify(results));
    }
  }
  console.log('frame pages: exact rendering, four-page residency, retained owner, fallback and release pass');
}
test('frame pages preserve pixels, ownership and bounded decoding', async () => {
  try { await main(); } finally { native.runtime.quit(); }
});
