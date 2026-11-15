'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryState, memoryPressure, parseProcessStatus, processMappingDetails, gameContext, createDiagnostics } = require('../runner/diagnostics.cjs');

const MiB = 1024 * 1024;

test('process status memory fields use one byte mapping', () => {
  assert.deepEqual(parseProcessStatus('Name:\tworker\nVmRSS:\t10 kB\nRssAnon:\t7 kB\n' +
    'RssFile:\t2 kB\nRssShmem:\t1 kB\nVmData:\t20 kB\nVmSwap:\t3 kB\n'), {
    name: 'worker', rssBytes: 10 * 1024, anonymousRssBytes: 7 * 1024,
    fileRssBytes: 2 * 1024, sharedRssBytes: 1 * 1024,
    dataVirtualBytes: 20 * 1024, swapBytes: 3 * 1024
  });
});

test('CPU logs expose sustained background load without asserting a JIT cause', () => {
  let clock = 0, totalUs = 0, mainUs = 0;
  const lines = [];
  const monitor = createDiagnostics({ now: () => clock,
    logger: { info: line => lines.push(line), warn: line => lines.push(line) },
    readMemory: () => ({ totalBytes: 1024 * MiB, availableBytes: 600 * MiB }),
    readCpu: () => ({ totalUs, mainUs }) });
  const sample = (total, main) => {
    clock += 10000; totalUs += total; mainUs = main === null ? null : mainUs + main;
    monitor.sample();
  };
  monitor.sample();
  sample(28800000, 8900000);
  let records = lines.map(line => JSON.parse(line.slice('[pmjs] diagnostic '.length)));
  const cpu = records.find(row => row.reason === 'cpu-usage');
  assert.equal(cpu.totalPercent, 288);
  assert.equal(cpu.mainPercent, 89);
  assert.equal(cpu.backgroundPercent, 199);
  assert.equal(records.some(row => row.reason === 'background-cpu-pressure'), false);
  sample(28800000, 8900000);
  sample(28800000, 8900000);
  records = lines.map(line => JSON.parse(line.slice('[pmjs] diagnostic '.length)));
  const warnings = records.filter(row => row.reason === 'background-cpu-pressure');
  assert.equal(warnings.length, 1, 'sustained warnings have a cooldown');
  assert.equal(warnings[0].attribution, 'unknown');
  assert.equal('nextDiagnostic' in warnings[0], false);
  sample(10000000, 9000000);
  sample(28800000, 8900000);
  sample(28800000, null);
  records = lines.map(line => JSON.parse(line.slice('[pmjs] diagnostic '.length)));
  assert.equal(records.filter(row => row.reason === 'background-cpu-pressure').length, 1);
  assert.equal(records.filter(row => row.reason === 'cpu-usage').at(-1).backgroundPercent, null);
});

test('memory accounting uses MemAvailable and a bounded cgroup (not free-only memory)', () => {
  const files = {
    '/proc/meminfo': 'MemTotal: 1048576 kB\nMemAvailable: 140000 kB\n',
    '/sys/fs/cgroup/memory.max': String(600 * MiB),
    '/sys/fs/cgroup/memory.current': String(540 * MiB),
    '/sys/fs/cgroup/memory.events': 'low 0\nhigh 0\nmax 3\noom 1\noom_kill 0\n'
  };
  const reader = { readFileSync: filename => {
    if (!(filename in files)) throw new Error('ENOENT');
    return files[filename];
  } };
  const state = memoryState({ reader,
    processObject: { memoryUsage: () => ({ rss: 7, heapUsed: 5, heapTotal: 6, external: 3, arrayBuffers: 2 }) },
    osObject: { totalmem: () => 1024 * MiB, freemem: () => 4 * MiB } });
  assert.equal(state.availableBytes, 60 * MiB);
  assert.equal(state.cgroupLimitBytes, 600 * MiB);
  assert.equal(state.cgroupEvents.oom, 1);
  assert.equal(state.v8Heap, undefined, 'healthy samples omit detailed V8 heap spaces');
});

test('memory sampling keeps using Node process data after guest bootstrap replaces global process', () => {
  const oldProcess = globalThis.process;
  const reader = { readFileSync(filename) {
    if (filename === '/proc/meminfo') return 'MemTotal: 1048576 kB\nMemAvailable: 262144 kB\n';
    if (filename === '/proc/' + oldProcess.pid + '/status') return 'VmRSS: 1000 kB\n';
    throw new Error('ENOENT');
  } };
  globalThis.process = { env: {}, cwd: () => '/guest' };
  try {
    const sample = memoryState({ reader, osObject: { totalmem: () => 1024 * MiB, freemem: () => 0 } });
    assert.ok(sample.rssBytes > 0);
    assert.equal(sample.availableBytes, 256 * MiB);
  } finally {
    globalThis.process = oldProcess;
  }
});

