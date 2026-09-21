function CanvasContext2D(canvas) {
  this.canvas = canvas;
  this.fillStyle = '#000000';
  this.strokeStyle = '#000000';
  this.globalAlpha = 1;
  this.globalCompositeOperation = 'source-over';
  this.font = '10px sans-serif';
  this.textAlign = 'start';
  this.textBaseline = 'alphabetic';
  this.lineWidth = 1;
  this._transform = [1, 0, 0, 1, 0, 0];
  this._stateStack = [];
  this._path = [];
  this._subpath = null;
  this._clipPaths = [];
}

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
  if (Math.abs(t[1]) > 0.000001 || Math.abs(t[2]) > 0.000001) return null;
  var x0 = t[0] * x + t[4];
  var y0 = t[3] * y + t[5];
  var x1 = t[0] * (x + width) + t[4];
  var y1 = t[3] * (y + height) + t[5];
  return { x: Math.min(x0, x1), y: Math.min(y0, y1),
    width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

function canvasSourcePixels(source, nativeSource, operationId) {
  var trace = globalThis.__pmjsTrace;
  var sourceResource = trace && trace.active() ?
    trace.revision(nativeSource, source && source._nativeCanvas ? 'canvas' : 'image') : null;
  if (source && source._nativeCanvas) {
    var canvasPixels = NativeHost.canvas.readPixels(nativeSource.handle, 0, 0,
      source.width, source.height);
    if (trace && trace.active()) trace.event('canvas', 'canvas.source-read', {
      parentOperationId: operationId, sourceId: sourceResource.id,
      sourceRevision: sourceResource.revision, width: source.width,
      height: source.height, bytes: canvasPixels.length, temporary: false
    });
    return canvasPixels;
  }
  var temporary = NativeHost.canvas.create(source.width, source.height);
  try {
    NativeHost.canvas.drawImage(temporary.handle, nativeSource.handle,
      0, 0, source.width, source.height, 0, 0, source.width, source.height, 1);
    var imagePixels = NativeHost.canvas.readPixels(temporary.handle, 0, 0,
      source.width, source.height);
    if (trace && trace.active()) trace.event('canvas', 'canvas.source-read', {
      parentOperationId: operationId, sourceId: sourceResource.id,
      sourceRevision: sourceResource.revision, width: source.width,
      height: source.height, bytes: imagePixels.length, temporary: true,
      temporaryWidth: source.width, temporaryHeight: source.height
    });
    return imagePixels;
  } finally {
    releaseNativeResource(temporary, 'canvas');
  }
}

function compositeCanvasPixel(pixels, offset, sourceColors, sourceAlpha, operation) {
  var destinationAlpha = pixels[offset + 3] / 255;
  var outputAlpha;
  var output = [0, 0, 0];
  operation = operation || 'source-over';
  if (operation === 'copy') {
    outputAlpha = sourceAlpha;
    output = sourceColors;
  } else if (operation === 'destination-in') {
    outputAlpha = destinationAlpha * sourceAlpha;
    output = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
  } else if (operation === 'source-atop') {
    outputAlpha = destinationAlpha;
    for (var atopChannel = 0; atopChannel < 3; atopChannel++) {
      output[atopChannel] = destinationAlpha <= 0 ? 0 :
        sourceColors[atopChannel] * sourceAlpha +
        pixels[offset + atopChannel] * (1 - sourceAlpha);
    }
  } else {
    outputAlpha = operation === 'lighter'
      ? Math.min(1, sourceAlpha + destinationAlpha)
      : sourceAlpha + destinationAlpha * (1 - sourceAlpha);
    for (var channel = 0; channel < 3; channel++) {
      var source = sourceColors[channel];
      var destination = pixels[offset + channel];
      var blended = source;
      if (operation === 'difference') blended = Math.abs(destination - source);
      else if (operation === 'saturation') {

        var gray = pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 +
          pixels[offset + 2] * 0.114;
        blended = gray;
      }
      var premultiplied = operation === 'lighter'
        ? source * sourceAlpha + destination * destinationAlpha
        : blended * sourceAlpha * destinationAlpha +
          source * sourceAlpha * (1 - destinationAlpha) +
          destination * destinationAlpha * (1 - sourceAlpha);
      output[channel] = outputAlpha <= 0 ? 0 : premultiplied / outputAlpha;
    }
  }
  for (var outputChannel = 0; outputChannel < 3; outputChannel++) {
    pixels[offset + outputChannel] = Math.max(0, Math.min(255,
      Math.round(output[outputChannel])));
  }
  pixels[offset + 3] = Math.max(0, Math.min(255, Math.round(outputAlpha * 255)));
}

function drawAffineImage(context, source, nativeSource, sx, sy, sw, sh,
    dx, dy, dw, dh, operationId) {
  var t = context._transform;
  var determinant = t[0] * t[3] - t[1] * t[2];
  if (Math.abs(determinant) < 0.000001) return;
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
  if (right <= left || bottom <= top) return;
  var sourcePixels = canvasSourcePixels(source, nativeSource, operationId);
  var destination = context.canvas._ensureNativeCanvas();
  var destinationPixels = NativeHost.canvas.readPixels(destination.handle,
    left, top, right - left, bottom - top);
  var inverseA = t[3] / determinant, inverseB = -t[1] / determinant;
  var inverseC = -t[2] / determinant, inverseD = t[0] / determinant;
  var alpha = Math.max(0, Math.min(1, Number(context.globalAlpha)));
  for (var y = top; y < bottom; y++) for (var x = left; x < right; x++) {
    var shiftedX = x + 0.5 - t[4], shiftedY = y + 0.5 - t[5];
    var localX = inverseA * shiftedX + inverseC * shiftedY;
    var localY = inverseB * shiftedX + inverseD * shiftedY;
    var u = (localX - dx) / dw, v = (localY - dy) / dh;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
    var sampleX = Math.max(0, Math.min(source.width - 1, Math.floor(sx + u * sw)));
    var sampleY = Math.max(0, Math.min(source.height - 1, Math.floor(sy + v * sh)));
    var sourceOffset = (sampleY * source.width + sampleX) * 4;
    var destinationOffset = ((y - top) * (right - left) + x - left) * 4;
    if (!passesCanvasClip(context, x + 0.5, y + 0.5)) continue;
    var sourceAlpha = sourcePixels[sourceOffset + 3] / 255 * alpha;
    compositeCanvasPixel(destinationPixels, destinationOffset,
      [sourcePixels[sourceOffset], sourcePixels[sourceOffset + 1],
       sourcePixels[sourceOffset + 2]], sourceAlpha,
      context.globalCompositeOperation);
  }
  NativeHost.canvas.writePixels(destination.handle, left, top,
    right - left, bottom - top, destinationPixels);
  if (globalThis.__pmjsTrace && __pmjsTrace.active()) {
    var destinationResource = __pmjsTrace.revision(destination, 'canvas', true);
    __pmjsTrace.event('canvas', 'canvas.destination-write', {
      parentOperationId: operationId, destinationId: destinationResource.id,
      destinationRevision: destinationResource.revision,
      x: left, y: top, width: right - left, height: bottom - top,
      bytes: destinationPixels.length
    });
  }
}

function paintAffineRectangle(context, x, y, width, height, rgba, clear) {
  var t = context._transform;
  var points = [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
  for (var index = 0; index < 4; index++) {
    var px = points[index][0], py = points[index][1];
    points[index] = [t[0] * px + t[2] * py + t[4],
      t[1] * px + t[3] * py + t[5]];
  }
  var left = Math.max(0, Math.floor(Math.min.apply(null, points.map(function(p) { return p[0]; }))));
  var top = Math.max(0, Math.floor(Math.min.apply(null, points.map(function(p) { return p[1]; }))));
  var right = Math.min(context.canvas.width, Math.ceil(Math.max.apply(null, points.map(function(p) { return p[0]; }))));
  var bottom = Math.min(context.canvas.height, Math.ceil(Math.max.apply(null, points.map(function(p) { return p[1]; }))));
  if (right <= left || bottom <= top) return;
  var canvas = context.canvas._ensureNativeCanvas();
  var pixels = NativeHost.canvas.readPixels(canvas.handle, left, top,
    right - left, bottom - top);
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
    if (!inside || !passesCanvasClip(context, targetX + 0.5, targetY + 0.5)) continue;
    var offset = ((targetY - top) * (right - left) + targetX - left) * 4;
    if (clear) {
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = pixels[offset + 3] = 0;
      continue;
    }
    var pixelRgba = dynamicStyle ? canvasStyleRgba(rgba,
      targetX + 0.5, targetY + 0.5, context.globalAlpha) : rgba;
    var sourceAlpha = (pixelRgba & 255) / 255;
    var sourceColors = [(pixelRgba >>> 24) & 255,
      (pixelRgba >>> 16) & 255, (pixelRgba >>> 8) & 255];
    compositeCanvasPixel(pixels, offset, sourceColors, sourceAlpha,
      context.globalCompositeOperation);
  }
  NativeHost.canvas.writePixels(canvas.handle, left, top,
    right - left, bottom - top, pixels);
}

function transformedPoint(context, x, y) {
  var t = context._transform;
  return [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
}

function canvasStyleRgba(style, x, y, alpha) {
  if (style && style._pmjsStyle === 'pattern') {
    var patternTransform = style.transform || [1, 0, 0, 1, 0, 0];
    var determinant = patternTransform[0] * patternTransform[3] -
      patternTransform[1] * patternTransform[2];
    if (Math.abs(determinant) < 0.000001) return 0;
    var shiftedX = x - patternTransform[4], shiftedY = y - patternTransform[5];
    var sampleX = Math.floor((patternTransform[3] * shiftedX -
      patternTransform[2] * shiftedY) / determinant);
    var sampleY = Math.floor((-patternTransform[1] * shiftedX +
      patternTransform[0] * shiftedY) / determinant);
    if (style.repeat === 'repeat' || style.repeat === 'repeat-x') {
      sampleX = ((sampleX % style.width) + style.width) % style.width;
    } else if (sampleX < 0 || sampleX >= style.width) return 0;
    if (style.repeat === 'repeat' || style.repeat === 'repeat-y') {
      sampleY = ((sampleY % style.height) + style.height) % style.height;
    } else if (sampleY < 0 || sampleY >= style.height) return 0;
    var pixelOffset = (sampleY * style.width + sampleX) * 4;
    return ((style.pixels[pixelOffset] << 24) |
      (style.pixels[pixelOffset + 1] << 16) |
      (style.pixels[pixelOffset + 2] << 8) |
      Math.round(style.pixels[pixelOffset + 3] * alpha)) >>> 0;
  }
  if (!style || (style._pmjsStyle !== 'linear-gradient' &&
      style._pmjsStyle !== 'radial-gradient')) {
    return colorWithGlobalAlpha(style, alpha);
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
    amount = length ? ((x - style.x0) * dx + (y - style.y0) * dy) / length : 0;
  }
  amount = Math.max(0, Math.min(1, amount));
  var lower = style.stops[0], upper = style.stops[style.stops.length - 1];
  for (var index = 1; index < style.stops.length; index++) {
    if (style.stops[index].offset >= amount) {
      lower = style.stops[index - 1]; upper = style.stops[index]; break;
    }
  }
  var span = upper.offset - lower.offset;
  var mix = span ? (amount - lower.offset) / span : 0;
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
      !style.nativeConcentric || !style.stops.length || context._clipPaths.length ||
      (context.globalCompositeOperation !== 'source-over' &&
       context.globalCompositeOperation !== 'lighter') ||
      typeof NativeHost.canvas.fillRadialGradient !== 'function') return false;
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
      !style.stops.length || context._clipPaths.length) return false;
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

function rasterPath(context, stroke, rule) {
  var paths = context._path.filter(function(path) { return path.length > 1; });
  if (!paths.length) return;
  var all = [].concat.apply([], paths);
  var radius = stroke ? Math.max(0.5, Number(context.lineWidth) / 2) : 0;
  var left = Math.max(0, Math.floor(Math.min.apply(null, all.map(function(p) { return p[0]; })) - radius));
  var top = Math.max(0, Math.floor(Math.min.apply(null, all.map(function(p) { return p[1]; })) - radius));
  var right = Math.min(context.canvas.width, Math.ceil(Math.max.apply(null, all.map(function(p) { return p[0]; })) + radius));
  var bottom = Math.min(context.canvas.height, Math.ceil(Math.max.apply(null, all.map(function(p) { return p[1]; })) + radius));
  if (right <= left || bottom <= top) return;
  var canvas = context.canvas._ensureNativeCanvas();
  var pixels = NativeHost.canvas.readPixels(canvas.handle, left, top, right - left, bottom - top);
  var style = stroke ? context.strokeStyle : context.fillStyle;
  for (var y = top; y < bottom; y++) for (var x = left; x < right; x++) {
    var px = x + 0.5, py = y + 0.5, covered = false;
    if (stroke) {
      for (var pathIndex = 0; pathIndex < paths.length && !covered; pathIndex++) {
        var path = paths[pathIndex];
        for (var edge = 1; edge < path.length; edge++) {
          var a = path[edge - 1], b = path[edge];
          var vx = b[0] - a[0], vy = b[1] - a[1];
          var lengthSquared = vx * vx + vy * vy;
          var amount = lengthSquared ? Math.max(0, Math.min(1,
            ((px - a[0]) * vx + (py - a[1]) * vy) / lengthSquared)) : 0;
          var dx = px - (a[0] + amount * vx), dy = py - (a[1] + amount * vy);
          if (dx * dx + dy * dy <= radius * radius) { covered = true; break; }
        }
      }
    } else {
      covered = pointInCanvasPaths(paths, px, py, rule);
    }
    if (!covered || !passesCanvasClip(context, px, py)) continue;
    var offset = ((y - top) * (right - left) + x - left) * 4;
    var rgba = canvasStyleRgba(style, px, py, context.globalAlpha);
    var sourceAlpha = (rgba & 255) / 255;
    var sourceColors = [(rgba >>> 24) & 255, (rgba >>> 16) & 255, (rgba >>> 8) & 255];
    var destinationAlpha = pixels[offset + 3] / 255;
    var outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
    for (var channel = 0; channel < 3; channel++) pixels[offset + channel] =
      outputAlpha <= 0 ? 0 : Math.round((sourceColors[channel] * sourceAlpha +
        pixels[offset + channel] * destinationAlpha * (1 - sourceAlpha)) / outputAlpha);
    pixels[offset + 3] = Math.round(outputAlpha * 255);
  }
  NativeHost.canvas.writePixels(canvas.handle, left, top, right - left,
    bottom - top, pixels);
}

function colorToRgba(color) {
  if (typeof color === 'number') return ((color & 0xffffff) << 8 | 0xff) >>> 0;
  var text = String(color).trim().toLowerCase();
  if (text === 'transparent') return 0x00000000;
  if (text === 'black') return 0x000000ff;
  if (text === 'white') return 0xffffffff;
  var hex = /^#([0-9a-f]{6})$/i.exec(text);
  if (hex) return (parseInt(hex[1], 16) * 256 + 255) >>> 0;
  var rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(text);
  if (rgba) {
    var alpha = rgba[4] === undefined ? 255 : Math.round(Number(rgba[4]) * 255);
    return ((Number(rgba[1]) & 255) * 0x1000000 +
            (Number(rgba[2]) & 255) * 0x10000 +
            (Number(rgba[3]) & 255) * 0x100 + (alpha & 255)) >>> 0;
  }
  return 0x000000ff;
}

function colorWithGlobalAlpha(color, globalAlpha) {
  var rgba = colorToRgba(color);
  var sourceAlpha = rgba & 255;
  var alpha = Math.round(sourceAlpha *
    Math.max(0, Math.min(1, Number(globalAlpha))));
  return ((rgba & 0xffffff00) | alpha) >>> 0;
}

function contextFont(context) {
  var fontStr = (context && typeof context === 'object') ? context.font : context;
  if (globalThis.PMJS && PMJS.fonts && typeof PMJS.fonts.resolveDescriptor === 'function') {
    var resolved = PMJS.fonts.resolveDescriptor(fontStr);
    return {
      path: (resolved.faces && resolved.faces[0] && resolved.faces[0].path) || 'fonts/gamefont.ttf',
      size: resolved.size,
      family: (resolved.faces && resolved.faces[0] && resolved.faces[0].family) || 'GameFont'
    };
  }
  var sizeMatch = /(\d+(?:\.\d+)?)px/.exec(String(fontStr));
  var size = sizeMatch ? Math.max(1, Math.round(Number(sizeMatch[1]))) : 10;
  var config = globalThis.pmjsGameConfig || {};
  var files = config.fonts || {};
  var family = String(fontStr).split(/\s+/).pop().replace(/["']/g, '');
  return { path: files[family] || files.GameFont || 'fonts/gamefont.ttf', size: size };
}

var nativeCompatibilityHits = Object.create(null);
var nativeCompatibilityStrict =
  NativeHost.runtime.env('PMJS_STRICT_COMPAT') === '1';
var nativeCompatibilityVerbose =
  NativeHost.runtime.env('PMJS_COMPAT_VERBOSE') === '1';
function nativeCompatibilityHit(capability, detail) {
  var count = (nativeCompatibilityHits[capability] || 0) + 1;
  nativeCompatibilityHits[capability] = count;
  if (count === 1) {
    var message = '[pmjs-compat] ' + capability + (detail ? ': ' + String(detail) : '');
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(message);
      if (nativeCompatibilityVerbose) {
        console.warn(new Error().stack || '');
      }
    } else if (typeof console !== 'undefined' && console.log) {
      console.log(message);
      if (nativeCompatibilityVerbose) {
        console.log(new Error().stack || '');
      }
    }
  }
  if (nativeCompatibilityStrict) {
    throw new Error('unsupported native capability: ' + capability +
      (detail ? ': ' + String(detail) : ''));
  }
}

function nativeCompatibilityObserved(capability, detail) {
  var count = (nativeCompatibilityHits[capability] || 0) + 1;
  nativeCompatibilityHits[capability] = count;
  if (count !== 1) return;
  var event = {
    capability: capability,
    detail: detail || '',
    frame: typeof Graphics === 'function' ? Graphics.frameCount : 0
  };
  console.log('[pmjs-compat] ' + JSON.stringify(event));
}

var nativeCanvasReleaseStats = { explicit: 0, finalizer: 0, sceneLifecycle: 0 };
function noteCanvasRelease(reason) {
  try {
    if (reason === 'explicit') nativeCanvasReleaseStats.explicit++;
    else if (reason === 'finalizer') nativeCanvasReleaseStats.finalizer++;
    else if (reason === 'scene-lifecycle') {
      nativeCanvasReleaseStats.sceneLifecycle++;
      try {
        nativeCompatibilityHit('canvas.release.sceneLifecycle',
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
globalThis.__pmjsCompatibilityHits = function() {
  return Object.assign({}, nativeCompatibilityHits);
};

CanvasContext2D.prototype.save = function() {
  this._stateStack.push({ transform: this._transform.slice(), fillStyle: this.fillStyle,
    strokeStyle: this.strokeStyle, globalAlpha: this.globalAlpha,
    globalCompositeOperation: this.globalCompositeOperation, font: this.font,
    textAlign: this.textAlign, textBaseline: this.textBaseline,
    lineWidth: this.lineWidth, clipPaths: this._clipPaths.map(function(region) {
      return { rule: region.rule, paths: region.paths.map(function(path) {
        return path.map(function(point) { return point.slice(); });
      }) };
    }) });
};
CanvasContext2D.prototype.restore = function() {
  if (!this._stateStack.length) return;
  var state = this._stateStack.pop();
  for (var key in state) this[key === 'transform' ? '_transform' :
    key === 'clipPaths' ? '_clipPaths' : key] = state[key];
};
CanvasContext2D.prototype.setTransform = function(a, b, c, d, e, f) {
  if (arguments.length === 1 && a) {
    this._transform = [Number(a.a), Number(a.b), Number(a.c), Number(a.d),
      Number(a.e), Number(a.f)];
  } else this._transform = [Number(a), Number(b), Number(c), Number(d), Number(e), Number(f)];
};
CanvasContext2D.prototype.resetTransform = function() {
  this._transform = [1, 0, 0, 1, 0, 0];
};
CanvasContext2D.prototype.transform = function(a, b, c, d, e, f) {
  this._transform = multiplyTransform(this._transform,
    [Number(a), Number(b), Number(c), Number(d), Number(e), Number(f)]);
};
CanvasContext2D.prototype.scale = function(x, y) { this.transform(x, 0, 0, y, 0, 0); };
CanvasContext2D.prototype.translate = function(x, y) { this.transform(1, 0, 0, 1, x, y); };
CanvasContext2D.prototype.rotate = function(angle) {
  var cosine = Math.cos(angle), sine = Math.sin(angle);
  this.transform(cosine, sine, -sine, cosine, 0, 0);
};
CanvasContext2D.prototype.clearRect = function(x, y, width, height) {
  var rectangle = axisAlignedRect(this, x, y, width, height);
  if (!rectangle || this._clipPaths.length) {
    paintAffineRectangle(this, x, y, width, height, 0, true); return;
  }
  x = rectangle.x; y = rectangle.y; width = rectangle.width; height = rectangle.height;
  var canvas = this.canvas._ensureNativeCanvas();
  if (x <= 0 && y <= 0 && width >= this.canvas.width && height >= this.canvas.height) {
    NativeHost.canvas.clear(canvas.handle);
  } else {
    NativeHost.canvas.clearRect(canvas.handle,
      Math.floor(x), Math.floor(y), Math.floor(width), Math.floor(height));
  }
};
CanvasContext2D.prototype.fillRect = function(x, y, width, height) {
  var rectangle = axisAlignedRect(this, x, y, width, height);
  if (rectangle && fillAxisAlignedRadialGradient(this, rectangle, this.fillStyle)) return;
  if (rectangle && fillAxisAlignedLinearGradient(this, rectangle, this.fillStyle)) return;
  if (!rectangle || this._clipPaths.length || typeof this.fillStyle === 'object' ||
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
  var line = Math.max(1, Number(this.lineWidth));
  var old = this.fillStyle;
  this.fillStyle = this.strokeStyle;
  this.fillRect(x, y, width, line);
  this.fillRect(x, y + height - line, width, line);
  this.fillRect(x, y + line, line, Math.max(0, height - line * 2));
  this.fillRect(x + width - line, y + line, line, Math.max(0, height - line * 2));
  this.fillStyle = old;
};
CanvasContext2D.prototype.drawImage = function(source) {
  var nativeSource = source && (source._nativeImage || source._nativeCanvas);
  if (!nativeSource && source && typeof source._ensureNativeCanvas === 'function') {
    nativeSource = source._ensureNativeCanvas();
  }
  if (!nativeSource && source instanceof NativeImage) return;
  if (!nativeSource) throw new TypeError('drawImage source has no native resource');

  var sx = 0;
  var sy = 0;
  var sw = Number(source.width) || 0;
  var sh = Number(source.height) || 0;
  var dx;
  var dy;
  var dw;
  var dh;
  if (arguments.length === 3) {
    dx = arguments[1]; dy = arguments[2]; dw = sw; dh = sh;
  } else if (arguments.length === 5) {
    dx = arguments[1]; dy = arguments[2]; dw = arguments[3]; dh = arguments[4];
  } else if (arguments.length === 9) {
    sx = arguments[1]; sy = arguments[2]; sw = arguments[3]; sh = arguments[4];
    dx = arguments[5]; dy = arguments[6]; dw = arguments[7]; dh = arguments[8];
  } else {
    throw new TypeError('unsupported drawImage overload');
  }
  var trace = globalThis.__pmjsTrace;
  var tracedDestination = trace && trace.active() ?
    this.canvas._ensureNativeCanvas() : null;
  var operationId = trace && trace.active() ? trace.event('canvas', 'canvas.drawImage', {
    sourceId: trace.id(nativeSource, source && source._nativeCanvas ? 'canvas' : 'image'),
    destinationId: trace.id(tracedDestination, 'canvas'),
    sourceX: sx, sourceY: sy, sourceWidth: sw, sourceHeight: sh,
    destinationX: dx, destinationY: dy,
    destinationWidth: dw, destinationHeight: dh,
    composite: this.globalCompositeOperation
  }) : 0;
  var transformed = axisAlignedRect(this, dx, dy, dw, dh);
  if (!transformed || this._clipPaths.length ||
      this.globalCompositeOperation !== 'source-over') {
    drawAffineImage(this, source, nativeSource, sx, sy, sw, sh,
      dx, dy, dw, dh, operationId);
    return;
  }
  dx = transformed.x; dy = transformed.y; dw = transformed.width; dh = transformed.height;
  var destination = this.canvas._ensureNativeCanvas();
  NativeHost.canvas.drawImage(
    destination.handle, nativeSource.handle,
    Math.floor(sx), Math.floor(sy), Math.floor(sw), Math.floor(sh),
    Math.floor(dx), Math.floor(dy), Math.floor(dw), Math.floor(dh),
    Math.max(0, Math.min(1, Number(this.globalAlpha))));
  if (trace && trace.active()) {
    var destinationResource = trace.revision(destination, 'canvas', true);
    trace.event('canvas', 'canvas.drawImage-complete', {
      parentOperationId: operationId,
      destinationId: destinationResource.id,
      destinationRevision: destinationResource.revision,
      x: Math.floor(dx), y: Math.floor(dy),
      width: Math.floor(dw), height: Math.floor(dh),
      submittedBytes: Math.max(0, Math.floor(dw)) *
        Math.max(0, Math.floor(dh)) * 4,
      implementation: 'native-cropped-draw'
    });
  }
};
function canvasTextPosition(context, text, x, y) {
  var font = contextFont(context);
  var width = NativeHost.canvas.measureText(font.path, String(text), font.size);
  if (context.textAlign === 'center') x -= width / 2;
  else if (context.textAlign === 'right' || context.textAlign === 'end') x -= width;
  var baseline = context.textBaseline;
  if (baseline === 'top' || baseline === 'hanging') y += font.size;
  else if (baseline === 'middle') y += font.size / 2;
  else if (baseline === 'bottom' || baseline === 'ideographic') y -= 0;
  return { font: font, width: width, x: x, top: y - font.size };
}

function drawCanvasText(context, text, x, y, stroke, maxWidth) {
  text = String(text);
  var placement = canvasTextPosition(context, text, Number(x), Number(y));
  maxWidth = maxWidth === undefined ? Infinity : Number(maxWidth);
  if (!(maxWidth > 0)) return;
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
  var color = colorWithGlobalAlpha(style, context.globalAlpha);
  var strokeWidth = stroke ? Math.max(0, Math.round(context.lineWidth)) : 0;
  if (Math.abs(t[0] - 1) < 0.000001 && Math.abs(t[1]) < 0.000001 &&
      Math.abs(t[2]) < 0.000001 && Math.abs(t[3] - 1) < 0.000001 &&
      !context._clipPaths.length && horizontalScale === 1) {
    NativeHost.canvas.drawText(context.canvas._ensureNativeCanvas().handle,
      placement.font.path, text, Math.round(placement.x + t[4]),
      Math.round(placement.top + placement.font.size + t[5]),
      placement.font.size, color, strokeWidth);
    return;
  }
  var padding = strokeWidth + 2;
  var temporary = NativeHost.canvas.create(
    Math.max(1, Math.ceil(placement.width) + padding * 2),
    Math.max(1, placement.font.size * 2 + padding * 2));
  try {
    NativeHost.canvas.drawText(temporary.handle, placement.font.path, text,
      padding, padding + placement.font.size, placement.font.size,
      colorToRgba(style), strokeWidth);
    var source = { width: temporary.width, height: temporary.height,
      _nativeCanvas: temporary };
    drawAffineImage(context, source, temporary, 0, 0, temporary.width,
      temporary.height, placement.x - padding, placement.top - padding,
      temporary.width * horizontalScale, temporary.height);
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
  this._path = []; this._subpath = null; this._currentPathPoint = null;
};
CanvasContext2D.prototype.closePath = function() {
  if (this._subpath && this._subpath.length > 1) this._subpath.push(this._subpath[0].slice());
};
CanvasContext2D.prototype.moveTo = function(x, y) {
  this._currentPathPoint = [Number(x), Number(y)];
  this._subpath = [transformedPoint(this, Number(x), Number(y))];
  this._path.push(this._subpath);
};
CanvasContext2D.prototype.lineTo = function(x, y) {
  if (!this._subpath) this.moveTo(x, y);
  else {
    this._currentPathPoint = [Number(x), Number(y)];
    this._subpath.push(transformedPoint(this, Number(x), Number(y)));
  }
};
CanvasContext2D.prototype.arc = function(x, y, radius, start, end, anticlockwise) {
  radius = Number(radius); if (radius < 0) throw new RangeError('negative arc radius');
  var sweep = Number(end) - Number(start);
  if (!anticlockwise && sweep < 0) sweep += Math.PI * 2;
  if (anticlockwise && sweep > 0) sweep -= Math.PI * 2;
  sweep = Math.max(-Math.PI * 2, Math.min(Math.PI * 2, sweep));
  var segments = Math.max(4, Math.ceil(Math.abs(sweep) * Math.max(1, radius) / 4));
  for (var index = 0; index <= segments; index++) {
    var angle = Number(start) + sweep * index / segments;
    var point = transformedPoint(this, Number(x) + Math.cos(angle) * radius,
      Number(y) + Math.sin(angle) * radius);
    if (!this._subpath) { this._subpath = [point]; this._path.push(this._subpath); }
    else this._subpath.push(point);
  }
  this._currentPathPoint = [Number(x) + Math.cos(Number(start) + sweep) * radius,
    Number(y) + Math.sin(Number(start) + sweep) * radius];
};
CanvasContext2D.prototype.arcTo = function(x1, y1, x2, y2, radius) {
  x1 = Number(x1); y1 = Number(y1); x2 = Number(x2); y2 = Number(y2);
  radius = Number(radius);
  if (radius < 0) throw new RangeError('negative arcTo radius');
  if (!this._currentPathPoint) { this.moveTo(x1, y1); return; }
  var x0 = this._currentPathPoint[0], y0 = this._currentPathPoint[1];
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
CanvasContext2D.prototype.rect = function(x, y, width, height) {
  this.moveTo(x, y); this.lineTo(x + width, y); this.lineTo(x + width, y + height);
  this.lineTo(x, y + height); this.closePath();
};
CanvasContext2D.prototype.clip = function(rule) {
  rule = rule === undefined ? 'nonzero' : String(rule);
  if (rule !== 'nonzero' && rule !== 'evenodd') throw new TypeError('invalid fill rule');
  this._clipPaths.push({ rule: rule, paths: this._path.map(function(path) {
    return path.map(function(point) { return point.slice(); });
  }) });
};
CanvasContext2D.prototype.fill = function(rule) {
  rule = rule === undefined ? 'nonzero' : String(rule);
  if (rule !== 'nonzero' && rule !== 'evenodd') throw new TypeError('invalid fill rule');
  rasterPath(this, false, rule);
};
CanvasContext2D.prototype.stroke = function() { rasterPath(this, true, 'nonzero'); };
CanvasContext2D.prototype.createLinearGradient = function() {
  var first = transformedPoint(this, Number(arguments[0]), Number(arguments[1]));
  var second = transformedPoint(this, Number(arguments[2]), Number(arguments[3]));
  return { _pmjsStyle: 'linear-gradient', x0: first[0], y0: first[1],
    x1: second[0], y1: second[1], stops: [], addColorStop: function(offset, color) {
      offset = Number(offset);
      if (!isFinite(offset) || offset < 0 || offset > 1) throw new RangeError('invalid color stop');
      colorToRgba(color);
      this.stops.push({ offset: offset, color: color });
      this.stops.sort(function(left, right) { return left.offset - right.offset; });
    } };
};
CanvasContext2D.prototype.createRadialGradient = function(x0, y0, r0, x1, y1, r1) {
  x0 = Number(x0); y0 = Number(y0); r0 = Number(r0);
  x1 = Number(x1); y1 = Number(y1); r1 = Number(r1);
  if (![x0, y0, r0, x1, y1, r1].every(Number.isFinite)) {
    throw new TypeError('invalid radial gradient');
  }
  if (r0 < 0 || r1 < 0) throw new RangeError('negative radial gradient radius');
  var first = transformedPoint(this, x0, y0);
  var second = transformedPoint(this, x1, y1);
  var transform = this._transform;
  var scaleX = Math.hypot(transform[0], transform[1]);
  var scaleY = Math.hypot(transform[2], transform[3]);
  var uniformScale = Math.abs(scaleX - scaleY) < 0.000001 &&
    Math.abs(transform[0] * transform[2] + transform[1] * transform[3]) < 0.000001;
  var scale = Math.sqrt(Math.abs(transform[0] * transform[3] -
    transform[1] * transform[2]));
  return { _pmjsStyle: 'radial-gradient',
    x0: first[0], y0: first[1], r0: r0 * scale,
    x1: second[0], y1: second[1], r1: r1 * scale,
    nativeConcentric: uniformScale && Math.abs(first[0] - second[0]) < 0.000001 &&
      Math.abs(first[1] - second[1]) < 0.000001 && r1 > r0,
    stops: [], addColorStop: function(offset, color) {
      offset = Number(offset);
      if (!isFinite(offset) || offset < 0 || offset > 1) throw new RangeError('invalid color stop');
      colorToRgba(color);
      this.stops.push({ offset: offset, color: color });
      this.stops.sort(function(left, right) { return left.offset - right.offset; });
    } };
};
CanvasContext2D.prototype.createPattern = function(source, repetition) {
  var nativeSource = source && (source._nativeImage || source._nativeCanvas);
  if (!nativeSource && source && typeof source._ensureNativeCanvas === 'function') {
    nativeSource = source._ensureNativeCanvas();
  }
  if (!nativeSource || !source.width || !source.height) return null;
  repetition = repetition || 'repeat';
  if (['repeat', 'repeat-x', 'repeat-y', 'no-repeat'].indexOf(repetition) < 0) {
    throw new TypeError('invalid pattern repetition');
  }
  return { _pmjsStyle: 'pattern', repeat: repetition,
    width: source.width, height: source.height,
    pixels: canvasSourcePixels(source, nativeSource), transform: [1, 0, 0, 1, 0, 0],
    setTransform: function(matrix) {
      matrix = matrix || {};
      var values = [matrix.a === undefined ? 1 : Number(matrix.a), Number(matrix.b) || 0,
        Number(matrix.c) || 0, matrix.d === undefined ? 1 : Number(matrix.d),
        Number(matrix.e) || 0, Number(matrix.f) || 0];
      if (!values.every(Number.isFinite)) throw new TypeError('invalid pattern transform');
      this.transform = values;
    } };
};
CanvasContext2D.prototype.measureText = function(text) {
  var font = contextFont(this);
  return NativeHost.canvas.measureTextMetrics(font.path, String(text), font.size);
};
CanvasContext2D.prototype.getImageData = function(x, y, width, height) {
  width = Math.floor(width);
  height = Math.floor(height);
  if (width <= 0 || height <= 0) throw new RangeError('invalid ImageData dimensions');
  var canvas = this.canvas._ensureNativeCanvas();
  return new ImageData(new Uint8ClampedArray(NativeHost.canvas.readPixels(
    canvas.handle, Math.floor(x), Math.floor(y), width, height)), width, height);
};
CanvasContext2D.prototype.putImageData = function(imageData, x, y) {
  if (!imageData || !imageData.data) throw new TypeError('invalid ImageData');
  var sourceX = arguments.length >= 7 ? Math.floor(arguments[3]) : 0;
  var sourceY = arguments.length >= 7 ? Math.floor(arguments[4]) : 0;
  var width = arguments.length >= 7 ? Math.floor(arguments[5]) : imageData.width;
  var height = arguments.length >= 7 ? Math.floor(arguments[6]) : imageData.height;
  sourceX = Math.max(0, sourceX);
  sourceY = Math.max(0, sourceY);
  width = Math.min(width, imageData.width - sourceX);
  height = Math.min(height, imageData.height - sourceY);
  if (width <= 0 || height <= 0) return;
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
  NativeHost.canvas.writePixels(canvas.handle, Math.floor(x) + sourceX,
    Math.floor(y) + sourceY, width, height, pixels);
};

[
  'clearRect', 'fillRect', 'drawImage', 'fillText', 'strokeText',
  'fill', 'stroke', 'putImageData'
].forEach(function(method) {
  var mutate = CanvasContext2D.prototype[method];
  CanvasContext2D.prototype[method] = function() {
    var result = mutate.apply(this, arguments);
    if (this.canvas && typeof this.canvas._pmjsContentChanged === 'function') {
      this.canvas._pmjsContentChanged();
    }
    return result;
  };
});
