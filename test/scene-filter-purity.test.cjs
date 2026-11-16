'use strict';

// Engine and plugin updates own filter state. Render preparation translates
// the current state into a render plan without advancing it.
const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');

const { runModule } = require('./helpers/runtime-context.cjs');

function createHarness() {
  class NoiseFilter {
    constructor() {
      this.noise = 0;
      this.seed = 0;
    }
  }
  class GlitchFilter {
    constructor() {
      this.slices = 0;
      this.offset = 0;
      this.seed = 0;
    }
  }
  class BlurFilter {
    constructor(blur) {
      this.blurX = blur || 0;
      this.blurY = blur || 0;
      this.quality = 4;
    }
    get blur() { return this.blurX; }
  }
  class ZoomBlurFilter {
    constructor() {
      this.strength = 0;
      this.center = { x: 0.5, y: 0.5 };
      this.innerRadius = 0;
      this.radius = -1;
    }
  }
  class AdvancedBloomFilter {
    constructor() {
      this.bloomScale = 0;
      this.brightness = 1;
      this.blur = 0;
      this.quality = 4;
      this.threshold = 1;
    }
  }
  const sandbox = {
    NativeHost: { render: {} },
    PIXI: { filters: { BlurFilter, ZoomBlurFilter, AdvancedBloomFilter,
      NoiseFilter, GlitchFilter } },
    nativeIdentityTransform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
    nativeFilterMatches(filter, ctor, name) {
      if (!filter) return false;
      if (typeof ctor === 'function' && filter instanceof ctor) return true;
      return !!(filter.constructor && filter.constructor.name === name);
    },
    nativeColorMatrixIsIdentity() { return false; },
    nativeCompatibilityHit() {}
  };
  sandbox.nativeMaskWorldTransform = function() {
    return sandbox.nativeIdentityTransform;
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  runModule(sandbox, 'js/pmjs-pixi4/scene-filters.js');
  return sandbox;
}

test('an active effect advances once per game update, never per render', () => {
  const sandbox = createHarness();
  const node = {};

  // Game update owns semantic mutation, mirroring Olivia's
  // updateHorrorNoise/updateHorrorGlitch/updateHorrorTV.
  const horror = {
    noise: new sandbox.PIXI.filters.NoiseFilter(),
    glitch: new sandbox.PIXI.filters.GlitchFilter(),
    tv: { time: 7, aniSpeed: 0.5, animated: true }
  };
  horror.noise.noise = 0.5;
  horror.noise.seed = 1;
  horror.glitch.slices = 5;
  horror.glitch.offset = 100;
  horror.glitch.seed = 2;

  let gameUpdates = 0;
  function gameUpdateHorrorEffects() {
    gameUpdates++;
    horror.noise.seed += 1;
    horror.glitch.seed += 1;
    horror.tv.time += horror.tv.aniSpeed;
  }

  gameUpdateHorrorEffects();
  assert.equal(gameUpdates, 1);

  const snapshot = JSON.parse(JSON.stringify({
    noise: { noise: horror.noise.noise, seed: horror.noise.seed },
    glitch: { slices: horror.glitch.slices, offset: horror.glitch.offset,
      seed: horror.glitch.seed },
    tv: { time: horror.tv.time }
  }));

  const firstRender = sandbox.nativeSceneFilter(node,
    [horror.noise, horror.glitch]);
  const secondRender = sandbox.nativeSceneFilter(node,
    [horror.noise, horror.glitch]);
  // The custom TV filter has no native translation; rendering it must still
  // leave its parameters untouched.
  sandbox.nativeSceneFilter(node, [horror.tv]);

  // Two renders without an intervening update produce identical plans.
  // Plans cross the vm boundary, so compare their JSON projection.
  const firstPlan = JSON.parse(JSON.stringify(firstRender));
  const secondPlan = JSON.parse(JSON.stringify(secondRender));
  assert.deepEqual(secondPlan, firstPlan);
  assert.ok(firstPlan.groups.length > 0);

  // And neither render advanced the effect parameters.
  assert.deepEqual({
    noise: { noise: horror.noise.noise, seed: horror.noise.seed },
    glitch: { slices: horror.glitch.slices, offset: horror.glitch.offset,
      seed: horror.glitch.seed },
    tv: { time: horror.tv.time }
  }, snapshot);
  assert.equal(gameUpdates, 1);
});

test('zero-strength screen-effect filters render as identity', () => {
  const sandbox = createHarness();
  const plan = JSON.parse(JSON.stringify(sandbox.nativeSceneFilter({}, [
    new sandbox.PIXI.filters.BlurFilter(),
    new sandbox.PIXI.filters.ZoomBlurFilter(),
    new sandbox.PIXI.filters.AdvancedBloomFilter()
  ])));
  assert.equal(plan.unsupported, false);
  assert.deepEqual(plan.groups, []);
});

test('an active screen-effect filter still renders', () => {
  const sandbox = createHarness();
  const blur = new sandbox.PIXI.filters.BlurFilter(8);
  const blurPlan = JSON.parse(JSON.stringify(
    sandbox.nativeSceneFilter({}, [blur])));
  assert.equal(blurPlan.groups.length, 1);
  assert.equal(blurPlan.groups[0].kind, 0);

  const zoom = new sandbox.PIXI.filters.ZoomBlurFilter();
  zoom.strength = 5;
  const zoomPlan = JSON.parse(JSON.stringify(
    sandbox.nativeSceneFilter({}, [zoom])));
  assert.equal(zoomPlan.groups.length, 1);
  assert.equal(zoomPlan.groups[0].kind, 4);

  const bloom = new sandbox.PIXI.filters.AdvancedBloomFilter();
  bloom.bloomScale = 1;
  const bloomPlan = JSON.parse(JSON.stringify(
    sandbox.nativeSceneFilter({}, [bloom])));
  assert.equal(bloomPlan.groups.length, 1);
  assert.equal(bloomPlan.groups[0].kind, 6);
});

test('inactive filters render as identity without touching parameters', () => {
  const sandbox = createHarness();
  const node = {};
  const noise = new sandbox.PIXI.filters.NoiseFilter();
  noise.noise = 0;
  noise.seed = 4;
  const glitch = new sandbox.PIXI.filters.GlitchFilter();
  glitch.slices = 0;
  glitch.seed = 9;

  const plan = JSON.parse(JSON.stringify(
    sandbox.nativeSceneFilter(node, [noise, glitch])));
  assert.deepEqual(plan.groups, []);
  assert.equal(noise.seed, 4);
  assert.equal(glitch.seed, 9);
});
