'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function loadTiming(extra) {
  const code = fs.readFileSync(path.join(__dirname, '../js/pmjs-mv/timing.js'), 'utf8');
  const context = {
    console, performance, Math, Number, __pmjsBuiltinRequire: require,
    globalThis: null, SceneManager: undefined,
    Utils: { isMobileSafari() { return false; } },
  };
  context.globalThis = context;
  if (extra) extra(context);
  vm.createContext(context);
  if (context.SceneManager && context.SceneManager.updateMain &&
      context.SceneManager.updateMain.toString() === stockUpdateMainSource) {
    context.SceneManager.updateMain = vm.runInContext('(' + stockUpdateMainSource + ')', context);
  }
  vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../js/pmjs-core/config.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../js/pmjs-core/optimizations.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-core/methods.js'), 'utf8'), context);
  vm.runInContext(code, context);
  return context;
}

const stockUpdateMainSource = `function() {
    if (Utils.isMobileSafari()) {
        this.changeScene();
        this.updateScene();
    } else {
        var newTime = this._getTimeInMsWithoutMobileSafari();
        var fTime = (newTime - this._currentTime) / 1000;
        if (fTime > 0.25) fTime = 0.25;
        this._currentTime = newTime;
        this._accumulator += fTime;
        while (this._accumulator >= this._deltaTime) {
            this.updateInputData();
            this.changeScene();
            this.updateScene();
            this._accumulator -= this._deltaTime;
        }
    }
    this.renderScene();
    this.requestUpdate();
}`;

function stockShapedScene() {
  return {
    _deltaTime: 1 / 60,
    _currentTime: 0,
    _accumulator: 0,
    _getTimeInMsWithoutMobileSafari() { return this._now; },
    _now: 0,
    logicSteps: 0,
    renders: 0,
    updateInputData() {},
    changeScene() {},
    updateScene() { this.logicSteps++; },
    renderScene() { this.renders++; },
    requestUpdate() {},
    resume() {
      this._stopped = false;
      this.requestUpdate();
      this._currentTime = this._getTimeInMsWithoutMobileSafari();
      this._accumulator = 0;
    },
    updateMain: vm.runInNewContext('(' + stockUpdateMainSource + ')', {
      Utils: { isMobileSafari() { return false; } }
    }),
  };
}

test('missing timing prerequisites warn with reasons and remain eligible for later installation', () => {
  const warnings = [];
  const context = loadTiming(ctx => {
    ctx.console = { ...console, warn(message) { warnings.push(message); } };
  });
  assert.equal(context.pmjsMvInstallTimingContract(), false);
  assert.equal(context.pmjsMvInstallTimingContract(), false);
  context.SceneManager = {};
  assert.equal(context.pmjsMvInstallTimingContract(), false);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /mv.logic-timing-contract refused for this use: SceneManager unavailable/);
  assert.match(warnings[1], /SceneManager.updateMain unavailable/);
  context.SceneManager = stockShapedScene();
  assert.equal(context.pmjsMvInstallTimingContract(), true);
  assert.equal(context.PMJS.optimizations.isEnabled('mv.logic-timing-contract'), true);
});

function startTiming(options, configure) {
  const ctx = loadTiming(context => {
    context.SceneManager = stockShapedScene();
    context.performance = { now: () => context.SceneManager._now };
    if (configure) configure(context);
  });
  assert.equal(ctx.pmjsMvInstallTimingContract(options), true);
  return {
    ctx,
    step(now) {
      const scene = ctx.SceneManager;
      scene._now = now;
      const before = scene.logicSteps;
      scene.updateMain();
      return scene.logicSteps - before;
    }
  };
}

test('first scene update synchronizes the clock and presents without advancing logic', () => {
  const { ctx, step } = startTiming();
  assert.equal(step(1000), 0);
  assert.equal(ctx.SceneManager.renders, 1);
  assert.equal(ctx.SceneManager._currentTime, 1000);
  assert.equal(ctx.__pmjsOverloadDiscontinuities, undefined);
});

