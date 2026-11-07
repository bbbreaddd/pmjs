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

function createMemoryReclaimer({ native, readMemory, now, collectGarbage,
  settleFinalizers = () => new Promise(resolve => setImmediate(() => setImmediate(resolve))),
  logger = console }) {
  let disabled = !collectGarbage && (typeof native.runtime.allocatorStats !== 'function' ||
    typeof native.runtime.trimAllocator !== 'function');
  let nextSampleAt = -Infinity;
  let lastSample, lowSamples = 0, episode = 0, attemptedEpisode = -1;
  let pending = false, startupDone = false, nextAttemptAt = 0, retryAfter = 0;
  let lastFootprint = 0, lastHeadroom = Infinity, nextDecodeCheckAt = 0;
  let criticalSince = null, criticalPending = false, lastAttemptAt = -Infinity;
  let collecting = false;
  function resetPressure() {
    lowSamples = 0; pending = false; criticalPending = false; criticalSince = null;
    nextDecodeCheckAt = 0;
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
      const grew = memory.rssBytes + (memory.swapBytes || 0) >= lastFootprint + CRITICAL_REGROWTH_BYTES;
      const worsening = memory.availableBytes <= lastHeadroom - 32 * MiB;
      const regular = now() >= nextAttemptAt &&
        (episode !== attemptedEpisode && now() >= retryAfter || grew || worsening);
      const critical = criticalSince !== null && now() >= lastAttemptAt + CRITICAL_MIN_INTERVAL_MS &&
        (grew || worsening);
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
      if (now() < nextDecodeCheckAt) return null;
      const criticalReady = criticalSince !== null && now() - criticalSince >= CRITICAL_GRACE_MS;
      if (emergency && !criticalReady) return null;
      try {
        const before = readMemory();
        if (!startup && !(before.availableBytes < MEMORY_PRESSURE_BYTES)) {
          resetPressure(); return null;
        }
        // Emergency deferrals wait for the next sample or grace period instead of
        // re-reading memory on every frame.
        if (emergency && !(before.availableBytes < CRITICAL_BYTES)) { criticalSince = null; return null; }
        const collectDuringDecode = Boolean(collectGarbage) && criticalReady && before.availableBytes < CRITICAL_BYTES;
        if (native.images.memory(0).pendingDecodeJobs !== 0 && !collectDuringDecode) {
          nextDecodeCheckAt = now() + SAMPLE_INTERVAL_MS;
          return null;
        }
        if (!native.runtime.allocatorStats?.() && !collectGarbage) { disabled = true; return null; }
        if (startup) startupDone = true;
        pending = false;
        criticalPending = false;
        criticalSince = null;
        attemptedEpisode = episode;
        lastFootprint = before.rssBytes + (before.swapBytes || 0);
        const beforeFootprint = lastFootprint;
        lastHeadroom = before.availableBytes;
        lastAttemptAt = now();
        nextAttemptAt = now() + 60000;
        retryAfter = nextAttemptAt;
        const started = now();
        const finish = gcMs => {
          const allocator = native.runtime.allocatorStats?.();
          if (!allocator && !collectGarbage) { disabled = true; return null; }
          let released = allocator?.freeArenaBytes >= 32 * MiB ? native.runtime.trimAllocator?.() : false;
          if (released === undefined) {
            if (!collectGarbage) { disabled = true; return null; }
            released = false;
          }
          if (!collectGarbage && allocator.freeArenaBytes < 32 * MiB) return null;
          const after = readMemory();
          lastFootprint = after.rssBytes + (after.swapBytes || 0);
          lastHeadroom = after.availableBytes;
          const recoveredBytes = Math.max(0, before.rssBytes - after.rssBytes);
          const recoveredFootprintBytes = Math.max(0, beforeFootprint - lastFootprint);
          if (Math.max(recoveredBytes, recoveredFootprintBytes) < 8 * MiB) retryAfter = now() + 300000;
          const result = { boundary: emergency ? 'critical-pressure' : boundary,
            durationMs: now() - started, gcMs, released,
            recoveredBytes, recoveredFootprintBytes,
            beforeRssBytes: before.rssBytes, afterRssBytes: after.rssBytes,
            beforeSwapBytes: before.swapBytes || 0, afterSwapBytes: after.swapBytes || 0,
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
