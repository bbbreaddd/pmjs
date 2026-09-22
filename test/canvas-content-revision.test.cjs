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
    canvas.__pmjsMaskProof = { revision: canvas.__pmjsContentRevision };
  };
  establish();
  const first = canvas.__pmjsContentRevision;
  drawing.fillRect(0, 0, 1, 1);
  assert.ok(canvas.__pmjsContentRevision > first);
  assert.equal(canvas.__pmjsMaskProof, null);
  establish();
  drawing.clearRect(0, 0, 1, 1);
  assert.equal(canvas.__pmjsMaskProof, null);
  establish();
  canvas.width = canvas.width;
  assert.equal(canvas.__pmjsMaskProof, null);
  establish();
  canvas.height = canvas.height;
  assert.equal(canvas.__pmjsMaskProof, null);
  establish();
  canvas._releaseNativeCanvas();
  assert.equal(canvas.__pmjsMaskProof, null);
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
