'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
require('./effect-fixtures.cjs').writeEffectFixtures(path.resolve(process.argv[3]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '', width: 64, height: 64,
  windowTitle: 'MZ particle contract' });
const fx = native.effects;
const projection = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, -64, 0, 0, 0, 1];
const camera = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -10, 1];
function frame(handle, transform = projection) {
  native.beginFrame();
  const metadata = new Uint32Array([9, 0xffffffff, handle, 0xffffff, 0, 0, 0]);
  const values = new Float32Array(native.scene.schema.valueStride);
  values.set([-2016, -2016, 4096, 4096, 0, 0, 1]);
  values.set(transform, 7);
  values.set(camera, 23);
  values.set([64, 64], 39);
  native.scene.submit(native.scene.schema.version, metadata, values, 1);
  native.renderScene();
  return Array.from(native.canvas.captureSceneRawPremultiplied());
}
try {
  assert.equal(native.scene.schema.effects, true);
  const context = fx.createContext();
  assert.match(fx.license, /Copyright \(c\) 2011 Effekseer Project/);
  assert.throws(() => fx.load(context, '../outside.efkefc', 1), /cannot load/);
  assert.throws(() => fx.load(context, 'missing.efkefc', 1), /cannot load/);
  assert.throws(() => fx.load(context, 'effects/MissingTexture.efkefc', 1), /cannot load effect resource/);
  assert.throws(() => fx.load(context, 'effects/InvalidTexture.efkefc', 1), /invalid effect color texture/);
  assert.throws(() => fx.load(context, 'effects/MissingSound.efkefc', 1), /cannot load effect sound/);
  assert.throws(() => fx.load(context, 'effects/InvalidSound.efkefc', 1), /cannot load effect sound/);
  assert.throws(() => fx.load(context, 'effects/MissingModel.efk', 1), /cannot load effect resource|invalid effect model/);
  assert.equal(fx.counts().effects, 0, 'failed resources must not enter the effect cache');
  const texture = fx.load(context, 'effects/TextureResource.efkefc', 1);
  fx.release(context, texture);
  const effect = fx.load(context, 'effects/square.efkefc', 1);
  const handle = fx.play(context, effect, 0, 0, 0);
  fx.control(handle, 'seed', 2147483647, 0, 0, 0);
  fx.control(handle, 'seed', 1, 0, 0, 0);
  assert.throws(() => fx.control(handle, 'seed', 1e30, 0, 0, 0), /invalid effect random seed/);
  assert.equal(fx.dynamicInput(handle, 0), 0);
  fx.control(handle, 'dynamicInput', 3, -2.5, 0, 0);
  assert.equal(fx.dynamicInput(handle, 3), -2.5);
  for (const index of [-1, 4, 0.5, NaN, Infinity]) {
    assert.throws(() => fx.dynamicInput(handle, index), /invalid effect dynamic input index/);
    assert.throws(() => fx.control(handle, 'dynamicInput', index, 0, 0, 0), /invalid effect (input index|control)/);
    assert.throws(() => fx.control(handle, 'trigger', index, 0, 0, 0), /invalid effect (input index|control)/);
  }
  for (const value of [-1, 256, NaN, Infinity]) {
    assert.throws(() => fx.control(handle, 'color', value, 255, 255, 255), /invalid effect (color|control)/);
  }
  for (const value of [-1, 10001, NaN, Infinity]) {
    assert.throws(() => fx.control(handle, 'frame', value, 0, 0, 0), /invalid effect (frame|control)/);
  }
  fx.update(context, 1);
  assert.ok(fx.exists(handle));
  const initial = frame(handle);
  assert.ok(initial.some((value, index) => index % 4 === 0 && value > 200), 'particle must draw visible red pixels');
  assert.deepEqual(frame(handle), initial, 'rendering must not advance simulation');
  const sibling = fx.play(context, effect, 0, 0, 0);
  fx.control(sibling, 'frame', 6, 0, 0, 0);
  assert.deepEqual(frame(handle), initial, 'seeking one effect must not advance another');
  fx.control(sibling, 'release', 0, 0, 0, 0);
  fx.control(handle, 'paused', 1, 0, 0, 0);
  fx.update(context, 5);
  assert.deepEqual(frame(handle), initial, 'paused particles must retain their frame');
  fx.control(handle, 'paused', 0, 0, 0, 0);
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
  assert.throws(() => fx.dynamicInput(handle, 0), /stale effect handle/);
  assert.throws(() => frame(handle), /invalid native scene packet/);
  const sound = fx.load(context, 'effects/Sound.efkefc', 1);
  const sounding = fx.play(context, sound, 0, 0, 0);
  fx.update(context, 2);
  assert.equal(fx.counts().voices, 1, 'authored particle sounds must play through native audio');
  fx.release(context, sound);
  assert.equal(fx.counts().voices, 1, 'cache release must retain a playing sound');
  fx.control(sounding, 'stop', 0, 0, 0, 0);
  fx.update(context, 2);
  assert.equal(fx.counts().voices, 0, 'stopping an effect must release its sound voices');
  for (const name of ['SpatialSound', 'SpatialStereo']) {
    const spatial = fx.load(context, 'effects/' + name + '.efkefc', 1);
    const spatialHandle = fx.play(context, spatial, 3, 4, 0);
    fx.update(context, 2);
    assert.equal(fx.counts().voices, 1, 'spatial sound must become ready and play');
    fx.control(spatialHandle, 'paused', 1, 0, 0, 0);
    fx.update(context, 3);
    assert.equal(fx.counts().voices, 1, 'paused sound must retain its voice');
    fx.release(context, spatial);
    fx.control(spatialHandle, 'paused', 0, 0, 0, 0);
    fx.update(context, 2);
    assert.equal(fx.counts().voices, 1, 'cache release must retain a resumed spatial sound');
    fx.control(spatialHandle, 'stop', 0, 0, 0, 0);
    fx.update(context, 2);
    assert.equal(fx.counts().voices, 0, 'spatial sound must stop with its effect');
  }
  const mono = fx.load(context, 'effects/SpatialSound.efkefc', 1);
  const stereo = fx.load(context, 'effects/SpatialStereo.efkefc', 1);
  const monoHandle = fx.play(context, mono, -1, 0, 0);
  const stereoHandle = fx.play(context, stereo, 1, 0, 0);
  fx.update(context, 2);
  assert.equal(fx.counts().voices, 2);
  fx.control(stereoHandle, 'paused', 1, 0, 0, 0);
  fx.control(monoHandle, 'stop', 0, 0, 0, 0);
  fx.update(context, 2);
  assert.equal(fx.counts().voices, 1, 'stopping one sound tag must retain another effect voice');
  fx.control(stereoHandle, 'stop', 0, 0, 0, 0);
  fx.update(context, 2);
  fx.release(context, mono); fx.release(context, stereo);
  const repeatedSound = fx.load(context, 'effects/SpatialSound.efkefc', 1);
  const oldest = fx.play(context, repeatedSound, 0, 0, 0);
  fx.update(context, 2);
  fx.control(oldest, 'paused', 1, 0, 0, 0);
  const reusedHandles = [];
  for (let index = 0; index < 24; index++) {
    reusedHandles.push(fx.play(context, repeatedSound, 0, 0, 0));
    fx.update(context, 2);
  }
  assert.equal(fx.counts().voices, 16, 'overlapping particle sounds must remain within the stock voice limit');
  for (const reused of reusedHandles) fx.control(reused, 'paused', 1, 0, 0, 0);
  fx.control(oldest, 'stop', 0, 0, 0, 0);
  fx.update(context, 2);
  assert.equal(fx.counts().voices, 16, 'stale paused tags must not stop a reused voice');
  fx.release(context, repeatedSound);
  fx.releaseContext(context);
  assert.deepEqual(fx.counts(), { contexts: 0, effects: 0, handles: 0, voices: 0 });
  console.log('native MZ particle rendering and ownership passed');
} finally { native.runtime.quit(); }
