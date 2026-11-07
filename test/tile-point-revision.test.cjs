'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeHarness } = require('./helpers/scene-encoder-harness.cjs');
function fixture() {
  const { sandbox, makeTexture } = makeHarness();
  const layer = { pointsBuf: [0,0,0,0,16,16,0,0,0], textures: [makeTexture(32,32)], version: 0 };
  sandbox.PMJS.pixi4.tilePointRevision = target => target === layer ? layer.version : -1;
  const builds = [];
  sandbox.NativeHost.render.createTileLayer = points => { builds.push(Array.from(points)); return builds.length; };
  return { sandbox, layer, builds, draw: () => sandbox.ensureNativeRectTileLayer(layer) };
}
test('unchanged admitted revisions skip scans, changed revisions rebuild changed coordinates', () => {
  const { layer, draw, builds } = fixture();
  draw();
  let reads = 0;
  Object.defineProperty(layer._pmjsNativePointSnapshot, '0', { get() { reads++; return 0; } });
  draw(); assert.equal(reads, 0);
  layer.pointsBuf[0] = 16; layer.version++;
  draw(); assert.equal(builds.length, 2); assert.equal(builds[1][0], 16);
});
test('declined providers and replacement arrays preserve coordinate comparison', () => {
  const { layer, draw, builds } = fixture();
  draw(); layer.version = -1;
  layer.pointsBuf[0] = 8; draw(); assert.equal(builds[1][0], 8);
  layer.version = 0; layer.pointsBuf = layer.pointsBuf.slice(); layer.pointsBuf[0] = 16;
  draw(); assert.equal(builds[2][0], 16);
});
test('binding replacement is checked independently of coordinate revisions', () => {
  const { sandbox, layer, draw, builds } = fixture();
  draw();
  layer.textures[0] = { baseTexture: { source: { _nativeImage: { handle: 999, width: 32, height: 32 } } } };
  draw(); assert.equal(builds.length, 2);
  assert.ok(sandbox.PMJS.pixi4.tilePointRevision(layer, layer.pointsBuf) >= 0);
});
