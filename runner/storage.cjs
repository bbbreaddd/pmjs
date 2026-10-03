'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createStorage(root) {
  const saveRoot = path.resolve(root);
  fs.mkdirSync(saveRoot, { recursive: true });
  let temporaryId = 0;
  // Advance before mutation attempts, including failures after partial changes.
  let mutationGeneration = 0;

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
    generation() { return mutationGeneration; },
    readText(relative) {
      try { return fs.readFileSync(resolve(relative), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    readBytes(relative) {
      try { return fs.readFileSync(resolve(relative)); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    writeBytes(relative, contents) {
      mutationGeneration++;
      const destination = resolve(relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.tmp-${process.pid}-${++temporaryId}`;
      let descriptor;
      try {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, contents);
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
    writeText(relative, contents) { return this.writeBytes(relative, Buffer.from(String(contents), 'utf8')); },
    exists: relative => fs.existsSync(resolve(relative)),
    isDirectory(relative) {
      try { return fs.statSync(resolve(relative)).isDirectory(); }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    },
    readDirectory(relative) {
      try { return fs.readdirSync(relative === '' ? saveRoot : resolve(relative)); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    makeDirectory(relative) {
      mutationGeneration++;
      return fs.mkdirSync(resolve(relative), { recursive: true });
    },
    remove(relative) {
      mutationGeneration++;
      try { fs.unlinkSync(resolve(relative)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
    rename(from, to) {
      mutationGeneration++;
      const destination = resolve(to);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(resolve(from), destination);
    },
  };
}

function createGameFilesystem(host, root) {
  const overlayRoot = path.resolve(root);
  const files = createStorage(path.join(overlayRoot, 'files'));
  const deleted = createStorage(path.join(overlayRoot, 'deleted'));
  host.mountWritableOverlay(overlayRoot);

  function normalize(relative) {
    const value = String(relative).replace(/\\/g, '/');
    const normalized = path.posix.normalize(value);
    if (!value || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
      throw new Error(`invalid game write path: ${relative}`);
    }
    return normalized.replace(/\/$/, '');
  }
  const key = name => name.replace(/[A-Z]/g, value => value.toLowerCase());
  const marker = name => Buffer.from(key(name)).toString('hex');
  function error(code, name) {
    return Object.assign(new Error(`${code}: ${name}`), { code });
  }
  function physical(name) {
    let directory = path.join(overlayRoot, 'files');
    for (const component of name.split('/')) {
      const entries = fs.existsSync(directory) && fs.statSync(directory).isDirectory()
        ? fs.readdirSync(directory) : [];
      directory = path.join(directory, entries.find(entry => key(entry) === key(component)) || component);
    }
    return directory;
  }
  function parents(name) {
    const parent = path.posix.dirname(name);
    if (!host.isDirectory(parent)) throw error(host.exists(parent) ? 'ENOTDIR' : 'ENOENT', parent);
    fs.mkdirSync(path.dirname(physical(name)), { recursive: true });
  }
  function mutate(operation) {
    try { return operation(); }
    finally { host.mountWritableOverlay(overlayRoot); }
  }
  function copy(name, destination) {
    if (host.isDirectory(name)) {
      fs.mkdirSync(destination);
      for (const child of host.readDirectory(name)) copy(name + '/' + child, path.join(destination, child));
    } else {
      const bytes = host.readBytes(name);
      if (bytes === null) throw error('ENOENT', name);
      fs.writeFileSync(destination, Buffer.from(bytes));
    }
  }
  return Object.assign(host, {
    writeBytes(relative, contents) {
      const name = normalize(relative);
      return mutate(() => {
        if (host.isDirectory(name)) throw error('EISDIR', name);
        parents(name);
        const destination = path.relative(path.join(overlayRoot, 'files'), physical(name));
        files.writeBytes(destination, contents);
      });
    },
    makeDirectory(relative, options = {}) {
      const name = normalize(relative);
      return mutate(() => {
        if (host.exists(name)) {
          if (options.recursive && host.isDirectory(name)) return;
          throw error('EEXIST', name);
        }
        if (!options.recursive) parents(name);
        else {
          let parent = path.posix.dirname(name);
          while (parent !== '.') {
            if (host.exists(parent) && !host.isDirectory(parent)) throw error('ENOTDIR', parent);
            parent = path.posix.dirname(parent);
          }
        }
        fs.mkdirSync(physical(name), { recursive: !!options.recursive });
      });
    },
    remove(relative) {
      const name = normalize(relative);
      return mutate(() => {
        if (!host.exists(name)) throw error('ENOENT', name);
        if (host.isDirectory(name)) throw error('EISDIR', name);
        deleted.writeText(marker(name), '');
        if (fs.existsSync(physical(name))) fs.unlinkSync(physical(name));
      });
    },
    rename(from, to) {
      const source = normalize(from), destination = normalize(to);
      return mutate(() => {
        if (!host.exists(source)) throw error('ENOENT', source);
        if (key(source) === key(destination)) return;
        if (key(destination).startsWith(key(source) + '/')) throw error('EINVAL', destination);
        const directory = host.isDirectory(source);
        if (host.exists(destination)) {
          if (directory !== host.isDirectory(destination)) throw error(directory ? 'ENOTDIR' : 'EISDIR', destination);
          if (directory && host.readDirectory(destination).length) throw error('ENOTEMPTY', destination);
        }
        parents(destination);
        const staging = fs.mkdtempSync(path.join(overlayRoot, 'rename-'));
        try {
          copy(source, path.join(staging, 'value'));
          if (directory && fs.existsSync(physical(destination))) fs.rmdirSync(physical(destination));
          fs.renameSync(path.join(staging, 'value'), physical(destination));
          deleted.writeText(marker(source), '');
          // A replaced base directory must not contribute old children after restart.
          if (directory) deleted.writeText(marker(destination), '');
          fs.rmSync(physical(source), { recursive: true, force: true });
        } finally { fs.rmSync(staging, { recursive: true, force: true }); }
      });
    }
  });
}

module.exports = { createStorage, createGameFilesystem };
