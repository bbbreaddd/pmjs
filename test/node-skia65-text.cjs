'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'assets/reference/skia65-text.json.gz'))));
require('./helpers/skia65-reference-contract.cjs').validate(fixture);
const native = require(path.resolve(process.argv[2]));
const assets = path.resolve(process.argv[3]);
for (const font of fixture.fonts)
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(assets, font.file))).digest('hex'), font.sha256);
native.initialize({ gameRoot: assets, assetRoot: '', width: 224, height: 72, windowTitle: 'Skia65 text fixtures' });
assert.equal(native.canvas.glyphStats().backend, 'skia65');
function premul(bytes) {
  const pixels = Buffer.from(bytes);
  for (let i = 0; i < pixels.length; i += 4) for (let c = 0; c < 3; c++) pixels[i + c] = Math.floor((pixels[i + c] * pixels[i + 3] + 127) / 255);
  return pixels;
}
const mismatches = [];
const inkBounds = [];
for (const item of fixture.cases) for (const layer of ['fill', 'outline', 'full']) {
  const style = { bold: !!item.bold, italic: !!item.italic, lineJoin: item.join, lineCap: item.cap, miterLimit: item.miterLimit };
  const reference = fixture.records.find(row => row.name === item.name && row.layer === layer);
  const measured = native.canvas.measureText(item.fontFiles, item.text, item.size, style);
  for (const realized of [false, true]) {
    const canvas = native.canvas.create(item.width, item.height);
    if (realized) native.canvas.readPixels(canvas.handle, 0, 0, 1, 1);
    const bg = reference.background.reduce((value, channel) => (value * 256 + channel) >>> 0, 0);
    assert.deepEqual(Array.from(premul(reference.background)), reference.backgroundPremul, 'Background roundtrip must reproduce the oracle input');
    native.canvas.fillRect(canvas.handle, 0, 0, item.width, item.height, bg);
    const x = item.align === 'center' ? item.x - measured / 2 : item.x;
    if (layer !== 'fill') native.canvas.drawText(canvas.handle, item.fontFiles, item.text, x, item.y, item.size, item.outline, item.stroke, style);
    if (layer !== 'outline') native.canvas.drawText(canvas.handle, item.fontFiles, item.text, x, item.y, item.size,
      ((item.fill & 0xffffff00) | Math.round((item.fill & 255) * item.alpha)) >>> 0, 0, style);
    const pixels = premul(native.canvas.readPixels(canvas.handle, 0, 0, item.width, item.height));
    const expected = Buffer.from(reference.pixels, 'base64');
    if (!realized && layer === 'fill' && item.background === 0) {
      let left = item.width, top = item.height, right = 0, bottom = 0;
      for (let y = 0; y < item.height; y++) for (let x = 0; x < item.width; x++) {
        if (!expected[(y * item.width + x) * 4 + 3]) continue;
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
      }
      inkBounds.push({ name: item.name, bounds: right ? [left, top, right, bottom] : null });
    }
    const repeated = premul(native.canvas.readPixels(canvas.handle, 0, 0, item.width, item.height));
    assert.deepEqual(pixels, repeated, 'Frozen Canvas pixels changed');
    let differingPixels = 0, maxDelta = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      let delta = 0; for (let c = 0; c < 4; c++) delta = Math.max(delta, Math.abs(pixels[i + c] - expected[i + c]));
      if (delta) differingPixels++; maxDelta = Math.max(maxDelta, delta);
    }
    if (differingPixels || measured !== reference.width)
      mismatches.push({ name: item.name, layer, realized, differingPixels, maxDelta, widthDelta: measured - reference.width });
    native.canvas.release(canvas.handle);
  }
}
console.log(JSON.stringify({ cases: fixture.cases.length, comparisons: fixture.records.length * 2, mismatches, inkBounds,
  stats: native.canvas.glyphStats(), memory: native.canvas.memory() }));
assert.equal(mismatches.length, 0, 'Chromium65 text fixtures require exact pixels and advances');
