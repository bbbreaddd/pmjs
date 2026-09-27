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
  assert.deepEqual(calls[0].slice(1, 6), ['fonts/fixture.ttf', 'hello', 4, 19, 18]);
  assert.equal(calls[0][6], 128);
  assert.equal(calls[0][7], 2);
  assert.equal(calls[1][6], 0xffffff40);
  assert.equal(calls[1][7], 0);
  assert.equal(drawing.globalAlpha, 0.25);
  assert.equal(drawing.font, '12px old-font');
  assert.equal(drawing.fillStyle, '#123456');
});

test('Canvas text measurement uses the same descriptor resolver and preserves string conversion', () => {
  const context = harness();
  context.PMJS.fonts = { resolveDescriptor(descriptor) {
    assert.equal(descriptor, '21px Fixture');
    return { size: 21, faces: [{ path: 'fixture.ttf' }] };
  } };
  context.NativeHost.canvas.measureText = (...args) => {
    assert.deepEqual(args, ['fixture.ttf', '123', 21]);
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
