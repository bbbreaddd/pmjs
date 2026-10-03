'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = [
  'js/pmjs-web/canvas.js',
  'js/pmjs-web/elements.js'
].map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');

function harness() {
  let handle = 0;
  const calls = { drawImage: [], writePixels: 0 };
  function EventTarget() {}
  EventTarget.prototype.addEventListener = function() {};
  EventTarget.prototype.removeEventListener = function() {};
  EventTarget.prototype.dispatchEvent = function() {};
  const context = {
    console,
    pmjsGameConfig: {},
    nativeWindowState: { focused: true, visible: true },
    EventTarget,
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
        writePixels() { calls.writePixels++; },
        readPixels(_handle, _x, _y, width, height) {
          return new Uint8ClampedArray(width * height * 4);
        },
        measureText() { return 1; },
        measureTextMetrics() { return { width: 1 }; }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
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
  assert.ok(context.calls.writePixels > 0,
    'reflection must be rasterized through affine sampling');
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
  assert.equal(context.calls.writePixels, 0);
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
  assert.equal(calls[1][6], 0xffffff40);
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
  test(`clipped Canvas crop reads only its source region and preserves pixels, reflected=${reflected}`, () => {
    const ctx = harness();
    const source = new ctx.CanvasElement();
    source.width = 816; source.height = 624;
    const handle = source._ensureNativeCanvas().handle;
    const target = new ctx.CanvasElement(); target.width = 2; target.height = 2;
    const drawing = target.getContext('2d');
    const reads = []; let output;
    ctx.NativeHost.canvas.readPixels = function(resource, x, y, width, height) {
      reads.push({ resource, x, y, width, height });
      const pixels = new Uint8ClampedArray(width * height * 4);
      if (resource === handle) {
        for (let row = 0; row < height; row++) for (let column = 0; column < width; column++)
          pixels.set([x + column, y + row, 77, 255], (row * width + column) * 4);
      }
      return pixels;
    };
    ctx.NativeHost.canvas.writePixels = function(_handle, _x, _y, _width, _height, pixels) {
      output = Array.from(pixels);
    };
    drawing.beginPath(); drawing.rect(0, 0, 2, 2); drawing.clip();
    if (reflected) { drawing.translate(2, 0); drawing.scale(-1, 1); }
    drawing.drawImage(source, 10.25, 20.25, 2, 2, 0, 0, 2, 2);
    assert.deepEqual(reads[0], { resource: handle, x: 10, y: 20, width: 3, height: 3 });
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
  ctx.NativeHost.canvas.readPixels = function(handle, x, y, width, height) {
    assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0);
    const pixels = new Uint8ClampedArray(width * height * 4);
    if (handle === sourceHandle) pixels.set([99, 88, 77, 255]);
    return pixels;
  };
  ctx.NativeHost.canvas.writePixels = function(_handle, _x, _y, _w, _h, pixels) { output = Array.from(pixels); };
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
    ctx.NativeHost.canvas.readPixels = (handle, x, y, width, height) => {
      const pixels = new Uint8ClampedArray(width * height * 4);
      if (handle === sourceHandle) pixels.fill(255);
      return pixels;
    };
    ctx.NativeHost.canvas.writePixels = (_handle, x, y, width, height, pixels) => {
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
