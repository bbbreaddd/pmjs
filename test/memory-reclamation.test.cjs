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

test('sustained critical pressure trims during play when no fade arrives', () => {
  // Field report: a fade trim, then a long sequence without a fade regrows past the headroom.
  const f = fixture(); f.pressure();
  assert.equal(f.policy.atBoundary('scene-fade').boundary, 'scene-fade');
  f.time += 20000; f.rss += 90 * MiB; f.available = 80 * MiB; f.pressure();
  assert.equal(f.policy.pending, true, 'regrowth under critical pressure bypasses the 60 s cooldown');
  assert.equal(f.policy.atBoundary(null), null, 'a fade gets the grace period first');
  f.time += 2000;
  const result = f.policy.atBoundary(null);
  assert.equal(result.boundary, 'critical-pressure');
  assert.equal(result.availableBytes, 80 * MiB);
  assert.equal(f.trims, 2);
  assert.equal(f.policy.pending, false);
});

test('a fade inside the grace period takes the critical trim invisibly', () => {
  const f = fixture(); f.available = 80 * MiB; f.pressure();
  assert.equal(f.policy.atBoundary(null), null);
  assert.equal(f.policy.atBoundary('scene-fade').boundary, 'scene-fade');
  f.time += 5000;
  assert.equal(f.policy.atBoundary(null), null);
  assert.equal(f.trims, 1);
});

test('non-critical pressure still waits for a fade', () => {
  const f = fixture(); f.available = 150 * MiB; f.pressure();
  f.time += 60000;
  assert.equal(f.policy.atBoundary(null), null);
  assert.equal(f.policy.atBoundary('dialogue-pause'), null);
  assert.equal(f.trims, 0);
});

test('critical trims need regrowth and a minimum interval', () => {
  const f = fixture(); f.available = 80 * MiB; f.pressure(); f.time += 2000;
  assert.equal(f.policy.atBoundary(null).boundary, 'critical-pressure');
  f.time += 3000; f.rss += 100 * MiB; f.pressure();
  assert.equal(f.policy.pending, false, 'within 10 s of the last attempt');
  f.time += 8000; f.rss -= 50 * MiB; f.pressure();
  assert.equal(f.policy.pending, false, 'less than 64 MiB regrowth since the trim');
  f.rss += 20 * MiB; f.pressure();
  assert.equal(f.policy.pending, true);
  f.time += 2000;
  assert.equal(f.policy.atBoundary(null).boundary, 'critical-pressure');
  assert.equal(f.trims, 2);
});

test('emergency deferrals do not read memory every frame', () => {
  const f = fixture(); let reads = 0; const sample = f.sample;
  f.available = 80 * MiB; f.pressure(); f.time += 2000;
  f.native.images.memory = () => ({ pendingDecodeJobs: f.jobs });
  const policy = createMemoryReclaimer({ native: f.native, readMemory: () => { reads++; return sample(); },
    readRss: () => f.rss, now: () => f.time, logger: { log() {}, warn() {} } });
  policy.observe(sample()); policy.observe(sample()); f.time += 2000; f.jobs = 1;
  for (let frame = 0; frame < 30; frame++) policy.atBoundary(null);
  assert.equal(reads, 1, 'active decodes restart the grace period');
  f.jobs = 0; f.time += 2000;
  assert.equal(policy.atBoundary(null).boundary, 'critical-pressure');
  f.available = 150 * MiB;
  assert.equal(f.trims, 1);
});

test('frame polling detects a fresh critical episode without waiting for diagnostics', () => {
  const { reclamationMemoryState } = require('../runner/diagnostics.cjs');
  const f = fixture(); f.available = 300 * MiB;
  const reads = [], attempts = [];
  const reader = { readFileSync(file) {
    if (file === '/proc/meminfo') { reads.push(f.time); return 'MemAvailable: ' + f.available / 1024 + ' kB\n'; }
    if (file === '/sys/fs/cgroup/memory.max') return 'max';
    throw Error('ENOENT');
  } };
  const memoryUsage = () => { throw Error('full process metrics must not be sampled'); };
  memoryUsage.rss = () => f.rss;
  const policy = createMemoryReclaimer({ native: f.native,
    readMemory: () => reclamationMemoryState({ reader, processObject: { memoryUsage },
      osObject: { totalmem: () => 1024 * MiB, freemem: () => 0 } }),
    readRss: () => f.rss, now: () => f.time, logger: { log() {}, warn(error) { assert.fail(error); } } });
  policy.poll();
  f.available = 80 * MiB; // Pressure begins immediately after a healthy sample.
  for (let timestamp = 125; timestamp <= 3000; timestamp += 125) {
    f.time = timestamp;
    const result = policy.atBoundary(null);
    if (result) attempts.push(timestamp);
    policy.poll(timestamp);
    policy.poll(timestamp); // Repeated frames cannot manufacture fresh observations.
  }
  assert.deepEqual(attempts, [2500]);
  assert.equal(f.trims, 1);
  assert.ok(reads.length <= 8, 'reads are bounded by the sample interval plus live validation');
});

test('live recovery cancels the old critical episode and renews the full grace period', () => {
  const f = fixture(); f.available = 80 * MiB; f.pressure();
  f.time = 2000; f.available = 250 * MiB;
  assert.equal(f.policy.atBoundary(null), null);
  f.time = 3000; f.available = 80 * MiB;
  f.policy.observe(f.sample());
  assert.equal(f.policy.pending, false, 'recovery resets the sustained-pressure sample count');
  f.time = 3500; f.policy.observe(f.sample());
  assert.equal(f.policy.atBoundary(null), null);
  f.time = 4999; assert.equal(f.policy.atBoundary(null), null);
  f.time = 5000; assert.equal(f.policy.atBoundary(null).boundary, 'critical-pressure');
  assert.equal(f.trims, 1);
});

test('sampler failures disable reclamation without aborting frames or retrying reads', () => {
  const f = fixture(); let reads = 0;
  const policy = createMemoryReclaimer({ native: f.native, now: () => f.time,
    readMemory() { reads++; throw Error('memory sampler unavailable'); },
    logger: { warn: message => f.warnings.push(message) } });
  policy.poll(0); policy.poll(10000);
  assert.equal(policy.atBoundary('scene-fade'), null);
  assert.equal(reads, 1);
  assert.equal(f.warnings.length, 1);
  assert.equal(policy.pending, false);
});
