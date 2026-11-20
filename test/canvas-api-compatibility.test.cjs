'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const calls = [];
  const realm = vm.createContext({ NativeHost: { runtime: { env: () => '' }, canvas: {
    create(width, height) { calls.push(['create', width, height]); return { handle: 1 }; },
    release() {}, fillRect() { calls.push(['fill']); }, clear() { calls.push(['clear']); },
    clearRect() { calls.push(['clearRect']); }, paintCircle() { calls.push(['circle']); },
    compositePixels() { calls.push(['pixels']); },
    readPixels(handle, x, y, width, height) {
      calls.push(['read', x, y, width, height]); return new Uint8Array(width * height * 4);
    }
  } } });
  for (const file of ['events', 'canvas', 'elements']) vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../js/pmjs-web', file + '.js'), 'utf8'), realm);
  const canvas = new realm.CanvasElement(); canvas.width = canvas.height = 8;
  return { realm, canvas, context: canvas.getContext('2d'), calls };
}

test('save, restore and resize share line-state defaults and preserve the current path', () => {
  const { canvas, context } = harness();
  context.lineCap = 'square'; context.lineJoin = 'bevel'; context.miterLimit = 3;
  context.moveTo(1, 2); context.save();
  context.lineCap = 'round'; context.lineJoin = 'round'; context.miterLimit = 8;
  context.lineTo(3, 4); context.restore();
  assert.deepEqual([context.lineCap, context.lineJoin, context.miterLimit], ['square', 'bevel', 3]);
  assert.equal(context._path[0].length, 2);
  for (const invalid of [0, -1, NaN, Infinity]) context.miterLimit = invalid;
  context.lineCap = 'invalid'; context.lineJoin = 'invalid';
  assert.deepEqual([context.lineCap, context.lineJoin, context.miterLimit], ['square', 'bevel', 3]);
  canvas.width = canvas.width;
  assert.deepEqual([context.lineCap, context.lineJoin, context.miterLimit], ['butt', 'miter', 10]);
  assert.equal(context._path.length, 0);
});

test('image-data regions use signed integer conversion, negative-size normalization and zero-size errors', () => {
  const { context, calls } = harness();
  const data = context.getImageData(6.9, 7.9, -3.9, -4.9);
  assert.deepEqual([data.width, data.height], [3, 4]);
  assert.deepEqual(calls.at(-1), ['read', 3, 3, 3, 4]);
  context.getImageData(-0.5, 0, 1.5, 1);
  assert.deepEqual(calls.at(-1), ['read', 0, 0, 1, 1]);
  for (const width of [0, 0.5, NaN, Infinity]) {
    assert.throws(() => context.getImageData(0, 0, width, 1), { name: 'IndexSizeError', code: 1 });
    assert.throws(() => context.createImageData(width, 1), { name: 'IndexSizeError', code: 1 });
  }
  assert.throws(() => context.getImageData(0, 0, 1), { name: 'TypeError' });
  assert.throws(() => context.createImageData({ width: 2, height: 2 }), { name: 'TypeError' });
  assert.throws(() => context.createImageData(1n, 2), { name: 'TypeError' });
});

test('getImageData uses each fresh native buffer without copying or sharing separate reads', () => {
  const { realm, context } = harness();
  const buffers = [];
  realm.NativeHost.canvas.readPixels = (_handle, _x, _y, width, height) => {
    const buffer = new ArrayBuffer(width * height * 4 + 8);
    const pixels = new Uint8Array(buffer, 4, width * height * 4);
    pixels.fill(37);
    buffers.push(buffer);
    return pixels;
  };
  const first = context.getImageData(0, 0, 2, 3);
  const second = context.getImageData(0, 0, 2, 3);
  assert.equal(first.data.buffer, buffers[0]);
  assert.equal(first.data.byteOffset, 4);
  assert.equal(first.data.byteLength, 24);
  assert.ok(vm.runInContext('Uint8ClampedArray', realm).prototype.isPrototypeOf(first.data));
  assert.equal(second.data.buffer, buffers[1]);
  first.data[0] = 999;
  assert.equal(first.data[0], 255);
  assert.equal(second.data[0], 37);
});

test('createImageData returns independent transparent data for both overloads', () => {
  const { context, calls } = harness();
  const source = context.createImageData(-3, -2); source.data.fill(255);
  const copy = context.createImageData(source);
  assert.deepEqual([copy.width, copy.height], [3, 2]);
  assert.ok(copy.data.every(value => value === 0));
  assert.notEqual(copy.data, source.data);
  assert.equal(calls.length, 0);
});

