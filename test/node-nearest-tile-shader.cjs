'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {png} = require('./helpers/png.cjs');

if (!process.argv.includes('--worker')) {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-nearest-comparison-'));
  try {
    for (const textures of [1, 4]) {
      const results = [0, 1].map(enabled => {
        const directory = path.join(output, `${textures}-${enabled}`); fs.mkdirSync(directory);
        const child = spawnSync(process.execPath, [__filename, process.argv[2], '--worker', directory], {
          env: {...process.env, PMJS_TILE_BATCH_TEXTURES: String(textures),
            PMJS_TILE_NEAREST_SHADER: String(enabled), PMJS_GRAPHICS_DIAGNOSTICS: '1',
            SDL_AUDIODRIVER: process.env.SDL_AUDIODRIVER || 'dummy'}, encoding: 'utf8', maxBuffer: 1024 * 1024
        });
        assert.equal(child.status, 0, `${child.stderr}\n${child.signal || ''} ${child.error || ''}`);
        return {...JSON.parse(child.stdout.trim().split('\n').at(-1)), directory};
      });
      assert.deepEqual(results[0].frames.map(frame => frame.name), results[1].frames.map(frame => frame.name));
      for (let index = 0; index < results[0].frames.length; ++index)
        assert.ok(fs.readFileSync(path.join(results[0].directory, results[0].frames[index].file)).equals(
          fs.readFileSync(path.join(results[1].directory, results[1].frames[index].file))),
        `pixels: textures=${textures}, case=${results[0].frames[index].name}`);
      assert.equal(results[0].draws, results[1].draws, 'shader selection preserves physical batching');
      assert.equal(results[0].filters, results[1].filters, 'shader selection preserves filter passes');
      assert.equal(results[0].filterTargets, results[1].filterTargets, 'shader selection preserves filter targets');
      assert.equal(results[0].filterClears, results[1].filterClears, 'shader selection preserves filter clears');
      assert.ok(results[1].active > 0 && results[1].fallback > 0);
      console.log(JSON.stringify({textures, comparisons: results[0].frames.length,
        active: results[1].active, fallback: results[1].fallback, draws: results[1].draws}));
    }
  } finally {fs.rmSync(output, {recursive: true, force: true});}
} else {
  main().catch(error => {console.error(error); process.exitCode = 1;});
}

