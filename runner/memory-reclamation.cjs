'use strict';

const { MEMORY_PRESSURE_BYTES } = require('./diagnostics.cjs');
const { setImmediate } = require('node:timers');
const MiB = 1024 * 1024;
// Below this much available memory the kernel OOM killer is close (the supervisor's
// critical-memory-pressure threshold). Waiting for a scene fade is then riskier than a
// short trim during play: a long sequence without a scene change can allocate past the
// remaining headroom before the next fade arrives.
const CRITICAL_BYTES = 96 * MiB;
// Give a fade that is about to happen the chance to take the trim invisibly.
const CRITICAL_GRACE_MS = 2000;
const SAMPLE_INTERVAL_MS = 500;
// An emergency trim may come before the normal cooldown ends, but only after the
// process has grown again; trimming already decommitted space recovers nothing.
const CRITICAL_MIN_INTERVAL_MS = 10000;
const CRITICAL_REGROWTH_BYTES = 64 * MiB;

function createMemoryReclaimer({ native, readMemory, readRss, now, collectGarbage,
  settleFinalizers = () => new Promise(resolve => setImmediate(() => setImmediate(resolve))),
  logger = console }) {
  let disabled = typeof native.runtime.allocatorStats !== 'function' ||
    typeof native.runtime.trimAllocator !== 'function';
  let nextSampleAt = -Infinity;
  let lastSample, lowSamples = 0, episode = 0, attemptedEpisode = -1;
  let pending = false, startupDone = false, nextAttemptAt = 0, retryAfter = 0;
  let lastRss = 0, lastHeadroom = Infinity;
  let criticalSince = null, criticalPending = false, lastAttemptAt = -Infinity;
  let collecting = false;
  function resetPressure() {
    lowSamples = 0; pending = false; criticalPending = false; criticalSince = null;
  }
  return {
    poll(timestamp = now()) {
      if (disabled || collecting || timestamp < nextSampleAt) return;
      nextSampleAt = timestamp + SAMPLE_INTERVAL_MS;
      try { this.observe(readMemory()); }
      catch (error) {
        disabled = true; resetPressure();
        logger.warn('[pmjs] allocator-reclamation unavailable: ' + error.message);
      }
    },
    get pending() { return pending && !disabled && !collecting; },
    observe(memory) {
      if (disabled || collecting || !memory || memory === lastSample) return;
      lastSample = memory;
      if (!(memory.availableBytes < MEMORY_PRESSURE_BYTES)) {
        resetPressure(); return;
      }
      if (memory.availableBytes < CRITICAL_BYTES) { if (criticalSince === null) criticalSince = now(); }
      else criticalSince = null;
      if (++lowSamples === 2) episode++;
      if (lowSamples < 2) return;
      const regular = now() >= nextAttemptAt &&
        (episode !== attemptedEpisode && now() >= retryAfter || memory.rssBytes >= lastRss + 64 * MiB ||
          memory.availableBytes <= lastHeadroom - 32 * MiB);
      const critical = criticalSince !== null && now() >= lastAttemptAt + CRITICAL_MIN_INTERVAL_MS &&
        memory.rssBytes >= lastRss + CRITICAL_REGROWTH_BYTES;
      if (regular || critical) { pending = true; criticalPending = !regular; }
    },
    // boundary is 'startup', 'scene-fade', or null/other while the game is playing.
    // Without a fade, only sustained critical pressure trims (logged as 'critical-pressure').
    atBoundary(boundary) {
      if (disabled || collecting) return null;
      const startup = boundary === 'startup';
      const emergency = !startup && boundary !== 'scene-fade';
      if (startup ? startupDone : !pending) return null;
      if (now() < nextAttemptAt && !criticalPending) return null;
      if (emergency && (criticalSince === null || now() - criticalSince < CRITICAL_GRACE_MS)) return null;
      if (startup) startupDone = true;
      try {
        const before = readMemory();
        if (!startup && !(before.availableBytes < MEMORY_PRESSURE_BYTES)) {
          resetPressure(); return null;
        }
        // Emergency deferrals wait for the next sample or grace period instead of
        // re-reading memory on every frame.
        if (emergency && !(before.availableBytes < CRITICAL_BYTES)) { criticalSince = null; return null; }
        if (native.images.memory(0).pendingDecodeJobs !== 0) {
          if (emergency) criticalSince = now();
          return null;
        }
        if (!native.runtime.allocatorStats()) { disabled = true; return null; }
        pending = false;
        criticalPending = false;
        criticalSince = null;
        attemptedEpisode = episode;
        lastRss = before.rssBytes;
        lastHeadroom = before.availableBytes;
        lastAttemptAt = now();
        nextAttemptAt = now() + 60000;
        retryAfter = nextAttemptAt;
        const started = now();
        const finish = gcMs => {
          const allocator = native.runtime.allocatorStats();
          if (!allocator) { disabled = true; return null; }
          const released = allocator.freeArenaBytes >= 32 * MiB ? native.runtime.trimAllocator() : false;
          if (released === undefined) { disabled = true; return null; }
          if (!collectGarbage && allocator.freeArenaBytes < 32 * MiB) return null;
          lastRss = readRss();
          const recoveredBytes = Math.max(0, before.rssBytes - lastRss);
          if (recoveredBytes < 8 * MiB) retryAfter = now() + 300000;
          const result = { boundary: emergency ? 'critical-pressure' : boundary,
            durationMs: now() - started, gcMs, released,
            recoveredBytes, beforeRssBytes: before.rssBytes, afterRssBytes: lastRss,
            availableBytes: before.availableBytes };
          logger.log('[pmjs] allocator-reclamation ' + JSON.stringify(result));
          return result;
        };
        if (!collectGarbage) return finish(0);
        collecting = true;
        return Promise.resolve().then(() => {
          const gcStarted = now();
          collectGarbage();
          return now() - gcStarted;
        }).then(async gcMs => {
          // Native resource finalizers run after collection, before allocator trimming.
          await settleFinalizers();
          return finish(gcMs);
        }).catch(error => {
          disabled = true;
          logger.warn('[pmjs] allocator-reclamation unavailable: ' + error.message);
          return null;
        }).finally(() => { collecting = false; });
      } catch (error) {
        disabled = true;
        pending = false;
        criticalPending = false;
        logger.warn('[pmjs] allocator-reclamation unavailable: ' + error.message);
        return null;
      }
    }
  };
}

module.exports = { createMemoryReclaimer };
