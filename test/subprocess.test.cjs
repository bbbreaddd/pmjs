'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { createSubprocesses } = require('../runner/subprocess.cjs');

function guestTasks(nodeErrors) {
  const context = vm.createContext({ console, performance, __pmjsBuiltinRequire: require,
    NativeHost: { runtime: { scheduling: require('node:timers') } },
    PMJS: {}, pmjsReportNodeException(error) { nodeErrors.push(error); } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../js/pmjs-web/scheduler.js'), 'utf8'), context);
  return context.PMJS.tasks;
}

function subprocesses() {
  const queue = [], root = temporaryDirectory('subprocess-'), opened = [], nodeErrors = [];
  let stopped = false;
  const service = createSubprocesses({
    tasks: () => ({ enqueue(callback, options) { if (!stopped) queue.push({ callback, options }); } }),
    resolveDirectory(virtual) { assert.equal(virtual, '/game'); return root; },
    openExternal(url) { opened.push(url); return true; }
  });
  return { ...service, root, opened,
    nodeErrors,
    drain() {
      while (queue.length) {
        const task = queue.shift();
        try { task.callback(); }
        catch (error) {
          if (task.options?.errorMode === 'uncaught') nodeErrors.push(error);
          else throw error;
        }
      }
    },
    terminate() { stopped = true; queue.length = 0; service.stop(); } };
}

test('subprocess callbacks preserve output, errors, cwd and argument boundaries through dispatcher', async () => {
  const root = temporaryDirectory('subprocess-');
  const h = createSubprocesses({ tasks: () => ({ enqueue: callback => setImmediate(callback) }),
    resolveDirectory(virtual) { assert.equal(virtual, '/game'); return root; }, openExternal() {} });
  let child, synchronous = true;
  const completion = new Promise(resolve => {
    child = h.api.execFile(process.execPath,
      ['-e', 'process.stdout.write(process.cwd());process.stderr.write("warning");process.exitCode=7;'],
      { cwd: '/game' }, (error, stdout, stderr) => {
        assert.equal(synchronous, false);
        resolve({ error, stdout, stderr });
      });
    child.on('error', error => assert.fail(error));
  });
  synchronous = false;
  const result = await completion;
  assert.equal(result.error.code, 7);
  assert.equal(result.stdout, root);
  assert.equal(result.stderr, 'warning');
  h.stop();
});

test('verified platform URL commands use the host browser and terminated callbacks are discarded', () => {
  const h = subprocesses();
  const results = [];
  for (const command of ['open "https://example.com/a"', 'rundll32 url.dll,FileProtocolHandler https://example.com/b']) {
    h.api.exec(command, (error, stdout, stderr) => results.push([error, stdout, stderr]));
  }
  assert.equal(results.length, 0);
  h.drain();
  assert.deepEqual(results, [[null, '', ''], [null, '', '']]);
  assert.deepEqual(h.opened, ['https://example.com/a', 'https://example.com/b']);
  h.api.exec('open https://example.com/terminated', () => assert.fail('callback after shutdown'));
  h.terminate(); h.drain();
  assert.equal(h.opened.length, 2);
});

test('child process callbacks and emitted events use Node exception delivery', () => {
  const h = subprocesses(), callbackError = new Error('exec callback'), exitError = new Error('exit listener');
  const trace = [];
  const child = h.api.exec('open https://example.com/callback', () => { throw callbackError; });
  child.on('exit', () => { throw exitError; });
  child.on('close', () => trace.push('close'));
  h.drain();
  assert.deepEqual(h.nodeErrors, [exitError, callbackError]);
  assert.deepEqual(trace, ['close']);
});

test('spawn and exit listener exceptions do not prevent later child events', async () => {
  const root = temporaryDirectory('subprocess-events-'), nodeErrors = [], trace = [];
  const spawnError = new Error('spawn listener'), exitError = new Error('exit listener');
  const service = createSubprocesses({
    tasks: () => ({ enqueue(callback, options = {}) {
      setImmediate(() => {
        try { callback(); }
        catch (error) {
          if (options.errorMode === 'uncaught') nodeErrors.push(error);
          else throw error;
        }
      });
    } }),
    resolveDirectory: () => root,
    openExternal: () => true
  });
  const child = service.api.spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 5)']);
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('spawn', () => { trace.push('spawn'); throw spawnError; });
    child.on('exit', () => { trace.push('exit'); throw exitError; });
    child.on('close', () => { trace.push('close'); resolve(); });
  });
  assert.deepEqual(nodeErrors, [spawnError, exitError]);
  assert.deepEqual(trace, ['spawn', 'exit', 'close']);
  await service.stop();
});

test('child output listener exceptions use the guest Node dispatcher', async t => {
  const nodeErrors = [], tasks = guestTasks(nodeErrors);
  const service = createSubprocesses({ tasks: () => tasks,
    resolveDirectory: () => temporaryDirectory('subprocess-output-'), openExternal: () => true });
  t.after(async () => { await service.stop(); tasks.stop(); });

  const listenerError = new Error('stdout listener');
  const child = service.api.spawn(process.execPath,
    ['-e', 'process.stdout.write("output"); setTimeout(() => process.exit(0), 5)']);
  child.stdout.on('data', () => { throw listenerError; });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  await tasks.idle();
  assert.deepEqual(nodeErrors, [listenerError]);
});

