function EventTarget() {
  this._listeners = Object.create(null);
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

EventTarget.prototype.dispatchEvent = function(event) {
  if (!event || typeof event.type !== 'string') {
    throw new TypeError('event must have a string type');
  }
  var listeners = (this._listeners[event.type] || []).slice();
  event.target = event.target || this;
  event.currentTarget = this;
  for (var index = 0; index < listeners.length; index++) {
    listeners[index].call(this, event);
  }
  return !event.defaultPrevented;
};

globalThis.EventTarget = EventTarget;
