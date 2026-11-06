'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../js/pmjs-mv/neutral-tone.js'), 'utf8');

function fixture({ enabled = true, modified = false } = {}) {
  let phase;
  let registration;
  let refusal;
  const context = vm.createContext({
    __pmjsBuiltinRequire: require,
    PMJS: {
      optimizations: {
        register(value) { registration = value; },
        isEnabled() { return enabled; },
        refuse(_id, reason) { refusal = reason; },
      },
      phases: { on(_name, _id, callback) { phase = callback; } },
    },
  });
  vm.runInContext(`
    var Graphics = { isWebGL: function() { return true; } };
    var PIXI = { BLEND_MODES: { NORMAL: 0 } };
    function ToneFilter() {
      this.enabled = true; this.alpha = 1; this.blendMode = 0;
      this.vertexSrc = 'vertex'; this.fragmentSrc = 'matrix'; this.apply = null;
      this.resolution = 1; this.padding = 0; this.autoFit = true; this.reset();
    }
    ToneFilter.prototype.reset = function() {
      this.matrix = Array.from({length: 20}, function(_, n) {
        return n === 0 || n === 6 || n === 12 || n === 18 ? 1 : 0;
      });
    };
    ToneFilter.prototype.adjustTone = function(r, g, b) {
      this.matrix[4] = r / 255; this.matrix[9] = g / 255; this.matrix[14] = b / 255;
    };
    ToneFilter.prototype.adjustSaturation = function(value) { this.matrix[0] += value / 255; };
    var $gameScreen = { value: [0, 0, 0, 0], tone: function() { return this.value.slice(); } };
    function Spriteset_Base() {
      this._tone = [0, 0, 0, 0]; this._baseSprite = {};
      this.createWebGLToneChanger();
    }
    Spriteset_Base.prototype.createWebGLToneChanger = function() {
      this._toneFilter = new ToneFilter(); this._baseSprite.filters = [this._toneFilter];
    };
    Spriteset_Base.prototype.updateWebGLToneChanger = function() {
      this._toneFilter.reset(); this._toneFilter.adjustTone.apply(this._toneFilter, this._tone);
      this._toneFilter.adjustSaturation(-this._tone[3]);
    };
    Spriteset_Base.prototype.updateToneChanger = function() {
      var tone = $gameScreen.tone();
      if (this._tone.join(',') !== tone.join(',')) {
        this._tone = tone; this.updateWebGLToneChanger();
      }
      return 'original-result';
    };
  `, context);
  const proto = context.Spriteset_Base.prototype;
  const originals = [proto.createWebGLToneChanger, proto.updateToneChanger, proto.updateWebGLToneChanger];
  const fingerprints = ['92ec27688f58bff9c19fcc5f7183e6717d7a23712572a7bedfb3dd0e02d1e677',
    '706ae66cd6736f0200fd55e8d41136ea7f3f6c7ce07c6cd1f4c5e52f586f2f45',
    '385d2fd8f898fd005e3b7dd05d5e7383f98119e15e65bb25a5d807863ee7bdfc'];
  let adapted = source;
  originals.forEach((method, index) => {
    adapted = adapted.replace(fingerprints[index], crypto.createHash('sha256')
      .update(method.toString().replace(/\r\n/g, '\n')).digest('hex'));
  });
  if (modified) proto.updateToneChanger = function() {
    // $gameScreen.tone() this._tone this.updateWebGLToneChanger()
    this.authoredCalls = (this.authoredCalls || 0) + 1;
    return 'modified-result';
  };
  const original = proto.updateToneChanger;
  const optimizationHooks = { ...context.PMJS.optimizations };
  context.PMJS.config ||= {};
  require('./helpers/runtime-context.cjs').runModule(context, 'js/pmjs-core/optimizations.js');
  Object.assign(context.PMJS.optimizations, optimizationHooks);
  require('./helpers/runtime-context.cjs').runModule(context, 'js/pmjs-core/methods.js');
  vm.runInContext(adapted, context);
  assert.equal(registration.id, 'mv.neutral-tone-bypass');
  assert.equal(registration.owner, 'pmjs-mv');
  phase();
  return { context, original, refusal };
}

