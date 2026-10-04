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
  if (typeof handler !== 'function') return;
  try {
    handler.call(target, event);
  } catch (error) {
    pmjsReportEventError(error);
  }
}

EventTarget.prototype.addEventListener = function(type, listener) {
  if (typeof listener !== 'function') return;
  var listeners = this._listeners[type];
  if (!listeners) {
    listeners = [];
    this._listeners[type] = listeners;
  }
  if (listeners.indexOf(listener) < 0) listeners.push(listener);
};

EventTarget.prototype.removeEventListener = function(type, listener) {
  var listeners = this._listeners[type];
  if (!listeners) return;
  var index = listeners.indexOf(listener);
  if (index >= 0) listeners.splice(index, 1);
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
    var returned;
    try {
      if (typeof this['on' + event.type] === 'function') returned = this['on' + event.type].call(this, event);
    } catch (error) { pmjsReportEventError(error); }
    if (returned === false && typeof event.preventDefault === 'function') event.preventDefault();
  }
  for (var index = 0; index < listeners.length; index++) {
    pmjsInvokeEventHandler(this, listeners[index], event);
  }
  return !event.defaultPrevented;
};

globalThis.EventTarget = EventTarget;
