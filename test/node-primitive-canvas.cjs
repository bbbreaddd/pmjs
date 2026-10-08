'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '', width: 64, height: 48,
  windowTitle: 'Primitive Canvas content ownership' });
let allocatedSurfaces = 0;
const renderer = Object.create(native.render);
renderer.createPrimitiveSurface = (...args) => {
  allocatedSurfaces++;
  return native.render.createPrimitiveSurface(...args);
};
const realm = vm.createContext({ console, pmjsGameConfig: {},
  nativeWindowState: { focused: true, visible: true }, PMJS: { config: { fonts: { GameFont: 'text-shaping.ttf' } } },
  NativeHost: { canvas: native.canvas, render: renderer, runtime: { env: () => '' } },
});
for (const file of ['js/pmjs-web/events.js', 'js/pmjs-web/canvas.js',
    ...require('./helpers/web-element-sources.cjs').elementSources,
    'js/pmjs-web/canvas-primitives.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), realm);
}
const create = () => { const canvas = new realm.CanvasElement(); canvas.width = 64; canvas.height = 48; return canvas; };
const canvas = create(), drawing = canvas.getContext('2d');
const recorder = realm.PMJS.web.canvas.createPrimitiveRecorder(canvas);
assert.ok(recorder);
assert.equal(realm.PMJS.web.canvas.createPrimitiveRecorder(canvas), null);
assert.equal(allocatedSurfaces, 1, 'A second recorder does not allocate an orphaned surface');
const read = (x = 30, y = 20) => Array.from(drawing.getImageData(x, y, 1, 1).data);
const fill = color => { drawing.fillStyle = color; drawing.fillRect(0, 0, 64, 48); };
function presented() {
  const image = canvas._nativeImage || canvas._ensureNativeCanvas();
  const values = new Float32Array(native.scene.schema.valueStride);
  values.set([1, 0, 0, 1, 0, 0, 1]); values.set([0, 0, 64, 48], 9); values.set([64, 48], 13);
  native.render.setClearColor(0, 0, 0, 0); native.beginFrame();
  native.scene.submit(native.scene.schema.version, new Uint32Array([1, 0xffffffff, image.handle, 0xffffff, 0, 0, 0]), values, 1);
  native.renderScene();
  return Array.from(native.canvas.captureSceneRawPremultiplied().slice((20 * 64 + 30) * 4, (20 * 64 + 30) * 4 + 4));
}
recorder.record(() => { fill('#ff0000'); assert.deepEqual(read(), [255, 0, 0, 255], 'Reads during recording see earlier fills'); });
assert.deepEqual(read(), [255, 0, 0, 255]);
recorder.record(() => fill('#ff0000'));
assert.ok(canvas._nativeImage, 'Unobserved full-surface updates retain acceleration');
assert.deepEqual(presented(), [255, 0, 0, 255], 'Published primitive pixels agree with Canvas observations');
assert.deepEqual(read(), [255, 0, 0, 255], 'Reads after publication materialize authored pixels');
recorder.record(() => fill('#ff0000'));
drawing.clearRect(0, 0, 64, 48);
assert.equal(canvas._nativeImage, undefined, 'Ordinary clearing invalidates the published surface');
assert.deepEqual(read(), [0, 0, 0, 0]);
assert.deepEqual(presented(), [0, 0, 0, 0], 'Clearing changes the displayed Canvas too');
recorder.record(() => fill('#00ff00'));
recorder.record(() => { drawing.fillStyle = '#ffffff'; drawing.fillRect(0, 0, 2, 2); });
assert.deepEqual(read(), [0, 255, 0, 255], 'Partial updates preserve the preceding full surface');
recorder.record(() => {});
assert.deepEqual(read(), [0, 255, 0, 255], 'An empty update preserves content');

const ordinary = create(), ordinaryDrawing = ordinary.getContext('2d');
ordinaryDrawing.fillStyle = '#000000'; ordinaryDrawing.fillRect(0, 0, 64, 48);
ordinaryDrawing.font = '24.75px GameFont'; ordinaryDrawing.fillStyle = '#ffffff'; ordinaryDrawing.fillText('AV', 3.75, 34.6);
recorder.record(() => fill('#000000'));
drawing.font = ordinaryDrawing.font; drawing.fillStyle = '#ffffff'; drawing.fillText('AV', 3.75, 34.6);
const pixels = source => Buffer.from(native.canvas.readPixels(source._ensureNativeCanvas().handle, 0, 0, 64, 48));
assert.deepEqual(pixels(canvas), pixels(ordinary), 'Text after publication preserves primitive pixels and uses the selected backend');
recorder.record(() => { fill('#000000'); drawing.fillStyle = '#ffffff'; drawing.fillText('AV', 3.75, 34.6); });
assert.deepEqual(pixels(canvas), pixels(ordinary), 'Non-recorded mutations during a callback preserve operation order');

recorder.record(() => fill('#00ff00'));
const retained = create(); retained.getContext('2d').drawImage(canvas, 0, 0);
drawing.clearRect(0, 0, 64, 48); recorder.record(() => fill('#0000ff'));
assert.deepEqual(Array.from(retained.getContext('2d').getImageData(30, 20, 1, 1).data), [0, 255, 0, 255],
  'Deferred Canvas draws retain primitive source content across updates');
canvas.width = canvas.width;
assert.deepEqual(read(), [0, 0, 0, 0], 'Dimension reset discards prior primitive pixels');
recorder.record(() => fill('#ff0000'));
recorder.destroy(); recorder.destroy();
assert.deepEqual(read(), [255, 0, 0, 255], 'Releasing an accelerator preserves its surviving Canvas owner');
for (const source of [canvas, ordinary, retained]) source._releaseNativeCanvas();
assert.equal(native.canvas.memory().liveCount, 0);
