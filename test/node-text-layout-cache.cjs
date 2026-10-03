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
assert.equal(stats.layoutRequests, 4);
assert.equal(stats.shapeTextCalls, 1);
assert.equal(stats.layoutCacheHits, 3);
assert.equal(stats.glyphMaskMisses, 1, 'Outlining and fill still share the rasterized glyph');
assert.equal(stats.glyphMetricMisses, 1, 'Layout cache does not duplicate glyph metrics');
reveal('B');
assert.equal(native.canvas.glyphStats().shapeTextCalls, 2);
reveal('A');
assert.equal(native.canvas.glyphStats().shapeTextCalls, 3,
  'Cache holds one recent layout, rather than every prior string');
const beforeSize = native.canvas.glyphStats().shapeTextCalls;
reveal('A', font, 28);
assert.equal(native.canvas.glyphStats().shapeTextCalls - beforeSize, 1);
const beforeFonts = native.canvas.glyphStats().shapeTextCalls;
reveal('A', [font, 'testfont.ttf']);
reveal('A', ['testfont.ttf', font]);
assert.equal(native.canvas.glyphStats().shapeTextCalls - beforeFonts, 2,
  'Ordered fallback faces participate in the layout key');
const beforeNormalized = native.canvas.glyphStats().shapeTextCalls;
native.canvas.measureText(font, 'A\nB', 24);
native.canvas.measureTextMetrics(font, 'A B', 24);
assert.equal(native.canvas.glyphStats().shapeTextCalls - beforeNormalized, 1,
  'Cache keys use prepared Canvas text');
const beforeFallback = native.canvas.glyphStats().fallbackShapeCalls;
reveal('لا', ['testfont.ttf', font]);
assert.equal(native.canvas.glyphStats().fallbackShapeCalls - beforeFallback, 1);
native.canvas.setGlyphCacheLimits(1024, 1);
reveal('AV ffi');
const tinyBefore = native.canvas.glyphStats().shapeTextCalls;
reveal('AV ffi');
assert.equal(native.canvas.glyphStats().shapeTextCalls - tinyBefore, 0,
  'Glyph-mask eviction does not invalidate positioned text or retain mask pointers');
assert.ok(native.canvas.glyphStats().layoutCacheBytes <= 32 * 1024);
const beforeLong = native.canvas.glyphStats().shapeTextCalls;
native.canvas.measureText(font, 'A'.repeat(129), 24);
native.canvas.measureText(font, 'A'.repeat(129), 24);
stats = native.canvas.glyphStats();
assert.equal(stats.shapeTextCalls - beforeLong, 1,
  'Moderately long text remains eligible for recent-layout reuse');
assert.ok(stats.layoutCacheBytes > 0 && stats.layoutCacheBytes <= 32 * 1024);
const beforeOversize = stats.shapeTextCalls;
native.canvas.measureText(font, 'A'.repeat(1024), 24);
native.canvas.measureText(font, 'A'.repeat(1024), 24);
stats = native.canvas.glyphStats();
assert.equal(stats.shapeTextCalls - beforeOversize, 2);
assert.equal(stats.layoutCacheBytes, 0, 'Long strings are not retained');
native.canvas.release(canvas.handle);
console.log('[text-cache] bounded reuse, font ordering, preparation and eviction passed');