async function main() {
  const native = require(path.resolve(process.argv[2]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-nearest-tiles-'));
  const frames = [], layers = [], canvases = [], images = [], plans = [];
  const width = 816, height = 624;
  const enabled = process.env.PMJS_TILE_NEAREST_SHADER === '1';
  const sheetWidth = 8192, sheetHeight = 64, sheetPixels = Buffer.alloc(sheetWidth * sheetHeight * 4);
  for (let y = 0; y < sheetHeight; ++y) for (let x = 0; x < sheetWidth; ++x)
    sheetPixels.set([x % 127, y, (x * 71 + y) % 97, (x + y) % 3 ? 255 : 127], (y * sheetWidth + x) * 4);
  fs.writeFileSync(path.join(root, 'source.png'), png(sheetWidth, sheetHeight, sheetPixels));
  fs.copyFileSync(path.join(root, 'source.png'), path.join(root, 'snapshot.png'));
  native.initialize({gameRoot: root, width, height, windowTitle: 'nearest tile shader'});
  native.render.configurePixiFragmentPrecision('highp');
  const schema = native.scene.schema;
  function layer(points, sources) {
    const handle = native.render.createTileLayer(new Float32Array(points), sources.map(image => image.handle));
    assert.ok(handle); layers.push(handle); return handle;
  }
  function frame(name, handle, options = {}, eligible = true) {
    const values = new Float32Array(schema.valueStride);
    values.set([...(options.transform || [1, 0, 0, 1, 5, 6]), 0.73]);
    values.set(options.animation || [0, 0], 15);
    if (options.clip) values.set([13.5, 10.25, 45.75, 38.5], 17);
    if (options.mask) values.set([1, 0, 0, 1, 0, 0], 22);
    const metadata = new Uint32Array([4, 0xffffffff, handle, 0xc3e7af,
      options.blend || 0, (options.linear ? 0 : 8) | (options.mask ? 4 : 0) | (options.clip ? 1 : 0),
      options.mask ? options.mask.handle : 0]);
    let packetMetadata = metadata, packetValues = values, count = 1;
    if (options.filter) {
      const nested = !!options.outerFilter;
      const begin = nested ? 1 : 0;
      count = nested ? 5 : 3;
      packetMetadata = new Uint32Array(schema.metadataStride * count);
      packetValues = new Float32Array(schema.valueStride * count);
      for (let index = 0; index < count; ++index)
        packetValues.set([1, 0, 0, 1, 0, 0, 1], schema.valueStride * index);
      if (nested) packetMetadata.set([6, 0xffffffff, options.outerFilter, 0xffffff, 31, 0, 0]);
      packetMetadata.set([6, nested ? 0 : 0xffffffff, options.filter, 0xffffff, 31, 0, 0], schema.metadataStride * begin);
      metadata[1] = begin; packetMetadata.set(metadata, schema.metadataStride * (begin + 1));
      packetMetadata.set([7, begin, 0, 0xffffff, 0, 0, 0], schema.metadataStride * (begin + 2));
      if (nested) packetMetadata.set([7, 0, 0, 0xffffff, 0, 0, 0], schema.metadataStride * 4);
      packetValues.set(values, schema.valueStride * (begin + 1));
    }
    native.beginFrame(); native.scene.submit(schema.version, packetMetadata, packetValues, count);
    const before = native.render.stats();
    native.renderScene();
    assert.equal(native.render.stats().nearestTileShaderDrawCalls > before.nearestTileShaderDrawCalls,
      enabled && eligible, name);
    let pixels;
    if (options.offscreen) {
      const canvas = native.canvas.create(width, height);
      const offscreenBefore = native.render.stats();
      native.render.renderToCanvas(canvas.handle);
      assert.equal(native.render.stats().nearestTileShaderDrawCalls, offscreenBefore.nearestTileShaderDrawCalls, name);
      pixels = Buffer.from(native.canvas.readPremultipliedPixels(canvas.handle, 0, 0, width, height));
      native.canvas.release(canvas.handle);
    } else pixels = Buffer.from(native.canvas.captureSceneRawPremultiplied());
    const file = `frame-${frames.length}.rgba`;
    fs.writeFileSync(path.join(process.argv.at(-1), file), pixels);
    frames.push({name, file});
    return pixels;
  }
  try {
    const sources = [0, 1, 2, 3, 4].map(index => {
      const image = native.canvas.create(32 + index, 32); canvases.push(image);
      const pixels = new Uint8Array(image.width * image.height * 4);
      for (let at = 0; at < pixels.length; at += 4) pixels.set([at % 89, index * 13, 63, 127], at);
      native.canvas.writePremultipliedPixels(image.handle, 0, 0, image.width, image.height, pixels);
      return image;
    });
    const tiny = native.canvas.create(1, 1); canvases.push(tiny); sources.push(tiny);
    native.canvas.writePremultipliedPixels(tiny.handle, 0, 0, 1, 1, new Uint8Array([255, 255, 255, 255]));
    const points = [];
    for (let index = 0; index < 21; ++index) points.push(0, 0, index % 7 * 10,
      Math.floor(index / 7) * 14, 24, 24, 1, 0, [0, 1, 2, 0, 3, 4, 0][index % 7]);
    points.push(384, 288, 12, 12, 48, 48, 0, 0, 5);
    const retained = layer(points, sources);
    for (const animation of [0, 1, 24]) for (const blend of [0, 1, 2, 3])
      frame(`ordinary animation=${animation} blend=${blend}`, retained, {animation: [animation, 0], blend});
    frame('fractional clip', retained, {clip: true});
    const fallbacks = [{linear: true}, {mask: sources[0]}, {animation: [0.25, 0]},
      {transform: [1, 0, 0, 1, 5.25, 6.5]}, {transform: [2, 0, 0, 2, 5, 6]},
      {transform: [-1, 0, 0, 1, 90, 6]}, {transform: [1, 0.1, -0.2, 1, 20, 6]}];
    fallbacks.forEach((options, index) => frame(`unsupported ${index}`, retained, options, false));
    frame('fractional source', layer([0.25, 0, 0, 0, 24, 24, 0, 0, 0], sources), {}, false);
    const mutable = layer([0, 0, 0, 0, 24, 24, 0, 0, 0], sources);
    const originalPixels = frame('canvas before mutation', mutable);
    native.canvas.writePremultipliedPixels(sources[0].handle, 0, 0, 32, 32, new Uint8Array(32 * 32 * 4));
    assert.notDeepEqual(frame('canvas after mutation', mutable), originalPixels);

    const rectangles = [0, 32, 4096, 8160].map(x => [x, 16, 32, 32]);
    const directory = path.join(root, 'prepared'); fs.mkdirSync(directory);
    const descriptor = await native.assets.processTiles([{file: path.join(root, 'snapshot.png'), rectangles}], directory);
    Object.assign(descriptor.sources[0], {source: 'source.png', snapshot: path.join(root, 'snapshot.png'),
      sourceIdentity: native.assets.sourceIdentity('source.png')});
    const set = {identity: 'nearest-tiles', directory, descriptor};
    assert.equal(native.assets.installTileSets([set]), 1);
    const view = await native.images.loadAsync('source.png', false, set.identity);
    const ordinary = native.images.load('source.png'); images.push(view, ordinary);
    const animated = layer([0, 16, 0, 0, 32, 32, 1, 0, 0], [view]);
    for (const offset of [0, 32, 4096, 8160, 8176, 8192, -16, 2048, 0]) {
      const expectedLayer = layer([offset, 16, 0, 0, 32, 32, 0, 0, 0], [ordinary]);
      // Larger offsets exceed the dynamic bound and deliberately select the general shader.
      const eligible = Math.abs(offset) <= 1024;
      assert.deepEqual(frame(`prepared animation ${offset}`, animated, {animation: [offset, 0]}, eligible),
        frame(`ordinary source ${offset}`, expectedLayer, {}, offset + 32 <= 8192));
    }
    for (const rectangle of rectangles) {
      const points = [...rectangle.slice(0, 2), 0, 0, ...rectangle.slice(2), 0, 0, 0];
      assert.deepEqual(frame(`prepared region ${rectangle[0]}`, layer(points, [view])),
        frame(`ordinary region ${rectangle[0]}`, layer(points, [ordinary])));
    }
    for (const [index, source] of [[-16, 16, 32, 32], [8176, 16, 32, 32], [0, -16, 32, 32], [0, 48, 32, 32]].entries()) {
      const points = [...source.slice(0, 2), 0, 0, ...source.slice(2), 0, 0, 0];
      assert.deepEqual(frame(`prepared padded ${index}`, layer(points, [view]), {}, source[0] + source[2] <= 8192),
        frame(`ordinary padded ${index}`, layer(points, [ordinary]), {}, source[0] + source[2] <= 8192));
    }
    const animatedEdge = layer([8160, 16, 0, 0, 32, 32, 1, 0, 0], [view]);
    for (const offset of [0, 16, 32, -16, 0]) {
      const expected = layer([8160 + offset, 16, 0, 0, 32, 32, 0, 0, 0], [ordinary]);
      assert.deepEqual(frame(`prepared animated edge ${offset}`, animatedEdge, {animation: [offset, 0]}),
        frame(`ordinary animated edge ${offset}`, expected, {}, 8192 + offset <= 8192));
    }
    const preparedRetained = layer([4096, 16, 0, 0, 32, 32, 0, 0, 0], [view]);
    const saved = frame('prepared retained before file replacement', preparedRetained);
    fs.writeFileSync(path.join(root, 'source.png'), png(sheetWidth, sheetHeight, Buffer.alloc(sheetPixels.length, 255)));
    assert.deepEqual(frame('prepared retained after file replacement', preparedRetained), saved);
    const changed = await native.images.loadAsync('source.png', false, set.identity); images.push(changed);
    assert.notDeepEqual(frame('replaced file ordinary fallback', layer([4096, 16, 0, 0, 32, 32, 0, 0, 0], [changed])), saved);
    assert.ok(native.assets.consumePreparationInvalidations() & 2);
    frame('prepared linear fallback', preparedRetained, {linear: true}, false);
    frame('prepared offscreen fallback', preparedRetained, {offscreen: true});
    const program = native.render.createFilterProgram(
      'varying vec2 vTextureCoord; uniform sampler2D uSampler; void main(){gl_FragColor=texture2D(uSampler,vTextureCoord);}',
      'attribute vec2 aVertexPosition; attribute vec2 aTextureCoord; uniform mat3 projectionMatrix; varying vec2 vTextureCoord; void main(){gl_Position=vec4((projectionMatrix*vec3(aVertexPosition,1.0)).xy,0,1);vTextureCoord=aTextureCoord;}');
    for (const resolution of [0.5, 1, 2]) {
      const plan = native.render.createFilterPlan({frame: [0, 0, width, height], resolutions: [resolution, resolution],
        passes: [{program: program.handle, input: 0, output: 1, clear: false, blend: 0, uniforms: [], samplers: []}]});
      plans.push(plan);
      frame(`prepared filter resolution ${resolution}`, preparedRetained, {filter: plan.handle}, resolution === 1);
    }
    function filter(frame, resolution = 1, effect = program) {
      const plan = native.render.createFilterPlan({frame, resolutions: [resolution, resolution],
        passes: [{program: effect.handle, input: 0, output: 1, clear: false, blend: 0, uniforms: [], samplers: []}]});
      plans.push(plan); return plan.handle;
    }
    const paddedFilter = filter([-4, -4, width + 8, height + 8]);
    for (const animation of [0, 1, 24]) for (const blend of [0, 1, 2, 3])
      frame(`padded filter animation=${animation} blend=${blend}`, retained,
        {filter: paddedFilter, animation: [animation, 0], blend});
    for (const crop of [[4, 6, width - 8, height - 12], [7, 9, 101, 79]])
      frame(`integer filter crop ${crop}`, retained, {filter: filter(crop)});
    frame('filtered fractional clip', retained, {filter: paddedFilter, clip: true});
    fallbacks.forEach((options, index) => frame(`filtered unsupported ${index}`, retained,
      {...options, filter: paddedFilter}, false));
    frame('fractional filter origin', retained, {filter: filter([-3.5, -4, width + 8, height + 8])}, false);
    frame('fractional filter extent', retained, {filter: filter([-4, -4, width + 8.5, height + 8])}, false);
    frame('nested filter fallback', retained, {filter: paddedFilter, outerFilter: paddedFilter}, false);
    const effectProgram = native.render.createFilterProgram(
      'varying vec2 vTextureCoord; uniform sampler2D uSampler; void main(){vec4 c=texture2D(uSampler,vTextureCoord);gl_FragColor=vec4(c.bgr*0.7,c.a);}',
      'attribute vec2 aVertexPosition; attribute vec2 aTextureCoord; uniform mat3 projectionMatrix; varying vec2 vTextureCoord; void main(){gl_Position=vec4((projectionMatrix*vec3(aVertexPosition,1.0)).xy,0,1);vTextureCoord=aTextureCoord;}');
    frame('non-neutral filter composition', preparedRetained,
      {filter: filter([-4, -4, width + 8, height + 8], 1, effectProgram)});
    frame('filtered prepared animation', animated, {filter: paddedFilter, animation: [32, 0]});
    frame('filtered animated sheet edge', animatedEdge, {filter: paddedFilter, animation: [16, 0]});
    const filteredWritten = frame('filtered canvas before write', mutable, {filter: paddedFilter});
    native.canvas.writePremultipliedPixels(sources[0].handle, 0, 0, 32, 32, new Uint8Array(32 * 32 * 4).fill(255));
    assert.notDeepEqual(frame('filtered canvas after write', mutable, {filter: paddedFilter}), filteredWritten);
    const stats = native.render.stats();
    console.log(JSON.stringify({frames, draws: stats.tileDrawCalls,
      active: stats.nearestTileShaderDrawCalls, fallback: stats.nearestTileShaderFallbackDrawCalls,
      filters: stats.filterDrawCalls, filterTargets: stats.filterTargetAcquires,
      filterClears: stats.filterTargetClears}));
  } finally {
    layers.forEach(handle => native.render.releaseTileLayer(handle));
    images.forEach(image => native.images.release(image.handle));
    canvases.forEach(image => native.canvas.release(image.handle));
    native.runtime.quit();
    fs.rmSync(root, {recursive: true, force: true});
  }
}
