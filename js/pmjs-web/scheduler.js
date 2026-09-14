'use strict';

(function() {
  var nextId = 1;

  var rafQueue = [];
  var cancelledRafs = new Set();
  var timers = new Map();

  var schedulerNow = 0;
  var draining = false;

  function clockNow() {
    return draining ? schedulerNow : performance.now();
  }

  function reportAsyncError(error) {
    console.error('[pmjs] async error:', error);
  }

  function requestAnimationFrameCompat(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('requestAnimationFrame callback must be a function');
    }
    var id = nextId++;
    rafQueue.push({
      id: id,
      callback: callback,
      cancelled: false
    });
    return id;
  }

  function cancelAnimationFrameCompat(id) {
    cancelledRafs.add(id);
    for (var i = 0; i < rafQueue.length; i++) {
      if (rafQueue[i].id === id) {
        rafQueue[i].cancelled = true;
        break;
      }
    }
  }

  function setTimeoutCompat(callback, delay) {
    var id = nextId++;
    var args = [];
    for (var i = 2; i < arguments.length; i++) args.push(arguments[i]);

    timers.set(id, {
      id: id,
      callback: callback,
      args: args,
      deadline: clockNow() + Math.max(0, Number(delay) || 0),
      interval: 0
    });

    return id;
  }

  function clearTimeoutCompat(id) {
    timers.delete(id);
  }

  function setIntervalCompat(callback, delay) {
    var interval = Math.max(1, Number(delay) || 0);
    var id = nextId++;
    var args = [];
    for (var i = 2; i < arguments.length; i++) args.push(arguments[i]);

    timers.set(id, {
      id: id,
      callback: callback,
      args: args,
      deadline: clockNow() + interval,
      interval: interval
    });

    return id;
  }

  function clearIntervalCompat(id) {
    timers.delete(id);
  }

  function drainTimers(now) {
    var due = [];

    timers.forEach(function(timer) {
      if (timer.deadline <= now) {
        due.push(timer);
      }
    });

    due.sort(function(a, b) {
      return a.deadline - b.deadline || a.id - b.id;
    });

    for (var i = 0; i < due.length; i++) {
      var timer = due[i];

      if (!timers.has(timer.id)) continue;

      if (timer.interval > 0) {
        do {
          timer.deadline += timer.interval;
        } while (timer.deadline <= now);
      } else {
        timers.delete(timer.id);
      }

      try {
        if (typeof timer.callback === 'function') {
          timer.callback.apply(globalThis, timer.args);
        } else if (typeof timer.callback === 'string') {
          (0, eval)(timer.callback);
        }
      } catch (error) {
        reportAsyncError(error);
      }
    }
  }

  function drainAnimationFrames(now) {
    var callbacks = rafQueue;
    rafQueue = [];

    for (var i = 0; i < callbacks.length; i++) {
      var entry = callbacks[i];
      if (!entry.cancelled && !cancelledRafs.has(entry.id)) {
        try {
          entry.callback(now);
        } catch (error) {
          reportAsyncError(error);
        }
      }
      cancelledRafs.delete(entry.id);
    }
    cancelledRafs.clear();
  }

  function pmjsDrainScheduler(now) {
    if (typeof now !== 'number') now = performance.now();
    schedulerNow = now;
    draining = true;
    try {
      drainTimers(now);
      drainAnimationFrames(now);
    } finally {
      draining = false;
    }
  }

  globalThis.requestAnimationFrame = requestAnimationFrameCompat;
  globalThis.cancelAnimationFrame = cancelAnimationFrameCompat;

  globalThis.setTimeout = setTimeoutCompat;
  globalThis.clearTimeout = clearTimeoutCompat;
  globalThis.setInterval = setIntervalCompat;
  globalThis.clearInterval = clearIntervalCompat;

  globalThis.pmjsDrainScheduler = pmjsDrainScheduler;

  if (typeof window !== 'undefined') {
    window.requestAnimationFrame = requestAnimationFrameCompat;
    window.cancelAnimationFrame = cancelAnimationFrameCompat;
    window.setTimeout = setTimeoutCompat;
    window.clearTimeout = clearTimeoutCompat;
    window.setInterval = setIntervalCompat;
    window.clearInterval = clearIntervalCompat;
  }
})();
