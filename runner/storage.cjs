'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createStorage(root) {
  const saveRoot = path.resolve(root);
  fs.mkdirSync(saveRoot, { recursive: true });
  let temporaryId = 0;

  function resolve(relative) {
    const value = String(relative).replace(/\\/g, '/');
    if (!value || value.startsWith('/') || value.split('/').includes('..')) {
      throw new Error(`invalid save path: ${relative}`);
    }
    const resolved = path.resolve(saveRoot, value);
    if (resolved !== saveRoot && !resolved.startsWith(saveRoot + path.sep)) {
      throw new Error(`save path escapes root: ${relative}`);
    }
    return resolved;
  }

  return {
    readText(relative) {
      try { return fs.readFileSync(resolve(relative), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    writeText(relative, contents) {
      const destination = resolve(relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.tmp-${process.pid}-${++temporaryId}`;
      let descriptor;
      try {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, String(contents), 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, destination);
        const directory = fs.openSync(path.dirname(destination), 'r');
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        try { fs.unlinkSync(temporary); } catch (_) {}
      }
    },
    exists: relative => fs.existsSync(resolve(relative)),
    isDirectory(relative) {
      try { return fs.statSync(resolve(relative)).isDirectory(); }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    },
    readDirectory(relative) {
      try { return fs.readdirSync(resolve(relative)); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    makeDirectory: relative => fs.mkdirSync(resolve(relative), { recursive: true }),
    remove(relative) {
      try { fs.unlinkSync(resolve(relative)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
    rename(from, to) {
      const destination = resolve(to);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(resolve(from), destination);
    },
  };
}

module.exports = { createStorage };
