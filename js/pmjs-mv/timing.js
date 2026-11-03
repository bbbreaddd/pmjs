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
    var renderHz = typeof opts.renderHz === 'number' ? opts.renderHz
      : typeof globalOpts.renderHz === 'number' ? globalOpts.renderHz
      : 0;
    var catchupMode = opts.catchupMode || globalOpts.catchupMode || 'burst';

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

  function pmjsMvResetStepGate(state, nowMs) {
    state.clockMs = nowMs;
    state.accMs = 0;
  }

  // Retain ordinary debt; bound progress and discard excess during overload.
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
    var slotMs = state.slotMs || 0;
    var nominalSteps = slotMs > 0 ? Math.ceil(slotMs / STEP_MS) : 1;
    var maxSteps = Math.max(BASE_MAX_STEPS_PER_FRAME, nominalSteps + 1);
    var overload = elapsed >= MAX_DEBT_MS || total >= MAX_DEBT_MS;
    var droppedMs = 0;
    if (overload) {
      var boundedTotal = Math.min(total, maxSteps * STEP_MS);
      droppedMs = total - boundedTotal;
      total = boundedTotal;
    }
    var full = Math.floor((total + 1e-4) / STEP_MS);
    var steps = full > maxSteps ? maxSteps : full;
    var frac = Math.max(0, total - full * STEP_MS);
    state.clockMs = nowMs;
    state.accMs = Math.max(0, total - steps * STEP_MS);
    if (state.catchupMode === 'smooth' && full > steps) {
      droppedMs += (full - steps) * STEP_MS;
      state.accMs = frac;
    }
    return { steps: steps, feedMs: steps > 0 ? steps * STEP_MS + frac : 0,
      overload: overload, droppedMs: droppedMs };
  }

  function pmjsMvReportOverload(droppedMs) {
    try {
      console.log('[pmjs] overload-debt-clamp dropped_ms=' +
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

  // Reviewed MV 1.6.1 implementation; retain exact LF and CRLF forms.
  var reviewedUpdateSource = `function() {
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

  var reviewedUpdateSources = [reviewedUpdateSource, reviewedUpdateSource.replace(/\n/g, '\r\n')];

  function pmjsMvRecognizesUpdateMain(fn) {
    return PMJS.methods.matchesSource(fn, reviewedUpdateSources);
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
    if (typeof SceneManager === 'undefined' || !SceneManager) {
      PMJS.optimizations.reportFallback(timingOptimizationId, 'SceneManager unavailable');
      return false;
    }
    if (typeof SceneManager.updateMain !== 'function') {
      PMJS.optimizations.reportFallback(timingOptimizationId, 'SceneManager.updateMain unavailable');
      return false;
    }
    if (SceneManager.updateMain._pmjsTimingWrapped) return true;
    if (SceneManager.updateMain._pmjsTimingRefused) return false;
    if (!pmjsMvRecognizesUpdateMain(SceneManager.updateMain)) {
      pmjsMvRefuseTimingContract('unrecognized-updateMain');
      PMJS.optimizations.refuse(timingOptimizationId,
        'unrecognized SceneManager.updateMain composition');
      return false;
    }
    if (typeof SceneManager.resume !== 'function') {
      pmjsMvRefuseTimingContract('missing-resume');
      PMJS.optimizations.refuse(timingOptimizationId, 'missing SceneManager.resume');
      return false;
    }
    if (SceneManager._deltaTime !== 1 / PMJS_MV_LOGIC_HZ) {
      pmjsMvRefuseTimingContract('modified-deltaTime');
      PMJS.optimizations.refuse(timingOptimizationId, 'modified SceneManager._deltaTime');
      return false;
    }
    var original = SceneManager.updateMain;
    var gate = pmjsMvCreateStepGate(options);
    var clockGetter = '_getTimeInMsWithoutMobileSafari';
    function wrappedUpdateMain() {
      var scene = this;
      var configuredHz = globalThis.__pmjsTimingConfig && globalThis.__pmjsTimingConfig.renderHz;
      if ((!options || options.renderHz === undefined) && typeof configuredHz === 'number' &&
          configuredHz >= 0 && configuredHz !== gate.renderHz) {
        gate.renderHz = configuredHz;
        gate.slotMs = configuredHz > 0 ? 1000 / configuredHz : 0;
      }
      if (scene._deltaTime !== 1 / PMJS_MV_LOGIC_HZ) {
        gate.clockMs = null;
        gate.accMs = 0;
        PMJS.optimizations.reportFallback(timingOptimizationId, 'modified SceneManager._deltaTime');
        return original.apply(scene, arguments);
      }
      var nowMs = performance.now();
      var savedGetter = scene[clockGetter];
      var fed = false;
      try {
        // Stock calls this clock only in its accumulator branch. Leave the
        // Mobile Safari branch and its platform-detection calls untouched.
        scene[clockGetter] = function() {
          var gated = pmjsMvGateSteps(gate, nowMs);
          scene._currentTime = nowMs;
          scene._accumulator = gated.feedMs / 1000;
          if (gated.overload || gated.droppedMs > 0) pmjsMvReportOverload(gated.droppedMs);
          fed = true;
          return nowMs;
        };
        return original.apply(scene, arguments);
      } finally {
        scene[clockGetter] = savedGetter;
        if (!fed) {
          gate.clockMs = null;
          gate.accMs = 0;
          PMJS.optimizations.reportFallback(timingOptimizationId, 'Mobile Safari timing branch');
        }
      }
    }
    wrappedUpdateMain._pmjsTimingWrapped = true;
    SceneManager.updateMain = wrappedUpdateMain;
    if (SceneManager.resume._pmjsTimingResumeWrapped) {
      SceneManager.resume._pmjsTimingGate = gate;
    } else {
      var originalResume = SceneManager.resume;
      function wrappedResume() {
        var result = originalResume.apply(this, arguments);
        pmjsMvResetStepGate(wrappedResume._pmjsTimingGate, performance.now());
        return result;
      }
      wrappedResume._pmjsTimingResumeWrapped = true;
      wrappedResume._pmjsTimingGate = gate;
      SceneManager.resume = wrappedResume;
    }
    return true;
  }

  globalThis.pmjsMvInstallTimingContract = pmjsMvInstallTimingContract;
})();
