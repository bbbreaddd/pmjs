'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHostContext } = require('./helpers/mz-host-context.cjs');

function setup() {
  const layers = [], viewports = [];
  let geometry = { drawableWidth: 128, drawableHeight: 128,
    viewportX: 0, viewportY: 0, viewportWidth: 128, viewportHeight: 128 };
  const host = {
    runtime: { env: () => '', now: () => 0, windowSize: () => ({ width: 64, height: 64 }) },
    canvas: { create: (width, height) => ({ handle: 17, width, height }), release() {} },
    render: {
      presentation: () => geometry,
      setPresentationViewport(width, height, filter) {
        viewports.push([width, height, filter]);
        geometry = { ...geometry, viewportX: (128 - width) / 2,
          viewportY: (128 - height) / 2, viewportWidth: width, viewportHeight: height };
      },
      setPresentationLayers(...values) { layers.push(values); }
    }
  };
  const context = createHostContext(host, { graphics: false });
  const canvas = context.document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  canvas.style.width = '32px'; canvas.style.height = '32px';
  canvas.style.imageRendering = 'pixelated';
  context.document.body.appendChild(canvas);
  return { context, canvas, layers, viewports, presentation: context.PMJS.web.presentation };
}

test('web presentation owns CSS geometry and hit testing without an engine', () => {
  const { context, canvas, viewports, presentation } = setup();
  const button = context.document.createElement('button');
  presentation.setLayers(canvas, null, null);
  presentation.setHitRegion(button, canvas, { x: 16, y: 16, width: 16, height: 16 });
  presentation.sync();
  const rect = canvas.getBoundingClientRect();
  assert.deepEqual([rect.left, rect.top, rect.width, rect.height], [16, 16, 32, 32]);
  assert.equal(presentation.pointerTarget(25, 25), button);
  assert.equal(presentation.pointerTarget(16, 16), canvas);
  presentation.sync();
  assert.deepEqual(viewports, [[64, 64, 1]], 'unchanged presentation keeps the cached viewport');
  let clicked = 0;
  button.onclick = () => { clicked++; };
  context.__pmjsReceiveInput({ pointerEvents: [
    { type: 'mousedown', button: 0, x: 25, y: 25 },
    { type: 'mouseup', button: 0, x: 25, y: 25 }
  ] });
  assert.equal(clicked, 1);
  presentation.setHitRegion(null);
  assert.equal(presentation.pointerTarget(25, 25), canvas);
});

test('web presentation resolves video through its texture capability and borrows overlay ownership', () => {
  const { context, canvas, layers, presentation } = setup();
  let source = { handle: 42 };
  const video = { style: { opacity: '0.75' }, _pmjsNativeTextureSource: () => source };
  Object.defineProperty(video, '_nativeImage', { get() { throw new Error('private representation read'); } });
  const overlay = context.document.createElement('canvas');
  canvas.style.opacity = '0.5';
  presentation.setLayers(canvas, video, overlay);
  presentation.sync();
  assert.deepEqual(layers.at(-1), [0.5, 42, 0.75, 17, 1]);
  source = { handle: 43 };
  presentation.sync();
  assert.equal(layers.at(-1)[1], 43);
  source = null;
  presentation.setLayers(canvas, video, null);
  presentation.sync();
  assert.deepEqual(layers.at(-1), [0.5, 0, 0.75, 0, 0]);
  assert.equal(overlay._ensureNativeCanvas().handle, 17, 'removing a layer does not destroy its canvas');
});

test('input snapshots reach owned subscribers independently of presentation refreshes', () => {
  const { context, canvas, presentation } = setup();
  const snapshots = [];
  context.PMJS.web.input.addEventListener('snapshot', event => {
    snapshots.push(event.snapshot);
    presentation.setLayers(canvas, null, null);
  });
  const input = { gamepads: [], pointerEvents: [] };
  context.__pmjsReceiveInput(input);
  presentation.sync(); presentation.sync();
  assert.deepEqual(snapshots, [input]);
  assert.equal(canvas.getBoundingClientRect().width, 32);
});
