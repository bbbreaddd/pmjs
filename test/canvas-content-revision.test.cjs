'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = [
  'js/pmjs-web/events.js',
  'js/pmjs-web/canvas.js',
  'js/pmjs-web/canvas-primitives.js',
  ...require('./helpers/web-element-sources.cjs').elementSources
].map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');

function harness() {
  let handle = 0;
  const calls = { drawImage: [], writePremultipliedPixels: 0, compositePixels: [] };
  const context = {
    console,
    pmjsGameConfig: {},
    nativeWindowState: { focused: true, visible: true },
    NativeHost: {
      runtime: { env() { return ''; } },
      canvas: {
        create(width, height) { return { handle: ++handle, width, height }; },
        release() {},
        fillRect() {},
        clear() {},
        clearRect() {},
        drawText() {},
        drawImage() { calls.drawImage.push(Array.from(arguments)); },
        writePremultipliedPixels() { calls.writePremultipliedPixels++; },
        compositePixels() { calls.compositePixels.push(Array.from(arguments)); },
        readPremultipliedPixels(_handle, _x, _y, width, height) {
          return new Uint8ClampedArray(width * height * 4);
        },
        measureText() { return 1; },
        measureTextMetrics() { return { width: 1 }; }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.PMJS.images = {};
  context.calls = calls;
  return context;
}

test('Canvas mutations and dimension resets invalidate revision-bound proof', () => {
  const context = harness();
  const canvas = new context.CanvasElement();
  const drawing = canvas.getContext('2d');
  const establish = () => {
    drawing.fillStyle = 'white';
    context.PMJS.web.canvas.trackMaskFill(drawing, 0, 0, canvas.width, canvas.height,
      'white', () => drawing.fillRect(0, 0, canvas.width, canvas.height));
    assert.ok(context.PMJS.web.canvas.unitMaskRect(canvas));
  };
  establish();
  const first = canvas.__pmjsContentRevision;
  drawing.fillRect(0, 0, 1, 1);
  assert.ok(canvas.__pmjsContentRevision > first);
  assert.equal(context.PMJS.web.canvas.unitMaskRect(canvas), null);
  establish();
  drawing.clearRect(0, 0, 1, 1);
  assert.equal(context.PMJS.web.canvas.unitMaskRect(canvas), null);
  establish();
  canvas.width = canvas.width;
  assert.equal(context.PMJS.web.canvas.unitMaskRect(canvas), null);
  establish();
  canvas.height = canvas.height;
  assert.equal(context.PMJS.web.canvas.unitMaskRect(canvas), null);
  establish();
  canvas._releaseNativeCanvas();
  assert.equal(context.PMJS.web.canvas.unitMaskRect(canvas), null);
});

test('document ID lookup follows attachment, removal, and live canvas IDs', () => {
  const { document } = harness();
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  canvas.id = 'overlay';
  parent.appendChild(canvas);
  assert.equal(document.getElementById('overlay'), null);
  document.body.appendChild(parent);
  assert.equal(document.getElementById('overlay'), canvas);
  canvas.id = 'replacement';
  assert.equal(document.getElementById('overlay'), null);
  assert.equal(document.getElementById('replacement'), canvas);
  parent.removeChild(canvas);
  assert.equal(document.getElementById('replacement'), null);
});

test('reflected image draws use the affine path', () => {
  const context = harness();
  const canvas = new context.CanvasElement();
  canvas.width = 8;
  canvas.height = 8;
  const drawing = canvas.getContext('2d');
  const image = new context.Image();
  image._nativeImage = { handle: 99 };
  image.width = image.naturalWidth = 2;
  image.height = image.naturalHeight = 2;
  drawing.translate(2, 0);
  drawing.scale(-1, 1);
  drawing.drawImage(image, 0, 0);
  assert.equal(context.calls.compositePixels.length, 1,
    'reflection submits affine samples to the native compositor');
  assert.equal(context.calls.writePremultipliedPixels, 0);
});

test('image draws ignore non-finite arguments across overloads and transforms', () => {
  const context = harness();
  const canvas = new context.CanvasElement();
  const drawing = canvas.getContext('2d');
  const image = new context.Image();
  image._nativeImage = { handle: 99 };
  image.width = image.height = 512;
  const overloads = [[2, 2], [2, 2, 32, 32], [160, 160, 32, 32, 2, 2, 32, 32]];
  for (const reflected of [false, true]) {
    drawing.setTransform(reflected ? -1 : 1, 0, 0, 1, 0, 0);
    for (const args of overloads) {
      for (let index = 0; index < args.length; index++) {
        for (const invalid of [NaN, Infinity, -Infinity, undefined]) {
          const invalidArgs = args.slice();
          invalidArgs[index] = invalid;
          drawing.drawImage(image, ...invalidArgs);
        }
      }
    }
  }
  assert.equal(context.calls.drawImage.length, 0);
  assert.equal(context.calls.writePremultipliedPixels, 0);
  drawing.resetTransform();
  drawing.drawImage(image, 160, 160, 32, 32, 2, 2, 32, 32);
  assert.equal(context.calls.drawImage.length, 1);
});

test('image draw arguments convert once using ToNumber semantics', () => {
  const context = harness();
  const drawing = new context.CanvasElement().getContext('2d');
  const image = new context.Image();
  image._nativeImage = { handle: 99 };
  image.width = image.height = 32;
  drawing.drawImage(image, '2', '3');
  assert.deepEqual(context.calls.drawImage[0].slice(6, 10), [2, 3, 32, 32]);
  assert.throws(() => drawing.drawImage(image, 1n, 2), { name: 'TypeError' });
  let conversions = 0;
  const coordinate = { valueOf() { return ++conversions === 1 ? 2 : NaN; } };
  drawing.drawImage(image, coordinate, 2);
  assert.equal(conversions, 1);
  assert.deepEqual(context.calls.drawImage[1].slice(6, 10), [2, 2, 32, 32]);
});

test('non-finite draws do not materialize source or destination canvases', () => {
  const context = harness();
  const source = new context.CanvasElement();
  const destination = new context.CanvasElement();
  const drawing = destination.getContext('2d');
  drawing.drawImage(source, 2, NaN);
  assert.equal(source._nativeCanvas, null);
  assert.equal(destination._nativeCanvas, null);
  drawing.drawImage(source, 2, 3);
  assert.ok(source._nativeCanvas);
  assert.ok(destination._nativeCanvas);
  assert.equal(context.calls.drawImage.length, 1);
});

test('resizing a canvas resets the existing 2D context state', () => {
  const context = harness();
  const canvas = new context.CanvasElement();
  const drawing = canvas.getContext('2d');
  drawing.translate(12, 8);
  drawing.globalAlpha = 0.25;
  drawing.fillStyle = '#f00';
  drawing.beginPath();
  drawing.rect(0, 0, 1, 1);
  drawing.clip();
  canvas.width = 16;
  assert.equal(canvas.getContext('2d'), drawing);
  assert.deepEqual(Array.from(drawing._transform), [1, 0, 0, 1, 0, 0]);
  assert.equal(drawing.globalAlpha, 1);
  assert.equal(drawing.fillStyle, '#000000');
  assert.equal(drawing._clipPaths.length, 0);
  assert.equal(drawing._stateStack.length, 0);
});

test('Canvas native text resolves fonts and preserves outline/body alpha without changing context state', () => {
  const context = harness();
  const calls = [];
  const descriptors = [];
  context.PMJS.fonts = { resolveDescriptor(descriptor) {
    descriptors.push(descriptor);
    return { size: 18, faces: [{ path: 'fonts/fixture.ttf', family: 'Fixture' }] };
  } };
  context.NativeHost.canvas.drawText = (...args) => calls.push(args);
  const canvas = new context.CanvasElement();
  const drawing = canvas.getContext('2d');
  drawing.globalAlpha = 0.25;
  drawing.font = '12px old-font';
  drawing.fillStyle = '#123456';
  assert.equal(context.PMJS.web.canvas.supportsNativeText(drawing), true);
  context.PMJS.web.canvas.drawNativeText(drawing, 'hello', 4, 19, {
    font: '18px Fixture', outlineWidth: 2.9,
    outlineColor: 'rgba(0, 0, 0, 0.5)', color: '#ffffff',
  });
  assert.deepEqual(descriptors, ['18px Fixture']);
  assert.equal(calls.length, 2);
  assert.deepEqual(Array.from(calls[0][1]), ['fonts/fixture.ttf']);
  assert.deepEqual(calls[0].slice(2, 6), ['hello', 4, 19, 18]);
  assert.equal(calls[0][6], 128);
  assert.equal(calls[0][7], 2.9);
  assert.equal(calls[0][8].lineJoin, 'round');
  assert.equal(calls[1][6], 0xffffff3f);
  assert.equal(calls[1][7], 0);
  assert.equal(drawing.globalAlpha, 0.25);
  assert.equal(drawing.font, '12px old-font');
  assert.equal(drawing.fillStyle, '#123456');
});

test('ordinary Canvas text preserves fractional placement, font size, stroke and synthetic styles', () => {
  const context = harness();
  const calls = [];
  context.PMJS.fonts = { resolveDescriptor() {
    return { size: 24.375, style: 'italic', weight: 700, faces: [{ path: 'fixture.ttf' }] };
  } };
  context.NativeHost.canvas.drawText = (...args) => calls.push(args);
  const drawing = new context.CanvasElement().getContext('2d');
  drawing.lineWidth = 2.75; drawing.lineJoin = 'bevel'; drawing.lineCap = 'square'; drawing.miterLimit = 3.5;
  drawing.strokeText('AV', 4.25, 35.875);
  assert.deepEqual(calls[0].slice(2, 6), ['AV', 4.25, 35.875, 24.375]);
  assert.equal(calls[0][7], 2.75);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][8])),
    { bold: true, italic: true, lineJoin: 'bevel', lineCap: 'square', miterLimit: 3.5 });
});

