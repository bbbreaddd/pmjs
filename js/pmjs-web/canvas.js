function CanvasContext2D(canvas) {
  this.canvas = canvas;
  resetCanvasContextState(this);
}

function resetCanvasContextState(context) {
  var canvas = context.canvas;
  context.canvas = canvas;
  context.fillStyle = '#000000';
  context.strokeStyle = '#000000';
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'source-over';
  context.font = '10px sans-serif';
  context.textAlign = 'start';
  context.textBaseline = 'alphabetic';
  context.lineWidth = 1;
  context.imageSmoothingEnabled = true;
  context._transform = [1, 0, 0, 1, 0, 0];
  context._stateStack = [];
  context._circlePath = null;
  context._path = [];
  context._subpath = null;
  context._clipPaths = [];
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

function canvasSourcePixels(source, nativeSource, operationId, region) {
  var x = region ? region.x : 0;
  var y = region ? region.y : 0;
  var width = region ? region.width : source.width;
  var height = region ? region.height : source.height;
  var trace = globalThis.__pmjsTrace;
  var sourceResource = trace && trace.active() ?
    trace.revision(nativeSource, source && source._nativeCanvas ? 'canvas' : 'image') : null;
  if (source && source._nativeCanvas) {
    var canvasPixels = NativeHost.canvas.readPremultipliedPixels(nativeSource.handle, x, y, width, height);
    if (trace && trace.active()) trace.event('canvas', 'canvas.source-read', {
      parentOperationId: operationId, sourceId: sourceResource.id,
      sourceRevision: sourceResource.revision, x: x, y: y, width: width,
      height: height, bytes: canvasPixels.length, temporary: false
    });
    return canvasPixels;
  }
  var temporary = NativeHost.canvas.create(width, height);
  try {
    NativeHost.canvas.drawImage(temporary.handle, nativeSource.handle,
      x, y, width, height, 0, 0, width, height, 1);
    var imagePixels = NativeHost.canvas.readPremultipliedPixels(temporary.handle, 0, 0, width, height);
    if (trace && trace.active()) trace.event('canvas', 'canvas.source-read', {
      parentOperationId: operationId, sourceId: sourceResource.id,
      sourceRevision: sourceResource.revision, x: x, y: y, width: width,
      height: height, bytes: imagePixels.length, temporary: true,
      temporaryWidth: width, temporaryHeight: height
    });
    return imagePixels;
  } finally {
    releaseNativeResource(temporary, 'canvas');
  }
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
function canvasNativePaint(style) {
  if (style && style._pmjsStyle === 'pattern') {
    return { kind: 'pattern', width: style.width, height: style.height,
      repeat: style.repeat, pixels: style.pixels, transform: style.transform };
  }
  if (style && (style._pmjsStyle === 'linear-gradient' || style._pmjsStyle === 'radial-gradient')) {
    return { kind: style._pmjsStyle === 'linear-gradient' ? 'linear' : 'radial',
      geometry: [style.x0, style.y0, style.r0 || 0, style.x1, style.y1, style.r1 || 0],
      offsets: style.stops.map(function(stop) { return stop.offset; }),
      colors: style.stops.map(function(stop) { return colorToRgba(stop.color); }) };
  }
  return { kind: 'solid', color: colorToRgba(style) };
}

function drawAffineImage(context, source, nativeSource, sx, sy, sw, sh,
    dx, dy, dw, dh, operationId) {
  if (!sw || !sh || !dw || !dh || source.width <= 0 || source.height <= 0) return;
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
  var region = canvasCompositeRegion(context, left, top, right, bottom);
  left = region[0]; top = region[1]; right = region[2]; bottom = region[3];
  if (right <= left || bottom <= top) return;
  var sourceLeft = Math.max(0, Math.min(source.width - 1,
    Math.floor(Math.min(sx, sx + sw))));
  var sourceTop = Math.max(0, Math.min(source.height - 1,
    Math.floor(Math.min(sy, sy + sh))));
  var sourceRight = Math.max(sourceLeft + 1, Math.min(source.width,
    Math.floor(Math.max(sx, sx + sw)) + 1));
  var sourceBottom = Math.max(sourceTop + 1, Math.min(source.height,
    Math.floor(Math.max(sy, sy + sh)) + 1));
  var sourceWidth = sourceRight - sourceLeft;
  var sourcePixels = canvasSourcePixels(source, nativeSource, operationId, {
    x: sourceLeft, y: sourceTop, width: sourceWidth,
    height: sourceBottom - sourceTop
  });
  var destination = context.canvas._ensureNativeCanvas();
  var paintPixels = new Uint8Array((right - left) * (bottom - top) * 4);
  var clipMask = new Uint8Array((right - left) * (bottom - top));
  var inverseA = t[3] / determinant, inverseB = -t[1] / determinant;
  var inverseC = -t[2] / determinant, inverseD = t[0] / determinant;
  var alpha = Math.max(0, Math.min(1, Number(context.globalAlpha)));
  for (var y = top; y < bottom; y++) for (var x = left; x < right; x++) {
    var shiftedX = x + 0.5 - t[4], shiftedY = y + 0.5 - t[5];
    var localX = inverseA * shiftedX + inverseC * shiftedY;
    var localY = inverseB * shiftedX + inverseD * shiftedY;
    var u = (localX - dx) / dw, v = (localY - dy) / dh;
    if (!passesCanvasClip(context, x + 0.5, y + 0.5)) continue;
    var index = (y - top) * (right - left) + x - left;
    clipMask[index] = 255;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
    var sampleX = Math.max(0, Math.min(source.width - 1, Math.floor(sx + u * sw)));
    var sampleY = Math.max(0, Math.min(source.height - 1, Math.floor(sy + v * sh)));
    var sourceOffset = ((sampleY - sourceTop) * sourceWidth + sampleX - sourceLeft) * 4;
    paintPixels.set(sourcePixels.subarray(sourceOffset, sourceOffset + 4), index * 4);
  }
  NativeHost.canvas.compositePixels(destination.handle, left, top,
    right - left, bottom - top, paintPixels, clipMask, context.globalCompositeOperation, alpha);
  if (globalThis.__pmjsTrace && __pmjsTrace.active()) {
    var destinationResource = __pmjsTrace.revision(destination, 'canvas', true);
    __pmjsTrace.event('canvas', 'canvas.destination-write', {
      parentOperationId: operationId, destinationId: destinationResource.id,
      destinationRevision: destinationResource.revision,
      x: left, y: top, width: right - left, height: bottom - top,
      bytes: paintPixels.length
    });
  }
}

function paintAffineRectangle(context, x, y, width, height, rgba, clear) {
  if (!width || !height) return;
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
    if (clear || !inside) continue;
    var offset = index * 4;
    var pixelRgba = dynamicStyle ? canvasStylePremultiplied(rgba,
      targetX + 0.5, targetY + 0.5, context.globalAlpha) : premultiplyCanvasColor(rgba);
    pixels[offset] = pixelRgba >>> 24; pixels[offset + 1] = pixelRgba >>> 16 & 255;
    pixels[offset + 2] = pixelRgba >>> 8 & 255; pixels[offset + 3] = pixelRgba & 255;
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
function canvasStylePremultiplied(style, x, y, alpha) {
  var rgba = canvasStyleRgba(style, x, y, alpha);
  if (!style || style._pmjsStyle !== 'pattern') return premultiplyCanvasColor(rgba);
  // Pattern samples already contain premultiplied colors.
  return ((Math.round((rgba >>> 24) * alpha) << 24) |
    (Math.round((rgba >>> 16 & 255) * alpha) << 16) |
    (Math.round((rgba >>> 8 & 255) * alpha) << 8) | (rgba & 255)) >>> 0;
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
  if (context.globalCompositeOperation === 'source-over' && NativeHost.canvas.paintRect &&
      NativeHost.canvas.paintRect(context.canvas._ensureNativeCanvas().handle,
        rectangle.x, rectangle.y, rectangle.width, rectangle.height, colorWithGlobalAlpha('#fff', context.globalAlpha), 0,
        style.x0, style.y0, style.x1, style.y1,
        style.stops.map(function(stop) { return stop.offset; }),
        style.stops.map(function(stop) { return colorToRgba(stop.color); }))) return true;
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

function rasterPath(context, stroke, rule, drawingPaths) {
  var paths = (drawingPaths || context._path).filter(function(path) { return path.length > 1; });
  if (!paths.length) return;
  var circle = !stroke && context._circlePath;
  if (circle) {
    NativeHost.canvas.paintCircle(context.canvas._ensureNativeCanvas().handle, {
      geometry: [circle.x, circle.y, circle.radius], transform: circle.transform,
      paint: canvasNativePaint(context.fillStyle),
      globalAlpha: Math.max(0, Math.min(1, Number(context.globalAlpha))),
      composite: context.globalCompositeOperation, clips: context._clipPaths
    });
    return;
  }
  var all = [].concat.apply([], paths);
  var radius = stroke ? Math.max(0.5, Number(context.lineWidth) / 2) : 0;
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
    if (!passesCanvasClip(context, px, py)) continue;
    var index = (y - top) * (right - left) + x - left;
    clipMask[index] = 255;
    if (!covered) continue;
    var offset = index * 4;
    var rgba = canvasStylePremultiplied(style, px, py, context.globalAlpha);
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

function parseCanvasColor(color) {
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

['fillStyle', 'strokeStyle'].forEach(function(property) {
  Object.defineProperty(CanvasContext2D.prototype, property, {
    get: function() { return this['_' + property]; },
    set: function(value) {
      if (value && typeof value === 'object' && value._pmjsStyle || parseCanvasColor(value) !== null) this['_' + property] = value;
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
  this._stateStack.push({ transform: this._transform.slice(), fillStyle: this.fillStyle,
    strokeStyle: this.strokeStyle, globalAlpha: this.globalAlpha,
    globalCompositeOperation: this.globalCompositeOperation, font: this.font,
    textAlign: this.textAlign, textBaseline: this.textBaseline,
    lineWidth: this.lineWidth, imageSmoothingEnabled: this.imageSmoothingEnabled,
    clipPaths: this._clipPaths.map(function(region) {
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
  var line = Number(this.lineWidth);
  if (!(line > 0) || !Number.isFinite(line)) return;
  var rectangle = axisAlignedRect(this, x, y, width, height);
  if (rectangle && Math.abs(this._transform[0]) === Math.abs(this._transform[3]) &&
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
  rasterPath(this, true, 'nonzero', [outline]);
};
CanvasContext2D.prototype.drawImage = function(source) {
  if (source && source._pmjsPrimitiveContent) source._pmjsPrimitiveContent.materialize();
  var nativeSource = source && (source._nativeImage || source._nativeCanvas);
  if (!nativeSource && !(source instanceof NativeImage) &&
      !(source && typeof source._ensureNativeCanvas === 'function')) {
    throw new TypeError('drawImage source has no native resource');
  }

  var sx = 0;
  var sy = 0;
  var sw = Number(source.width) || 0;
  var sh = Number(source.height) || 0;
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
  if (!transformed || this._transform[0] < 0 || this._transform[3] < 0 ||
      this._clipPaths.length ||
      this.globalCompositeOperation !== 'source-over') {
    drawAffineImage(this, source, nativeSource, sx, sy, sw, sh,
      dx, dy, dw, dh, operationId);
    return;
  }
  dx = transformed.x; dy = transformed.y; dw = transformed.width; dh = transformed.height;
  var destination = this.canvas._ensureNativeCanvas();
  NativeHost.canvas.drawImage(
    destination.handle, nativeSource.handle,
    sx, sy, sw, sh, dx, dy, dw, dh,
    Math.max(0, Math.min(1, Number(this.globalAlpha))), this.imageSmoothingEnabled !== false);
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
  if (baseline === 'top' || baseline === 'hanging') y += font.size;
  else if (baseline === 'middle') y += font.size / 2;
  else if (baseline === 'bottom' || baseline === 'ideographic') y -= 0;
  return { font: font, width: width, x: x, top: y - font.size };
}

function drawCanvasText(context, text, x, y, stroke, maxWidth) {
  text = String(text);
  x = +x; y = +y;
  var suppliedWidth = maxWidth !== undefined;
  maxWidth = suppliedWidth ? +maxWidth : Infinity;
  if (!Number.isFinite(x) || !Number.isFinite(y) ||
      (suppliedWidth && !Number.isFinite(maxWidth)) || !(maxWidth > 0)) return;
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
  var color = colorWithGlobalAlpha(style, context.globalAlpha);
  var strokeWidth = stroke ? Math.max(0, usesLegacyText() ? Math.round(context.lineWidth) : Number(context.lineWidth)) : 0;
  if (Math.abs(t[0] - 1) < 0.000001 && Math.abs(t[1]) < 0.000001 &&
      Math.abs(t[2]) < 0.000001 && Math.abs(t[3] - 1) < 0.000001 &&
      !context._clipPaths.length && horizontalScale === 1) {
    NativeHost.canvas.drawText(context.canvas._ensureNativeCanvas().handle,
      placement.font.paths, text, placement.x + t[4],
      placement.top + placement.font.size + t[5],
      placement.font.size, color, strokeWidth, nativeTextStyle(context, placement.font));
    return;
  }
  var padding = strokeWidth + 2;
  var temporary = NativeHost.canvas.create(
    Math.max(1, Math.ceil(Math.ceil(placement.width) + padding * 2)),
    Math.max(1, Math.ceil(placement.font.size * 2 + padding * 2)));
  try {
    NativeHost.canvas.drawText(temporary.handle, placement.font.paths, text,
      padding, padding + placement.font.size, placement.font.size,
      colorToRgba(style), strokeWidth, nativeTextStyle(context, placement.font));
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
  this._circlePath = null;
  this._path = []; this._subpath = null; this._currentPathPoint = null;
};
CanvasContext2D.prototype.closePath = function() {
  if (this._subpath && this._subpath.length > 1) this._subpath.push(this._subpath[0].slice());
};
CanvasContext2D.prototype.moveTo = function(x, y) {
  this._circlePath = null;
  this._currentPathPoint = [Number(x), Number(y)];
  this._subpath = [transformedPoint(this, Number(x), Number(y))];
  this._path.push(this._subpath);
};
CanvasContext2D.prototype.lineTo = function(x, y) {
  this._circlePath = null;
  if (!this._subpath) this.moveTo(x, y);
  else {
    this._currentPathPoint = [Number(x), Number(y)];
    this._subpath.push(transformedPoint(this, Number(x), Number(y)));
  }
};
CanvasContext2D.prototype.arc = function(x, y, radius, start, end, anticlockwise) {
  radius = Number(radius); if (radius < 0) throw new RangeError('negative arc radius');
  x = Number(x); y = Number(y); start = Number(start); end = Number(end);
  if (![x, y, radius, start, end].every(Number.isFinite)) return;
  var difference = end - start, tau = Math.PI * 2;
  var sweep;
  if (!anticlockwise && difference >= tau) sweep = tau;
  else if (anticlockwise && difference <= -tau) sweep = -tau;
  else {
    sweep = (difference % tau + tau) % tau;
    if (anticlockwise && sweep > 0) sweep -= tau;
  }
  this._circlePath = !this._path.length && Math.abs(sweep) >= Math.PI * 2 ?
    { x: Number(x), y: Number(y), radius: radius, transform: this._transform.slice() } : null;
  var segments = Math.max(8, Math.ceil(Math.abs(sweep) * Math.max(1, radius) * 2));
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
      if (parseCanvasColor(color) === null) throw new SyntaxError('Invalid color');
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
      if (parseCanvasColor(color) === null) throw new SyntaxError('Invalid color');
      this.stops.push({ offset: offset, color: color });
      this.stops.sort(function(left, right) { return left.offset - right.offset; });
    } };
};
CanvasContext2D.prototype.createPattern = function(source, repetition) {
  if (source && source._pmjsPrimitiveContent) source._pmjsPrimitiveContent.materialize();
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
  return NativeHost.canvas.measureTextMetrics(font.paths, String(text), font.size, nativeTextStyle(this, font));
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


(function() {
  function lightColor(value, alpha) {
    var rgba = colorWithGlobalAlpha(value, alpha);
    return [((rgba >>> 24) & 255) / 255, ((rgba >>> 16) & 255) / 255,
      ((rgba >>> 8) & 255) / 255, (rgba & 255) / 255];
  }

  function appendLightRecord(records, kind, bounds, center, radii, stops, alpha,
      blendMode) {
    records.push(kind, bounds[0], bounds[1], bounds[2], bounds[3],
      center[0], center[1], radii[0], radii[1], stops.length);
    for (var offsetIndex = 0; offsetIndex < 3; offsetIndex++) {
      records.push(offsetIndex < stops.length ? stops[offsetIndex].offset : 0);
    }
    for (var colorIndex = 0; colorIndex < 3; colorIndex++) {
      var color = colorIndex < stops.length ?
        lightColor(stops[colorIndex].color, alpha) : [0, 0, 0, 0];
      records.push(color[0], color[1], color[2], color[3]);
    }
    records.push(blendMode);
  }

  var surfaceFinalizer = typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry(function(handle) {
        try { NativeHost.render.releasePrimitiveSurface(handle); } catch (_) {}
      }) : null;

  globalThis.PMJS = globalThis.PMJS || {};
  PMJS.web = PMJS.web || {};
  PMJS.web.canvas = PMJS.web.canvas || {};
  PMJS.web.canvas.createPrimitiveRecorder = function(canvas) {
    if (typeof NativeHost === 'undefined' || !NativeHost.render ||
        typeof NativeHost.render.createPrimitiveSurface !== 'function' ||
        typeof NativeHost.render.renderPrimitiveSurface !== 'function' ||
        typeof NativeHost.render.releasePrimitiveSurface !== 'function') return null;
    var context = canvas && typeof canvas.getContext === 'function' && canvas.getContext('2d');
    if (!context || typeof context.fillRect !== 'function') return null;
    if (canvas._pmjsPrimitiveContent) return null;
    var surfaceWidth = canvas.width;
    var surfaceHeight = canvas.height;
    var surface = NativeHost.render.createPrimitiveSurface(surfaceWidth, surfaceHeight);
    if (surfaceFinalizer) surfaceFinalizer.register(canvas, surface.handle, canvas);
    var originalFillRect = context.fillRect;
    var originalFill = context.fill;
    var records = [];
    var replay = [];
    var priorReplay = [];
    var clearColor = [0, 0, 0, 0];
    var recording = false;
    var fallback = false;

    function replayRecordedCanvasOperations(force) {
      if (fallback || !force && !recording && canvas._nativeImage !== surface.image) return;
      fallback = true;
      delete canvas._nativeImage;
      var operations = priorReplay.concat(replay);
      priorReplay.length = 0;
      for (var index = 0; index < operations.length; index++) {
        var operation = operations[index];
        context.save();
        context.fillStyle = operation.style;
        context.globalAlpha = operation.alpha;
        context.globalCompositeOperation = operation.composite;
        context._clipPaths = [];
        context.setTransform.apply(context, operation.transform);
        originalFillRect.apply(context, operation.arguments);
        context.restore();
      }
    }

    context.fillRect = function(x, y, width, height) {
      if (!recording || fallback) {
        if (!recording && surface && canvas._nativeImage === surface.image) {
          replayRecordedCanvasOperations();
        }
        return originalFillRect.apply(this, arguments);
      }
      var transform = this._transform;
      var identity = transform && transform[0] === 1 && transform[1] === 0 &&
        transform[2] === 0 && transform[3] === 1;
      var blendMode = this.globalCompositeOperation === 'lighter' ? 1 :
        this.globalCompositeOperation === 'source-over' ? 0 : -1;
      var style = this.fillStyle;
      var supportedGradient = style && style._pmjsStyle === 'radial-gradient' &&
        style.nativeConcentric && style.stops.length > 0 && style.stops.length <= 3;
      var supportedSolid = typeof style === 'string' || typeof style === 'number';
      if (!identity || this._clipPaths && this._clipPaths.length ||
          blendMode < 0 || (!supportedGradient && !supportedSolid)) {
        replayRecordedCanvasOperations();
        return originalFillRect.apply(this, arguments);
      }
      var bounds = [x + transform[4], y + transform[5], width, height];
      var fullOpaque = supportedSolid && blendMode === 0 &&
        bounds[0] <= 0 && bounds[1] <= 0 && bounds[0] + bounds[2] >= canvas.width &&
        bounds[1] + bounds[3] >= canvas.height && lightColor(style, this.globalAlpha)[3] === 1;
      // A full opaque first fill reconstructs the surface independently. Other
      // updates must preserve existing Canvas content through its ordinary owner.
      if (replay.length === 0 && !fullOpaque) {
        replayRecordedCanvasOperations();
        return originalFillRect.apply(this, arguments);
      }
      if (replay.length === 0) priorReplay.length = 0;
      var replayStyle = supportedGradient ? Object.assign({}, style, { stops: style.stops.map(function(stop) {
        return { offset: stop.offset, color: stop.color };
      }) }) : style;
      replay.push({ style: replayStyle, alpha: this.globalAlpha,
        composite: this.globalCompositeOperation,
        transform: Array.prototype.slice.call(transform),
        arguments: Array.prototype.slice.call(arguments) });
      if (fullOpaque && replay.length === 1) {
        clearColor = lightColor(style, this.globalAlpha);
        return;
      }
      if (supportedGradient) {
        appendLightRecord(records, 1, bounds, [style.x0, style.y0],
          [style.r0, style.r1], style.stops, this.globalAlpha, blendMode);
      } else {
        appendLightRecord(records, 0, bounds, [0, 0], [0, 0],
          [{ offset: 0, color: style }], this.globalAlpha, blendMode);
      }
    };
    context.fill = function() {
      if (recording && !fallback || surface && canvas._nativeImage === surface.image) {
        replayRecordedCanvasOperations();
      }
      return originalFill.apply(this, arguments);
    };

    function record(draw) {
      if (!surface) return draw();
      priorReplay = canvas._nativeImage === surface.image ? replay.slice() : [];
      records.length = 0;
      replay.length = 0;
      clearColor = [0, 0, 0, 0];
      fallback = false;
      recording = true;
      try {
        if (canvas.width !== surfaceWidth || canvas.height !== surfaceHeight) {
          replayRecordedCanvasOperations();
        }
        var result = draw();
      } catch (error) {
        replayRecordedCanvasOperations();
        throw error;
      } finally {
        recording = false;
      }
      if (!replay.length) replayRecordedCanvasOperations();
      if (!fallback) {
        try {
          NativeHost.render.renderPrimitiveSurface(
            surface.handle, clearColor, records);
          canvas._nativeImage = surface.image;
          if (canvas._pmjsContentChanged) canvas._pmjsContentChanged();
        } catch (_) {
          replayRecordedCanvasOperations(true);
        }
      }
      return result;
    }

    var content = canvas._pmjsPrimitiveContent = {
      materialize: replayRecordedCanvasOperations,
      reset: function() {
        fallback = true;
        replay.length = priorReplay.length = 0;
        if (canvas._nativeImage === surface.image) delete canvas._nativeImage;
      }
    };
    var recordingFillRect = context.fillRect;
    var recordingFill = context.fill;
    return {
      record: record,
      destroy: function() {
        if (!surface) return;
        replayRecordedCanvasOperations();
        if (canvas._pmjsPrimitiveContent === content) delete canvas._pmjsPrimitiveContent;
        if (surfaceFinalizer) surfaceFinalizer.unregister(canvas);
        if (canvas._nativeImage === surface.image) delete canvas._nativeImage;
        if (context.fillRect === recordingFillRect) context.fillRect = originalFillRect;
        if (context.fill === recordingFill) context.fill = originalFill;
        NativeHost.render.releasePrimitiveSurface(surface.handle);
        surface = null;
      }
    };
  };
})();

function canvasIsUntransformedSourceOver(context) {
  var transform = context && context._transform;
  return !!(transform && transform.length === 6 &&
    transform[0] === 1 && transform[1] === 0 && transform[2] === 0 &&
    transform[3] === 1 && transform[4] === 0 && transform[5] === 0 &&
    !(context._clipPaths && context._clipPaths.length) &&
    context.globalCompositeOperation === 'source-over');
}

Object.assign(PMJS.web.canvas, {
  blur: function(canvas) {
    NativeHost.canvas.blur(canvas._ensureNativeCanvas().handle);
  },
  readPixel: function(canvas, context, x, y) {
    if (canvas && canvas._nativeCanvas) {
      var rgba = NativeHost.canvas.pixel(canvas._ensureNativeCanvas().handle, x, y);
      return [(rgba >>> 24) & 255, (rgba >>> 16) & 255,
        (rgba >>> 8) & 255, rgba & 255];
    }
    if (context && typeof context.getImageData === 'function') {
      return context.getImageData(x, y, 1, 1).data;
    }
    return null;
  },
  supportsNativeText: canvasIsUntransformedSourceOver,
  drawNativeText: function(context, text, x, baseline, style) {
    var font = contextFont(style.font);
    var canvas = context.canvas._ensureNativeCanvas();
    var options = nativeTextStyle(context, font);
    options.lineJoin = 'round'; // MV Bitmap._drawTextOutline sets this before stroking.
    if (style.outlineWidth > 0) {
      NativeHost.canvas.drawText(canvas.handle, font.paths, text,
        x, baseline, font.size, colorWithGlobalAlpha(style.outlineColor, 1),
        Math.max(0, Number(style.outlineWidth)), options);
    }
    NativeHost.canvas.drawText(canvas.handle, font.paths, text,
      x, baseline, font.size,
      colorWithGlobalAlpha(style.color, context.globalAlpha), 0, options);
  },
  measureTextWidth: function(text, descriptor) {
    var font = contextFont(descriptor);
    return NativeHost.canvas.measureText(font.paths, String(text), font.size, nativeTextStyle({}, font));
  }
});

// A full opaque red-channel fill proves unit weight for the sprite mask shader.
// Keep proof state private; consumers receive only a validated rectangle.
(function() {
  var maskProofs = new WeakMap();
  PMJS.web.canvas.trackMaskFill = function(context, x, y, width, height, color, draw) {
    var canvas = context && context.canvas;
    var eligible = canvas && Number.isFinite(canvas.__pmjsContentRevision) &&
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