for (const [renderHz, expected] of [
  [30, [2, 2, 2, 2]], [60, [1, 1, 1, 1]], [120, [0, 1, 0, 1]]
]) {
  test(renderHz + ' Hz presentation preserves authored 60 Hz scene updates', () => {
    const { ctx, step } = startTiming({ renderHz });
    assert.equal(step(0), 0);
    const steps = expected.map((_, index) => step((index + 1) * 1000 / renderHz));
    assert.deepEqual(steps, expected);
    assert.equal(ctx.SceneManager.renders, expected.length + 1);
    assert.equal(ctx.SceneManager._deltaTime, 1 / 60);
    assert.equal(ctx.__pmjsOverloadDiscontinuities, undefined);
  });
}

test('changing the runtime frame limit preserves the authored update rate', () => {
  const { ctx, step } = startTiming(undefined, context => {
    context.__pmjsTimingConfig = { renderHz: 120 };
  });
  step(0);
  assert.equal(step(1000 / 120), 0);
  assert.equal(step(1000 / 60), 1);
  ctx.__pmjsTimingConfig.renderHz = 30;
  assert.equal(step(50), 2);
  assert.equal(step(250 / 3), 2);
});

test('ordinary fractional debt survives into subsequent scene updates', () => {
  const { ctx, step } = startTiming();
  step(0);
  assert.equal(step(20), 1);
  assert.equal(step(35), 1);
  assert.equal(step(50), 1);
  assert.equal(ctx.__pmjsOverloadDiscontinuities, undefined);
});

for (const catchupMode of ['smooth', 'burst']) {
  test(catchupMode + ' catch-up bounds repeated overload and then resumes normal cadence', () => {
    const logs = [];
    const { ctx, step } = startTiming({ catchupMode }, context => {
      context.console = { log(message) { logs.push(String(message)); } };
    });
    step(0);
    for (const now of [300, 600, 900]) assert.equal(step(now), 2);
    assert.equal(ctx.SceneManager.logicSteps, 6);
    assert.equal(ctx.__pmjsOverloadDiscontinuities, 3);
    assert.equal(logs.filter(line => line.includes('overload-debt-clamp')).length, 3);
    assert.equal(step(900 + 1000 / 60), 1);
  });

  test(catchupMode + ' catch-up remains bounded during sustained 40 ms arrivals', () => {
    const { step } = startTiming({ catchupMode });
    step(0);
    for (let frame = 1; frame <= 10; frame++) assert.equal(step(frame * 40), 2);
  });
}

test('a backward clock change resynchronizes without scene updates or an overload', () => {
  const { ctx, step } = startTiming();
  step(1000);
  assert.equal(step(500), 0);
  assert.equal(ctx.__pmjsOverloadDiscontinuities, undefined);
  assert.equal(step(500 + 1000 / 60), 1);
});

test('smooth catch-up preserves ordinary 45 ms elapsed time and its fractional remainder', () => {
  const { ctx, step } = startTiming({ renderHz: 60, catchupMode: 'smooth' });
  step(0);
  assert.equal(step(16.67), 1);
  assert.equal(step(61.67), 2);
  assert.equal(step(78.34), 1);
  assert.equal(step(83.34), 1);
  assert.equal(ctx.__pmjsOverloadDiscontinuities, undefined);
});

test('smooth catch-up discards excess whole steps while retaining fractional debt', () => {
  const logs = [];
  const { ctx, step } = startTiming({ renderHz: 60, catchupMode: 'smooth' }, context => {
    context.console = { log(message) { logs.push(String(message)); } };
  });
  step(0);
  assert.equal(step(105), 2);
  assert.equal(step(115), 0);
  assert.equal(step(120), 1);
  assert.equal(step(120), 0);
  assert.equal(ctx.__pmjsOverloadDiscontinuities, 1);
  assert.deepEqual(logs, ['[pmjs] overload-debt-clamp dropped_ms=66.7']);
});

test('30 Hz burst catch-up pays retained debt before returning to normal cadence', () => {
  const { step } = startTiming({ renderHz: 30, catchupMode: 'burst' });
  step(0);
  assert.equal(step(1000 / 30), 2);
  assert.equal(step(100), 3);
  assert.equal(step(4000 / 30), 3);
  assert.equal(step(5000 / 30), 2);
});

