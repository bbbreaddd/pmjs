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
        writePixels() {},
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