test('invalid Canvas line widths retain the previous stroke through save, restore and resize', () => {
  const context = harness();
  context.PMJS.fonts = { resolveDescriptor() { return { size: 18, faces: [{ path: 'fixture.ttf' }] }; } };
  const calls = [];
  context.NativeHost.canvas.drawText = (...args) => calls.push(args);
  const canvas = new context.CanvasElement();
  const drawing = canvas.getContext('2d');
  assert.equal(drawing.lineWidth, 1);
  drawing.lineWidth = 2.75;
  drawing.save();
  for (const invalid of [0, -1, NaN, Infinity, -Infinity, undefined, null, 'invalid']) {
    drawing.lineWidth = invalid;
    drawing.strokeText('A', 0, 20);
    assert.equal(drawing.lineWidth, 2.75);
    assert.equal(calls.at(-1)[7], 2.75);
  }
  drawing.lineWidth = '3.5';
  assert.equal(drawing.lineWidth, 3.5);
  for (const nonNumber of [1n, Symbol('width')]) {
    assert.throws(() => { drawing.lineWidth = nonNumber; }, { name: 'TypeError' });
    assert.equal(drawing.lineWidth, 3.5);
  }
  drawing.restore();
  assert.equal(drawing.lineWidth, 2.75);
  canvas.width = canvas.width;
  assert.equal(drawing.lineWidth, 1);
});

