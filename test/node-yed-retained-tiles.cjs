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
  for (const [x,y] of [[1,0],[1,1],[0,1],[0,0],[-1,0],[-1,-1],[0,0]]) {
    map.origin.x=x*16;map.origin.y=y*16;
    api.prepare(map,x,y);
    const expected=[];
    for(let row=0;row<2;row++)for(let col=0;col<2;col++) {
      const cx=x+col,cy=y+row;
      if(cx<0||cx>=2||cy<0||cy>=2)continue;
      expected.push(cx===0 ? 32 : 16,0,col*16,row*16,16,16,0,0,0);
    }
    const candidate=render(context.ensureNativeRectTileLayer(rect),0);
    const reference=native.render.createTileLayer(new Float32Array(expected),[atlas.handle]);
    assert.equal(candidate,render(reference,0),'tile-window crossings preserve pixels');
    native.render.releaseTileLayer(reference);
  }
  console.log(JSON.stringify({ pixelComparisons: 16, uploads: scene.uploads }));
} finally {
  scene.dispose();
  fs.rmSync(root, { recursive: true, force: true });
}
