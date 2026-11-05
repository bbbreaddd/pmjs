'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const methodHash = require('./test-fixtures/method-hash.cjs')();

for (const name of ['choice-width', 'static-events', 'blank-characters', 'loop-recovery',
  'plain-word-measure', 'screen-effects']) {
  test(`${name} requires successful source qualification before inspecting methods`, () => {
    for (const qualification of [undefined, { verified: false }]) {
      const hooks = [], refused = [];
      const context = { Bitmap: function() {}, PMJS: {
        isatSourceQualification: qualification,
        isatMethodHash() { throw Error('must qualify sources first'); },
        optimizations: { register() {}, isEnabled() { return true; }, refuse(...args) { refused.push(args); } },
        phases: { on(_phase, _id, callback) { hooks.push(callback); } }
      } };
      vm.runInNewContext(fs.readFileSync(require.resolve(`../../../patches/isat/${name}.js`), 'utf8'), context);
      for (const hook of hooks) hook();
      assert.equal(refused.length, 1);
      assert.match(refused[0][1], /unqualified/);
    }
  });
}

test('screen-effects refuses method lookalikes and retains authored side effects', () => {
  function Spriteset() {}
  let calls = 0;
  Spriteset.prototype.createScreenEffectFilters = function() {
    this._ase_blur_filter = this._ase_zblur_filter = this._ase_glow_filter =
      this._ase_wave_filter = this._ase_dist_filter = {};
    calls++;
  };
  Spriteset.prototype.updateScreenEffects = Spriteset.prototype.createScreenEffectFilters;
  Spriteset.prototype.update = function() { calls++; };
  const originals = { ...Spriteset.prototype }, hooks = [], refused = [];
  vm.runInNewContext(fs.readFileSync(require.resolve('../../../patches/isat/screen-effects.js'), 'utf8'), {
    Spriteset_Base: Spriteset,
    PMJS: { isatSourceQualification: { verified: true }, isatMethodHash: methodHash,
      optimizations: { register() {}, isEnabled() { return true; }, refuse(...args) { refused.push(args); } },
      phases: { on(_phase, _id, callback) { hooks.push(callback); } } }
  });
  hooks.forEach(hook => hook());
  assert.equal(refused.length, 1);
  assert.deepEqual({ ...Spriteset.prototype }, originals);
  const spriteset = new Spriteset();
  for (const method of Object.keys(originals)) spriteset[method]();
  assert.equal(calls, Object.keys(originals).length);
});
