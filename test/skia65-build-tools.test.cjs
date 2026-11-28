'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');

test('ARM64 builds prepare dependencies before replacing an installation', () => {
  const result = spawnSync('python3', [path.resolve(__dirname, '../tools/build_test.py')], {
    encoding: 'utf8', env: { ...process.env, TMPDIR: temporaryDirectory('pmjs-build-test-') }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('LLVM strip selection accepts supported ARM64 tools', () => {
  const result = spawnSync('python3', [path.resolve(__dirname, '../tools/llvm_tools_test.py')], {
    encoding: 'utf8', env: { ...process.env, TMPDIR: temporaryDirectory('pmjs-strip-test-') }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('Skia component verification separates production and requested test inputs', () => {
  const result = spawnSync('python3', [path.resolve(__dirname, '../tools/skia65/artifact_test.py')], {
    encoding: 'utf8', env: { ...process.env, TMPDIR: temporaryDirectory('pmjs-skia-artifact-') }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('Skia source downloads verify contents independently of generated archive timestamps', () => {
  const result = spawnSync('python3', [path.resolve(__dirname, '../tools/skia65/provision_test.py')], {
    encoding: 'utf8', env: { ...process.env, TMPDIR: temporaryDirectory('pmjs-skia-provision-') }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('Skia raster cache preserves pinned sources and archive integrity', () => {
  const result = spawnSync('python3', [path.resolve(__dirname, '../tools/skia65/build_test.py')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