test('Linux memory PSI reports stalls independently of remaining memory', () => {
  const reader = { readFileSync: file => {
    if (file === '/sys/fs/cgroup/memory.pressure') return 'some avg10=11.50 avg60=5.00 total=1\nfull avg10=1.25 avg60=0.00 total=2\n';
    throw new Error('missing');
  } };
  assert.deepEqual(memoryPressure(reader), { someAvg10: 11.5, fullAvg10: 1.25 });
});

test('detailed Linux memory snapshot partitions anonymous RSS by mapping and lists the largest regions', () => {
  const smaps = [
    '1000-3000 rw-p 00000000 00:00 0 [heap]\nSize: 8 kB\nRss: 8 kB\nAnonymous: 8 kB\nPrivate_Dirty: 8 kB\nSwap: 0 kB',
    '4000-5000 rw-p 00000000 00:00 0 [stack]\nSize: 4 kB\nRss: 4 kB\nAnonymous: 4 kB\nPrivate_Dirty: 4 kB\nSwap: 0 kB',
    '6000-a000 rw-p 00000000 00:00 0\nSize: 16 kB\nRss: 12 kB\nAnonymous: 12 kB\nPrivate_Dirty: 12 kB\nSwap: 0 kB',
    'b000-f000 rw-p 00000000 00:00 0 /dev/dri/renderD128\nSize: 16 kB\nRss: 8 kB\nAnonymous: 4 kB\nPrivate_Dirty: 4 kB\nSwap: 0 kB',
    '10000-11000 rw-p 00000000 00:00 0 [anon:V8-heap]\nSize: 4 kB\nRss: 4 kB\nAnonymous: 4 kB\nPrivate_Dirty: 4 kB\nSwap: 0 kB'
  ].join('\n') + '\n';
  const reader = { readFileSync(file) {
    if (file === '/proc/77/smaps') return smaps;
    throw new Error('ENOENT');
  } };
  const result = processMappingDetails(77, reader, 3);
  assert.equal(result.mappingCount, 5);
  assert.equal(result.anonymousBytes, 32 * 1024);
  assert.deepEqual(result.anonymousByKind, {
    processHeapBytes: 8 * 1024, threadStackBytes: 4 * 1024,
    namedAnonymousBytes: 4 * 1024, unnamedMappingBytes: 12 * 1024,
    fileMappingBytes: 4 * 1024, otherNamedMappingBytes: 0
  });
  assert.equal(result.largestAnonymousMappings.length, 3);
  assert.equal(result.largestAnonymousMappings[0].name, '[unnamed]');
  assert.equal(result.largestAnonymousMappings[1].name, '[heap]');
  assert.equal(processMappingDetails(77, { readFileSync() { throw Error('unavailable'); } }), null);
});

test('worker memoryState never reads smaps, even for a detailed V8 snapshot', () => {
  const reads = [];
  const reader = { readFileSync(file) {
    reads.push(file);
    if (file === '/proc/meminfo') return 'MemTotal: 1048576 kB\nMemAvailable: 500000 kB\n';
    if (file === '/proc/77/status') return 'VmRSS: 1000 kB\nRssAnon: 800 kB\n';
    throw Error('ENOENT');
  } };
  const memory = memoryState({ detailed: true, reader,
    processObject: { pid: 77, memoryUsage: () => ({ rss: 1024, heapUsed: 256,
      heapTotal: 512, external: 128, arrayBuffers: 64 }) },
    osObject: { totalmem: () => 1024 * MiB, freemem: () => 0 } });
  assert.equal(memory.processMappings, undefined);
  assert.equal(reads.includes('/proc/77/smaps'), false);
});

test('map snapshot avoids guest getters and falls back to map metadata name', () => {
  let accessed = 0;
  const map = { _mapId: 21, _interpreter: { _eventId: 9, _index: 5, _waitMode: 'message' } };
  Object.defineProperty(map, 'mapId', { get() { accessed++; throw new Error('bad getter'); } });
  const globals = { $gameMap: map, $dataMap: {}, $dataMapInfos: { 21: { name: 'Garden' } },
    $gamePlayer: { _x: 3, _y: 12 }, SceneManager: { _scene: {} }, Graphics: { frameCount: 123 } };
  assert.deepEqual(gameContext(globals), {
    mapId: 21, mapName: 'Garden', scene: 'Object', x: 3, y: 12,
    eventId: 9, commandIndex: 5, commandCode: undefined, interpreterDepth: 0, waitMode: 'message', frameCount: 123
  });
  assert.equal(accessed, 0);
});

