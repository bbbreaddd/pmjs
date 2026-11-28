'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const testRoot = path.join(root, 'test');
function listTests(directory = testRoot) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTests(filename);
    if (!entry.isFile() || !entry.name.endsWith('.test.cjs')) return [];
    return [filename];
  }).sort();
}

const args = process.argv.slice(2);
const hasFileSelection = args.some(argument =>
  /\.test\.(?:cjs|mjs|js)$/.test(argument) || argument.includes('*') ||
  argument === 'test' || argument.startsWith('test/') || argument === './test' ||
  argument.startsWith('./test/') ||
  (path.isAbsolute(argument) && argument.startsWith(testRoot + path.sep)));
const files = hasFileSelection ? [] : listTests();
const result = spawnSync(process.execPath, ['--test', ...args, ...files], {
  cwd: root,
  stdio: 'inherit'
});

if (result.error) {
  process.stderr.write(`test-js: ${result.error.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status === null ? 1 : result.status;
}
