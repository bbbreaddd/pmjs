'use strict';

const { loadPmjsRuntime, runModule } = require('../../helpers/runtime-context.cjs');

const assert = require('node:assert/strict');
const test = require('node:test');

function fixture({ enabled = true, qualified = true, resume = true, lateChange = false } = {}) {
  const fallbackCalls = [];
  let now = 0;
  function guestRepeat() { fallbackCalls.push({ receiver: this, args: [...arguments] }); return 7; }
  const manager = {
    determineRepeatNumber: guestRepeat,
    resume(value) { this.resumed = value; return value; },
  };
  if (!resume) delete manager.resume;
  const context = loadPmjsRuntime({
    console: { log() {}, error() {} },
    PMJS_GAME_CONFIG: enabled ? {} : { disableOptimizations: ['omori.logic-timing'] },
    SceneManager: manager, performance: { now: () => now },
  });
  context.PMJS.methods.matchesSource = (fn, accepted) => {
    assert.equal(accepted.length, 1);
    return qualified && fn === guestRepeat;
  };
  runModule(context, 'patches/omori/timing.js');
  context.PMJS.plugins.snapshotEffectiveManifest([{ name: 'GTP_OmoriFixes', status: true }]);
  context.PMJS.plugins.execute('GTP_OmoriFixes', () => {});
  context.PMJS.plugins.finish();
  context.PMJS.phases.emit('afterGuestPlugins');
  if (lateChange) manager.determineRepeatNumber = () => 9;
  context.PMJS.methods.install();
  context.PMJS.optimizations.finalize();
  const refusals = context.PMJS.optimizations.dump()
    .filter(entry => entry.refusalReason)
    .map(entry => entry.refusalReason);
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
