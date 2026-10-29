'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { MEMORY_PRESSURE_BYTES, processMappingDetails, parseProcessStatus } = require('./diagnostics.cjs');

const terminalStates = new WeakMap();
function terminalState(stream) {
  let state = terminalStates.get(stream);
  if (state) return state;
  state = { failed: stream.destroyed || stream.writableEnded, listeners: new Set() };
  const unavailable = state.fail = error => {
    if (state.failed) return;
    state.failed = true;
    for (const listener of state.listeners) listener(error);
  };
  // Standard streams outlive sessions; late write errors must remain handled
  // after a worker exits, without adding another handler on every reload.
  stream.on('error', unavailable);
  stream.once('close', unavailable);
  terminalStates.set(stream, state);
  return state;
}

// All persistent output belongs to this process, not the game event loop.
// Retain the first 128 KiB and the newest output within each 2 MiB file.
const RETAIN_LOGS = 4;
const LOG_LIMIT_BYTES = 2 * 1024 * 1024;
const PREFIX_BYTES = 128 * 1024;
const WINDOW_MS = 10_000;
const STREAM_BUDGET_BYTES = Object.freeze({ stdout: 64 * 1024, stderr: 128 * 1024 });
const STDERR_TAIL_BYTES = 32 * 1024;
const MONITOR_INTERVAL_MS = 10_000;
const STARTUP_HEARTBEAT_TIMEOUT_MS = 60_000;
const GAME_HANG_TIMEOUT_MS = 30_000;
const MEMORY_SNAPSHOT_COOLDOWN_MS = 60_000;
const MEMORY_SNAPSHOT_TIMEOUT_MS = 10_000;
const WORKER_MONITOR_PROTOCOL = 1;
const WORKER_MONITOR_HANDSHAKE_TIMEOUT_MS = 10_000;
const MiB = 1024 * 1024;

function memorySnapshotCause({ headroomBytes, pressureTriggered = false,
  sustainedPressureSamples = 0, oomKillDelta = 0 } = {}) {
  if (oomKillDelta > 0) return { reason: 'oom-event', critical: true };
  if (headroomBytes !== undefined && headroomBytes < 96 * MiB && pressureTriggered)
    return { reason: 'critical-memory-pressure', critical: true };
  if (pressureTriggered && sustainedPressureSamples >= 2)
    return { reason: 'memory-pressure', critical: false };
  return null;
}

function heartbeatTimeout({ nowMs, startedAtMs, lastHeartbeatAtMs, hasHeartbeat,
  diagnosticsReady = false, monitorOnline = false }) {
  if (!hasHeartbeat && nowMs - startedAtMs > STARTUP_HEARTBEAT_TIMEOUT_MS)
    return diagnosticsReady ? 'missing' : monitorOnline ? 'startup' : 'unavailable';
  if (hasHeartbeat && nowMs - lastHeartbeatAtMs > GAME_HANG_TIMEOUT_MS) return 'hang';
  return null;
}

function procPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function workerCgroupDirectory(pid, reader = fs) {
  if (!Number.isInteger(pid)) return null;
  try {
    const text = reader.readFileSync('/proc/' + pid + '/cgroup', 'utf8');
    const unified = /^0::(.*)$/m.exec(text);
    const memory = text.split('\n').map(line => /^\d+:([^:]*):(.*)$/.exec(line))
      .find(match => match && match[1].split(',').includes('memory'));
    if (!unified && !memory) return null;
    const membership = path.posix.normalize(unified ? unified[1] : memory[2]);
    const mountInfo = reader.readFileSync('/proc/' + pid + '/mountinfo', 'utf8');
    for (const line of mountInfo.split('\n')) {
      const separator = line.indexOf(' - ');
      if (separator < 0) continue;
      const mount = line.slice(0, separator).split(' ');
      const filesystem = line.slice(separator + 3).split(' ');
      const fsType = filesystem[0];
      const superOptions = (filesystem[2] || '').split(',');
      const isMemoryMount = unified ? fsType === 'cgroup2' :
        fsType === 'cgroup' && superOptions.includes('memory');
      if (!isMemoryMount) continue;
      const root = path.posix.normalize(procPath(mount[3]));
      const mountPoint = path.posix.normalize(procPath(mount[4]));
      const relative = path.posix.relative(root, membership);
      if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) continue;
      const directory = path.posix.join(mountPoint, relative);
      const probe = unified ? 'memory.current' : 'memory.usage_in_bytes';
      try { reader.readFileSync(path.posix.join(directory, probe), 'utf8'); return directory; }
      catch (_) {}
    }
    return null;
  } catch (_) { return null; }
}