test('jittered arrivals preserve elapsed simulation time', () => {
  const { ctx, step } = startTiming({ renderHz: 60, catchupMode: 'smooth' });
  const jitters = [-0.7, 0.8, -0.9, 0.5, -0.4, 0.9, -0.8, 0.2, -0.6, 0.7,
    -0.5, 0.6, -0.7, 0.4, -0.3, 0.8, -0.6, 0.3, -0.5, 0.7,
    -0.8, 0.5, -0.4, 0.6, -0.7, 0.3, -0.5, 0.6, -0.4, 0.5];
  step(0);
  jitters.forEach((jitter, index) => step((index + 1) * 1000 / 60 + jitter));
  assert.equal(ctx.SceneManager.logicSteps, 30);
  assert.equal(ctx.__pmjsOverloadDiscontinuities, undefined);
});

test('sustained 30 Hz arrivals preserve fixed-60 simulation without discarding ordinary debt', () => {
  const { ctx, step } = startTiming({ renderHz: 60, catchupMode: 'smooth' });
  step(0);
  for (let frame = 1; frame <= 300; frame++) step(frame * 1000 / 30);
  assert.equal(ctx.SceneManager.logicSteps, 600);
  assert.equal(ctx.__pmjsOverloadDiscontinuities, undefined);
});

test('59.94 Hz arrivals preserve the authored step rate', () => {
  const { step } = startTiming({ renderHz: 60, catchupMode: 'smooth' });
  step(0);
  for (let frame = 1; frame <= 120; frame++) assert.equal(step(frame * 1000 / 59.94), 1);
});

test('resume clears the clock and retained debt after a pause', () => {
  const { ctx, step } = startTiming();
  step(0);
  assert.equal(step(20), 1);
  ctx.SceneManager._now = 220;
  ctx.SceneManager.resume();
  assert.equal(step(220), 0);
  assert.equal(step(235), 0);
  assert.equal(step(240), 1);
});

test('install is idempotent and can wrap a later stock-shaped guest replacement', () => {
  const { ctx, step } = startTiming();
  const wrapped = ctx.SceneManager.updateMain;
  const resume = ctx.SceneManager.resume;
  assert.equal(ctx.pmjsMvInstallTimingContract(), true);
  assert.equal(ctx.SceneManager.updateMain, wrapped);
  ctx.SceneManager.updateMain = stockShapedScene().updateMain;
  assert.equal(ctx.pmjsMvInstallTimingContract(), true);
  assert.notEqual(ctx.SceneManager.updateMain, wrapped);
  assert.equal(ctx.SceneManager.resume, resume);
  step(0);
  assert.equal(step(1000 / 30), 2);
  ctx.SceneManager._now = 220;
  ctx.SceneManager.resume();
  assert.equal(step(220), 0);
  assert.equal(step(240), 1);
});

test('disabled optimization leaves authored scene updates and resume unchanged', () => {
  const ctx = loadTiming(context => {
    context.PMJS_GAME_CONFIG = { disableOptimizations: ['mv.logic-timing-contract'] };
    context.SceneManager = stockShapedScene();
  });
  const { updateMain, resume } = ctx.SceneManager;
  assert.equal(ctx.pmjsMvInstallTimingContract(), false);
  assert.equal(ctx.SceneManager.updateMain, updateMain);
  assert.equal(ctx.SceneManager.resume, resume);
  ctx.SceneManager._now = 20;
  ctx.SceneManager.updateMain();
  assert.equal(ctx.SceneManager.logicSteps, 1);
});

test('direct-stepping overrides remain unchanged and execute their authored behavior', () => {
  const logs = [];
  const ctx = loadTiming(context => {
    context.console = { log(message) { logs.push(String(message)); } };
    context.SceneManager = stockShapedScene();
  });
  const update = ctx.SceneManager.updateMain = function() {
    this.updateInputData();
    this.changeScene();
    this.updateScene();
    this.renderScene();
  };
  assert.equal(ctx.pmjsMvInstallTimingContract(), false);
  assert.equal(ctx.SceneManager.updateMain, update);
  assert.equal(ctx.__pmjsTimingFallback, 'unrecognized-updateMain');
  assert.equal(ctx.PMJS.optimizations.isEnabled('mv.logic-timing-contract'), false);
  assert.equal(ctx.pmjsMvInstallTimingContract(), false);
  assert.equal(logs.filter(line => line.includes('timing-contract refused')).length, 1);
  ctx.SceneManager.updateMain();
  assert.equal(ctx.SceneManager.logicSteps, 1);
});

