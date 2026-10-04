'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const directories = new Set();
const root = path.resolve(__dirname, '../../.cache/tests');

function temporaryDirectory(prefix) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(root, prefix));
  directories.add(directory);
  return directory;
}

function cleanup() {
  for (const directory of directories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  directories.clear();
}

test.after(cleanup);
process.once('exit', cleanup);

module.exports = { temporaryDirectory };
