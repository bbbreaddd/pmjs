function EventTarget() {
  this._listeners = Object.create(null);
  this._eventHandlers = Object.create(null);
}

var reportingEventError = false;
function pmjsReportEventError(error) {
  if (reportingEventError) {
    console.error('[pmjs] event error:', error);
    return;
  }
  reportingEventError = true;
  try {
    var event = {
      type: 'error', error: error,
      message: error && error.message ? error.message : String(error),
      filename: '', lineno: 0, colno: 0, defaultPrevented: false,
      preventDefault: function() { this.defaultPrevented = true; }
    };
    if (typeof globalThis.onerror === 'function') {
      try {
        if (globalThis.onerror(event.message, '', 0, 0, error) === true) {
          event.preventDefault();
        }
      } catch (handlerError) {
        console.error('[pmjs] error handler failed:', handlerError);
      }
    }
    if (typeof globalThis.dispatchEvent === 'function') {
      globalThis.dispatchEvent(event);
    }
    if (!event.defaultPrevented) console.error('[pmjs] event error:', error);
  } catch (reportError) {
    console.error('[pmjs] error handler failed:', reportError);
  } finally {
    reportingEventError = false;
  }
}

function pmjsInvokeEventHandler(target, handler, event) {
  if (typeof handler !== 'function') return undefined;
  try {
    var result = handler.call(target, event);
    if (PMJS.tasks && typeof PMJS.tasks.trackGuestPromise === 'function') {
      PMJS.tasks.trackGuestPromise(result, 'browser');
    }
    return result;
  } catch (error) {
    pmjsReportEventError(error);
    return undefined;
  }
}

EventTarget.prototype.addEventListener = function(type, listener) {
  if (typeof listener !== 'function') return;
  var listeners = this._listeners[type];
  if (!listeners) {
    listeners = [];
    this._listeners[type] = listeners;
  }
  if (!listeners.some(function(entry) { return entry.callback === listener; })) {
    listeners.push({ callback: listener, removed: false });
  }
  if (typeof documentTarget !== 'undefined' && this === documentTarget &&
      (type === 'gamepadconnected' || type === 'gamepaddisconnected')) {
    PMJS.web.observeGamepads();
  }
};

EventTarget.prototype.removeEventListener = function(type, listener) {
  var listeners = this._listeners[type];
  if (!listeners) return;
  var index = listeners.findIndex(function(entry) { return entry.callback === listener; });
  if (index >= 0) {
    // Dispatch snapshots retain registrations, so removal must invalidate them too.
    listeners[index].removed = true;
    listeners.splice(index, 1);
  }
};

EventTarget.defineEventHandlerProperty = function(prototype, type) {
  Object.defineProperty(prototype, 'on' + type, {
    configurable: true,
    get: function() { return this._eventHandlers[type] || null; },
    set: function(handler) {
      var previous = this._eventHandlers[type];
      if (previous) this.removeEventListener(type, previous);
      this._eventHandlers[type] = typeof handler === 'function' ? handler : null;
      if (this._eventHandlers[type]) this.addEventListener(type, this._eventHandlers[type]);
    }
  });
};

EventTarget.prototype.dispatchEvent = function(event) {
  if (!event || typeof event.type !== 'string') {
    throw new TypeError('event must have a string type');
  }
  var listeners = (this._listeners[event.type] || []).slice();
  event.target = event.target || this;
  event.currentTarget = this;
  if (!event._pmjsHandlerInvoked && !this._eventHandlers[event.type]) {
    var returned = pmjsInvokeEventHandler(this, this['on' + event.type], event);
    if (returned === false && typeof event.preventDefault === 'function') event.preventDefault();
  }
  for (var index = 0; index < listeners.length; index++) {
    if (!listeners[index].removed) pmjsInvokeEventHandler(this, listeners[index].callback, event);
  }
  return !event.defaultPrevented;
};

globalThis.EventTarget = EventTarget;
function pmjsDispatchHostEvent(target, event, isCurrent) {
  event.target = event.target || target;
  event.currentTarget = target;
  var listeners = (target._listeners[event.type] || []).slice();
  if (!target._eventHandlers[event.type] && typeof target['on' + event.type] === 'function') {
    listeners.unshift({ callback: target['on' + event.type], removed: false });
  }
  var chain = Promise.resolve();
  listeners.forEach(function(listener) {
    chain = chain.then(function() {
      return PMJS.tasks.invoke(function() {
        if (listener.removed || PMJS.tasks.stopped || isCurrent && !isCurrent()) return;
        pmjsInvokeEventHandler(target, listener.callback, event);
      }, 'event');
    });
  });
  return chain.then(function() {
    return !PMJS.tasks.stopped && (!isCurrent || isCurrent());
  });
}

globalThis.PMJS = globalThis.PMJS || {};
PMJS.web = PMJS.web || {};
PMJS.web.input = PMJS.web.input || new EventTarget();
