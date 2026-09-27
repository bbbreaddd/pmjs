'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '',
  width: 192, height: 128, windowTitle: 'text texture upload test' });

function render(canvas) {
  const schema = native.scene.schema;
  const metadata = new Uint32Array([1, 0xffffffff, canvas.handle, 0xffffff, 0, 0, 0]);
  const values = new Float32Array(schema.valueStride);
  values.set([1, 0, 0, 1, 0, 0, 1], 0);
  values.set([0, 0, 192, 128], 9);
  values.set([192, 128], 13);
  native.beginFrame();
  native.scene.submit(schema.version, metadata, values, 1);
  native.renderFrame();
  const capture = native.canvas.captureScene();
  const pixels = Array.from(native.canvas.readPixels(capture.handle, 0, 0, 192, 128));
  native.canvas.release(capture.handle);
  return pixels;
}

for (const text of ['j', 'AV', 'ffi', 'e\u0323\u0301', 'سلام']) {
  for (const size of [13, 19, 28]) {
    for (const stroke of [0, 1, 5]) {
      const canvas = native.canvas.create(192, 128);
      native.canvas.fillRect(canvas.handle, 0, 0, 192, 128, 0x000000ff);
      const blank = render(canvas); // Consume the initial full-surface upload.
      native.canvas.drawText(canvas.handle, 'text-shaping.ttf', text,
        7, 64, size, 0xffffffff, stroke);
      const expected = Array.from(native.canvas.readPixels(canvas.handle, 0, 0, 192, 128));
      assert.notDeepEqual(expected, blank);
      const uploads = native.images.memory(0);
      assert.deepEqual(render(canvas), expected,
        `${text}, ${size}px, stroke ${stroke}: sub-upload preserves every raster pixel`);
      const updated = native.images.memory(0);
      assert.ok(updated.textureRegionUpdates > uploads.textureRegionUpdates,
        'Text changes must reach the GPU through a region upload');
      assert.equal(updated.textureFullUpdates, uploads.textureFullUpdates,
        'A full upload must not hide inaccurate text dirty bounds');
      native.canvas.release(canvas.handle);
    }
  }
}
console.log('[text-upload] raster masks match GPU texture sub-uploads');
