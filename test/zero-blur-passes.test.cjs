'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { makeHarness } = require('./helpers/scene-encoder-harness.cjs');

function fixture() {
  const { sandbox } = makeHarness();
  const passes = [
    { program: 1, input: 0, output: 3, clear: true },
    { program: 1, input: 3, output: 0, clear: true },
    { program: 1, input: 0, output: 3, clear: true },
    { program: 1, input: 3, output: 2, clear: true },
    { program: 2, input: 2, output: 3, clear: true },
    { program: 2, input: 3, output: 2, clear: true },
    { program: 2, input: 2, output: 3, clear: true },
    { program: 2, input: 3, output: 1, clear: false },
  ].map(pass => ({ ...pass, blend: 0, uniforms: [0], samplers: [] }));
  const plan = { frame: [0, 0, 64, 64], resolutions: [1, 1, 1, 1], passes };
  const copies = new Set(passes);
  return { sandbox, plan, copies, collapse: () => sandbox.nativeCollapseZeroBlurPasses(plan, copies, 64, 64) };
}

test('zero blur reduces redundant work without losing the final output', () => {
  const { plan, collapse } = fixture();
  collapse();
  assert.ok(plan.passes.length <= 2);
  assert.ok(plan.resolutions.length <= 3);
  const last = plan.passes.at(-1);
  assert.equal(last.output, 1);
  assert.equal(last.clear, false);
  for (const pass of plan.passes) {
    assert.ok(pass.input < plan.resolutions.length);
    assert.ok(pass.output < plan.resolutions.length);
  }
});

for (const read of ['input', 'sampler', 'blend']) test(`later ${read} retains a live scratch write`, () => {
  const { plan, collapse } = fixture();
  const writer = plan.passes[6];
  plan.resolutions.push(1);
  plan.passes.push({ program: 3, input: read === 'input' ? 3 : 1,
    output: read === 'blend' ? 3 : 4, clear: read !== 'blend',
    samplers: read === 'sampler' ? [{ image: 0, target: 3 }] : [] });
  collapse();
  assert.ok(plan.passes.includes(writer));
  assert.equal(plan.resolutions.length, read === 'blend' ? 4 : 5);
});

test('non-unit sampling, translated frames and root projections retain original passes', () => {
  for (const reason of ['resolution', 'frame', 'viewport', 'projection', 'unqualified']) {
    const { sandbox, plan, copies, collapse } = fixture();
    if (reason === 'resolution') plan.resolutions.fill(0.75);
    if (reason === 'frame') plan.frame[0] = 7;
    if (reason === 'viewport') plan.frame[2] = 23;
    if (reason === 'projection') sandbox.nativeSceneRootTransform = { a: 0.5, b: 0, c: 0, d: 0.5, tx: 0, ty: 0 };
    if (reason === 'unqualified') copies.clear();
    collapse();
    assert.equal(plan.passes.length, 8, reason);
    assert.equal(plan.resolutions.length, 4, reason);
  }
});
