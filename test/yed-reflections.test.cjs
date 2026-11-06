'use strict';

const { runOptimizationAdapter } = require('./helpers/runtime-context.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function fixture(recognized = true, surfaces = []) {
  class Container {
    constructor() { this.children = []; this.visible = true; }
    addChild(child) { if (child.parent) child.parent.removeChild(child); this.children.push(child); child.parent = this; }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parent = null; }
    destroy() { this.destroyed = true; for (const child of this.children) child.destroy(); }
  }
  class Character { updateReflection() {} }
  class Map { constructor() { this._reflection = []; } isOnReflection() {} }
  class Ordinary extends Container { update() { this.ticks = (this.ticks || 0) + 1; } }
  class Reflection extends Ordinary {
    constructor() { super(); this._character = new Character(); }
    update() { super.update(); this.updateReflect(); }
    updateReflect() { this.visible = context.$gameMap._reflection.length > 0; }
    updatePosition() {}
  }
  class Spriteset extends Container {
    constructor() { super(); this._tilemap = new Container(); this.addChild(this._tilemap); }
    createCharacters() {
      this._characterSprites = [new Ordinary(), new Reflection()];
      this._characterSprites.forEach(sprite => this._tilemap.addChild(sprite));
      return 'created';
    }
    update() { this._tilemap.children.slice().forEach(sprite => sprite.update()); }
  }
  let enabled = true, refused = false;
  const known = new Set([Spriteset.prototype.createCharacters, Character.prototype.updateReflection,
    Map.prototype.isOnReflection, Reflection.prototype.update, Reflection.prototype.updateReflect,
    Reflection.prototype.updatePosition]);
  const context = { PIXI: {Container}, Spriteset_Map: Spriteset, Game_CharacterBase: Character,
    Game_Map: Map, $gameMap: new Map(), PMJS: {plugins: {registerOptimization() {}, onLoaded(plugin, id, fn) { fn(); }},
      phases: {on(phase, id, fn) { fn(); }}, methods: {wrap() {}, matchesSource: fn => recognized && known.has(fn)},
      optimizations: {isEnabled: () => enabled, refuse() { refused = true; }} } };
  runOptimizationAdapter(fs.readFileSync(require.resolve('../js/pmjs-plugins/yed/tiled.js'), 'utf8'), context);
  context.$gameMap._reflection = surfaces;
  const scene = new Spriteset();
  assert.equal(scene.createCharacters(), 'created');
  return {scene, context, disable() { enabled = false; }, refused: () => refused};
}
test('empty maps retain reflection ownership without updating duplicate sprites', () => {
  const h = fixture(), s = h.scene, members = s._characterSprites;
  s.update(); s.update();
  assert.equal(members[0].ticks, 2);
  assert.equal(members[1].ticks, undefined);
  assert.equal(s._characterSprites, members);
  assert.equal(members[1].parent.visible, false);
  s.destroy();
  assert.equal(members[1].destroyed, true);
});
test('live reflection changes restore the same sprites before their next update', () => {
  const h = fixture(), s = h.scene, mirror = s._characterSprites[1];
  h.context.$gameMap._reflection.push({}); s.update();
  assert.equal(mirror.parent, s._tilemap); assert.equal(mirror.ticks, 1); assert.equal(mirror.visible, true);
  h.context.$gameMap._reflection.length = 0; s.update();
  assert.equal(mirror.ticks, 1); assert.equal(mirror.parent.visible, false);
  h.disable(); s.update();
  assert.equal(mirror.parent, s._tilemap); assert.equal(mirror.ticks, 2); assert.equal(mirror.visible, false);
});
test('maps with reflection areas keep ordinary reflection updates from creation', () => {
  const h = fixture(true, [{}]), s = h.scene, mirror = s._characterSprites[1];
  assert.equal(mirror.parent, s._tilemap);
  s.update(); s.update();
  assert.equal(mirror.ticks, 2);
  assert.equal(mirror.visible, true);
});
test('active balloons and animations keep updating until their cleanup completes', () => {
  for (const property of ['_balloonSprite', '_animationSprites']) {
    const h = fixture(), s = h.scene, mirror = s._characterSprites[1];
    mirror[property] = property === '_animationSprites' ? [{}] : {};
    s.update();
    assert.equal(mirror.parent, s._tilemap); assert.equal(mirror.ticks, 1);
    mirror[property] = property === '_animationSprites' ? [] : null;
    s.update();
    assert.equal(mirror.parent.visible, false); assert.equal(mirror.ticks, 1);
  }
});
test('unknown methods, unknown reflection state and replacement maps retain updates', () => {
  for (const mutate of [
    h => { h.scene._characterSprites[1].update = function() { this.custom = true; }; },
    h => { h.context.$gameMap.isOnReflection = function() { return true; }; },
    h => { h.context.$gameMap._reflection = null; h.scene._characterSprites[1].updateReflect = function() {}; },
    h => { h.context.$gameMap = new h.context.Game_Map(); }
  ]) {
    const h = fixture(); mutate(h); h.scene.update();
    assert.equal(h.scene._characterSprites[1].parent, h.scene._tilemap);
  }
  const h = fixture(false); h.scene.update();
  assert.equal(h.refused(), true); assert.equal(h.scene._characterSprites[1].ticks, 1);
});