test('native Bitmap text preserves the inherited stroke for invalid outline widths', () => {
  const context = harness();
  context.PMJS.fonts = { resolveDescriptor() { return { size: 18, faces: [{ path: 'fixture.ttf' }] }; } };
  const calls = [];
  context.NativeHost.canvas.drawText = (...args) => calls.push(args);
  const drawing = new context.CanvasElement().getContext('2d');
  drawing.lineWidth = 2.75;
  for (const outlineWidth of [0, -1, NaN, Infinity, undefined]) {
    context.PMJS.web.canvas.drawNativeText(drawing, 'A', 0, 20, {
      font: '18px sans-serif', outlineWidth,
      outlineColor: '#00000080', color: '#ffffff'
    });
    assert.equal(calls.at(-2)[7], 2.75);
    assert.equal(calls.at(-1)[7], 0);
    assert.equal(drawing.lineWidth, 2.75);
  }
});

test('non-finite text positions and supplied widths are no-ops before font or canvas preparation', () => {
  const context = harness();
  const canvas = new context.CanvasElement();
  const drawing = canvas.getContext('2d');
  context.NativeHost.canvas.measureText = () => { throw new Error('invalid text draw measured a font'); };
  context.NativeHost.canvas.drawText = () => { throw new Error('invalid text draw reached the host'); };
  for (const method of ['fillText', 'strokeText']) {
    for (const invalid of [NaN, Infinity, -Infinity, undefined]) {
      drawing[method]('A', invalid, 20);
      drawing[method]('A', 0, invalid);
    }
    for (const width of [NaN, Infinity, -Infinity, 0, -1]) {
      drawing[method]('A', 0, 20, width);
    }
  }
  assert.equal(canvas._nativeCanvas, null);
});