test('worker samples avoid duplicate pressure warnings and bound slow-frame summaries', () => {
  let clock = 0, callback, cleared = false;
  const warnings = [], information = [], errors = [];
  let available = 75 * MiB;
  const monitor = createDiagnostics({
    logger: { warn: line => warnings.push(line), info: line => information.push(line), error: line => errors.push(line) },
    now: () => clock,
    readMemory: () => ({ totalBytes: 1024 * MiB, availableBytes: available, cgroupEvents: { oom_kill: 0 } }),
    getGlobals: () => ({ $gameMap: { _mapId: 8 } }),
    getNative: () => ({ images: { memory: () => { throw Error('native failed'); } } }),
    timers: { setInterval(fn) { callback = fn; return { unref() {} }; }, clearInterval() { cleared = true; } }
  });
  monitor.start();
  assert.equal(warnings.length, 0);
  clock = 1000; callback(); callback();
  assert.equal(warnings.length, 0);
  monitor.observeFrame(200, 1000);
  clock = 61000; monitor.observeFrame(200, clock);
  assert.equal(warnings.length, 0, 'frame completion only records counters');
  callback();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /slow-frame-summary/);
  clock = 65000; callback();
  assert.equal(warnings.length, 1, 'worker does not duplicate supervisor pressure reports');
  available = 600 * MiB;
  clock = 310000; callback();
  assert.equal(information.some(line => line.includes('memory-recovered')), false);
  monitor.stage('bootstrap');
  clock = 312000;
  monitor.report('fatal-error', new Error('script failed'));
  assert.match(errors[0], /"stage":"bootstrap"/);
  assert.match(errors[0], /"lastMemoryAgeMs":2000/);
  assert.match(errors[0], /"lastMemory"/);
  assert.match(errors[0], /script failed/);
  monitor.stop();
  assert.equal(cleared, true);
});

test('heartbeat is sent even when optional diagnostic sampling throws', () => {
  let clock = 0;
  const heartbeats = [];
  const monitor = createDiagnostics({ now: () => clock,
    readMemory: () => { throw Error('procfs unavailable'); },
    onHeartbeat: heartbeat => heartbeats.push(heartbeat), heartbeatMs: 10000 });
  monitor.sample();
  clock = 10000;
  monitor.sample();
  assert.equal(heartbeats.length, 1);
});

test('healthy play avoids detailed native queries and reports location only once', () => {
  let clock = 0, timer;
  let nativeCalls = 0;
  const lines = [];
  const heartbeats = [];
  const monitor = createDiagnostics({ now: () => clock, logger: {
    info: s => lines.push(s), warn: s => lines.push(s) },
    onHeartbeat: heartbeat => heartbeats.push(heartbeat),
    getNative: () => ({ images: { memory() { nativeCalls++; return {}; } } }),
    readMemory: () => ({ totalBytes: 1024 * MiB, availableBytes: 600 * MiB,
      rssBytes: 250 * MiB, cgroupEvents: { oom_kill: 0 } }),
    getGlobals: () => ({ $gameMap: { _mapId: 1 } }),
    timers: { setInterval(cb) { timer = cb; return { unref() {} }; }, clearInterval() {} }
  });
  monitor.start();
  for (let t = 15000; t <= 300000; t += 15000) {
    clock = t;
    timer();
  }
  assert.equal(lines.filter(line => line.includes('heartbeat')).length, 0);
  assert.equal(heartbeats.length, 20);
  assert.equal(lines.filter(line => line.includes('map-transition')).length, 0);
  assert.equal(lines.filter(line => line.includes('game-location')).length, 1);
  assert.equal(lines.filter(line => line.includes('memory-pressure')).length, 0);
  assert.equal(nativeCalls, 0);
  monitor.stop();
});

