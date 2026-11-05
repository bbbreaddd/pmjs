function CanvasContext2D(canvas) {
  this.canvas = canvas;
  // Reserve double storage before the integer default so fractional opacity
  // does not invalidate context layout checks embedded by V8.
  this._globalAlpha = NaN;
  resetCanvasContextState(this);
}

function resetCanvasContextState(context) {
  context._fillStyle = '#000000';
  context._strokeStyle = '#000000';
  context._globalAlpha = 1;
  context._compositeOperation = 'source-over';
  context._font = '10px sans-serif';
  context.textAlign = 'start';
  context.textBaseline = 'alphabetic';
  context._lineWidth = 1;
  context._lineCap = 'butt';
  context._lineJoin = 'miter';
  context._miterLimit = 10;
  context._imageSmoothingEnabled = true;
  context._lineDashOffset = 0;
  context._shadowColor = 'rgba(0, 0, 0, 0)';
  context._shadowBlur = 0;
  context._shadowOffsetX = 0;
  context._shadowOffsetY = 0;
  context._transform = [1, 0, 0, 1, 0, 0];
  context._stateStack = [];
  context._circlePath = null;
  context._pendingArc = null;
  context._path = [];
  context._subpath = null;
  context._currentPathPoint = null;
  context._clipPaths = [];
  context._lineDash = [];
}
function canvasTransformInvertible(context) {
  var t = context._transform;
  var determinant = t[0] * t[3] - t[1] * t[2];
  return Number.isFinite(determinant) && determinant !== 0;
}
function canvasIndexSizeError(message) {
  if (typeof DOMException === 'function') return new DOMException(message, 'IndexSizeError');
  var error = new Error(message); error.name = 'IndexSizeError'; error.code = 1; return error;
}

['lineDashOffset', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY'].forEach(function(name) {
  Object.defineProperty(CanvasContext2D.prototype, name, {
    get: function() { return this['_' + name]; },
    set: function(value) {
      value = +value;
      if (Number.isFinite(value) && (name !== 'shadowBlur' || value >= 0)) this['_' + name] = value;
    }
  });
});
Object.defineProperty(CanvasContext2D.prototype, 'shadowColor', {
  get: function() { return this._shadowColor; },
  set: function(value) { var color = canvasSerializedColor(value); if (color !== null) this._shadowColor = color; }
});
CanvasContext2D.prototype.setLineDash = function(segments) {
  if (!segments || typeof segments[Symbol.iterator] !== 'function') throw new TypeError('line dash must be iterable');
  var dash = Array.from(segments, function(value) { return +value; });
  if (!dash.every(function(value) { return Number.isFinite(value) && value >= 0; })) return;
  this._lineDash = dash.length % 2 ? dash.concat(dash) : dash;
};
CanvasContext2D.prototype.getLineDash = function() { return this._lineDash.slice(); };

function canvasPathCommands(paths) {
  if (!paths.some(function(path) { return path.commands; })) return [];
  var commands = [];
  paths.forEach(function(path) {
    if (path.commands) commands = commands.concat(path.commands);
    else {
      path.forEach(function(point, index) { commands.push(index ? 1 : 0, point[0], point[1]); });
      if (path.closed) commands.push(4);
    }
  });
  return commands;
}
function canvasPathBounds(path, point) {
  if (!path.bounds) path.bounds = [point.slice(), point.slice()];
  for (var axis = 0; axis < 2; axis++) {
    path.bounds[0][axis] = Math.min(path.bounds[0][axis], point[axis]);
    path.bounds[1][axis] = Math.max(path.bounds[1][axis], point[axis]);
  }
}
function canvasFlattenCurve(points, path) {
  var remaining = 8192;
  function flatten(curve, depth) {
    var first = curve[0], last = curve[curve.length - 1];
    var dx = last[0] - first[0], dy = last[1] - first[1], length = Math.hypot(dx, dy);
    var flat = curve.slice(1, -1).every(function(control) {
      return length ? Math.abs(dx * (control[1] - first[1]) - dy * (control[0] - first[0])) <= length * 0.01 :
        Math.hypot(control[0] - first[0], control[1] - first[1]) <= 0.01;
    });
    if (flat || depth >= 16 || remaining <= 1) { path.push(last); remaining--; return; }
    var left = [first], right = [last], row = curve;
    while (row.length > 1) {
      row = row.slice(1).map(function(point, index) { return [(row[index][0] + point[0]) / 2, (row[index][1] + point[1]) / 2]; });
      left.push(row[0]); right.unshift(row[row.length - 1]);
    }
    flatten(left, depth + 1); flatten(right, depth + 1);
  }
  flatten(points, 0);
}
function canvasFlattenPath(path) {
  if (!path.needsFlatten) return;
  var points = [], commands = path.commands;
  for (var i = 0; i < commands.length;) {
    var verb = commands[i++];
    if (verb === 4) points.push(points[0].slice());
    else if (verb === 5) {
      var x = commands[i++], y = commands[i++], radius = commands[i++];
      var start = commands[i++], sweep = commands[i++], t = commands.slice(i, i + 6); i += 6;
      var extent = radius * (Math.hypot(t[0], t[1]) + Math.hypot(t[2], t[3]));
      var segments = Math.min(8192, Math.max(16, Math.ceil(Math.abs(sweep) * Math.sqrt(extent * 2))));
      for (var index = 0; index <= segments; index++) {
        var angle = start + sweep * index / segments;
        var px = x + Math.cos(angle) * radius, py = y + Math.sin(angle) * radius;
        var point = [t[0] * px + t[2] * py + t[4], t[1] * px + t[3] * py + t[5]];
        if (index || !points.length || point[0] !== points[points.length - 1][0] || point[1] !== points[points.length - 1][1]) points.push(point);
      }
    } else if (verb === 2 || verb === 3) {
      var curve = [points[points.length - 1]];
      for (var end = i + (verb === 3 ? 6 : 4); i < end; i += 2) curve.push([commands[i], commands[i + 1]]);
      canvasFlattenCurve(curve, points);
    } else {
      points.push([commands[i], commands[i + 1]]); i += 2;
    }
  }
  path.length = 0;
  for (var index = 0; index < points.length; index++) path.push(points[index]);
  path.needsFlatten = false;
}
function canvasCurve(context, values, cubic) {
  if (values.length < (cubic ? 6 : 4)) throw new TypeError('not enough curve arguments');
  values = values.map(function(value) { return Math.fround(+value); });
  if (!values.every(Number.isFinite) || !canvasTransformInvertible(context)) return;
  materializeCanvasArc(context); context._circlePath = null;
  if (!context._subpath) context.moveTo(values[0], values[1]);
  if (context._subpath.closed) {
    context._subpath = [context._subpath[0].slice()]; context._path.push(context._subpath);
  }
  var path = context._subpath;
  if (!path.commands) {
    path.commands = [];
    path.forEach(function(point, index) { path.commands.push(index ? 1 : 0, point[0], point[1]); });
  }
  var points = [context._currentPathPoint.slice()], command = [cubic ? 3 : 2];
  for (var i = 0; i < values.length; i += 2) {
    var point = transformedPoint(context, values[i], values[i + 1]);
    points.push(point); command.push(point[0], point[1]);
  }
  path.commands.push.apply(path.commands, command);
  points.forEach(function(point) { canvasPathBounds(path, point); });
  path.needsFlatten = true;
  path.push(points[points.length - 1]);
  context._currentPathPoint = points[points.length - 1].slice();
}
CanvasContext2D.prototype.quadraticCurveTo = function(cpx, cpy, x, y) {
  canvasCurve(this, Array.prototype.slice.call(arguments, 0, 4), false);
};
CanvasContext2D.prototype.bezierCurveTo = function(cp1x, cp1y, cp2x, cp2y, x, y) {
  canvasCurve(this, Array.prototype.slice.call(arguments, 0, 6), true);
};

function multiplyTransform(left, right) {
  return [left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5]];
}