test('text draw coordinates convert once and an omitted maximum width allows ordinary drawing', () => {
  const context = harness();
  context.PMJS.config = { fonts: { GameFont: 'fixture.ttf' } };
  const drawing = new context.CanvasElement().getContext('2d');
  const calls = [];
  context.NativeHost.canvas.drawText = (...args) => calls.push(args);
  let conversions = 0;
  const coordinate = { valueOf() { return ++conversions === 1 ? 2 : NaN; } };
  drawing.fillText('A', coordinate, '20');
  drawing.strokeText('A', '3', '21', undefined);
  assert.equal(conversions, 1);
  assert.deepEqual(calls.map(args => args.slice(3, 5)), [[2, 20], [3, 21]]);
  assert.throws(() => drawing.fillText('A', 1n, 20), { name: 'TypeError' });
});

test('Canvas text measurement uses the same descriptor resolver and preserves string conversion', () => {
  const context = harness();
  context.PMJS.fonts = { resolveDescriptor(descriptor) {
    assert.equal(descriptor, '21px Fixture');
    return { size: 21, faces: [{ path: 'fixture.ttf' }] };
  } };
  context.NativeHost.canvas.measureText = (...args) => {
    assert.deepEqual(Array.from(args[0]), ['fixture.ttf']);
    assert.deepEqual(args.slice(1, 3), ['123', 21]);
    assert.equal(args[3].bold, false);
    assert.equal(args[3].italic, false);
    return 37;
  };
  assert.equal(context.PMJS.web.canvas.measureTextWidth(123, '21px Fixture'), 37);
});

test('Canvas blur uses native backing without changing context state', () => {
  const context = harness();
  const calls = [];
  context.NativeHost.canvas.blur = handle => calls.push(handle);
  const canvas = new context.CanvasElement();
  const drawing = canvas.getContext('2d');
  drawing.globalAlpha = 0.25;
  drawing.globalCompositeOperation = 'lighter';
  drawing.translate(3, 4);
  const transform = Array.from(drawing._transform);
  context.PMJS.web.canvas.blur(canvas);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], canvas._nativeCanvas.handle);
  assert.equal(drawing.globalAlpha, 0.25);
  assert.equal(drawing.globalCompositeOperation, 'lighter');
  assert.deepEqual(Array.from(drawing._transform), transform);
});

test('mask rectangles are detached and failed fills cannot create proof', () => {
  const context = harness();
  const canvas = new context.CanvasElement();
  const drawing = canvas.getContext('2d');
  const owner = context.PMJS.web.canvas;
  drawing.fillStyle = '#ff0000';
  const fill = () => owner.trackMaskFill(drawing, 0, 0, canvas.width, canvas.height,
    '#ff0000', () => { drawing.fillRect(0, 0, canvas.width, canvas.height); return 42; });
  assert.equal(fill(), 42);
  const rectangle = owner.unitMaskRect(canvas);
  rectangle.width = 1;
  assert.equal(owner.unitMaskRect(canvas).width, canvas.width);
  drawing.clearRect(0, 0, 1, 1);
  assert.throws(() => owner.trackMaskFill(drawing, 0, 0, canvas.width, canvas.height,
    'white', () => { throw new Error('fill failed'); }), /fill failed/);
  assert.equal(owner.unitMaskRect(canvas), null);
});