test('zero-sized canvases serialize and read as empty without exposing native backing', () => {
  for (const axis of ['width', 'height']) {
    const { realm, canvas, context, calls } = harness();
    canvas[axis] = 0;
    assert.deepEqual(Array.from(realm.PMJS.web.canvas.readPixel(canvas, context, 0, 0)), [0, 0, 0, 0]);
    context.fillRect(0, 0, 1, 1); context.clearRect(0, 0, 1, 1);
    assert.equal(canvas.toDataURL(), 'data:,');
    const data = context.getImageData(-1, -1, 3, 3);
    assert.equal(data.data.length, 36); assert.ok(data.data.every(value => value === 0));
    assert.equal(calls.length, 0);
  }
});

test('singular transforms do not submit rectangles or path paints', () => {
  const { context, calls } = harness();
  context.moveTo(0, 0); context.lineTo(6, 6);
  context.setTransform(1, 1, 1, 1, 0, 0);
  context.fillRect(0, 0, 5, 5); context.clearRect(0, 0, 5, 5);
  context.strokeRect(0, 0, 5, 5); context.fill(); context.stroke();
  assert.equal(calls.length, 0);
});

test('arc radii validate before singular transforms but after finite arguments', () => {
  const { context } = harness();
  for (const transform of [[0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 0, 0]]) {
    context.setTransform(...transform);
    assert.throws(() => context.arc(4, 4, -1, 0, Math.PI), { name: 'IndexSizeError', code: 1 });
    assert.throws(() => context.arcTo(4, 4, 6, 6, -1), { name: 'IndexSizeError', code: 1 });
    assert.doesNotThrow(() => context.arc(NaN, 4, -1, 0, Math.PI));
    assert.doesNotThrow(() => context.arcTo(4, Infinity, 6, 6, -1));
    assert.doesNotThrow(() => context.arc(4, 4, 1, 0, Math.PI));
    assert.equal(context._path.length, 0);
  }
});

test('gradient fallback extends interior stops to both ends under transformed sampling', () => {
  const { realm, context } = harness();
  const gradient = context.createLinearGradient(0, 0, 8, 0);
  gradient.addColorStop(0.25, 'red'); gradient.addColorStop(0.75, 'blue');
  for (const [x, color] of [[0, 0xff0000ff], [8, 0x0000ffff]]) {
    assert.equal(realm.canvasStyleRgba(gradient, x, 0, 1), color);
    assert.equal(realm.canvasStyleRgba(gradient, 8, x, 1, [0, 1, -1, 0, 8, 0]), color);
  }
});

test('full arcs fill without polygon construction and retain captured geometry for later commands', () => {
  const { context, calls } = harness();
  context.arc(2, 2, 10000, 0, Math.PI * 2); context.fill();
  assert.deepEqual(calls, [['create', 8, 8], ['circle']]);
  assert.equal(context._path.length, 0);
  context.translate(3, 4); context.lineTo(5, 6);
  assert.ok(context._path[0].length <= 8194);
  assert.deepEqual(Array.from(context._path[0][0]), [10002, 2]);
  assert.deepEqual(Array.from(context._path[0].at(-1)), [8, 10]);
  context.beginPath(); context.arc(4, 4, 2, 0, Math.PI * 2); context.clip();
  assert.equal(context._clipPaths.length, 1);
  assert.ok(context._clipPaths[0].paths[0].length > 2);
});

test('portable rectangle coverage and stroke outlines preserve fractional fills and transformed caps', () => {
  const { realm, context } = harness();
  const pixels = new Uint8Array(8 * 8 * 4);
  realm.NativeHost.canvas.compositePixels = function(handle, left, top, width, height, data) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
      pixels.set(data.subarray((y * width + x) * 4, (y * width + x + 1) * 4), ((top + y) * 8 + left + x) * 4);
  };
  const alpha = (x, y) => pixels[(y * 8 + x) * 4 + 3];
  context.fillStyle = 'red'; context.fillRect(0.25, 0.25, 1, 1);
  [alpha(0, 0), alpha(1, 0), alpha(0, 1), alpha(1, 1)].forEach((value, index) => {
    assert.ok(Math.abs(value - [144, 48, 48, 16][index]) <= 1);
  });
  pixels.fill(0); context.scale(3, 2); context.lineWidth = 2;
  context.moveTo(1, 2); context.lineTo(2, 2); context.stroke();
  assert.equal(alpha(4, 2), 255); assert.equal(alpha(4, 5), 255);
  assert.equal(alpha(2, 4), 0); assert.equal(alpha(4, 6), 0);
  context.lineCap = 'square'; context.stroke(); assert.equal(alpha(1, 4), 255);
  context.lineCap = 'round'; context.stroke(); assert.equal(alpha(1, 4), 255);
});


