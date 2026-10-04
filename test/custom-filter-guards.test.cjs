'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { makeHarness } = require('./helpers/scene-encoder-harness.cjs');

function fixture() {
  const { sandbox } = makeHarness();
  class Filter {
    constructor() {
      this.fragmentSrc = 'fragment';
      this.vertexSrc = Filter.defaultVertexSrc;
      this.uniforms = { amount: 0.25, tint: [1, 0.5, 0.25] };
    }
    apply() {}
  }
  Filter.defaultVertexSrc = 'stock vertex';
  sandbox.PIXI.Filter = Filter;
  let compilations = 0;
  sandbox.NativeHost.render.createFilterProgram = () => {
    compilations++;
    return { handle: 7, uniforms: [{ name: 'amount', size: 1 },
      { name: 'tint', size: 3 }] };
  };
  const file = path.join(__dirname, '../js/pmjs-pixi4/scene-filters.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return { sandbox, Filter, compilations: () => compilations };
}

test('custom filter uniforms are snapshotted while the compiled program is reused', () => {
  const { sandbox, Filter, compilations } = fixture();
  const filter = new Filter();
  const first = sandbox.nativeSceneFilter({}, [filter]);
  filter.uniforms.amount = 0.75;
  filter.uniforms.tint[0] = 0;
  const second = sandbox.nativeSceneFilter({}, [filter]);
  assert.equal(first.unsupported, false);
  assert.equal(second.unsupported, false);
  assert.deepEqual(Array.from(first.groups[0].parameters), [4, 0.25, 1, 0.5, 0.25]);
  assert.deepEqual(Array.from(second.groups[0].parameters), [4, 0.75, 0, 0.5, 0.25]);
  assert.equal(first.groups[0].resource, second.groups[0].resource);
  assert.equal(compilations(), 1);
});

test('custom filter hooks and targets outside the native contract remain unsupported', () => {
  const { sandbox, Filter, compilations } = fixture();
  for (const changes of [{ vertexSrc: 'custom vertex' }, { apply() {} },
    { resolution: 0.5 }, { autoFit: false }, { blendMode: 1 }]) {
    const filter = Object.assign(new Filter(), changes);
    assert.equal(sandbox.nativeSceneFilter({}, [filter]).unsupported, true);
  }
  assert.equal(sandbox.nativeSceneFilter({ filterArea: {} }, [new Filter()]).unsupported, true);
  Filter.prototype.apply = function replacedApply() {};
  assert.equal(sandbox.nativeSceneFilter({}, [new Filter()]).unsupported, true);
  assert.equal(compilations(), 0);
});
