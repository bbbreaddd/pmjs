'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { createHostContext } = require('./helpers/mz-host-context.cjs');
const reference = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'assets/reference/canvas-pixel-conversion.json.gz'))));
assert.equal(reference.reference.chromium, '65.0.3325.146');
assert.equal(reference.reference.nwVersion, '0.29.0');
assert.equal(reference.reference.archiveSha256, 'f6b759cbe0f2b57082ff08d63350be2e73bbf1a44717137fece0c13d048ff14b');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 32, height: 24, windowTitle: 'Canvas pixel encodings' });
const handles = [];
const create = (w, h) => { const c = native.canvas.create(w, h); handles.push(c.handle); return c; };
const read = (c, w = c.width, h = c.height) => Buffer.from(native.canvas.readPremultipliedPixels(c.handle, 0, 0, w, h));
const skia = native.canvas.glyphStats().backend === 'skia65';
try {
  const all = create(256, 256), input = new Uint8Array(256 * 256 * 4);
  for (let alpha = 0; alpha < 256; alpha++) for (let color = 0; color < 256; color++)
    input.set([color, color, color, alpha], (alpha * 256 + color) * 4);
  native.canvas.writePixels(all.handle, 0, 0, 256, 256, input);
  const premultiplied = read(all);
  assert.deepEqual(premultiplied, Buffer.from(reference.premultiplied), 'all 65,536 browser import combinations');
  for (let repeat = 0; repeat < 3; repeat++) {
    assert.deepEqual(Buffer.from(native.canvas.readPixels(all.handle, 0, 0, 256, 256)), Buffer.from(reference.straight), 'fixed-point browser export');
    assert.deepEqual(read(all), premultiplied, 'observation cannot mutate content');
  }
  for (const item of reference.overAlpha) {
    const source = create(item.width, 1);
    const bytes = new Uint8Array(item.width * 4);
    for (let x = 0; x < item.width; x++) bytes.set(item.rgba, x * 4);
    native.canvas.writePremultipliedPixels(source.handle, 0,0,item.width,1,bytes);
    assert.deepEqual(read(source), Buffer.from(item.source), 'raw browser source bytes survive transport');
    // The portable fallback has its own compositor, rather than Skia's row batches.
    if (!skia) continue;
    const destination = create(item.width, 1);
    if (item.background) native.canvas.fillRect(destination.handle,0,0,item.width,1,0x00ff0080);
    native.canvas.drawImage(destination.handle,source.handle,0,0,item.width,1,0,0,item.width,1,1);
    assert.deepEqual(read(destination), Buffer.from(item.pixels), 'over-alpha browser drawing, width=' + item.width);
    const copy = create(item.width,1);
    if (item.background) native.canvas.fillRect(copy.handle,0,0,item.width,1,0x00ff0080);
    native.canvas.drawImage(copy.handle,destination.handle,0,0,item.width,1,0,0,item.width,1,1);
    assert.deepEqual(read(copy), Buffer.from(item.copy), 'over-alpha browser Canvas copy, width=' + item.width);
  }
  if (skia) for (const item of reference.mixedAlpha) {
    const source = create(item.width, 1), destination = create(item.width, 1);
    native.canvas.writePremultipliedPixels(source.handle, 0,0,item.width,1, Uint8Array.from(item.source));
    if (item.background) native.canvas.fillRect(destination.handle,0,0,item.width,1,0x00ff0080);
    native.canvas.drawImage(destination.handle,source.handle,0,0,item.width,1,0,0,item.width,1,1);
    assert.deepEqual(read(destination), Buffer.from(item.pixels), 'mixed alpha browser source-over, width=' + item.width);
    const copy = create(item.width,1);
    if (item.background) native.canvas.fillRect(copy.handle,0,0,item.width,1,0x00ff0080);
    native.canvas.drawImage(copy.handle,destination.handle,0,0,item.width,1,0,0,item.width,1,1);
    assert.deepEqual(read(copy), Buffer.from(item.copy), 'mixed alpha browser repeated copy, width=' + item.width);
  }
  const odd = create(5, 3);
  native.canvas.writePremultipliedPixels(odd.handle, -1, 1, 3, 1, Uint8Array.of(9,8,7,6, 255,127,0,0, 128,0,0,127));
  assert.deepEqual(Array.from(native.canvas.readPremultipliedPixels(odd.handle, -1, 1, 4, 1)), [0,0,0,0, 255,127,0,0, 128,0,0,127, 0,0,0,0]);
  const frozen = read(odd);
  native.canvas.pixel(odd.handle, 0, 1);
  assert.deepEqual(Array.from(native.canvas.readPixels(odd.handle, 0, 1, 2, 1)), [0,0,0,0, 255,0,0,127]);
  assert.ok(native.canvas.encodePng(odd.handle).length > 0);
  assert.deepEqual(read(odd), frozen, 'PNG serialization cannot normalize hidden or over-alpha RGB');
  const copy = create(5, 3);
  native.canvas.drawImage(copy.handle, odd.handle, 0,0,5,3, 0,0,5,3,1);
  native.canvas.clear(odd.handle);
  const copied = Buffer.from(frozen);
  copied.fill(0, (1 * 5) * 4, (1 * 5 + 1) * 4);
  assert.deepEqual(read(copy), copied, 'captured version follows browser source-over without changing source');
  native.canvas.drawImage(copy.handle, copy.handle, 0,1,2,1, 2,1,2,1,1);
  assert.deepEqual(Array.from(native.canvas.readPremultipliedPixels(copy.handle, 2,1,2,1)), [0,0,0,0, 128,0,0,127], 'self draw captures before detachment');
  const source = create(1,1), target = create(1,1);
  native.canvas.writePremultipliedPixels(source.handle,0,0,1,1,Uint8Array.of(0,128,0,128));
  native.canvas.writePremultipliedPixels(target.handle,0,0,1,1,Uint8Array.of(255,127,0,0));
  native.canvas.drawImage(target.handle,source.handle,0,0,1,1,0,0,1,1,1);
  assert.deepEqual(Array.from(read(target)), [127,191,0,128], 'alpha-zero destination is not necessarily transparent black');
  const ctx = createHostContext(native, { graphics: false });
  // Force clipping and reflection through the JavaScript affine path.
  ctx.sourceHandle = source.handle; ctx.targetHandle = target.handle;
  const raw = vm.runInContext(`(function() {
    var source = document.createElement('canvas'); source.width = source.height = 1;
    source._nativeCanvas = { handle: sourceHandle, width: 1, height: 1 };
    var target = document.createElement('canvas'); target.width = target.height = 1;
    target._nativeCanvas = { handle: targetHandle, width: 1, height: 1 };
    NativeHost.canvas.writePremultipliedPixels(sourceHandle,0,0,1,1,Uint8Array.of(255,127,0,0));
    NativeHost.canvas.clear(targetHandle);
    var drawing = target.getContext('2d'); drawing.beginPath(); drawing.rect(0,0,1,1); drawing.clip();
    drawing.translate(1,0); drawing.scale(-1,1); drawing.drawImage(source,0,0);
    return Array.from(NativeHost.canvas.readPremultipliedPixels(targetHandle,0,0,1,1));
  })()`, ctx);
  assert.deepEqual(Array.from(raw), [0,0,0,0], 'affine source-over follows browser alpha-zero behavior');
  const explicitCopy = vm.runInContext(`(function() {
    var source = document.createElement('canvas'); source.width = source.height = 1;
    source._nativeCanvas = { handle: sourceHandle, width: 1, height: 1 };
    var target = document.createElement('canvas'); target.width = target.height = 1;
    target._nativeCanvas = { handle: targetHandle, width: 1, height: 1 };
    var drawing = target.getContext('2d'); drawing.globalCompositeOperation = 'copy';
    drawing.drawImage(source,0,0);
    return Array.from(NativeHost.canvas.readPremultipliedPixels(targetHandle,0,0,1,1));
  })()`, ctx);
  assert.deepEqual(Array.from(explicitCopy), [255,127,0,0], 'explicit copy retains raw source colors');
  for (const item of reference.lighterAlphaZero) {
    native.canvas.clear(target.handle);
    if (item.background) native.canvas.fillRect(target.handle,0,0,1,1,0x00ff0080);
    const lighter = vm.runInContext(`(function() {
      var source = document.createElement('canvas'); source.width = source.height = 1;
      source._nativeCanvas = { handle: sourceHandle, width: 1, height: 1 };
      var target = document.createElement('canvas'); target.width = target.height = 1;
      target._nativeCanvas = { handle: targetHandle, width: 1, height: 1 };
      var drawing = target.getContext('2d'); drawing.globalCompositeOperation = 'lighter';
      drawing.drawImage(source,0,0);
      return Array.from(NativeHost.canvas.readPremultipliedPixels(targetHandle,0,0,1,1));
    })()`, ctx);
    assert.deepEqual(Array.from(lighter), item.pixels, 'lighter preserves browser alpha-zero source contributions');
  }
  assert.equal(native.canvas.glyphStats().scratchBytes || 0, 0);
} finally {
  for (const handle of handles) native.canvas.release(handle);
  native.runtime.quit();
}
console.log('[canvas-pixels] browser conversion, observations, copies and affine transport agree');
