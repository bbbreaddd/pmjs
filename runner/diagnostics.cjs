'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const v8 = require('node:v8');
const { performance } = require('node:perf_hooks');
const HOST_PROCESS = process;
const HOST_CONSOLE = console;
const hostCpuUsage = process.cpuUsage.bind(process);

function cpuState() {
  const usage = hostCpuUsage();
  let mainUs = null;
  try {
    const runNs = Number(fs.readFileSync('/proc/self/schedstat', 'utf8').trim().split(/\s+/)[0]);
    if (Number.isFinite(runNs) && runNs > 0) mainUs = runNs / 1000;
  } catch (_) {}
  return { totalUs: usage.user + usage.system, mainUs };
}

const MiB = 1024 * 1024;
const MEMORY_PRESSURE_BYTES = 180 * MiB;
// Resolve the active cgroup v2 if the mount exposes multiple descendants.
// In container/cgroup namespaces /sys/fs/cgroup may already be the delegated
// root, in which case the fallback is the correct location.
function readCgroupFile(name, reader = fs) {
  let relative = '';
  try {
    const match = /^0::(.*)$/m.exec(reader.readFileSync('/proc/self/cgroup', 'utf8'));
    if (match) relative = match[1].replace(/^\/+/, '');
  } catch (_) {}
  const candidates = relative ? [path.posix.join('/sys/fs/cgroup', relative, name),
    '/sys/fs/cgroup/' + name] : ['/sys/fs/cgroup/' + name];
  for (const candidate of candidates) {
    try { return reader.readFileSync(candidate, 'utf8'); } catch (_) {}
  }
  return null;
}
function numericFile(file, reader = fs) {
  try {
    const value = reader.readFileSync(file, 'utf8').trim();
    if (/^\d+$/.test(value)) {
      const number = Number(value);
      return Number.isSafeInteger(number) ? number : null;
    }
  } catch (_) {}
  return null;
}
function memAvailable(reader = fs) {
  try {
    const text = reader.readFileSync('/proc/meminfo', 'utf8');
    const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(text);
    if (match) return Number(match[1]) * 1024;
  } catch (_) {}
  return null;
}
function hostMemoryDetails(reader = fs) {
  const fields = {
    MemFree: 'freeBytes', Buffers: 'buffersBytes', Cached: 'cachedBytes',
    Active: 'activeBytes', Inactive: 'inactiveBytes',
    'Active(anon)': 'activeAnonBytes', 'Inactive(anon)': 'inactiveAnonBytes',
    'Active(file)': 'activeFileBytes', 'Inactive(file)': 'inactiveFileBytes',
    AnonPages: 'anonBytes', Mapped: 'mappedBytes', Shmem: 'sharedMemoryBytes',
    Slab: 'slabBytes', SReclaimable: 'reclaimableSlabBytes',
    SUnreclaim: 'unreclaimableSlabBytes', SwapTotal: 'swapTotalBytes',
    SwapFree: 'swapFreeBytes', CmaTotal: 'contiguousMemoryBytes',
    CmaFree: 'contiguousMemoryFreeBytes'
  };
  try {
    const text = reader.readFileSync('/proc/meminfo', 'utf8');
    const result = {};
    for (const match of text.matchAll(/^([^:]+):\s+(\d+)\s+kB$/gm)) {
      const key = fields[match[1]];
      if (key) result[key] = Number(match[2]) * 1024;
    }
    return Object.keys(result).length ? result : null;
  } catch (_) { return null; }
}
const PROCESS_STATUS_FIELDS = Object.freeze({
  RssAnon: 'anonymousRssBytes', RssFile: 'fileRssBytes',
  VmRSS: 'rssBytes', RssShmem: 'sharedRssBytes', VmData: 'dataVirtualBytes', VmSwap: 'swapBytes'
});
function parseProcessStatus(text) {
  const result = {};
  const name = /^Name:\s+(.+)$/m.exec(text);
  if (name) result.name = name[1];
  for (const match of text.matchAll(/^([^:\s]+):\s+(\d+)\s+kB$/gm)) {
    const key = PROCESS_STATUS_FIELDS[match[1]];
    if (key) result[key] = Number(match[2]) * 1024;
  }
  return result;
}
function processMemoryDetails(pid, reader = fs) {
  if (!Number.isInteger(pid)) return null;
  try {
    const text = reader.readFileSync('/proc/' + pid + '/status', 'utf8');
    const { name, ...result } = parseProcessStatus(text);
    return Object.keys(result).length ? result : null;
  } catch (_) { return null; }
}
function processMappingDetails(pid, reader = fs, largestLimit = 8) {
  if (!Number.isInteger(pid)) return null;
  try {
    const text = reader.readFileSync('/proc/' + pid + '/smaps', 'utf8');
    const totals = { mappingCount: 0, rssBytes: 0, anonymousBytes: 0, swapBytes: 0 };
    const anonymousByKind = { processHeapBytes: 0, threadStackBytes: 0,
      namedAnonymousBytes: 0, unnamedMappingBytes: 0, fileMappingBytes: 0,
      otherNamedMappingBytes: 0 };
    const mappings = [];
    let current = null;
    const finish = () => {
      if (!current) return;
      totals.mappingCount++;
      totals.rssBytes += current.rssBytes;
      totals.anonymousBytes += current.anonymousBytes;
      totals.swapBytes += current.swapBytes;
      if (current.anonymousBytes > 0) {
        const name = current.name;
        if (name === '[heap]') anonymousByKind.processHeapBytes += current.anonymousBytes;
        else if (/^\[stack(?::|\])/.test(name)) anonymousByKind.threadStackBytes += current.anonymousBytes;
        else if (/^\[anon(?:_shmem)?:/.test(name)) anonymousByKind.namedAnonymousBytes += current.anonymousBytes;
        else if (!name) anonymousByKind.unnamedMappingBytes += current.anonymousBytes;
        else if (name[0] === '/') anonymousByKind.fileMappingBytes += current.anonymousBytes;
        else anonymousByKind.otherNamedMappingBytes += current.anonymousBytes;
        mappings.push(current);
      }
    };
    for (const line of text.split('\n')) {
      const header = /^([\da-f]+)-([\da-f]+)\s+\S+\s+\S+\s+\S+\s+\d+\s*(.*)$/.exec(line);
      if (header) {
        finish();
        current = { range: header[1] + '-' + header[2], name: header[3].trim(),
          sizeBytes: 0, rssBytes: 0, anonymousBytes: 0, privateDirtyBytes: 0, swapBytes: 0 };
        continue;
      }
      if (!current) continue;
      const field = /^(Size|Rss|Anonymous|Private_Dirty|Swap):\s+(\d+)\s+kB$/.exec(line);
      if (!field) continue;
      const value = Number(field[2]) * 1024;
      if (field[1] === 'Size') current.sizeBytes = value;
      else if (field[1] === 'Rss') current.rssBytes = value;
      else if (field[1] === 'Anonymous') current.anonymousBytes = value;
      else if (field[1] === 'Private_Dirty') current.privateDirtyBytes = value;
      else current.swapBytes = value;
    }
    finish();
    mappings.sort((a, b) => b.anonymousBytes - a.anonymousBytes);
    return { ...totals, anonymousByKind,
      largestAnonymousMappings: mappings.slice(0, Math.max(0, largestLimit)).map(mapping => ({
        range: mapping.range, name: mapping.name || '[unnamed]', sizeBytes: mapping.sizeBytes,
        rssBytes: mapping.rssBytes, anonymousBytes: mapping.anonymousBytes,
        privateDirtyBytes: mapping.privateDirtyBytes, swapBytes: mapping.swapBytes
      })) };
  } catch (_) { return null; }
}
function v8HeapDetails(v8Object = v8) {
  try {
    const statistics = v8Object.getHeapStatistics();
    const spaces = v8Object.getHeapSpaceStatistics().map(space => ({
      name: space.space_name,
      sizeBytes: space.space_size,
      usedBytes: space.space_used_size,
      availableBytes: space.space_available_size,
      physicalBytes: space.physical_space_size
    }));
    return {
      heapLimitBytes: statistics.heap_size_limit,
      mallocedBytes: statistics.malloced_memory,
      peakMallocedBytes: statistics.peak_malloced_memory,
      nativeContexts: statistics.number_of_native_contexts,
      detachedContexts: statistics.number_of_detached_contexts,
      spaces
    };
  } catch (_) { return null; }
}
function memoryPressure(reader = fs) {
  let text;
  text = readCgroupFile('memory.pressure', reader);
  if (!text) { try { text = reader.readFileSync('/proc/pressure/memory', 'utf8'); } catch (_) {} }
  if (!text) return null;
  const result = {};
  for (const match of text.matchAll(/^(some|full)\s+avg10=([\d.]+)/gm)) {
    const value = Number(match[2]);
    if (Number.isFinite(value)) result[match[1] + 'Avg10'] = value;
  }
  return Object.keys(result).length ? result : null;
}
function memoryEvents(reader = fs) {
  try {
    const text = readCgroupFile('memory.events.local', reader) ||
      readCgroupFile('memory.events', reader);
    if (!text) return null;
    const result = {};
    for (const match of text.matchAll(/^(low|high|max|oom|oom_kill)\s+(\d+)$/gm))
      result[match[1]] = Number(match[2]);
    return result;
  } catch (_) { return null; }
}
function memoryState({ reader = fs, processObject = HOST_PROCESS, osObject = os, detailed = false } = {}) {
  const usage = processObject.memoryUsage();
  const total = osObject.totalmem();
  const hostAvailable = memAvailable(reader) ?? osObject.freemem();
  const limitText = readCgroupFile('memory.max', reader);
  const usageText = readCgroupFile('memory.current', reader);
  let cgroupLimit = limitText && /^\d+$/.test(limitText.trim()) ? Number(limitText.trim()) : null;
  let cgroupUsed = usageText && /^\d+$/.test(usageText.trim()) ? Number(usageText.trim()) : null;
  // cgroup v1 fallback. Unbounded limits are excluded below.
  if (cgroupLimit === null) {
    cgroupLimit = numericFile('/sys/fs/cgroup/memory/memory.limit_in_bytes', reader);
    cgroupUsed = numericFile('/sys/fs/cgroup/memory/memory.usage_in_bytes', reader);
  }
  const bounded = Number.isFinite(cgroupLimit) && cgroupLimit > 0 && cgroupLimit <= total;
  const limitBytes = bounded ? cgroupLimit : total;
  // memory.current includes reclaimable cache. This is deliberately a lower bound on
  // actual headroom, not an estimate of how many bytes an allocation can obtain.
  const cgroupHeadroom = bounded && cgroupUsed !== null ?
    Math.max(0, cgroupLimit - cgroupUsed) : null;
  const availableBytes = Math.max(0, Math.min(hostAvailable,
    cgroupHeadroom === null ? Infinity : cgroupHeadroom));
  return {
    rssBytes: usage.rss, heapUsedBytes: usage.heapUsed, heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external, arrayBufferBytes: usage.arrayBuffers,
    v8Heap: detailed ? v8HeapDetails() : undefined,
    process: processMemoryDetails(processObject.pid, reader),
    host: detailed ? hostMemoryDetails(reader) : undefined,
    totalBytes: limitBytes, availableBytes, hostAvailableBytes: hostAvailable,
    cgroupLimitBytes: bounded ? cgroupLimit : null,
    cgroupUsedBytes: bounded ? cgroupUsed : null,
    cgroupEvents: memoryEvents(reader), pressure: memoryPressure(reader)
  };
}
function own(obj, property) {
  try {
    if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(obj, property);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined;
  } catch (_) { return undefined; }
}
function bounded(value) {
  if (typeof value === 'string') return value.slice(0, 160).replace(/[\r\n\t]/g, ' ');
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function gameContext(root = globalThis) {
  // Read data fields only. Calling plugin-patched getters/methods while reporting
  // another fault can mutate interpreter state or raise a second exception.
  const map = own(root, '$gameMap');
  const dataMap = own(root, '$dataMap');
  const mapId = own(map, '_mapId');
  const mapInfos = own(root, '$dataMapInfos');
  const mapInfo = own(mapInfos, String(mapId));
  const mapName = own(dataMap, 'displayName') || own(mapInfo, 'name');
  const player = own(root, '$gamePlayer');
  const manager = own(root, 'SceneManager');
  const scene = own(manager, '_scene');
  const rootInterpreter = own(map, '_interpreter');
  let interpreter = rootInterpreter, depth = 0;
  for (let i = 0; i < 8; i++) {
    const child = own(interpreter, '_childInterpreter');
    if (!child) break;
    interpreter = child;
    depth++;
  }
  const index = own(interpreter, '_index');
  const command = own(own(interpreter, '_list'), String(index));
  const sceneClass = scene && own(scene, 'constructor');
  let proto;
  try { proto = scene && Object.getPrototypeOf(scene); } catch (_) {}
  const prototypeConstructor = own(proto, 'constructor');
  const name = own(sceneClass, 'name') || own(prototypeConstructor, 'name');
  return {
    mapId: bounded(mapId),
    mapName: bounded(mapName),
    scene: bounded(name),
    x: bounded(own(player, '_x')), y: bounded(own(player, '_y')),
    eventId: bounded(own(interpreter, '_eventId')),
    commandIndex: bounded(index), commandCode: bounded(own(command, 'code')),
    interpreterDepth: depth,
    waitMode: bounded(own(interpreter, '_waitMode')),
    frameCount: bounded(own(own(root, 'Graphics'), 'frameCount'))
  };
}
function compactLocation(context) {
  return { mapId: context.mapId, mapName: context.mapName, scene: context.scene,
    x: context.x, y: context.y, frameCount: context.frameCount };
}
function createDiagnostics({ logger = console, getNative = () => null,
  getGlobals = () => globalThis, now = () => performance.now(),
  readMemory = options => memoryState(options), readCpu = cpuState, timers = require('node:timers'),
  intervalMs = 10000, slowFrameMs = 180,
  heartbeatMs = 10000, slowRepeatMs = 60000, onHeartbeat = () => {} } = {}) {
  let stage = 'starting', handle = null;
  let count = 0, sum = 0, maxSlowFrame = 0, slowCount = 0, windowStart = now();
  let lastMemory = null, lastMemoryAt = -Infinity, lastContext = {}, lastLocation = null;
  let lastCompletedFrameAt = -Infinity;
  const memoryHistory = [];
  let lastLocationCheckAt = -Infinity, lastHeartbeatAt = now();
  let previousCpu = null, backgroundBusyMs = 0, lastCpuWarningAt = -Infinity;
  // Resource enumeration and renderer/audio summaries are reserved for rare
  // memory warnings. They must remain optional if native diagnostics fail.
  function optionalNative({ includeLargestImages = false } = {}) {
    const native = getNative();
    if (!native) return undefined;
    const extra = {};
    try { if (native.runtime?.allocatorStats) extra.allocator = native.runtime.allocatorStats(); } catch (_) {}
    try { if (native.images?.memory) {
      const info = native.images.memory(includeLargestImages ? 5 : 0);
      extra.images = { liveCount: info.liveCount, gpuBytes: info.gpuBytes,
        peakGpuBytes: info.peakGpuBytes, cpuBytes: info.cpuBytes,
        tileMetadataBytes: info.tileMetadataBytes, warmBytes: info.warmBytes,
        pinnedBytes: info.pinnedBytes, pendingDecodeJobs: info.pendingDecodeJobs,
        preparedFrameCacheBytes: info.preparedFrameCacheBytes,
        preparedFrameResidentBytes: info.preparedFrameResidentBytes };
      if (includeLargestImages) extra.images.largest = Array.isArray(info.largest) ? info.largest.slice(0, 5).map(image => ({
          path: image.path, width: image.width, height: image.height,
          gpuBytes: image.gpuBytes, cpuBytes: image.cpuBytes,
          references: image.references, pins: image.pins
        })) : undefined;
    } } catch (_) {}
    try { if (native.canvas?.memory) extra.canvas = native.canvas.memory(); } catch (_) {}
    try { if (native.media?.audioStats) {
      const info = native.media.audioStats();
      extra.audio = { livePcmBytes: info.livePcmBytes, cacheBytes: info.cacheBytes,
        cacheEntries: info.entries, sampleVoices: info.sampleVoices,
        streamVoices: info.streamVoices,
        streamBufferedPcmBytes: info.streamBufferedBytes };
    } } catch (_) {}
    try { if (native.render?.stats) {
      const info = native.render.stats();
      extra.renderer = { rendererTargetBytes: info.rendererTargetBytes,
        rendererTargetCacheBytes: info.rendererTargetCacheBytes,
        tileGeometryGpuBytes: info.tileGeometryGpuBytes,
        tileGeometryCpuBytes: info.tileGeometryCpuBytes };
    } } catch (_) {}
    const hasNativeDetails = Object.keys(extra).length > 0;
    if (!hasNativeDetails) return undefined;
    return Object.keys(extra).length ? extra : undefined;
  }
  function emit(reason, details = {}, memory = null, level = 'warn') {
    try {
      const context = gameContext(getGlobals());
      lastContext = context;
      const message = { reason, stage, uptimeMs: Math.round(now() - windowOrigin),
        context: reason === 'game-location' || reason === 'map-transition' ||
          reason === 'scene-transition' ? compactLocation(context) : context, ...details };
      if (memory) {
        message.memory = memory;
        message.gameMemory = {
          v8HeapUsedBytes: memory.heapUsedBytes,
          v8HeapTotalBytes: memory.heapTotalBytes,
          v8HeapLimitBytes: memory.v8Heap && memory.v8Heap.heapLimitBytes,
          v8ExternalBytes: memory.externalBytes,
          nodeArrayBufferBytes: memory.arrayBufferBytes,
          processAnonymousRssBytes: memory.process && memory.process.anonymousRssBytes
        };
      }
      const line = '[pmjs] diagnostic ' + JSON.stringify(message);
      if (logger === HOST_CONSOLE) {
        // Avoid calling guest/plugin-patched console methods from monitoring.
        // This goes to the supervisor's pipe without invoking game JavaScript.
        const severity = level === 'error' ? 'ERROR' : level === 'warn' ? 'WARN' : 'INFO';
        fs.writeSync(2, new Date().toISOString() + ' ' + severity + ' ' + line + '\n');
      } else {
        (logger[level] || logger.warn).call(logger, line);
      }
    } catch (_) {
      // Keep a small signal available if allocating the detailed report itself
      // fails during memory exhaustion.
      if (memory && level === 'warn' && logger === HOST_CONSOLE) {
        try {
          fs.writeSync(2, new Date().toISOString() + ' WARN [pmjs] diagnostic ' +
            'reason=' + reason + ' details=unavailable rssBytes=' + memory.rssBytes +
            ' heapUsedBytes=' + memory.heapUsedBytes +
            ' availableBytes=' + memory.availableBytes + '\n');
        } catch (_) {}
      }
    }
  }
  const windowOrigin = now();
  function sampleLocation(context, timestamp) {
    if (timestamp - lastLocationCheckAt < 1000) return;
    lastLocationCheckAt = timestamp;
    const next = compactLocation(context);
    if (!next || (next.mapId == null && next.scene == null)) return;
    if (!lastLocation) {
      lastLocation = next;
      emit('game-location', { to: next }, null, 'info');
      return;
    }
    const mapChanged = next.mapId != null && next.mapId !== lastLocation.mapId;
    const sceneChanged = next.scene != null && next.scene !== lastLocation.scene;
    if (mapChanged || sceneChanged) {
      emit(mapChanged ? 'map-transition' : 'scene-transition',
        { from: lastLocation, to: next }, null, 'info');
    }
    lastLocation = next;
  }
  function sendHeartbeat() {
    try {
      const timestamp = now();
      if (heartbeatMs <= 0 || timestamp - lastHeartbeatAt < heartbeatMs) return;
      lastHeartbeatAt = timestamp;
      onHeartbeat({ at: Date.now(), mapId: lastContext.mapId,
        scene: lastContext.scene, frameCount: lastContext.frameCount,
        lastCompletedFrameAgeMs: Number.isFinite(lastCompletedFrameAt) ?
          Math.max(0, timestamp - lastCompletedFrameAt) : null });
    } catch (_) {}
  }
  function sample() {
    try {
      let memory = readMemory();
      lastMemory = memory;
      lastContext = gameContext(getGlobals());
      const timestamp = now();
      lastMemoryAt = timestamp;
      memoryHistory.push({ at: timestamp, availableBytes: memory.availableBytes,
        rssBytes: memory.rssBytes, heapUsedBytes: memory.heapUsedBytes,
        externalBytes: memory.externalBytes, cgroupEvents: memory.cgroupEvents });
      if (memoryHistory.length > 8) memoryHistory.shift();
      sampleLocation(lastContext, timestamp);
      const cpu = readCpu();
      if (previousCpu && timestamp - previousCpu.at >= 1000) {
        const elapsedMs = timestamp - previousCpu.at;
        const totalDelta = cpu.totalUs - previousCpu.totalUs;
        const mainDelta = cpu.mainUs !== null && previousCpu.mainUs !== null ?
          cpu.mainUs - previousCpu.mainUs : null;
        if (Number.isFinite(totalDelta) && totalDelta >= 0) {
          const totalPercent = totalDelta / (elapsedMs * 10);
          const mainPercent = mainDelta !== null && mainDelta >= 0 ? mainDelta / (elapsedMs * 10) : null;
          const backgroundPercent = mainPercent !== null ? Math.max(0, totalPercent - mainPercent) : null;
          const details = { intervalMs: Math.round(elapsedMs),
            totalPercent: Math.round(totalPercent),
            mainPercent: mainPercent === null ? null : Math.round(mainPercent),
            backgroundPercent: backgroundPercent === null ? null : Math.round(backgroundPercent) };
          emit('cpu-usage', details, null, 'info');
          backgroundBusyMs = backgroundPercent >= 100 ? backgroundBusyMs + elapsedMs : 0;
          if (backgroundBusyMs >= 20000 && timestamp - lastCpuWarningAt >= 60000) {
            lastCpuWarningAt = timestamp;
            emit('background-cpu-pressure', { ...details, sustainedMs: Math.round(backgroundBusyMs),
              attribution: 'unknown' }, null);
          }
        } else backgroundBusyMs = 0;
      }
      previousCpu = { ...cpu, at: timestamp };
      if (timestamp - windowStart >= slowRepeatMs) {
        if (slowCount > 0) {
          emit('slow-frame-summary', { sampledFrames: count, slowFrames: slowCount,
            maxSampledFrameMs: Math.round(maxSlowFrame * 10) / 10,
            meanFrameWallMs: count ? Math.round(sum / count * 10) / 10 : undefined }, null);
        }
        count = 0; sum = 0; slowCount = 0; maxSlowFrame = 0; windowStart = timestamp;
      }
    } catch (_) {
    } finally {
      sendHeartbeat();
    }
  }
  function supervisorMemorySnapshot(request = {}) {
    const timestamp = now();
    const sampledMemory = readMemory({ detailed: true });
    lastMemory = sampledMemory;
    lastMemoryAt = timestamp;
    lastContext = gameContext(getGlobals());
    memoryHistory.push({ at: timestamp, availableBytes: sampledMemory.availableBytes,
      rssBytes: sampledMemory.rssBytes, heapUsedBytes: sampledMemory.heapUsedBytes,
      externalBytes: sampledMemory.externalBytes, cgroupEvents: sampledMemory.cgroupEvents });
    if (memoryHistory.length > 8) memoryHistory.shift();
    const memory = {
      heapUsedBytes: sampledMemory.heapUsedBytes,
      heapTotalBytes: sampledMemory.heapTotalBytes,
      externalBytes: sampledMemory.externalBytes,
      arrayBufferBytes: sampledMemory.arrayBufferBytes,
      v8Heap: sampledMemory.v8Heap
    };
    return {
      capturedAt: new Date().toISOString(),
      reason: request.reason || 'supervisor-request',
      context: lastContext,
      memory,
      native: optionalNative({ includeLargestImages: request.critical === true })
    };
  }
  // Call from a sampled completion only; the caller has already taken a clock
  // reading, so don't take another one on the rendering path.
  function observeFrame(frameMs, sampledAtMs) {
    if (!Number.isFinite(frameMs) || frameMs < 0) return;
    const t = sampledAtMs === undefined ? now() : sampledAtMs;
    lastCompletedFrameAt = t;
    count++;
    sum += frameMs;
    if (frameMs >= slowFrameMs) { slowCount++; maxSlowFrame = Math.max(maxSlowFrame, frameMs); }
  }
  return {
    start() { if (handle) return; sample(); handle = timers.setInterval(sample, intervalMs);
      if (typeof handle.unref === 'function') handle.unref(); },
    stop() { if (handle) { timers.clearInterval(handle); handle = null; } },
    stage(value) { stage = String(value); },
    observeFrame,
    supervisorMemorySnapshot,
    report(reason, error) {
      let description;
      try { description = error && (error.stack || error.message || String(error)); }
      catch (_) { description = 'error details unavailable'; }
      const memoryAgeMs = Number.isFinite(lastMemoryAt) ? Math.max(0, now() - lastMemoryAt) : null;
      emit(reason, { error: typeof description === 'string' ? description.slice(0, 4096) : undefined,
        lastMemoryAgeMs: memoryAgeMs, lastMemory: lastMemory ? {
          rssBytes: lastMemory.rssBytes, heapUsedBytes: lastMemory.heapUsedBytes,
          heapTotalBytes: lastMemory.heapTotalBytes, externalBytes: lastMemory.externalBytes,
          arrayBufferBytes: lastMemory.arrayBufferBytes, availableBytes: lastMemory.availableBytes,
          hostAvailableBytes: lastMemory.hostAvailableBytes,
          process: lastMemory.process, cgroupEvents: lastMemory.cgroupEvents
        } : null, recentMemorySamples: memoryHistory.slice(-4) }, null, 'error');
    },
    sample,
    snapshot() { return { stage, memory: lastMemory, context: lastContext }; }
  };
}

module.exports = { MEMORY_PRESSURE_BYTES, readCgroupFile, numericFile, memAvailable, memoryEvents, memoryPressure,
  parseProcessStatus, processMappingDetails, memoryState, gameContext, createDiagnostics };
