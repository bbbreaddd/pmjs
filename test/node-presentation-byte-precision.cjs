'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 256, height: 256,
  windowTitle: 'presentation byte precision' });
const source = native.canvas.create(256, 256), upper = native.canvas.create(256, 256);
const pixels = new Uint8Array(256 * 256 * 4), overlay = pixels.slice();
for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
  const at = (y * 256 + x) * 4;
  pixels.set([x, x, x, 255], at); overlay.set([y, y, y, y], at);
}
const schema = native.scene.schema;
const capture = process.argv.includes('--capture'), frames = [];
function mesh(handle) {
  return native.render.createMesh(handle, [0, 0, 256, 0, 256, 256, 0, 256],
    [0, 0, 1, 0, 1, 1, 0, 1], [0, 1, 2, 0, 2, 3], 1);
}
const sourceMesh = mesh(source.handle), upperMesh = mesh(upper.handle);
function scene(alpha, withOverlay, meshDraw = false) {
  const layers = meshDraw ? [sourceMesh, upperMesh] : [source.handle, upper.handle];
  const handles = withOverlay ? layers : layers.slice(0, 1);
  const metadata = new Uint32Array(handles.length * schema.metadataStride);
  const values = new Float32Array(handles.length * schema.valueStride);
  handles.forEach((handle, index) => {
    metadata.set([meshDraw ? 8 : 1, 0xffffffff, handle, 0xffffff, 0, meshDraw ? 8 : 1024 | 8, 0], index * schema.metadataStride);
    values.set([1, 0, 0, 1, 0, 0, index ? 1 : alpha], index * schema.valueStride);
    values.set([0, 0, 256, 256, 256, 256], index * schema.valueStride + 9);
  });
  native.render.setClearColor(0, 0, 0, 1);
  native.beginFrame(); native.scene.submit(schema.version, metadata, values, handles.length);
}
try {
  native.canvas.writePremultipliedPixels(source.handle, 0, 0, 256, 256, pixels);
  native.canvas.writePremultipliedPixels(upper.handle, 0, 0, 256, 256, overlay);
  for (const alpha of [1, 19/255, 128/255, 0.83]) for (const withOverlay of [false, true]) {
    scene(1, false);
    native.render.setPresentationLayers(alpha, 0, 0, withOverlay ? upper.handle : 0, 1);
    native.renderFrame();
    assert.ok(Buffer.from(native.canvas.captureSceneRawPremultiplied()).equals(Buffer.from(pixels)),
      'page composition preserves the game framebuffer');
    const frame = native.canvas.captureDrawable();
    let actual;
    try {
      assert.deepEqual([frame.width, frame.height], [256, 256]);
      actual = Buffer.from(native.canvas.readPremultipliedPixels(frame.handle, 0, 0, 256, 256));
    } finally { native.canvas.release(frame.handle); }
    if (capture) frames.push({ alpha, withOverlay, pixels: actual.toString('base64') });
    scene(alpha, withOverlay, true); native.renderScene();
    const expected = Buffer.from(native.canvas.captureSceneRawPremultiplied());
    const first = actual.findIndex((byte, index) => byte !== expected[index]);
    assert.equal(first, -1,
      `page layers versus mesh draws: opacity ${alpha}, overlay ${withOverlay}, byte ${first}: ${actual[first]} / ${expected[first]}`);
    if (alpha === 19/255 && !withOverlay) {
      assert.equal(actual[47 * 4], 4, 'gray 47 at opacity 19/255 rounds to byte 4');
    }
  }
} finally {
  native.render.setPresentationLayers(1, 0, 0, 0, 0);
  native.render.releaseMesh(sourceMesh); native.render.releaseMesh(upperMesh);
  native.canvas.release(source.handle); native.canvas.release(upper.handle);
}

if (capture) console.log(JSON.stringify({ frames, graphics: native.render.graphicsInfo() }));