test('invalid paths leave valid geometry intact and rect converts all inputs before arithmetic', () => {
  const { context, canvas } = harness();
  context.moveTo(1, 1); context.lineTo(4, 1);
  const before = JSON.stringify(context._path);
  for (const invalid of [NaN, Infinity, -Infinity]) {
    context.moveTo(invalid, 2); context.lineTo(2, invalid); context.rect(1, 1, invalid, 3);
  }
  assert.equal(JSON.stringify(context._path), before);
  context.beginPath(); context.rect('1', '2', '3', '4');
  assert.deepEqual(JSON.parse(JSON.stringify(context._path[0])), [[1, 2], [4, 2], [4, 6], [1, 6], [1, 2]]);
  canvas.width = canvas.width; context.arcTo(2, 2, 5, 2, 1);
  assert.equal(context._path[0].length, 1);
});

test('font assignments validate before replacing saved text state', () => {
  const { context, canvas } = harness();
  context.font = 'italic bold 20px serif';
  const valid = context.font;
  for (const invalid of ['', 'not-a-valid-font', '20px', '20px "unterminated', 'bogus 20px serif', '-2px serif']) {
    context.font = invalid; assert.equal(context.font, valid);
  }
  context.save(); context.font = '12pt sans-serif'; assert.equal(context.font, '16px sans-serif');
  context.restore(); assert.equal(context.font, valid);
  canvas.height = canvas.height; assert.equal(context.font, '10px sans-serif');
});

test('unquoted font families accept Unicode identifiers and retain invalid-assignment behavior', () => {
  const { context } = harness();
  for (const family of ['游ゴシック', 'ＭＳ ゴシック', 'Écriture', 'Шрифт', '𠮷野', '-游ゴシック']) {
    context.font = '20px ' + family;
    assert.equal(context.font, '20px ' + family);
  }
  const valid = context.font;
  for (const family of ['1游ゴシック', '-1游ゴシック', '游ゴシック;', '游ゴシック()', '游ゴシック,']) {
    context.font = '20px ' + family;
    assert.equal(context.font, valid);
  }
});

test('empty canvas pattern sources throw while unloaded images return null', () => {
  const { context, canvas } = harness();
  canvas.width = 0;
  assert.throws(() => context.createPattern(canvas, 'repeat'), { name: 'InvalidStateError', code: 11 });
});

test('image dimensions and invalid draws preserve intrinsic and lazy-source contracts', () => {
  const { realm, context, calls } = harness();
  realm.NativeImage = function() {};
  const source = { width: 1, height: 1, naturalWidth: 4, naturalHeight: 2, _nativeImage: { handle: 9, width: 4, height: 2 } };
  realm.NativeHost.canvas.drawImage = function() { calls.push(Array.from(arguments)); };
  context.drawImage(source, 0, 0);
  assert.deepEqual(calls.at(-1).slice(2, 10), [0, 0, 4, 2, 0, 0, 4, 2]);
  source.width = source.height = 0; context.drawImage(source, 0, 0);
  assert.deepEqual(calls.at(-1).slice(2, 6), [0, 0, 4, 2]);
  let materializations = 0;
  source._pmjsPrimitiveContent = { materialize() { materializations++; } };
  context.drawImage(source, NaN, 0); context.drawImage(source, 0, 0, 0, 2);
  context.scale(0, 1); context.drawImage(source, 0, 0);
  assert.equal(materializations, 0);
  for (const value of [0, null, undefined, '', false]) { context.imageSmoothingEnabled = value; assert.equal(context.imageSmoothingEnabled, false); }
  context.imageSmoothingEnabled = 'false'; assert.equal(context.imageSmoothingEnabled, true);
});


test('ImageData infers height and shares the supplied clamped array', () => {
  const { realm } = harness();
  const result = vm.runInContext('var pixels = new Uint8ClampedArray(16); var image = new ImageData(pixels, 2); [image.width, image.height, image.data === pixels]', realm);
  assert.deepEqual(Array.from(result), [2, 2, true]);
  for (const expression of ['new ImageData(new Uint8ClampedArray(12), 2)', 'new ImageData(new Uint8ClampedArray(16), 0)', 'new ImageData(new Uint8ClampedArray(16), 2, 3)']) {
    assert.throws(() => vm.runInContext(expression, realm), { name: 'IndexSizeError', code: 1 });
  }
});

