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
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 32, height: 32, windowTitle: 'Canvas composition' });
try {
  const context = createHostContext(native, { graphics: false });
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
  const create = native.canvas.create;
  for (const immediate of [false, true]) {
    native.canvas.create = function(width, height) {
      const canvas = create(width, height);
      if (immediate) native.canvas.readPixels(canvas.handle, 0, 0, 1, 1);
      return canvas;
    };
    try {
      const regressionFrames = context.canvasRegressionFixtures();
      assert.deepEqual(Object.keys(regressionFrames), Object.keys(regression.frames));
      for (const [name, pixels] of Object.entries(regression.frames)) {
        const max = Math.max(...pixels.map((value, index) => Math.abs(value - regressionFrames[name][index])));
        if (max > regression.channelTolerance) differences.push({ name, max, immediate });
      }
    } finally { native.canvas.create = create; }
  }
  assert.deepEqual(differences, [], 'browser regression pixel differences');

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
  assert.deepEqual(native.canvas.readPremultipliedPixels(handle, 0, 0, 8, 8), frozen, 'invalid requests leave pixels unchanged');
  console.log('Canvas composite browser cases passed:', Object.keys(actual).length);
} finally { native.runtime.quit(); }
