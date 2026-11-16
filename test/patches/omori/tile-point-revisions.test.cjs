'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../../patches/omori/tile-point-revisions.js'), 'utf8');
const acceptedDigest = 'ebc98404226f51c05b0345fbcbaa0074ca5199fda1912aa0d022708b005e0317';
function fixture({ digest = acceptedDigest, unreadable = false } = {}) {
  function RectTileLayer() { this.pointsBuf = []; }
  RectTileLayer.prototype.addRect = function(value) { this.pointsBuf.push(value); };
  RectTileLayer.prototype.clear = function() { this.pointsBuf.length = 0; this._pmjsNativeGeneration++; };
  const retained = { flushAnimation(layer, value) { layer.pointsBuf[0] = value; layer._pmjsNativeGeneration++; } };
  const accepted = new Set([RectTileLayer.prototype.addRect, RectTileLayer.prototype.clear, retained.flushAnimation]);
  const refused = [];
  let install;
  const context = { PIXI: { tilemap: { RectTileLayer } }, $plugins: [{ name: 'YED_Tiled', status: true }],
    PMJS: { pixi4: {}, yedRetainedTiles: retained,
      methods: { matchesSource: fn => accepted.has(fn), fingerprint: () => digest },
      optimizations: { register() {}, isEnabled: () => true, refuse(_id, reason) { refused.push(reason); } },
      phases: { on(_phase, _id, callback) { install = callback; } } },
    __pmjsBuiltinRequire: name => name === 'node:buffer' ? { Buffer } : ({ createHash() { return { update() { return this; }, digest: () => digest }; } }),
    NativeHost: { fs: { readBytes() { if (unreadable) throw new Error('missing'); return Buffer.alloc(0); } } } };
  vm.runInNewContext(source, context);
  return { context, install, refused, RectTileLayer, retained };
}

test('recognized writers advance revisions without replacing guest arrays', () => {
  const { context, install, RectTileLayer, retained } = fixture();
  install();
  const layer = new RectTileLayer(), points = layer.pointsBuf;
  const revision = context.PMJS.pixi4.tilePointRevision;
  assert.equal(revision(layer, points), -1);
  layer.addRect(1);
  assert.equal(layer.pointsBuf, points);
  assert.equal(revision(layer, points), 1);
  retained.flushAnimation(layer, 2);
  assert.equal(revision(layer, points), 2);
  layer.clear();
  assert.equal(revision(layer, points), 3);
});

test('replacement arrays and changed methods decline the shortcut', () => {
  for (const kind of ['array', 'method', 'animation']) {
    const { context, install, RectTileLayer, retained } = fixture();
    install();
    const layer = new RectTileLayer(); layer.addRect(1);
    if (kind === 'array') layer.pointsBuf = [1];
    if (kind === 'method') layer.addRect = function() {};
    if (kind === 'animation') retained.flushAnimation = function() {};
    assert.equal(context.PMJS.pixi4.tilePointRevision(layer, layer.pointsBuf), -1);
  }
});

test('changed or unreadable sources leave the original writers installed', () => {
  for (const options of [{ digest: 'changed' }, { unreadable: true }]) {
    const { context, install, RectTileLayer, refused } = fixture(options);
    const writer = RectTileLayer.prototype.addRect;
    install();
    assert.equal(RectTileLayer.prototype.addRect, writer);
    assert.equal(context.PMJS.pixi4.tilePointRevision, undefined);
    assert.equal(refused.length, 1);
  }
});