function cgroupRead(name, reader = fs, directory = null) {
  if (!directory) return null;
  try { return reader.readFileSync(path.posix.join(directory, name), 'utf8'); }
  catch (_) { return null; }
}

function oomKillCount(reader = fs, directory = null) {
  try {
    const text = cgroupRead('memory.events.local', reader, directory) ||
      cgroupRead('memory.events', reader, directory) || '';
    const match = /^oom_kill\s+(\d+)/m.exec(text);
    return match ? Number(match[1]) : null;
  } catch (_) { return null; }
}

function readWorkerMemory(pid, reader = fs, cgroupDirectory = null) {
  const snapshot = {};
  try {
    const text = reader.readFileSync('/proc/' + pid + '/status', 'utf8');
    Object.assign(snapshot, parseProcessStatus(text));
    delete snapshot.name;
  } catch (_) {}
  try {
    const text = reader.readFileSync('/proc/meminfo', 'utf8');
    const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(text);
    if (match) snapshot.hostAvailableBytes = Number(match[1]) * 1024;
  } catch (_) {}
  try {
    let limit = (cgroupRead('memory.max', reader, cgroupDirectory) || '').trim();
    let used = (cgroupRead('memory.current', reader, cgroupDirectory) || '').trim();
    if (!/^\d+$/.test(limit) || !/^\d+$/.test(used)) {
      limit = (cgroupRead('memory.limit_in_bytes', reader, cgroupDirectory) || '').trim();
      used = (cgroupRead('memory.usage_in_bytes', reader, cgroupDirectory) || '').trim();
    }
    if (/^\d+$/.test(limit) && /^\d+$/.test(used)) {
      const limitBytes = Number(limit), usedBytes = Number(used);
      if (Number.isSafeInteger(limitBytes) && Number.isSafeInteger(usedBytes)) {
        snapshot.cgroupLimitBytes = limitBytes;
        snapshot.cgroupUsedBytes = usedBytes;
        snapshot.cgroupHeadroomBytes = Math.max(0, limitBytes - usedBytes);
      }
    }
  } catch (_) {}
  const values = [snapshot.hostAvailableBytes, snapshot.cgroupHeadroomBytes]
    .filter(Number.isFinite);
  if (values.length) snapshot.headroomBytes = Math.min(...values);
  return snapshot;
}

function readLargestProcesses(reader = fs, limit = 5) {
  const processes = [];
  try {
    for (const entry of reader.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const text = reader.readFileSync('/proc/' + entry + '/status', 'utf8');
        const item = { pid: Number(entry), ...parseProcessStatus(text) };
        delete item.dataVirtualBytes;
        if (item.rssBytes) processes.push(item);
      } catch (_) { /* Processes can exit while /proc is sampled. */ }
    }
  } catch (_) { return []; }
  processes.sort((left, right) => right.rssBytes - left.rssBytes);
  return processes.slice(0, limit);
}

function readCpuTicks(pid, reader = fs) {
  try {
    const text = reader.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const end = text.lastIndexOf(')');
    if (end < 0) return null;
    const fields = text.slice(end + 2).trim().split(/\s+/);
    const user = Number(fields[11]), system = Number(fields[12]);
    return Number.isFinite(user) && Number.isFinite(system) ? user + system : null;
  } catch (_) { return null; }
}

