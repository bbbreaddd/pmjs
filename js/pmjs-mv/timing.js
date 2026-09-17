'use strict';

// MV logic stays at its authored 60 Hz while presentation is paced separately.

(function() {
  var PMJS_MV_LOGIC_HZ = 60;
  var STEP_MS = 1000 / PMJS_MV_LOGIC_HZ;
  var MAX_DEBT_MS = 250;
  var MAX_STEPS_PER_FRAME = 2;

  function pmjsMvCreateStepGate() {
    return { accMs: 0, clockMs: null };
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
    if (total >= MAX_DEBT_MS) {
      state.clockMs = nowMs;
      state.accMs = 0;
      return { steps: 0, feedMs: 0, overload: true, droppedMs: total };
    }
    var full = Math.floor(total / STEP_MS);
    var steps = full > MAX_STEPS_PER_FRAME ? MAX_STEPS_PER_FRAME : full;
    var frac = total - full * STEP_MS;
    state.clockMs = nowMs;
    state.accMs = total - steps * STEP_MS;
    return { steps: steps, feedMs: steps * STEP_MS + frac,
      overload: false, droppedMs: 0 };
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
    return source.indexOf('_accumulator') !== -1 &&
      source.indexOf('_deltaTime') !== -1 &&
      source.indexOf('_currentTime') !== -1 &&
      source.indexOf('renderScene') !== -1;
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

  function pmjsMvInstallTimingContract() {
    if (typeof SceneManager === 'undefined' || !SceneManager) return false;
    if (typeof SceneManager.updateMain !== 'function') return false;
    if (SceneManager.updateMain._pmjsTimingWrapped) return true;
    if (SceneManager.updateMain._pmjsTimingRefused) return false;
    if (!pmjsMvRecognizesUpdateMain(SceneManager.updateMain)) {
      pmjsMvRefuseTimingContract('unrecognized-updateMain');
      return false;
    }
    var original = SceneManager.updateMain;
    SceneManager._deltaTime = 1 / PMJS_MV_LOGIC_HZ;
    var gate = pmjsMvCreateStepGate();
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

  function pmjsMvEnsureTimingContract() {
    if (typeof SceneManager === 'undefined' || !SceneManager) return false;
    if (typeof SceneManager.updateMain !== 'function') return false;
    if (SceneManager.updateMain._pmjsTimingWrapped) return true;
    if (SceneManager.updateMain._pmjsTimingRefused) return false;
    return pmjsMvInstallTimingContract();
  }

  globalThis.pmjsMvLogicHz = PMJS_MV_LOGIC_HZ;
  globalThis.pmjsMvCreateStepGate = pmjsMvCreateStepGate;
  globalThis.pmjsMvGateSteps = pmjsMvGateSteps;
  globalThis.pmjsMvRecognizesUpdateMain = pmjsMvRecognizesUpdateMain;
  globalThis.pmjsMvInstallTimingContract = pmjsMvInstallTimingContract;
  globalThis.pmjsMvEnsureTimingContract = pmjsMvEnsureTimingContract;
})();
