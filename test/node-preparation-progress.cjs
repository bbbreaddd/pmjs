'use strict';

process.env.PMJS_GRAPHICS_DIAGNOSTICS = '1';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { progressLines } = require('../runner/index.cjs');
const { performance } = require('node:perf_hooks');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '',
  width: 320, height: 240, windowTitle: 'preparation progress' });
const before = native.render.stats().frames;
const started = performance.now();
for (let completed = 0; completed < 1000; ++completed)
  native.runtime.preparationProgress({ completed, total: 1000 });
native.runtime.preparationProgress({ completed: 1000, total: 1000 });
const elapsed = performance.now() - started;
const frames = native.render.stats().frames - before;
assert.ok(frames >= 2, 'initial and complete progress must be displayed');
assert.ok(frames <= Math.floor(elapsed / 100) + 2,
  'progress presentation must be bounded independently of callback count');
assert.throws(() => native.runtime.preparationProgress({ completed: -1, total: 1 }));
const canvasesBefore = native.canvas.memory().liveCount;
const progress = { phase: 'prepare', completed: 17, total: 100, generated: 10,
  hits: 7, fallback: 2, elapsedMs: 10000, terminal: false,
  source: 'img/pictures/' + 'café_'.repeat(40) + 'portrait.png' };
function show(value) {
  native.runtime.preparationProgress({ ...value, terminal: true,
    fonts: ['missing.ttf', 'text-shaping.ttf'], lines: progressLines(value) });
  return Buffer.from(native.canvas.captureSceneRawPremultiplied());
}
const cold = show(progress);
let titlePixels = 0;
for (let y = 35; y < 58; y++) for (let x = 0; x < 320; x++) {
  if (cold[(y * 320 + x) * 4] > 160) titlePixels++;
}
assert.ok(titlePixels > 30, 'phase title text must be visible before guest boot');
const warm = show({ ...progress, phase: 'validate', generated: 0, hits: 17 });
assert.ok(!cold.equals(warm), 'warm validation and cold generation must show different text');
assert.equal(native.canvas.memory().liveCount, canvasesBefore, 'terminal display releases its canvas');
// Unknown totals are throttled too; discovery must not redraw at polling frequency.
const discoveryBefore = native.render.stats().frames;
const discoveryStarted = performance.now();
for (let i = 0; i < 1000; i++) native.runtime.preparationProgress({
  completed: 0, total: 0, phase: 'discover', terminal: false });
assert.ok(native.render.stats().frames - discoveryBefore <=
  Math.floor((performance.now() - discoveryStarted) / 100) + 1);
show({ phase: 'complete', terminal: true, completed: 100, total: 100, elapsedMs: 20000 });
assert.equal(native.canvas.memory().liveCount, canvasesBefore);
if (process.env.PMJS_PREPARATION_CAPTURE) {
  const frame = native.canvas.captureScene();
  try { fs.writeFileSync(process.env.PMJS_PREPARATION_CAPTURE, Buffer.from(native.canvas.encodePng(frame.handle))); }
  finally { native.canvas.release(frame.handle); }
}
native.beginFrame(); native.renderFrame();
const cleared = Buffer.from(native.canvas.captureSceneRawPremultiplied());
assert.ok(!warm.equals(cleared), 'following frame must not retain preparation text');
native.runtime.quit();