function openSessionLog(options, sequence) {
  const directory = process.env.PMJS_LOG_DIR ||
    (options && options.saveRoot && path.join(path.dirname(path.resolve(options.saveRoot)), 'logs'));
  if (!directory) return null;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = 'session-' + new Date().toISOString().replace(/[:.]/g, '-') +
      '-' + process.pid + '-' + String(sequence).padStart(6, '0') + '.log';
    const fullPath = path.join(directory, filename);
    const fd = fs.openSync(fullPath, 'wx', 0o600);
    let position = 0, failed = false, wraps = 0, closed = false;
    function write(value) {
      if (failed || closed) return;
      try {
        const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
        let offset = 0;
        while (offset < data.length) {
          if (position >= LOG_LIMIT_BYTES) {
            fs.ftruncateSync(fd, PREFIX_BYTES);
            position = PREFIX_BYTES;
            wraps++;
            // Write this before the next chunk, so a crash during rollover
            // leaves an explicit gap marker rather than a misleading log.
            const marker = Buffer.from('[pmjs] log-tail-rolled; middle output omitted\n');
            position += fs.writeSync(fd, marker, 0, marker.length, position);
          }
          const size = Math.min(data.length - offset, LOG_LIMIT_BYTES - position);
          const written = fs.writeSync(fd, data, offset, size, position);
          if (written <= 0) throw new Error('zero-byte log write');
          offset += written;
          position += written;
        }
      } catch (error) {
        failed = true;
        try { process.stderr.write('[pmjs] session log failed: ' + error.message + '\n'); } catch (_) {}
      }
    }
    function close({ sync = false } = {}) {
      if (closed) return;
      if (wraps) write('[pmjs] log-tail-rolled count=' + wraps + '\n');
      if (sync) { try { fs.fsyncSync(fd); } catch (_) {} }
      closed = true;
      try { fs.closeSync(fd); } catch (_) {}
    }
    // Strictly prune *our* files and keep no more than four, including this one.
    try {
      const names = fs.readdirSync(directory).filter(name =>
        /^session-\d{4}-\d{2}-\d{2}T.*\.log$/.test(name)).sort();
      for (const name of names.slice(0, -RETAIN_LOGS)) {
        try { fs.unlinkSync(path.join(directory, name)); } catch (_) {}
      }
    } catch (_) {}
    write('[pmjs] session-start supervisor_pid=' + process.pid + ' at=' +
      new Date().toISOString() + '\n');
    return { path: fullPath, write, close, writable: () => !failed && !closed };
  } catch (error) {
    try { process.stderr.write('[pmjs] cannot create session log: ' + error.message + '\n'); } catch (_) {}
    return null;
  }
}

function createOutputLimiter(log, now = () => performance.now()) {
  let windowStart = now();
  const used = { stdout: 0, stderr: 0 };
  const dropped = { stdout: 0, stderr: 0 };
  let stderrTail = null, stderrTailUsed = 0, stderrTailOffset = 0;
  function rememberDropped(chunk) {
    if (!stderrTail) stderrTail = Buffer.allocUnsafe(STDERR_TAIL_BYTES);
    const count = Math.min(chunk.length, STDERR_TAIL_BYTES);
    const bytes = chunk.subarray(chunk.length - count);
    const first = Math.min(count, STDERR_TAIL_BYTES - stderrTailOffset);
    bytes.copy(stderrTail, stderrTailOffset, 0, first);
    if (first < count) bytes.copy(stderrTail, 0, first);
    stderrTailOffset = (stderrTailOffset + count) % STDERR_TAIL_BYTES;
    stderrTailUsed = Math.min(STDERR_TAIL_BYTES, stderrTailUsed + count);
  }
  function flushDropped() {
    if (!log) return;
    for (const name of ['stdout', 'stderr']) {
      if (dropped[name]) {
        log.write('[pmjs] output-rate-limit stream=' + name + ' dropped_bytes=' +
          dropped[name] + '\n');
        dropped[name] = 0;
      }
    }
  }
  function write(name, chunk) {
    // On disk failure stop suppressing terminal output: observability should
    // fail open rather than discard the only remaining error channel.
    if (!log || (typeof log.writable === 'function' && !log.writable())) return chunk;
    const t = now();
    if (t - windowStart >= WINDOW_MS) {
      flushDropped();
      windowStart = t;
      used.stdout = used.stderr = 0;
    }
    const kept = Math.min(chunk.length, Math.max(0, STREAM_BUDGET_BYTES[name] - used[name]));
    if (kept) log.write(chunk.subarray(0, kept));
    used[name] += kept;
    dropped[name] += chunk.length - kept;
    // Preserve stderr even when rate-limited. A fixed circular byte buffer
    // avoids repeated 32 KiB copies during pathological 1-byte write floods.
    if (name === 'stderr' && chunk.length > kept) rememberDropped(chunk.subarray(kept));
    // Disk retention is a separate policy from terminal visibility. The
    // supervisor always forwards the original stream chunk to its terminal.
    return chunk;
  }
  function finish({ abnormal = false } = {}) {
    flushDropped();
    if (abnormal && stderrTailUsed && log) {
      log.write('[pmjs] final-rate-limited-stderr-tail (may duplicate earlier output):\n');
      const start = (stderrTailOffset - stderrTailUsed + STDERR_TAIL_BYTES) % STDERR_TAIL_BYTES;
      const first = Math.min(stderrTailUsed, STDERR_TAIL_BYTES - start);
      log.write(stderrTail.subarray(start, start + first));
      if (first < stderrTailUsed) log.write(stderrTail.subarray(0, stderrTailUsed - first));
      log.write('\n[pmjs] end-final-stderr-tail\n');
    }
  }
  return { write, finish };
}

