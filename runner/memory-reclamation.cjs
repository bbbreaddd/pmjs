'use strict';

const { MEMORY_PRESSURE_BYTES } = require('./diagnostics.cjs');
const MiB = 1024 * 1024;

function createMemoryReclaimer({ native, readMemory, readRss, now, logger = console }) {
  let disabled = typeof native.runtime.allocatorStats !== 'function' ||
    typeof native.runtime.trimAllocator !== 'function';
  let lastSample, lowSamples = 0, episode = 0, attemptedEpisode = -1;
  let pending = false, startupDone = false, nextAttemptAt = 0, retryAfter = 0;
  let lastRss = 0, lastHeadroom = Infinity;
  return {
    get pending() { return pending && !disabled; },
    observe(memory) {
      if (disabled || !memory || memory === lastSample) return;
      lastSample = memory;
      if (!(memory.availableBytes < MEMORY_PRESSURE_BYTES)) { lowSamples = 0; pending = false; return; }
      if (++lowSamples === 2) episode++;
      if (lowSamples >= 2 && now() >= nextAttemptAt &&
          (episode !== attemptedEpisode && now() >= retryAfter || memory.rssBytes >= lastRss + 64 * MiB ||
            memory.availableBytes <= lastHeadroom - 32 * MiB)) pending = true;
    },
    atBoundary(boundary) {
      if (disabled || (boundary !== 'startup' && boundary !== 'scene-fade') || now() < nextAttemptAt) return null;
      const startup = boundary === 'startup';
      if (startup ? startupDone : !pending) return null;
      if (startup) startupDone = true;
      try {
        const before = readMemory();
        if (!startup && !(before.availableBytes < MEMORY_PRESSURE_BYTES)) { pending = false; return null; }
        if (native.images.memory(0).pendingDecodeJobs !== 0) return null;
        const allocator = native.runtime.allocatorStats();
        if (!allocator) { disabled = true; return null; }
        pending = false;
        attemptedEpisode = episode;
        lastRss = before.rssBytes;
        lastHeadroom = before.availableBytes;
        nextAttemptAt = now() + 60000;
        retryAfter = nextAttemptAt;
        if (allocator.freeArenaBytes < 32 * MiB) return null;
        const started = now();
        const released = native.runtime.trimAllocator();
        if (released === undefined) { disabled = true; return null; }
        const durationMs = now() - started;
        lastRss = readRss();
        const recoveredBytes = Math.max(0, before.rssBytes - lastRss);
        if (recoveredBytes < 8 * MiB) retryAfter = now() + 300000;
        const result = { boundary, durationMs, released, recoveredBytes,
          beforeRssBytes: before.rssBytes, afterRssBytes: lastRss };
        logger.log('[pmjs] allocator-reclamation ' + JSON.stringify(result));
        return result;
      } catch (error) {
        disabled = true;
        pending = false;
        logger.warn('[pmjs] allocator-reclamation unavailable: ' + error.message);
        return null;
      }
    }
  };
}

module.exports = { createMemoryReclaimer };