function axisAlignedRect(context, x, y, width, height) {
  var t = context._transform;
  if (t[1] !== 0 || t[2] !== 0) return null;
  var x0 = t[0] * x + t[4];
  var y0 = t[3] * y + t[5];
  var x1 = t[0] * (x + width) + t[4];
  var y1 = t[3] * (y + height) + t[5];
  return { x: Math.min(x0, x1), y: Math.min(y0, y1),
    width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

function canvasSourceDimensions(source) {
  if (source && 'videoWidth' in source) return [Number(source.videoWidth), Number(source.videoHeight)];
  if (source && 'naturalWidth' in source) return [Number(source.naturalWidth), Number(source.naturalHeight)];
  return [Number(source.width) || 0, Number(source.height) || 0];
}
function canvasReferenceEngine() {
  return globalThis.PMJS_RUNTIME_ENGINE || (globalThis.PMJS_RUNTIME_GAME && PMJS_RUNTIME_GAME.engine);
}

function canvasSourcePixels(source, nativeSource, region) {
  var x = region ? region.x : 0;
  var y = region ? region.y : 0;
  var width = region ? region.width : source.width;
  var height = region ? region.height : source.height;
  if (source && source._nativeCanvas) {
    var canvasPixels = NativeHost.canvas.readPremultipliedPixels(nativeSource.handle, x, y, width, height);
    return canvasPixels;
  }
  var temporary = NativeHost.canvas.create(width, height);
  try {
    NativeHost.canvas.drawImage(temporary.handle, nativeSource.handle,
      x, y, width, height, 0, 0, width, height, 1);
    var imagePixels = NativeHost.canvas.readPremultipliedPixels(temporary.handle, 0, 0, width, height);
    return imagePixels;
  } finally {
    releaseNativeResource(temporary, 'canvas');
  }
}

var canvasFontValues = new Map();
function canvasFontValue(value) {
  if (value.length > 256) return parseCanvasFontValue(value);
  if (canvasFontValues.has(value)) return canvasFontValues.get(value);
  var result = parseCanvasFontValue(value);
  if (canvasFontValues.size >= 128) canvasFontValues.clear();
  canvasFontValues.set(value, result);
  return result;
}
function parseCanvasFontValue(value) {
  var match = /^\s*((?:(?:normal|italic|oblique|small-caps|bold|bolder|lighter|[1-9]00)\s+)*)(\d+(?:\.\d+)?|\.\d+)(px|pt|pc|in|cm|mm|em|rem|%)\s*(?:\/\s*(?:normal|\d+(?:\.\d+)?(?:px|pt|em|%)?)\s+)?(.+?)\s*$/i.exec(value);
  if (!match || !(Number(match[2]) > 0)) return null;
  var prefix = match[1].trim().split(/\s+/).filter(Boolean);
  var style = prefix.filter(function(token) { return /^(italic|oblique)$/i.test(token); });
  var weight = prefix.filter(function(token) { return /^(bold|bolder|lighter|[1-9]00)$/i.test(token); });
  if (style.length > 1 || weight.length > 1 || prefix.filter(function(token) { return token === 'small-caps'; }).length > 1) return null;
  var families = match[4].match(/"[^"\r\n]+"|'[^'\r\n]+'|[^,]+/g);
  if (!families || families.join(',').replace(/\s+/g, '') !== match[4].replace(/\s+/g, '')) return null;
  for (var i = 0; i < families.length; i++) {
    var family = families[i].trim();
    if (!/^(?:"[^"\r\n]+"|'[^'\r\n]+'|(?:--|-?[_a-zA-Z\u0080-\uffff])[-_a-zA-Z0-9\u0080-\uffff]*(?:\s+(?:--|-?[_a-zA-Z\u0080-\uffff])[-_a-zA-Z0-9\u0080-\uffff]*)*)$/.test(family)) return null;
    if (/^(inherit|initial|unset|revert|default)$/i.test(family)) return null;
  }
  var factors = { px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, em: 16, rem: 16, '%': 0.16 };
  var size = Number(match[2]) * factors[match[3].toLowerCase()];
  if (!Number.isFinite(size)) return null;
  var parts = prefix.filter(function(token) { return token !== 'normal'; });
  return parts.concat([size + 'px', families.map(function(family) { return family.trim(); }).join(', ')]).join(' ');
}
Object.defineProperty(CanvasContext2D.prototype, 'font', {
  get: function() { return this._font; },
  set: function(value) { var font = canvasFontValue(String(value)); if (font !== null) this._font = font; }
});

Object.defineProperty(CanvasContext2D.prototype, 'imageSmoothingEnabled', {
  get: function() { return this._imageSmoothingEnabled; },
  set: function(value) { this._imageSmoothingEnabled = !!value; }
});

Object.defineProperty(CanvasContext2D.prototype, 'globalAlpha', {
  get: function() { return this._globalAlpha; },
  set: function(value) {
    value = +value;
    if (Number.isFinite(value) && value >= 0 && value <= 1) this._globalAlpha = value;
  }
});

Object.defineProperty(CanvasContext2D.prototype, 'lineWidth', {
  get: function() { return this._lineWidth; },
  set: function(value) {
    value = +value;
    if (Number.isFinite(value) && value > 0) this._lineWidth = value;
  }
});

[['lineCap', ['butt', 'round', 'square']], ['lineJoin', ['miter', 'round', 'bevel']]].forEach(function(entry) {
  Object.defineProperty(CanvasContext2D.prototype, entry[0], {
    get: function() { return this['_' + entry[0]]; },
    set: function(value) {
      value = String(value);
      if (entry[1].indexOf(value) >= 0) this['_' + entry[0]] = value;
    }
  });
});
Object.defineProperty(CanvasContext2D.prototype, 'miterLimit', {
  get: function() { return this._miterLimit; },
  set: function(value) {
    value = +value;
    if (Number.isFinite(value) && value > 0) this._miterLimit = value;
  }
});
function canvasPaintEmpty(style) {
  return !!(style && style._pmjsStyle === 'linear-gradient' && style.x0 === style.x1 && style.y0 === style.y1);
}
function canvasImageSmoothing(context, sw, sh, dw, dh) {
  var t = context._transform;
  return context.imageSmoothingEnabled ||
    dw * dw * (t[0] * t[0] + t[1] * t[1]) < sw * sw &&
    dh * dh * (t[2] * t[2] + t[3] * t[3]) < sh * sh;
}
function nativeCanvasPath(context, paths, stroke, clear, rule) {
  return typeof NativeHost.canvas.paintPath === 'function' &&
    NativeHost.canvas.paintPath(context.canvas._ensureNativeCanvas().handle, {
      // Native coverage bounds must include the control hull before subdivision.
      paths: paths.map(function(path) { return path.bounds ? path.concat(path.bounds) : path; }),
      closed: paths.map(function(path) { return !!path.closed; }),
      commands: canvasPathCommands(paths), dash: stroke ? context._lineDash : [],
      dashOffset: context.lineDashOffset,
      transform: context._transform, paint: canvasNativePaint(clear ? '#00000000' :
        stroke ? context.strokeStyle : context.fillStyle, context),
      globalAlpha: context.globalAlpha, composite: context.globalCompositeOperation,
      clips: context._clipPaths, stroke: stroke ? context.lineWidth : 0,
      cap: ['butt', 'round', 'square'].indexOf(context.lineCap),
      join: ['miter', 'round', 'bevel'].indexOf(context.lineJoin),
      miterLimit: context.miterLimit, clear: !!clear, rule: rule || 'nonzero'
    });
}
var canvasCompositeOperations = [
  'source-over', 'source-in', 'source-out', 'source-atop', 'destination-over',
  'destination-in', 'destination-out', 'destination-atop', 'lighter', 'copy', 'xor',
  'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'
];
Object.defineProperty(CanvasContext2D.prototype, 'globalCompositeOperation', {
  get: function() { return this._compositeOperation || 'source-over'; },
  set: function(value) {
    value = String(value);
    if (canvasCompositeOperations.indexOf(value) >= 0) this._compositeOperation = value;
  }
});
function canvasCompositeRegion(context, left, top, right, bottom) {
  var operation = context.globalCompositeOperation;
  if (operation === 'copy' || operation === 'source-in' || operation === 'source-out' ||
      operation === 'destination-in' || operation === 'destination-atop') {
    return [0, 0, context.canvas.width, context.canvas.height];
  }
  return [left, top, right, bottom];
}
function canvasNativePaint(style, context) {
  if (style && style._pmjsStyle === 'pattern') {
    return { kind: 'pattern', width: style.width, height: style.height,
      repeat: style.repeat, pixels: style.pixels, smoothing: context ? context.imageSmoothingEnabled : true, transform: context ? multiplyTransform(context._transform, style.transform) : style.transform };
  }
  if (style && (style._pmjsStyle === 'linear-gradient' || style._pmjsStyle === 'radial-gradient')) {
    return { kind: style._pmjsStyle === 'linear-gradient' ? 'linear' : 'radial',
      geometry: [style.x0, style.y0, style.r0 || 0, style.x1, style.y1, style.r1 || 0],
      offsets: style.stops.map(function(stop) { return stop.offset; }),
      colors: style.stops.map(function(stop) { return colorToRgba(stop.color); }),
      transform: context ? context._transform : [1, 0, 0, 1, 0, 0] };
  }
  return { kind: 'solid', color: colorToRgba(style) };
}

function drawAffineImage(context, source, nativeSource, sx, sy, sw, sh,
    dx, dy, dw, dh, paintStyle, smoothing) {
  if (!sw || !sh || !dw || !dh || source.width <= 0 || source.height <= 0) return;
  var t = context._transform;
  var determinant = t[0] * t[3] - t[1] * t[2];
  if (!Number.isFinite(determinant) || determinant === 0) return;
  if (smoothing === undefined) smoothing = context.imageSmoothingEnabled;
  if (typeof NativeHost.canvas.drawAffineImage === 'function') {
    var target = context.canvas._ensureNativeCanvas();
    var descriptor = {
      geometry: [sx, sy, sw, sh, dx, dy, dw, dh], transform: t,
      globalAlpha: context.globalAlpha, smoothing: smoothing,
      composite: context.globalCompositeOperation, clips: context._clipPaths
    };
    if (paintStyle) descriptor.paint = canvasNativePaint(paintStyle, { _transform: context._paintTransform || t, imageSmoothingEnabled: context.imageSmoothingEnabled });
    NativeHost.canvas.drawAffineImage(target.handle, nativeSource.handle, descriptor);
    return;
  }
  var corners = [[dx, dy], [dx + dw, dy], [dx + dw, dy + dh], [dx, dy + dh]];
  for (var index = 0; index < corners.length; index++) {
    var point = corners[index], px = point[0], py = point[1];
    point[0] = t[0] * px + t[2] * py + t[4];
    point[1] = t[1] * px + t[3] * py + t[5];
  }
  var left = Math.max(0, Math.floor(Math.min.apply(null, corners.map(function(p) { return p[0]; }))));
  var top = Math.max(0, Math.floor(Math.min.apply(null, corners.map(function(p) { return p[1]; }))));
  var right = Math.min(context.canvas.width, Math.ceil(Math.max.apply(null, corners.map(function(p) { return p[0]; }))));
  var bottom = Math.min(context.canvas.height, Math.ceil(Math.max.apply(null, corners.map(function(p) { return p[1]; }))));
  var region = canvasCompositeRegion(context, left, top, right, bottom);
  left = region[0]; top = region[1]; right = region[2]; bottom = region[3];
  if (right <= left || bottom <= top) return;
  var sourceLeft = Math.max(0, Math.min(source.width - 1,
    Math.floor(Math.min(sx, sx + sw) - (smoothing ? 1 : 0))));
  var sourceTop = Math.max(0, Math.min(source.height - 1,
    Math.floor(Math.min(sy, sy + sh) - (smoothing ? 1 : 0))));
  var sourceRight = Math.max(sourceLeft + 1, Math.min(source.width,
    smoothing ? Math.ceil(Math.max(sx, sx + sw) + 1) :
      Math.floor(Math.max(sx, sx + sw)) + 1));
  var sourceBottom = Math.max(sourceTop + 1, Math.min(source.height,
    smoothing ? Math.ceil(Math.max(sy, sy + sh) + 1) :
      Math.floor(Math.max(sy, sy + sh)) + 1));
  var sourceWidth = sourceRight - sourceLeft;
  var sourcePixels = canvasSourcePixels(source, nativeSource, {
    x: sourceLeft, y: sourceTop, width: sourceWidth,
    height: sourceBottom - sourceTop
  });
  var destination = context.canvas._ensureNativeCanvas();
  var paintPixels = new Uint8Array((right - left) * (bottom - top) * 4);
  var clipMask = new Uint8Array((right - left) * (bottom - top));
  var inverseA = t[3] / determinant, inverseB = -t[1] / determinant;
  var inverseC = -t[2] / determinant, inverseD = t[0] / determinant;
  var alpha = Math.max(0, Math.min(1, Number(context.globalAlpha)));
  var axis = t[1] === 0 && t[2] === 0;
  var startX = Math.floor((sx + ((left + 0.5 - t[4]) / t[0] - dx) / dw * sw - 0.5) * 65536);
  var startY = Math.floor((sy + ((top + 0.5 - t[5]) / t[3] - dy) / dh * sh - 0.5) * 65536);
  var stepX = Math.trunc(sw / (dw * t[0]) * 65536), stepY = Math.trunc(sh / (dh * t[3]) * 65536);
  for (var y = top; y < bottom; y++) for (var x = left; x < right; x++) {
    var shiftedX = x + 0.5 - t[4], shiftedY = y + 0.5 - t[5];
    var localX = inverseA * shiftedX + inverseC * shiftedY;
    var localY = inverseB * shiftedX + inverseD * shiftedY;
    var u = (localX - dx) / dw, v = (localY - dy) / dh;
    if (!passesCanvasClip(context, x + 0.5, y + 0.5)) continue;
    var index = (y - top) * (right - left) + x - left;
    clipMask[index] = 255;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
    var sampleX = sx + u * sw, sampleY = sy + v * sh;
    if (smoothing) {
      sampleX = Math.max(0, Math.min(source.width - 1, axis ? (startX + (x - left) * stepX) / 65536 : sampleX - 0.5));
      sampleY = Math.max(0, Math.min(source.height - 1, axis ? (startY + (y - top) * stepY) / 65536 : sampleY - 0.5));
      var x0 = Math.floor(sampleX), y0 = Math.floor(sampleY);
      var x1 = Math.min(source.width - 1, x0 + 1), y1 = Math.min(source.height - 1, y0 + 1);
      // The low-quality raster filter uses four fractional bits.
      var fx = Math.floor((sampleX - x0) * 16 + 0.00001) / 16, fy = Math.floor((sampleY - y0) * 16 + 0.00001) / 16;
      var p00 = ((y0 - sourceTop) * sourceWidth + x0 - sourceLeft) * 4;
      var p10 = ((y0 - sourceTop) * sourceWidth + x1 - sourceLeft) * 4;
      var p01 = ((y1 - sourceTop) * sourceWidth + x0 - sourceLeft) * 4;
      var p11 = ((y1 - sourceTop) * sourceWidth + x1 - sourceLeft) * 4;
      for (var channel = 0; channel < 4; channel++) {
        paintPixels[index * 4 + channel] = Math.round(
          (sourcePixels[p00 + channel] * (1 - fx) + sourcePixels[p10 + channel] * fx) * (1 - fy) +
          (sourcePixels[p01 + channel] * (1 - fx) + sourcePixels[p11 + channel] * fx) * fy);
      }
    } else {
      sampleX = Math.max(0, Math.min(source.width - 1,
        Math.floor(axis ? (startX + (x - left) * stepX + 32768) / 65536 : sampleX)));
      sampleY = Math.max(0, Math.min(source.height - 1,
        Math.floor(axis ? (startY + (y - top) * stepY + 32768) / 65536 : sampleY)));
      var sourceOffset = ((sampleY - sourceTop) * sourceWidth + sampleX - sourceLeft) * 4;
      paintPixels.set(sourcePixels.subarray(sourceOffset, sourceOffset + 4), index * 4);
    }
  }
  if (paintStyle) {
    for (var py = top; py < bottom; py++) for (var px = left; px < right; px++) {
      var offset = ((py - top) * (right - left) + px - left) * 4;
      var coverage = paintPixels[offset + 3] / 255;
      var rgba = canvasStylePremultiplied(paintStyle, px + 0.5, py + 0.5, 1, context._paintTransform || t, context.imageSmoothingEnabled);
      for (var channel = 0; channel < 4; channel++)
        paintPixels[offset + channel] = Math.round(((rgba >>> ((3 - channel) * 8)) & 255) * coverage);
    }
  }
  NativeHost.canvas.compositePixels(destination.handle, left, top,
    right - left, bottom - top, paintPixels, clipMask, context.globalCompositeOperation, alpha);
}

function canvasPolygonCoverage(points, x, y) {
  var polygon = points;
  [[0, x, 1], [0, x + 1, -1], [1, y, 1], [1, y + 1, -1]].forEach(function(boundary) {
    var clipped = [], axis = boundary[0], limit = boundary[1], sign = boundary[2];
    for (var i = 0; i < polygon.length; i++) {
      var a = polygon[i], b = polygon[(i + 1) % polygon.length];
      var insideA = sign * (a[axis] - limit) >= 0, insideB = sign * (b[axis] - limit) >= 0;
      if (insideA) clipped.push(a);
      if (insideA !== insideB) {
        var amount = (limit - a[axis]) / (b[axis] - a[axis]);
        clipped.push([a[0] + amount * (b[0] - a[0]), a[1] + amount * (b[1] - a[1])]);
      }
    }
    polygon = clipped;
  });
  var area = 0;
  for (var i = 0; i < polygon.length; i++) {
    var a = polygon[i], b = polygon[(i + 1) % polygon.length]; area += a[0] * b[1] - a[1] * b[0];
  }
  return Math.min(1, Math.abs(area) / 2);
}

function paintAffineRectangle(context, x, y, width, height, rgba, clear) {
  if (!width || !height || !canvasTransformInvertible(context)) return;
  var t = context._transform;
  var points = [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
  for (var index = 0; index < 4; index++) {
    var px = points[index][0], py = points[index][1];
    points[index] = [t[0] * px + t[2] * py + t[4],
      t[1] * px + t[3] * py + t[5]];
  }
  points.closed = true;
  if (nativeCanvasPath(context, [points], false, clear)) return;
  var left = Math.max(0, Math.floor(Math.min.apply(null, points.map(function(p) { return p[0]; }))));
  var top = Math.max(0, Math.floor(Math.min.apply(null, points.map(function(p) { return p[1]; }))));
  var right = Math.min(context.canvas.width, Math.ceil(Math.max.apply(null, points.map(function(p) { return p[0]; }))));
  var bottom = Math.min(context.canvas.height, Math.ceil(Math.max.apply(null, points.map(function(p) { return p[1]; }))));
  if (!clear) {
    var region = canvasCompositeRegion(context, left, top, right, bottom);
    left = region[0]; top = region[1]; right = region[2]; bottom = region[3];
  }
  if (right <= left || bottom <= top) return;
  var canvas = context.canvas._ensureNativeCanvas();
  var pixels = new Uint8Array((right - left) * (bottom - top) * 4);
  var clipMask = new Uint8Array((right - left) * (bottom - top));
  var dynamicStyle = rgba && typeof rgba === 'object';
  for (var targetY = top; targetY < bottom; targetY++) for (var targetX = left; targetX < right; targetX++) {
    var inside = true, sign = 0;
    for (var edge = 0; edge < 4; edge++) {
      var first = points[edge], second = points[(edge + 1) & 3];
      var cross = (second[0] - first[0]) * (targetY + 0.5 - first[1]) -
        (second[1] - first[1]) * (targetX + 0.5 - first[0]);
      if (Math.abs(cross) < 0.000001) continue;
      var currentSign = cross < 0 ? -1 : 1;
      if (sign && sign !== currentSign) { inside = false; break; }
      sign = currentSign;
    }
    if (!passesCanvasClip(context, targetX + 0.5, targetY + 0.5) || clear && !inside) continue;
    var index = (targetY - top) * (right - left) + targetX - left;
    clipMask[index] = 255;
    var coverage = clear ? 0 : canvasPolygonCoverage(points, targetX, targetY);
    if (clear || !coverage) continue;
    var offset = index * 4;
    var pixelRgba = dynamicStyle ? canvasStylePremultiplied(rgba,
      targetX + 0.5, targetY + 0.5, context.globalAlpha, context._transform, context.imageSmoothingEnabled) : premultiplyCanvasColor(rgba);
    var scale = Math.round(coverage * 255) + 1;
    pixels[offset] = (pixelRgba >>> 24) * scale >> 8;
    pixels[offset + 1] = (pixelRgba >>> 16 & 255) * scale >> 8;
    pixels[offset + 2] = (pixelRgba >>> 8 & 255) * scale >> 8;
    pixels[offset + 3] = (pixelRgba & 255) * scale >> 8;
  }
  NativeHost.canvas.compositePixels(canvas.handle, left, top,
    right - left, bottom - top, pixels, clipMask, clear ? 'copy' : context.globalCompositeOperation, 1);
}

function transformedPoint(context, x, y) {
  var t = context._transform;
  return [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
}

function premultiplyCanvasColor(rgba) {
  var alpha = rgba & 255;
  return ((Math.floor(((rgba >>> 24) * alpha + 127) / 255) << 24) |
    (Math.floor(((rgba >>> 16 & 255) * alpha + 127) / 255) << 16) |
    (Math.floor(((rgba >>> 8 & 255) * alpha + 127) / 255) << 8) | alpha) >>> 0;
}
function canvasStylePremultiplied(style, x, y, alpha, transform, smoothing) {
  if (style && style._pmjsStyle === 'pattern') style = Object.assign({}, style, { smoothing: smoothing !== false });
  var rgba = canvasStyleRgba(style, x, y, alpha, transform);
  if (!style || style._pmjsStyle !== 'pattern') return premultiplyCanvasColor(rgba);
  // Pattern samples already contain premultiplied colors.
  return ((Math.round((rgba >>> 24) * alpha) << 24) |
    (Math.round((rgba >>> 16 & 255) * alpha) << 16) |
    (Math.round((rgba >>> 8 & 255) * alpha) << 8) | (rgba & 255)) >>> 0;
}

function canvasStyleRgba(style, x, y, alpha, transform) {
  if (style && style._pmjsStyle === 'pattern') {
    var patternTransform = style.transform || [1, 0, 0, 1, 0, 0];
    if (transform) patternTransform = multiplyTransform(transform, patternTransform);
    var determinant = patternTransform[0] * patternTransform[3] -
      patternTransform[1] * patternTransform[2];
    if (!Number.isFinite(determinant) || determinant === 0) return 0;
    var shiftedX = x - patternTransform[4], shiftedY = y - patternTransform[5];
    var sampleX = (patternTransform[3] * shiftedX - patternTransform[2] * shiftedY) / determinant;
    var sampleY = (-patternTransform[1] * shiftedX + patternTransform[0] * shiftedY) / determinant;
    function sample(px, py) {
      if (style.repeat === 'repeat' || style.repeat === 'repeat-x') px = ((px % style.width) + style.width) % style.width;
      else if (px < 0 || px >= style.width) return [0, 0, 0, 0];
      if (style.repeat === 'repeat' || style.repeat === 'repeat-y') py = ((py % style.height) + style.height) % style.height;
      else if (py < 0 || py >= style.height) return [0, 0, 0, 0];
      var offset = (py * style.width + px) * 4;
      return Array.prototype.slice.call(style.pixels, offset, offset + 4);
    }
    var channels;
    if (style.smoothing === false) channels = sample(Math.floor(sampleX), Math.floor(sampleY));
    else {
      var x0 = Math.floor(sampleX - 0.5), y0 = Math.floor(sampleY - 0.5);
      var fx = Math.floor((sampleX - 0.5 - x0) * 16) / 16, fy = Math.floor((sampleY - 0.5 - y0) * 16) / 16;
      var a = sample(x0, y0), b = sample(x0 + 1, y0), c = sample(x0, y0 + 1), d = sample(x0 + 1, y0 + 1);
      channels = a.map(function(value, i) { return Math.floor(
        (value * (1 - fx) + b[i] * fx) * (1 - fy) + (c[i] * (1 - fx) + d[i] * fx) * fy); });
    }
    return ((channels[0] << 24) | (channels[1] << 16) | (channels[2] << 8) | Math.round(channels[3] * alpha)) >>> 0;
  }
  if (!style || (style._pmjsStyle !== 'linear-gradient' &&
      style._pmjsStyle !== 'radial-gradient')) {
    return colorWithGlobalAlpha(style, alpha);
  }
  if (transform) {
    var det = transform[0] * transform[3] - transform[1] * transform[2];
    if (!Number.isFinite(det) || det === 0) return 0;
    var localX = x - transform[4], localY = y - transform[5];
    x = (transform[3] * localX - transform[2] * localY) / det;
    y = (-transform[1] * localX + transform[0] * localY) / det;
  }
  if (!style.stops.length) return 0;
  var amount;
  if (style._pmjsStyle === 'radial-gradient') {
    var centerDx = style.x1 - style.x0, centerDy = style.y1 - style.y0;
    var radiusDelta = style.r1 - style.r0;
    var pointX = x - style.x0, pointY = y - style.y0;
    if (Math.abs(centerDx) < 0.000001 && Math.abs(centerDy) < 0.000001) {
      amount = radiusDelta ?
        (Math.sqrt(pointX * pointX + pointY * pointY) - style.r0) / radiusDelta : 0;
    } else {
      var quadraticA = centerDx * centerDx + centerDy * centerDy -
        radiusDelta * radiusDelta;
      var quadraticB = -2 * (pointX * centerDx + pointY * centerDy +
        style.r0 * radiusDelta);
      var quadraticC = pointX * pointX + pointY * pointY - style.r0 * style.r0;
      var discriminant = quadraticB * quadraticB - 4 * quadraticA * quadraticC;
      if (discriminant < 0) amount = 0;
      else if (Math.abs(quadraticA) < 0.000001) {
        amount = Math.abs(quadraticB) < 0.000001 ? 0 : -quadraticC / quadraticB;
      } else {
        amount = (-quadraticB + Math.sqrt(discriminant)) / (2 * quadraticA);
      }
    }
  } else {
    var dx = style.x1 - style.x0, dy = style.y1 - style.y0;
    var length = dx * dx + dy * dy;
    if (!length) return 0;
    amount = ((x - style.x0) * dx + (y - style.y0) * dy) / length;
  }
  amount = Math.max(0, Math.min(1, amount));
  var lower = style.stops[0], upper = style.stops[style.stops.length - 1];
  for (var index = 1; index < style.stops.length; index++) {
    if (style.stops[index].offset >= amount) {
      lower = style.stops[index - 1]; upper = style.stops[index]; break;
    }
  }
  var span = upper.offset - lower.offset;
  var mix = span ? Math.max(0, Math.min(1, (amount - lower.offset) / span)) : 0;
  var first = colorToRgba(lower.color), second = colorToRgba(upper.color);
  var channel = function(shift) {
    return Math.round(((first >>> shift) & 255) * (1 - mix) +
      ((second >>> shift) & 255) * mix);
  };
  return ((channel(24) << 24) | (channel(16) << 16) | (channel(8) << 8) |
    Math.round(channel(0) * Math.max(0, Math.min(1, alpha)))) >>> 0;
}

function fillAxisAlignedRadialGradient(context, rectangle, style) {
  if (!style || style._pmjsStyle !== 'radial-gradient' ||
      !style.nativeConcentric || !style.stops.length || style.stops.length > 64 || context._clipPaths.length ||
      ![rectangle.x, rectangle.y, rectangle.width, rectangle.height].every(Number.isInteger) ||
      (context.globalCompositeOperation !== 'source-over' &&
       context.globalCompositeOperation !== 'lighter') ||
      typeof NativeHost.canvas.fillRadialGradient !== 'function') return false;
  var transform = context._transform;
  if (transform[1] !== 0 || transform[2] !== 0 || transform[0] !== transform[3] || transform[0] <= 0) return false;
  style = Object.assign({}, style, {
    x0: style.x0 * transform[0] + transform[4], y0: style.y0 * transform[3] + transform[5],
    x1: style.x1 * transform[0] + transform[4], y1: style.y1 * transform[3] + transform[5],
    r0: style.r0 * transform[0], r1: style.r1 * transform[0]
  });

  var left = Math.floor(rectangle.x);
  var top = Math.floor(rectangle.y);
  var width = Math.ceil(rectangle.x + rectangle.width) - left;
  var height = Math.ceil(rectangle.y + rectangle.height) - top;
  NativeHost.canvas.fillRadialGradient(context.canvas._ensureNativeCanvas().handle,
    left, top, width, height, style.x0, style.y0, style.r0, style.r1,
    style.stops.map(function(stop) { return stop.offset; }),
    style.stops.map(function(stop) {
      return colorWithGlobalAlpha(stop.color, context.globalAlpha);
    }), context.globalCompositeOperation === 'lighter');
  return true;
}

function fillAxisAlignedLinearGradient(context, rectangle, style) {
  if (!style || style._pmjsStyle !== 'linear-gradient' ||
      !style.stops.length || (style.x0 === style.x1 && style.y0 === style.y1) || context._clipPaths.length ||
      context.globalCompositeOperation !== 'source-over') return false;
  var transform = context._transform;
  if (transform[1] !== 0 || transform[2] !== 0 || transform[0] !== transform[3] || transform[0] <= 0) return false;
  style = Object.assign({}, style, {
    x0: style.x0 * transform[0] + transform[4], y0: style.y0 * transform[3] + transform[5],
    x1: style.x1 * transform[0] + transform[4], y1: style.y1 * transform[3] + transform[5],
    r0: style.r0 * transform[0], r1: style.r1 * transform[0]
  });
  if (style.stops.length <= 64 && NativeHost.canvas.paintRect &&
      NativeHost.canvas.paintRect(context.canvas._ensureNativeCanvas().handle,
        rectangle.x, rectangle.y, rectangle.width, rectangle.height, colorWithGlobalAlpha('#fff', context.globalAlpha), 0,
        style.x0, style.y0, style.x1, style.y1,
        style.stops.map(function(stop) { return stop.offset; }),
        style.stops.map(function(stop) { return colorToRgba(stop.color); }))) return true;
  if (![rectangle.x, rectangle.y, rectangle.width, rectangle.height].every(Number.isInteger)) return false;
  var dx = style.x1 - style.x0;
  var dy = style.y1 - style.y0;
  var horizontal = Math.abs(dy) < 0.000001;
  var vertical = Math.abs(dx) < 0.000001;
  if (!horizontal && !vertical) return false;
  var canvas = context.canvas._ensureNativeCanvas();
  var left = Math.floor(rectangle.x);
  var top = Math.floor(rectangle.y);
  var width = Math.ceil(rectangle.x + rectangle.width) - left;
  var height = Math.ceil(rectangle.y + rectangle.height) - top;
  var strips = horizontal ? width : height;
  for (var offset = 0; offset < strips; offset++) {
    var sampleX = horizontal ? left + offset + 0.5 : left + width * 0.5;
    var sampleY = vertical ? top + offset + 0.5 : top + height * 0.5;
    var rgba = canvasStyleRgba(style, sampleX, sampleY, context.globalAlpha);
    NativeHost.canvas.fillRect(canvas.handle,
      horizontal ? left + offset : left,
      vertical ? top + offset : top,
      horizontal ? 1 : width,
      vertical ? 1 : height,
      rgba);
  }
  return true;
}

function pointInCanvasPaths(paths, x, y, rule) {
  var crossings = 0, winding = 0;
  for (var pathIndex = 0; pathIndex < paths.length; pathIndex++) {
    var path = paths[pathIndex];
    for (var index = 0, previous = path.length - 1; index < path.length;
         previous = index++) {
      var first = path[index], second = path[previous];
      if ((first[1] > y) !== (second[1] > y) &&
          x < (second[0] - first[0]) * (y - first[1]) /
          (second[1] - first[1]) + first[0]) {
        crossings++;
        winding += second[1] > first[1] ? 1 : -1;
      }
    }
  }
  return rule === 'evenodd' ? (crossings & 1) !== 0 : winding !== 0;
}

function passesCanvasClip(context, x, y) {
  for (var index = 0; index < context._clipPaths.length; index++) {
    var clip = context._clipPaths[index];
    if (!pointInCanvasPaths(clip.paths, x, y, clip.rule)) return false;
  }
  return true;
}

function canvasDashedPaths(context, paths) {
  var dash = context._lineDash, total = dash.reduce(function(sum, value) { return sum + value; }, 0);
  if (!total) return paths;
  var t = context._transform, determinant = t[0] * t[3] - t[1] * t[2], result = [];
  paths.forEach(function(path) {
    var index = 0, phase = (context.lineDashOffset % total + total) % total;
    while (phase >= dash[index]) { phase -= dash[index]; index = (index + 1) % dash.length; }
    var remaining = dash[index] - phase, active = null;
    var local = path.map(function(point) {
      var x = point[0] - t[4], y = point[1] - t[5];
      return [(t[3] * x - t[2] * y) / determinant, (-t[1] * x + t[0] * y) / determinant];
    });
    for (var i = 1; i < local.length; i++) {
      var a = local[i - 1], b = local[i], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (var distance = 0; distance < length;) {
        if (!remaining) { index = (index + 1) % dash.length; remaining = dash[index]; active = null; continue; }
        var step = Math.min(remaining, length - distance);
        if (!(index % 2)) {
          if (!active) { active = [transformedPoint(context, a[0] + (b[0] - a[0]) * distance / length, a[1] + (b[1] - a[1]) * distance / length)]; result.push(active); }
          active.push(transformedPoint(context, a[0] + (b[0] - a[0]) * (distance + step) / length, a[1] + (b[1] - a[1]) * (distance + step) / length));
        }
        distance += step; remaining -= step;
      }
    }
  });
  return result;
}
function canvasStrokePolygons(context, paths) {
  paths = canvasDashedPaths(context, paths);
  // Stored path points are in destination space; stroke outlines belong in current user space.
  var t = context._transform, determinant = t[0] * t[3] - t[1] * t[2];
  var radius = context.lineWidth / 2, polygons = [];
  function circle(point) {
    var polygon = [], extent = radius * (Math.hypot(t[0], t[1]) + Math.hypot(t[2], t[3]));
    var count = Math.min(8192, Math.max(16, Math.ceil(Math.PI * 2 * Math.sqrt(extent * 2))));
    for (var i = 0; i < count; i++) {
      var angle = i * Math.PI * 2 / count;
      polygon.push([point[0] + radius * Math.cos(angle), point[1] + radius * Math.sin(angle)]);
    }
    polygons.push(polygon);
  }
  paths.forEach(function(path) {
    var local = path.map(function(point) {
      var x = point[0] - t[4], y = point[1] - t[5];
      return [(t[3] * x - t[2] * y) / determinant, (-t[1] * x + t[0] * y) / determinant];
    });
    var edges = [];
    for (var i = 1; i < local.length; i++) {
      var a = local[i - 1], b = local[i], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length) edges.push({ a: a, b: b, dx: (b[0] - a[0]) / length, dy: (b[1] - a[1]) / length });
    }
    if (!edges.length) {
      if (!path.closed && context.lineCap === 'round') circle(local[0]);
      else if (!path.closed && context.lineCap === 'square') {
        var point = local[0];
        polygons.push([[point[0] - radius, point[1] - radius], [point[0] + radius, point[1] - radius],
          [point[0] + radius, point[1] + radius], [point[0] - radius, point[1] + radius]]);
      }
      return;
    }
    edges.forEach(function(edge, index) {
      var nx = -edge.dy * radius, ny = edge.dx * radius;
      var start = !path.closed && context.lineCap === 'square' && index === 0 ? radius : 0;
      var end = !path.closed && context.lineCap === 'square' && index === edges.length - 1 ? radius : 0;
      var ax = edge.a[0] - edge.dx * start, ay = edge.a[1] - edge.dy * start;
      var bx = edge.b[0] + edge.dx * end, by = edge.b[1] + edge.dy * end;
      polygons.push([[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]]);
      if (index === edges.length - 1 && !path.closed) return;
      var next = edges[(index + 1) % edges.length], point = edge.b;
      var cross = edge.dx * next.dy - edge.dy * next.dx;
      if (context.lineJoin === 'round') { circle(point); return; }
      if (Math.abs(cross) < 0.000001) return;
      var side = cross > 0 ? -1 : 1;
      var first = [point[0] - edge.dy * radius * side, point[1] + edge.dx * radius * side];
      var second = [point[0] - next.dy * radius * side, point[1] + next.dx * radius * side];
      var join = [point, first];
      if (context.lineJoin === 'miter') {
        var distance = ((second[0] - first[0]) * next.dy - (second[1] - first[1]) * next.dx) / cross;
        var miter = [first[0] + edge.dx * distance, first[1] + edge.dy * distance];
        if (Math.hypot(miter[0] - point[0], miter[1] - point[1]) <= radius * context.miterLimit) join.push(miter);
      }
      join.push(second); polygons.push(join);
    });
    if (!path.closed && context.lineCap === 'round') { circle(edges[0].a); circle(edges[edges.length - 1].b); }
  });
  return polygons.map(function(polygon) {
    return polygon.map(function(point) { return transformedPoint(context, point[0], point[1]); });
  });
}

function rasterPath(context, stroke, rule, drawingPaths) {
  if (!canvasTransformInvertible(context) || !context.canvas.width || !context.canvas.height) return;
  if (canvasPaintEmpty(stroke ? context.strokeStyle : context.fillStyle)) return;
  if (stroke || !context._circlePath) materializeCanvasArc(context);
  var paths = (drawingPaths || context._path).filter(function(path) { return path.length > 1; });
  if (!paths.length && !context._circlePath) return;
  if (stroke && nativeCanvasPath(context, paths, true, false)) return;
  var circle = !stroke && context._circlePath;
  if (circle) {
    NativeHost.canvas.paintCircle(context.canvas._ensureNativeCanvas().handle, {
      geometry: [circle.x, circle.y, circle.radius], transform: circle.transform,
      paint: canvasNativePaint(context.fillStyle, context),
      globalAlpha: Math.max(0, Math.min(1, Number(context.globalAlpha))),
      composite: context.globalCompositeOperation, clips: context._clipPaths
    });
    return;
  }
  if (!stroke && nativeCanvasPath(context, paths, false, false, rule)) return;
  paths.forEach(canvasFlattenPath);
  if (stroke) paths = canvasStrokePolygons(context, paths);
  if (!paths.length) return;
  var all = [].concat.apply([], paths);
  var radius = 0;
  var left = Math.max(0, Math.floor(Math.min.apply(null, all.map(function(p) { return p[0]; })) - radius));
  var top = Math.max(0, Math.floor(Math.min.apply(null, all.map(function(p) { return p[1]; })) - radius));
  var right = Math.min(context.canvas.width, Math.ceil(Math.max.apply(null, all.map(function(p) { return p[0]; })) + radius));
  var bottom = Math.min(context.canvas.height, Math.ceil(Math.max.apply(null, all.map(function(p) { return p[1]; })) + radius));
  var region = canvasCompositeRegion(context, left, top, right, bottom);
  left = region[0]; top = region[1]; right = region[2]; bottom = region[3];
  if (right <= left || bottom <= top) return;
  var canvas = context.canvas._ensureNativeCanvas();
  var pixels = new Uint8Array((right - left) * (bottom - top) * 4);
  var clipMask = new Uint8Array((right - left) * (bottom - top));
  var style = stroke ? context.strokeStyle : context.fillStyle;
  for (var y = top; y < bottom; y++) for (var x = left; x < right; x++) {
    var px = x + 0.5, py = y + 0.5, covered = false;
    if (stroke) {
      covered = paths.some(function(path) { return pointInCanvasPaths([path], px, py, 'nonzero'); });
    } else {
      covered = pointInCanvasPaths(paths, px, py, rule);
    }
    if (!passesCanvasClip(context, px, py)) continue;
    var index = (y - top) * (right - left) + x - left;
    clipMask[index] = 255;
    if (!covered) continue;
    var offset = index * 4;
    var rgba = canvasStylePremultiplied(style, px, py, context.globalAlpha, context._transform, context.imageSmoothingEnabled);
    pixels[offset] = rgba >>> 24; pixels[offset + 1] = rgba >>> 16 & 255;
    pixels[offset + 2] = rgba >>> 8 & 255; pixels[offset + 3] = rgba & 255;
  }
  NativeHost.canvas.compositePixels(canvas.handle, left, top, right - left,
    bottom - top, pixels, clipMask, context.globalCompositeOperation, 1);
}

// CSS Color named values: https://www.w3.org/TR/css-color-4/#named-colors
var canvasNamedColors = {
  aliceblue: 0xf0f8ff, antiquewhite: 0xfaebd7, aqua: 0x00ffff, aquamarine: 0x7fffd4,
  azure: 0xf0ffff, beige: 0xf5f5dc, bisque: 0xffe4c4, black: 0x000000,
  blanchedalmond: 0xffebcd, blue: 0x0000ff, blueviolet: 0x8a2be2, brown: 0xa52a2a,
  burlywood: 0xdeb887, cadetblue: 0x5f9ea0, chartreuse: 0x7fff00, chocolate: 0xd2691e,
  coral: 0xff7f50, cornflowerblue: 0x6495ed, cornsilk: 0xfff8dc, crimson: 0xdc143c,
  cyan: 0x00ffff, darkblue: 0x00008b, darkcyan: 0x008b8b, darkgoldenrod: 0xb8860b,
  darkgray: 0xa9a9a9, darkgreen: 0x006400, darkgrey: 0xa9a9a9, darkkhaki: 0xbdb76b,
  darkmagenta: 0x8b008b, darkolivegreen: 0x556b2f, darkorange: 0xff8c00, darkorchid: 0x9932cc,
  darkred: 0x8b0000, darksalmon: 0xe9967a, darkseagreen: 0x8fbc8f, darkslateblue: 0x483d8b,
  darkslategray: 0x2f4f4f, darkslategrey: 0x2f4f4f, darkturquoise: 0x00ced1, darkviolet: 0x9400d3,
  deeppink: 0xff1493, deepskyblue: 0x00bfff, dimgray: 0x696969, dimgrey: 0x696969,
  dodgerblue: 0x1e90ff, firebrick: 0xb22222, floralwhite: 0xfffaf0, forestgreen: 0x228b22,
  fuchsia: 0xff00ff, gainsboro: 0xdcdcdc, ghostwhite: 0xf8f8ff, gold: 0xffd700,
  goldenrod: 0xdaa520, gray: 0x808080, green: 0x008000, greenyellow: 0xadff2f,
  grey: 0x808080, honeydew: 0xf0fff0, hotpink: 0xff69b4, indianred: 0xcd5c5c,
  indigo: 0x4b0082, ivory: 0xfffff0, khaki: 0xf0e68c, lavender: 0xe6e6fa,
  lavenderblush: 0xfff0f5, lawngreen: 0x7cfc00, lemonchiffon: 0xfffacd, lightblue: 0xadd8e6,
  lightcoral: 0xf08080, lightcyan: 0xe0ffff, lightgoldenrodyellow: 0xfafad2, lightgray: 0xd3d3d3,
  lightgreen: 0x90ee90, lightgrey: 0xd3d3d3, lightpink: 0xffb6c1, lightsalmon: 0xffa07a,
  lightseagreen: 0x20b2aa, lightskyblue: 0x87cefa, lightslategray: 0x778899, lightslategrey: 0x778899,
  lightsteelblue: 0xb0c4de, lightyellow: 0xffffe0, lime: 0x00ff00, limegreen: 0x32cd32,
  linen: 0xfaf0e6, magenta: 0xff00ff, maroon: 0x800000, mediumaquamarine: 0x66cdaa,
  mediumblue: 0x0000cd, mediumorchid: 0xba55d3, mediumpurple: 0x9370db, mediumseagreen: 0x3cb371,
  mediumslateblue: 0x7b68ee, mediumspringgreen: 0x00fa9a, mediumturquoise: 0x48d1cc, mediumvioletred: 0xc71585,
  midnightblue: 0x191970, mintcream: 0xf5fffa, mistyrose: 0xffe4e1, moccasin: 0xffe4b5,
  navajowhite: 0xffdead, navy: 0x000080, oldlace: 0xfdf5e6, olive: 0x808000,
  olivedrab: 0x6b8e23, orange: 0xffa500, orangered: 0xff4500, orchid: 0xda70d6,
  palegoldenrod: 0xeee8aa, palegreen: 0x98fb98, paleturquoise: 0xafeeee, palevioletred: 0xdb7093,
  papayawhip: 0xffefd5, peachpuff: 0xffdab9, peru: 0xcd853f, pink: 0xffc0cb,
  plum: 0xdda0dd, powderblue: 0xb0e0e6, purple: 0x800080, rebeccapurple: 0x663399,
  red: 0xff0000, rosybrown: 0xbc8f8f, royalblue: 0x4169e1, saddlebrown: 0x8b4513,
  salmon: 0xfa8072, sandybrown: 0xf4a460, seagreen: 0x2e8b57, seashell: 0xfff5ee,
  sienna: 0xa0522d, silver: 0xc0c0c0, skyblue: 0x87ceeb, slateblue: 0x6a5acd,
  slategray: 0x708090, slategrey: 0x708090, snow: 0xfffafa, springgreen: 0x00ff7f,
  steelblue: 0x4682b4, tan: 0xd2b48c, teal: 0x008080, thistle: 0xd8bfd8,
  tomato: 0xff6347, turquoise: 0x40e0d0, violet: 0xee82ee, wheat: 0xf5deb3,
  white: 0xffffff, whitesmoke: 0xf5f5f5, yellow: 0xffff00, yellowgreen: 0x9acd32
};

var canvasColorValues = new Map();
function parseCanvasColor(color) {
  // HWB acceptance depends on the current reference engine.
  if (typeof color !== 'string' || color.length > 256 || /hwb/i.test(color)) return parseCanvasColorValue(color);
  if (canvasColorValues.has(color)) return canvasColorValues.get(color);
  var result = parseCanvasColorValue(color);
  if (canvasColorValues.size >= 256) canvasColorValues.clear();
  canvasColorValues.set(color, result);
  return result;
}
function parseCanvasColorValue(color) {
  if (typeof color === 'number' && Number.isFinite(color)) return ((color & 0xffffff) << 8 | 255) >>> 0;
  if (typeof color !== 'string') return null;
  var text = color.trim().toLowerCase();
  if (text === 'transparent') return 0;
  if (Object.prototype.hasOwnProperty.call(canvasNamedColors, text)) return (canvasNamedColors[text] * 256 + 255) >>> 0;
  var hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (hex) {
    var digits = hex[1];
    if (digits.length < 5) digits = digits.split('').map(function(digit) { return digit + digit; }).join('');
    if (digits.length === 6) digits += 'ff';
    return parseInt(digits, 16) >>> 0;
  }
  var functional = /^(rgba?|hsla?|hwb)\((.*)\)$/.exec(text);
  if (!functional) return null;
  if (functional[1] === 'hwb' && canvasReferenceEngine()) return null;
  var body = functional[2], comma = body.indexOf(',') >= 0;
  if (comma && body.indexOf('/') >= 0) return null;
  var sections = comma ? [body] : body.split('/');
  if (sections.length > 2) return null;
  var parts = sections[0].trim().split(comma ? /\s*,\s*/ : /\s+/);
  var alpha = comma && parts.length === 4 ? parts.pop() : sections[1];
  if (parts.length !== 3 || functional[1] === 'hwb' && comma) return null;
  function component(value, scale, percentageOnly) {
    if (value === 'none' && !comma) return 0;
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?$/.test(value)) return NaN;
    var percent = value.endsWith('%');
    if (percentageOnly && !percent) return NaN;
    return Number(percent ? value.slice(0, -1) : value) * (percent ? scale / 100 : 1);
  }
  var opacity = alpha === undefined ? 1 : component(alpha.trim(), 1, false);
  var channels;
  if (functional[1].slice(0, 3) === 'rgb') {
    if (comma && parts.some(function(part) { return part.endsWith('%') !== parts[0].endsWith('%'); })) return null;
    channels = parts.map(function(part) { return component(part, 255, false); });
  } else {
    var hue = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|grad|rad|turn)?$/.exec(parts[0]);
    if (!hue && parts[0] !== 'none') return null;
    var angle = hue ? Number(hue[1]) * ({ deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 }[hue[2] || 'deg']) : 0;
    angle = ((angle % 360) + 360) % 360 / 60;
    var first = component(parts[1], 1, true), second = component(parts[2], 1, true);
    if (![first, second, angle].every(Number.isFinite)) return null;
    first = Math.max(0, Math.min(1, first)); second = Math.max(0, Math.min(1, second));
    var chroma = functional[1] === 'hwb' ? 1 : (1 - Math.abs(2 * second - 1)) * first;
    var middle = chroma * (1 - Math.abs(angle % 2 - 1));
    var rgb = [[chroma, middle, 0], [middle, chroma, 0], [0, chroma, middle],
      [0, middle, chroma], [middle, 0, chroma], [chroma, 0, middle]][Math.floor(angle)];
    channels = rgb.map(function(channel) {
      if (functional[1] === 'hwb') return 255 * (first + second >= 1 ? first / (first + second) : channel * (1 - first - second) + first);
      return 255 * (channel + second - chroma / 2);
    });
  }
  if (!channels.concat([opacity]).every(Number.isFinite)) return null;
  var bytes = channels.map(function(channel) { return Math.round(Math.max(0, Math.min(255, channel))); });
  return (bytes[0] * 0x1000000 + bytes[1] * 0x10000 + bytes[2] * 0x100 + Math.round(Math.max(0, Math.min(1, opacity)) * 255)) >>> 0;
}

function colorToRgba(color) {
  var rgba = parseCanvasColor(color);
  return rgba === null ? 0x000000ff : rgba;
}
function canvasSerializedColor(value) {
  var rgba = parseCanvasColor(String(value));
  if (rgba === null) return null;
  var alpha = rgba & 255;
  if (alpha === 255) return '#' + (rgba >>> 8).toString(16).padStart(6, '0');
  var fraction = alpha ? String(alpha / 255).slice(2) : '0';
  var zeros = (fraction.match(/^0*/) || [''])[0];
  var significant = fraction.slice(zeros.length);
  // Decimal serialization rounds the shortest decimal representation to
  // fifteen significant digits, without a second binary floating conversion.
  if (significant.length > 15) significant = String(Number(significant.slice(0, 15)) + (Number(significant[15]) >= 5 ? 1 : 0));
  var serializedAlpha = alpha ? ('0.' + zeros + significant).replace(/0+$/, '') : '0';
  return 'rgba(' + [rgba >>> 24, rgba >>> 16 & 255, rgba >>> 8 & 255, serializedAlpha].join(', ') + ')';
}

['fillStyle', 'strokeStyle'].forEach(function(property) {
  Object.defineProperty(CanvasContext2D.prototype, property, {
    get: function() { return this['_' + property]; },
    set: function(value) {
      if (value && typeof value === 'object' && value._pmjsStyle) { this['_' + property] = value; return; }
      var color = canvasSerializedColor(value);
      if (color !== null) this['_' + property] = color;
    }
  });
});

function colorWithGlobalAlpha(color, globalAlpha) {
  var rgba = colorToRgba(color);
  var sourceAlpha = rgba & 255;
  // Chromium 65 scales paint alpha with an eight-bit fixed-point factor.
  var scale = Math.round(Math.max(0, Math.min(1, Number(globalAlpha))) * 256);
  var alpha = (sourceAlpha * scale) >> 8;
  return ((rgba & 0xffffff00) | alpha) >>> 0;
}

var canvasTextBackend;
function usesLegacyText() {
  if (canvasTextBackend === undefined) {
    canvasTextBackend = typeof NativeHost.canvas.glyphStats === 'function' ?
      NativeHost.canvas.glyphStats().backend : 'skia65';
  }
  return canvasTextBackend === 'freetype';
}
function canvasFontSize(size) {
  return usesLegacyText() ? Math.max(1, Math.round(size)) : size;
}

function contextFont(context) {
  var fontStr = (context && typeof context === 'object') ? context.font : context;
  if (globalThis.PMJS && PMJS.fonts && typeof PMJS.fonts.resolveDescriptor === 'function') {
    var resolved = PMJS.fonts.resolveDescriptor(fontStr);
    return {
      paths: resolved.faces.map(function(face) { return face.path; }),
      size: canvasFontSize(resolved.size), style: resolved.style, weight: resolved.weight,
      family: (resolved.faces && resolved.faces[0] && resolved.faces[0].family) || 'GameFont'
    };
  }
  var sizeMatch = /(\d+(?:\.\d+)?)px/.exec(String(fontStr));
  var size = sizeMatch ? Math.max(1, Number(sizeMatch[1])) : 10;
  var config = PMJS.config;
  var files = config.fonts || {};
  var family = String(fontStr).split(/\s+/).pop().replace(/["']/g, '');
  return { paths: [files[family] || files.GameFont || 'fonts/gamefont.ttf'],
    size: canvasFontSize(size), family: family,
    style: /\b(italic|oblique)\b/.test(String(fontStr)) ? 'italic' : 'normal',
    weight: /\bbold\b/.test(String(fontStr)) ? 700 : Number((/\b([1-9]00)\b/.exec(String(fontStr)) || [0, 400])[1]) };
}


var nativeCanvasReleaseStats = { explicit: 0, finalizer: 0, sceneLifecycle: 0 };
function noteCanvasRelease(reason) {
  try {
    if (reason === 'explicit') nativeCanvasReleaseStats.explicit++;
    else if (reason === 'finalizer') nativeCanvasReleaseStats.finalizer++;
    else if (reason === 'scene-lifecycle') {
      nativeCanvasReleaseStats.sceneLifecycle++;
      try {
        PMJS.compat.hit('canvas.release.sceneLifecycle',
          'total=' + nativeCanvasReleaseStats.sceneLifecycle);
      } catch (_) {}
      try {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[pmjs] canvas released by scene lifecycle (ownership violation risk)');
        }
      } catch (_) {}
    }
  } catch (_) {}
}
var nativeResourceFinalizer = typeof FinalizationRegistry === 'function'
  ? new FinalizationRegistry(function(resource) {
      try {
        if (resource.kind === 'image') NativeHost.images.release(resource.handle);
        else if (resource.kind === 'canvas') {
          noteCanvasRelease('finalizer');
          NativeHost.canvas.release(resource.handle);
        }
      } catch (_) {}
    })
  : null;
function trackNativeResource(resource, kind) {
  if (resource && nativeResourceFinalizer) {
    nativeResourceFinalizer.register(resource,
      { kind: kind, handle: resource.handle }, resource);
  }
  return resource;
}
function releaseNativeResource(resource, kind) {
  if (!resource) return;
  if (nativeResourceFinalizer) nativeResourceFinalizer.unregister(resource);
  if (kind === 'image') NativeHost.images.release(resource.handle);
  else if (kind === 'canvas') {
    noteCanvasRelease('explicit');
    NativeHost.canvas.release(resource.handle);
  }
}
globalThis.__pmjsCanvasReleaseStats = function() {
  return { explicit: nativeCanvasReleaseStats.explicit,
    finalizer: nativeCanvasReleaseStats.finalizer,
    sceneLifecycle: nativeCanvasReleaseStats.sceneLifecycle };
};


CanvasContext2D.prototype.save = function() {
  this._stateStack.push({
    _transform: this._transform.slice(),
    _clipPaths: this._clipPaths.map(function(region) {
      return { rule: region.rule, paths: region.paths.map(function(path) {
        return path.map(function(point) { return point.slice(); });
      }) };
    }),
    _fillStyle: this._fillStyle,
    _strokeStyle: this._strokeStyle,
    _globalAlpha: this._globalAlpha,
    _compositeOperation: this._compositeOperation,
    _font: this._font,
    textAlign: this.textAlign,
    textBaseline: this.textBaseline,
    _lineWidth: this._lineWidth,
    _lineCap: this._lineCap,
    _lineJoin: this._lineJoin,
    _miterLimit: this._miterLimit,
    _imageSmoothingEnabled: this._imageSmoothingEnabled,
    _lineDashOffset: this._lineDashOffset,
    _shadowColor: this._shadowColor,
    _shadowBlur: this._shadowBlur,
    _shadowOffsetX: this._shadowOffsetX,
    _shadowOffsetY: this._shadowOffsetY,
    _lineDash: this._lineDash.slice()
  });
};
CanvasContext2D.prototype.restore = function() {
  if (!this._stateStack.length) return;
  var state = this._stateStack.pop();
  this._transform = state._transform;
  this._clipPaths = state._clipPaths;
  this._fillStyle = state._fillStyle;
  this._strokeStyle = state._strokeStyle;
  this._globalAlpha = state._globalAlpha;
  this._compositeOperation = state._compositeOperation;
  this._font = state._font;
  this.textAlign = state.textAlign;
  this.textBaseline = state.textBaseline;
  this._lineWidth = state._lineWidth;
  this._lineCap = state._lineCap;
  this._lineJoin = state._lineJoin;
  this._miterLimit = state._miterLimit;
  this._imageSmoothingEnabled = state._imageSmoothingEnabled;
  this._lineDashOffset = state._lineDashOffset;
  this._shadowColor = state._shadowColor;
  this._shadowBlur = state._shadowBlur;
  this._shadowOffsetX = state._shadowOffsetX;
  this._shadowOffsetY = state._shadowOffsetY;
  this._lineDash = state._lineDash;
};
CanvasContext2D.prototype.setTransform = function(a, b, c, d, e, f) {
  if (arguments.length < 6 && canvasReferenceEngine() === 'mv') throw new TypeError('setTransform requires six arguments');
  var transform = arguments.length === 1 && a ?
    [Number(a.a), Number(a.b), Number(a.c), Number(a.d), Number(a.e), Number(a.f)] :
    [Number(a), Number(b), Number(c), Number(d), Number(e), Number(f)];
  if (transform.every(Number.isFinite)) this._transform = transform;
};
CanvasContext2D.prototype.resetTransform = function() {
  this._transform = [1, 0, 0, 1, 0, 0];
};
CanvasContext2D.prototype.transform = function(a, b, c, d, e, f) {
  var transform = [Number(a), Number(b), Number(c), Number(d), Number(e), Number(f)];
  if (transform.every(Number.isFinite)) this._transform = multiplyTransform(this._transform, transform);
};
CanvasContext2D.prototype.scale = function(x, y) { this.transform(x, 0, 0, y, 0, 0); };
CanvasContext2D.prototype.translate = function(x, y) { this.transform(1, 0, 0, 1, x, y); };
CanvasContext2D.prototype.rotate = function(angle) {
  var cosine = Math.cos(angle), sine = Math.sin(angle);
  this.transform(cosine, sine, -sine, cosine, 0, 0);
};
CanvasContext2D.prototype.clearRect = function(x, y, width, height) {
  x = +x; y = +y; width = +width; height = +height;
  if (![x, y, width, height].every(Number.isFinite) || !canvasTransformInvertible(this) ||
      !this.canvas.width || !this.canvas.height) return;
  if (!width || !height) return;
  var rectangle = axisAlignedRect(this, x, y, width, height);
  if (!rectangle || this._clipPaths.length ||
      ![rectangle.x, rectangle.y, rectangle.width, rectangle.height].every(Number.isInteger)) {
    paintAffineRectangle(this, x, y, width, height, 0, true); return;
  }
  x = rectangle.x; y = rectangle.y; width = rectangle.width; height = rectangle.height;
  var canvas = this.canvas._ensureNativeCanvas();
  if (x <= 0 && y <= 0 && x + width >= this.canvas.width && y + height >= this.canvas.height) {
    NativeHost.canvas.clear(canvas.handle);
  } else {
    NativeHost.canvas.clearRect(canvas.handle,
      Math.floor(x), Math.floor(y), Math.floor(width), Math.floor(height));
  }
};
CanvasContext2D.prototype.fillRect = function(x, y, width, height) {
  if (canvasPaintEmpty(this.fillStyle)) return;
  x = +x; y = +y; width = +width; height = +height;
  if (![x, y, width, height].every(Number.isFinite) || !canvasTransformInvertible(this) ||
      !this.canvas.width || !this.canvas.height) return;
  if (!width || !height) return;
  var rectangle = axisAlignedRect(this, x, y, width, height);
  if (rectangle && fillAxisAlignedRadialGradient(this, rectangle, this.fillStyle)) return;
  if (rectangle && fillAxisAlignedLinearGradient(this, rectangle, this.fillStyle)) return;
  if (!rectangle || this._clipPaths.length || typeof this.fillStyle === 'object' ||
      ![rectangle.x, rectangle.y, rectangle.width, rectangle.height].every(Number.isInteger) ||
      this.globalCompositeOperation !== 'source-over') {
    paintAffineRectangle(this, x, y, width, height,
      typeof this.fillStyle === 'object' ? this.fillStyle :
        colorWithGlobalAlpha(this.fillStyle, this.globalAlpha), false);
    return;
  }
  var canvas = this.canvas._ensureNativeCanvas();
  NativeHost.canvas.fillRect(canvas.handle, rectangle.x, rectangle.y,
    rectangle.width, rectangle.height,
    colorWithGlobalAlpha(this.fillStyle, this.globalAlpha));
};
CanvasContext2D.prototype.strokeRect = function(x, y, width, height) {
  if (canvasPaintEmpty(this.strokeStyle)) return;
  x = +x; y = +y; width = +width; height = +height;
  if (![x, y, width, height].every(Number.isFinite) || !canvasTransformInvertible(this) ||
      !this.canvas.width || !this.canvas.height) return;
  var line = Number(this.lineWidth);
  if (!(line > 0) || !Number.isFinite(line)) return;
  if (!width || !height) {
    if (!width && !height) return;
    var segment = [transformedPoint(this, x, y), transformedPoint(this, x + width, y + height)];
    var drawing = Object.create(this); drawing.lineCap = 'butt';
    rasterPath(drawing, true, 'nonzero', [segment]);
    return;
  }
  var rectangle = axisAlignedRect(this, x, y, width, height);
  if (rectangle && Math.abs(this._transform[0]) === Math.abs(this._transform[3]) &&
      this.lineJoin === 'miter' && this.miterLimit === 10 &&
      !this._lineDash.length &&
      !this._clipPaths.length && this.globalCompositeOperation === 'source-over' &&
      typeof this.strokeStyle !== 'object' && NativeHost.canvas.paintRect &&
      NativeHost.canvas.paintRect(this.canvas._ensureNativeCanvas().handle,
        rectangle.x, rectangle.y, rectangle.width, rectangle.height,
        colorWithGlobalAlpha(this.strokeStyle, this.globalAlpha), line * Math.abs(this._transform[0]),
        0, 0, 0, 0, [], [])) return;
  var context = this;
  var outline = [[x, y], [x + width, y], [x + width, y + height],
    [x, y + height], [x, y]].map(function(point) {
      return transformedPoint(context, point[0], point[1]);
    });
  outline.closed = true;
  rasterPath(this, true, 'nonzero', [outline]);
};
CanvasContext2D.prototype.drawImage = function(source) {
  var nativeSource = source && (typeof source._pmjsNativeTextureSource === 'function'
    ? source._pmjsNativeTextureSource() : (source._nativeImage || source._nativeCanvas));
  if (!nativeSource && source && 'videoWidth' in source) return;
  if (!nativeSource && !(source instanceof NativeImage) &&
      !(source && typeof source._ensureNativeCanvas === 'function')) {
    throw new TypeError('drawImage source has no native resource');
  }

  var sx = 0;
  var sy = 0;
  var dimensions = canvasSourceDimensions(source);
  var sw = dimensions[0];
  var sh = dimensions[1];
  var dx;
  var dy;
  var dw;
  var dh;
  if (arguments.length === 3) {
    dx = +arguments[1]; dy = +arguments[2]; dw = sw; dh = sh;
  } else if (arguments.length === 5) {
    dx = +arguments[1]; dy = +arguments[2]; dw = +arguments[3]; dh = +arguments[4];
  } else if (arguments.length === 9) {
    sx = +arguments[1]; sy = +arguments[2]; sw = +arguments[3]; sh = +arguments[4];
    dx = +arguments[5]; dy = +arguments[6]; dw = +arguments[7]; dh = +arguments[8];
  } else {
    throw new TypeError('unsupported drawImage overload');
  }
  // HTML Canvas drawImage is a no-op if any numeric argument is NaN or infinite.
  if (!Number.isFinite(sx) || !Number.isFinite(sy) ||
      !Number.isFinite(sw) || !Number.isFinite(sh) ||
      !Number.isFinite(dx) || !Number.isFinite(dy) ||
      !Number.isFinite(dw) || !Number.isFinite(dh)) return;
  if (!sw || !sh || !dw || !dh || !dimensions[0] || !dimensions[1] ||
      !this.canvas.width || !this.canvas.height || !canvasTransformInvertible(this)) return;
  if (source._pmjsPrimitiveContent) {
    source._pmjsPrimitiveContent.materialize();
    nativeSource = source._nativeImage || source._nativeCanvas;
  }
  if (!nativeSource && typeof source._ensureNativeCanvas === 'function') {
    nativeSource = source._ensureNativeCanvas();
  }
  if (!nativeSource && source instanceof NativeImage) return;
  if (!nativeSource) throw new TypeError('drawImage source has no native resource');
  // Negative dimensions grow the rectangle backwards without reflecting pixels.
  if (sw < 0) { sx += sw; sw = -sw; }
  if (sh < 0) { sy += sh; sh = -sh; }
  if (dw < 0) { dx += dw; dw = -dw; }
  if (dh < 0) { dy += dh; dh = -dh; }
  if (!sw || !sh || !dw || !dh) return;
  var sourceWidth = nativeSource.width || source.width;
  var sourceHeight = nativeSource.height || source.height;
  var clippedLeft = Math.max(0, sx), clippedTop = Math.max(0, sy);
  var clippedRight = Math.min(sourceWidth, sx + sw);
  var clippedBottom = Math.min(sourceHeight, sy + sh);
  if (clippedRight <= clippedLeft || clippedBottom <= clippedTop) return;
  // Crop the destination proportionally, before transforming or compositing it.
  dx += (clippedLeft - sx) / sw * dw;
  dy += (clippedTop - sy) / sh * dh;
  dw *= (clippedRight - clippedLeft) / sw;
  dh *= (clippedBottom - clippedTop) / sh;
  sx = clippedLeft; sy = clippedTop;
  sw = clippedRight - clippedLeft; sh = clippedBottom - clippedTop;
  if (!this.canvas.width || !this.canvas.height || !dimensions[0] || !dimensions[1] ||
      !canvasTransformInvertible(this)) return;
  var smoothing = canvasImageSmoothing(this, sw, sh, dw, dh);
  var transformed = axisAlignedRect(this, dx, dy, dw, dh);
  if (!transformed || this._transform[0] < 0 || this._transform[3] < 0 ||
      this._clipPaths.length ||
      this.globalCompositeOperation !== 'source-over') {
    var bitmapSource = { width: dimensions[0], height: dimensions[1], _nativeCanvas: source._nativeCanvas };
    drawAffineImage(this, bitmapSource, nativeSource, sx, sy, sw, sh,
      dx, dy, dw, dh, null, smoothing);
    return;
  }
  dx = transformed.x; dy = transformed.y; dw = transformed.width; dh = transformed.height;
  var destination = this.canvas._ensureNativeCanvas();
  NativeHost.canvas.drawImage(
    destination.handle, nativeSource.handle,
    sx, sy, sw, sh, dx, dy, dw, dh,
    Math.max(0, Math.min(1, Number(this.globalAlpha))), smoothing);
};
function nativeTextStyle(context, font) {
  return { bold: font.weight >= 600, italic: font.style === 'italic' || font.style === 'oblique',
    lineJoin: context.lineJoin || 'miter', lineCap: context.lineCap || 'butt',
    miterLimit: context.miterLimit || 10 };
}
function canvasTextPosition(context, text, x, y) {
  var font = contextFont(context);
  var width = NativeHost.canvas.measureText(font.paths, String(text), font.size, nativeTextStyle(context, font));
  if (context.textAlign === 'center') x -= width / 2;
  else if (context.textAlign === 'right' || context.textAlign === 'end') x -= width;
  var baseline = context.textBaseline;
  if (baseline !== 'alphabetic' && typeof NativeHost.canvas.measureTextMetrics === 'function') {
    var metrics = NativeHost.canvas.measureTextMetrics(font.paths, String(text), font.size, nativeTextStyle(context, font));
    var ascent = Math.round(metrics.fontBoundingBoxAscent), descent = Math.round(metrics.fontBoundingBoxDescent);
    var tiny = ascent < 3 || ascent + descent < 2;
    if (tiny) { ascent = metrics.fontBoundingBoxAscent; descent = metrics.fontBoundingBoxDescent; }
    if (baseline === 'top') y += ascent;
    else if (baseline === 'hanging') y += tiny ? ascent * 0.8 : Math.floor(ascent * 80 / 100);
    else if (baseline === 'middle') y += -descent + (tiny ? (ascent + descent) / 2 : Math.floor((ascent + descent) / 2));
    else if (baseline === 'bottom' || baseline === 'ideographic') y -= descent;
  }
  return { font: font, width: width, x: x, top: y - font.size };
}

function drawCanvasText(context, text, x, y, stroke, maxWidth) {
  text = String(text);
  x = +x; y = +y;
  var suppliedWidth = maxWidth !== undefined;
  maxWidth = suppliedWidth ? +maxWidth : Infinity;
  if (!Number.isFinite(x) || !Number.isFinite(y) ||
      (suppliedWidth && !Number.isFinite(maxWidth)) || !(maxWidth > 0) ||
      !canvasTransformInvertible(context) || !context.canvas.width || !context.canvas.height) return;
  if (canvasPaintEmpty(stroke ? context.strokeStyle : context.fillStyle)) return;
  var placement = canvasTextPosition(context, text, x, y);
  var horizontalScale = placement.width > maxWidth ? maxWidth / placement.width : 1;
  if (horizontalScale < 1) {
    var removedWidth = placement.width - maxWidth;
    if (context.textAlign === 'center') placement.x += removedWidth / 2;
    else if (context.textAlign === 'right' || context.textAlign === 'end') {
      placement.x += removedWidth;
    }
  }
  var t = context._transform;
  var style = stroke ? context.strokeStyle : context.fillStyle;
  var dynamicStyle = style && typeof style === 'object';
  var color = colorWithGlobalAlpha(style, context.globalAlpha);
  var strokeWidth = stroke ? Math.max(0, usesLegacyText() ? Math.round(context.lineWidth) : Number(context.lineWidth)) : 0;
  if (!dynamicStyle && !context._clipPaths.length && context.globalCompositeOperation === 'source-over' &&
      (!usesLegacyText() || (t[0] === 1 && t[1] === 0 && t[2] === 0 && t[3] === 1 && horizontalScale === 1))) {
    var options = nativeTextStyle(context, placement.font);
    var directX = placement.x + t[4], directY = placement.top + placement.font.size + t[5];
    if (t[0] !== 1 || t[1] !== 0 || t[2] !== 0 || t[3] !== 1 || horizontalScale < 1) {
      options.transform = multiplyTransform(t, [horizontalScale, 0, 0, 1, placement.x, placement.top + placement.font.size]);
      directX = directY = 0;
    }
    NativeHost.canvas.drawText(context.canvas._ensureNativeCanvas().handle,
      placement.font.paths, text, directX, directY,
      placement.font.size, color, strokeWidth, options);
    return;
  }
  if (!usesLegacyText()) {
    var transform = horizontalScale < 1 ?
      multiplyTransform(t, [horizontalScale, 0, 0, 1, placement.x, placement.top + placement.font.size]) : t;
    var textStyle = nativeTextStyle(context, placement.font); textStyle.transform = transform;
    var mask = NativeHost.canvas.create(context.canvas.width, context.canvas.height);
    try {
      NativeHost.canvas.drawText(mask.handle, placement.font.paths, text, horizontalScale < 1 ? 0 : placement.x,
        horizontalScale < 1 ? 0 : placement.top + placement.font.size, placement.font.size, 0xffffffff, strokeWidth, textStyle);
      var drawing = Object.create(context); drawing._transform = [1, 0, 0, 1, 0, 0];
      drawing._paintTransform = transform;
      drawAffineImage(drawing, mask, mask, 0, 0, mask.width, mask.height,
        0, 0, mask.width, mask.height, style, false);
    } finally { releaseNativeResource(mask, 'canvas'); }
    return;
  }
  var padding = strokeWidth + 2;
  var temporary = NativeHost.canvas.create(
    Math.max(1, Math.ceil(Math.ceil(placement.width) + padding * 2)),
    Math.max(1, Math.ceil(placement.font.size * 2 + padding * 2)));
  try {
    NativeHost.canvas.drawText(temporary.handle, placement.font.paths, text,
      padding, padding + placement.font.size, placement.font.size,
      dynamicStyle ? 0xffffffff : colorToRgba(style), strokeWidth, nativeTextStyle(context, placement.font));
    var source = { width: temporary.width, height: temporary.height,
      _nativeCanvas: temporary };
    drawAffineImage(context, source, temporary, 0, 0, temporary.width,
      temporary.height, placement.x - padding, placement.top - padding,
      temporary.width * horizontalScale, temporary.height, dynamicStyle ? style : null);
  } finally {
    releaseNativeResource(temporary, 'canvas');
  }
}
CanvasContext2D.prototype.fillText = function(text, x, y, maxWidth) {
  drawCanvasText(this, text, x, y, false, maxWidth);
};
CanvasContext2D.prototype.strokeText = function(text, x, y, maxWidth) {
  drawCanvasText(this, text, x, y, true, maxWidth);
};
CanvasContext2D.prototype.beginPath = function() {
  this._pendingArc = null;
  this._circlePath = null;
  this._path = []; this._subpath = null; this._currentPathPoint = null;
};
CanvasContext2D.prototype.closePath = function() {
  materializeCanvasArc(this);
  if (this._subpath && this._subpath.length > 1 && !this._subpath.closed) {
    this._subpath.push(this._subpath[0].slice());
    this._subpath.closed = true;
    if (this._subpath.commands) this._subpath.commands.push(4);
    this._currentPathPoint = this._subpath[0].slice();
  }
};
CanvasContext2D.prototype.moveTo = function(x, y) {
  x = Math.fround(+x); y = Math.fround(+y);
  if (![x, y].every(Number.isFinite) || !canvasTransformInvertible(this)) return;
  materializeCanvasArc(this);
  this._circlePath = null;
  this._currentPathPoint = transformedPoint(this, Number(x), Number(y));
  this._subpath = [transformedPoint(this, Number(x), Number(y))];
  this._path.push(this._subpath);
};
CanvasContext2D.prototype.lineTo = function(x, y) {
  x = Math.fround(+x); y = Math.fround(+y);
  if (![x, y].every(Number.isFinite) || !canvasTransformInvertible(this)) return;
  materializeCanvasArc(this);
  this._circlePath = null;
  if (!this._subpath) this.moveTo(x, y);
  else {
    if (this._subpath.closed) {
      this._subpath = [this._subpath[0].slice()];
      this._path.push(this._subpath);
    }
    this._currentPathPoint = transformedPoint(this, Number(x), Number(y));
    this._subpath.push(transformedPoint(this, Number(x), Number(y)));
    if (this._subpath.commands) this._subpath.commands.push(1, this._currentPathPoint[0], this._currentPathPoint[1]);
  }
};
function appendCanvasArc(context, arc) {
  var t = arc.transform;
  if (context._subpath && context._subpath.closed) {
    context._subpath = [context._subpath[0].slice()];
    context._path.push(context._subpath);
  }
  function pointAt(angle) {
    var x = arc.x + Math.cos(angle) * arc.radius, y = arc.y + Math.sin(angle) * arc.radius;
    return [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
  }
  var startPoint = pointAt(arc.start);
  if (!context._subpath) { context._subpath = [startPoint]; context._path.push(context._subpath); }
  var path = context._subpath;
  if (!path.commands) {
    path.commands = [];
    path.forEach(function(point, index) { path.commands.push(index ? 1 : 0, point[0], point[1]); });
  }
  path.push(startPoint, pointAt(arc.start + arc.sweep));
  path.commands.push.apply(path.commands, [5, arc.x, arc.y, arc.radius, arc.start, arc.sweep].concat(t));
  var cx = t[0] * arc.x + t[2] * arc.y + t[4], cy = t[1] * arc.x + t[3] * arc.y + t[5];
  var rx = arc.radius * (Math.abs(t[0]) + Math.abs(t[2]));
  var ry = arc.radius * (Math.abs(t[1]) + Math.abs(t[3]));
  canvasPathBounds(path, [cx - rx, cy - ry]); canvasPathBounds(path, [cx + rx, cy + ry]);
  path.needsFlatten = true;
}
function materializeCanvasArc(context) {
  if (!context._pendingArc) return;
  var arc = context._pendingArc;
  context._pendingArc = null;
  appendCanvasArc(context, arc);
}
CanvasContext2D.prototype.arc = function(x, y, radius, start, end, anticlockwise) {
  radius = Math.fround(+radius);
  x = Math.fround(+x); y = Math.fround(+y); start = Math.fround(+start); end = Math.fround(+end);
  if (![x, y, radius, start, end].every(Number.isFinite)) return;
  if (radius < 0) throw canvasIndexSizeError('negative arc radius');
  if (!canvasTransformInvertible(this)) return;
  materializeCanvasArc(this);
  var difference = end - start, tau = Math.PI * 2;
  var sweep;
  if (!anticlockwise && difference >= tau) sweep = tau;
  else if (anticlockwise && difference <= -tau) sweep = -tau;
  else {
    sweep = (difference % tau + tau) % tau;
    if (!sweep && difference) sweep = anticlockwise ? -tau : tau;
    else if (anticlockwise && sweep > 0) sweep -= tau;
  }
  var arc = { x: x, y: y, radius: radius, start: start, sweep: sweep, transform: this._transform.slice() };
  this._circlePath = !this._path.length && Math.abs(sweep) >= tau ? arc : null;
  if (this._circlePath) this._pendingArc = arc;
  else appendCanvasArc(this, arc);
  this._currentPathPoint = transformedPoint(this, x + Math.cos(start + sweep) * radius,
    y + Math.sin(start + sweep) * radius);
};
CanvasContext2D.prototype.arcTo = function(x1, y1, x2, y2, radius) {
  x1 = Math.fround(+x1); y1 = Math.fround(+y1); x2 = Math.fround(+x2); y2 = Math.fround(+y2);
  radius = Math.fround(+radius);
  if (![x1, y1, x2, y2, radius].every(Number.isFinite)) return;
  if (radius < 0) throw canvasIndexSizeError('negative arcTo radius');
  if (!canvasTransformInvertible(this)) return;
  if (!this._currentPathPoint) { this.moveTo(x1, y1); return; }
  var t = this._transform, determinant = t[0] * t[3] - t[1] * t[2];
  // The raster path reports its last stored vertex after a close verb.
  var current = this._subpath && this._subpath.closed ?
    this._subpath[this._subpath.length - 2] : this._currentPathPoint;
  var px = current[0] - t[4], py = current[1] - t[5];
  var x0 = (t[3] * px - t[2] * py) / determinant;
  var y0 = (-t[1] * px + t[0] * py) / determinant;
  var firstX = x0 - x1, firstY = y0 - y1;
  var secondX = x2 - x1, secondY = y2 - y1;
  var firstLength = Math.hypot(firstX, firstY);
  var secondLength = Math.hypot(secondX, secondY);
  var cross = firstX * secondY - firstY * secondX;
  if (!radius || !firstLength || !secondLength || Math.abs(cross) < 0.000001) {
    this.lineTo(x1, y1); return;
  }
  firstX /= firstLength; firstY /= firstLength;
  secondX /= secondLength; secondY /= secondLength;
  var cosine = Math.max(-1, Math.min(1, firstX * secondX + firstY * secondY));
  var halfAngle = Math.acos(cosine) / 2;
  var tangentDistance = radius / Math.tan(halfAngle);
  var tangent1X = x1 + firstX * tangentDistance;
  var tangent1Y = y1 + firstY * tangentDistance;
  var tangent2X = x1 + secondX * tangentDistance;
  var tangent2Y = y1 + secondY * tangentDistance;
  var normalX = cross < 0 ? firstY : -firstY;
  var normalY = cross < 0 ? -firstX : firstX;
  var centerX = tangent1X + normalX * radius;
  var centerY = tangent1Y + normalY * radius;
  this.lineTo(tangent1X, tangent1Y);
  this.arc(centerX, centerY, radius,
    Math.atan2(tangent1Y - centerY, tangent1X - centerX),
    Math.atan2(tangent2Y - centerY, tangent2X - centerX), cross > 0);
};
CanvasContext2D.prototype.ellipse = function(x, y, radiusX, radiusY, rotation, start, end) {
  materializeCanvasArc(this);
  if (arguments.length < 7) throw new TypeError('ellipse requires seven arguments');
  // The reference canvas path stores float geometry, including its angles.
  x = Math.fround(+x); y = Math.fround(+y);
  radiusX = Math.fround(+radiusX); radiusY = Math.fround(+radiusY);
  rotation = Math.fround(+rotation); start = Math.fround(+start); end = Math.fround(+end);
  var anticlockwise = !!arguments[7];
  if (![x, y, radiusX, radiusY, rotation, start, end].every(Number.isFinite)) return;
  if (radiusX < 0 || radiusY < 0) {
    if (typeof DOMException === 'function') throw new DOMException('negative ellipse radius', 'IndexSizeError');
    var error = new Error('negative ellipse radius');
    error.name = 'IndexSizeError'; error.code = 1;
    throw error;
  }
  var transform = this._transform;
  if (transform[0] * transform[3] - transform[1] * transform[2] === 0) return;
  var tau = Math.fround(Math.PI * 2), quarter = Math.PI / 2;
  var normalizedStart = Math.fround(start % tau);
  if (normalizedStart < 0) {
    normalizedStart = Math.fround(normalizedStart + tau);
    if (normalizedStart >= tau) normalizedStart = Math.fround(normalizedStart - tau);
  }
  end = Math.fround(end + Math.fround(normalizedStart - start)); start = normalizedStart;
  var difference = Math.fround(end - start), sweep;
  if (!anticlockwise && difference >= tau) sweep = tau;
  else if (anticlockwise && -difference >= tau) sweep = -tau;
  else if (!anticlockwise && start > end) sweep = tau - Math.fround((start - end) % tau);
  else if (anticlockwise && start < end) sweep = -(tau - Math.fround((end - start) % tau));
  else sweep = difference;
  var cosine = Math.cos(rotation), sine = Math.sin(rotation);
  var ellipseTransform = multiplyTransform(transform,
    [cosine * radiusX, sine * radiusX, -sine * radiusY, cosine * radiusY, x, y]);
  // Skia treats float sweeps within 1/4096 degree of a turn as a full oval.
  var sweepDegrees = Math.fround(Math.fround(Math.fround(sweep) * 180) / Math.fround(Math.PI));
  var fullTurn = Math.abs(Math.abs(sweepDegrees) - 360) <= 1 / 4096;
  this._circlePath = !this._path.length && radiusX && radiusY && fullTurn ?
    { x: 0, y: 0, radius: 1, transform: ellipseTransform } : null;
  var context = this;
  function append(angle) {
    var u = radiusX * Math.cos(angle), v = radiusY * Math.sin(angle);
    var local = [x + cosine * u - sine * v, y + sine * u + cosine * v];
    var point = transformedPoint(context, local[0], local[1]);
    if (!context._subpath) { context._subpath = [point]; context._path.push(context._subpath); }
    else context._subpath.push(point);
    if (context._subpath.commands) context._subpath.commands.push(1, point[0], point[1]);
    context._currentPathPoint = point.slice();
  }
  append(start);
  if (!sweep || (!radiusX && !radiusY)) return;
  if (!radiusX || !radiusY) {
    // A collapsed ellipse still traverses its extrema before reaching the end.
    var direction = sweep < 0 ? -1 : 1;
    var extremum = (direction > 0 ? Math.floor(start / quarter) + 1 : Math.ceil(start / quarter) - 1) * quarter;
    for (; direction * (start + sweep - extremum) > 0; extremum += direction * quarter) append(extremum);
  } else {
    var extent = Math.hypot(ellipseTransform[0], ellipseTransform[1]) +
      Math.hypot(ellipseTransform[2], ellipseTransform[3]);
    // Bound polygon work for huge radii; ordinary paths target subpixel chords.
    var segments = Math.min(8192, Math.max(4, Math.ceil(Math.abs(sweep) * Math.sqrt(extent * 2))));
    for (var index = 1; index < segments; index++) append(start + sweep * index / segments);
  }
  append(start + sweep);
};
CanvasContext2D.prototype.rect = function(x, y, width, height) {
  x = Math.fround(+x); y = Math.fround(+y); width = Math.fround(+width); height = Math.fround(+height);
  if (![x, y, width, height].every(Number.isFinite) || !canvasTransformInvertible(this)) return;
  this.moveTo(x, y); this.lineTo(x + width, y); this.lineTo(x + width, y + height);
  this.lineTo(x, y + height); this.closePath();
};
CanvasContext2D.prototype.clip = function(rule) {
  materializeCanvasArc(this);
  rule = rule === undefined ? 'nonzero' : String(rule);
  if (rule !== 'nonzero' && rule !== 'evenodd') throw new TypeError('invalid fill rule');
  if (!canvasTransformInvertible(this)) return;
  this._clipPaths.push({ rule: rule, paths: this._path.map(function(path) {
    canvasFlattenPath(path);
    return path.map(function(point) { return point.slice(); });
  }) });
};
CanvasContext2D.prototype.fill = function(rule) {
  rule = rule === undefined ? 'nonzero' : String(rule);
  if (rule !== 'nonzero' && rule !== 'evenodd') throw new TypeError('invalid fill rule');
  rasterPath(this, false, rule);
};
CanvasContext2D.prototype.stroke = function() { rasterPath(this, true, 'nonzero'); };
function CanvasGradient() {
  this.stops = [];
}
CanvasGradient.prototype.addColorStop = function(offset, color) {
  offset = Number(offset);
  if (!isFinite(offset) || offset < 0 || offset > 1) throw new RangeError('invalid color stop');
  if (parseCanvasColor(color) === null) throw new SyntaxError('Invalid color');
  this.stops.push({ offset: offset, color: color });
  this.stops.sort(function(left, right) { return left.offset - right.offset; });
};
globalThis.CanvasGradient = CanvasGradient;

CanvasContext2D.prototype.createLinearGradient = function() {
  var first = [Number(arguments[0]), Number(arguments[1])];
  var second = [Number(arguments[2]), Number(arguments[3])];
  if (!first.concat(second).every(Number.isFinite)) throw new TypeError('invalid linear gradient');
  return Object.assign(new CanvasGradient(), { _pmjsStyle: 'linear-gradient',
    x0: first[0], y0: first[1], x1: second[0], y1: second[1] });
};
CanvasContext2D.prototype.createRadialGradient = function(x0, y0, r0, x1, y1, r1) {
  x0 = Number(x0); y0 = Number(y0); r0 = Number(r0);
  x1 = Number(x1); y1 = Number(y1); r1 = Number(r1);
  if (![x0, y0, r0, x1, y1, r1].every(Number.isFinite)) {
    throw new TypeError('invalid radial gradient');
  }
  if (r0 < 0 || r1 < 0) throw canvasIndexSizeError('negative radial gradient radius');
  return Object.assign(new CanvasGradient(), { _pmjsStyle: 'radial-gradient', x0: x0, y0: y0, r0: r0,
    x1: x1, y1: y1, r1: r1,
    nativeConcentric: x0 === x1 && y0 === y1 && r1 > r0 });
};
CanvasContext2D.prototype.createPattern = function(source, repetition) {
  if (source && source._pmjsPrimitiveContent) source._pmjsPrimitiveContent.materialize();
  var dimensions = canvasSourceDimensions(source);
  if (!dimensions[0] || !dimensions[1]) {
    if (source && typeof source._ensureNativeCanvas === 'function') {
      if (typeof DOMException === 'function') throw new DOMException('empty pattern source', 'InvalidStateError');
      var error = new Error('empty pattern source'); error.name = 'InvalidStateError'; error.code = 11; throw error;
    }
    return null;
  }
  var nativeSource = source && (typeof source._pmjsNativeTextureSource === 'function'
    ? source._pmjsNativeTextureSource() : (source._nativeImage || source._nativeCanvas));
  if (!nativeSource && source && typeof source._ensureNativeCanvas === 'function') {
    nativeSource = source._ensureNativeCanvas();
  }
  if (!nativeSource || !dimensions[0] || !dimensions[1]) return null;
  repetition = repetition || 'repeat';
  if (['repeat', 'repeat-x', 'repeat-y', 'no-repeat'].indexOf(repetition) < 0) {
    throw new TypeError('invalid pattern repetition');
  }
  var pattern = { _pmjsStyle: 'pattern', repeat: repetition,
    width: dimensions[0], height: dimensions[1],
    pixels: canvasSourcePixels(source, nativeSource, { x: 0, y: 0, width: dimensions[0], height: dimensions[1] }), transform: [1, 0, 0, 1, 0, 0],
    setTransform: function(matrix) {
      matrix = matrix || {};
      var values = [matrix.a === undefined ? 1 : Number(matrix.a), Number(matrix.b) || 0,
        Number(matrix.c) || 0, matrix.d === undefined ? 1 : Number(matrix.d),
        Number(matrix.e) || 0, Number(matrix.f) || 0];
      if (!values.every(Number.isFinite)) throw new TypeError('invalid pattern transform');
      this.transform = values;
    } };
  if (canvasReferenceEngine() === 'mv') delete pattern.setTransform;
  return pattern;
};
function measureCanvasText(font, text, style) {
  return NativeHost.canvas.measureTextMetrics(font.paths, text, font.size, style);
}
CanvasContext2D.prototype.measureText = function(text) {
  var font = contextFont(this);
  return measureCanvasText(font, String(text), nativeTextStyle(this, font));
};
function canvasImageDataInteger(value) {
  return +value | 0;
}
function canvasImageDataSize(width, height) {
  if (!width || !height) {
    if (typeof DOMException === 'function') throw new DOMException('zero ImageData dimension', 'IndexSizeError');
    var error = new Error('zero ImageData dimension'); error.name = 'IndexSizeError'; error.code = 1; throw error;
  }
  return [Math.abs(width), Math.abs(height)];
}
CanvasContext2D.prototype.createImageData = function(width, height) {
  if (arguments.length === 1) {
    if (!(width instanceof ImageData)) throw new TypeError('invalid ImageData');
    height = width.height; width = width.width;
  } else {
    if (arguments.length < 2) throw new TypeError('createImageData requires two dimensions');
    width = canvasImageDataInteger(width); height = canvasImageDataInteger(height);
  }
  var size = canvasImageDataSize(width, height);
  return new ImageData(size[0], size[1]);
};
CanvasContext2D.prototype.getImageData = function(x, y, width, height) {
  if (arguments.length < 4) throw new TypeError('getImageData requires four arguments');
  x = canvasImageDataInteger(x); y = canvasImageDataInteger(y);
  width = canvasImageDataInteger(width); height = canvasImageDataInteger(height);
  if (width < 0) x += width;
  if (height < 0) y += height;
  var size = canvasImageDataSize(width, height);
  width = size[0]; height = size[1];
  if (!this.canvas.width || !this.canvas.height) return new ImageData(width, height);
  var canvas = this.canvas._ensureNativeCanvas();
  var pixels = NativeHost.canvas.readPixels(canvas.handle, x, y, width, height);
  return new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), width, height);
};
CanvasContext2D.prototype.putImageData = function(imageData, x, y) {
  if (!imageData || !imageData.data) throw new TypeError('invalid ImageData');
  x = canvasImageDataInteger(x); y = canvasImageDataInteger(y);
  var sourceX = arguments.length >= 7 ? canvasImageDataInteger(arguments[3]) : 0;
  var sourceY = arguments.length >= 7 ? canvasImageDataInteger(arguments[4]) : 0;
  var width = arguments.length >= 7 ? canvasImageDataInteger(arguments[5]) : imageData.width;
  var height = arguments.length >= 7 ? canvasImageDataInteger(arguments[6]) : imageData.height;
  if (width < 0) { sourceX += width; width = -width; }
  if (height < 0) { sourceY += height; height = -height; }
  var right = Math.min(imageData.width, sourceX + width);
  var bottom = Math.min(imageData.height, sourceY + height);
  sourceX = Math.max(0, sourceX);
  sourceY = Math.max(0, sourceY);
  width = right - sourceX;
  height = bottom - sourceY;
  if (width <= 0 || height <= 0 || !this.canvas.width || !this.canvas.height) return;
  var pixels = imageData.data;
  if (sourceX !== 0 || sourceY !== 0 || width !== imageData.width ||
      height !== imageData.height) {
    pixels = new Uint8ClampedArray(width * height * 4);
    for (var row = 0; row < height; row++) {
      var start = ((sourceY + row) * imageData.width + sourceX) * 4;
      pixels.set(imageData.data.subarray(start, start + width * 4), row * width * 4);
    }
  }
  var canvas = this.canvas._ensureNativeCanvas();
  NativeHost.canvas.writePixels(canvas.handle, x + sourceX,
    y + sourceY, width, height, pixels);
};

function canvasShadowSourceBounds(context, args, method) {
  var points = [], rectangle;
  if (method === 'fillRect' || method === 'strokeRect') rectangle = Array.prototype.slice.call(args, 0, 4);
  else if (method === 'drawImage' && (args.length === 5 || args.length === 9))
    rectangle = Array.prototype.slice.call(args, args.length - 4);
  else if (method === 'fill' || method === 'stroke') {
    context._path.forEach(function(path) {
      path.forEach(function(point) { points.push(point); });
      if (path.bounds) path.bounds.forEach(function(point) { points.push(point); });
    });
    var arc = context._pendingArc;
    if (arc) {
      var t = arc.transform, cx = t[0] * arc.x + t[2] * arc.y + t[4], cy = t[1] * arc.x + t[3] * arc.y + t[5];
      var rx = arc.radius * (Math.abs(t[0]) + Math.abs(t[2])), ry = arc.radius * (Math.abs(t[1]) + Math.abs(t[3]));
      points.push([cx - rx, cy - ry], [cx + rx, cy + ry]);
    }
  } else return null;
  if (rectangle) {
    if (rectangle.length !== 4 || !rectangle.every(Number.isFinite)) return null;
    for (var corner = 0; corner < 4; corner++) points.push(transformedPoint(context,
      rectangle[0] + (corner & 1 ? rectangle[2] : 0), rectangle[1] + (corner & 2 ? rectangle[3] : 0)));
  }
  if (!points.length) return null;
  var bounds = [Infinity, Infinity, -Infinity, -Infinity];
  points.forEach(function(point) {
    bounds[0] = Math.min(bounds[0], point[0]); bounds[1] = Math.min(bounds[1], point[1]);
    bounds[2] = Math.max(bounds[2], point[0]); bounds[3] = Math.max(bounds[3], point[1]);
  });
  var padding = 2;
  if (/^stroke/.test(method)) {
    var transform = context._transform;
    padding += context.lineWidth * Math.max(1, context.lineJoin === 'miter' ? context.miterLimit : 1) *
      (Math.hypot(transform[0], transform[1]) + Math.hypot(transform[2], transform[3])) / 2;
  }
  return [Math.floor(bounds[0] - padding), Math.floor(bounds[1] - padding),
    Math.ceil(bounds[2] + padding), Math.ceil(bounds[3] + padding)];
}

function drawCanvasShadow(context, draw, args, method) {
  if (!context.canvas.width || !context.canvas.height || !canvasTransformInvertible(context)) return;
  var geometryMask = method !== 'drawImage';
  var source = args[0];
  var opaqueImage = !geometryMask && source && (source._context2d && source._context2d._alpha === false ||
    source._nativeImage && NativeHost.images.isOpaque(source._nativeImage.handle));
  // Capture only geometry that can contribute to the destination after shifting and blurring.
  // The mask and image blur implementations clamp sigma to different finite limits.
  var sigma = context.shadowBlur ? 0.288675 * context.shadowBlur + 0.5 : 0;
  var margin = Math.ceil(Math.min(sigma, geometryMask || opaqueImage ? 136 : 532) * 3) + 2;
  // Geometry loopers translate before rasterization; image filters translate the captured pixels.
  var geometryOffsetX = geometryMask || opaqueImage ? context.shadowOffsetX : 0;
  var geometryOffsetY = geometryMask || opaqueImage ? context.shadowOffsetY : 0;
  var filterOffsetX = context.shadowOffsetX - geometryOffsetX;
  var filterOffsetY = context.shadowOffsetY - geometryOffsetY;
  var originX = Math.floor(-filterOffsetX) - margin;
  var originY = Math.floor(-filterOffsetY) - margin;
  var right = Math.ceil(context.canvas.width - filterOffsetX) + margin;
  var bottom = Math.ceil(context.canvas.height - filterOffsetY) + margin;
  var bounds = canvasShadowSourceBounds(context, args, method);
  if (bounds && bounds.every(Number.isFinite)) {
    if (opaqueImage && (bounds[2] - 2 <= 0 || bounds[3] - 2 <= 0 ||
        bounds[0] + 2 >= context.canvas.width || bounds[1] + 2 >= context.canvas.height)) return;
    originX = Math.max(originX, Math.floor(bounds[0] + geometryOffsetX));
    originY = Math.max(originY, Math.floor(bounds[1] + geometryOffsetY));
    right = Math.min(right, Math.ceil(bounds[2] + geometryOffsetX));
    bottom = Math.min(bottom, Math.ceil(bounds[3] + geometryOffsetY));
  }
  if (right <= originX || bottom <= originY) {
    if (['source-in', 'source-out', 'destination-in', 'destination-atop'].indexOf(context.globalCompositeOperation) < 0) return;
    // An empty shadow still participates in full-canvas compositing.
    right = originX + 1; bottom = originY + 1;
  }
  var shiftX = geometryOffsetX - originX, shiftY = geometryOffsetY - originY;
  var mask = new CanvasElement();
  mask.width = right - originX; mask.height = bottom - originY;
  var drawing = Object.create(context); drawing.canvas = mask;
  drawing._transform = multiplyTransform([1, 0, 0, 1, shiftX, shiftY], context._transform);
  drawing._clipPaths = []; drawing.globalAlpha = 1;
  drawing.globalCompositeOperation = 'source-over'; drawing.shadowColor = 'transparent';
  // Image filters blur premultiplied alpha; geometry shadows blur coverage.
  if (!geometryMask && !opaqueImage) drawing.globalAlpha = context.globalAlpha;
  var shadowStyle = /^stroke/.test(method) ? context.strokeStyle : context.fillStyle;
  if (geometryMask && canvasPaintEmpty(shadowStyle)) return;
  var shadowPaint = geometryMask ? canvasNativePaint(shadowStyle, drawing) : null;
  if (geometryMask) drawing.fillStyle = drawing.strokeStyle = 'white';
  drawing._path = context._path.map(function(path) {
    var shifted = path.map(function(point) { return [point[0] + shiftX, point[1] + shiftY]; });
    shifted.closed = path.closed;
    shifted.needsFlatten = path.needsFlatten;
    if (path.bounds) shifted.bounds = path.bounds.map(function(point) { return [point[0] + shiftX, point[1] + shiftY]; });
    if (path.commands) {
      shifted.commands = path.commands.slice();
      for (var i = 0; i < shifted.commands.length;) {
        var verb = shifted.commands[i++], count = verb === 5 ? 11 : verb === 4 ? 0 : verb === 3 ? 6 : verb === 2 ? 4 : 2;
        if (verb === 5) { shifted.commands[i + 9] += shiftX; shifted.commands[i + 10] += shiftY; i += count; }
        else for (var end = i + count; i < end; i += 2) {
          shifted.commands[i] += shiftX; shifted.commands[i + 1] += shiftY;
        }
      }
    }
    return shifted;
  });
  drawing._subpath = null;
  ['_circlePath', '_pendingArc'].forEach(function(key) {
    if (context[key]) {
      drawing[key] = Object.assign({}, context[key]);
      drawing[key].transform = multiplyTransform([1, 0, 0, 1, shiftX, shiftY], context[key].transform);
    }
  });
  try {
    draw.apply(drawing, args);
    if (!mask._nativeCanvas) return;
    var shadow = {
      x: filterOffsetX + originX, y: filterOffsetY + originY,
      blur: context.shadowBlur, color: colorToRgba(context.shadowColor),
      globalAlpha: geometryMask || opaqueImage ? context.globalAlpha : 1,
      composite: context.globalCompositeOperation, clips: context._clipPaths
    };
    if (geometryMask) shadow.paint = shadowPaint;
    var operation = context.globalCompositeOperation;
    if (opaqueImage) shadow.paint = {kind: 'solid', color: 0xffffffff};
    var grouped = !geometryMask && operation !== 'source-over' && operation !== 'copy' &&
      operation !== 'source-in' && operation !== 'source-out' &&
      operation !== 'destination-in' && operation !== 'destination-atop' && !opaqueImage;
    if (grouped) {
      // Translucent image shadows merge with the foreground before blending.
      // Opaque images and full-canvas composite modes use separate passes.
      var group = new CanvasElement();
      group.width = context.canvas.width; group.height = context.canvas.height;
      try {
        shadow.composite = 'source-over'; shadow.clips = [];
        NativeHost.canvas.paintShadow(group._ensureNativeCanvas().handle, mask._nativeCanvas.handle, shadow);
        var foreground = Object.create(context); foreground.canvas = group;
        foreground._clipPaths = []; foreground.globalCompositeOperation = 'source-over';
        draw.apply(foreground, args);
        var composition = Object.create(context); composition._transform = [1, 0, 0, 1, 0, 0];
        composition.globalAlpha = 1; composition.imageSmoothingEnabled = false;
        draw.call(composition, group, 0, 0);
        return true;
      } finally { group._releaseNativeCanvas(); }
    }
    NativeHost.canvas.paintShadow(context.canvas._ensureNativeCanvas().handle, mask._nativeCanvas.handle, shadow);
  } finally { mask._releaseNativeCanvas(); }
}

[
  'clearRect', 'fillRect', 'strokeRect', 'drawImage', 'fillText', 'strokeText',
  'fill', 'stroke', 'putImageData'
].forEach(function(method) {
  var mutate = CanvasContext2D.prototype[method];
  CanvasContext2D.prototype[method] = function() {
    try {
      if (method !== 'clearRect' && method !== 'putImageData' && (colorToRgba(this.shadowColor) & 255) &&
          this.globalCompositeOperation !== 'copy' && (this.shadowBlur || this.shadowOffsetX || this.shadowOffsetY) &&
          drawCanvasShadow(this, mutate, arguments, method)) return;
      return mutate.apply(this, arguments);
    } finally {
      if (this.canvas && typeof this.canvas._pmjsContentChanged === 'function') {
        this.canvas._pmjsContentChanged();
      }
    }
  };
});


globalThis.PMJS = globalThis.PMJS || {};
PMJS.web = PMJS.web || {};
PMJS.web.canvas = PMJS.web.canvas || {};

function canvasIsUntransformedSourceOver(context) {
  var transform = context && context._transform;
  return !!(transform && transform.length === 6 &&
    transform[0] === 1 && transform[1] === 0 && transform[2] === 0 &&
    transform[3] === 1 && transform[4] === 0 && transform[5] === 0 &&
    !(context._clipPaths && context._clipPaths.length) &&
    !((colorToRgba(context.shadowColor) & 255) && (context.shadowBlur || context.shadowOffsetX || context.shadowOffsetY)) &&
    context.globalCompositeOperation === 'source-over');
}

var mvBlurCanvasMethods = ['drawImage', 'fillRect', 'save', 'restore'].map(function(name) {
  return { name: name, method: CanvasContext2D.prototype[name] };
});
var nativeTextCanvasMethods = ['fillText', 'strokeText', 'save', 'restore'].map(function(name) {
  return { name: name, method: CanvasContext2D.prototype[name] };
});

var batchDrawImageMethod = CanvasContext2D.prototype.drawImage;

Object.assign(PMJS.web.canvas, {
  drawImageBatch: function(context, source, rectangles) {
    if (!canvasIsUntransformedSourceOver(context) || context.drawImage !== batchDrawImageMethod ||
        !(source instanceof CanvasElement) || typeof NativeHost.canvas.drawImageBatch !== 'function' ||
        !context.canvas.width || !context.canvas.height || !Number.isFinite(context.globalAlpha)) return false;
    if (rectangles.length % 8 || rectangles.length > 8 * 4096) return false;
    var rows = new Float32Array(rectangles.length / 8 * 9);
    for (var i = 0, out = 0; i < rectangles.length; i += 8, out += 9) {
      for (var j = 0; j < 8; j++) {
        var value = rectangles[i + j];
        if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) return false;
        rows[out + j] = value;
      }
      if (rows[out] < 0 || rows[out+1] < 0 || rows[out+2] <= 0 || rows[out+3] <= 0 ||
          rows[out+6] <= 0 || rows[out+7] <= 0 ||
          rows[out] + rows[out+2] > source.width || rows[out+1] + rows[out+3] > source.height) return false;
      rows[out+8] = canvasImageSmoothing(context, rows[out+2], rows[out+3], rows[out+6], rows[out+7]) ? 1 : 0;
    }
    if (source._pmjsPrimitiveContent) source._pmjsPrimitiveContent.materialize();
    var nativeSource = typeof source._pmjsNativeTextureSource === 'function'
      ? source._pmjsNativeTextureSource() : source._nativeCanvas;
    if (!nativeSource) nativeSource = source._ensureNativeCanvas();
    try {
      NativeHost.canvas.drawImageBatch(context.canvas._ensureNativeCanvas().handle,
        nativeSource.handle, rows, Math.max(0, Math.min(1, context.globalAlpha)));
    } finally { context.canvas._pmjsContentChanged(); }
    return true;
  },
  blur: function(canvas) {
    NativeHost.canvas.blur(canvas._ensureNativeCanvas().handle);
  },
  blurMv: function(context) {
    if (!canvasIsUntransformedSourceOver(context) || context.globalAlpha !== 1 ||
        typeof NativeHost.canvas.blurMv !== 'function' ||
        !mvBlurCanvasMethods.every(function(entry) {
          return context[entry.name] === entry.method;
        })) return false;
    return NativeHost.canvas.blurMv(context.canvas._ensureNativeCanvas().handle);
  },
  readPixel: function(canvas, context, x, y) {
    if (canvas && (!canvas.width || !canvas.height)) return [0, 0, 0, 0];
    if (canvas && canvas._nativeCanvas) {
      x = canvasImageDataInteger(x);
      y = canvasImageDataInteger(y);
      if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return [0, 0, 0, 0];
      var rgba = NativeHost.canvas.pixel(canvas._ensureNativeCanvas().handle, x, y);
      return [(rgba >>> 24) & 255, (rgba >>> 16) & 255,
        (rgba >>> 8) & 255, rgba & 255];
    }
    if (context && typeof context.getImageData === 'function') {
      return context.getImageData(x, y, 1, 1).data;
    }
    return null;
  },
  supportsNativeText: function(context, maxWidth, align, style) {
    return context instanceof CanvasContext2D && context.canvas instanceof CanvasElement &&
      canvasIsUntransformedSourceOver(context) && nativeTextCanvasMethods.every(function(entry) {
        return context[entry.name] === entry.method;
      }) &&
      (!style || [style.outlineColor, style.color].every(function(color) {
        return typeof color === 'string' && parseCanvasColor(color) !== null;
      })) &&
      (!(maxWidth || (align && align !== 'left')) ||
        (!usesLegacyText() && typeof NativeHost.canvas.drawOutlinedText === 'function'));
  },
  drawNativeText: function(context, text, x, baseline, style) {
    var font = contextFont(style.font);
    var canvas = context.canvas._ensureNativeCanvas();
    var options = nativeTextStyle(context, font);
    options.lineJoin = 'round'; // MV Bitmap._drawTextOutline sets this before stroking.
    var outlineWidth = +style.outlineWidth;
    if (!Number.isFinite(outlineWidth) || !(outlineWidth > 0)) outlineWidth = context.lineWidth;
    if (!usesLegacyText() && typeof NativeHost.canvas.drawOutlinedText === 'function') {
      var maxWidth = style.maxWidth || 0xffffffff;
      if (!(maxWidth > 0)) return;
      NativeHost.canvas.drawOutlinedText(canvas.handle, font.paths, text, x, baseline,
        font.size, colorWithGlobalAlpha(style.outlineColor, 1), outlineWidth,
        colorWithGlobalAlpha(style.color, context.globalAlpha), maxWidth, style.align || 'left', options);
      return;
    }
    NativeHost.canvas.drawText(canvas.handle, font.paths, text,
      x, baseline, font.size, colorWithGlobalAlpha(style.outlineColor, 1),
      outlineWidth, options);
    NativeHost.canvas.drawText(canvas.handle, font.paths, text,
      x, baseline, font.size,
      colorWithGlobalAlpha(style.color, context.globalAlpha), 0, options);
  },
  measureTextWidth: function(text, descriptor) {
    var font = contextFont(descriptor);
    return NativeHost.canvas.measureText(font.paths, String(text), font.size, nativeTextStyle({}, font));
  }
});

['blur', 'blurMv', 'drawNativeText'].forEach(function(name) {
  var mutate = PMJS.web.canvas[name];
  PMJS.web.canvas[name] = function(target) {
    var result;
    try {
      result = mutate.apply(this, arguments);
      return result;
    } finally {
      var canvas = name === 'blur' ? target : target && target.canvas;
      if (result !== false && canvas && canvas._pmjsContentChanged) canvas._pmjsContentChanged();
    }
  };
});

// A full opaque red-channel fill proves unit weight for the sprite mask shader.
// Keep proof state private; consumers receive only a validated rectangle.
(function() {
  var maskProofs = new WeakMap();
  var maskFillMethods = ['fillRect', 'save', 'restore'].map(function(name) {
    return { name: name, method: CanvasContext2D.prototype[name] };
  });
  PMJS.web.canvas.trackMaskFill = function(context, x, y, width, height, color, draw) {
    var canvas = context && context.canvas;
    var eligible = context instanceof CanvasContext2D && canvas instanceof CanvasElement &&
      maskFillMethods.every(function(entry) { return context[entry.name] === entry.method; }) &&
      Number.isFinite(canvas.__pmjsContentRevision) &&
      Number(x) === 0 && Number(y) === 0 &&
      Number(width) === canvas.width && Number(height) === canvas.height &&
      Number(context.globalAlpha) === 1 &&
      canvasIsUntransformedSourceOver(context);
    if (eligible) {
      var rgba = colorToRgba(color);
      eligible = ((rgba >>> 24) & 255) === 255 && (rgba & 255) === 255;
    }
    var result = draw();
    if (eligible) {
      maskProofs.set(canvas, { width: Number(width), height: Number(height),
        revision: canvas.__pmjsContentRevision });
    }
    return result;
  };
  PMJS.web.canvas.unitMaskRect = function(canvas) {
    var proof = canvas && maskProofs.get(canvas);
    if (!proof) return null;
    if (proof.revision !== canvas.__pmjsContentRevision ||
        proof.width !== canvas.width || proof.height !== canvas.height) {
      maskProofs.delete(canvas);
      return null;
    }
    return { x: 0, y: 0, width: proof.width, height: proof.height };
  };
})();