async function runSupervised(prepare, { worker = path.join(__dirname, 'session.cjs'),
  monitorIntervalMs = MONITOR_INTERVAL_MS, memoryReader = readWorkerMemory,
  mappingReader = processMappingDetails,
  cpuReader = readCpuTicks, processListReader = readLargestProcesses,
  oomCounter = oomKillCount, snapshotTimeoutMs = MEMORY_SNAPSHOT_TIMEOUT_MS,
  snapshotCooldownMs = MEMORY_SNAPSHOT_COOLDOWN_MS,
  workerHandshakeTimeoutMs = WORKER_MONITOR_HANDSHAKE_TIMEOUT_MS } = {}) {
  let active = null, signal = null, sequence = 0;
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = new Map(signals.map(name => [name, () => {
    signal = name;
    if (active) { try { active.kill(name); } catch (_) {} }
  }]));
  for (const [name, handler] of handlers) process.on(name, handler);
  try {
    for (;;) {
      const options = typeof prepare === 'function' ? await prepare() : prepare;
      if (signal) return { code: null, signal };
      const log = openSessionLog(options, ++sequence);
      const limiter = createOutputLimiter(log);
      let workerCgroup = null;
      let oomBefore = null;
      let abnormal = false;
      const result = await new Promise((resolve, reject) => {
        let child, reload = false, monitor = null, settled = false;
        const history = [];
        let lastReportedHeadroom = Infinity;
        let pressureActive = false;
        let criticalSnapshotRequested = false;
        let lastHeartbeatAt = performance.now();
        const workerStartedAt = lastHeartbeatAt;
        let lastHeartbeat = null;
        let receivedHeartbeat = false;
        let startupTimeoutReported = false;
        let heartbeatMissingReported = false;
        let lastCpuTicks = null;
        let hangReported = false;
        let pressureSampleCount = 0;
        let lastSnapshotRequestAt = -Infinity;
        let snapshotRequestId = 0;
        let pendingSnapshotId = null;
        let pendingSnapshotTimer = null;
        let pendingSnapshotSentAt = null;
        let timedOutSnapshotId = null;
        let timedOutSnapshotSentAt = null;
        const supervisorMemoryByRequest = new Map();
        let lastMemorySnapshot = null;
        let workerProtocol = null;
        let workerMonitorOnline = false;
        let diagnosticsReady = false;
        let diagnosticsReadySeen = false;
        let diagnosticsProbeSent = false;
        let queuedSnapshotRequest = null;
        let handshakeTimer = null;
        let lastOomCount = oomBefore;
        const worseningBytes = 32 * MiB;
        const drainListeners = [];
        const outputCleanups = [];
        function setDiagnosticsReady() {
          const wasReady = diagnosticsReady;
          const wasSeen = diagnosticsReadySeen;
          diagnosticsReady = true;
          diagnosticsReadySeen = true;
          diagnosticsProbeSent = false;
          if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
          if (log && !wasReady) log.write('[pmjs] worker-diagnostics-' +
            (wasSeen ? 'recovered' : 'ready') + ' protocol=' + WORKER_MONITOR_PROTOCOL + '\n');
          if (queuedSnapshotRequest) {
            const queued = queuedSnapshotRequest;
            queuedSnapshotRequest = null;
            requestMemorySnapshot(queued.reason, queued.sample, queued.critical,
              queued.supervisorMemory);
          }
        }
        function sendMonitorProbe() {
          if (!workerMonitorOnline || workerProtocol !== WORKER_MONITOR_PROTOCOL ||
              diagnosticsProbeSent || !child || !child.connected) return;
          diagnosticsProbeSent = true;
          try {
            child.send({ type: 'pmjs-worker-monitor-probe', protocol: WORKER_MONITOR_PROTOCOL }, error => {
              if (error) diagnosticsProbeSent = false;
            });
          } catch (_) { diagnosticsProbeSent = false; }
        }
        function captureSupervisorMemory(sample) {
          const supervisorMemory = { ...(sample || {}) };
          supervisorMemory.processMappingsCapturedAt = new Date().toISOString();
          try {
            supervisorMemory.processMappings = mappingReader(child.pid, fs) || null;
            supervisorMemory.processMappingsAvailable = supervisorMemory.processMappings !== null;
          } catch (_) {
            supervisorMemory.processMappings = null;
            supervisorMemory.processMappingsAvailable = false;
          }
          lastMemorySnapshot = { receivedAt: new Date().toISOString(),
            receivedAtMonotonic: performance.now(), snapshot: null, supervisorMemory };
          return supervisorMemory;
        }
        function requestMemorySnapshot(reason, sample, critical = false, capturedSupervisorMemory = null) {
          const now = performance.now();
          if (!diagnosticsReady) {
            const replaceQueued = !queuedSnapshotRequest ||
              (critical && !queuedSnapshotRequest.critical) ||
              (reason === 'oom-event' && queuedSnapshotRequest.reason !== 'oom-event');
            if (replaceQueued) {
              const supervisorMemory = capturedSupervisorMemory || captureSupervisorMemory(sample);
              queuedSnapshotRequest = { reason, sample, critical, supervisorMemory };
            }
            if (workerMonitorOnline) sendMonitorProbe();
            return;
          }
          if (!child || !child.connected || (pendingSnapshotId !== null && !critical)) return;
          if (!critical && now - lastSnapshotRequestAt < snapshotCooldownMs) return;
          if (pendingSnapshotTimer) { clearTimeout(pendingSnapshotTimer); pendingSnapshotTimer = null; }
          timedOutSnapshotId = null;
          timedOutSnapshotSentAt = null;
          const requestId = ++snapshotRequestId;
          pendingSnapshotId = requestId;
          pendingSnapshotSentAt = now;
          lastSnapshotRequestAt = now;
          const supervisorMemory = capturedSupervisorMemory || captureSupervisorMemory(sample);
          supervisorMemoryByRequest.set(requestId, supervisorMemory);
          while (supervisorMemoryByRequest.size > 2)
            supervisorMemoryByRequest.delete(supervisorMemoryByRequest.keys().next().value);
          try {
            child.send({ type: 'pmjs-memory-snapshot-request', requestId, reason,
              critical, supervisorMemory: sample }, error => {
              if (error && pendingSnapshotId === requestId) {
                pendingSnapshotId = null;
                pendingSnapshotSentAt = null;
                diagnosticsReady = false;
                sendMonitorProbe();
                if (pendingSnapshotTimer) clearTimeout(pendingSnapshotTimer);
                pendingSnapshotTimer = null;
              }
            });
          } catch (_) { pendingSnapshotId = null; }
          pendingSnapshotTimer = setTimeout(() => {
            if (pendingSnapshotId !== requestId) return;
            timedOutSnapshotId = requestId;
            timedOutSnapshotSentAt = pendingSnapshotSentAt;
            pendingSnapshotId = null;
            pendingSnapshotSentAt = null;
            pendingSnapshotTimer = null;
            diagnosticsReady = false;
            const externalMemory = supervisorMemoryByRequest.get(requestId) || null;
            if (log) log.write('[pmjs] memory-breakdown-timeout requestId=' + requestId +
              ' reason=' + reason + ' timeout_ms=' + snapshotTimeoutMs +
              ' channel_suspended=true supervisorMemory=' + JSON.stringify(externalMemory) + '\n');
            sendMonitorProbe();
          }, snapshotTimeoutMs);
          if (typeof pendingSnapshotTimer.unref === 'function') pendingSnapshotTimer.unref();
        }
        function sampleMemory() {
          if (!child || !Number.isInteger(child.pid)) return;
          try {
            const sample = memoryReader(child.pid, fs, workerCgroup);
            if (!Object.keys(sample).length) { pressureSampleCount = 0; return; }
            const t = performance.now();
            sample.at = new Date().toISOString();
            const cpuTicks = cpuReader(child.pid);
            const heartbeatState = heartbeatTimeout({ nowMs: t, startedAtMs: workerStartedAt,
              lastHeartbeatAtMs: lastHeartbeatAt, hasHeartbeat: receivedHeartbeat,
              diagnosticsReady, monitorOnline: workerMonitorOnline });
            if (heartbeatState === 'startup' && !startupTimeoutReported) {
              startupTimeoutReported = true;
              sample.startupTimeoutMs = STARTUP_HEARTBEAT_TIMEOUT_MS;
              sample.largestProcesses = processListReader();
              if (log) log.write('[pmjs] worker-startup-timeout ' + JSON.stringify(sample) + '\n');
            } else if (heartbeatState === 'missing' && !heartbeatMissingReported) {
              heartbeatMissingReported = true;
              sample.lastHeartbeat = null;
              sample.diagnosticsReady = true;
              if (log) log.write('[pmjs] worker-heartbeat-missing ' + JSON.stringify(sample) + '\n');
            } else if (heartbeatState === 'hang' && !hangReported) {
              hangReported = true;
              sample.cpuTicksSinceLastSample = cpuTicks !== null && lastCpuTicks !== null ?
                Math.max(0, cpuTicks - lastCpuTicks) : null;
              sample.lastHeartbeat = lastHeartbeat;
              sample.largestProcesses = processListReader();
              if (log) log.write('[pmjs] suspected-game-hang ' + JSON.stringify(sample) + '\n');
            }
            lastCpuTicks = cpuTicks;
            history.push(sample);
            if (history.length > 12) history.shift();
            const currentOomCount = oomCounter(fs, workerCgroup);
            const oomDelta = currentOomCount !== null && lastOomCount !== null ?
              Math.max(0, currentOomCount - lastOomCount) : 0;
            if (currentOomCount !== null) lastOomCount = currentOomCount;
            const pressured = sample.headroomBytes !== undefined && sample.headroomBytes < MEMORY_PRESSURE_BYTES;
            pressureSampleCount = pressured ? pressureSampleCount + 1 : 0;
            const worsening = pressured && (!pressureActive ||
              sample.headroomBytes <= lastReportedHeadroom - worseningBytes);
            const snapshotCause = memorySnapshotCause({ headroomBytes: sample.headroomBytes,
              pressureTriggered: pressured, sustainedPressureSamples: pressureSampleCount,
              oomKillDelta: oomDelta });
            const shouldCapture = snapshotCause &&
              (!snapshotCause.critical || !criticalSnapshotRequested || oomDelta > 0);
            if (worsening) {
              sample.largestProcesses = processListReader();
              pressureActive = true;
              lastReportedHeadroom = sample.headroomBytes;
              if (log) log.write('[pmjs] supervisor-memory-pressure ' + JSON.stringify(sample) + '\n');
            } else if (!pressured && pressureActive) {
              pressureActive = false;
              criticalSnapshotRequested = false;
              lastReportedHeadroom = Infinity;
              if (log) log.write('[pmjs] supervisor-memory-recovered ' + JSON.stringify({
                at: sample.at, headroomBytes: sample.headroomBytes
              }) + '\n');
            }
            if (shouldCapture) {
              if (snapshotCause.critical) criticalSnapshotRequested = true;
              requestMemorySnapshot(snapshotCause.reason,
                { ...sample, oomKillDelta: oomDelta, sustainedPressureSamples: pressureSampleCount },
                snapshotCause.critical);
            }
          } catch (_) {
            pressureSampleCount = 0;
            /* Diagnostics must never abort a session. */
          }
        }
        function cleanup() {
          if (monitor) { clearInterval(monitor); monitor = null; }
          if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
          if (pendingSnapshotTimer) { clearTimeout(pendingSnapshotTimer); pendingSnapshotTimer = null; }
          for (const [stream, listener] of drainListeners) stream.removeListener('drain', listener);
          for (const cleanupOutput of outputCleanups) cleanupOutput();
          active = null;
        }
        try {
        const environment = { ...process.env };
        // Large transient buffers should release their mappings when freed.
        if (process.platform === 'linux' && environment.MALLOC_MMAP_THRESHOLD_ === undefined &&
            !/(^|:)glibc\.malloc\.mmap_threshold=/.test(environment.GLIBC_TUNABLES || ''))
          environment.MALLOC_MMAP_THRESHOLD_ = '1048576';
        child = active = fork(worker, [], { stdio: ['inherit', 'pipe', 'pipe', 'ipc'], env: environment });
        workerCgroup = workerCgroupDirectory(child.pid);
        oomBefore = oomCounter(fs, workerCgroup);
        lastOomCount = oomBefore;
        } catch (error) {
          abnormal = true;
          cleanup();
          if (log) log.write('[pmjs] worker-spawn-failed ' + error.message + '\n');
          reject(error);
          return;
        }
        for (const [name, destination] of [['stdout', process.stdout], ['stderr', process.stderr]]) {
          let blocked = false;
          const source = child[name];
          const output = terminalState(destination);
          const resume = () => { blocked = false; source.resume(); };
          const unavailable = error => {
            destination.removeListener('drain', resume);
            resume();
            if (log) log.write('[pmjs] terminal-output-unavailable stream=' + name +
              ' code=' + (error?.code || 'closed') + '\n');
          };
          output.listeners.add(unavailable);
          outputCleanups.push(() => output.listeners.delete(unavailable));
          drainListeners.push([destination, resume]);
          child[name].on('data', chunk => {
            limiter.write(name, chunk);
            if (blocked || output.failed) return;
            try {
              if (!destination.write(chunk)) {
                blocked = true;
                source.pause();
                destination.once('drain', resume);
              }
            } catch (error) {
              output.fail(error);
            }
          });
        }
        child.on('message', message => {
          if (message && message.type === 'pmjs-worker-monitor-online') {
            workerMonitorOnline = true;
            workerProtocol = Number(message.protocol) || null;
            if (workerProtocol === WORKER_MONITOR_PROTOCOL) {
              if (log) log.write('[pmjs] worker-monitor-online protocol=' + workerProtocol + '\n');
            } else if (log) {
              log.write('[pmjs] worker-monitor-unavailable reason=protocol-mismatch protocol=' +
                JSON.stringify(message.protocol) + ' expected=' + WORKER_MONITOR_PROTOCOL + '\n');
            }
          }
          if (message && message.type === 'pmjs-worker-diagnostics-ready') {
            const protocol = Number(message.protocol) || null;
            if (protocol === WORKER_MONITOR_PROTOCOL) {
              workerMonitorOnline = true;
              workerProtocol = protocol;
              setDiagnosticsReady();
            } else if (log) {
              log.write('[pmjs] worker-monitor-unavailable reason=protocol-mismatch protocol=' +
                JSON.stringify(message.protocol) + ' expected=' + WORKER_MONITOR_PROTOCOL + '\n');
            }
          }
          if (message && message.type === 'pmjs-session-complete') reload = message.reload === true;
          if (message && message.type === 'pmjs-heartbeat') {
            receivedHeartbeat = true;
            lastHeartbeatAt = performance.now();
            lastHeartbeat = message.heartbeat || null;
            hangReported = false;
            heartbeatMissingReported = false;
          }
          const pendingSnapshotReply = message && message.type === 'pmjs-memory-snapshot' &&
            message.requestId === pendingSnapshotId;
          const lateSnapshotReply = message && message.type === 'pmjs-memory-snapshot' &&
            pendingSnapshotId === null && message.requestId === timedOutSnapshotId;
          if (pendingSnapshotReply || lateSnapshotReply) {
            const late = lateSnapshotReply;
            const supervisorMemory = supervisorMemoryByRequest.get(message.requestId) || null;
            supervisorMemoryByRequest.delete(message.requestId);
            const sentAt = late ? timedOutSnapshotSentAt : pendingSnapshotSentAt;
            const responseDelayMs = Number.isFinite(sentAt) ?
              Math.max(0, Math.round(performance.now() - sentAt)) : null;
            if (!late) {
              pendingSnapshotId = null;
              pendingSnapshotSentAt = null;
              if (pendingSnapshotTimer) { clearTimeout(pendingSnapshotTimer); pendingSnapshotTimer = null; }
            }
            timedOutSnapshotId = null;
            timedOutSnapshotSentAt = null;
            if (message.snapshot && !message.error) {
              if (!diagnosticsReady) setDiagnosticsReady();
              const snapshotAgeMs = Math.max(0, Date.now() - Date.parse(message.snapshot.capturedAt));
              lastMemorySnapshot = { receivedAt: new Date().toISOString(),
                receivedAtMonotonic: performance.now(), snapshot: message.snapshot,
                supervisorMemory: supervisorMemory || message.supervisorMemory || null };
              if (log) log.write('[pmjs] memory-breakdown ' + JSON.stringify({
                reason: message.snapshot.reason,
                late,
                responseDelayMs,
                snapshotAgeMs: Number.isFinite(snapshotAgeMs) ? snapshotAgeMs : null,
                supervisorMemory: lastMemorySnapshot.supervisorMemory,
                snapshot: message.snapshot
              }) + '\n');
            } else if (log) {
              log.write('[pmjs] memory-breakdown-unavailable requestId=' + message.requestId +
                ' late=' + late + ' error=' + JSON.stringify(message.error || 'empty snapshot') + '\n');
              diagnosticsReady = false;
              sendMonitorProbe();
            }
          }
        });
        // Node may emit both 'error' and 'close' for a failed spawn.
        // Finalize once, after pipes have been drained, not twice.
        let spawnError = null;
        child.once('error', error => {
          spawnError = error;
          if (log) log.write('[pmjs] worker-error ' + error.message + '\n');
        });
        child.once('close', (code, terminated) => {
          if (settled) return;
          settled = true;
          cleanup();
          abnormal = Boolean(spawnError || code !== 0 || (terminated && !signal));
          limiter.finish({ abnormal });
          if (log) {
            log.write('[pmjs] session-exit code=' + code + ' signal=' + terminated + '\n');
            const oomAfter = oomCounter(fs, workerCgroup);
            if (oomBefore !== null && oomAfter !== null && oomAfter > oomBefore) {
              log.write('[pmjs] cgroup-oom-kill-counter-increased delta=' +
                (oomAfter - oomBefore) + ' (not proof worker was the victim)\n');
            }
            if (abnormal) {
              if (history.length) history[history.length - 1].largestProcesses = processListReader();
              log.write('[pmjs] pre-exit-memory-samples ' + JSON.stringify(history) + '\n');
              if (lastMemorySnapshot) {
                const ageMs = Math.max(0, performance.now() - lastMemorySnapshot.receivedAtMonotonic);
                log.write('[pmjs] last-game-memory-snapshot ' + JSON.stringify({
                  capturedAt: lastMemorySnapshot.snapshot?.capturedAt ||
                    lastMemorySnapshot.supervisorMemory?.processMappingsCapturedAt,
                  supervisorReceivedAt: lastMemorySnapshot.receivedAt,
                  ageMs: Math.round(ageMs), stale: ageMs > 60_000,
                  supervisorMemory: lastMemorySnapshot.supervisorMemory,
                  snapshot: lastMemorySnapshot.snapshot
                }) + '\n');
              }
            }
          }
          if (spawnError) reject(spawnError);
          else resolve({ code, signal: terminated, reload });
        });
        try {
          child.send(options, error => {
            if (error) {
              if (log) log.write('[pmjs] ipc-startup-error ' + error.message + '\n');
              try { child.kill('SIGTERM'); } catch (_) {}
            }
          });
        } catch (error) {
          if (log) log.write('[pmjs] ipc-startup-error ' + error.message + '\n');
          try { child.kill('SIGTERM'); } catch (_) {}
        }
        handshakeTimer = setTimeout(() => {
          if (!diagnosticsReady && log) log.write('[pmjs] worker-monitor-unavailable reason=' +
            (workerMonitorOnline ? 'diagnostics-timeout' : 'protocol-timeout') +
            ' timeout_ms=' + workerHandshakeTimeoutMs +
            ' expected=' + WORKER_MONITOR_PROTOCOL + '\n');
        }, workerHandshakeTimeoutMs);
        if (typeof handshakeTimer.unref === 'function') handshakeTimer.unref();
        // Install pipe/IPC listeners and send startup options first. Procfs
        // sampling cannot delay the initial IPC or leave pipes undrained.
        sampleMemory();
        monitor = setInterval(sampleMemory, monitorIntervalMs);
        if (typeof monitor.unref === 'function') monitor.unref();
      }).finally(() => { if (log) log.close({ sync: abnormal }); });
      if (signal) return { code: result.code, signal };
      if (result.code !== 0 || result.signal || !result.reload) return result;
    }
  } finally {
    for (const [name, handler] of handlers) process.removeListener(name, handler);
  }
}

module.exports = { runSupervised, openSessionLog, createOutputLimiter, readWorkerMemory,
  readLargestProcesses, oomKillCount, workerCgroupDirectory, memorySnapshotCause, heartbeatTimeout };