test('supervisor memory snapshot captures separate V8 and native allocation categories', () => {
  const imageLimits = [];
  let detailed = false;
  const monitor = createDiagnostics({ now: () => 100,
    getGlobals: () => ({ $gameMap: { _mapId: 5 } }),
    readMemory: options => {
      detailed = options.detailed === true;
      return { rssBytes: 500 * MiB, heapUsedBytes: 80 * MiB, heapTotalBytes: 100 * MiB,
        externalBytes: 30 * MiB, arrayBufferBytes: 8 * MiB, availableBytes: 150 * MiB,
        process: { anonymousRssBytes: 350 * MiB }, v8Heap: { heapLimitBytes: 2 * 1024 * MiB,
          spaces: [{ name: 'old_space', usedBytes: 40 * MiB }] } };
    },
    getNative: () => ({
      runtime: { allocatorStats: () => ({ arenaBytes: 100 * MiB, freeArenaBytes: 60 * MiB }) },
      images: { memory(limit) { imageLimits.push(limit); return {
        liveCount: 20, cpuBytes: 25 * MiB, gpuBytes: 40 * MiB,
        preparedFrameCacheBytes: 2 * MiB,
        ...(limit === 5 ? { largest: [{ path: 'img/picture/large.png', width: 2048, height: 2048,
          cpuBytes: 16 * MiB, gpuBytes: 16 * MiB, references: 2, pins: 0 }] } : {})
      }; } },
      canvas: { memory: () => ({ cpuBytes: 9 * MiB, liveCount: 4 }) },
      media: { audioStats: () => ({ livePcmBytes: 3 * MiB, cacheBytes: 4 * MiB,
        entries: 2, streamBufferedBytes: 1 * MiB }) },
      render: { stats: () => ({ rendererTargetBytes: 6 * MiB, tileGeometryGpuBytes: 1 * MiB }) }
    })
  });
  const snapshot = monitor.supervisorMemorySnapshot({ reason: 'supervisor-request' });
  assert.equal(detailed, true);
  assert.deepEqual(imageLimits, [0]);
  assert.equal(snapshot.reason, 'supervisor-request');
  assert.equal(snapshot.context.mapId, 5);
  assert.equal(snapshot.memory.v8Heap.spaces[0].usedBytes, 40 * MiB);
  assert.equal(snapshot.native.images.cpuBytes, 25 * MiB);
  assert.equal(snapshot.native.allocator.freeArenaBytes, 60 * MiB);
  assert.equal('largest' in snapshot.native.images, false);
  const criticalSnapshot = monitor.supervisorMemorySnapshot({ reason: 'memory-critical', critical: true });
  assert.deepEqual(imageLimits, [0, 5]);
  assert.equal(criticalSnapshot.native.images.largest[0].path, 'img/picture/large.png');
  assert.equal(snapshot.native.canvas.cpuBytes, 9 * MiB);
  assert.equal(snapshot.native.audio.livePcmBytes, 3 * MiB);
  assert.equal(snapshot.native.renderer.rendererTargetBytes, 6 * MiB);
  assert.equal('accounting' in snapshot, false);
  assert.equal('processMappings' in snapshot.memory, false);
  assert.equal('externalMinusListedCategoriesBytes' in snapshot, false);
});

test('cgroup v2 descendant paths are probed before cgroup mount root', () => {
  const { readCgroupFile } = require('../runner/diagnostics.cjs');
  const seen = [];
  const reader = { readFileSync(name) {
    seen.push(name);
    if (name === '/proc/self/cgroup') return '0::/user.slice/pmjs.scope\n';
    if (name === '/sys/fs/cgroup/user.slice/pmjs.scope/memory.events') return 'oom_kill 7\n';
    throw Error('ENOENT');
  }};
  assert.equal(readCgroupFile('memory.events', reader), 'oom_kill 7\n');
  assert.ok(!seen.includes('/sys/fs/cgroup/memory.events'));
});

test('reclamation sampling shares bounded headroom accounting without detailed metrics', () => {
  const { reclamationMemoryState } = require('../runner/diagnostics.cjs');
  const files = {
    '/proc/self/cgroup': '0::/game\n',
    '/proc/meminfo': 'MemAvailable: 140000 kB\n',
    '/sys/fs/cgroup/game/memory.max': String(600 * MiB),
    '/sys/fs/cgroup/game/memory.current': String(540 * MiB)
  };
  const reader = { readFileSync(file) {
    assert.ok(file in files, 'unexpected detailed memory read: ' + file);
    return files[file];
  } };
  const memoryUsage = () => assert.fail('full memoryUsage is unnecessary');
  memoryUsage.rss = () => 400 * MiB;
  const state = reclamationMemoryState({ reader, processObject: { memoryUsage },
    osObject: { totalmem: () => 1024 * MiB, freemem: () => 0 } });
  assert.equal(state.availableBytes, 60 * MiB);
  assert.equal(state.rssBytes, 400 * MiB);
});

test('reclamation sampling includes process swap without reading memory mappings', () => {
  const reader = { readFileSync(file) {
    if (file === '/proc/meminfo') return 'MemAvailable: 80000 kB\n';
    if (file === '/proc/123/status') return 'VmSwap: 64000 kB\n';
    assert.doesNotMatch(file, /smaps/);
    throw Error('ENOENT');
  } };
  const memoryUsage = () => assert.fail('full memoryUsage is unnecessary');
  memoryUsage.rss = () => 400 * MiB;
  const state = require('../runner/diagnostics.cjs').reclamationMemoryState({ reader,
    processObject: { pid: 123, memoryUsage },
    osObject: { totalmem: () => 1024 * MiB, freemem: () => 0 } });
  assert.equal(state.swapBytes, 64000 * 1024);
  assert.equal(state.rssBytes, 400 * MiB);
});
