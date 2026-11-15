'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
const root = temporaryDirectory('pmjs-retained-tiles-');
native.initialize({ gameRoot: root, width: 32, height: 32, windowTitle: 'retained tiles' });
const { createRetainedTileScene } = require('./helpers/retained-tile-scene.cjs');
const scene = createRetainedTileScene(native);
const { atlas, map, api, context, rect, render } = scene;
try {
  for (const frame of [0, 1, 2]) {
    if (frame) api.updateAnimation(map);
    for (const camera of [0, 5, 5]) {
      map.origin.x = camera;
      api.prepare(map, 0, 0);
      const handle = context.ensureNativeRectTileLayer(rect);
      const candidate = render(handle, camera);
      const expected = [frame * 16,0,0,0,16,16,0,0,0, 16,0,16,0,16,16,0,0,0,
        frame * 16,0,0,16,16,16,0,0,0, 16,0,16,16,16,16,0,0,0];
      const reference = native.render.createTileLayer(new Float32Array(expected), [atlas.handle]);
      assert.equal(candidate, render(reference, camera), 'source patches and camera shifts preserve pixels');
      native.render.releaseTileLayer(reference);
      assert.equal(scene.uploads, frame + 1, 'warm camera movement must reuse native geometry');
    }
  }
  console.log(JSON.stringify({ pixelComparisons: 9, uploads: scene.uploads }));
} finally {
  scene.dispose();
  fs.rmSync(root, { recursive: true, force: true });
}
