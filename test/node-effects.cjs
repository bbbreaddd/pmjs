'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '', width: 64, height: 64,
  windowTitle: 'MZ particle contract' });
const fx = native.effects;
const projection = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, -64, 0, 0, 0, 1];
const camera = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -10, 1];
function frame(handle, transform = projection) {
  native.beginFrame();
  const metadata = new Uint32Array([9, 0xffffffff, handle, 0xffffff, 0, 0, 0]);
  const values = new Float32Array(41);
  values.set([-2016, -2016, 4096, 4096, 0, 0, 1]);
  values.set(transform, 7);
  values.set(camera, 23);
  native.scene.submit(28, metadata, values, 1);
  native.renderScene();
  return Array.from(native.canvas.captureSceneRawPremultiplied());
}
try {
  assert.equal(native.scene.schema.effects, true);
  const context = fx.createContext();
  assert.throws(() => fx.load(context, '../outside.efkefc', 1), /cannot load/);
  assert.throws(() => fx.load(context, 'missing.efkefc', 1), /cannot load/);
  const effect = fx.load(context, 'effects/square.efkefc', 1);
  const handle = fx.play(context, effect, 0, 0, 0);
  fx.control(handle, 'seed', 1, 0, 0, 0);
  fx.update(context, 1);
  assert.ok(fx.exists(handle));
  const initial = frame(handle);
  assert.ok(initial.some((value, index) => index % 4 === 0 && value > 200), 'particle must draw visible red pixels');
  assert.deepEqual(frame(handle), initial, 'rendering must not advance simulation');
  const mirror = projection.slice();
  mirror[0] = -1;
  fx.control(handle, 'location', 2, 0, 0, 0);
  fx.update(context, 1);
  assert.notDeepEqual(frame(handle, mirror), initial, 'projection and location must affect drawing');
  fx.release(context, effect);
  assert.ok(fx.exists(handle), 'cache release must retain a playing effect');
  assert.ok(frame(handle).some(value => value > 200));
  assert.throws(() => fx.play(context, effect, 0, 0, 0), /stale effect resource/);
  fx.control(handle, 'stop', 0, 0, 0, 0);
  fx.update(context, 1);
  assert.equal(fx.exists(handle), false);
  assert.ok(frame(handle).every((value, index) => index % 4 === 3 || value === 0));
  fx.control(handle, 'release', 0, 0, 0, 0);
  assert.throws(() => frame(handle), /invalid native scene packet/);
  fx.releaseContext(context);
  assert.deepEqual(fx.counts(), { contexts: 0, effects: 0, handles: 0, voices: 0 });
  console.log('native MZ particle rendering and ownership passed');
} finally { native.runtime.quit(); }
