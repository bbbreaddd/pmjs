'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture({ disabled = false, unknown = false, install = true } = {}) {
  const callbacks = [];
  const context = vm.createContext({ PMJS: {
    phases: { on(phase, key, callback) { callbacks.push(callback); } },
    methods: { matchesSource() { return !unknown; } },
    optimizations: { isEnabled() { return !disabled; } }
  } });
  vm.runInContext(`
    function Sprite() {}
    Sprite.prototype.synchronizeHorrorFiltersWithSource = function() {
      if (this._horrorFiltersSource) this.sourceUpdates = (this.sourceUpdates || 0) + 1;
    };
    Sprite.prototype.updateHorrorNoise = function() { this.noiseUpdates = (this.noiseUpdates || 0) + 1; };
    Sprite.prototype.updateHorrorGlitch = function() {};
    Sprite.prototype.updateHorrorTV = function() {};
    Sprite.prototype.updateHorrorEffects = function() {
      if (this._horrorFilters.noiseFilter) this.updateHorrorNoise();
    };
    var Olivia = { HorrorEffects: { ___Sprite_update___: function() {
      for (var child of this.children) if (child.update) child.update();
    } } };
    Sprite.prototype.update = function() {
      this.synchronizeHorrorFiltersWithSource();
      Olivia.HorrorEffects.___Sprite_update___.call(this);
      this.updateHorrorEffects();
    };
    function Sprite_Base() {
      this.children = []; this._hiding = true; this.visible = false; this.layerId = -1;
      this._animationSprites = []; this._horrorFilters = {}; this._horrorFiltersSource = null;
    }
    Sprite_Base.prototype = Object.create(Sprite.prototype);
    Sprite_Base.prototype.updateVisibility = function() { this.visible = !this._hiding; };
    Sprite_Base.prototype.updateAnimationSprites = function() {
      for (var item of this._animationSprites) item.ticks++;
    };
    Sprite_Base.prototype.update = function() {
      Sprite.prototype.update.call(this); this.updateVisibility(); this.updateAnimationSprites();
    };
    function Tilemap() {
      this.animationCount = 0; this.animationFrame = 0; this.touches = 0;
      this._priorityTiles = [new Sprite_Base(), new Sprite_Base()];
      this.children = this._priorityTiles.slice();
      this.bitmaps = [{ touch: () => this.touches++ }];
    }
    Tilemap.prototype.update = function() {
      this.animationCount++; this.animationFrame = Math.floor(this.animationCount / 30);
      var length = this.children.length;
      for (var i = 0; i < length; i++) if (this.children[i] && this.children[i].update) this.children[i].update();
      for (var j = 0; j < this.bitmaps.length; j++) if (this.bitmaps[j]) this.bitmaps[j].touch();
    };
  `, context);
  const original = context.Tilemap.prototype.update;
  vm.runInContext(fs.readFileSync(require.resolve('../js/pmjs-plugins/yed/priority-updates.js'), 'utf8'), context);
  if (install) callbacks[0]();
  return { context, map: new context.Tilemap(), original };
}

test('inactive priority sprites retain state, children and bitmap servicing', () => {
  const reference = fixture({ install: false }), candidate = fixture();
  const children = candidate.map.children.slice();
  for (let i = 0; i < 40; i++) { reference.map.update(); candidate.map.update(); }
  assert.equal(candidate.context.PMJS.yedPriorityUpdates.diagnostics().skipped, 80);
  assert.equal(candidate.map.animationCount, reference.map.animationCount);
  assert.equal(candidate.map.animationFrame, reference.map.animationFrame);
  assert.equal(candidate.map.touches, reference.map.touches);
  assert.deepEqual(candidate.map.children, children);
  assert.equal(candidate.map.children[0].visible, false);
});

test('priority reuse, animations, children, filter sources and active effects keep updates', () => {
  const { context, map } = fixture();
  const child = map.children[0];
  child.layerId = 1; child._hiding = false; map.update();
  assert.equal(child.visible, true);
  child.layerId = -1; child._hiding = true; map.update();
  assert.equal(child.visible, false);
  child._animationSprites.push({ ticks: 0 }); map.update();
  assert.equal(child._animationSprites[0].ticks, 1);
  child._animationSprites.length = 0;
  let updates = 0; child.children.push({ update() { updates++; } }); map.update();
  assert.equal(updates, 1); child.children.length = 0;
  child._horrorFiltersSource = {}; map.update(); assert.equal(child.sourceUpdates, 1);
  child._horrorFiltersSource = null; child._horrorFilters.noiseFilter = {}; map.update();
  assert.equal(child.noiseUpdates, 1);
  child._horrorFilters = {};
  const before = context.PMJS.yedPriorityUpdates.diagnostics().skipped; map.update();
  assert.equal(context.PMJS.yedPriorityUpdates.diagnostics().skipped, before + 2);
});

test('instance and later prototype overrides retain their callbacks', () => {
  const { context, map } = fixture();
  let count = 0;
  map.children[0].updateAnimationSprites = () => count++;
  map.update(); assert.equal(count, 1);
  context.Olivia.HorrorEffects.___Sprite_update___ = function() { count++; };
  map.update(); assert.equal(count, 4);
});

test('pool replacement and malformed entries preserve ordinary children', () => {
  const { context, map } = fixture();
  map._priorityTiles = [null, map.children[0]];
  let count = 0; map.children.push({ update() { count++; } });
  map.update(); assert.equal(count, 1);
  assert.equal(context.PMJS.yedPriorityUpdates.diagnostics().skipped, 1);
});

test('replacement effect namespace keeps the new delegated behavior', () => {
  const { context, map } = fixture();
  let updates = 0;
  context.Olivia.HorrorEffects = { ___Sprite_update___() { updates++; } };
  map.update();
  assert.equal(updates, 2);
  assert.equal(context.PMJS.yedPriorityUpdates.diagnostics().skipped, 0);
});

test('unknown compositions and disabled painting do not replace update', () => {
  for (const options of [{ disabled: true }, { unknown: true }]) {
    const { context, original } = fixture(options);
    assert.equal(context.Tilemap.prototype.update, original);
    assert.equal(context.PMJS.yedPriorityUpdates.diagnostics().installed, false);
  }
});
