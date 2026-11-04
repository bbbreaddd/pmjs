'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../../../patches/omori/timing.js'), 'utf8');

function fixture({ enabled = true, qualified = true, resume = true, lateChange = false } = {}) {
  const hooks = new Map(), wrappers = [], refusals = [], fallbackCalls = [];
  let now = 0;
  function guestRepeat() { fallbackCalls.push({ receiver: this, args: [...arguments] }); return 7; }
  const manager = {
    determineRepeatNumber: guestRepeat,
    resume(value) { this.resumed = value; return value; },
  };
  if (!resume) delete manager.resume;
  const context = {
    SceneManager: manager, performance: { now: () => now },
    PMJS: {
      plugins: { registerOptimization(name, definition) {
        assert.equal(name, 'GTP_OmoriFixes');
        assert.equal(definition.id, 'omori.logic-timing');
      } },
      optimizations: { isEnabled: () => enabled, refuse(id, reason) { refusals.push(reason); } },
      phases: { on(name, id, callback) { hooks.set(name, callback); } },
      methods: {
        matchesSource(fn, accepted) {
          assert.equal(accepted.length, 1);
          return qualified && fn === guestRepeat;
        },
        wrap(definition) { wrappers.push(definition); }
      }
    }
  };
  vm.runInNewContext(source, context);
  hooks.get('afterGuestPlugins')();
  if (lateChange) manager.determineRepeatNumber = () => 9;
  for (const wrapper of wrappers) {
    const target = wrapper.getTarget();
    target[wrapper.method] = wrapper.wrap(target[wrapper.method]);
  }
  return { manager, guestRepeat, refusals, fallbackCalls,
    step(delta, elapsed = delta * 1000 / 60) {
      now += elapsed;
      return manager.determineRepeatNumber(delta);
    }
  };
}

test('fractional frame rates retain 60 logic updates per second', () => {
  for (const fps of [30, 35, 45, 50, 55, 60, 120]) {
    const f = fixture();
    let updates = 0;
    for (let frame = 0; frame < fps * 10; frame++) updates += f.step(60 / fps);
    assert.equal(updates, 600, `${fps} FPS`);
  }
});

test('ordinary catch-up retains debt and limits each callback to two updates', () => {
  const f = fixture();
  assert.equal(f.step(1.25), 1);
  assert.equal(f.step(3), 2);
  assert.equal(f.step(1), 2);
  assert.equal(f.step(0.75), 1);
  assert.equal(f.step(1), 1);
});

test('long wall-clock stalls discard debt even when Pixi clamps its delta', () => {
  const f = fixture();
  assert.equal(f.step(1.75), 1);
  assert.equal(f.step(6, 2000), 2);
  assert.equal(f.step(1), 1);
  assert.equal(f.step(1), 1);
});

test('sustained overload bounds retained debt and recovers at normal cadence', () => {
  const f = fixture();
  for (let frame = 0; frame < 30; frame++) assert.equal(f.step(6), 2);
  assert.equal(f.step(6), 2);
  const recovery = Array.from({ length: 16 }, () => f.step(1));
  assert.ok(recovery.every(steps => steps === 1 || steps === 2));
  assert.ok(recovery.reduce((total, steps) => total + steps, 0) - 16 < 15);
  assert.deepEqual(recovery.slice(-3), [1, 1, 1]);
});

test('resume resets fractional debt and preserves the guest receiver and result', () => {
  const f = fixture();
  assert.equal(f.step(0.75), 0);
  assert.equal(f.manager.resume('resume'), 'resume');
  assert.equal(f.manager.resumed, 'resume');
  assert.equal(f.step(0.5, 5000), 0);
  assert.equal(f.step(0.5), 1);
});

test('unsupported timing methods and disabled policy preserve guest behavior', () => {
  for (const options of [{ enabled: false }, { qualified: false }, { resume: false }]) {
    const f = fixture(options);
    assert.equal(f.manager.determineRepeatNumber, f.guestRepeat);
    assert.equal(f.step(1), 7);
    assert.equal(f.fallbackCalls[0].receiver, f.manager);
    assert.deepEqual(f.fallbackCalls[0].args, [1]);
  }
  const f = fixture({ lateChange: true });
  assert.equal(f.step(1), 9);
  assert.equal(f.refusals.length, 1);
});

test('invalid ticker input delegates to the guest and clears old debt', () => {
  const f = fixture();
  assert.equal(f.step(0.75), 0);
  assert.equal(f.step(NaN, 0), 7);
  assert.equal(f.step(0.5), 0);
  assert.equal(f.step(-1, 0), 7);
  assert.equal(f.step(0.5), 0);
});
