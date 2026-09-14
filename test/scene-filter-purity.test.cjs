'use strict';

// Render preparation must observe filter state, never advance it. Game and
// plugin updates own semantic mutation (Olivia updateHorrorNoise/Glitch/TV);
// nativeSceneFilter translates the current state into a render plan.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname,
  '../js/pmjs-pixi4/scene-filters.js'), 'utf8');

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
  const sandbox = {
    PIXI: { filters: { NoiseFilter, GlitchFilter } },
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
  vm.runInContext(source, sandbox, { filename: 'pmjs-pixi4/scene-filters.js' });
  return sandbox;
}

test('render preparation performs no semantic mutation', () => {
  assert.ok(source.indexOf('__pmjsPrepareSceneFilters') === -1,
    'render preparation must not invoke scene-filter preparation hooks');
  assert.ok(source.indexOf('updateHorror') === -1,
    'render preparation must not advance horror effects');
});

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
