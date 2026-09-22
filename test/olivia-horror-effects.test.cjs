'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runtimeRoot = path.resolve(__dirname, '..');
const optimizationsSource = fs.readFileSync(
  path.join(runtimeRoot, 'js/pmjs-core/optimizations.js'), 'utf8');
const source = fs.readFileSync(
  path.join(runtimeRoot, 'js/pmjs-plugins/olivia/horror-effects.js'), 'utf8');

function createKnownOliviaSprite() {
  function Sprite() {
    this._horrorFilters = {};
  }
  Sprite.prototype.synchronizeHorrorFiltersWithSource = function() {
    if (!!this._horrorFiltersSource && !!this._horrorFiltersSource._horrorFilters) {
      var source = this._horrorFiltersSource._horrorFilters;
      if (!!source.noiseFilter) {
        this._horrorFilters = this._horrorFilters || {};
        this._horrorFilters.noiseFilter = source.noiseFilter;
      }
      if (!!source.glitchFilter) {
        this._horrorFilters = this._horrorFilters || {};
        this._horrorFilters.glitchFilter = source.glitchFilter;
      }
      if (!!source.tvFilter) {
        this._horrorFilters = this._horrorFilters || {};
        this._horrorFilters.tvFilter = source.tvFilter;
      }
    }
  };
  Sprite.prototype.updateHorrorEffects = function() {
    this.updateHorrorNoise();
    this.updateHorrorGlitch();
    this.updateHorrorTV();
  };
  Sprite.prototype.updateHorrorNoise = function() {
    this.noiseCalls = (this.noiseCalls || 0) + 1;
    if (!!this._horrorFilters.noiseFilter) {
      if (this._horrorFilters.noiseFilter.animated) {
        this._horrorFilters.noiseFilter.seed = Math.random() * 3;
      }
    }
  };
  Sprite.prototype.updateHorrorGlitch = function() {
    this.glitchCalls = (this.glitchCalls || 0) + 1;
    if (!!this._horrorFilters.glitchFilter) {
      if (this._horrorFiltersGlitchSpecial &&
          this._horrorFilters.glitchFilter.animated) {
        this.updateHorrorGlitchEffect(this._horrorFilters.glitchFilter);
      }
      if (this._horrorFilters.glitchFilter.refreshRequest) {
        this._horrorFilters.glitchFilter.refreshRequest = false;
      }
    }
  };
  Sprite.prototype.updateHorrorTV = function() {
    this.tvCalls = (this.tvCalls || 0) + 1;
    if (!!this._horrorFilters.tvFilter) {
      if (this._horrorFilters.tvFilter.animated) {
        this._horrorFilters.tvFilter.time +=
          this._horrorFilters.tvFilter.aniSpeed;
      }
    }
  };
  return Sprite;
}

const registrySources = {
  lifecycle: 'js/pmjs-rpgmaker/lifecycle.js',
  methods: 'js/pmjs-core/methods.js',
  plugins: 'js/pmjs-rpgmaker/plugins.js',
};

function loadRegistrySupport(sandbox) {
  for (const [name, file] of Object.entries(registrySources)) {
    vm.runInContext(fs.readFileSync(path.join(runtimeRoot, file), 'utf8'),
      sandbox, { filename: file });
  }
}

function loadWithRegistrations(extra = {}) {
  const registrations = [];
  const sandbox = Object.assign({
    console,
    pmjsRegisterHook(hookName, callback) {
      registrations.push({ hookName, callback });
    }
  }, extra);
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-core/config.js'), 'utf8'), sandbox);
  vm.runInContext(optimizationsSource, sandbox, { filename: 'optimizations.js' });
  loadRegistrySupport(sandbox);
  vm.runInContext(source, sandbox, { filename: 'olivia-horror-effects.js' });
  return { sandbox, registrations };
}

test('registers plugins.olivia.horror-effects optimization', () => {
  const { sandbox } = loadWithRegistrations();
  assert.equal(sandbox.PMJS.optimizations.isEnabled('plugins.olivia.horror-effects'), true);
  assert.ok(sandbox.PMJS.optimizations.ids().includes('plugins.olivia.horror-effects'));
});

