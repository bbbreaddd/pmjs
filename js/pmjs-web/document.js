var documentTarget = new EventTarget();
globalThis.document = documentTarget;
documentTarget.readyState = 'complete';
Object.defineProperty(documentTarget, 'title', {
  configurable: true,
  enumerable: true,
  get: function() {
    return (globalThis.__pmjsGameInfo && globalThis.__pmjsGameInfo.title) ||
      PMJS.config.title || 'PMJS';
  },
  set: function(value) {
    globalThis.__pmjsSetWindowTitle(value);
  }
});
documentTarget.hasFocus = function() { return nativeWindowState.focused; };
Object.defineProperty(documentTarget, 'hidden', {
  configurable: true,
  enumerable: true,
  get: function() { return !nativeWindowState.visible; }
});
Object.defineProperty(documentTarget, 'visibilityState', {
  configurable: true,
  enumerable: true,
  get: function() { return nativeWindowState.visible ? 'visible' : 'hidden'; }
});
documentTarget.documentElement = new GenericElement('html');
documentTarget.body = new GenericElement('body');
documentTarget.head = new GenericElement('head');
documentTarget.documentElement.parentNode = documentTarget;
documentTarget.documentElement.appendChild(documentTarget.head);
documentTarget.documentElement.appendChild(documentTarget.body);
documentTarget.createElement = function(tagName) {
  var name = String(tagName).toLowerCase();
  if (name === 'canvas') return new CanvasElement();
  if (name === 'audio') return new AudioElement();
  if (name === 'video') return new VideoElement();
  if (name === 'script') return new ScriptElement();
  var element = new GenericElement(tagName);
  if (name === 'style') {
    element.sheet = {
      insertRule: function(rule) {
        if (rule && globalThis.PMJS && PMJS.fonts &&
            typeof PMJS.fonts.registerFontFaceRule === 'function') {
          PMJS.fonts.registerFontFaceRule(rule);
        }
      }
    };
  }
  return element;
};
documentTarget.createTextNode = function(text) {
  var node = new GenericElement('#text');
  node.textContent = String(text);
  return node;
};
documentTarget.getElementById = function(id) {
  id = String(id);
  if (!id) return null;
  function find(node) {
    if (node.id === id) return node;
    var children = node.children || [];
    for (var child of children) {
      var match = find(child);
      if (match) return match;
    }
    return null;
  }
  return find(this.body) || find(this.head);
};
documentTarget.getElementsByTagName = function(tagName) {
  var elements = String(tagName).toLowerCase() === 'head' ? [this.head] : [];
  elements.item = function(index) { return this[index] || null; };
  return elements;
};

globalThis.HTMLCanvasElement = CanvasElement;
globalThis.HTMLImageElement = NativeImage;
globalThis.HTMLVideoElement = VideoElement;
globalThis.Image = NativeImage;
globalThis.CanvasRenderingContext2D = CanvasContext2D;
globalThis.addEventListener = EventTarget.prototype.addEventListener.bind(documentTarget);
globalThis.removeEventListener = EventTarget.prototype.removeEventListener.bind(documentTarget);
globalThis.dispatchEvent = EventTarget.prototype.dispatchEvent.bind(documentTarget);

function setNativeFullscreen(enabled, element) {
  NativeHost.runtime.setFullscreen(enabled);
  documentTarget.fullscreenElement = enabled ? (element || documentTarget.body) : null;
  documentTarget.mozFullScreen = enabled;
  documentTarget.webkitIsFullScreen = enabled;
  documentTarget.webkitFullscreenElement = documentTarget.fullscreenElement;
  documentTarget.mozFullScreenElement = documentTarget.fullscreenElement;
  documentTarget.msFullscreenElement = documentTarget.fullscreenElement;
  documentTarget.dispatchEvent({ type: 'fullscreenchange', target: documentTarget });
}

GenericElement.prototype.requestFullscreen = function() {
  try {
    setNativeFullscreen(true, this);
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
};
GenericElement.prototype.requestFullScreen = function() { setNativeFullscreen(true, this); };
GenericElement.prototype.webkitRequestFullscreen = GenericElement.prototype.requestFullScreen;
GenericElement.prototype.webkitRequestFullScreen = GenericElement.prototype.requestFullScreen;
GenericElement.prototype.mozRequestFullScreen = GenericElement.prototype.requestFullScreen;
GenericElement.prototype.msRequestFullscreen = GenericElement.prototype.requestFullScreen;
documentTarget.fullscreenElement = null;
documentTarget.webkitFullscreenElement = null;
documentTarget.mozFullScreenElement = null;
documentTarget.msFullscreenElement = null;
documentTarget.mozFullScreen = false;
documentTarget.webkitIsFullScreen = false;
documentTarget.exitFullscreen = function() {
  try {
    setNativeFullscreen(false);
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
};
documentTarget.cancelFullScreen = function() { setNativeFullscreen(false); };
documentTarget.webkitCancelFullScreen = documentTarget.cancelFullScreen;
documentTarget.mozCancelFullScreen = documentTarget.cancelFullScreen;
documentTarget.msExitFullscreen = documentTarget.cancelFullScreen;

GenericElement.prototype.focus = function() {
  if (documentTarget.activeElement === this) return;
  var previous = documentTarget.activeElement;
  documentTarget.activeElement = this;
  if (previous) previous.dispatchEvent({ type: 'blur', target: previous });
  this.dispatchEvent({ type: 'focus', target: this });
};
GenericElement.prototype.blur = function() {
  if (documentTarget.activeElement !== this) return;
  documentTarget.activeElement = documentTarget.body;
  this.dispatchEvent({ type: 'blur', target: this });
};
documentTarget.activeElement = documentTarget.body;

['requestFullscreen', 'requestFullScreen', 'webkitRequestFullscreen',
  'webkitRequestFullScreen', 'mozRequestFullScreen', 'msRequestFullscreen',
  'focus', 'blur'].forEach(function(name) {
  CanvasElement.prototype[name] = GenericElement.prototype[name];
});
