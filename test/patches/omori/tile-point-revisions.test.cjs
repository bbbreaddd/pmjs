'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../../patches/omori/tile-point-revisions.js'), 'utf8');
const acceptedDigest = 'ebc98404226f51c05b0345fbcbaa0074ca5199fda1912aa0d022708b005e0317';
function fixture({ digest = acceptedDigest, unreadable = false, realAnimation = false, modSources = null,
  plugins = [{name:'YED_Tiled',status:true}] } = {}) {
  function RectTileLayer() { this.pointsBuf = []; }
  RectTileLayer.prototype.addRect = function(value) { this.pointsBuf.push(value); };
  RectTileLayer.prototype.clear = function() { this.pointsBuf.length = 0; this._pmjsNativeGeneration++; };
  var retained = { flushAnimation(layer, value) { layer.pointsBuf[0] = value; layer._pmjsNativeGeneration++; } };
  var actualMethods;
  if (realAnimation) {
    const runtime = path.resolve(__dirname, '../../..');
    const animationContext = { PMJS: {}, __pmjsBuiltinRequire: require };
    vm.runInNewContext(fs.readFileSync(path.join(runtime, 'js/pmjs-core/methods.js'), 'utf8'), animationContext);
    vm.runInNewContext(fs.readFileSync(path.join(runtime, 'js/pmjs-plugins/yed/retained-tiles.js'), 'utf8'), animationContext);
    retained = animationContext.PMJS.yedRetainedTiles;
    actualMethods = animationContext.PMJS.methods;
  }
  const accepted = new Set([RectTileLayer.prototype.addRect, RectTileLayer.prototype.clear, retained.flushAnimation]);
  const refused = [], hashInputs = [];
  let install;
  const context = { PIXI: { tilemap: { RectTileLayer } }, $plugins: plugins,
    PMJS: { omori: { modSourceIdentity: () => modSources }, pixi4: {}, yedRetainedTiles: retained,
      methods: { matchesSource: (fn, expected) => realAnimation && fn === retained.flushAnimation ?
        actualMethods.matchesSource(fn, expected) : accepted.has(fn), fingerprint: () => digest },
      optimizations: { register() {}, isEnabled: () => true, refuse(_id, reason) { refused.push(reason); }, reportFallback() {} },
      phases: { on(_phase, _id, callback) { install = callback; } } },
    __pmjsBuiltinRequire: name => name === 'node:buffer' ? { Buffer } : ({ createHash() { return { update(value) { hashInputs.push(value); return this; }, digest: () => digest }; } }),
    readGameBytes() { if (unreadable) throw new Error('missing'); return Buffer.alloc(0); },
    NativeHost: { fs: { readBytes() { throw new Error('raw encrypted reads are unavailable'); } } } };
  vm.runInNewContext(source, context);
  return { context, install, refused, RectTileLayer, retained, hashInputs };
}

test('CEP graphs hash stable plugin identities and the qualified hook sources', () => {
  for (const digest of ['2bc535afc6a46e94647d822258fbefa0ad83171805bb1742f6405f49b236f7ff',
    'fa139f3943f5857b7e194c4bba3081cd2c9a3ecb46da60be96d501cc3a170f2f']) {
    const { context, install, refused, hashInputs } = fixture({ digest, plugins:[{name:'random',status:true}],
      modSources:{digest:'hooks',pluginNames:{random:'@oneloader/0'},valid:true} });
    install();
    assert.deepEqual(refused, []);
    assert.equal(typeof context.PMJS.pixi4.tilePointRevision, 'function');
    assert.ok(hashInputs.includes('@oneloader/0\0'));
    assert.ok(!hashInputs.includes('random\0'));
    assert.ok(hashInputs.includes('\0modloader\0hooks'));
  }
});

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

test('the qualified original source graph supports decoded files and revision invalidation', () => {
  const { context, install, RectTileLayer, refused } = fixture({
    digest: 'b2d4ded21ef340df9c7f4ccc802134bab0dd297c1be392957a6a4f24ef53b300' });
  install();
  assert.deepEqual(refused, []);
  const layer = new RectTileLayer(); layer.addRect(1);
  assert.equal(context.PMJS.pixi4.tilePointRevision(layer, layer.pointsBuf), 1);
  layer.pointsBuf = [2];
  assert.equal(context.PMJS.pixi4.tilePointRevision(layer, layer.pointsBuf), -1);
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

test('changed execution hooks decline revisions for previously tracked layers', () => {
  const modSources = { digest: 'qualified', pluginNames: {}, valid: true };
  const { context, install, RectTileLayer } = fixture({ modSources });
  install();
  const layer = new RectTileLayer(); layer.addRect(1);
  assert.equal(context.PMJS.pixi4.tilePointRevision(layer, layer.pointsBuf), 1);
  modSources.valid = false;
  assert.equal(context.PMJS.pixi4.tilePointRevision(layer, layer.pointsBuf), -1);
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

test('current retained animation writer qualifies for tile revisions', () => {
  const { context, install, refused } = fixture({ realAnimation: true });
  install();
  assert.deepEqual(refused, []);
  assert.equal(typeof context.PMJS.pixi4.tilePointRevision, 'function');
});