test('a refused direct-stepping update remains tied to the configured presentation cadence', () => {
  const ctx = loadTiming(context => {
    context.__pmjsTimingConfig = { renderHz: 30 };
    context.SceneManager = stockShapedScene();
  });
  ctx.SceneManager.updateMain = function() { this.updateScene(); this.renderScene(); };
  assert.equal(ctx.pmjsMvInstallTimingContract(), false);
  for (let frame = 0; frame < 30; frame++) ctx.SceneManager.updateMain();
  assert.equal(ctx.SceneManager.logicSteps, 30);
});

test('stock-looking time scaling is refused without changing guest simulation', () => {
  const ctx = loadTiming(context => { context.SceneManager = stockShapedScene(); });
  const source = stockUpdateMainSource.replace('this._currentTime = newTime;',
    'fTime *= 0.5; this._currentTime = newTime;');
  const update = ctx.SceneManager.updateMain = vm.runInContext('(' + source + ')', ctx);
  assert.equal(ctx.pmjsMvInstallTimingContract(), false);
  assert.equal(ctx.SceneManager.updateMain, update);
  ctx.SceneManager._now = 1000 / 30;
  update.call(ctx.SceneManager);
  assert.equal(ctx.SceneManager.logicSteps, 1);
});

test('custom logic intervals remain authored at installation and after finalization', () => {
  const ctx = loadTiming(context => { context.SceneManager = stockShapedScene(); });
  ctx.SceneManager._deltaTime = 1 / 30;
  const original = ctx.SceneManager.updateMain;
  assert.equal(ctx.pmjsMvInstallTimingContract(), false);
  assert.equal(ctx.SceneManager.updateMain, original);
  assert.equal(ctx.SceneManager._deltaTime, 1 / 30);

  const { ctx: installed, step } = startTiming();
  step(0);
  installed.PMJS.optimizations.finalize();
  installed.SceneManager._deltaTime = 1 / 30;
  assert.equal(step(1000 / 30), 1);
  assert.equal(installed.SceneManager._deltaTime, 1 / 30);
});

test('Mobile Safari branch stays authored across runtime platform changes', () => {
  let mobile = true;
  let detections = 0;
  const { ctx, step } = startTiming({}, context => {
    context.Utils.isMobileSafari = () => { detections++; return mobile; };
  });
  ctx.PMJS.optimizations.finalize();
  assert.equal(step(0), 1);
  assert.equal(step(1000 / 30), 1);
  assert.equal(ctx.SceneManager._currentTime, 0);
  assert.equal(detections, 2);
  mobile = false;
  assert.equal(step(100), 0);
  assert.equal(step(100 + 1000 / 30), 2);
  mobile = true;
  assert.equal(step(200), 1);
  assert.equal(detections, 5);
});

test('stock clock drift cannot add a logic step and the original clock getter is restored', () => {
  const { ctx, step } = startTiming(undefined, context => {
    context.SceneManager._getTimeInMsWithoutMobileSafari = function() {
      return this._now + 0.005;
    };
  });
  const getter = ctx.SceneManager._getTimeInMsWithoutMobileSafari;
  step(0);
  assert.equal(step(1000 / 60 - 0.001), 0);
  assert.equal(step(1000 / 60 + 0.001), 1);
  assert.equal(ctx.SceneManager._getTimeInMsWithoutMobileSafari, getter);
});

test('install returns without wrapping when engine services are missing', () => {
  const ctx = loadTiming();
  assert.equal(ctx.pmjsMvInstallTimingContract(), false);
  ctx.SceneManager = {};
  assert.equal(ctx.pmjsMvInstallTimingContract(), false);
  ctx.SceneManager = stockShapedScene();
  delete ctx.SceneManager.resume;
  const update = ctx.SceneManager.updateMain;
  assert.equal(ctx.pmjsMvInstallTimingContract(), false);
  assert.equal(ctx.SceneManager.updateMain, update);
  assert.equal(ctx.__pmjsTimingFallback, 'missing-resume');
});

