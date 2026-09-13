'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tool = path.resolve(__dirname, '../tools/build-js-runtime.mjs');
test('bundle generation is deterministic and confined to the explicit root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-bundle-'));
  fs.writeFileSync(path.join(root, 'a.js'), 'one();\n');
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ modules: ['a.js'] }));
  const args = [tool, '--root', root, '--manifest', 'manifest.json', '--output', 'out.js'];
  childProcess.execFileSync(process.execPath, args);
  const first = fs.readFileSync(path.join(root, 'out.js'), 'utf8');
  childProcess.execFileSync(process.execPath, [...args, '--check']);
  assert.equal(fs.readFileSync(path.join(root, 'out.js'), 'utf8'), first);
  assert.throws(() => childProcess.execFileSync(process.execPath,
    [tool, '--root', root, '--manifest', 'manifest.json', '--output', '../escape.js']),
  /output must be inside root/);
});
