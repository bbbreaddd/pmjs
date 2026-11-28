'use strict';

const { loadPmjsRuntime, runModule } = require('../../helpers/runtime-context.cjs');
const assert = require('node:assert/strict');
const test = require('node:test');
test('map sprite policy preserves prior values, external edits and scene reuse', () => {
const options = new WeakMap();
let map = 30, calls = 0;
class Scene_Map { createDisplayObjects() { calls++; return 'created'; } }
const context = loadPmjsRuntime({
  console: { log() {}, error() {} },
  Scene_Map, $gameMap: { mapId: () => map },
});
const PMJS = context.PMJS;
PMJS.isatSourceQualification = { verified: true };
PMJS.pixi4 = {
  getStageRenderOptions: scene => options.get(scene),
  setStageRenderOptions(scene, value) {
    if (value && value.worldState !== 'pixi' && value.worldState !== 'native') throw new TypeError('worldState required');
    if (value) options.set(scene, { ...value }); else options.delete(scene);
  }
};
runModule(context, 'patches/isat/map-sprite-dispatch.js');
PMJS.phases.emit('afterGuestPlugins');
PMJS.optimizations.finalize();
function enter(previous) {
  const scene = new Scene_Map();
  if (previous) PMJS.pixi4.setStageRenderOptions(scene, previous);
  map = 30;
  assert.equal(scene.createDisplayObjects(), 'created');
  assert.deepEqual(options.get(scene), { ...previous, worldState: 'pixi', plainSpriteSegments: false });
  return scene;
}
function exit(scene) { map = 22; scene.createDisplayObjects(); return options.get(scene); }
const defaultScene = enter();
defaultScene.createDisplayObjects();
assert.equal(exit(defaultScene), undefined, 'a repeated entry restores the original absence of options');
assert.deepEqual(exit(enter({ worldState: 'native', plainSpriteSegments: true })),
  { worldState: 'native', plainSpriteSegments: true });
assert.deepEqual(exit(enter({ worldState: 'pixi', plainSpriteSegments: false })),
  { worldState: 'pixi', plainSpriteSegments: false }, 'explicit original values retain their presence');
assert.deepEqual(exit(enter({ worldState: 'pixi' })), { worldState: 'pixi' });
const unrelated = enter({ worldState: 'native', plainSpriteSegments: true, other: 'before' });
PMJS.pixi4.setStageRenderOptions(unrelated, { ...options.get(unrelated), other: 'after', added: 42 });
assert.deepEqual(exit(unrelated), { worldState: 'native', plainSpriteSegments: true, other: 'after', added: 42 });
const externalBoth = enter();
PMJS.pixi4.setStageRenderOptions(externalBoth, { worldState: 'native', plainSpriteSegments: true, other: 42 });
assert.deepEqual(exit(externalBoth), { worldState: 'native', plainSpriteSegments: true, other: 42 },
  'external overrides of both fields survive');
const externalWorld = enter();
PMJS.pixi4.setStageRenderOptions(externalWorld, { worldState: 'native', plainSpriteSegments: false });
assert.deepEqual(exit(externalWorld), { worldState: 'native' });
const externalSegments = enter();
PMJS.pixi4.setStageRenderOptions(externalSegments, { worldState: 'pixi', plainSpriteSegments: true });
assert.deepEqual(exit(externalSegments), { worldState: 'native', plainSpriteSegments: true },
  'remaining external fields receive the default native world-state contract');
const externalOther = enter();
PMJS.pixi4.setStageRenderOptions(externalOther, { ...options.get(externalOther), other: 42 });
assert.deepEqual(exit(externalOther), { other: 42, worldState: 'native' });
const externalClear = enter({ worldState: 'native', plainSpriteSegments: true });
PMJS.pixi4.setStageRenderOptions(externalClear, null);
assert.equal(exit(externalClear), undefined, 'an external clear is preserved');
const fresh = new Scene_Map();
fresh.createDisplayObjects();
assert.equal(options.has(fresh), false, 'unowned scenes do not acquire options');
PMJS.pixi4.setStageRenderOptions(fresh, { worldState: 'pixi', plainSpriteSegments: false, other: 7 });
fresh.createDisplayObjects();
assert.deepEqual(options.get(fresh), { worldState: 'pixi', plainSpriteSegments: false, other: 7 });
});

function qualificationFixture(qualification = { verified: true }) {
  const options = new WeakMap();
  class Scene_Map {
    createDisplayObjects() { return 'created'; }
    update() { return 'updated'; }
    terminate() { return 'terminated'; }
  }
  const context = loadPmjsRuntime({
    console: { log() {}, error() {} },
    Scene_Map, $gameMap: { mapId: () => 30 },
  });
  const PMJS = context.PMJS;
  if (qualification !== undefined) PMJS.isatSourceQualification = qualification;
  PMJS.pixi4 = {
    getStageRenderOptions: scene => options.get(scene),
    setStageRenderOptions(scene, value) { if (value) options.set(scene, { ...value }); else options.delete(scene); },
  };
  const original = Scene_Map.prototype.createDisplayObjects;
  runModule(context, 'patches/isat/map-sprite-dispatch.js');
  PMJS.phases.emit('afterGuestPlugins');
  PMJS.phases.emit('afterPlugins');
  PMJS.methods.install();
  PMJS.optimizations.finalize();
  const refusals = Array.from(PMJS.optimizations.dump()).filter(entry => entry.refusalReason).map(entry => entry.refusalReason);
  return { PMJS, Scene_Map, options, refusals, original };
}

test('unqualified map sources do not install a scene policy', () => {
  for (const qualification of [null, { verified: false }]) {
    const h = qualificationFixture(qualification);
    assert.equal(h.Scene_Map.prototype.createDisplayObjects, h.original);
    assert.deepEqual(h.refusals, ['unqualified map sources']);
  }
});

test('qualification replacement restores owned policy on update and preserves foreign edits', () => {
  const h = qualificationFixture(), scene = new h.Scene_Map();
  h.PMJS.pixi4.setStageRenderOptions(scene, { worldState: 'native', plainSpriteSegments: true, other: 1 });
  scene.createDisplayObjects();
  h.PMJS.pixi4.setStageRenderOptions(scene, { ...h.options.get(scene), plainSpriteSegments: true, other: 2 });
  h.PMJS.isatSourceQualification = { verified: true };
  assert.equal(scene.update(), 'updated');
  assert.deepEqual(h.options.get(scene), { worldState: 'native', plainSpriteSegments: true, other: 2 });
  scene.createDisplayObjects();
  assert.equal(h.options.get(scene).worldState, 'native');
});

test('map termination restores the original absence of scene policy', () => {
  const h = qualificationFixture(), scene = new h.Scene_Map();
  scene.createDisplayObjects();
  assert.equal(scene.terminate(), 'terminated');
  assert.equal(h.options.has(scene), false);
});
