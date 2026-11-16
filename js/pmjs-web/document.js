var documentTarget = new Node();
documentTarget.nodeType = 9;
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
documentTarget.children = [documentTarget.documentElement];
documentTarget.documentElement.appendChild(documentTarget.head);
documentTarget.documentElement.appendChild(documentTarget.body);
documentTarget.createElement = function(tagName) {
  var name = String(tagName).toLowerCase();
  if (name === 'canvas') return new CanvasElement();
  if (name === 'audio') return new AudioElement();
  if (name === 'video') return new VideoElement();
  if (name === 'script') return new ScriptElement();
  if (name === 'input') return new InputElement();
  var element = new GenericElement(tagName);
  if (name === 'style') element.sheet = new CSSStyleSheet(null);
  return element;
};
documentTarget.createTextNode = function(text) {
  return new TextNode(text);
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
  return find(this.documentElement);
};
documentTarget.getElementsByTagName = function(tagName) {
  var results = this.documentElement.getElementsByTagName(tagName);
  if (String(tagName).toLowerCase() === 'html' || tagName === '*') results.unshift(this.documentElement);
  return results;
};

function CSSFontFaceRule(text) {
  this.cssText = text;
  this.type = 5;
  this.style = new CSSStyleDeclaration();
  this.style.cssText = text.slice(text.indexOf('{') + 1, text.lastIndexOf('}'));
}
function CSSStyleSheet(href) {
  this.href = href;
  this.cssRules = [];
  this.cssRules.item = function(index) { return this[index] || null; };
}
CSSStyleSheet.prototype.insertRule = function(text, index) {
  index = index === undefined ? 0 : Number(index);
  if (index < 0 || index > this.cssRules.length) throw new RangeError('invalid CSS rule index');
  var rule = /@font-face/i.test(text) ? new CSSFontFaceRule(String(text)) : { cssText: String(text), type: 1 };
  rule.parentStyleSheet = this;
  this.cssRules.splice(index, 0, rule);
  if (globalThis.PMJS && PMJS.fonts) PMJS.fonts.registerFontFaceRule(String(text), this.href);
  return index;
};
CSSStyleSheet.prototype.deleteRule = function(index) {
  if (index < 0 || index >= this.cssRules.length) throw new RangeError('invalid CSS rule index');
  this.cssRules.splice(index, 1);
};
globalThis.CSSFontFaceRule = CSSFontFaceRule;
globalThis.CSSStyleSheet = CSSStyleSheet;
var registeredStyleSheets = [];
Object.defineProperty(documentTarget, 'styleSheets', { get: function() {
  var sheets = registeredStyleSheets.slice();
  this.documentElement.getElementsByTagName('style').forEach(function(element) {
    if (sheets.indexOf(element.sheet) < 0) sheets.push(element.sheet);
  });
  sheets.item = function(index) { return this[index] || null; };
  return sheets;
} });
PMJS.web.registerStylesheet = function(text, href) {
  var sheet = registeredStyleSheets.find(function(item) { return item.href === href; });
  if (!sheet) { sheet = new CSSStyleSheet(href); registeredStyleSheets.push(sheet); }
  sheet.cssRules.length = 0;
  var rules = String(text).match(/@font-face\s*\{[^}]+\}/gi) || [];
  rules.forEach(function(rule) { sheet.insertRule(rule, sheet.cssRules.length); });
};
globalThis.getComputedStyle = function(element) {
  if (!(element instanceof Element)) throw new TypeError('getComputedStyle requires an Element');
  var computed = new CSSStyleDeclaration();
  computed.display = 'block'; computed.position = 'static';
  computed.transform = 'none'; computed.transformOrigin = '0px 0px'; computed.opacity = '1';
  ['color', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle'].forEach(function(name) {
    for (var node = element; node && node.style; node = node.parentNode) {
      if (node.style[name]) { computed[name] = node.style[name]; break; }
    }
  });
  Object.assign(computed, element.style);
  if (computed.color) {
    var color = parseCanvasColor(computed.color);
    if (color !== null) {
      var rgba = colorToRgba(computed.color);
      var bytes = [rgba >>> 24, rgba >>> 16 & 255, rgba >>> 8 & 255, rgba & 255];
      computed.color = bytes[3] === 255 ? 'rgb(' + bytes.slice(0, 3).join(', ') + ')' :
        'rgba(' + bytes.slice(0, 3).join(', ') + ', ' + bytes[3] / 255 + ')';
    }
  }
  return computed;
};

globalThis.HTMLCanvasElement = CanvasElement;
globalThis.HTMLImageElement = NativeImage;
globalThis.HTMLVideoElement = VideoElement;
globalThis.Image = NativeImage;
globalThis.CanvasRenderingContext2D = CanvasContext2D;
globalThis.addEventListener = EventTarget.prototype.addEventListener.bind(documentTarget);
globalThis.removeEventListener = EventTarget.prototype.removeEventListener.bind(documentTarget);
globalThis.dispatchEvent = EventTarget.prototype.dispatchEvent.bind(documentTarget);
['gamepadconnected', 'gamepaddisconnected'].forEach(function(type) {
  Object.defineProperty(globalThis, 'on' + type, {
    configurable: true,
    get: function() { return documentTarget['on' + type]; },
    set: function(listener) { documentTarget['on' + type] = listener; }
  });
  EventTarget.defineEventHandlerProperty(documentTarget, type);
});

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
  if (NativeHost.input && NativeHost.input.setTextInput) NativeHost.input.setTextInput(this instanceof InputElement && this.type === 'text');
  this.dispatchEvent({ type: 'focus', target: this });
};
GenericElement.prototype.blur = function() {
  if (documentTarget.activeElement !== this) return;
  documentTarget.activeElement = documentTarget.body;
  if (NativeHost.input && NativeHost.input.setTextInput) NativeHost.input.setTextInput(false);
  this.dispatchEvent({ type: 'blur', target: this });
};
documentTarget.activeElement = documentTarget.body;

['requestFullscreen', 'requestFullScreen', 'webkitRequestFullscreen',
  'webkitRequestFullScreen', 'mozRequestFullScreen', 'msRequestFullscreen',
  'focus', 'blur'].forEach(function(name) {
  CanvasElement.prototype[name] = GenericElement.prototype[name];
});
