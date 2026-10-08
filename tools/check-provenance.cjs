'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const inventory = JSON.parse(fs.readFileSync(path.join(root, 'third_party/provenance.json')));
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z',
  'js', 'src', 'runner', 'tools', 'test', 'third_party', 'example', 'cmake'], { cwd: root }).toString().split('\0').filter(Boolean);
const errors = [];
for (const file of Object.keys(inventory.files)) {
  if (path.isAbsolute(file) || file.split('/').includes('..')) {
    errors.push('Invalid inventory path: ' + file);
  } else if (!fs.existsSync(path.join(root, file))) {
    errors.push('Stale inventory entry: ' + file);
  }
}
for (const file of new Set([...files, ...Object.keys(inventory.files)])) {
  if (path.isAbsolute(file) || file.split('/').includes('..')) continue;
  if (!fs.existsSync(path.join(root, file))) continue;
  if (file === 'third_party/provenance.json') continue;
  const explicit = inventory.files[file];
  if (!explicit && (/^js\/pmjs-plugins\/.*\.js$/.test(file) ||
      /^third_party\//.test(file) || file === 'js/pmjs-web/fallback-font.js')) {
    errors.push('Unclassified file: ' + file); continue;
  }
  const entry = explicit && explicit.origin === 'original' ?
    Object.assign({}, inventory.defaults, explicit) : explicit || inventory.defaults;
  if (!entry) { errors.push('Missing default metadata: ' + file); continue; }
  if (!['original', 'compatibility', 'permissive'].includes(entry.origin)) {
    errors.push('Invalid origin: ' + file);
  }
  if (!entry.source || !entry.license || !entry.notice) errors.push('Incomplete provenance: ' + file);
  if (!entry.revision && entry.origin === 'permissive') errors.push('Missing revision: ' + file);
  if (!entry.notice || path.isAbsolute(entry.notice) || entry.notice.split('/').includes('..') ||
      !fs.existsSync(path.join(root, entry.notice))) errors.push('Missing notice: ' + file);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log('Provenance inventory checks passed.');
