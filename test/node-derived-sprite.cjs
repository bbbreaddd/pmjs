'use strict';

process.env.PMJS_GRAPHICS_DIAGNOSTICS = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { png } = require('./helpers/png.cjs');
const native = require(path.resolve(process.argv[2]));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-derived-sprite-'));
const fixtures = [];
for (const [name, width, height, grid, backdrop] of [
  ['transparent', 192, 96, [6, 4], [0, 0, 0, 0]],
  ['opaque', 192, 96, [6, 4], [12, 23, 34, 255]],
  ['power-of-two', 256, 128, [8, 4], [0, 0, 0, 0]],
  ['wide', 8192, 32, [256, 1], [0, 0, 0, 0]],
  ['uniform', 192, 96, [1, 1], [37, 83, 129, 117]],
  ['uniform-black', 816, 624, [1, 1], [0, 0, 0, 255]],
]) {
  const uniform = name.startsWith('uniform');
  const pixels = Buffer.alloc(width * height * 4);
  const cw = width / grid[0], ch = height / grid[1];
  for (let y = 0; y < height; ++y) for (let x = 0; x < width; ++x) {
    const inside = name === 'wide' ? x % cw >= 12 && x % cw < 16 && y % ch >= 12 && y % ch < 16 :
      !uniform && x % cw >= 5 && x % cw < cw - 4 && y % ch >= 3 && y % ch < ch - 3;
    const color = inside ? [(x % cw * 23) % 256, (y % ch * 19) % 256, (x + y) % 256, 96 + (x % cw * 7) % 160] : backdrop;
    pixels.set(color, (y * width + x) * 4);
  }
  const bytes = png(width, height, pixels);
  fs.writeFileSync(path.join(root, name + '.png'), bytes);
  fixtures.push({ name, bytes, width, height, cw, ch, grid, backdrop, uniform });
}
native.initialize({ gameRoot: root, assetRoot: '', width: 128, height: 96, windowTitle: 'derived sprite pixels' });
native.render.setClearColor(0.08, 0.15, 0.2, 1);
const schema = native.scene.schema;
// Initialize diagnostic fallback storage before measuring image realization.
native.images.memory();

function frame(image, source, transform, nearest, alpha = 1, blend = 0, extraFlags = 0, projection) {
  const tint = extraFlags & (1 << 11) ?
    ((alpha * 255 << 24) | (Math.round(195 * alpha) << 16) |
      (Math.round(231 * alpha) << 8) | Math.round(175 * alpha)) >>> 0 : 0xc3e7af;
  const metadata = new Uint32Array([1, 0xffffffff, image.handle, tint, blend, (nearest ? 8 : 0) | extraFlags, 0]);
  const values = new Float32Array(schema.valueStride);
  values.set([...transform, alpha]);
  values.set(source, 9);
  values.set([source[2], source[3]], 13);
  native.beginFrame();
  if (projection) native.render.setSceneProjection(projection);
  assert.equal(native.scene.submit(schema.version, metadata, values, 1), undefined);
  native.renderScene();
  return Buffer.from(native.canvas.captureSceneRawPremultiplied());
}

