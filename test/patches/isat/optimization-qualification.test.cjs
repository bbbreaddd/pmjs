'use strict';

const { loadPmjsRuntime, runModule } = require('../../helpers/runtime-context.cjs');

const assert = require('node:assert/strict');
const test = require('node:test');
const methodHash = require('./test-fixtures/method-hash.cjs')();

for (const name of ['choice-width', 'static-events', 'blank-characters', 'loop-recovery',
  'plain-word-measure', 'screen-effects']) {
  test(`${name} requires successful source qualification before inspecting methods`, () => {
    for (const qualification of [undefined, { verified: false }]) {
      const context = loadPmjsRuntime({
        console: { log() {}, error() {} },
        Bitmap: function() {},
      });
      if (qualification !== undefined) context.PMJS.isatSourceQualification = qualification;
      context.PMJS.isatMethodHash = () => { throw Error('must qualify sources first'); };
      runModule(context, `patches/isat/${name}.js`);
      context.PMJS.phases.emit('beforeBoot');
      context.PMJS.phases.emit('afterGuestPlugins');
      context.PMJS.phases.emit('afterPlugins');
      context.PMJS.methods.install();
      context.PMJS.optimizations.finalize();
      const refused = context.PMJS.optimizations.dump()
        .filter(entry => entry.refusalReason)
        .map(entry => [entry.id, entry.refusalReason]);
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
  const originals = { ...Spriteset.prototype };
  const context = loadPmjsRuntime({
    console: { log() {}, error() {} },
    Spriteset_Base: Spriteset,
  });
  context.PMJS.isatSourceQualification = { verified: true };
  context.PMJS.isatMethodHash = methodHash;
  runModule(context, 'patches/isat/screen-effects.js');
  context.PMJS.phases.emit('beforeBoot');
  context.PMJS.phases.emit('afterGuestPlugins');
  context.PMJS.phases.emit('afterPlugins');
  context.PMJS.methods.install();
  context.PMJS.optimizations.finalize();
  const refused = context.PMJS.optimizations.dump().filter(entry => entry.refusalReason);
  assert.equal(refused.length, 1);
  assert.deepEqual({ ...Spriteset.prototype }, originals);
  const spriteset = new Spriteset();
  for (const method of Object.keys(originals)) spriteset[method]();
  assert.equal(calls, Object.keys(originals).length);
});