test('line dashes and shadows validate, copy, save and reset their state', () => {
  const { canvas, context } = harness();
  context.setLineDash([1, 2, 3]); context.lineDashOffset = 2;
  assert.deepEqual(Array.from(context.getLineDash()), [1, 2, 3, 1, 2, 3]);
  context.getLineDash()[0] = 100;
  context.shadowColor = 'red'; context.shadowBlur = 3; context.shadowOffsetX = -2;
  context.save(); context.setLineDash([]); context.shadowColor = 'invalid'; context.shadowBlur = -1;
  context.restore();
  assert.deepEqual(Array.from(context.getLineDash()), [1, 2, 3, 1, 2, 3]);
  assert.deepEqual([context.shadowColor, context.shadowBlur, context.shadowOffsetX, context.lineDashOffset], ['#ff0000', 3, -2, 2]);
  for (const dash of [[-1], [NaN], [Infinity]]) context.setLineDash(dash);
  assert.equal(context.getLineDash().length, 6);
  canvas.width = canvas.width;
  assert.deepEqual(Array.from(context.getLineDash()), []);
  assert.deepEqual([context.shadowBlur, context.shadowOffsetX, context.lineDashOffset], [0, 0, 0]);
});

test('videos without a drawable frame do not throw or allocate a destination', () => {
  const { realm, context, calls } = harness(); realm.NativeImage = function() {};
  let queries = 0;
  const source = { videoWidth: 4, videoHeight: 2, _pmjsNativeTextureSource() { queries++; return null; } };
  context.drawImage(source, 0, 0); assert.equal(queries, 1); assert.equal(calls.length, 0);
});

test('the MV reference hides later transforms and rejects later color syntax', () => {
  const { realm, context, canvas } = harness();
  realm.PMJS_RUNTIME_ENGINE = 'mv';
  context.fillStyle = 'red'; context.fillStyle = 'hwb(120 20% 30%)'; assert.equal(context.fillStyle, '#ff0000');
  assert.throws(() => context.setTransform({ a: 1, d: 1 }), { name: 'TypeError' });
  realm.NativeHost.canvas.drawImage = function() {};
  realm.NativeHost.canvas.readPremultipliedPixels = () => new Uint8Array(8 * 8 * 4);
  assert.equal(typeof context.createPattern(canvas, 'repeat').setTransform, 'undefined');
  realm.PMJS_RUNTIME_ENGINE = 'mz';
  assert.equal(typeof context.createPattern(canvas, 'repeat').setTransform, 'function');
});


test('public colors convert to CSS strings and serialize their parsed values', () => {
  const { context } = harness();
  context.fillStyle = 'blue'; context.fillStyle = 0xff0000; assert.equal(context.fillStyle, '#0000ff');
  for (const [value, expected] of [['red', '#ff0000'], ['rgba(1,2,3,0.5)', 'rgba(1, 2, 3, 0.501960784313726)'], ['rgba(1,2,3,0.1)', 'rgba(1, 2, 3, 0.101960784313725)'], ['#12345601', 'rgba(18, 52, 86, 0.00392156862745098)']]) {
    context.fillStyle = context.strokeStyle = context.shadowColor = value;
    assert.deepEqual([context.fillStyle, context.strokeStyle, context.shadowColor], [expected, expected, expected]);
  }
  context.fillStyle = { toString() { return 'red'; } }; assert.equal(context.fillStyle, '#ff0000');
});

