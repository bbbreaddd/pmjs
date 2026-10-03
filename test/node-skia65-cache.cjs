'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'assets/reference/skia65-text.json.gz'))));
require('./helpers/skia65-reference-contract.cjs').validate(fixture);
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '', width: 224, height: 72,
  windowTitle: 'Skia65 cached text contracts' });
assert.equal(native.canvas.glyphStats().backend, 'skia65');
function premul(bytes) {
  const pixels = Buffer.from(bytes);
  for (let i = 0; i < pixels.length; i += 4)
    for (let channel = 0; channel < 3; ++channel)
      pixels[i + channel] = Math.floor((pixels[i + channel] * pixels[i + 3] + 127) / 255);
  return pixels;
}
function compare(item) {
  const style = { bold: !!item.bold, italic: !!item.italic, lineJoin: item.join, lineCap: item.cap, miterLimit: item.miterLimit };
  const expected = fixture.records.find(row => row.name === item.name && row.layer === 'full');
  const canvas = native.canvas.create(item.width, item.height);
  const background = expected.background.reduce((value, channel) => (value * 256 + channel) >>> 0, 0);
  native.canvas.fillRect(canvas.handle, 0, 0, item.width, item.height, background);
  const width = native.canvas.measureText(item.fontFiles, item.text, item.size, style);
  assert.equal(width, expected.width, item.name);
  const x = item.align === 'center' ? item.x - width / 2 : item.x;
  native.canvas.drawText(canvas.handle, item.fontFiles, item.text, x, item.y, item.size, item.outline, item.stroke, style);
  native.canvas.drawText(canvas.handle, item.fontFiles, item.text, x, item.y, item.size,
    ((item.fill & 0xffffff00) | Math.round((item.fill & 255) * item.alpha)) >>> 0, 0, style);
  const pixels = premul(native.canvas.readPixels(canvas.handle, 0, 0, item.width, item.height));
  assert.deepEqual(pixels, Buffer.from(expected.pixels, 'base64'), item.name);
  native.canvas.release(canvas.handle);
}
for (const item of fixture.cases) compare(item);
for (const item of fixture.cases.slice().reverse()) compare(item);
const font = 'text-shaping.ttf';
for (let index = 0; index < 200; ++index)
  native.canvas.measureText(font, `OMORI ${index} AV ffi é`, 28);
const before = native.canvas.glyphStats();
assert.ok(before.layoutCacheEntries <= before.fontStacks * 16);
assert.ok(before.layoutCacheBytes <= before.fontStacks * 64 * 1024);
assert.ok(before.metricCacheBytes <= before.fontStacks * 128 * 20);
assert.ok(before.scratchBytes <= 128 * 1024);
const retained = native.canvas.create(224, 72);
native.canvas.drawText(retained.handle, font, 'AV To', 12.25, 38.75, 24.5, 0xffffffff, 0);
for (let count = 1; count <= 17; ++count)
  native.canvas.measureText(Array(count).fill(font), 'AV To', 24.5);
const reference = fixture.records.find(row => row.name === 'fractional' && row.layer === 'fill');
assert.deepEqual(premul(native.canvas.readPixels(retained.handle, 0, 0, 224, 72)),
  Buffer.from(reference.pixels, 'base64'), 'Queued text survives font-stack eviction');
native.canvas.release(retained.handle);
for (const item of fixture.cases) compare(item);
assert.equal(native.canvas.memory().liveCount, 0);
assert.ok(native.canvas.glyphStats().fontStacks <= 16);
console.log(JSON.stringify({ comparisons: fixture.cases.length * 3 + 1, stats: native.canvas.glyphStats() }));
