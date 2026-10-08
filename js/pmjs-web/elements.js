function ImageData(data, width, height) {
  if (typeof data === 'number') {
    height = width;
    width = data;
    data = new Uint8ClampedArray(width * height * 4);
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

function CanvasElement() {
  EventTarget.call(this);
  this._width = 300;
  this._height = 150;
  this.__pmjsContentRevision = 0;
  this.style = {};
  this.screencanvas = false;
  this._context2d = null;
  this._nativeCanvas = null;
}

CanvasElement.prototype = Object.create(EventTarget.prototype);
CanvasElement.prototype.constructor = CanvasElement;
CanvasElement.prototype._pmjsContentChanged = function() {
  this.__pmjsContentRevision++;
};
function isCanvasDiagnosticsEnabled() {
  return typeof NativeHost !== 'undefined' &&
    NativeHost.runtime &&
    typeof NativeHost.runtime.env === 'function' &&
    NativeHost.runtime.env('PMJS_CANVAS_DIAG') === '1';
}

function logCanvasCreation(width, height, url) {
  var bytes = width * height * 4;
  var tag = url ? (' url=' + url) : '';
  console.log('[pmjs-canvas-diag] create ' + width + 'x' + height +
    ' (' + (bytes / 1024).toFixed(1) + ' KB)' + tag);
}

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
      NativeHost.canvas.create(width, height),
      'canvas');
    if (isCanvasDiagnosticsEnabled()) {
      logCanvasCreation(width, height, this._pmjsBitmapUrl);
    }
  }
  return this._nativeCanvas;
};
Object.defineProperty(CanvasElement.prototype, 'width', {
  get: function() { return this._width; },
  set: function(value) {
    this._width = Math.max(0, Number(value) | 0);
    this._releaseNativeCanvas();
    if (this._context2d) resetCanvasContextState(this._context2d);
  }
});
Object.defineProperty(CanvasElement.prototype, 'height', {
  get: function() { return this._height; },
  set: function(value) {
    this._height = Math.max(0, Number(value) | 0);
    this._releaseNativeCanvas();
    if (this._context2d) resetCanvasContextState(this._context2d);
  }
});
CanvasElement.prototype.getContext = function(type) {
  if (type === '2d') {
    if (!this._context2d) this._context2d = new CanvasContext2D(this);
    return this._context2d;
  }
  return null;
};
CanvasElement.prototype.toDataURL = function() {
  return 'data:image/png;base64,' +
    base64Bytes(NativeHost.canvas.encodePng(this._ensureNativeCanvas().handle));
};
CanvasElement.prototype.getBoundingClientRect = function() {
  return this._pmjsPresentationRect || { left: 0, top: 0, width: this.width, height: this.height };
};

Object.defineProperties(CanvasElement.prototype, {
  offsetLeft: { get: function() { return this.getBoundingClientRect().left; } },
  offsetTop: { get: function() { return this.getBoundingClientRect().top; } }
});

function GenericElement(tagName) {
  EventTarget.call(this);
  this.tagName = String(tagName).toUpperCase();
  this.style = {};
  this.children = [];
  this.parentNode = null;
}

GenericElement.prototype = Object.create(EventTarget.prototype);
GenericElement.prototype.constructor = GenericElement;
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
GenericElement.prototype.removeChild = function(child) {
  var index = this.children.indexOf(child);
  if (index >= 0) this.children.splice(index, 1);
  child.parentNode = null;
  return child;
};
GenericElement.prototype.setAttribute = function(name, value) { this[name] = String(value); };
GenericElement.prototype.getAttribute = function(name) { return this[name] || null; };
GenericElement.prototype.removeAttribute = function(name) {
  name = String(name);
  if (Object.prototype.hasOwnProperty.call(this, name)) {
    delete this[name];
    return;
  }
  var descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), name);
  if (descriptor && descriptor.set) this[name] = '';
};
GenericElement.prototype.getElementsByTagName = function() { return []; };

function escapeElementText(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
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
      this.children.forEach(function(child) { child.parentNode = null; });
      this.children = [];
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
  this.src = '';
  this.type = '';
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
      var text = new GenericElement('#text');
      text.textContent = value === null ? '' : String(value);
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
