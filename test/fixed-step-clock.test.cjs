'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FixedStepClock } = require('../runner/fixed-step-clock.cjs');

test('logical rate stays at sixty across supported presentation rates', () => {
  for (const hz of [30,60,120]) {
    const clock = new FixedStepClock(0); let total = 0;
    for (let frame = 0; frame < hz * 10; ++frame) total += clock.takeSteps(frame * 1000 / hz);
    assert.equal(total, hz === 30 ? 599 : 600);
  }
});
test('a presentation hitch advances bounded logical work without slowing the clock', () => {
  const clock = new FixedStepClock(0);
  assert.equal(clock.takeSteps(0),1);
  assert.equal(clock.takeSteps(100),6);
  assert.equal(clock.takeSteps(1100),15);
});
