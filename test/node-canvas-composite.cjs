'use strict';

const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const crypto = require('node:crypto'), zlib = require('node:zlib'), vm = require('node:vm');
const { createHostContext } = require('./helpers/mz-host-context.cjs');
const { canvasCompositeFixtures } = require('./helpers/canvas-composite-scenario.cjs');
const { canvasRegressionFixtures } = require('./helpers/canvas-regression-scenario.cjs');
const expected = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'assets/reference/canvas-composite.json.gz'))));
assert.equal(expected.chromium, '65.0.3325.146');
assert.equal(expected.scenarioSha256, crypto.createHash('sha256').update(
  fs.readFileSync(path.join(__dirname, 'helpers/canvas-composite-scenario.cjs'))).digest('hex'));
const native = require(path.resolve(process.argv[2]));
function pixelDifferences(expected, actual) {
  const result = {max: 0, differingPixels: 0, differingChannels: 0, deltaOne: 0, deltaTwo: 0, aboveTwo: 0};
  for (let pixel = 0; pixel < expected.length; pixel += 4) {
    let different = false;
    for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs(expected[pixel + channel] - actual[pixel + channel]);
      if (!delta) continue;
      different = true; result.differingChannels++;
      result.max = Math.max(result.max, delta);
      if (delta === 1) result.deltaOne++;
      else if (delta === 2) result.deltaTwo++;
      else result.aboveTwo++;
    }
    if (different) result.differingPixels++;
  }
  return result;
}
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 32, height: 32, windowTitle: 'Canvas composition' });
try {
  const context = createHostContext(native, { graphics: false });
  context.PMJS.config.fonts.ShapingFont = 'text-shaping.ttf';
  const encodedCanvas = context.document.createElement('canvas'); encodedCanvas.width = encodedCanvas.height = 8;
  encodedCanvas.getContext('2d').fillStyle = '#ff000080'; encodedCanvas.getContext('2d').fillRect(0, 0, 8, 8);
  for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/unknown']) {
    const mime = type === 'image/unknown' ? 'image/png' : type;
    const url = encodedCanvas.toDataURL(type, 0.8);
    assert.ok(url.startsWith('data:' + mime + ';base64,'));
    const bytes = Buffer.from(url.split(',')[1], 'base64');
    const decoded = native.images.loadBytes(bytes);
    assert.deepEqual([decoded.width, decoded.height], [8, 8]);
    assert.equal(native.images.isOpaque(decoded.handle), mime === 'image/jpeg');
    if (mime === 'image/jpeg') assert.deepEqual(Array.from(bytes.subarray(0, 2)), [255, 216]);
    if (mime === 'image/webp') assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
    native.images.release(decoded.handle);
    assert.throws(() => native.images.isOpaque(decoded.handle), /cannot inspect image opacity/);
  }
  encodedCanvas._releaseNativeCanvas();
  const qualityCanvas = context.document.createElement('canvas'); qualityCanvas.width = qualityCanvas.height = 16;
  const qualityPixels = new Uint8ClampedArray(16 * 16 * 4);
  for (let i = 0; i < qualityPixels.length; i += 4)
    qualityPixels.set([(i * 73) & 255, (i * 29 + 37) & 255, (i * 11 + 193) & 255, 255], i);
  qualityCanvas.getContext('2d').putImageData(new context.ImageData(qualityPixels, 16, 16), 0, 0);
  const encode = (type, quality) => Buffer.from(qualityCanvas.toDataURL(type, quality).split(',')[1], 'base64');
  const lossless = encode('image/webp', 1);
  const decodedLossless = native.images.loadBytes(lossless);
  try {
    const target = context.document.createElement('canvas'); target.width = target.height = 16;
    try {
      target.getContext('2d').drawImage({width: 16, height: 16, _nativeImage: decodedLossless}, 0, 0);
      assert.deepEqual(Array.from(target.getContext('2d').getImageData(0, 0, 16, 16).data),
        Array.from(qualityPixels), 'WebP quality one preserves every opaque RGB byte');
    } finally { target._releaseNativeCanvas(); }
  } finally { native.images.release(decodedLossless.handle); }
  assert.equal(lossless.toString('ascii', 12, 16), 'VP8L');
  for (const quality of [undefined, 0.8, 1 - Number.EPSILON, NaN, -1, '1'])
    assert.equal(encode('image/webp', quality).toString('ascii', 12, 16), 'VP8 ', 'lossy WebP quality ' + quality);
  function jpegSampling(bytes) {
    for (let offset = 2; offset < bytes.length;) {
      assert.equal(bytes[offset], 255);
      const marker = bytes[offset + 1], length = bytes.readUInt16BE(offset + 2);
      if (marker === 0xc0) {
        const components = bytes[offset + 9];
        return Array.from({length: components}, (_, index) => bytes[offset + 11 + index * 3]);
      }
      offset += 2 + length;
    }
    throw new Error('JPEG frame header missing');
  }
  for (const quality of [1, 0.999, 0.995])
    assert.deepEqual(jpegSampling(encode('image/jpeg', quality)), [0x11, 0x11, 0x11], 'rounded quality 100 uses 4:4:4');
  for (const quality of [undefined, 0.994, 0.8])
    assert.deepEqual(jpegSampling(encode('image/jpeg', quality)), [0x22, 0x11, 0x11], 'lower JPEG quality retains 4:2:0');
  qualityCanvas._releaseNativeCanvas();
  vm.runInContext('globalThis.canvasCompositeFixtures = ' + canvasCompositeFixtures.toString(), context);
  const actual = context.canvasCompositeFixtures();
  const failures = [];
  for (const [label, pixels] of Object.entries(expected.frames)) {
    assert.equal(actual[label].length, pixels.length);
    const max = Math.max(...pixels.map((byte, index) => Math.abs(byte - actual[label][index])));
    const tolerance = expected.channelTolerances[label] || expected.channelTolerance;
    if (max > tolerance) failures.push({ label, max });
  }
  assert.deepEqual(failures, [], 'browser composite pixel differences');

  const regression = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'assets/reference/canvas-regressions.json.gz'))));
  require('../tools/generate-canvas-regressions-reference.cjs').validateFixture(regression);
  vm.runInContext('globalThis.canvasRegressionFixtures = ' + canvasRegressionFixtures.toString(), context);
  const differences = [];
  const pixelReports = [];
  const create = native.canvas.create;
  const nativeAffine = native.canvas.drawAffineImage;
  for (const affine of [false, true]) for (const immediate of [false, true]) {
    native.canvas.drawAffineImage = affine ? nativeAffine : undefined;
    native.canvas.create = function(width, height, opaque) {
      const canvas = create(width, height, !!opaque);
      if (immediate) native.canvas.readPixels(canvas.handle, 0, 0, 1, 1);
      return canvas;
    };
    try {
      const regressionFrames = context.canvasRegressionFixtures();
      assert.deepEqual(Object.keys(regressionFrames), Object.keys(regression.frames));
      for (const [name, pixels] of Object.entries(regression.frames)) {
        assert.equal(regressionFrames[name].length, pixels.length);
        const report = {name, immediate, affine, ...pixelDifferences(pixels, regressionFrames[name])};
        pixelReports.push(report);
        if (report.max > regression.channelTolerance) differences.push(report);
      }
    } finally { native.canvas.create = create; native.canvas.drawAffineImage = nativeAffine; }
  }
  if (process.env.PMJS_CANVAS_DIFFERENCE_REPORT)
    fs.writeFileSync(process.env.PMJS_CANVAS_DIFFERENCE_REPORT, JSON.stringify(pixelReports, null, 2) + '\n');
  console.log(JSON.stringify({comparisons: pixelReports.length,
    exact: pixelReports.filter(report => report.max === 0).length,
    differingPixels: pixelReports.reduce((total, report) => total + report.differingPixels, 0),
    deltaOne: pixelReports.reduce((total, report) => total + report.deltaOne, 0),
    deltaTwo: pixelReports.reduce((total, report) => total + report.deltaTwo, 0),
    maximumDifference: Math.max(...pixelReports.map(report => report.max))}));
  assert.deepEqual(differences, [], 'browser regression pixel differences');

  for (const [offset, blur] of [[10000, 0], [-10000, 3], [2, 10000]]) {
    const target = context.document.createElement('canvas'); target.width = target.height = 8;
    const sizes = [], originalCreate = native.canvas.create;
    native.canvas.create = function(width, height, opaque) {
      sizes.push([width, height]); return originalCreate(width, height, opaque);
    };
    try {
      const paint = target.getContext('2d');
      paint.shadowColor = 'red'; paint.shadowOffsetX = offset; paint.shadowOffsetY = -offset; paint.shadowBlur = blur;
      paint.fillRect(1 - offset, 1 + offset, 3, 3);
      assert.ok(sizes.length >= 2, 'shadow and destination allocated');
      assert.ok(sizes.every(([width, height]) => width <= 16 && height <= 16),
        'shadow source capture follows geometry, independently of offset and blur');
    } finally { native.canvas.create = originalCreate; target._releaseNativeCanvas(); }
  }

  for (const rule of ['nonzero', 'evenodd']) for (const method of ['fill', 'image']) {
    const target = context.document.createElement('canvas'); target.width = target.height = 8;
    const source = context.document.createElement('canvas'); source.width = source.height = 1;
    try {
      source.getContext('2d').fillStyle = 'white'; source.getContext('2d').fillRect(0, 0, 1, 1);
      const paint = target.getContext('2d'); paint.fillStyle = 'blue'; paint.fillRect(0, 0, 8, 8);
      paint.beginPath(); paint.rect(1, 1, 6, 6);
      paint.moveTo(3, 3); paint.lineTo(3, 5); paint.lineTo(5, 5); paint.lineTo(5, 3); paint.closePath();
      paint.clip(rule); paint.save(); paint.beginPath(); paint.rect(2, 0, 6, 8); paint.clip();
      paint.fillStyle = 'white';
      if (method === 'fill') { paint.beginPath(); paint.rect(0, 0, 8, 8); paint.fill(); }
      else paint.drawImage(source, 0, 0, 8, 8);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const inside = x >= 2 && x < 7 && y >= 1 && y < 7 && !(x >= 3 && x < 5 && y >= 3 && y < 5);
        assert.deepEqual(Array.from(paint.getImageData(x, y, 1, 1).data),
          inside ? [255, 255, 255, 255] : [0, 0, 255, 255], 'nested clip hole: ' + rule + '/' + method + '/' + x + '/' + y);
      }
      paint.restore(); paint.fillStyle = 'white'; paint.fillRect(1, 1, 1, 1);
      assert.deepEqual(Array.from(paint.getImageData(1, 1, 1, 1).data), [255, 255, 255, 255]);
    } finally { target._releaseNativeCanvas(); source._releaseNativeCanvas(); }
  }

  for (const opaque of [false, true]) {
    const source = context.document.createElement('canvas'); source.width = source.height = 2;
    const drawing = source.getContext('2d', {alpha: !opaque});
    drawing.putImageData(new context.ImageData(new Uint8ClampedArray([
      32, 128, 192, 255, 32, 128, 192, opaque ? 255 : 0,
      32, 128, 192, opaque ? 255 : 128, 32, 128, 192, opaque ? 255 : 64
    ]), 2, 2), 0, 0);
    const loaded = native.images.loadBytes(Buffer.from(source.toDataURL().split(',')[1], 'base64'));
    try {
      assert.equal(native.images.isOpaque(loaded.handle), opaque);
      for (const operation of ['source-over', 'source-in', 'destination-over', 'copy', 'lighter', 'multiply', 'exclusion']) {
        const frames = [];
        for (const input of [source, {width: 2, height: 2, _nativeImage: loaded}]) {
          const target = context.document.createElement('canvas'); target.width = target.height = 8;
          const paint = target.getContext('2d');
          paint.fillStyle = '#2060a080'; paint.fillRect(0, 0, 5, 8);
          paint.shadowColor = '#ff0000c0'; paint.shadowOffsetX = 2; paint.shadowOffsetY = 1; paint.shadowBlur = 3;
          paint.globalAlpha = 0.5; paint.globalCompositeOperation = operation; paint.imageSmoothingEnabled = false;
          paint.drawImage(input, 1, 1, 3, 3);
          frames.push(native.canvas.readPremultipliedPixels(target._nativeCanvas.handle, 0, 0, 8, 8));
          target._releaseNativeCanvas();
        }
        const max = frames[0].reduce((maximum, value, index) => Math.max(maximum, Math.abs(value - frames[1][index])), 0);
        assert.ok(max <= 2, 'loaded image shadow differs from canvas source: ' + operation + '/' + opaque + '/' + max);
      }
    } finally { native.images.release(loaded.handle); source._releaseNativeCanvas(); }
  }

  const image = native.images.load('fixture.png');
  try {
    const imageSource = { width: image.width, height: image.height, _nativeImage: image };
    for (const smoothing of [false, true]) for (const operation of ['source-over', 'copy', 'multiply']) {
      const results = [];
      for (const affine of [false, true]) {
        const target = context.document.createElement('canvas'); target.width = target.height = 8;
        const drawing = target.getContext('2d');
        drawing.fillStyle = '#2060a080'; drawing.fillRect(0, 0, 8, 8);
        drawing.imageSmoothingEnabled = smoothing; drawing.globalAlpha = 0.5;
        drawing.globalCompositeOperation = operation; drawing.setTransform(-1, 0.25, 0.3, 1, 6, 0);
        native.canvas.drawAffineImage = affine ? nativeAffine : undefined;
        try { drawing.drawImage(imageSource, 0, 0, 6, 6); }
        finally { native.canvas.drawAffineImage = nativeAffine; }
        results.push(native.canvas.readPremultipliedPixels(target._ensureNativeCanvas().handle, 0, 0, 8, 8));
        target._releaseNativeCanvas();
      }
      assert.deepEqual(results[0], results[1], 'decoded image affine parity: ' + operation + '/' + smoothing);
    }
    const target = context.document.createElement('canvas'); target.width = target.height = 8;
    const drawing = target.getContext('2d'); drawing.setTransform(1, 0.25, -0.25, 1, 2, 0);
    const read = native.canvas.readPremultipliedPixels, create = native.canvas.create, composite = native.canvas.compositePixels;
    native.canvas.readPremultipliedPixels = native.canvas.create = native.canvas.compositePixels = function() {
      throw new Error('affine image drawing must not transfer source or destination pixels through JavaScript');
    };
    // Allocate the destination before counting temporary surfaces.
    native.canvas.create = create; target._ensureNativeCanvas();
    native.canvas.create = function() { throw new Error('affine image drawing must not create a temporary canvas'); };
    try { drawing.drawImage(imageSource, 0, 0, 6, 6); }
    finally { native.canvas.readPremultipliedPixels = read; native.canvas.create = create; native.canvas.compositePixels = composite; }
    target._releaseNativeCanvas();
  } finally { native.images.release(image.handle); }

  for (const affine of [false, true]) {
    const target = context.document.createElement('canvas'); target.width = target.height = 8;
    const retained = context.document.createElement('canvas'); retained.width = retained.height = 8;
    const drawing = target.getContext('2d');
    drawing.fillStyle = 'red'; drawing.fillRect(0, 0, 4, 8);
    retained.getContext('2d').drawImage(target, 0, 0);
    drawing.setTransform(-1, 0, 0, 1, 8, 0);
    native.canvas.drawAffineImage = affine ? nativeAffine : undefined;
    try { drawing.drawImage(target, 0, 0); }
    finally { native.canvas.drawAffineImage = nativeAffine; }
    assert.deepEqual(Array.from(drawing.getImageData(7, 4, 1, 1).data), [255, 0, 0, 255], 'self draw samples captured content');
    target._releaseNativeCanvas();
    assert.deepEqual(Array.from(retained.getContext('2d').getImageData(7, 4, 1, 1).data), [0, 0, 0, 0], 'retained content survives affine mutation and release');
    retained._releaseNativeCanvas();
  }

  const opaque = {
    'source-over': [255, 0, 0, 255], 'source-in': [255, 0, 0, 255], 'source-out': [0, 0, 0, 0],
    'source-atop': [255, 0, 0, 255], 'destination-over': [0, 255, 255, 255],
    'destination-in': [0, 255, 255, 255], 'destination-out': [0, 0, 0, 0],
    'destination-atop': [0, 255, 255, 255], lighter: [255, 255, 255, 255], copy: [255, 0, 0, 255],
    xor: [0, 0, 0, 0], multiply: [0, 0, 0, 255], screen: [255, 255, 255, 255],
    overlay: [0, 255, 255, 255], darken: [0, 0, 0, 255], lighten: [255, 255, 255, 255],
    'color-dodge': [0, 255, 255, 255], 'color-burn': [0, 255, 255, 255],
    'hard-light': [255, 0, 0, 255], 'soft-light': [0, 255, 255, 255],
    difference: [255, 255, 255, 255], exclusion: [255, 255, 255, 255],
    hue: [255, 146, 146, 255], saturation: [0, 255, 255, 255],
    color: [255, 146, 146, 255], luminosity: [0, 109, 109, 255]
  };
  const fractional = {
    'source-over': [128, 64, 64, 192], 'source-in': [64, 0, 0, 64], 'source-out': [64, 0, 0, 64],
    'source-atop': [64, 64, 64, 128], 'destination-over': [64, 128, 128, 192],
    'destination-in': [0, 64, 64, 64], 'destination-out': [0, 64, 64, 64],
    'destination-atop': [64, 64, 64, 128], lighter: [128, 128, 128, 255], copy: [128, 0, 0, 128],
    xor: [64, 64, 64, 127], multiply: [64, 64, 64, 192], screen: [128, 128, 128, 192],
    overlay: [64, 128, 128, 192], darken: [64, 64, 64, 192], lighten: [128, 128, 128, 192],
    'color-dodge': [64, 128, 128, 192], 'color-burn': [64, 128, 128, 192],
    'hard-light': [128, 64, 64, 192], 'soft-light': [64, 128, 128, 192],
    difference: [128, 128, 128, 192], exclusion: [128, 128, 128, 192],
    hue: [128, 100, 100, 192], saturation: [64, 128, 128, 192],
    color: [128, 100, 100, 192], luminosity: [64, 91, 91, 192]
  };
  const probe = native.canvas.create(1, 1);
  try {
    for (const [alpha, rows] of [[255, opaque], [128, fractional]]) {
      for (const [operation, pixel] of Object.entries(rows)) {
        native.canvas.writePremultipliedPixels(probe.handle, 0, 0, 1, 1, new Uint8Array([0, alpha, alpha, alpha]));
        native.canvas.compositePixels(probe.handle, 0, 0, 1, 1, new Uint8Array([alpha, 0, 0, alpha]), new Uint8Array([255]), operation, 1);
        assert.deepEqual(Array.from(native.canvas.readPremultipliedPixels(probe.handle, 0, 0, 1, 1)), pixel,
          'compositing equations: ' + operation + ', alpha=' + alpha);
      }
    }
    for (const operation of Object.keys(opaque)) {
      native.canvas.writePremultipliedPixels(probe.handle, 0, 0, 1, 1, new Uint8Array([0, 128, 128, 128]));
      native.canvas.compositePixels(probe.handle, 0, 0, 1, 1, new Uint8Array(4), new Uint8Array([255]), operation, 1);
      const clears = ['source-in', 'source-out', 'destination-in', 'destination-atop', 'copy'].includes(operation);
      assert.deepEqual(Array.from(native.canvas.readPremultipliedPixels(probe.handle, 0, 0, 1, 1)),
        clears ? [0, 0, 0, 0] : [0, 128, 128, 128], 'transparent source: ' + operation);
    }
  } finally { native.canvas.release(probe.handle); }

  const transparentSource = context.document.createElement('canvas');
  transparentSource.width = transparentSource.height = 4;
  transparentSource.getContext('2d').fillStyle = 'rgba(255,0,0,0.5)';
  transparentSource.getContext('2d').fillRect(0, 0, 4, 4);
  for (const operation of Object.keys(opaque)) {
    for (const shape of ['rectangle', 'image', 'path', 'circle', 'stroke', 'strokeRect']) {
      const surface = context.document.createElement('canvas'); surface.width = surface.height = 8;
      const paint = surface.getContext('2d');
      paint.globalCompositeOperation = operation; paint.globalAlpha = 0.5;
      paint.fillStyle = paint.strokeStyle = 'rgba(255,0,0,0.5)';
      if (shape === 'rectangle') paint.fillRect(1, 1, 4, 4);
      else if (shape === 'image') paint.drawImage(transparentSource, 1, 1);
      else if (shape === 'circle') { paint.beginPath(); paint.arc(3, 3, 2, 0, Math.PI * 2); paint.fill(); }
      else if (shape === 'path') { paint.beginPath(); paint.rect(1, 1, 4, 4); paint.fill(); }
      else if (shape === 'strokeRect') { paint.lineWidth = 2; paint.strokeRect(3, 1, 3, 4); }
      else { paint.beginPath(); paint.moveTo(0, 3); paint.lineTo(8, 3); paint.lineWidth = 2; paint.stroke(); }
      const invisible = ['source-in', 'source-atop', 'destination-in', 'destination-out'].includes(operation);
      assert.deepEqual(Array.from(paint.getImageData(3, 3, 1, 1).data),
        invisible ? [0, 0, 0, 0] : [255, 0, 0, 64], 'transparent backdrop: ' + operation + '/' + shape);
    }
  }

  const canvas = context.document.createElement('canvas'); canvas.width = canvas.height = 8;
  const drawing = canvas.getContext('2d');
  drawing.globalCompositeOperation = 'multiply';
  drawing.globalCompositeOperation = 'invalid';
  assert.equal(drawing.globalCompositeOperation, 'multiply');
  for (const [operation, expectedPixel] of [
    ['saturation', [0, 255, 0, 255]], ['multiply', [0, 0, 0, 255]], ['destination-out', [0, 0, 0, 0]]
  ]) {
    drawing.globalCompositeOperation = 'source-over'; drawing.fillStyle = 'lime'; drawing.fillRect(0, 0, 8, 8);
    drawing.globalCompositeOperation = operation; drawing.fillStyle = 'red'; drawing.fillRect(0, 0, 8, 8);
    assert.deepEqual(Array.from(drawing.getImageData(4, 4, 1, 1).data), expectedPixel, operation);
  }

  drawing.globalCompositeOperation = 'source-over'; drawing.fillStyle = 'blue'; drawing.fillRect(0, 0, 8, 8);
  drawing.globalCompositeOperation = 'copy'; drawing.fillStyle = 'rgba(255,0,0,0.5)';
  drawing.fillRect(1, 1, 0, 4);
  assert.deepEqual(Array.from(drawing.getImageData(3, 3, 1, 1).data), [0, 0, 255, 255], 'empty fillRect has no compositing effect');
  drawing.beginPath(); drawing.rect(1, 1, 4, 4); drawing.fill();
  assert.deepEqual(Array.from(drawing.getImageData(3, 3, 1, 1).data), [255, 0, 0, 128]);
  assert.deepEqual(Array.from(drawing.getImageData(7, 7, 1, 1).data), [0, 0, 0, 0], 'copy clears outside shape');

  const patternSource = vm.runInContext('document.createElement("canvas")', context);
  patternSource.width = patternSource.height = 2;
  patternSource.getContext('2d').fillRect(0, 0, 2, 2);
  const linear = drawing.createLinearGradient(0, 0, 8, 8);
  linear.addColorStop(0, 'red'); linear.addColorStop(1, 'blue');
  const radial = drawing.createRadialGradient(4, 4, 0, 4, 4, 3);
  radial.addColorStop(0, 'red'); radial.addColorStop(1, 'blue');
  const paints = ['red', linear, radial, drawing.createPattern(patternSource, 'repeat')];
  const read = native.canvas.readPremultipliedPixels, write = native.canvas.writePremultipliedPixels;
  let readbacks = 0, writes = 0;
  native.canvas.readPremultipliedPixels = function() { readbacks++; return read.apply(this, arguments); };
  native.canvas.writePremultipliedPixels = function() { writes++; return write.apply(this, arguments); };
  try {
    for (const paint of paints) {
      drawing.fillStyle = paint;
      drawing.globalCompositeOperation = 'source-over';
      drawing.beginPath(); drawing.arc(4, 4, 3, 0, Math.PI * 2); drawing.fill();
    }
  } finally { native.canvas.readPremultipliedPixels = read; native.canvas.writePremultipliedPixels = write; }
  assert.equal(readbacks, 0, 'circle painting owns destination pixels');
  assert.equal(writes, 0, 'circle painting never uploads destination pixels from JavaScript');

  for (const kind of ['clips', 'linear', 'radial']) {
    const surface = context.document.createElement('canvas'); surface.width = surface.height = 8;
    const paint = surface.getContext('2d');
    paint.fillStyle = 'red';
    if (kind === 'clips') {
      for (let i = 0; i < 65; i++) {
        paint.beginPath(); paint.rect(2, 0, 4, 8); paint.clip();
      }
    } else {
      const gradient = kind === 'linear' ? paint.createLinearGradient(0, 0, 8, 8) :
        paint.createRadialGradient(4, 4, 0, 4, 4, 4);
      for (let i = 0; i < 65; i++) gradient.addColorStop(i / 64, 'red');
      paint.fillStyle = gradient;
    }
    paint.beginPath(); paint.arc(4, 4, 3, 0, Math.PI * 2); paint.fill();
    assert.deepEqual(Array.from(paint.getImageData(4, 4, 1, 1).data), [255, 0, 0, 255],
      'circle painting supports more than 64 ' + kind);
    if (kind === 'clips') assert.deepEqual(Array.from(paint.getImageData(1, 4, 1, 1).data),
      [0, 0, 0, 0], 'repeated clips retain their intersection');
  }

  for (const operation of ['source-in', 'source-out', 'destination-in', 'destination-atop', 'copy']) {
    const surface = context.document.createElement('canvas'); surface.width = surface.height = 8;
    const paint = surface.getContext('2d');
    paint.fillStyle = 'blue'; paint.fillRect(0, 0, 8, 8);
    paint.beginPath(); paint.rect(1.25, 0, 4.5, 8); paint.clip();
    paint.globalCompositeOperation = operation; paint.fillStyle = 'red';
    paint.beginPath(); paint.arc(4, 4, 1, 0, Math.PI * 2); paint.fill();
    assert.deepEqual(Array.from(paint.getImageData(1, 1, 1, 1).data), [0, 0, 255, 64],
      'transparent-source clearing retains uncovered clip fraction: ' + operation);
    assert.deepEqual(Array.from(paint.getImageData(0, 1, 1, 1).data), [0, 0, 255, 255],
      'transparent-source clearing preserves pixels outside clip: ' + operation);
  }

  for (const circle of [false, true]) {
    const source = native.canvas.create(8, 8), retained = native.canvas.create(8, 8);
    try {
      native.canvas.fillRect(source.handle, 0, 0, 8, 8, 0x0000ffff);
      native.canvas.drawImage(retained.handle, source.handle, 0, 0, 8, 8, 0, 0, 8, 8, 1);
      if (circle) native.canvas.paintCircle(source.handle, {
        geometry: [4, 4, 3], transform: [1, 0, 0, 1, 0, 0], paint: { kind: 'solid', color: 0xff0000ff },
        globalAlpha: 1, composite: 'source-over', clips: []
      });
      else native.canvas.compositePixels(source.handle, 0, 0, 1, 1,
        new Uint8Array([255, 0, 0, 255]), new Uint8Array([255]), 'copy', 1);
      native.canvas.release(source.handle);
      assert.deepEqual(Array.from(native.canvas.readPremultipliedPixels(retained.handle, 4, 4, 1, 1)),
        [0, 0, 255, 255], 'retained source content survives paint and source release');
    } finally { native.canvas.release(retained.handle); }
  }

  const handle = canvas._ensureNativeCanvas().handle;
  const frozen = native.canvas.readPremultipliedPixels(handle, 0, 0, 8, 8);
  assert.throws(() => native.canvas.compositePixels(handle, 0, 0, 1, 1, new Uint8Array(3), new Uint8Array(1), 'copy', 1), RangeError);
  assert.throws(() => native.canvas.compositePixels(handle, 0, 0, 1, 1, new Uint8Array(4), new Uint8Array(1), 'invalid', 1), RangeError);
  assert.throws(() => native.canvas.paintCircle(handle, { geometry: [4, 4, -1],
    transform: [1, 0, 0, 1, 0, 0], paint: { kind: 'solid', color: 0xffffffff },
    globalAlpha: 1, composite: 'copy', clips: [] }), RangeError);
  assert.throws(() => native.canvas.paintPath(handle, {
    paths: [[[1, 1], [6, 1]]], closed: [], transform: [1, 0, 0, 1, 0, 0],
    paint: { kind: 'solid', color: 0xffffffff }, globalAlpha: 1, composite: 'copy',
    clips: [], stroke: 2, cap: 0, join: 0, miterLimit: 10, clear: false
  }), { name: 'TypeError', message: 'invalid Canvas path paint' });
  assert.throws(() => native.canvas.drawAffineImage(handle, handle, {
    geometry: [0, 0, 8, 8, 0, 0, 8, 8], transform: [1, NaN, 0, 1, 0, 0],
    globalAlpha: 1, composite: 'copy', clips: [], smoothing: true
  }), RangeError);
  assert.deepEqual(native.canvas.readPremultipliedPixels(handle, 0, 0, 8, 8), frozen, 'invalid requests leave pixels unchanged');
  console.log('Canvas composite browser cases passed:', Object.keys(actual).length);
} finally { native.runtime.quit(); }
