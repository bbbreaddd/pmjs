'use strict';

// This test exercises the legacy cache implementation, irrespective of the local default.
process.env.PMJS_TEXT_BACKEND = 'freetype';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
const root = path.resolve(process.argv[3]);

native.initialize({
  gameRoot: root,
  assetRoot: '',
  width: 128,
  height: 128,
  windowTitle: 'glyph cache test',
});

const font = 'testfont.ttf';

// 1. Font loading validation
assert.equal(native.canvas.canLoadFont(font), true, 'testfont.ttf must load successfully');
assert.equal(native.canvas.canLoadFont('nonexistent-font.ttf'), false, 'nonexistent font must fail to load');

let stats = native.canvas.glyphStats();
assert.ok(stats.fontStrikes >= 1, 'Font strike should be recorded');
assert.equal(stats.glyphEntries, 0, 'No glyphs should be cached before measurement/draw');
assert.equal(stats.glyphBytes, 0, 'No glyph bytes before measurement/draw');
assert.ok(stats.maxGlyphBytes > 0, 'maxGlyphBytes must be positive');
assert.ok(stats.maxGlyphEntries > 0, 'maxGlyphEntries must be positive');

// 2. Metrics caching without rasterization
const width1 = native.canvas.measureText(font, 'HELLO', 24);
assert.ok(typeof width1 === 'number' && width1 > 0, 'measureText should return positive width');

stats = native.canvas.glyphStats();
assert.ok(stats.glyphEntries > 0, 'measureText should populate glyph cache');
assert.equal(stats.glyphMaskMisses, 0, 'measureText must NOT rasterize glyph masks');

// Repeated measurement must reuse the prepared layout without rasterizing.
const hitsBeforeRepeatMeasure = stats.layoutCacheHits;
const width2 = native.canvas.measureText(font, 'HELLO', 24);
assert.equal(width2, width1, 'Measured width must remain identical');

stats = native.canvas.glyphStats();
assert.ok(stats.layoutCacheHits > hitsBeforeRepeatMeasure, 'Repeated measurement should reuse the layout');
assert.equal(stats.glyphMaskMisses, 0, 'Mask misses must remain 0');

// Measure metrics
const metrics = native.canvas.measureTextMetrics(font, 'HELLO', 24);
assert.equal(metrics.width, width1);
assert.ok(metrics.fontBoundingBoxAscent > 0);

// 3. Drawing materializes base fill mask and reuses it on repeat draw
const canvas = native.canvas.create(128, 128);
native.canvas.clear(canvas.handle);

native.canvas.drawText(canvas.handle, font, 'HELLO', 10, 40, 24, 0xffffffff, 0);
native.canvas.pixel(canvas.handle, 10, 40);

stats = native.canvas.glyphStats();
assert.ok(stats.glyphBytes > 0, 'Glyph cache bytes should track rasterized coverage');

const maskHitsBeforeRepeat = stats.glyphMaskHits;
const maskMissesBeforeRepeat = stats.glyphMaskMisses;
native.canvas.drawText(canvas.handle, font, 'HELLO', 10, 60, 24, 0xff00ffff, 0);
native.canvas.pixel(canvas.handle, 10, 60);

stats = native.canvas.glyphStats();
assert.ok(stats.glyphMaskHits > maskHitsBeforeRepeat, 'Repeat fill draw should hit glyph mask cache');
assert.equal(stats.glyphMaskMisses, maskMissesBeforeRepeat, 'Repeat fill draw must not rasterize new masks');

// 4. Derived stroke masks from base fill mask
native.canvas.drawText(canvas.handle, font, 'TEST', 10, 80, 24, 0x000000ff, 4);
native.canvas.pixel(canvas.handle, 10, 80);

const strokeHitsBeforeRepeat = native.canvas.glyphStats().strokeMaskHits;
const strokeMissesBeforeRepeat = native.canvas.glyphStats().strokeMaskMisses;
native.canvas.drawText(canvas.handle, font, 'TEST', 10, 80, 24, 0x000000ff, 4);
native.canvas.pixel(canvas.handle, 10, 80);

stats = native.canvas.glyphStats();
assert.ok(stats.strokeMaskHits > strokeHitsBeforeRepeat, 'Repeat outline draw should hit stroke mask cache');
assert.equal(stats.strokeMaskMisses, strokeMissesBeforeRepeat, 'Repeat outline draw must not rebuild stroke masks');

const maskMissesBeforeTestFill = stats.glyphMaskMisses;
native.canvas.drawText(canvas.handle, font, 'TEST', 10, 80, 24, 0xffffffff, 0);
native.canvas.pixel(canvas.handle, 10, 80);
assert.equal(native.canvas.glyphStats().glyphMaskMisses, maskMissesBeforeTestFill,
  'Fill draw after outline must reuse base fill mask without new rasterizations');

// 5. Strike isolation across different font sizes
const widthSmall = native.canvas.measureText(font, 'HELLO', 14);
assert.ok(widthSmall < width1, '14px text should have smaller width than 24px text');

stats = native.canvas.glyphStats();
assert.ok(stats.fontStrikes >= 2, 'Different pixel sizes must create distinct font strikes');

// 8. Negative cache resilience: failed size strike does not poison face
assert.throws(() => native.canvas.measureText(font, 'A', Infinity), /text measurement failed/, 'Nonfinite pixel size must throw');
assert.ok(typeof native.canvas.measureText(font, 'A', 20) === 'number', 'Valid pixel size for same font must still succeed');

// 9. In-process cache limit reconfiguration and eviction safety
native.canvas.setGlyphCacheLimits(1, 1);
let tinyStats = native.canvas.glyphStats();
assert.equal(tinyStats.maxGlyphBytes, 1024, 'maxGlyphBytes should clamp to at least 1024');
assert.equal(tinyStats.maxGlyphEntries, 1, 'maxGlyphEntries should clamp to at least 1');

// Measure and draw with constrained budget (tests eviction and pinned MRU entry)
const c3 = native.canvas.create(64, 64);
native.canvas.drawText(c3.handle, font, 'WORDONE', 5, 20, 24, 0xffffffff, 0);
native.canvas.drawText(c3.handle, font, 'WORDTWO', 5, 40, 24, 0x00ff00ff, 2);
native.canvas.pixel(c3.handle, 5, 20);

tinyStats = native.canvas.glyphStats();
assert.ok(tinyStats.glyphEvictions > 0, 'Expected evictions under tiny budget');
assert.ok(tinyStats.glyphEntries <= 2, 'Cache entry count should stay constrained');

// Verify canvas can still be released without dangling pointer issues
native.canvas.release(c3.handle);

// Restore normal limits
native.canvas.setGlyphCacheLimits(8 * 1024 * 1024, 4096);
const restoredStats = native.canvas.glyphStats();
assert.equal(restoredStats.maxGlyphBytes, 8 * 1024 * 1024);
assert.equal(restoredStats.maxGlyphEntries, 4096);

native.canvas.release(canvas.handle);
assert.ok(native.canvas.measureText(font, 'W', 300) > 0);
const large = native.canvas.create(96, 96);
native.canvas.drawText(large.handle, font, 'W', -50, 180, 300, 0xffffffff, 40);
assert.ok(native.canvas.readPixels(large.handle, 0, 0, 96, 96).some((value, i) => i % 4 === 3 && value));
native.canvas.release(large.handle);
console.log('[pmjs-node-glyph-cache] all assertions passed successfully');
