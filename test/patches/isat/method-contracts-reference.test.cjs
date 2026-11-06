'use strict';

const { runOptimizationAdapter } = require('../../helpers/runtime-context.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const methodHash = require('./test-fixtures/method-hash.cjs')();
const game = process.env.PMJS_ISAT_REFERENCE_GAME;

function method(context, file, assignment) {
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf(assignment);
  assert.ok(start >= 0, assignment);
  const body = source.slice(source.indexOf('function', start));
  for (const match of body.matchAll(/};/g)) {
    const expression = '(' + body.slice(0, match.index + 1) + ')';
    let script;
    try { script = new vm.Script(expression); } catch { continue; }
    return script.runInContext(context);
  }
  assert.fail('missing function expression: ' + assignment);
}

function fixture(name) {
  const hooks = [], refused = [];
  const context = vm.createContext({
    PMJS: { isatSourceQualification: { verified: true }, isatMethodHash: methodHash,
      optimizations: { register() {}, isEnabled() { return true; }, refuse(...args) { refused.push(args); } },
      phases: { on(_phase, _id, callback) { hooks.push(callback); } } }
  });
  const guestMethod = (file, assignment) => method(context, path.join(game, file), assignment);
  function install() {
    runOptimizationAdapter(fs.readFileSync(require.resolve(`../../../patches/isat/${name}.js`), 'utf8'), context);
    hooks.forEach(hook => hook());
    assert.deepEqual(refused, []);
  }
  return { context, guestMethod, install };
}

test('plain-word admission accepts the purchased methods and the shared raster wrapper', { skip: !game }, () => {
  for (const shared of [false, true]) {
    const f = fixture('plain-word-measure'), c = f.context;
    c.Window_Base = function() {};
    const raw = f.guestMethod('js/plugins/YEP_MessageCore.js', 'Window_Base.prototype.textWidthExCheck =');
    c.Window_Base.prototype.textWidthExCheck = shared ? method(c,
      require.resolve('../../../js/pmjs-plugins/yanfly/message-core.js'), 'windowProto.textWidthExCheck =') : raw;
    c.VictorEngine = { ControlText: { textWidth: f.guestMethod('js/rpg_windows.js', 'Window_Base.prototype.textWidth =') } };
    c.SRD = { TranslationEngine: { translate: f.guestMethod('js/plugins/SRD_TranslationEngine.js', '$.translate =') } };
    const original = c.Window_Base.prototype.textWidthExCheck;
    f.install();
    assert.notEqual(c.Window_Base.prototype.textWidthExCheck, original);
  }
});

test('screen-effect admission accepts the effective weather wrapper and preserves update results', { skip: !game }, () => {
  const f = fixture('screen-effects'), c = f.context;
  c.Spriteset_Base = function() {};
  const proto = c.Spriteset_Base.prototype;
  for (const key of ['createScreenEffectFilters', 'updateScreenEffects']) {
    proto[key] = f.guestMethod('js/plugins/Aries001_AnimationScreenEffects.js', `Spriteset_Base.prototype.${key} =`);
  }
  proto.update = f.guestMethod('js/plugins/MOG_Weather_EX.js', 'Spriteset_Base.prototype.update =');
  const original = proto.update;
  f.install();
  assert.notEqual(proto.update, original);
  function Filter() { this.enabled = true; }
  c.PIXI = { filters: Object.fromEntries(['BlurFilter', 'ZoomBlurFilter', 'AdvancedBloomFilter',
    'ShockwaveFilter', 'GlitchFilter'].map(name => [name, Filter])) };
  c.Point = function(x, y) { this.x = x; this.y = y; };
  c.Graphics = { boxWidth: 816, boxHeight: 624 };
  c.ConfigManager = { screenEffectsEnabled: false };
  c.$gameMap = { _mapId: 30 }; c.$gameSystem = {};
  c._mog_weatherEX_sprtbase_update = function() {
    this.baseUpdates = (this.baseUpdates || 0) + 1;
    this._filters.forEach(filter => { filter.enabled = true; });
  };
  const scene = Object.create(proto);
  scene.updateWeatherEX_Base = function() { this.weatherUpdates = (this.weatherUpdates || 0) + 1; };
  assert.equal(scene.createScreenEffectFilters(), undefined);
  assert.ok(scene._filters.every(filter => !filter.enabled));
  assert.equal(scene.update(), undefined);
  assert.equal(scene.baseUpdates, 1); assert.equal(scene.weatherUpdates, 1);
  assert.equal(c.$gameSystem._weatherEX_MapId, 30);
  assert.ok(scene._filters.every(filter => !filter.enabled));
  scene.updateScreenEffects = function() {};
  scene.update();
  assert.ok(scene._filters.every(filter => filter.enabled), 'instance overrides retain the authored path');
  delete scene.updateScreenEffects;
  c.PMJS.isatSourceQualification = { verified: false };
  scene.update();
  assert.ok(scene._filters.every(filter => filter.enabled), 'revoked qualification retains the authored path');
});

test('save recovery accepts the purchased engine and preserves the MetaControls wrapper', { skip: !game }, () => {
  const f = fixture('save-recovery'), c = f.context;
  const original = f.guestMethod('js/rpg_managers.js', 'DataManager.saveGame =');
  const wrapper = f.guestMethod('js/plugins/Olivia_MetaControls.js', 'DataManager.saveGame =');
  const calls = [];
  c.Olivia = { MetaControls: { ___DataManager_saveGame___: original } };
  c.$gameVariables = {};
  c.StorageManager = { exists: () => true, backup: id => calls.push(['backup', id]) };
  c.DataManager = {
    saveGame: wrapper,
    saveGameMetaControls() { calls.push('meta-controls'); },
    saveGameWithoutRescue(id) { calls.push(['save', id]); return 'saved'; }
  };
  f.install();
  assert.notEqual(c.Olivia.MetaControls.___DataManager_saveGame___, original);
  assert.equal(c.DataManager.saveGame, wrapper);
  assert.equal(c.DataManager.saveGame(2), 'saved');
  assert.deepEqual(calls, ['meta-controls', ['backup', 2], ['save', 2]]);
});