test('invalid timing options fail before wrapping authored scene updates', () => {
  for (const [options, message] of [
    [{ catchupMode: 'smoothh' }, /catchupMode must be "smooth" or "burst"/],
    [{ renderHz: -60 }, /renderHz must be a non-negative finite number/],
    [{ renderHz: NaN }, /renderHz must be a non-negative finite number/]
  ]) {
    const ctx = loadTiming(context => { context.SceneManager = stockShapedScene(); });
    const update = ctx.SceneManager.updateMain;
    assert.throws(() => ctx.pmjsMvInstallTimingContract(options), message);
    assert.equal(ctx.SceneManager.updateMain, update);
  }
});

test('installer consumes runner-normalized timing without reading timing environment variables', () => {
  const { parseTimingConfig } = require('../runner/index.cjs');
  for (const env of [{}, { PMJS_RENDER_HZ: '30', PMJS_CATCHUP_MODE: 'smooth' },
    { PMJS_RENDER_HZ: '120' }, { PMJS_RENDER_HZ: '60', PMJS_UNCAPPED: '1' }]) {
    const timing = parseTimingConfig(env);
    const { step } = startTiming(undefined, context => {
      context.__pmjsTimingConfig = timing;
      context.NativeHost = { runtime: { env(name) {
        if (name === 'PMJS_RENDER_HZ' || name === 'PMJS_CATCHUP_MODE') {
          throw new Error('MV must consume normalized timing');
        }
        return '';
      } } };
    });
    step(0);
    assert.equal(step(200), timing.renderHz === 30 ? 3 : 2);
  }
});

test('explicit timing options override runner timing', () => {
  const { step } = startTiming({ renderHz: 60, catchupMode: 'smooth' }, context => {
    context.__pmjsTimingConfig = { renderHz: 30, catchupMode: 'burst' };
  });
  step(0);
  assert.equal(step(2000 / 30), 2);
  assert.equal(step(2500 / 30), 1);
});

test('standalone installation ignores raw host timing policy', () => {
  const { step } = startTiming(undefined, context => {
    context.NativeHost = { runtime: { env(name) {
      return name === 'PMJS_RENDER_HZ' ? '77' : name === 'PMJS_CATCHUP_MODE' ? 'invalid' : '';
    } } };
  });
  step(0);
  assert.equal(step(2000 / 30), 2);
  assert.equal(step(2500 / 30), 2);
});


test('reviewed timing accepts explicit CRLF source and refuses unreviewed formatting', () => {
  const ctx = loadTiming(context => { context.SceneManager = stockShapedScene(); });
  ctx.SceneManager.updateMain = vm.runInContext('(' + stockUpdateMainSource.replace(/\n/g, '\r\n') + ')', ctx);
  assert.equal(ctx.pmjsMvInstallTimingContract(), true);
  const changed = loadTiming(context => { context.SceneManager = stockShapedScene(); });
  const method = vm.runInContext('(' + stockUpdateMainSource.replace('this.renderScene();', 'this.renderScene( );') + ')', changed);
  changed.SceneManager.updateMain = method;
  assert.equal(changed.pmjsMvInstallTimingContract(), false);
  assert.equal(changed.SceneManager.updateMain, method);
});


test('private engine updateMain is recognized without rewriting its source',
  { skip: !process.env.PMJS_MV_REFERENCE_GAME && 'set PMJS_MV_REFERENCE_GAME to run private recognition' }, () => {
    const guest = vm.createContext({ performance, navigator: { userAgent: '' }, window: {}, location: { search: '' } });
    const core = fs.readFileSync(path.join(process.env.PMJS_MV_REFERENCE_GAME, 'js/rpg_core.js'), 'utf8');
    const renderingBoundary = core.indexOf('function Point()');
    assert.ok(renderingBoundary > 0, 'reference core must provide the reviewed non-rendering declarations');
    vm.runInContext(core.slice(0, renderingBoundary), guest, { filename: 'rpg_core.js' });
    vm.runInContext(fs.readFileSync(path.join(process.env.PMJS_MV_REFERENCE_GAME, 'js/rpg_managers.js'), 'utf8'), guest,
      { filename: 'rpg_managers.js' });
    const ctx = loadTiming(context => { context.SceneManager = stockShapedScene(); });
    ctx.SceneManager.updateMain = guest.SceneManager.updateMain;
    assert.equal(ctx.pmjsMvInstallTimingContract(), true);
  });
