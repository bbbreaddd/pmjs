'use strict';

// This test exercises the legacy cache implementation, irrespective of the local default.
process.env.PMJS_TEXT_BACKEND = 'freetype';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '',
  width: 128, height: 96, windowTitle: 'recent text layout test' });
const font = 'text-shaping.ttf';
const canvas = native.canvas.create(128, 96);
native.canvas.readPixels(canvas.handle, 0, 0, 1, 1);

function reveal(text, fonts = font, size = 24) {
  const width = native.canvas.measureText(fonts, text, size);
  const measured = native.canvas.measureTextMetrics(fonts, text, size);
  assert.equal(measured.width, width);
  native.canvas.drawText(canvas.handle, fonts, text, 16, 48, size, 0x000000ff, 4);
  native.canvas.drawText(canvas.handle, fonts, text, 16, 48, size, 0xffffffff, 0);
}
reveal('A');
let stats = native.canvas.glyphStats();
assert.ok(stats.layoutCacheHits > 0, 'Repeated layout queries within a draw cycle should hit layout cache');
reveal('B');
reveal('A', font, 28);
const wPrimaryA = native.canvas.measureText(font, 'AV ffi', 24);
const wPrimaryB = native.canvas.measureText('testfont.ttf', 'AV ffi', 24);
assert.notEqual(wPrimaryA, wPrimaryB, 'Test fonts must have distinct widths to verify fallback ordering');
assert.equal(native.canvas.measureText([font, 'testfont.ttf'], 'AV ffi', 24), wPrimaryA);
assert.equal(native.canvas.measureText(['testfont.ttf', font], 'AV ffi', 24), wPrimaryB);
assert.equal(native.canvas.measureText(font, 'A\nB', 24), native.canvas.measureTextMetrics(font, 'A B', 24).width);
reveal('لا', ['testfont.ttf', font]);
native.canvas.setGlyphCacheLimits(1024, 1);
reveal('AV ffi');
const tinyBefore = native.canvas.glyphStats().shapeTextCalls;
reveal('AV ffi');
assert.equal(native.canvas.glyphStats().shapeTextCalls - tinyBefore, 0,
  'Glyph-mask eviction does not invalidate positioned text or retain mask pointers');
assert.ok(native.canvas.glyphStats().layoutCacheBytes <= 32 * 1024);
native.canvas.measureText(font, 'A'.repeat(129), 24);
native.canvas.measureText(font, 'A'.repeat(129), 24);
assert.ok(native.canvas.glyphStats().layoutCacheBytes <= 32 * 1024);
native.canvas.measureText(font, 'A'.repeat(1024), 24);
native.canvas.measureText(font, 'A'.repeat(1024), 24);
assert.ok(native.canvas.glyphStats().layoutCacheBytes <= 32 * 1024);
native.canvas.release(canvas.handle);
console.log('[text-cache] bounded reuse, font ordering, preparation and eviction passed');
