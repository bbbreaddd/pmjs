'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { createHostContext } = require('./helpers/mz-host-context.cjs');
const { titleCanvasFixtures } = require('./helpers/title-canvas-scenario.cjs');
const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'assets/reference/skia65-canvas-primitives.json.gz'))));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.equal(fixture.scenarioSha256, hash(path.join(__dirname, 'helpers/title-canvas-scenario.cjs')));
assert.equal(fixture.readbackSha256, hash(path.join(__dirname, '../tools/skia65/reference-readback.cjs')));
assert.match(fixture.generatorSha256, /^[a-f0-9]{64}$/);
assert.equal(fixture.reference.nwVersion, '0.29.0');
assert.equal(fixture.reference.chromium, '65.0.3325.146');
assert.equal(fixture.reference.archiveSha256, 'f6b759cbe0f2b57082ff08d63350be2e73bbf1a44717137fece0c13d048ff14b');
assert.equal(fixture.reference.referenceFiles.nw, '0c99f7355109513384f386bd6bff014d9c89d011b3eeb5690cae4da56b2aca73');
assert.equal(fixture.representation, 'direct premultiplied RGBA8');
assert.equal(fixture.freshProcessReplays, 2);
assert.equal(fixture.frozenFramesEqual, true);
assert.equal(Object.keys(fixture.frames).length, 25);
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '', width: 64, height: 64, windowTitle: 'Chromium 65 Canvas primitives' });
const create = native.canvas.create;
for (const immediate of [false, true]) {
  const handles = new Set();
  native.canvas.create = function(width, height) {
    const canvas = create(width, height);
    handles.add(canvas.handle);
    if (immediate) native.canvas.readPixels(canvas.handle, 0, 0, 1, 1);
    return canvas;
  };
  try {
    const context = createHostContext(native, { graphics: false });
    const frames = vm.runInContext('(' + titleCanvasFixtures.toString() + ')(function(canvas) { return NativeHost.canvas.readPremultipliedPixels(canvas._ensureNativeCanvas().handle, 0, 0, canvas.width, canvas.height); })', context);
    assert.deepEqual(Object.keys(frames), Object.keys(fixture.frames));
    for (const [name, frame] of Object.entries(frames)) {
      assert.equal(frame.width, fixture.frames[name].width);
      assert.equal(frame.height, fixture.frames[name].height);
      assert.deepEqual(Buffer.from(frame.pixels), Buffer.from(fixture.frames[name].pixels), name + ' immediate=' + immediate);
    }
  } finally {
    native.canvas.create = create;
    for (const handle of handles) native.canvas.release(handle);
  }
}
assert.equal(native.canvas.memory().liveCount, 0);
console.log(JSON.stringify({ cases: 25, drawingModes: 2, differingPixels: 0 }));
