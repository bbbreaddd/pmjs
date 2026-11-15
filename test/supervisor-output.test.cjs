'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');

test('session workers expose collection without requiring launcher flags', async () => {
  const directory = temporaryDirectory('supervisor-collection-');
  const worker = path.join(directory, 'worker.cjs');
  const resultFile = path.join(directory, 'collection.json');
  fs.writeFileSync(worker, `
    process.once('message', () => {
      require('node:fs').writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ gc: typeof global.gc }));
      process.send({ type: 'pmjs-session-complete', reload: false }, () => process.exit(0));
    });
  `);
  const { runSupervised } = require('../runner/supervisor.cjs');
  const result = await runSupervised({ saveRoot: path.join(directory, 'saves') }, { worker });
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(fs.readFileSync(resultFile, 'utf8')).gc, 'function');
});

for (const stream of ['stdout', 'stderr']) {
  test(`a broken ${stream} reader preserves worker logs across reloads`, async () => {
    const directory = temporaryDirectory('supervisor-output-');
    const worker = path.join(directory, 'worker.cjs');
    const parent = path.join(directory, 'parent.cjs');
    const resultFile = path.join(directory, 'result.json');
    fs.writeFileSync(worker, `
      setTimeout(() => process.exit(4), 2000);
      process.once('message', options => {
        process.${stream}.write('x'.repeat(32768));
        setTimeout(() => process.${stream}.write('LATE_WORKER_OUTPUT\\n',
          () => process.send({ type: 'pmjs-session-complete', reload: options.attempt === 1 },
            () => process.exit(0))), 50);
      });
    `);
    fs.writeFileSync(parent, `
      const fs = require('node:fs');
      let attempt = 0;
      require(${JSON.stringify(path.resolve(__dirname, '../runner/supervisor.cjs'))})
        .runSupervised(() => ({ saveRoot: ${JSON.stringify(path.join(directory, 'saves'))},
          attempt: ++attempt }),
          { worker: ${JSON.stringify(worker)} })
        .then(result => fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(result)));
    `);
    const child = spawn(process.execPath, [parent], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, killSignal: 'SIGKILL'
    });
    child[stream].destroy();
    const other = stream === 'stdout' ? 'stderr' : 'stdout';
    let diagnostics = '';
    child[other].on('data', chunk => { diagnostics += chunk; });
    const [code, signal] = await once(child, 'close');
    assert.equal(signal, null, diagnostics);
    assert.equal(code, 0, diagnostics);
    assert.equal(JSON.parse(fs.readFileSync(resultFile, 'utf8')).code, 0);
    const logs = path.join(directory, 'logs');
    const entries = fs.readdirSync(logs).sort();
    assert.equal(entries.length, 2);
    assert.match(fs.readFileSync(path.join(logs, entries[0]), 'utf8'),
      new RegExp('terminal-output-unavailable stream=' + stream));
    for (const entry of entries) {
      const content = fs.readFileSync(path.join(logs, entry), 'utf8');
      assert.match(content, /LATE_WORKER_OUTPUT/);
      assert.match(content, /session-exit code=0 signal=null/);
    }
  });
}

test('the real session worker stops when its supervisor crashes', async () => {
  const directory = temporaryDirectory('session-parent-loss-');
  const parent = path.join(directory, 'parent.cjs');
  const exitFile = path.join(directory, 'worker-exit.txt');
  const observer = path.join(directory, 'observe-exit.cjs');
  fs.writeFileSync(observer, `process.once('exit', code =>
    require('node:fs').writeFileSync(${JSON.stringify(exitFile)}, String(code)));`);
  fs.writeFileSync(parent, `
    const { fork } = require('node:child_process');
    const child = fork(${JSON.stringify(path.resolve(__dirname, '../runner/session.cjs'))}, [],
      { stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        execArgv: ['--require', ${JSON.stringify(observer)}] });
    child.once('message', () => {
      process.stdout.write(String(child.pid) + '\\n', () => process.kill(process.pid, 'SIGKILL'));
    });
  `);
  const child = spawn(process.execPath, [parent], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', diagnostics = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  const timeout = setTimeout(() => {
    child.kill('SIGKILL');
    const pid = Number(output.trim());
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
  }, 5000);
  try {
    // The worker inherits stderr, so close also waits for its descriptor to close.
    const [, signal] = await once(child, 'close');
    assert.equal(signal, 'SIGKILL');
    assert.match(diagnostics, /Supervisor connection lost; stopping session/);
    const pid = Number(output.trim());
    assert.ok(pid > 0);
    assert.equal(fs.readFileSync(exitFile, 'utf8'), '1');
  } finally { clearTimeout(timeout); }
});
