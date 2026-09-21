'use strict';

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

const font = 'testfont.otf';

// 1. Font loading validation
assert.equal(native.canvas.canLoadFont(font), true, 'testfont.otf must load successfully');
assert.equal(native.canvas.canLoadFont('nonexistent-font.ttf'), false, 'nonexistent font must fail to load');

let stats = native.canvas.glyphStats();
assert.ok(stats.fontStrikes >= 1, 'Font strike should be recorded');
assert.equal(stats.glyphEntries, 0, 'No glyphs should be cached before measurement/draw');
assert.equal(stats.glyphBytes, 0, 'No glyph bytes before measurement/draw');
assert.ok(stats.maxGlyphBytes > 0, 'maxGlyphBytes must be positive');
assert.ok(stats.maxGlyphEntries > 0, 'maxGlyphEntries must be positive');

// 2. Metrics caching without rasterization
// "HELLO" has 4 unique glyphs: H, E, L, O (L is repeated)
const width1 = native.canvas.measureText(font, 'HELLO', 24);
assert.ok(typeof width1 === 'number' && width1 > 0, 'measureText should return positive width');

stats = native.canvas.glyphStats();
assert.equal(stats.glyphEntries, 4, 'Expected 4 unique glyph entries in cache');
assert.equal(stats.glyphMetricMisses, 4, 'Expected 4 metric misses for unique characters');
assert.equal(stats.glyphMetricHits, 1, 'Expected 1 metric hit for duplicate character L');
assert.equal(stats.glyphMaskMisses, 0, 'measureText must NOT rasterize or miss any glyph masks');
assert.equal(stats.glyphMaskHits, 0, 'measureText must NOT query glyph masks');
assert.equal(stats.freetypeRenderUs, 0, 'measureText must NOT spend time in FreeType render');

// Measure again - all 5 should hit metric cache
const width2 = native.canvas.measureText(font, 'HELLO', 24);
assert.equal(width2, width1, 'Measured width must remain identical');

stats = native.canvas.glyphStats();
assert.equal(stats.glyphMetricHits, 6, 'Second measureText should hit metrics for all 5 characters');
assert.equal(stats.glyphMetricMisses, 4, 'Metric misses should not increase');
assert.equal(stats.glyphMaskMisses, 0, 'Mask misses must remain 0');

// Measure metrics
const metrics = native.canvas.measureTextMetrics(font, 'HELLO', 24);
assert.equal(metrics.width, width1);
assert.ok(metrics.fontBoundingBoxAscent > 0);

stats = native.canvas.glyphStats();
assert.equal(stats.glyphMetricHits, 11, 'measureTextMetrics should also hit metrics cache');
assert.equal(stats.glyphMaskMisses, 0, 'measureTextMetrics must NOT rasterize masks');

// 3. Drawing materializes base fill mask
const canvas = native.canvas.create(128, 128);
native.canvas.clear(canvas.handle);

// Draw fill text: "HELLO"
native.canvas.drawText(canvas.handle, font, 'HELLO', 10, 40, 24, 0xffffffff, 0);
// Realize canvas to execute drawTextNow
const p1 = native.canvas.pixel(canvas.handle, 10, 40);

stats = native.canvas.glyphStats();
assert.equal(stats.glyphMaskMisses, 4, 'Expected 4 mask misses to rasterize H, E, L, O');
assert.equal(stats.glyphMaskHits, 1, 'Second L should hit mask cache');
assert.equal(stats.freetypeRenderUs, 0, 'FreeType render time should be 0 when telemetry is disabled (clock gated)');
assert.ok(stats.glyphBytes > 500, 'Glyph cache bytes should track rasterized coverage');

// Draw "HELLO" fill again: must hit fill mask cache for all 5 characters, 0 new rasterizations
native.canvas.drawText(canvas.handle, font, 'HELLO', 10, 60, 24, 0xff00ffff, 0);
native.canvas.pixel(canvas.handle, 10, 60);

stats = native.canvas.glyphStats();
assert.equal(stats.glyphMaskHits, 6, 'Expected 5 more mask hits for second draw');
assert.equal(stats.glyphMaskMisses, 4, 'Mask misses must not increase on repeat draw');

// 4. Derived stroke masks from base fill mask
// Draw outline text for new word "TEST" (strokeWidth = 4)
// T, E, S, T -> unique: T, E, S (E was already cached in "HELLO", so unique new: T, S)
native.canvas.drawText(canvas.handle, font, 'TEST', 10, 80, 24, 0x000000ff, 4);
native.canvas.pixel(canvas.handle, 10, 80);

stats = native.canvas.glyphStats();
// T and S were new so 2 mask misses; E was already cached, second T was duplicate hit
assert.equal(stats.strokeMaskMisses, 3, 'Expected 3 unique stroke mask builds for T, E, S');
assert.equal(stats.strokeMaskHits, 1, 'Second T in TEST should hit stroke mask cache');