test('Olivia fast path skips inactive work and preserves active plugin updates for known Olivia implementation', () => {
  const Sprite = createKnownOliviaSprite();
  const { sandbox } = loadWithRegistrations({
    Sprite,
    Olivia: { HorrorEffects: {} }
  });
  sandbox.pmjsInstallOliviaHorrorEffects();

  const inactive = new Sprite();
  inactive.updateHorrorEffects();
  assert.equal(inactive.noiseCalls, undefined);
  assert.equal(inactive.glitchCalls, undefined);
  assert.equal(inactive.tvCalls, undefined);

  const filtered = new Sprite();
  filtered._horrorFilters = { noiseFilter: {} };
  filtered.updateHorrorEffects();
  assert.equal(filtered.noiseCalls, 1);
  assert.equal(filtered.glitchCalls, 1);
  assert.equal(filtered.tvCalls, 1);
});

test('Olivia integration leaves unknown outer wrappers on reference behavior', () => {
  const Sprite = createKnownOliviaSprite();
  let customStateUpdates = 0;
  let noiseUpdates = 0;

  Sprite.prototype.updateHorrorEffects = function composedWrapper() {
    customStateUpdates++;
    this.updateHorrorNoise();
  };
  Sprite.prototype.updateHorrorNoise = function() {
    noiseUpdates++;
  };

  const { sandbox } = loadWithRegistrations({
    Sprite,
    Olivia: { HorrorEffects: {} }
  });
  sandbox.pmjsInstallOliviaHorrorEffects();

  const sprite = new Sprite();
  sprite.updateHorrorEffects();
  assert.equal(customStateUpdates, 1);
  assert.equal(noiseUpdates, 1);

  sprite._horrorFilters = { noiseFilter: {} };
  sprite.updateHorrorEffects();
  assert.equal(customStateUpdates, 2);
  assert.equal(noiseUpdates, 2);
});

test('Olivia fast path is inert when the plugin is absent', () => {
  function Sprite() {}
  const update = function() {
    this.updateHorrorNoise();
    this.updateHorrorGlitch();
    this.updateHorrorTV();
  };
  Sprite.prototype.updateHorrorEffects = update;
  const { sandbox } = loadWithRegistrations({ Sprite });
  assert.equal(sandbox.Sprite.prototype.updateHorrorEffects, update);
});

test('Olivia adapter activates on its trigger plugin and ignores others', () => {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-core/config.js'), 'utf8'), sandbox);
  vm.runInContext(optimizationsSource, sandbox, { filename: 'optimizations.js' });
  loadRegistrySupport(sandbox);
  vm.runInContext(source, sandbox, { filename: 'olivia-horror-effects.js' });

  sandbox.Sprite = createKnownOliviaSprite();
  sandbox.Olivia = { HorrorEffects: {} };
  const before = sandbox.Sprite.prototype.updateHorrorEffects;

  sandbox.PMJS.plugins.execute('SomeOtherPlugin', function() {});
  assert.equal(sandbox.Sprite.prototype.updateHorrorEffects, before);

  sandbox.PMJS.plugins.execute('Olivia_HorrorEffects', function() {});
  assert.equal(sandbox.Sprite.prototype.updateHorrorEffects, before);
  sandbox.PMJS.phases.emit('afterGuestPlugins');
  assert.notEqual(sandbox.Sprite.prototype.updateHorrorEffects, before);
  assert.equal(sandbox.Sprite.prototype._pmjsOliviaInstalled, true);
});

test('Olivia optimization disabled via disableOptimizations leaves stock behavior', () => {
  const Sprite = createKnownOliviaSprite();
  const { sandbox } = loadWithRegistrations({
    Sprite,
    Olivia: { HorrorEffects: {} },
    PMJS_GAME_CONFIG: { disableOptimizations: ['plugins.olivia.horror-effects'] }
  });
  sandbox.pmjsInstallOliviaHorrorEffects();

  const inactive = new Sprite();
  inactive.updateHorrorEffects();
  assert.equal(inactive.noiseCalls, 1);
  assert.equal(inactive.glitchCalls, 1);
  assert.equal(inactive.tvCalls, 1);
});