async function main() {
  let comparisons = 0;
  for (const fixture of fixtures) {
    const directory = path.join(root, fixture.name + '-prepared');
    fs.mkdirSync(directory);
    const recipe = { grid: fixture.grid, backdrop: fixture.backdrop };
    if (fixture.name === 'opaque') recipe.crop = [0, 0, fixture.cw, fixture.ch];
    const descriptor = await native.assets.processImage(fixture.name + '.png', directory,
      fixture.uniform ? null : recipe);
    assert.ok(descriptor, fixture.name);
    if (fixture.uniform) {
      assert.deepEqual(descriptor.uniform, fixture.backdrop, 'automatic uniform detection');
      assert.deepEqual(descriptor.cells, []);
      assert.deepEqual(descriptor.pages, []);
    }
    const original = native.images.loadBytes(fixture.bytes);
    native.assets.installPrepared([{ source: fixture.name + '.png', directory, descriptor,
      sourceIdentity: native.assets.sourceIdentity(fixture.name + '.png') }]);
    const derived = await native.images.loadAsync(fixture.name + '.png');
    assert.deepEqual([derived.width, derived.height], [fixture.width, fixture.height]);
    native.beginFrame();
    native.scene.submit(schema.version, new Uint32Array(0), new Float32Array(0), 0);
    native.renderScene();
    const empty = Buffer.from(native.canvas.captureSceneRawPremultiplied());
    const beforeOffscreen = native.images.memory();
    const offscreenTransforms = [
      [1, 0, 0, 1, -fixture.cw, 0],
      [1, 0, 0, 1, 128, 0],
      [1, 0, 0, 1, 0, -fixture.ch],
      [1, 0, 0, 1, 0, 96],
      [1.31, 0.17, -0.2, 1.19, -2 * fixture.cw, -2 * fixture.ch],
    ];
    for (const nearest of [true, false]) for (const transform of offscreenTransforms) {
      for (const flags of [0, 1 << 8, 1 << 11]) {
        assert.deepEqual(frame(derived, [0, 0, fixture.cw, fixture.ch], transform,
          nearest, 0.63, 0, flags), empty, `${fixture.name}: offscreen draw changed pixels`);
      }
    }
    for (const transform of offscreenTransforms) {
      native.beginFrame();
      native.render.image(derived.handle, ...transform, 0, 0, fixture.cw, fixture.ch,
        0.63, 0xc3e7af, 0);
      native.renderScene();
      assert.deepEqual(Buffer.from(native.canvas.captureSceneRawPremultiplied()), empty,
        `${fixture.name}: offscreen direct draw changed pixels`);
    }
    // The packet builder sees a fractional sliver; rounding hides it at render time.
    for (const nearest of [true, false]) {
      assert.deepEqual(frame(derived, [0, 0, fixture.cw, fixture.ch],
        [1, 0, 0, 1, -fixture.cw + 0.25, 0], nearest, 0.63, 0, 1 << 8), empty,
      `${fixture.name}: rounded offscreen draw changed pixels`);
    }
    const afterOffscreen = native.images.memory();
    for (const counter of ['gpuBytes', 'textureCreates', 'textureUploadBytes',
      'preparedRegions', 'preparedMaterializations']) {
      assert.equal(afterOffscreen[counter], beforeOffscreen[counter],
        `${fixture.name}: offscreen draw changed ${counter}`);
    }
    assert.deepEqual(afterOffscreen.preparedFallbacks, beforeOffscreen.preparedFallbacks,
      'offscreen sprites must not select a backing');
    if (fixture.name === 'transparent') {
      const source = [0, 0, fixture.cw, fixture.ch];
      const transform = [1, 0, 0, 1, -fixture.cw, 0];
      const projection = [1, 0, 0, 1, fixture.cw + 8, 8];
      const projected = frame(derived, source, transform, false, 1, 0, 0, projection);
      assert.notDeepEqual(projected, empty, 'projection moved the sprite into view');
      assert.deepEqual(projected, frame(original, source, transform, false, 1, 0, 0, projection),
        'culling must respect a nonidentity scene projection');
    }
    if (fixture.uniform) {
      // Warm ordinary premultiplied storage before measuring the prepared image.
      frame(original, [0, 0, fixture.width, fixture.height], [1, 0, 0, 1, 0, 0], true);
    }
    const before = native.images.memory();
    const sources = [[0, 0, fixture.cw, fixture.ch],
      [Math.min(fixture.width - fixture.cw, fixture.cw), 0, fixture.cw, fixture.ch],
      [5.25, 3.5, Math.min(14.5, fixture.cw - 6), Math.min(13.5, fixture.ch - 5)]];
    const transforms = [[2, 0, 0, 2, 8, 8], [1.31, 0.17, -0.2, 1.19, 28.25, 15.5], [-1.75, 0, 0, 1.5, 94, 20]];
    for (const nearest of [true, false]) for (const source of sources) for (const transform of transforms) {
      const control = frame(original, source, transform, nearest, 0.63);
      const candidate = frame(derived, source, transform, nearest, 0.63);
      if (!candidate.equals(control)) {
        const differences = [];
        for (let i = 0; i < candidate.length && differences.length < 12; ++i) {
          if (candidate[i] !== control[i]) differences.push({ x: Math.floor(i / 4) % 128,
            y: Math.floor(i / 512), channel: i % 4, candidate: candidate[i], control: control[i] });
        }
        throw new Error(JSON.stringify({ name: fixture.name, nearest, source, transform, differences }));
      }
      assert.deepEqual(frame(derived, source, transform, nearest, 0.63), candidate,
        'frozen derived frame changed');
      ++comparisons;
    }
    if (fixture.uniform) {
      const compact = native.images.memory();
      const pixelBytes = fixture.backdrop[3] === 255 ? 4 : 8;
      assert.equal(compact.gpuBytes - before.gpuBytes, pixelBytes,
        'uniform drawing allocated more than straight and premultiplied source pixels');
      assert.equal(compact.preparedMaterializations, before.preparedMaterializations,
        'uniform drawing expanded the logical image');
      const source = [0, 0, fixture.width, fixture.height];
      const transform = [128 / fixture.width, 0, 0, 96 / fixture.height, 0, 0];
      for (const backgroundAlpha of [0, 1]) {
        native.render.setClearColor(0.08, 0.15, 0.2, backgroundAlpha);
        for (const flags of [0, 1 << 11]) for (const nearest of [true, false]) {
          for (const alpha of [0, 150 / 255, 0.37, 1]) {
            assert.deepEqual(frame(derived, source, transform, nearest, alpha, 0, flags),
              frame(original, source, transform, nearest, alpha, 0, flags),
              `${fixture.name}: alpha=${alpha}, background=${backgroundAlpha}, flags=${flags}`);
            ++comparisons;
          }
        }
      }
      native.render.setClearColor(0.08, 0.15, 0.2, 1);
      const afterOpacity = native.images.memory();
      assert.equal(afterOpacity.preparedMaterializations, before.preparedMaterializations,
        'opacity or packed sprite colour expanded the logical image');
      assert.equal(afterOpacity.textureUploadBytes, compact.textureUploadBytes,
        'opacity or packed sprite colour uploaded source pixels again');
    }
    // Mipmap and cross-cell crops require ordinary backing with original sampling.
    for (const [source, flags] of [
      [[0, 0, Math.min(fixture.width, fixture.cw + 7), fixture.ch], 0],
      [[0, 0, fixture.cw, fixture.ch], 1 << 16],
    ]) {
      assert.deepEqual(frame(derived, source, [1, 0, 0, 1, 8, 8], false, 1, 0, flags),
        frame(original, source, [1, 0, 0, 1, 8, 8], false, 1, 0, flags));
      ++comparisons;
    }
    const after = native.images.memory();
    if (fixture.uniform || fixture.name === 'power-of-two' || fixture.name === 'wide') {
      assert.ok(after.preparedRegions > before.preparedRegions, 'eligible sprites did not use prepared regions');
    } else {
      assert.ok(after.preparedFallbacks['non-power-of-two-sampling'] > 0,
        'non-power-of-two nearest sampling must use compatible backing');
    }
    assert.ok(after.preparedFallbacks.mipmaps > 0, 'mipmaps did not use compatible backing');
    if (!fixture.uniform) assert.ok(after.preparedFallbacks['linear-sampling'] > 0,
      'nonuniform linear sampling must use compatible backing');
    for (const blend of [1, 2, 3]) {
      assert.deepEqual(frame(derived, sources[0], transforms[0], true, 0.63, blend),
        frame(original, sources[0], transforms[0], true, 0.63, blend));
      ++comparisons;
    }
    native.images.release(original.handle);
    native.images.release(derived.handle);
  }
  console.log(JSON.stringify({ comparisons, memory: native.images.memory() }));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  native.runtime.quit();
  fs.rmSync(root, { recursive: true, force: true });
});
