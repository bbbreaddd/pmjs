'use strict';

(function() {
  var host = typeof NativeHost !== 'undefined' && NativeHost.runtime && NativeHost.runtime.scheduling ||
    globalThis.__pmjsBuiltinRequire('node:timers');
  var hostNextTick = host.nextTick;
  if (typeof hostNextTick !== 'function' && typeof globalThis.__pmjsBuiltinRequire === 'function') {
    var hostProcess = globalThis.__pmjsBuiltinRequire('node:process');
    hostNextTick = hostProcess.nextTick.bind(hostProcess);
  }
  if (typeof hostNextTick !== 'function') hostNextTick = host.setImmediate;
  var nextId = 1;
  var tasks = [], head = 0, continuations = [];
  var scheduled = null, stopped = false, rendering = false, frame = null;
  var clock = performance.now.bind(performance);
  var frameTasks = 0, frameStartedAt = 0, idleWaiters = [];
  var stopListeners = new Set();
  var nodeListenerExceptions = new WeakMap();
  var guestPromiseOrigins = new WeakMap();
  var runningTask = false;
  var activeOrigin, promiseScopes = [];
  var promiseHooks = typeof globalThis.__pmjsBuiltinRequire === 'function'
    ? globalThis.__pmjsBuiltinRequire('node:v8').promiseHooks : host.promiseHooks;
  // Registration scopes keep host observers of guest promises outside guest attribution.
  var removePromiseHooks = promiseHooks && promiseHooks.createHook({
    init: function(promise) {
      if (activeOrigin) guestPromiseOrigins.set(promise, activeOrigin);
    },
    before: function(promise) {
      promiseScopes.push(activeOrigin);
      activeOrigin = guestPromiseOrigins.get(promise);
    },
    after: function() { activeOrigin = promiseScopes.pop(); }
  });
  function runGuest(origin, callback, receiver, args) {
    var previous = activeOrigin;
    activeOrigin = origin;
    try { return trackGuestPromise(callback.apply(receiver, args || []), origin); }
    finally { activeOrigin = previous; }
  }
  function runHost(callback, receiver, args) {
    var previous = activeOrigin;
    activeOrigin = undefined;
    try { return callback.apply(receiver, args || []); }
    finally { activeOrigin = previous; }
  }
  var rafs = new Map(), timers = new Map(), immediates = new Set(), timerWake = null;

  function report(error) {
    if (typeof pmjsReportEventError === 'function') pmjsReportEventError(error);
    else console.error('[pmjs] async error:', error);
  }
  function reportUncaught(error) {
    if (typeof pmjsReportNodeException === 'function') pmjsReportNodeException(error);
    else console.error('[pmjs] uncaught exception in Node callback:', error);
  }
  function nodeListenerException(error) {
    var marker = {};
    nodeListenerExceptions.set(marker, error);
    return marker;
  }
  function trackGuestPromise(value, origin) {
    if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
      guestPromiseOrigins.set(value, origin);
    }
    return value;
  }
  function wrapNodeEmitter(emitter, synchronousMethods) {
    // Tag only guest listener throws so unrelated failures in the same I/O task stay fatal.
    var synchronousDispatch = 0;
    var originalEmit = emitter.emit;
    var methods = ['on', 'addListener', 'once', 'prependListener', 'prependOnceListener'];
    var synchronous = synchronousMethods || ['emit', 'push', 'read', 'write'];
    emitter.emit = function(event) {
      if (event === 'error' && !synchronousDispatch && emitter.listenerCount('error') === 0) {
        var error = arguments[1];
        if (runningTask) throw nodeListenerException(error);
        reportUncaught(error);
        return false;
      }
      return originalEmit.apply(this, arguments);
    };
    var guestEmitter;
    guestEmitter = new Proxy(emitter, {
      get: function(target, property) {
        if (methods.indexOf(property) >= 0) return function(event, listener) {
          if (typeof listener !== 'function') return target[property].call(target, event, listener);
          var wrapped = function() {
            try { return runGuest('node', listener, guestEmitter, arguments); }
            catch (error) {
              if (synchronousDispatch) throw error;
              if (runningTask) throw nodeListenerException(error);
              reportUncaught(error);
            }
          };
          wrapped.pmjsGuestNodeListener = true;
          wrapped.listener = listener;
          var result = target[property].call(target, event, wrapped);
          return result === target ? guestEmitter : result;
        };
        if (property === 'rawListeners') return function(event) {
          return target.rawListeners(event).map(function(listener) {
            return listener && listener.pmjsGuestNodeListener ? listener.listener : listener;
          });
        };
        if (property === 'removeListener' || property === 'off') return function(event, listener) {
          var raw = target.rawListeners(event), wrapped = null;
          for (var index = raw.length - 1; index >= 0 && !wrapped; index--) {
            var candidate = raw[index];
            while (candidate && !candidate.pmjsGuestNodeListener) candidate = candidate.listener;
            if (candidate && candidate.listener === listener) wrapped = candidate;
          }
          var result = target.removeListener(event, wrapped || listener);
          return result === target ? guestEmitter : result;
        };
        var value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        if (synchronous.indexOf(property) >= 0) return function() {
          synchronousDispatch++;
          try {
            var result = value.apply(target, arguments);
            return result === target ? guestEmitter : result;
          } finally { synchronousDispatch--; }
        };
        return function() {
          var result = value.apply(target, arguments);
          return result === target ? guestEmitter : result;
        };
      },
      set: function(target, property, value) { target[property] = value; return true; }
    });
    return guestEmitter;
  }
  function wake() {
    if (!stopped && scheduled === null) scheduled = host.setImmediate(step);
  }
  function discard(options) {
    if (!options.discard) return;
    try { options.discard(); } catch (error) { report(error); }
  }
  function enqueue(callback, options) {
    options = options || {};
    if (stopped) {
      discard(options);
      return false;
    }
    tasks.push({ callback: callback, options: options });
    wake();
    return true;
  }
  function invoke(callback, errorMode, renderingCallback) {
    return new Promise(function(resolve, reject) {
      var entry = { callback: function() {
        try { resolve(callback()); }
        catch (error) {
          if (errorMode === 'event') { report(error); resolve(); }
          else reject(error);
        }
      }, options: { discard: function() { resolve(); } } };
      if (stopped) { resolve(); return; }
      if (rendering && renderingCallback) continuations.push(entry);
      else tasks.push(entry);
      wake();
    });
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    if (removePromiseHooks) removePromiseHooks();
    if (scheduled !== null) host.clearImmediate(scheduled);
    if (timerWake !== null) host.clearTimeout(timerWake);
    scheduled = timerWake = null;
    timers.clear(); rafs.clear(); immediates.clear();
    stopListeners.forEach(function(callback) { try { callback(); } catch (error) { report(error); } });
    stopListeners.clear();
    var discarded = tasks.slice(head).concat(continuations);
    tasks = []; head = 0; continuations = [];
    discarded.forEach(function(entry) {
      discard(entry.options);
    });
    if (frame) { frame.resolve(); frame = null; }
    idleWaiters.splice(0).forEach(function(resolve) { resolve(); });
  }
  function fatal(error) {
    stop();
    if (typeof host.onFatal === 'function') host.onFatal(error);
    else throw error;
  }
  function step() {
    scheduled = null;
    if (stopped) return;
    // Bound resource admission across host turns without losing Promise checkpoints.
    if (!rendering && frame && (head === tasks.length || frameTasks >= 64 ||
      (frameTasks > 0 && clock() - frameStartedAt >= 4))) {
      var active = frame; frame = null;
      rendering = true;
      var result;
      try { result = active.callback(); }
      catch (error) { rendering = false; active.reject(error); wake(); return; }
      Promise.resolve(result).then(function(value) {
        rendering = false; active.resolve(value); wake();
      }, function(error) {
        rendering = false; active.reject(error); wake();
      });
      return;
    }
    var entry;
    if (rendering) entry = continuations.shift();
    else if (head < tasks.length) { entry = tasks[head]; tasks[head++] = null; }
    if (!entry) {
      if (!rendering) {
        tasks = []; head = 0;
        idleWaiters.splice(0).forEach(function(resolve) { resolve(); });
      }
      return;
    }
    if (!rendering && frame) {
      if (frameTasks === 0) frameStartedAt = clock();
      frameTasks++;
    }
    runningTask = true;
    try {
      if (entry.options.errorMode === 'uncaught') runGuest('node', entry.callback);
      else runHost(entry.callback);
    }
    catch (error) {
      runningTask = false;
      if (nodeListenerExceptions.has(error)) reportUncaught(nodeListenerExceptions.get(error));
      else if (entry.options.errorMode === 'event') report(error);
      else if (entry.options.errorMode === 'uncaught') reportUncaught(error);
      else { fatal(error); return; }
    } finally { runningTask = false; }
    if (!rendering && head >= tasks.length) { tasks = []; head = 0; }
    // Amortize compaction across the queue; consumed slots release callbacks above.
    else if (!rendering && head > 64 && head * 2 >= tasks.length) { tasks.splice(0, head); head = 0; }
    // Return to Node even when the last callback only queues Promise work.
    wake();
  }
  PMJS.tasks = {
    enqueue: enqueue,
    nextTick: function(callback, args) {
      if (typeof callback !== 'function') throw new TypeError('nextTick callback must be a function');
      if (stopped) return false;
      hostNextTick(function() {
        if (stopped) return;
        runningTask = true;
        try { runGuest('node', callback, undefined, args); }
        catch (error) {
          reportUncaught(nodeListenerExceptions.has(error) ? nodeListenerExceptions.get(error) : error);
        } finally { runningTask = false; }
      });
      return true;
    },
    invoke: invoke,
    nodeListenerException: nodeListenerException,
    trackGuestPromise: trackGuestPromise,
    runGuest: runGuest,
    runHost: runHost,
    guestPromiseOrigin: function(promise) { return guestPromiseOrigins.get(promise); },
    wrapNodeEmitter: wrapNodeEmitter,
    invokeRendering: function(callback, errorMode) { return invoke(callback, errorMode, true); },
    idle: function() {
      return new Promise(function(resolve) {
        if (stopped) resolve();
        else { idleWaiters.push(resolve); wake(); }
      });
    },
    runFrame: function(callback) {
      return new Promise(function(resolve, reject) {
        if (stopped) { resolve(); return; }
        if (frame || rendering) { reject(new Error('overlapping rendering phases')); return; }
        frame = { callback: callback, resolve: resolve, reject: reject };
        frameTasks = 0;
        wake();
      });
    },
    stop: stop,
    onStop: function(callback) {
      if (stopped) callback();
      else stopListeners.add(callback);
      return function() { stopListeners.delete(callback); };
    },
    get stopped() { return stopped; }
  };

  function armTimers() {
    if (timerWake !== null) host.clearTimeout(timerWake);
    timerWake = null;
    if (stopped) return;
    var deadline = Infinity;
    timers.forEach(function(timer) {
      if (!timer.queued) deadline = Math.min(deadline, timer.deadline);
    });
    if (deadline !== Infinity) timerWake = host.setTimeout(queueDueTimers,
      Math.max(0, deadline - performance.now()));
  }
  function queueDueTimers() {
    timerWake = null;
    var now = performance.now(), due = [];
    timers.forEach(function(timer) {
      if (!timer.queued && timer.deadline <= now) due.push(timer);
    });
    due.sort(function(a, b) { return a.deadline - b.deadline || a.id - b.id; });
    due.forEach(function(timer) {
      timer.queued = true;
      enqueue(function() {
        if (!timers.has(timer.id)) return;
        if (!timer.interval) timers.delete(timer.id);
        try {
          if (typeof timer.callback === 'function') runGuest('browser', timer.callback, globalThis, timer.args);
          else if (typeof timer.callback === 'string') runGuest('browser', function() { return (0, eval)(timer.callback); });
        } finally {
          if (timer.interval && timers.has(timer.id)) {
            var now = performance.now();
            timer.deadline += Math.max(1, Math.floor((now - timer.deadline) / timer.interval) + 1) * timer.interval;
            timer.queued = false;
          }
          armTimers();
        }
      }, { errorMode: 'event' });
    });
    armTimers();
  }
  function addTimer(callback, delay, interval, args) {
    var id = nextId++;
    delay = Math.max(interval ? 1 : 0, Number(delay) || 0);
    if (!stopped) {
      timers.set(id, { id: id, callback: callback, args: args,
        deadline: performance.now() + delay, interval: interval ? delay : 0, queued: false });
      armTimers();
    }
    return id;
  }
  function clearTimer(id) { timers.delete(id); armTimers(); }
  function addImmediate(callback, args) {
    if (typeof callback !== 'function') throw new TypeError('setImmediate callback must be a function');
    var referenced = true;
    var handle = {
      ref: function() { referenced = true; return handle; },
      unref: function() { referenced = false; return handle; },
      hasRef: function() { return referenced && immediates.has(handle); }
    };
    immediates.add(handle);
    enqueue(function() {
      if (!immediates.delete(handle)) return;
      return callback.apply(globalThis, args);
    }, { errorMode: 'uncaught', discard: function() { immediates.delete(handle); } });
    return handle;
  }
  globalThis.setTimeout = function(callback, delay) {
    return addTimer(callback, delay, false, Array.prototype.slice.call(arguments, 2));
  };
  globalThis.setInterval = function(callback, delay) {
    return addTimer(callback, delay, true, Array.prototype.slice.call(arguments, 2));
  };
  globalThis.clearTimeout = globalThis.clearInterval = clearTimer;
  globalThis.setImmediate = function(callback) {
    return addImmediate(callback, Array.prototype.slice.call(arguments, 1));
  };
  globalThis.clearImmediate = function(handle) { immediates.delete(handle); };
  globalThis.requestAnimationFrame = function(callback) {
    if (typeof callback !== 'function') throw new TypeError('requestAnimationFrame callback must be a function');
    var id = nextId++;
    if (!stopped) rafs.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = function(id) { rafs.delete(id); };
  globalThis.pmjsDrainScheduler = function(now) {
    if (typeof now !== 'number') now = performance.now();
    var snapshot = Array.from(rafs.keys());
    var chain = Promise.resolve();
    snapshot.forEach(function(id) {
      chain = chain.then(function() {
        return invoke(function() {
          var callback = rafs.get(id);
          if (!callback) return;
          rafs.delete(id);
          runGuest('browser', callback, undefined, [now]);
        }, 'event', true);
      });
    });
    return chain;
  };
})();
