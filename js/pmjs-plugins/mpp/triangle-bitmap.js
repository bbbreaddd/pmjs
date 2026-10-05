PMJS.plugins = PMJS.plugins || {};
PMJS.plugins.mpp = PMJS.plugins.mpp || {};
Object.assign(PMJS.plugins.mpp, {
  setTriangleBitmap: function(mesh, description) {
    if (description === null) {
      PMJS.pixi4.setMeshNativeMaterial(mesh, 'mpp-triangle-bitmap', null);
      delete mesh._pmjsMppTriangleBitmap;
      return;
    }
    if (!description || !Array.isArray(description.points) || description.points.length !== 3 ||
        !description.points.every(function(point) { return Array.isArray(point) && point.length === 2; }) ||
        !Array.isArray(description.sourceBounds) || description.sourceBounds.length !== 4 ||
        !description.stroke || !Array.isArray(description.stroke.color) || description.stroke.color.length !== 3) {
      throw new TypeError('Triangle bitmap requires finite points, bounds and stroke');
    }
    var stroke = description.stroke;
    var parameters = [].concat.apply([], description.points).concat(description.sourceBounds,
      stroke.color, [stroke.alpha, stroke.width, stroke.miterLimit]);
    if (parameters.length !== 16 || !parameters.every(Number.isFinite)) {
      throw new TypeError('Triangle bitmap requires finite points, bounds and stroke');
    }
    var samples = description.strokeSamples === undefined ? 4 : description.strokeSamples;
    var coverage = description.clipCoverage === undefined ? 'canvas-crop' : description.clipCoverage;
    if (samples !== 0 && samples !== 4) throw new TypeError('Triangle stroke samples must be zero or four');
    if (coverage !== 'area' && coverage !== 'canvas-crop') throw new TypeError('Triangle clip coverage must be area or canvas-crop');
    var coefficients = nativeTrianglePaintParameters(parameters, samples, coverage);
    PMJS.pixi4.setMeshNativeMaterial(mesh, 'mpp-triangle-bitmap', {
      coefficients: Array.from(coefficients)
    });
    mesh._pmjsMppTriangleBitmap = coefficients;
  },
  clearBackground: function(texture, points, rectangles) {
    points = Float32Array.from(points);
    var normals = new Float32Array(points.length);
    for (var index = 0; index < points.length; index += 6) {
      normals.set(nativeTriangleClipNormals(points.subarray(index, index + 6)), index);
    }
    PMJS.pixi4.clearBackgroundTriangles(texture, points,
      rectangles || new Float32Array(0), normals);
  },
});
function nativeTriangleClipNormals(coordinates) {
  var points = Float32Array.from(coordinates), result = new Float32Array(6);
  var area = (points[2] - points[0]) * (points[5] - points[1]) -
    (points[3] - points[1]) * (points[4] - points[0]);
  var winding = area >= 0 ? 1 : -1;
  for (var edge = 0; edge < 3; edge++) {
    var next = (edge + 1) % 3;
    var dx = points[next * 2] - points[edge * 2];
    var dy = points[next * 2 + 1] - points[edge * 2 + 1];
    var length = Math.hypot(dx, dy) || 1;
    result[edge * 2] = -dy * winding / length;
    result[edge * 2 + 1] = dx * winding / length;
  }
  return result;
}
function nativeTrianglePaintParameters(parameters, strokeSamples, clipCoverage) {
  var result = new Float32Array(30);
  result.set(parameters);
  var points = [0, 1, 2].map(function(index) {
    return { x: parameters[index * 2], y: parameters[index * 2 + 1] };
  });
  var area = (points[1].x - points[0].x) * (points[2].y - points[0].y) -
    (points[1].y - points[0].y) * (points[2].x - points[0].x);
  var clipNormals = nativeTriangleClipNormals(result.subarray(0, 6));
  var normals = [], perimeter = 0, bevels = 0;
  for (var edge = 0; edge < 3; edge++) {
    var dx = points[(edge + 1) % 3].x - points[edge].x;
    var dy = points[(edge + 1) % 3].y - points[edge].y;
    var length = Math.hypot(dx, dy);
    perimeter += length;
    normals.push({ x: clipNormals[edge * 2], y: clipNormals[edge * 2 + 1] });
    result[16 + edge * 2] = normals[edge].x;
    result[17 + edge * 2] = normals[edge].y;
  }
  for (var corner = 0; corner < 3; corner++) {
    var before = normals[(corner + 2) % 3], after = normals[corner];
    var sumX = before.x + after.x, sumY = before.y + after.y;
    var dot = sumX * after.x + sumY * after.y;
    var miterX = sumX / Math.max(dot, 0.000001);
    var miterY = sumY / Math.max(dot, 0.000001);
    result[22 + corner * 2] = miterX;
    result[23 + corner * 2] = miterY;
    if (Math.hypot(miterX, miterY) > parameters[15]) bevels |= 1 << corner;
  }
  result[28] = Math.abs(area) / (perimeter || 1);
  result[29] = bevels | (strokeSamples === 4 ? 8 : 0) | (clipCoverage === 'canvas-crop' ? 16 : 0);
  return result;
}
