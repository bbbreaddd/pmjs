function ImageData(data, width, height) {
  if (arguments.length < 2) throw new TypeError('ImageData requires two arguments');
  var suppliedPixels = data instanceof Uint8ClampedArray;
  if (!suppliedPixels) {
    height = +width >>> 0;
    width = +data >>> 0;
    if (!width || !height) throw canvasIndexSizeError('ImageData dimensions must be nonzero');
    data = new Uint8ClampedArray(width * height * 4);
  } else {
    width = +width >>> 0;
    if (!width || !data.length || data.length % (width * 4)) {
      throw canvasIndexSizeError('ImageData data does not form complete rows');
    }
    var inferredHeight = data.length / (width * 4);
    height = height === undefined ? inferredHeight : +height >>> 0;
    if (!height || height !== inferredHeight) throw canvasIndexSizeError('ImageData height does not match data');
  }
  if (!(data instanceof Uint8ClampedArray) || width <= 0 || height <= 0 ||
      data.length !== width * height * 4) {
    throw new TypeError('invalid ImageData constructor arguments');
  }
  this.data = data;
  this.width = width;
  this.height = height;
}
globalThis.ImageData = ImageData;

function base64Bytes(bytes) {
  var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var encoded = '';
  for (var index = 0; index < bytes.length; index += 3) {
    var first = bytes[index];
    var second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    var third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    encoded += alphabet[first >> 2];
    encoded += alphabet[(first & 3) << 4 | second >> 4];
    encoded += index + 1 < bytes.length ?
      alphabet[(second & 15) << 2 | third >> 6] : '=';
    encoded += index + 2 < bytes.length ? alphabet[third & 63] : '=';
  }
  return encoded;
}