for (const reflected of [false, true]) {
  test(`clipped Canvas crop submits its source region without destination readback, reflected=${reflected}`, () => {
    const ctx = harness();
    const source = new ctx.CanvasElement();
    source.width = 816; source.height = 624;
    const handle = source._ensureNativeCanvas().handle;
    const target = new ctx.CanvasElement(); target.width = 2; target.height = 2;
    const drawing = target.getContext('2d');
    const reads = []; let output;
    ctx.NativeHost.canvas.readPremultipliedPixels = function(resource, x, y, width, height) {
      reads.push({ resource, x, y, width, height });
      const pixels = new Uint8ClampedArray(width * height * 4);
      if (resource === handle) {
        for (let row = 0; row < height; row++) for (let column = 0; column < width; column++)
          pixels.set([x + column, y + row, 77, 255], (row * width + column) * 4);
      }
      return pixels;
    };
    ctx.NativeHost.canvas.compositePixels = function(_handle, _x, _y, _width, _height, pixels, mask, operation, alpha) {
      output = Array.from(pixels);
      assert.deepEqual(Array.from(mask), [255, 255, 255, 255]);
      assert.equal(operation, 'source-over');
      assert.equal(alpha, 1);
    };
    drawing.beginPath(); drawing.rect(0, 0, 2, 2); drawing.clip();
    drawing.imageSmoothingEnabled = false;
    if (reflected) { drawing.translate(2, 0); drawing.scale(-1, 1); }
    drawing.drawImage(source, 10.25, 20.25, 2, 2, 0, 0, 2, 2);
    assert.deepEqual(reads, [{ resource: handle, x: 10, y: 20, width: 3, height: 3 }]);
    assert.deepEqual(output, reflected
      ? [11,20,77,255, 10,20,77,255, 11,21,77,255, 10,21,77,255]
      : [10,20,77,255, 11,20,77,255, 10,21,77,255, 11,21,77,255]);
  });
}

test('fully out-of-range Canvas image crops leave the destination unchanged', () => {
  const ctx = harness();
  const source = new ctx.CanvasElement(); source.width = 2; source.height = 2;
  const sourceHandle = source._ensureNativeCanvas().handle;
  const target = new ctx.CanvasElement(); target.width = 2; target.height = 2;
  let output;
  ctx.NativeHost.canvas.readPremultipliedPixels = function(handle, x, y, width, height) {
    assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0);
    const pixels = new Uint8ClampedArray(width * height * 4);
    if (handle === sourceHandle) pixels.set([99, 88, 77, 255]);
    return pixels;
  };
  ctx.NativeHost.canvas.compositePixels = function(_handle, _x, _y, _w, _h, pixels) { output = Array.from(pixels); };
  const drawing = target.getContext('2d');
  drawing.beginPath(); drawing.rect(0, 0, 2, 2); drawing.clip();
  drawing.drawImage(source, -10, -10, 2, 2, 0, 0, 2, 2);
  assert.equal(output, undefined);
  assert.equal(ctx.calls.drawImage.length, 0);
});


for (const clipped of [false, true]) {
  test(`partly out-of-range crops trim the destination proportionally, clip=${clipped}`, () => {
    const ctx = harness();
    const source = new ctx.CanvasElement(); source.width = source.height = 2;
    const sourceHandle = source._ensureNativeCanvas().handle;
    const target = new ctx.CanvasElement(); target.width = target.height = 4;
    const drawing = target.getContext('2d');
    let written;
    ctx.NativeHost.canvas.readPremultipliedPixels = (handle, x, y, width, height) => {
      const pixels = new Uint8ClampedArray(width * height * 4);
      if (handle === sourceHandle) pixels.fill(255);
      return pixels;
    };
    ctx.NativeHost.canvas.compositePixels = (_handle, x, y, width, height, pixels) => {
      written = { x, y, width, height, pixels: Array.from(pixels) };
    };
    if (clipped) { drawing.beginPath(); drawing.rect(0, 0, 4, 4); drawing.clip(); }
    drawing.drawImage(source, -1, -1, 2, 2, 0, 0, 4, 4);
    if (clipped) {
      assert.deepEqual(written, { x: 2, y: 2, width: 2, height: 2, pixels: new Array(16).fill(255) });
    } else {
      assert.deepEqual(ctx.calls.drawImage[0].slice(2, 10), [0, 0, 1, 1, 2, 2, 2, 2]);
    }
  });
}

