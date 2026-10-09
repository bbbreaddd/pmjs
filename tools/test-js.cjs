'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const nativeReferences = new Set(['text-layout-reference.test.cjs', 'pixi-filter-boundary-reference.test.cjs']);
const tests = fs.readdirSync(path.join(root, 'test')).sort()
  .filter(name => name.endsWith('.test.cjs') && !nativeReferences.has(name))
  .map(name => path.join(root, 'test', name));
const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status === null ? 1 : result.status;
