'use strict';

const { loadPmjsRuntime, runModule } = require('../../helpers/runtime-context.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');

function fixture(verified = true) {
  const options = new WeakMap(), troop = { _troopId: 26 };
  class Scene_Battle {
    createDisplayObjects() { this.created = (this.created || 0) + 1; return 'created'; }
    terminate() { this.terminated = true; return 'terminated'; }
  }
  const context = loadPmjsRuntime({
    console: { log() {}, error() {} },
    Scene_Battle, $gameTroop: troop,
  });
  context.PMJS.isatSourceQualification = { verified };
  context.PMJS.pixi4 = {
    getStageRenderOptions: scene => options.get(scene),
    setStageRenderOptions(scene, value) {
      if (value) options.set(scene, { ...value }); else options.delete(scene);
    }
  };
  runModule(context, 'patches/isat/battle-sprite-dispatch.js');
  context.PMJS.phases.emit('afterGuestPlugins');
  context.PMJS.optimizations.finalize();
  return { PMJS: context.PMJS, Scene_Battle, options, troop };
}

test('Bourdon uses ordinary Pixi preparation and generic sprite encoding, preserving scene ownership', () => {
  const { PMJS, Scene_Battle, options, troop } = fixture();
  const scene = new Scene_Battle();
  assert.equal(scene.createDisplayObjects(), 'created');
  assert.deepEqual(options.get(scene), { worldState: 'pixi', plainSpriteSegments: false });
  scene.createDisplayObjects();
  assert.equal(scene.terminate(), 'terminated');
  assert.equal(options.has(scene), false);
  PMJS.pixi4.setStageRenderOptions(scene, { worldState: 'native', plainSpriteSegments: true, other: 42 });
  scene.createDisplayObjects();
  PMJS.pixi4.setStageRenderOptions(scene, { ...options.get(scene), other: 43, plainSpriteSegments: true });
  scene.terminate();
  assert.deepEqual(options.get(scene), { worldState: 'native', plainSpriteSegments: true, other: 43 });
  troop._troopId = 25;
  scene.createDisplayObjects();
  assert.deepEqual(options.get(scene), { worldState: 'native', plainSpriteSegments: true, other: 43 });
});

test('unqualified sources and later qualification replacement retain ordinary battle behavior', () => {
  const failed = fixture(false), scene = new failed.Scene_Battle();
  scene.createDisplayObjects();
  assert.equal(failed.options.has(scene), false);
  const changed = fixture();
  changed.PMJS.isatSourceQualification = { verified: true };
  const later = new changed.Scene_Battle();
  later.createDisplayObjects();
  assert.equal(changed.options.has(later), false);
});