test('negative source and destination dimensions grow backwards without mirroring', () => {
  const ctx = harness();
  const source = new ctx.CanvasElement(); source.width = source.height = 2;
  const target = new ctx.CanvasElement();
  target.getContext('2d').drawImage(source, 2, 2, -2, -2, 4, 4, -4, -4);
  assert.deepEqual(ctx.calls.drawImage[0].slice(2, 10), [0, 0, 2, 2, 0, 0, 4, 4]);
});

test('every Canvas painting entry point invalidates a solid-mask proof', () => {
  const operations = {
    clearRect: c => c.clearRect(1, 1, 2, 2), fillRect: c => c.fillRect(1, 1, 2, 2),
    strokeRect: c => c.strokeRect(1, 1, 2, 2),
    nativeStrokeRect: (c, h) => { h.NativeHost.canvas.paintRect = () => true; c.strokeRect(1, 1, 2, 2); },
    drawImage: (c, h) => { const source = new h.CanvasElement(); source.width = source.height = 2; c.drawImage(source, 1, 1); },
    fill: c => { c.beginPath(); c.rect(1, 1, 2, 2); c.fill(); },
    stroke: c => { c.beginPath(); c.rect(1, 1, 2, 2); c.stroke(); },
    fillText: c => c.fillText('X', 1, 3), strokeText: c => c.strokeText('X', 1, 3),
    putImageData: c => c.putImageData({ width: 1, height: 1, data: new Uint8ClampedArray(4) }, 1, 1),
    blur: (c, h) => h.PMJS.web.canvas.blur(c.canvas),
    blurMv: (c, h) => h.PMJS.web.canvas.blurMv(c),
    nativeText: (c, h) => h.PMJS.web.canvas.drawNativeText(c, 'X', 1, 3,
      { font: '18px fixture', outlineWidth: 1, outlineColor: 'black', color: 'black' })
  };
  for (const [name, draw] of Object.entries(operations)) {
    const h = harness(), canvas = new h.CanvasElement(); canvas.width = canvas.height = 10;
    h.PMJS.fonts = { resolveDescriptor: () => ({ size: 18, faces: [{ path: 'fixture.ttf' }] }) };
    Object.assign(h.NativeHost.canvas, { writePixels() {}, blur() {}, blurMv: () => true });
    const c = canvas.getContext('2d'), owner = h.PMJS.web.canvas;
    owner.trackMaskFill(c, 0, 0, 10, 10, 'white', () => c.fillRect(0, 0, 10, 10));
    assert.ok(owner.unitMaskRect(canvas));
    const revision = canvas.__pmjsContentRevision;
    draw(c, h);
    assert.ok(canvas.__pmjsContentRevision > revision, name);
    assert.equal(owner.unitMaskRect(canvas), null, name);
  }
});

test('partial native painting failures invalidate an earlier proof', () => {
  const h = harness(), canvas = new h.CanvasElement(), c = canvas.getContext('2d');
  h.PMJS.fonts = { resolveDescriptor: () => ({ size: 18, faces: [{ path: 'fixture.ttf' }] }) };
  h.PMJS.web.canvas.trackMaskFill(c, 0, 0, canvas.width, canvas.height, 'white',
    () => c.fillRect(0, 0, canvas.width, canvas.height));
  let draws = 0;
  h.NativeHost.canvas.drawText = () => { if (++draws === 2) throw Error('body failed'); };
  assert.throws(() => h.PMJS.web.canvas.drawNativeText(c, 'X', 1, 3,
    { font: '18px fixture', outlineWidth: 1, outlineColor: 'black', color: 'black' }), /body failed/);
  assert.equal(h.PMJS.web.canvas.unitMaskRect(canvas), null);
});

test('full-clear eligibility checks normalized far edges', () => {
  const h = harness(), canvas = new h.CanvasElement(); canvas.width = canvas.height = 10;
  const calls = []; h.NativeHost.canvas.clear = () => calls.push('whole');
  h.NativeHost.canvas.clearRect = (...args) => calls.push(args.slice(1));
  const c = canvas.getContext('2d');
  c.clearRect(-5, 0, 10, 10); c.clearRect(0, -5, 10, 10);
  c.clearRect(-5, -5, 15, 15); c.clearRect(10, 10, -10, -10);
  assert.deepEqual(calls, [[-5, 0, 10, 10], [0, -5, 10, 10], 'whole', 'whole']);
});