test('neutral-tone bypass preserves filter ownership and restores it for tint or matrix changes', () => {
  const { context, refusal } = fixture();
  assert.equal(refusal, undefined);

  const spriteset = new context.Spriteset_Base();
  const filter = spriteset._toneFilter;
  const filters = spriteset._baseSprite.filters;
  assert.equal(spriteset.updateToneChanger(), 'original-result');
  assert.equal(filter.enabled, false);
  assert.equal(spriteset._baseSprite.filters, filters);

  context.$gameScreen.value = [-68, -68, 0, 68];
  spriteset.updateToneChanger();
  assert.equal(filter.enabled, true);
  assert.equal(filter.matrix[4], -68 / 255);

  context.$gameScreen.value = [0, 0, 0, 0];
  spriteset.updateToneChanger();
  assert.equal(filter.enabled, false);

  filter.matrix[4] = 0.01;
  spriteset.updateToneChanger();
  assert.equal(filter.enabled, true);
});

test('disabled optimization and modified method lookalikes keep the original behavior', () => {
  for (const options of [{ enabled: false }, { modified: true }]) {
    const f = fixture(options), scene = new f.context.Spriteset_Base();
    assert.equal(scene.updateToneChanger, f.original);
    assert.equal(scene.updateToneChanger(), options.modified ? 'modified-result' : 'original-result');
    assert.equal(scene._toneFilter.enabled, true);
    if (options.modified) {
      assert.match(f.refusal, /unrecognized/);
      assert.equal(scene.authoredCalls, 1);
    }
  }
});

test('instance overrides and filter-class replacement restore previously suppressed filters', () => {
  for (const change of [
    f => { f.scene.createWebGLToneChanger = function() {}; },
    f => { f.scene.updateWebGLToneChanger = function() {}; },
    f => { f.context.ToneFilter = function() {}; }
  ]) {
    const f = fixture(); f.scene = new f.context.Spriteset_Base();
    f.scene.updateToneChanger();
    assert.equal(f.scene._toneFilter.enabled, false);
    change(f); f.scene.updateToneChanger();
    assert.equal(f.scene._toneFilter.enabled, true);
  }
});

test('non-neutral filter state and explicitly disabled filters retain their authored state', () => {
  for (const change of [scene => { scene._toneFilter.alpha = 0.5; },
    scene => { scene._toneFilter.padding = 20; },
    scene => { scene._toneFilter.enabled = false; },
    scene => { scene._baseSprite.filters = []; }]) {
    const f = fixture(), scene = new f.context.Spriteset_Base(); change(scene);
    const enabled = scene._toneFilter.enabled;
    scene.updateToneChanger(); assert.equal(scene._toneFilter.enabled, enabled);
  }
});

for (const reference of [process.env.PMJS_FELVIDEK_REFERENCE_GAME, process.env.PMJS_ISAT_REFERENCE_GAME]) {
test('the reviewed effective engine methods qualify without substituted fingerprints', { skip: !reference }, () => {
  const { context } = fixture({ enabled: false });
  const sprites = fs.readFileSync(path.join(reference, 'js/rpg_sprites.js'), 'utf8');
  const manifest = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(reference, 'js/plugins.js'), 'utf8'), manifest);
  const keys = ['createWebGLToneChanger', 'updateToneChanger', 'updateWebGLToneChanger'];
  for (const plugin of manifest.$plugins.filter(plugin => plugin.status)) {
    const text = fs.readFileSync(path.join(reference, 'js/plugins', plugin.name + '.js'), 'utf8');
    assert.ok(keys.every(key => !new RegExp('Spriteset_Base\\.prototype\\.' + key + '\\s*=').test(text)),
      'enabled plugin replaces the reviewed engine lifecycle: ' + plugin.name);
  }
  for (const key of keys) {
    const start = sprites.indexOf('Spriteset_Base.prototype.' + key + ' =');
    assert.ok(start >= 0);
    const body = sprites.slice(sprites.indexOf('function', start));
    let method;
    for (const match of body.matchAll(/};/g)) {
      let script;
      try { script = new vm.Script('(' + body.slice(0, match.index + 1) + ')'); } catch { continue; }
      method = script.runInContext(context); break;
    }
    assert.equal(typeof method, 'function'); context.Spriteset_Base.prototype[key] = method;
  }
  let install, refusal;
  context.PMJS.optimizations.isEnabled = () => true;
  context.PMJS.optimizations.refuse = (_id, reason) => { refusal = reason; };
  context.PMJS.phases.on = (_phase, _id, callback) => { install = callback; };
  const original = context.Spriteset_Base.prototype.updateToneChanger;
  vm.runInContext(source, context); install();
  assert.equal(refusal, undefined);
  assert.notEqual(context.Spriteset_Base.prototype.updateToneChanger, original);
});

}
