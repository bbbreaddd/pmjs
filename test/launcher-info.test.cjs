'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { formatLauncherEnvironment, formatLauncherIdentity } = require('../runner/launcher-info.cjs');

test('launcher environment reports compact host and hardware details', () => {
  const line = formatLauncherEnvironment({
    reader: { readFileSync: file => file === '/proc/device-tree/model'
      ? 'Example Handheld\0' : file === '/proc/meminfo'
        ? 'MemTotal: 2097152 kB\nMemAvailable: 786432 kB\n'
        : 'mali_kbase 1 0 - Live 0x0\n' },
    osObject: {
      cpus: () => [{ model: 'Example ARM CPU' }, { model: 'Example ARM CPU' }],
      totalmem: () => 2 * 1024 * 1024 * 1024,
      freemem: () => 768 * 1024 * 1024,
      release: () => '6.1.0'
    },
    processObject: { platform: 'linux', arch: 'arm64', version: 'v22.0.0', versions: { napi: '10' } }
  });
  for (const field of ['arch=arm64', 'device="Example Handheld"', 'ram_total_mib=2048', 'gpu_kernel_modules=mali_kbase']) {
    assert.ok(line.includes(field), field);
  }
});

test('launcher environment tolerates unavailable device and CPU model information', () => {
  const line = formatLauncherEnvironment({
    reader: { readFileSync() { throw new Error('unavailable'); } },
    osObject: { cpus: () => [], totalmem: () => 1024 * 1024, release: () => 'kernel' },
    processObject: { platform: 'linux', arch: 'x64', version: 'v22.0.0', versions: {} }
  });
  assert.ok(line.includes('device="unknown"'));
  assert.ok(line.includes('gpu_kernel_modules=unknown'));
});

test('launcher identity identifies dirty or clean sources and omits absent build IDs', () => {
  const sha = 'a'.repeat(64);
  assert.equal(formatLauncherIdentity({ buildId: null, source: { dirty: true, commit: 'ignored' } }, sha),
    `[pmjs] launcher identity source=dirty build_info_sha256=${sha}`);
  assert.equal(formatLauncherIdentity({ buildId: 'build-42', source: { dirty: false, commit: 'c'.repeat(40) } }, sha),
    `[pmjs] launcher identity build=build-42 source=${'c'.repeat(40)} build_info_sha256=${sha}`);
});

test('--build-info remains an implemented, version-free launcher command', () => {
  const root = temporaryDirectory('pmjs-build-info-command-');
  fs.writeFileSync(path.join(root, 'build-info.json'), JSON.stringify({
    buildId: 'fixture-build', source: { dirty: true, commit: 'abc123' }
  }));
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../tools/pmjs.mjs'),
    root, '--build-info'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'PMJS build=fixture-build source=dirty');
});