test('spawned output is bounded while paused, resumes intact, and can be abandoned at shutdown', async t => {
  const tasks = guestTasks([]);
  const service = createSubprocesses({ tasks: () => tasks, resolveDirectory: () => process.cwd() });
  t.after(async () => { await service.stop(); tasks.stop(); });
  const size = 8 * 1024 * 1024;
  const launch = () => service.api.spawn(process.execPath,
    ['-e', `process.stdout.write(Buffer.alloc(${size}, 37));`]);
  const child = launch();
  const closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  await new Promise(resolve => child.stdout.once('readable', resolve));
  await tasks.idle();
  assert.ok(child.stdout.writableLength <= child.stdout.writableHighWaterMark * 2);
  let total = 0;
  for await (const bytes of child.stdout) {
    assert.equal(bytes[0], 37);
    total += bytes.length;
  }
  assert.equal(await closed, 0);
  assert.equal(total, size);
  const abandoned = launch();
  await new Promise(resolve => abandoned.stdout.once('readable', resolve));
  await service.stop();
});

test('child stdin preserves backpressure, payload, and Node callback/event delivery', async t => {
  const nodeErrors = [], tasks = guestTasks(nodeErrors);
  const service = createSubprocesses({ tasks: () => tasks,
    resolveDirectory: () => temporaryDirectory('subprocess-stdin-'), openExternal: () => true });
  t.after(async () => { await service.stop(); tasks.stop(); });

  const callbackError = new Error('stdin write callback');
  const drainError = new Error('stdin drain listener');
  const payload = 'pmjs-stdin-'.repeat(100_000);
  const trace = [];
  const child = service.api.spawn(process.execPath, ['-e',
    'let size=0;process.stdin.on("data",chunk=>size+=chunk.length);process.stdin.on("end",()=>process.stdout.write(String(size)));']);
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  const drained = new Promise(resolve => child.stdin.on('drain', () => {
    trace.push('drain');
    resolve();
    throw drainError;
  }));
  const accepted = child.stdin.write(payload, () => { trace.push('write-callback'); throw callbackError; });
  assert.equal(accepted, false, 'large write should report backpressure synchronously');
  await drained;
  await tasks.idle();
  child.stdin.end(() => trace.push('end-callback'));
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  await tasks.idle();

  assert.equal(output, String(Buffer.byteLength(payload)));
  assert.ok(trace.includes('drain'));
  assert.ok(trace.includes('write-callback'));
  assert.ok(trace.includes('end-callback'));
  assert.deepEqual(nodeErrors, [drainError, callbackError]);
});

test('child stdin drops pending guest callbacks on scheduler shutdown', async () => {
  const nodeErrors = [], tasks = guestTasks(nodeErrors);
  const service = createSubprocesses({ tasks: () => tasks,
    resolveDirectory: () => temporaryDirectory('subprocess-stdin-stop-'), openExternal: () => true });
  const child = service.api.spawn(process.execPath, ['-e',
    'process.on("SIGTERM",()=>{});process.stdin.resume();setInterval(()=>{},60000);']);
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  let callbackRan = false;
  child.stdin.write(Buffer.alloc(1024 * 1024), () => { callbackRan = true; });
  tasks.stop();
  await service.stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(callbackRan, false);
  assert.deepEqual(nodeErrors, []);
});

test('child stdin errors reach guest error listeners through the Node dispatcher', async t => {
  const nodeErrors = [], tasks = guestTasks(nodeErrors);
  const service = createSubprocesses({ tasks: () => tasks,
    resolveDirectory: () => temporaryDirectory('subprocess-stdin-error-'), openExternal: () => true });
  t.after(async () => { await service.stop(); tasks.stop(); });

  const listenerError = new Error('stdin error listener');
  const child = service.api.spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 10)']);
  child.stdin.on('error', () => { throw listenerError; });
  child.stdin.write(Buffer.alloc(4 * 1024 * 1024));
  await new Promise(resolve => child.once('close', resolve));
  await tasks.idle();
  assert.deepEqual(nodeErrors, [listenerError]);
});

test('session shutdown settles owned subprocesses and rejects later launches', async () => {
  const root = temporaryDirectory('subprocess-stop-');
  const service = createSubprocesses({ tasks: () => ({ enqueue: callback => setImmediate(callback) }),
    resolveDirectory: () => root, openExternal: () => true });
  const child = service.api.spawn(process.execPath, ['-e',
    'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},60000);']);
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  await service.stop();
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  assert.throws(() => service.api.spawn(process.execPath, []), { code: 'ERR_RUNTIME_STOPPED' });
  assert.throws(() => service.api.exec('open https://example.com/after-stop'), { code: 'ERR_RUNTIME_STOPPED' });
});
