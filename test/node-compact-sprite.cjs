'use strict';

process.env.PMJS_GRAPHICS_DIAGNOSTICS = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { png } = require('./helpers/png.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const native = require(path.resolve(process.argv[2]));

test('compact prepared sprites match full textures through filters, fades and clips', async context => {
  const root = temporaryDirectory('pmjs-compact-sprite-');
  const multiRow = process.argv.includes('--multi-row');
  const columns = multiRow ? 4 : 5, rows = multiRow ? 5 : 1;
  const cellWidth = 816, cellHeight = 624, height = cellHeight * rows, width = cellWidth * columns;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const cell = Math.floor(x / cellWidth) + Math.floor(y / cellHeight) * columns, cx = x % cellWidth, cy = y % cellHeight;
    const inside = cx >= 158 + cell && cx < 693 - cell && cy >= 156 + cell && cy < 315 + cell;
    const gray = inside ? (cx * 71 + cy * 29 + cell * 53) % 256 : 0;
    pixels.set([gray, gray, gray, 255], (y * width + x) * 4);
  }
  const bytes = png(width, height, pixels);
  fs.writeFileSync(path.join(root, 'source.png'), bytes);
  native.initialize({ gameRoot: root, assetRoot: '', width: cellWidth, height: cellHeight,
    windowTitle: 'compact prepared sprite pixels', imageWarmCacheBytes: 0 });
  try {
    const schema = native.scene.schema;
    const original = native.images.loadBytes(bytes);
    const directory = path.join(root, 'prepared');
    fs.mkdirSync(directory);
    const descriptor = await native.assets.processImage('source.png', directory,
      { grid: [columns, rows], crop: [0, 0, cellWidth, cellHeight], backdrop: [0, 0, 0, 255] });
    assert.ok(descriptor, 'fixture must retain prepared image storage');
    assert.equal(descriptor.compactEligible, true, 'preparation certifies compact sampling');
    if (process.argv.includes('--legacy-index')) delete descriptor.compactEligible;
    native.assets.installPrepared([{ source: 'source.png', directory, descriptor,
      sourceIdentity: native.assets.sourceIdentity('source.png') }]);
    const compact = await native.images.loadAsync('source.png');
    const fragment = 'varying vec2 vTextureCoord; uniform sampler2D uSampler; void main(){vec4 c=texture2D(uSampler,vTextureCoord);gl_FragColor=vec4(c.rgb*vec3(0.75,0.9,0.6),c.a);}';
    const vertex = 'attribute vec2 aVertexPosition; attribute vec2 aTextureCoord; uniform mat3 projectionMatrix; varying vec2 vTextureCoord; void main(){gl_Position=vec4((projectionMatrix*vec3(aVertexPosition,1.0)).xy,0,1);vTextureCoord=aTextureCoord;}';
    const program = native.render.createFilterProgram(fragment, vertex);
    const plan = native.render.createFilterPlan({ frame: [-4, -4, 824, 632], resolutions: [1, 1],
      passes: [{ program: program.handle, input: 0, output: 1, clear: false, blend: 0, uniforms: [], samplers: [] }] });
    function render(image, cell, alpha, blend, filtered, scale, clip, floatUv = false) {
      const count = filtered ? 3 : 1, sprite = filtered ? 1 : 0;
      const metadata = new Uint32Array(count * schema.metadataStride);
      const values = new Float32Array(count * schema.valueStride);
      for (let i = 0; i < count; i++) {
        metadata.set([i === sprite ? 1 : i === 0 ? 6 : 7, filtered && i > 0 ? 0 : 0xffffffff,
          i === sprite ? image.handle : i === 0 ? plan.handle : 0, 0xc3e7af,
          i === sprite ? blend : i === 0 ? 31 : 0, i === sprite ? (1 << 8) | (floatUv ? 1 << 17 : 0) : 0, 0], i * schema.metadataStride);
        values.set([1, 0, 0, 1, 0, 0, 1], i * schema.valueStride);
      }
      const at = sprite * schema.valueStride;
      values.set([scale, 0, 0, scale, 0, -15, alpha], at);
      values.set([cell % columns * cellWidth, Math.floor(cell / columns) * cellHeight, cellWidth, cellHeight, cellWidth, cellHeight], at + 9);
      if (clip) {
        metadata[sprite * schema.metadataStride + 5] |= 1;
        values.set([180, 140, 510, 210], at + 17);
      }
      native.render.setClearColor(0.08, 0.15, 0.2, 0.6);
      native.beginFrame();
      native.scene.submit(schema.version, metadata, values, count);
      native.renderScene();
      return Buffer.from(native.canvas.captureSceneRawPremultiplied());
    }
    let comparisons = 0;
    const cells = multiRow ? [0, 1, 2, 3, 4, 8, 12, 16, 19] : [0, 1, 2, 3, 4];
    for (const floatUv of multiRow ? [false, true] : [false]) {
      for (const filtered of [false, true]) for (const cell of cells) {
        for (const alpha of [0.37, 1]) for (const blend of [0, 1, 2, 3]) {
          assert.deepEqual(render(compact, cell, alpha, blend, filtered, 1, false, floatUv),
            render(original, cell, alpha, blend, filtered, 1, false, floatUv),
            `filter=${filtered} cell=${cell} alpha=${alpha} blend=${blend} floatUv=${floatUv}`);
          comparisons++;
        }
      }
      const posedCell = multiRow ? 19 : 2;
      for (const filtered of [false, true]) for (const scale of [0.98, 1.31]) for (const clip of [false, true]) {
        assert.deepEqual(render(compact, posedCell, 0.63, 0, filtered, scale, clip, floatUv),
          render(original, posedCell, 0.63, 0, filtered, scale, clip, floatUv), `filter=${filtered} scale=${scale} clip=${clip}`);
        comparisons++;
      }
    }
    const memory = native.images.memory(100);
    const owner = memory.largest.find(entry => entry.handle === compact.handle);
    assert.ok(owner, 'prepared sprite owner must remain observable');
    assert.equal(owner.palette, false);
    assert.equal(memory.sourceTextureBuilds, 0);
    context.diagnostic(JSON.stringify({ comparisons, compact: owner }));
    native.images.release(compact.handle);
    native.images.release(original.handle);
  } finally {
    native.runtime.quit();
  }
});
