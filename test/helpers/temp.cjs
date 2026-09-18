'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const directories = new Set();

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