test('dirty ImageData rectangles intersect original edges and normalize negative extents', () => {
  const h = harness(), canvas = new h.CanvasElement(), c = canvas.getContext('2d');
  const data = { width: 3, height: 2, data: Uint8ClampedArray.from({ length: 24 }, (_, i) => i + 1) };
  let writes = []; h.NativeHost.canvas.writePixels = (...args) => writes.push(args.slice(1));
  c.putImageData(data, 4, 5, -1, 0, 2, 1);
  assert.deepEqual(writes[0].slice(0, 4), [4, 5, 1, 1]);
  assert.deepEqual(Array.from(writes[0][4]), Array.from(data.data.subarray(0, 4)));
  writes = []; c.putImageData(data, 4, 5, 2, 2, -2, -2);
  assert.deepEqual(writes[0].slice(0, 4), [4, 5, 2, 2]);
  assert.deepEqual(Array.from(writes[0][4]), [...data.data.subarray(0, 8), ...data.data.subarray(12, 20)]);
  writes = [];
  for (const rect of [[-4, 0, 2, 1], [4, 0, 2, 1], [0, -4, 1, 2], [0, 3, 1, 1], [0, 0, 0, 1]])
    c.putImageData(data, 0, 0, ...rect);
  assert.deepEqual(writes, []);
});

test('linear gradients and text bypass source-over shortcuts for other operations', () => {
  const h = harness(), canvas = new h.CanvasElement(); canvas.width = canvas.height = 10;
  const c = canvas.getContext('2d'); let fills = 0, textTargets = [];
  h.NativeHost.canvas.fillRect = () => fills++;
  h.NativeHost.canvas.drawText = handle => textTargets.push(handle);
  h.PMJS.fonts = { resolveDescriptor: () => ({ size: 18, faces: [{ path: 'fixture.ttf' }] }) };
  for (const operation of ['destination-out', 'destination-in', 'copy', 'multiply']) {
    c.globalCompositeOperation = operation;
    const gradient = c.createLinearGradient(0, 0, 2, 0);
    gradient.addColorStop(0, 'white'); gradient.addColorStop(1, 'black');
    c.fillStyle = gradient; c.fillRect(0, 0, 2, 2);
    assert.equal(h.calls.compositePixels.at(-1)[7], operation);
    c.fillStyle = 'white'; c.fillText('X', 1, 3); c.strokeText('X', 1, 3);
    assert.equal(h.calls.compositePixels.at(-1)[7], operation);
  }
  assert.equal(fills, 0);
  assert.ok(textTargets.every(handle => handle !== canvas._nativeCanvas.handle));
});

test('affine smoothing interpolates premultiplied pixels and preserves reflection', () => {
  for (const translucent of [false, true]) for (const reflected of [false, true]) {
    const h = harness(), source = new h.CanvasElement(); source.width = 2; source.height = 1;
    const target = new h.CanvasElement(); target.width = 4; target.height = 1;
    const alpha = translucent ? 128 : 255;
    h.NativeHost.canvas.readPremultipliedPixels = () => Uint8ClampedArray.from([255, 0, 0, 255, 0, 0, alpha, alpha]);
    const c = target.getContext('2d'); c.beginPath(); c.rect(0, 0, 4, 1); c.clip();
    if (reflected) { c.translate(4, 0); c.scale(-1, 1); }
    c.imageSmoothingEnabled = false; c.drawImage(source, 0, 0, 4, 1);
    const nearest = Array.from(h.calls.compositePixels.at(-1)[5]);
    c.imageSmoothingEnabled = true; c.drawImage(source, 0, 0, 4, 1);
    const filtered = Array.from(h.calls.compositePixels.at(-1)[5]);
    let expected = [[255, 0, 0, 255], [191, 0, Math.round(alpha / 4), Math.round(255 * 0.75 + alpha / 4)],
      [64, 0, Math.round(alpha * 0.75), Math.round(255 / 4 + alpha * 0.75)], [0, 0, alpha, alpha]];
    if (reflected) expected.reverse();
    assert.deepEqual(filtered, expected.flat());
    assert.notDeepEqual(filtered, nearest);
  }
});