test('repeated font and color assignments reuse parsing without skipping public coercion', () => {
  const { realm, context } = harness();
  const parseFont = realm.parseCanvasFontValue, parseColor = realm.parseCanvasColorValue;
  let fontParses = 0, colorParses = 0, fontCoercions = 0, colorCoercions = 0;
  realm.parseCanvasFontValue = value => { fontParses++; return parseFont(value); };
  realm.parseCanvasColorValue = value => { colorParses++; return parseColor(value); };
  let fontValue = 'italic bold 12pt serif', colorValue = 'rgba(11,22,33,0.5)';
  const font = { toString() { fontCoercions++; return fontValue; } };
  const color = { toString() { colorCoercions++; return colorValue; } };
  for (let i = 0; i < 3; i++) {
    context.font = font;
    context.fillStyle = color; context.strokeStyle = color; context.shadowColor = color;
  }
  assert.equal(context.font, 'italic bold 16px serif');
  assert.equal(fontParses, 1); assert.equal(colorParses, 1);
  assert.equal(fontCoercions, 3); assert.equal(colorCoercions, 9);
  const validColor = context.fillStyle;
  fontValue = 'invalid-font'; colorValue = 'invalid-color';
  for (let i = 0; i < 2; i++) { context.font = font; context.fillStyle = color; }
  assert.equal(context.font, 'italic bold 16px serif'); assert.equal(context.fillStyle, validColor);
  assert.equal(fontParses, 2); assert.equal(colorParses, 2);
  assert.equal(fontCoercions, 5); assert.equal(colorCoercions, 11);
  const failure = new Error('coercion failed'), throwing = { toString() { throw failure; } };
  assert.throws(() => { context.font = throwing; }, error => error === failure);
  assert.throws(() => { context.fillStyle = throwing; }, error => error === failure);
  assert.equal(context.font, 'italic bold 16px serif'); assert.equal(context.fillStyle, validColor);
  const gradient = context.createLinearGradient(0, 0, 1, 0);
  context.fillStyle = gradient; assert.equal(context.fillStyle, gradient);
});

test('color reuse preserves HWB acceptance when the reference engine changes', () => {
  const { realm, context } = harness();
  const hwb = ' HWB(120 20% 30%) ';
  context.fillStyle = hwb; const accepted = context.fillStyle;
  assert.notEqual(accepted, '#000000');
  for (const engine of ['mv', 'mz']) {
    realm.PMJS_RUNTIME_ENGINE = engine;
    context.fillStyle = 'red'; context.fillStyle = hwb;
    assert.equal(context.fillStyle, '#ff0000');
  }
  realm.PMJS_RUNTIME_ENGINE = '';
  context.fillStyle = hwb; assert.equal(context.fillStyle, accepted);
  realm.PMJS_RUNTIME_GAME = { engine: 'mv' };
  context.fillStyle = 'blue'; context.fillStyle = hwb;
  assert.equal(context.fillStyle, '#0000ff');
  realm.PMJS_RUNTIME_GAME.engine = '';
  context.fillStyle = hwb; assert.equal(context.fillStyle, accepted);
});

test('font and color reuse stays bounded and leaves long values uncached', () => {
  const { realm, context, canvas } = harness();
  for (let i = 0; i < 1024; i++) {
    const color = '#' + i.toString(16).padStart(6, '0'), font = '12px "font-' + i + '"';
    context.fillStyle = color; context.font = font;
    assert.equal(context.fillStyle, color); assert.equal(context.font, font);
    assert.ok(realm.canvasColorValues.size <= 256); assert.ok(realm.canvasFontValues.size <= 128);
  }
  const longColor = ' '.repeat(300) + 'red', longFont = '16px "' + 'A'.repeat(300) + '"';
  context.fillStyle = longColor; context.font = longFont;
  assert.equal(context.fillStyle, '#ff0000'); assert.equal(context.font, longFont);
  assert.equal(realm.canvasColorValues.has(longColor), false);
  assert.equal(realm.canvasFontValues.has(longFont), false);
  canvas.width = canvas.width;
  assert.equal(context.fillStyle, '#000000'); assert.equal(context.font, '10px sans-serif');
});

test('singular clip preserves the current path and prior clipping region', () => {
  const { context } = harness();
  context.rect(0, 0, 3, 3); context.clip(); const existing = context._clipPaths[0];
  context.scale(0, 1); context.clip(); assert.equal(context._clipPaths.length, 1);
  assert.equal(context._clipPaths[0], existing); assert.ok(context._path.length);
});

test('path float conversion and negative-radius exceptions match the reference', () => {
  const { context } = harness();
  context.translate(-16777216, 0); context.moveTo(16777217, 0); context.lineTo(16777217, 4);
  assert.deepEqual(Array.from(context._path[0][0]), [0, 0]);
  for (const draw of [() => context.arc(0, 0, -1, 0, 1), () => context.arcTo(0, 0, 1, 1, -1), () => context.createRadialGradient(0, 0, -1, 0, 0, 1)]) {
    assert.throws(draw, { name: 'IndexSizeError', code: 1 });
  }
});

