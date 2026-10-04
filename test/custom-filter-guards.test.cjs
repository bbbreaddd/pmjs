'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { makeHarness } = require('./helpers/scene-encoder-harness.cjs');

function fixture() {
  const { sandbox, compatHits } = makeHarness();
  class Filter {
    constructor() {
      this.fragmentSrc = 'fragment';
      this.vertexSrc = 'vertex';
      this.uniforms = { amount: 0.25, tint: [1, 0.5, 0.25] };
    }
    apply(manager, input, output, clear) { manager.applyFilter(this, input, output, clear); }
  }
  sandbox.PIXI.Filter = Filter;
  class ColorMatrixFilter extends Filter {
    constructor() {
      super();
      this.fragmentSrc = 'identity fragment';
      this.matrix = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
    }
  }
  sandbox.PIXI.filters.ColorMatrixFilter = ColorMatrixFilter;
  class NoiseFilter extends Filter {}
  sandbox.PIXI.filters.NoiseFilter = NoiseFilter;
  sandbox.Graphics = { width: 32, height: 32 };
  let compilations = 0;
  const plans = [];
  sandbox.NativeHost.render.createFilterProgram = () => {
    compilations++;
    return { handle: 7, uniforms: [{ name: 'amount', size: 1 }, { name: 'tint', size: 3 }] };
  };
  sandbox.NativeHost.render.createFilterPlan = plan => {
    plans.push(JSON.parse(JSON.stringify(plan)));
    return { handle: 100 + plans.length };
  };
  const file = path.join(__dirname, '../js/pmjs-pixi4/scene-filters.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  const node = { getBounds: () => ({ x: 4, y: 4, width: 16, height: 16 }) };
  return { sandbox, Filter, NoiseFilter, node, plans, compatHits, compilations: () => compilations };
}

test('custom filter passes snapshot mutations and reuse the vertex/fragment program', () => {
  const { sandbox, Filter, node, plans, compilations } = fixture();
  const filter = new Filter();
  assert.equal(sandbox.nativeSceneFilter(node, [filter]).unsupported, false);
  filter.uniforms.amount = 0.75;
  filter.uniforms.tint[0] = 0;
  assert.equal(sandbox.nativeSceneFilter(node, [filter]).unsupported, false);
  assert.deepEqual(plans[0].passes[0].uniforms, [0.25, 1, 0.5, 0.25]);
  assert.deepEqual(plans[1].passes[0].uniforms, [0.75, 0, 0.5, 0.25]);
  assert.equal(compilations(), 1);
  filter.vertexSrc = 'another vertex';
  sandbox.nativeSceneFilter(node, [filter]);
  assert.equal(compilations(), 1, 'warm shader source mutation bypassed the Pixi cache');
  filter.glShaders = {};
  filter.glShaderKey = 0;
  sandbox.nativeSceneFilter(node, [filter]);
  assert.equal(compilations(), 2);
});

test('custom apply hooks preserve pass order, target reuse and clear/blend state', () => {
  const { sandbox, Filter, node, plans, compatHits } = fixture();
  const filter = new Filter();
  filter.apply = function(manager, input, output, clear) {
    const temporary = manager.getRenderTarget(true);
    this.uniforms.amount = 0.25;
    manager.applyFilter(this, input, temporary, true);
    this.uniforms.amount = 0.75;
    this.blendMode = 1;
    manager.applyFilter(this, temporary, output, clear);
    manager.returnRenderTarget(temporary);
    assert.equal(manager.getRenderTarget(true), temporary);
  };
  assert.equal(sandbox.nativeSceneFilter(node, [filter]).unsupported, false);
  assert.deepEqual(plans[0].passes.map(pass => [pass.input, pass.output, pass.clear, pass.blend]),
    [[0, 2, true, 0], [2, 1, false, 1]]);
  assert.equal(plans[0].passes[0].uniforms[0], 0.25);
  assert.equal(plans[0].passes[1].uniforms[0], 0.75);
  assert.deepEqual(compatHits, []);
});

test('invalid uniforms and feedback targets are observable and never publish a filter plan', () => {
  const { sandbox, Filter, node, plans, compatHits } = fixture();
  const filter = new Filter();
  filter.uniforms.amount = NaN;
  assert.equal(sandbox.nativeSceneFilter(node, [filter]).unsupported, true);
  assert.equal(plans.length, 0);
  filter.uniforms.amount = 0.25;
  filter.apply = function(manager, input) { manager.applyFilter(this, input, input, false); };
  assert.equal(sandbox.nativeSceneFilter(node, [filter]).unsupported, true);
  assert.equal(plans.length, 0);
  assert.ok(compatHits.every(hit => hit[0] === 'render.filter-program'),
    JSON.stringify(compatHits));
});


test('changed shaders and subclasses run before a native identity-filter shortcut', () => {
  const { sandbox, node, plans } = fixture();
  const Core = sandbox.PIXI.filters.ColorMatrixFilter;
  assert.equal(sandbox.nativeSceneFilter(node, [new Core()]).groups.length, 0);
  const replacement = new Core();
  replacement.fragmentSrc = 'replacement fragment';
  assert.equal(sandbox.nativeSceneFilter(node, [replacement]).groups[0].kind, 31);
  class Subclass extends Core {}
  assert.equal(sandbox.nativeSceneFilter(node, [new Subclass()]).groups[0].kind, 31);
  Core.prototype.apply = function(manager, input, output, clear) {
    this.uniforms.amount = 0.5;
    manager.applyFilter(this, input, output, clear);
  };
  assert.equal(sandbox.nativeSceneFilter(node, [new Core()]).groups[0].kind, 31);
  assert.equal(plans[2].passes[0].uniforms[0], 0.5);
});

test('authored filters update stale world bounds unless the caller supplied Pixi world state', () => {
  const { sandbox, Filter, node, plans } = fixture();
  const calls = [];
  node.getBounds = skipUpdate => {
    calls.push(skipUpdate);
    return { x: skipUpdate ? 4 : 12, y: 14, width: 16, height: 16 };
  };
  sandbox.nativeSceneUsePixiWorldState = false;
  sandbox.nativeSceneFilter(node, [new Filter()]);
  assert.deepEqual(plans[0].frame, [8, 10, 24, 24]);
  sandbox.nativeSceneUsePixiWorldState = true;
  sandbox.nativeSceneFilter(node, [new Filter()]);
  assert.deepEqual(calls, [false, true]);
});

test('authored apply hooks receive the active renderer and its queried GL limits', () => {
  const { sandbox, Filter, node, compatHits } = fixture();
  const renderer = { gl: { MAX_VARYING_VECTORS: 36348,
    getParameter(parameter) { assert.equal(parameter, 36348); return 32; } } };
  sandbox.Graphics._renderer = renderer;
  const filter = new Filter();
  filter.apply = function(manager, input, output, clear) {
    assert.equal(manager.renderer, renderer);
    assert.equal(manager.renderer.gl.getParameter(manager.renderer.gl.MAX_VARYING_VECTORS), 32);
    manager.applyFilter(this, input, output, clear);
  };
  assert.equal(sandbox.nativeSceneFilter(node, [filter]).unsupported, false);
  assert.deepEqual(compatHits, []);
});


test('a source-backed noise filter uses its authored program instead of a different random hash', () => {
  const { sandbox, NoiseFilter, node, plans } = fixture();
  const result = sandbox.nativeSceneFilter(node, [new NoiseFilter()]);
  assert.equal(result.unsupported, false);
  assert.equal(result.groups[0].kind, 31);
  assert.equal(plans.length, 1);
});

test('fullscreen filter frames preserve the supported Pixi version padding contract', () => {
  for (const version of ['4.5.4', '4.6.2', '4.7.0', '4.8.0', '4.8.9']) {
    const { sandbox, Filter, node, plans } = fixture();
    sandbox.PIXI.VERSION = version;
    node.filterArea = { x: 0, y: 0, width: 32, height: 32 };
    sandbox.nativeSceneFilter(node, [new Filter()]);
    assert.deepEqual(plans[0].frame, version.startsWith('4.8.') ? [0, 0, 32, 32] : [-4, -4, 40, 40]);
  }
});
