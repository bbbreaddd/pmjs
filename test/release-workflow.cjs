'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-release-contract-'));
try {
  const stage = path.join(temporary, 'relocated runtime');
  fs.cpSync(path.resolve(process.argv[2]), stage, { recursive: true });
  const game = path.join(temporary, 'game with spaces');
  const state = path.join(temporary, 'prepared state');
  fs.mkdirSync(path.join(game, 'js/libs'), { recursive: true });
  fs.writeFileSync(path.join(game, 'js/rpg_core.js'), 'Utils.RPGMAKER_VERSION = "1.6.2";');
  fs.writeFileSync(path.join(game, 'js/rpg_managers.js'), '');
  fs.writeFileSync(path.join(game, 'js/libs/pixi.js'), 'PIXI.VERSION = "4.5.4";');
  fs.writeFileSync(path.join(game, 'js/libs/pixi-tilemap.js'), '');
  fs.writeFileSync(path.join(game, 'js/plugins.js'), 'var $plugins = [];');
  const config = path.join(temporary, 'config.json');
  fs.writeFileSync(config, '{}');
  const manifest = path.join(temporary, 'adapters.json');
  fs.writeFileSync(manifest, '{"adapters":"auto"}');
  function cli(...args) {
    return spawnSync(path.join(stage, 'bin/pmjs'), args, { cwd: temporary, encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', LD_LIBRARY_PATH: '' } });
  }
  const version = cli('--version');
  assert.equal(version.status, 0, version.stdout + version.stderr);
  assert.match(version.stdout, /^PMJS /);
  const help = cli('--help');
  assert.equal(help.status, 0, help.stdout + help.stderr);
  assert.match(help.stdout, /pmjs prepare --game DIR/);
  const unprepared = cli('run', '--game', game, '--state', state);
  assert.notEqual(unprepared.status, 0);
  assert.match(unprepared.stderr, /has not been prepared/);
  assert.equal(fs.existsSync(state), false, 'running does not prepare the game');
  const prepared = cli('prepare', '--game', game, '--state', state, '--config', config, '--manifest', manifest);
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  const record = fs.readFileSync(path.join(state, 'prepared.json'), 'utf8');
  const broken = cli('prepare', '--game', game, '--state', state, '--config', path.join(temporary, 'missing.json'));
  assert.notEqual(broken.status, 0);
  assert.equal(fs.readFileSync(path.join(state, 'prepared.json'), 'utf8'), record,
    'failed preparation preserves the working preparation record');
  fs.writeFileSync(config, '{"title":"Changed"}');
  const stale = cli('run', '--game', game, '--state', state);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /prepare again/);
  fs.writeFileSync(config, '{}');
  for (const file of [manifest, path.join(game, 'js/plugins.js'), path.join(game, 'js/libs/pixi.js'),
    path.join(game, 'js/rpg_core.js')]) {
    const original = fs.readFileSync(file);
    fs.appendFileSync(file, '\n ');
    const changed = cli('run', '--game', game, '--state', state);
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /prepare again/);
    fs.writeFileSync(file, original);
  }
  fs.writeFileSync(path.join(game, 'js/pixi.js'), 'PIXI.VERSION = "4.8.0";');
  assert.match(cli('run', '--game', game, '--state', state).stderr, /prepare again/);
  fs.rmSync(path.join(game, 'js/pixi.js'));
  const bootstrap = path.join(state, JSON.parse(record).bootstrap);
  fs.appendFileSync(bootstrap, '\n// damaged\n');
  const damaged = cli('run', '--game', game, '--state', state);
  assert.notEqual(damaged.status, 0);
  assert.match(damaged.stderr, /prepare again/);
  const packageSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(stage, 'build-info.json'))).digest('hex');
  const report = path.join(temporary, 'verification.json');
  function archive(verification, development = false) {
    fs.writeFileSync(report, JSON.stringify(verification));
    return spawnSync('python3', [path.resolve(__dirname, '../tools/release.py'), 'archive',
      '--stage', stage, '--report', report, '--output', path.join(temporary, 'release.tar.gz'),
      ...(development ? ['--development'] : [])],
    { encoding: 'utf8' });
  }
  const wrongPackage = archive({ schema: 1, packageSha256: '0'.repeat(64), static: 'passed' });
  assert.notEqual(wrongPackage.status, 0);
  assert.match(wrongPackage.stderr, /different package/);
  const noExecution = archive({ schema: 1, packageSha256, static: 'passed', smoke: null });
  assert.notEqual(noExecution.status, 0);
  assert.match(noExecution.stderr, /executed smoke test is required/);
  const incompleteReceipt = archive({ schema: 1, packageSha256, static: 'passed', smoke: { load: true } });
  assert.notEqual(incompleteReceipt.status, 0);
  assert.match(incompleteReceipt.stderr, /does not verify this exact package/);
  const load = cli('self-test');
  assert.equal(load.status, 0, load.stdout + load.stderr);
  const receipt = JSON.parse(load.stdout.trim().split('\n').at(-1));
  assert.equal(receipt.test, 'package-load');
  assert.equal(receipt.graphics, null);
  const loadOnly = archive({ schema: 1, packageSha256, static: 'passed', smoke: receipt });
  assert.notEqual(loadOnly.status, 0);
  assert.match(loadOnly.stderr, /require a graphics smoke receipt/);
  const development = archive({ schema: 1, packageSha256, static: 'passed', smoke: null }, true);
  assert.equal(development.status, 0, development.stdout + development.stderr);
  fs.chmodSync(path.join(stage, 'LICENSE'), 0o755);
  const synthesizedModes = cli('self-test');
  assert.equal(synthesizedModes.status, 0, synthesizedModes.stdout + synthesizedModes.stderr);
  fs.chmodSync(path.join(stage, 'bin/pmjs'), 0o644);
  const noExecutable = spawnSync(process.execPath, [path.join(stage, 'share/pmjs/tools/package-self-test.cjs'), stage],
    { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', LD_LIBRARY_PATH: '' } });
  assert.notEqual(noExecutable.status, 0, 'required executable access is checked');
  fs.chmodSync(path.join(stage, 'bin/pmjs'), 0o755);
  const extraFile = path.join(stage, 'lib/unexpected.so');
  fs.writeFileSync(extraFile, 'unexpected');
  const changedPayload = cli('self-test');
  assert.notEqual(changedPayload.status, 0);
  assert.match(changedPayload.stderr, /exact package payload/);
  fs.rmSync(extraFile);
  fs.appendFileSync(path.join(stage, 'share/pmjs/runner/cli.cjs'), '\n// damaged\n');
  const tampered = cli('self-test');
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /package checksum/);
  console.log('Installed preparation, relocation, archive gates and tamper checks passed');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
