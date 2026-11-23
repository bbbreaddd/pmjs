'use strict';

process.env.PMJS_GRAPHICS_DIAGNOSTICS = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { png } = require('./helpers/png.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const native = require(path.resolve(process.argv[2]));
const disabled = process.argv.includes('--disabled');

test('block sprites share GPU storage across frames, effects and retained owners', async context => {
  const root = temporaryDirectory('pmjs-block-sprite-');
  const frameWidth = 256, frameHeight = 256, frames = 8, width = frameWidth * frames;
  const pixels = Buffer.alloc(width * frameHeight * 4);
  for (let y = 0; y < frameHeight; ++y) for (let x = 0; x < width; ++x) {
    const frame = Math.floor(x / frameWidth), bx = Math.floor(x % frameWidth / 64), by = Math.floor(y / 64);
    const tx = x % 64, ty = y % 64;
    const patterned = (bx === 3 || by === 3) && tx >= 8 && tx < 56 && ty >= 8 && ty < 56;
    const type = ((frame >> (bx % 3)) + bx + by) % 4;
    const gray = patterned ? (tx * 13 + ty * 17 + type * 31) % 256 : 255;
    const alpha = patterned ? (tx * 7 + ty * 19 + type * 23) % 256 : 0;
    pixels.set([gray, gray, gray, alpha], (y * width + x) * 4);
  }
  const bytes = png(width, frameHeight, pixels);
  fs.writeFileSync(path.join(root, 'source.png'), bytes);
  native.initialize({ gameRoot: root, assetRoot: '', width: 192, height: 160,
    windowTitle: 'block sprite pixels', imageWarmCacheBytes: 0,
    ...(disabled ? { preparedCompactSampling: false } : {}) });
  try {
    const schema = native.scene.schema;
    native.render.setClearColor(0.08, 0.15, 0.2, 0.6);
    const original = native.images.loadBytes(bytes);
    const directory = path.join(root, 'prepared');
    fs.mkdirSync(directory);
    const descriptor = await native.assets.processImage('source.png', directory, { grid: [frames, 1] });
    assert.ok(descriptor, 'repeated patterns must produce a prepared image');
    assert.deepEqual(descriptor.blockGrid, [64, frameWidth, frameHeight],
      'automatic preparation must select the smaller block representation');
    assert.ok([1, 2].includes(descriptor.blockChannels), 'preparation certifies block eligibility');
    assert.equal(descriptor.pages.length, 1, 'fixture must fit the one-atlas path');
    if (process.argv.includes('--legacy-index')) delete descriptor.blockChannels;
    native.assets.installPrepared([{ source: 'source.png', directory, descriptor,
      sourceIdentity: native.assets.sourceIdentity('source.png') }]);
    const derived = await native.images.loadAsync('source.png');
    const retained = native.images.acquireCached('source.png');
    assert.equal(retained.handle, derived.handle, 'second owner must share the same prepared resource');

    function sprite(image, frame, options = {}) {
      const alpha = options.alpha ?? 1;
      let flags = (1 << 17) | (options.nearest ? 8 : 0) | (options.effect ? 16 : 0) |
        (options.packed ? 1 << 11 : 0) | (options.mipmap ? 1 << 16 : 0);
      const values = new Float32Array(schema.valueStride);
      values.set([...(options.transform || [0.5, 0, 0, 0.5, 24.25, 12.5]), alpha]);
      values.set([frame * frameWidth, 0, frameWidth, frameHeight, frameWidth, frameHeight], 9);
      if (options.effect) values.set([0.75, 0.25, 0.5, 0.3], 37);
      if (options.effect === 2) values.set([0.1, -0.05, 0.04, 0.3], 33);
      if (options.clip) { flags |= 1; values.set([35, 25, 115, 100], 17); }
      const packed = Math.round(alpha * 255);
      const tint = options.packed ? ((packed << 24) | (packed << 16) | (packed << 8) | packed) >>> 0 : 0xffffff;
      return { metadata: [1, 0xffffffff, image.handle, tint, options.blend || 0, flags, 0], values };
    }
    function submit(entries) {
      const metadata = new Uint32Array(entries.length * schema.metadataStride);
      const values = new Float32Array(entries.length * schema.valueStride);
      entries.forEach((entry, index) => {
        metadata.set(entry.metadata, index * schema.metadataStride);
        values.set(entry.values, index * schema.valueStride);
      });
      native.beginFrame();
      native.scene.submit(schema.version, metadata, values, entries.length);
    }
    function capture() { return Buffer.from(native.canvas.captureSceneRawPremultiplied()); }
    function render(entries) {
      submit(entries);
      const before = native.render.stats().drawCalls;
      native.renderScene();
      return { pixels: capture(), draws: native.render.stats().drawCalls - before };
    }
    function match(actual, expected, label) {
      assert.equal(actual.length, expected.length);
      let delta = 0, largest = 0;
      for (let i = 0; i < actual.length; ++i) {
        const difference = Math.abs(actual[i] - expected[i]);
        if (difference > delta) { delta = difference; largest = i; }
      }
      const pixel = largest - largest % 4;
      assert.ok(delta <= 1, `${label}: maximum channel difference ${delta} at ` +
        `${Math.floor(largest / 4) % 192},${Math.floor(largest / (192 * 4))}; ` +
        `${Array.from(actual.subarray(pixel, pixel + 4))} versus ${Array.from(expected.subarray(pixel, pixel + 4))}`);
    }
    const baseline = native.images.memory();
    let comparisons = 0;
    if (disabled) {
      for (let frame = 0; frame < frames; ++frame) for (const nearest of [false, true]) {
        for (const effect of [0, 1, 2]) {
          // Keep the frame-cache nearest control on texel centers; fractional
          // tie decisions can differ between full-sheet and padded-frame UVs.
          const options = { nearest, effect, alpha: 0.63,
            transform: nearest ? [1, 0, 0, 1, -64, -96] : undefined };
          match(render([sprite(derived, frame, options)]).pixels,
            render([sprite(original, frame, options)]).pixels,
            `disabled block path frame=${frame}, nearest=${nearest}, effect=${effect}`);
          ++comparisons;
        }
      }
      const after = native.images.memory();
      assert.equal(after.blockTextureUploads, baseline.blockTextureUploads,
        'disabled compact sampling must not upload a block backing');
      assert.equal(after.blockRegions, baseline.blockRegions,
        'disabled compact sampling must not resolve block regions');
      assert.equal(after.sourceTextureBuilds, 0);
      render([]);
      native.images.release(derived.handle);
      native.images.release(retained.handle);
      native.images.release(original.handle);
      context.diagnostic(JSON.stringify({ disabled: true, comparisons, memory: native.images.memory() }));
      return;
    }
    for (const packed of [false, true]) {
      // Warm only the ordinary image so its uploads do not enter candidate accounting.
      render([sprite(original, 0, { packed })]);
      const before = native.images.memory();
      render([sprite(derived, 0, { packed })]);
      const first = native.images.memory();
      assert.equal(first.blockTextureUploads, before.blockTextureUploads);
      for (let frame = 0; frame < frames; ++frame) for (const nearest of [false, true]) {
        for (const effect of [0, 1, 2]) {
          const options = { packed, nearest, effect, alpha: 0.63, clip: effect === 2,
            transform: effect === 2 ? [0.47, 0.11, -0.09, 0.49, 36.25, 3.5] : undefined };
          const expected = render([sprite(original, frame, options)]);
          const actual = render([sprite(derived, frame, options)]);
          match(actual.pixels, expected.pixels, `frame=${frame}, nearest=${nearest}, effect=${effect}, packed=${packed}`);
          assert.equal(actual.draws, 1, 'one block sprite must remain one draw');
          ++comparisons;
        }
      }
      for (const blend of [1, 2, 3]) {
        const options = { packed, alpha: 0.63, blend, nearest: false };
        match(render([sprite(derived, 2, options)]).pixels, render([sprite(original, 2, options)]).pixels,
          `blend=${blend}, packed=${packed}`);
        ++comparisons;
      }
      const after = native.images.memory();
      assert.equal(after.blockTextureUploads, first.blockTextureUploads, 'changing frames must reuse atlas and table');
      assert.equal(after.textureUploadBytes, first.textureUploadBytes, 'animation or effects must not upload frame pixels');
      assert.equal(after.sourceTextureBuilds, 0);
    }
    // Direct image commands use straight sampling; packet sprites use premultiplied sampling.
    function direct(image, frame) {
      native.beginFrame();
      const before = native.render.stats().drawCalls;
      native.render.image(image.handle, 0.5, 0, 0, 0.5, 24.25, 12.5,
        frame * frameWidth, 0, frameWidth, frameHeight, 0.63, 0xffffff, 0);
      native.renderScene();
      return { pixels: capture(), draws: native.render.stats().drawCalls - before };
    }
    direct(original, 0);
    const beforeStraight = native.images.memory();
    direct(derived, 0);
    const straight = native.images.memory();
    assert.equal(straight.blockTextureUploads, beforeStraight.blockTextureUploads);
    for (let frame = 0; frame < frames; ++frame) {
      const expected = direct(original, frame), actual = direct(derived, frame);
      match(actual.pixels, expected.pixels, `straight frame=${frame}`);
      assert.equal(actual.draws, 1);
      ++comparisons;
    }
    assert.equal(native.images.memory().textureUploadBytes, straight.textureUploadBytes,
      'straight animation must also reuse its atlas/table pair');
    const active = native.images.memory(100);
    const owner = active.largest.find(entry => entry.handle === derived.handle);
    const atlasBytes = descriptor.pages[0].width * descriptor.pages[0].height * 2;
    const tableBytes = Math.ceil(frameWidth / 64) * Math.ceil(frameHeight / 64) * frames * 4;
    assert.ok(owner.gpuBytes > 0);
    assert.equal(active.blockUploadFailures, baseline.blockUploadFailures);
    assert.equal(active.blockRegions, baseline.blockRegions);

    const mixed = (prepared) => [sprite(prepared, 1, { nearest: true }),
      sprite(original, 2, { nearest: false, alpha: 0.5, transform: [0.4, 0, 0, 0.4, 3, 40] }),
      sprite(prepared, 3, { packed: true, effect: 2, alpha: 0.63 })];
    match(render(mixed(derived)).pixels, render(mixed(original)).pixels, 'ordinary draws interleaved with block draws');
    ++comparisons;

    const expected = render([sprite(original, 4, { effect: 1 })]).pixels;
    submit([sprite(derived, 4, { effect: 1 })]);
    native.images.release(derived.handle);
    native.renderScene();
    match(capture(), expected, 'queued scene must remain valid while a separate owner retains the source');
    match(render([sprite(retained, 4, { effect: 1 })]).pixels, expected, 'retained source must support reuse');
    comparisons += 2;

    // Unsupported sampling retains the ordinary source path and exact mipmap behavior.
    const beforeFallback = native.images.memory();
    const options = { mipmap: true, transform: [0.5, 0, 0, 0.5, 24, 12] };
    match(render([sprite(retained, 0, options)]).pixels, render([sprite(original, 0, options)]).pixels,
      'mipmap fallback');
    const fallback = native.images.memory();
    assert.ok(fallback.preparedFallbacks.mipmaps > (beforeFallback.preparedFallbacks.mipmaps || 0));
    assert.equal(fallback.blockTextureUploads, beforeFallback.blockTextureUploads,
      'fallback sampling must not allocate another block backing');
    ++comparisons;

    render([]);
    const releaseState = native.images.memory(100);
    const beforeRelease = releaseState.gpuBytes;
    native.images.release(retained.handle);
    native.beginFrame();
    const released = native.images.memory(100);
    assert.ok(beforeRelease - released.gpuBytes >= owner.gpuBytes,
      'final source release must release both block atlas/table pairs: ' + JSON.stringify({
        before: releaseState.largest.find(entry => entry.handle === retained.handle),
        after: released.largest.find(entry => entry.handle === retained.handle),
        bytesFreed: beforeRelease - released.gpuBytes, expected: owner.gpuBytes }));
    native.images.release(original.handle);
    context.diagnostic(JSON.stringify({ comparisons, atlasBytes, tableBytes, memory: native.images.memory() }));
  } finally {
    native.runtime.quit();
  }
});