// Draw "TEST" outline again (strokeWidth = 4) -> all 4 should hit stroke mask cache!
native.canvas.drawText(canvas.handle, font, 'TEST', 10, 80, 24, 0x000000ff, 4);
native.canvas.pixel(canvas.handle, 10, 80);

stats = native.canvas.glyphStats();
assert.equal(stats.strokeMaskHits, 5, 'All 4 characters should hit stroke mask cache on repeat outline draw');

// Draw "TEST" fill (strokeWidth = 0) -> all 4 should hit base fill mask without FreeType render!
native.canvas.drawText(canvas.handle, font, 'TEST', 10, 80, 24, 0xffffffff, 0);
native.canvas.pixel(canvas.handle, 10, 80);

stats = native.canvas.glyphStats();
assert.equal(stats.glyphMaskMisses, 6, 'Fill draw after outline must reuse base fill mask without new misses');

// 5. Strike isolation across different font sizes
const widthSmall = native.canvas.measureText(font, 'HELLO', 14);
assert.ok(widthSmall < width1, '14px text should have smaller width than 24px text');

stats = native.canvas.glyphStats();
assert.ok(stats.fontStrikes >= 2, 'Different pixel sizes must create distinct font strikes');

// 7. Test exact ABC sequence from review
// measureText("ABC") -> metrics entries created -> glyphMaskMisses remains 0
const glyphEntriesBeforeABC = stats.glyphEntries;
const maskMissesBeforeABC = stats.glyphMaskMisses;
const metricMissesBeforeABC = stats.glyphMetricMisses;

native.canvas.measureText(font, 'ABC', 20);
stats = native.canvas.glyphStats();
assert.equal(stats.glyphEntries, glyphEntriesBeforeABC + 3, 'measureText("ABC") must create 3 metrics entries');
assert.equal(stats.glyphMetricMisses, metricMissesBeforeABC + 3, 'Expected 3 metric misses for A, B, C');
assert.equal(stats.glyphMaskMisses, maskMissesBeforeABC, 'measureText("ABC") must NOT increment glyphMaskMisses');

// drawText("ABC", stroke=0) -> same 3 glyph entries -> 3 fill masks created
const c2 = native.canvas.create(128, 128);
native.canvas.drawText(c2.handle, font, 'ABC', 10, 30, 20, 0xffffffff, 0);
native.canvas.pixel(c2.handle, 10, 30);
stats = native.canvas.glyphStats();
assert.equal(stats.glyphEntries, glyphEntriesBeforeABC + 3, 'drawText("ABC", stroke=0) must reuse the same 3 glyph entries');
assert.equal(stats.glyphMaskMisses, maskMissesBeforeABC + 3, 'Expected 3 fill mask misses for A, B, C');

// drawText("ABC", stroke=4) -> still same 3 glyph entries -> derived stroke masks created
const strokeMissesBeforeABC = stats.strokeMaskMisses;
const maskHitsBeforeABC = stats.glyphMaskHits;
native.canvas.drawText(c2.handle, font, 'ABC', 10, 60, 20, 0x000000ff, 4);
native.canvas.pixel(c2.handle, 10, 60);
stats = native.canvas.glyphStats();
assert.equal(stats.glyphEntries, glyphEntriesBeforeABC + 3, 'drawText("ABC", stroke=4) must remain at same 3 entries');
assert.equal(stats.strokeMaskMisses, strokeMissesBeforeABC + 3, 'Expected 3 derived stroke mask misses');
assert.equal(stats.glyphMaskHits, maskHitsBeforeABC + 3, 'Outline draw must hit cached base fill masks for A, B, C');

// drawText("ABC", stroke=4) again -> stroke hits, no rasterization
const strokeHitsBeforeRepeat = stats.strokeMaskHits;
const renderUsBeforeRepeat = stats.freetypeRenderUs;
native.canvas.drawText(c2.handle, font, 'ABC', 10, 60, 20, 0x000000ff, 4);
native.canvas.pixel(c2.handle, 10, 60);
stats = native.canvas.glyphStats();
assert.equal(stats.strokeMaskHits, strokeHitsBeforeRepeat + 3, 'Repeat outline draw must hit stroke mask cache');
assert.equal(stats.freetypeRenderUs, renderUsBeforeRepeat, 'No FreeType render on repeat outline draw');
native.canvas.release(c2.handle);

// 8. Negative cache resilience: failed size strike does not poison face
assert.throws(() => native.canvas.measureText(font, 'A', 300), /text measurement failed/, 'Invalid pixel size (>256) must throw');
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
console.log('[pmjs-node-glyph-cache] all assertions passed successfully');