function CSSStyleDeclaration() {}
function cssPropertyName(name) {
  return String(name).replace(/-([a-z])/g, function(_, letter) { return letter.toUpperCase(); });
}
CSSStyleDeclaration.prototype.setProperty = function(name, value) {
  this[cssPropertyName(name)] = String(value);
};
CSSStyleDeclaration.prototype.getPropertyValue = function(name) {
  var value = this[cssPropertyName(name)];
  return value === undefined ? '' : String(value);
};
CSSStyleDeclaration.prototype.removeProperty = function(name) {
  var previous = this.getPropertyValue(name);
  delete this[cssPropertyName(name)];
  return previous;
};
Object.defineProperty(CSSStyleDeclaration.prototype, 'cssText', {
  get: function() {
    return Object.keys(this).map(function(name) {
      return name.replace(/[A-Z]/g, function(letter) { return '-' + letter.toLowerCase(); }) + ': ' + this[name] + ';';
    }, this).join(' ');
  },
  set: function(text) {
    Object.keys(this).forEach(function(name) { delete this[name]; }, this);
    String(text).split(';').forEach(function(declaration) {
      var colon = declaration.indexOf(':');
      if (colon > 0) this.setProperty(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
    }, this);
  }
});
['transform', 'transformOrigin', 'perspective', 'perspectiveOrigin', 'opacity', 'visibility',
  'display', 'position', 'left', 'top', 'right', 'bottom', 'width', 'height', 'maxWidth', 'maxHeight',
  'color', 'backgroundColor', 'fontSize', 'fontFamily', 'fontWeight', 'fontStyle', 'lineHeight',
  'padding', 'margin', 'border', 'zIndex', 'overflow', 'filter', 'imageRendering', 'src'].forEach(function(name) {
  Object.defineProperty(CSSStyleDeclaration.prototype, name, { value: '', writable: true, configurable: true });
});
globalThis.CSSStyleDeclaration = CSSStyleDeclaration;

function Node() { EventTarget.call(this); this.children = []; this.parentNode = null; }
Node.prototype = Object.create(EventTarget.prototype);
Node.prototype.constructor = Node;
function Element() { Node.call(this); }
Element.prototype = Object.create(Node.prototype);
Element.prototype.constructor = Element;
function HTMLElement(tagName) {
  Element.call(this);
  this.tagName = String(tagName).toUpperCase();
  this.nodeType = 1;
  this.style = new CSSStyleDeclaration();
}
HTMLElement.prototype = Object.create(Element.prototype);
HTMLElement.prototype.constructor = HTMLElement;
globalThis.Node = Node;
globalThis.Element = Element;
globalThis.HTMLElement = HTMLElement;

function GenericElement(tagName) {
  HTMLElement.call(this, tagName);
  this._attributes = Object.create(null);
}
GenericElement.prototype = Object.create(HTMLElement.prototype);
GenericElement.prototype.constructor = GenericElement;

function CanvasElement() {
  GenericElement.call(this, 'canvas');
  this._width = 300;
  this._height = 150;
  this.__pmjsContentRevision = 0;
  this.screencanvas = false;
  this._context2d = null;
  this._nativeCanvas = null;
}

CanvasElement.prototype = Object.create(GenericElement.prototype);
CanvasElement.prototype.constructor = CanvasElement;
CanvasElement.prototype._pmjsContentChanged = function() {
  this.__pmjsContentRevision++;
};


CanvasElement.prototype._releaseNativeCanvas = function() {
  if (this._pmjsPrimitiveContent) this._pmjsPrimitiveContent.reset();
  releaseNativeResource(this._nativeCanvas, 'canvas');
  this._nativeCanvas = null;
  this._pmjsContentChanged();
};
CanvasElement.prototype._ensureNativeCanvas = function() {
  if (this._pmjsPrimitiveContent) this._pmjsPrimitiveContent.materialize();
  if (!this._nativeCanvas) {
    var width = Math.max(1, this.width);
    var height = Math.max(1, this.height);
    this._nativeCanvas = trackNativeResource(
      NativeHost.canvas.create(width, height, !!(this._context2d && this._context2d._alpha === false)),
      'canvas');
  }
  return this._nativeCanvas;
};
function reflectedNonNegativeInteger(value, fallback) {
  var match = value === null ? null : String(value).match(/^[\t\n\f\r ]*\+?(\d+)/);
  var result = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(result) && result <= 2147483647 ? result : fallback;
}
['width', 'height'].forEach(function(name) {
  Object.defineProperty(CanvasElement.prototype, name, {
    configurable: true,
    get: function() { return this['_' + name]; },
    set: function(value) {
      var attribute = String(Number(value) >>> 0);
      this._attributes[name] = attribute;
      CanvasElement.prototype._attributeChanged.call(this, name, attribute);
    }
  });
});
CanvasElement.prototype._attributeChanged = function(name, value) {
  if (name !== 'width' && name !== 'height') return;
  this['_' + name] = reflectedNonNegativeInteger(value, name === 'width' ? 300 : 150);
  this._releaseNativeCanvas();
  if (this._context2d) resetCanvasContextState(this._context2d);
};
CanvasElement.prototype.getContext = function(type, options) {
  if (type === '2d') {
    if (!this._context2d) {
      this._context2d = new CanvasContext2D(this);
      this._context2d._alpha = !options || options.alpha === undefined || !!options.alpha;
    }
    return this._context2d;
  }
  return null;
};
CanvasElement.prototype.toDataURL = function(type, quality) {
  if (!this.width || !this.height) return 'data:,';
  type = type === undefined ? 'image/png' : String(type).toLowerCase();
  var handle = this._ensureNativeCanvas().handle;
  var suppliedQuality = typeof quality === 'number' && quality >= 0 && quality <= 1;
  var bytes;
  if (type === 'image/jpeg') bytes = NativeHost.canvas.encodeJpeg(handle, suppliedQuality ? quality : 0.92);
  else if (type === 'image/webp') bytes = NativeHost.canvas.encodeWebP(handle, suppliedQuality ? quality : 0.8);
  else { type = 'image/png'; bytes = NativeHost.canvas.encodePng(handle); }
  return 'data:' + type + ';base64,' + base64Bytes(bytes);
};
CanvasElement.prototype.getBoundingClientRect = function() {
  if (this._pmjsNativePresentation && NativeHost.render && NativeHost.render.presentation) {
    var geometry = NativeHost.render.presentation();
    var size = NativeHost.runtime.windowSize();
    var ratioX = geometry.drawableWidth / size.width, ratioY = geometry.drawableHeight / size.height;
    return { left: geometry.viewportX / ratioX, top: geometry.viewportY / ratioY,
      width: geometry.viewportWidth / ratioX, height: geometry.viewportHeight / ratioY };
  }
  return this._pmjsPresentationRect || { left: 0, top: 0, width: this.width, height: this.height };
};

Object.defineProperties(CanvasElement.prototype, {
  offsetLeft: { get: function() { return this.getBoundingClientRect().left; } },
  offsetTop: { get: function() { return this.getBoundingClientRect().top; } }
});

GenericElement.prototype.appendChild = function(child) {
  for (var ancestor = this; ancestor; ancestor = ancestor.parentNode) {
    if (ancestor === child) throw new Error('Cannot append an ancestor');
  }
  if (child.parentNode) child.parentNode.removeChild(child);
  child.parentNode = this;
  this.children.push(child);
  if (this instanceof ScriptElement) this._prepare();
  prepareConnectedScripts(child);
  return child;
};
function removeElementChild(parent, child) {
  if (parent.children.indexOf(child) < 0) throw new Error('The node is not a child of this element');
  if (typeof documentTarget !== 'undefined' && child.contains(documentTarget.activeElement)) {
    documentTarget.activeElement.blur();
  }
  var index = parent.children.indexOf(child);
  if (index >= 0) {
    parent.children.splice(index, 1);
    child.parentNode = null;
  }
  return child;
}
GenericElement.prototype.removeChild = function(child) { return removeElementChild(this, child); };
['id', 'title', 'src', 'type'].forEach(function(name) {
  Object.defineProperty(GenericElement.prototype, name, {
    configurable: true,
    get: function() { return this.getAttribute(name) || ''; },
    set: function(value) { this._attributes[name] = String(value); }
  });
});
Object.defineProperty(GenericElement.prototype, 'className', {
  configurable: true,
  get: function() { return this.getAttribute('class') || ''; },
  set: function(value) { this._attributes.class = String(value); }
});
GenericElement.prototype.setAttribute = function(name, value) {
  name = String(name).toLowerCase();
  value = String(value);
  this._attributes[name] = value;
  if (this._attributeChanged) this._attributeChanged(name, value);
};
GenericElement.prototype.getAttribute = function(name) {
  name = String(name).toLowerCase();
  return Object.prototype.hasOwnProperty.call(this._attributes, name) ? this._attributes[name] : null;
};
GenericElement.prototype.hasAttribute = function(name) { return this.getAttribute(name) !== null; };
GenericElement.prototype.removeAttribute = function(name) {
  name = String(name).toLowerCase();
  if (!this.hasAttribute(name)) return;
  delete this._attributes[name];
  if (this._attributeChanged) this._attributeChanged(name, null);
};
GenericElement.prototype.remove = function() {
  if (this.parentNode) this.parentNode.removeChild(this);
};
GenericElement.prototype.contains = function(node) {
  for (; node; node = node.parentNode) if (node === this) return true;
  return false;
};
Node.prototype.contains = GenericElement.prototype.contains;
Node.prototype.removeChild = GenericElement.prototype.removeChild;
Node.prototype.remove = GenericElement.prototype.remove;
Object.defineProperty(GenericElement.prototype, 'isConnected', {
  get: function() { return typeof documentTarget !== 'undefined' && documentTarget.documentElement.contains(this); }
});
GenericElement.prototype.getElementsByTagName = function(tagName) {
  var name = String(tagName).toUpperCase(), results = [];
  function visit(node) {
    (node.children || []).forEach(function(child) {
      if (child.nodeType === 1 && (name === '*' || child.tagName === name)) results.push(child);
      visit(child);
    });
  }
  visit(this);
  results.item = function(index) { return this[index] || null; };
  return results;
};
GenericElement.prototype.getBoundingClientRect = function() {
  var left = parseFloat(this.style.left) || 0, top = parseFloat(this.style.top) || 0;
  var width = parseFloat(this.style.width) || 0, height = parseFloat(this.style.height) || 0;
  return { x: left, y: top, left: left, top: top, width: width, height: height,
    right: left + width, bottom: top + height };
};

function escapeElementText(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function TextNode(text) {
  Node.call(this);
  this.nodeType = 3;
  this.textContent = String(text);
}
TextNode.prototype = Object.create(Node.prototype);
TextNode.prototype.constructor = TextNode;
Object.defineProperty(TextNode.prototype, 'outerHTML', {
  get: function() { return escapeElementText(this.textContent); }
});
globalThis.Text = TextNode;
Object.defineProperties(GenericElement.prototype, {
  textContent: {
    configurable: true,
    get: function() {
      var text = this._innerHTML === undefined ? this._textContent || '' :
        this._innerHTML.replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, function(_, entity) {
          if (entity[0] === '#') return String.fromCodePoint(parseInt(entity.slice(entity[1].toLowerCase() === 'x' ? 2 : 1), entity[1].toLowerCase() === 'x' ? 16 : 10));
          return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity.toLowerCase()];
        });
      return text + this.children.map(function(child) { return child.textContent || ''; }).join('');
    },
    set: function(value) {
      while (this.children.length) removeElementChild(this, this.children[0]);
      this._innerHTML = undefined;
      this._textContent = value === null ? '' : String(value);
    }
  },
  innerHTML: {
    configurable: true,
    get: function() {
      return (this._innerHTML === undefined ? escapeElementText(this._textContent || '') : this._innerHTML) +
        this.children.map(function(child) { return child.outerHTML || ''; }).join('');
    },
    set: function(value) {
      this.textContent = '';
      this._innerHTML = value === null ? '' : String(value);
    }
  },
  outerHTML: {
    get: function() {
      if (this.tagName === '#TEXT') return escapeElementText(this.textContent);
      var tag = this.tagName.toLowerCase();
      return '<' + tag + (this.id ? ' id="' + escapeElementText(this.id).replace(/"/g, '&quot;') + '"' : '') +
        '>' + this.innerHTML + '</' + tag + '>';
    }
  }
});

function prepareConnectedScripts(node) {
  if (node instanceof ScriptElement) node._prepare();
  (node.children || []).slice().forEach(prepareConnectedScripts);
}

function ScriptElement() {
  GenericElement.call(this, 'script');
  this._started = false;
}
ScriptElement.prototype = Object.create(GenericElement.prototype);
ScriptElement.prototype.constructor = ScriptElement;
ScriptElement.prototype._prepare = function() {
  if (this._started || this.src) return;
  var root = this;
  while (root.parentNode) root = root.parentNode;
  if (root !== documentTarget) return;
  var type = String(this.type || '').trim().toLowerCase();
  if (type && type !== 'text/javascript' && type !== 'application/javascript') return;
  if (!this.textContent) return;
  this._started = true;
  var script = this;
  try { pmjsExecuteScriptElement(script); }
  catch (error) { pmjsReportEventError(error); }
};
Object.defineProperties(ScriptElement.prototype, {
  textContent: {
    configurable: true,
    get: function() {
      return this.children.map(function(child) { return child.textContent || ''; }).join('');
    },
    set: function(value) {
      this.children.forEach(function(child) { child.parentNode = null; });
      var text = new TextNode(value === null ? '' : String(value));
      text.parentNode = this;
      this.children = [text];
      this._prepare();
    }
  },
  text: {
    configurable: true,
    get: function() { return this.textContent; },
    set: function(value) { this.textContent = value; }
  }
});

function AudioElement() {
  GenericElement.call(this, 'audio');
}

AudioElement.prototype = Object.create(GenericElement.prototype);
AudioElement.prototype.constructor = AudioElement;
AudioElement.prototype.canPlayType = function(type) {
  return /^audio\//.test(String(type)) ? 'maybe' : '';
};

function InputElement() {
  GenericElement.call(this, 'input');
  this._value = '';
  this.selectionStart = this.selectionEnd = 0;
}
InputElement.prototype = Object.create(GenericElement.prototype);
InputElement.prototype.constructor = InputElement;
InputElement.prototype._attributeChanged = function(name, value) {
  if (name === 'value' && value !== null) this.value = value;
};
Object.defineProperty(InputElement.prototype, 'value', {
  get: function() { return this._value; },
  set: function(value) {
    this._value = String(value);
    this.selectionStart = this.selectionEnd = this._value.length;
  }
});
['disabled', 'readOnly'].forEach(function(property) {
  var name = property.toLowerCase();
  Object.defineProperty(InputElement.prototype, property, {
    configurable: true,
    get: function() { return this.hasAttribute(name); },
    set: function(value) { if (value) this._attributes[name] = ''; else delete this._attributes[name]; }
  });
});
Object.defineProperty(InputElement.prototype, 'type', {
  configurable: true,
  get: function() { return this.getAttribute('type') || 'text'; },
  set: function(value) { this._attributes.type = String(value); }
});
Object.defineProperty(InputElement.prototype, 'maxLength', {
  configurable: true,
  get: function() { return reflectedNonNegativeInteger(this.getAttribute('maxlength'), -1); },
  set: function(value) {
    value = Number(value) | 0;
    if (value < 0) throw new RangeError('maxLength must be nonnegative');
    this._attributes.maxlength = String(value);
  }
});
InputElement.prototype.setSelectionRange = function(start, end) {
  this.selectionEnd = Math.max(0, Math.min(this.value.length, Number(end) || 0));
  this.selectionStart = Math.max(0, Math.min(this.selectionEnd, Number(start) || 0));
};
InputElement.prototype._insertText = function(text) {
  if (this.disabled || this.readOnly || this.type !== 'text') return;
  var start = this.selectionStart, end = this.selectionEnd;
  text = String(text);
  if (this.maxLength >= 0) text = text.slice(0, Math.max(0, this.maxLength - this.value.length + end - start));
  if (!text && start === end) return;
  this._value = this.value.slice(0, start) + text + this.value.slice(end);
  this.selectionStart = this.selectionEnd = start + text.length;
  this.dispatchEvent({ type: 'input', target: this });
};
InputElement.prototype._editKey = function(event) {
  var start = this.selectionStart, end = this.selectionEnd;
  if (event.keyCode === 8 || event.keyCode === 46) {
    if (start === end) {
      if (event.keyCode === 8) start = Math.max(0, start - 1);
      else end = Math.min(this.value.length, end + 1);
      // Keep UTF-16 surrogate pairs intact when deleting a character.
      if (start > 0 && /[\uDC00-\uDFFF]/.test(this.value[start])) start--;
      if (end < this.value.length && /[\uDC00-\uDFFF]/.test(this.value[end])) end++;
    }
    this.setSelectionRange(start, end); this._insertText('');
  } else if (event.keyCode === 36) this.setSelectionRange(0, 0);
  else if (event.keyCode === 35) this.setSelectionRange(this.value.length, this.value.length);
  else if (event.keyCode === 37) this.setSelectionRange(Math.max(0, start - 1), Math.max(0, start - 1));
  else if (event.keyCode === 39) this.setSelectionRange(Math.min(this.value.length, end + 1), Math.min(this.value.length, end + 1));
  else if ((event.ctrlKey || event.metaKey) && event.keyCode === 65) this.setSelectionRange(0, this.value.length);
};
globalThis.HTMLInputElement = InputElement;
