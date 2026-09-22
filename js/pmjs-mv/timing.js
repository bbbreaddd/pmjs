'use strict';

// MV logic stays at its authored 60 Hz while presentation is paced separately.

(function() {
  var timingOptimizationId = 'mv.logic-timing-contract';
  PMJS.optimizations.register({
    id: timingOptimizationId,
    owner: 'pmjs-mv/timing',
    fallback: 'leave final guest SceneManager.updateMain unchanged'
  });
  var PMJS_MV_LOGIC_HZ = 60;
  var STEP_MS = 1000 / PMJS_MV_LOGIC_HZ;
  var MAX_DEBT_MS = 250;
  // Baseline catch-up bound per frame for uncapped execution and nominal ratio floors.
  var BASE_MAX_STEPS_PER_FRAME = 2;

  function pmjsMvCreateStepGate(options) {
    var globalOpts = globalThis.__pmjsTimingConfig || {};
    var opts = options || {};
    var envRenderHz = (typeof NativeHost !== 'undefined' && NativeHost.runtime &&
      typeof NativeHost.runtime.env === 'function' && Number(NativeHost.runtime.env('PMJS_RENDER_HZ'))) || 0;
    var envCatchupMode = (typeof NativeHost !== 'undefined' && NativeHost.runtime &&
      typeof NativeHost.runtime.env === 'function' && NativeHost.runtime.env('PMJS_CATCHUP_MODE')) || '';

    var renderHz = typeof opts.renderHz === 'number' ? opts.renderHz
      : typeof globalOpts.renderHz === 'number' ? globalOpts.renderHz
      : envRenderHz;
    var catchupMode = opts.catchupMode || globalOpts.catchupMode || envCatchupMode || 'burst';

    if (typeof renderHz !== 'number' || !isFinite(renderHz) || renderHz < 0) {
      throw new TypeError('pmjsMvCreateStepGate: renderHz must be a non-negative finite number, got ' + renderHz);
    }
    if (catchupMode !== 'smooth' && catchupMode !== 'burst') {
      throw new TypeError('pmjsMvCreateStepGate: catchupMode must be "smooth" or "burst", got ' + catchupMode);
    }

    var slotMs = renderHz > 0 ? (1000 / renderHz) : 0;
    return {
      renderHz: renderHz,
      catchupMode: catchupMode,
      slotMs: slotMs,
      accMs: 0,
      clockMs: null
    };
  }

  // Retain ordinary debt; rebase without catch-up after a discontinuity.
  function pmjsMvGateSteps(state, nowMs) {
    if (!state || typeof nowMs !== 'number' || !(nowMs >= 0) ||
        typeof state.accMs !== 'number' || !(state.accMs >= 0)) {
      return { steps: 0, feedMs: 0, overload: false, droppedMs: 0 };
    }
    if (state.clockMs === null || state.clockMs === undefined ||
        !(nowMs >= state.clockMs)) {
      state.clockMs = nowMs;
      state.accMs = 0;
      return { steps: 0, feedMs: 0, overload: false, droppedMs: 0 };
    }
    var elapsed = nowMs - state.clockMs;

    var total = state.accMs + elapsed;
    if (elapsed >= MAX_DEBT_MS || total >= MAX_DEBT_MS) {
      state.clockMs = nowMs;
      state.accMs = 0;
      return { steps: 0, feedMs: 0, overload: true, droppedMs: total };
    }
    var slotMs = state.slotMs || 0;
    var nominalSteps = slotMs > 0 ? Math.ceil(slotMs / STEP_MS) : 1;
    var maxSteps = Math.max(BASE_MAX_STEPS_PER_FRAME, nominalSteps + 1);
    var full = Math.floor((total + 1e-4) / STEP_MS);
    var steps = full > maxSteps ? maxSteps : full;
    var frac = Math.max(0, total - full * STEP_MS);
    var droppedMs = 0;
    state.clockMs = nowMs;
    state.accMs = Math.max(0, total - steps * STEP_MS);
    if (state.catchupMode === 'smooth' && full > steps) {
      droppedMs = (full - steps) * STEP_MS;
      state.accMs = frac;
    }
    return { steps: steps, feedMs: steps > 0 ? steps * STEP_MS + frac : 0,
      overload: false, droppedMs: droppedMs };
  }

  function pmjsMvReportOverload(droppedMs) {
    try {
      console.log('[pmjs] overload-discontinuity dropped_ms=' +
        Number(droppedMs).toFixed(1));
    } catch (_) {}
    try {
      if (typeof globalThis.__pmjsOverloadDiscontinuities === 'number') {
        globalThis.__pmjsOverloadDiscontinuities += 1;
      } else {
        globalThis.__pmjsOverloadDiscontinuities = 1;
      }
    } catch (_) {}
  }

  // Direct-stepping overrides cannot be safely controlled by this gate.
  function pmjsMvRecognizesUpdateMain(fn) {
    var source = '';
    try {
      source = Function.prototype.toString.call(fn);
    } catch (_) {
      return false;
    }
    return /this\._currentTime\s*=\s*newTime/.test(source) &&
      /this\._accumulator\s*\+=\s*fTime/.test(source) &&
      /while\s*\(\s*this\._accumulator\s*>=\s*this\._deltaTime\s*\)/.test(source) &&
      /this\.updateInputData\(\)\s*;\s*this\.changeScene\(\)\s*;\s*this\.updateScene\(\)/.test(source) &&
      /this\._accumulator\s*-=\s*this\._deltaTime/.test(source) &&
      /this\.renderScene\(\)\s*;\s*this\.requestUpdate\(\)/.test(source);
  }

  function pmjsMvRefuseTimingContract(reason) {
    try {
      var current = SceneManager.updateMain;
      if (current && !current._pmjsTimingRefused) {
        current._pmjsTimingRefused = true;
        console.log('[pmjs] timing-contract refused: ' + reason +
          ' (updateMain left untouched; logic runs per presentation)');
      }
    } catch (_) {}
    try {
      globalThis.__pmjsTimingFallback = reason;
    } catch (_) {}
  }

  function pmjsMvInstallTimingContract(options) {
    if (!PMJS.optimizations.isEnabled(timingOptimizationId)) return false;
    if (typeof SceneManager === 'undefined' || !SceneManager) return false;
    if (typeof SceneManager.updateMain !== 'function') return false;
    if (SceneManager.updateMain._pmjsTimingWrapped) return true;
    if (SceneManager.updateMain._pmjsTimingRefused) return false;
    if (!pmjsMvRecognizesUpdateMain(SceneManager.updateMain)) {
      pmjsMvRefuseTimingContract('unrecognized-updateMain');
      PMJS.optimizations.refuse(timingOptimizationId,
        'unrecognized SceneManager.updateMain composition');
      return false;
    }
    var original = SceneManager.updateMain;
    SceneManager._deltaTime = 1 / PMJS_MV_LOGIC_HZ;
    var gate = pmjsMvCreateStepGate(options);
    var clockGetter = '_getTimeInMsWithoutMobileSafari';
    function wrappedUpdateMain() {
      var nowMs = performance.now();
      SceneManager._deltaTime = 1 / PMJS_MV_LOGIC_HZ;
      var gated = pmjsMvGateSteps(gate, nowMs);
      if (gated.overload) {
        SceneManager._currentTime = nowMs;
        SceneManager._accumulator = 0;
        pmjsMvReportOverload(gated.droppedMs);
      } else {
        // Feed only the steps selected by the gate into stock updateMain.
        SceneManager._currentTime = nowMs;
        SceneManager._accumulator = gated.feedMs / 1000;
      }
      // Prevent stock's second clock read from changing the selected steps.
      var hadGetter = false;
      var savedGetter;
      try {
        hadGetter = typeof SceneManager[clockGetter] === 'function';
        savedGetter = SceneManager[clockGetter];
        SceneManager[clockGetter] = function() { return nowMs; };
        return original.apply(this, arguments);
      } finally {
        try {
          if (hadGetter) SceneManager[clockGetter] = savedGetter;
          else delete SceneManager[clockGetter];
        } catch (_) {}
      }
    }
    wrappedUpdateMain._pmjsTimingWrapped = true;
    SceneManager.updateMain = wrappedUpdateMain;
    return true;
  }

  function pmjsMvEnsureTimingContract(options) {
    if (typeof SceneManager === 'undefined' || !SceneManager) return false;
    if (typeof SceneManager.updateMain !== 'function') return false;
    if (SceneManager.updateMain._pmjsTimingWrapped) return true;
    if (SceneManager.updateMain._pmjsTimingRefused) return false;
    return pmjsMvInstallTimingContract(options);
  }

  globalThis.pmjsMvLogicHz = PMJS_MV_LOGIC_HZ;
  globalThis.pmjsMvCreateStepGate = pmjsMvCreateStepGate;
  globalThis.pmjsMvGateSteps = pmjsMvGateSteps;
  globalThis.pmjsMvRecognizesUpdateMain = pmjsMvRecognizesUpdateMain;
  globalThis.pmjsMvInstallTimingContract = pmjsMvInstallTimingContract;
  globalThis.pmjsMvEnsureTimingContract = pmjsMvEnsureTimingContract;
})();