test('native curves retain their verbs and conservative bounds without subdividing', () => {
  const { realm, context } = harness();
  const requests = [];
  realm.NativeHost.canvas.paintPath = (handle, request) => { requests.push(request); return true; };
  context.moveTo(1, 1); context.bezierCurveTo(-100, 100, 100, 100, 7, 1);
  context.arc(4, 4, 10000, 0, Math.PI); context.closePath(); context.fill(); context.stroke();
  assert.equal(requests.length, 2);
  assert.ok(requests[0].paths[0].length < 10, 'native submission must not contain thousands of polygon vertices');
  assert.deepEqual(Array.from(requests[0].commands.slice(0, 10)), [0, 1, 1, 3, -100, 100, 100, 100, 7, 1]);
  assert.ok(requests[0].paths[0].some(point => point[0] <= -9996 && point[1] <= -9996));
  assert.ok(requests[0].paths[0].some(point => point[0] >= 10004 && point[1] >= 10004));
  assert.equal(requests[0].closed[0], true);
  context.clip(); context.fill();
  assert.ok(requests[2].paths[0].some(point => point[0] <= -9996 && point[1] <= -9996),
    'clipping subdivision must retain the native control bounds');
});

test('portable curves and clipping materialize geometry once and preserve clip snapshots', () => {
  const { realm, context } = harness();
  const pixels = new Uint8Array(8 * 8 * 4);
  realm.NativeHost.canvas.paintPath = () => false;
  realm.NativeHost.canvas.compositePixels = (handle, left, top, width, height, data) => {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
      pixels.set(data.subarray((y * width + x) * 4, (y * width + x + 1) * 4), ((top + y) * 8 + left + x) * 4);
  };
  context.moveTo(1, 1); context.quadraticCurveTo(4, 7, 7, 1); context.closePath(); context.fill();
  assert.equal(pixels[(2 * 8 + 4) * 4 + 3], 255, 'curved interior must survive portable rendering');
  assert.equal(pixels[(5 * 8 + 4) * 4 + 3], 0);
  const count = context._path[0].length;
  context.fill(); assert.equal(context._path[0].length, count);
  context.clip(); const clip = JSON.stringify(context._clipPaths[0]);
  context.bezierCurveTo(0, 0, 8, 8, 4, 4); context.fill();
  assert.equal(JSON.stringify(context._clipPaths[0]), clip);
  context.beginPath(); context.arc(4, 4, 3, 0, Math.PI); context.clip();
  assert.ok(context._clipPaths[1].paths[0].length > 10);
  assert.equal(JSON.stringify(context._clipPaths[0]), clip);
});

test('first context options apply after an earlier serialization allocated backing', () => {
  const { realm } = harness();
  const created = [], released = [];
  realm.NativeHost.canvas.create = (width, height, opaque) => {
    created.push({ width, height, opaque }); return { handle: created.length };
  };
  realm.NativeHost.canvas.encodePng = () => new Uint8Array();
  realm.releaseNativeResource = resource => { if (resource) released.push(resource.handle); };
  const canvas = new realm.CanvasElement(); canvas.width = canvas.height = 1;
  canvas.toDataURL();
  const context = canvas.getContext('2d', { alpha: false });
  canvas._ensureNativeCanvas();
  assert.deepEqual(created.map(value => value.opaque), [false, true]);
  assert.deepEqual(released, [1]);
  assert.equal(canvas.getContext('2d', { alpha: true }), context);
  assert.equal(context._alpha, false);
  const transparent = new realm.CanvasElement();
  transparent.toDataURL();
  const backing = transparent._nativeCanvas;
  transparent.getContext('2d');
  assert.equal(transparent._nativeCanvas, backing);
  assert.deepEqual(released, [1]);
});


test('toBlob snapshots encoded bytes and reports MIME fallback asynchronously', async () => {
  const { realm, canvas } = harness(), tasks = [];
  realm.Blob = Blob;
  realm.PMJS = { tasks: { enqueue: callback => tasks.push(callback) } };
  const bytes = Uint8Array.from([1, 2, 3]);
  realm.NativeHost.canvas.encodePng = () => bytes;
  let result;
  canvas.toBlob(blob => { result = blob; }, 'unsupported/type');
  assert.equal(result, undefined);
  bytes.fill(0);
  tasks.shift()();
  assert.equal(result.type, 'image/png');
  assert.deepEqual([...new Uint8Array(await result.arrayBuffer())], [1, 2, 3]);
  canvas.width = 0;
  canvas.toBlob(blob => { result = blob; });
  tasks.shift()();
  assert.equal(result, null);
  assert.throws(() => canvas.toBlob(null), { name: 'TypeError' });
});
