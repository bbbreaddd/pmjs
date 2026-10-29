'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMemoryReclaimer } = require('../runner/memory-reclamation.cjs');
const MiB = 1024 * 1024;

function fixture() {
  const f = { time: 0, rss: 540 * MiB, available: 160 * MiB,
    free: 160 * MiB, recovery: 150 * MiB, jobs: 0, trims: 0, logs: [], warnings: [] };
  const native = { runtime: {
    allocatorStats: () => ({ freeArenaBytes: f.free }),
    trimAllocator() { f.trims++; f.time += 56; f.rss -= f.recovery; return f.recovery > 0; }
  }, images: { memory: () => ({ pendingDecodeJobs: f.jobs }) } };
  f.sample = () => ({ availableBytes: f.available, rssBytes: f.rss });
  f.native = native;
  f.policy = createMemoryReclaimer({ native, readMemory: f.sample, readRss: () => f.rss,
    now: () => f.time, logger: { log: line => f.logs.push(line), warn: line => f.warnings.push(line) } });
  f.pressure = () => { f.policy.observe(f.sample()); f.policy.observe(f.sample()); };
  return f;
}

test('startup reclaims once, preserving allocator/resource policy outside the call', () => {
  const f = fixture(); f.available = 500 * MiB;
  const result = f.policy.atBoundary('startup');
  assert.equal(result.recoveredBytes, 150 * MiB);
  assert.equal(result.durationMs, 56);
  assert.equal(f.free, 160 * MiB, 'logical free bytes can remain high after reclamation');
  f.time += 60000;
  assert.equal(f.policy.atBoundary('startup'), null);
  assert.equal(f.trims, 1);
});

test('pressure needs distinct observations and a supported rendering boundary', () => {
  const f = fixture(), sample = f.sample();
  f.policy.observe(sample); f.policy.observe(sample);
  assert.equal(f.policy.pending, false);
  f.policy.observe(f.sample());
  assert.equal(f.policy.pending, true);
  assert.equal(f.policy.atBoundary(null), null);
  assert.equal(f.policy.atBoundary('dialogue-pause'), null);
  assert.equal(f.trims, 0);
  assert.equal(f.policy.atBoundary('scene-fade').recoveredBytes, 150 * MiB);
  assert.equal(f.policy.pending, false);
});

test('healthy memory and stale pressure do not cause gameplay reclamation', () => {
  const f = fixture(); f.available = 400 * MiB; f.pressure();
  assert.equal(f.policy.pending, false);
  f.available = 160 * MiB; f.pressure();
  f.available = 300 * MiB;
  assert.equal(f.policy.atBoundary('scene-fade'), null);
  assert.equal(f.policy.pending, false);
  assert.equal(f.trims, 0);
});

test('active decodes defer a request and small free arenas avoid a trim', () => {
  const f = fixture(); f.pressure(); f.jobs = 1;
  assert.equal(f.policy.atBoundary('scene-fade'), null);
  assert.equal(f.policy.pending, true);
  f.jobs = 0; f.free = 8 * MiB;
  assert.equal(f.policy.atBoundary('scene-fade'), null);
  assert.equal(f.policy.pending, false);
  assert.equal(f.trims, 0);
});

test('cooldown and RSS growth prevent repeatedly trimming already decommitted space', () => {
  const f = fixture(); f.pressure(); f.policy.atBoundary('scene-fade');
  f.time += 59000; f.rss += 100 * MiB; f.policy.observe(f.sample());
  assert.equal(f.policy.pending, false);
  f.time += 1001; f.policy.observe(f.sample());
  assert.equal(f.policy.pending, true);
  f.policy.atBoundary('scene-fade');
  f.time += 60001; f.policy.observe(f.sample());
  assert.equal(f.policy.pending, false);
  assert.equal(f.trims, 2);
});

test('low-yield attempts back off but new allocation growth can retry after the cooldown', () => {
  const f = fixture(); f.recovery = 0; f.pressure(); f.policy.atBoundary('scene-fade');
  f.time += 60001;
  f.available = 300 * MiB; f.policy.observe(f.sample());
  f.available = 160 * MiB; f.pressure();
  assert.equal(f.policy.pending, false);
  f.rss += 65 * MiB; f.policy.observe(f.sample());
  assert.equal(f.policy.pending, true);
  f.policy.atBoundary('scene-fade');
  assert.equal(f.trims, 2);
});

test('a new sustained pressure episode or worsening headroom rearms a successful policy', () => {
  const f = fixture(); f.pressure(); f.policy.atBoundary('scene-fade'); f.time += 60001;
  f.available = 300 * MiB; f.policy.observe(f.sample());
  f.available = 160 * MiB; f.pressure();
  assert.equal(f.policy.pending, true);
  f.policy.atBoundary('scene-fade'); f.time += 60001;
  f.available = 100 * MiB; f.policy.observe(f.sample());
  assert.equal(f.policy.pending, true);
});

test('missing native support and native failures never abort the game or retry each frame', () => {
  const f = fixture(); f.native.runtime.allocatorStats = () => undefined;
  f.pressure(); assert.equal(f.policy.atBoundary('scene-fade'), null);
  assert.equal(f.policy.pending, false);
  const g = fixture(); g.native.runtime.trimAllocator = () => { throw new Error('unavailable'); };
  g.pressure(); assert.equal(g.policy.atBoundary('scene-fade'), null);
  g.time += 600001; g.pressure();
  assert.equal(g.policy.pending, false); assert.equal(g.warnings.length, 1);
  const h = createMemoryReclaimer({ native: { runtime: {} } });
  h.observe({ availableBytes: 0 }); assert.equal(h.atBoundary('startup'), null);
});
