'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const readerFinalizer = new FinalizationRegistry(descriptor => fs.closeSync(descriptor));

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function createStorage(root) {
  const saveRoot = path.resolve(root);
  makeDirectory(saveRoot);
  let temporaryId = 0;
  // Advance before mutation attempts, including failures after partial changes.
  let mutationGeneration = 0;

  function makeDirectory(directory) {
    const first = fs.mkdirSync(directory, { recursive: true });
    if (!first) return;
    for (let current = directory; ; current = path.dirname(current)) {
      syncDirectory(current);
      if (current === path.dirname(first)) break;
    }
    return first;
  }
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
    openRead(relative, start = 0) {
      if (!Number.isSafeInteger(start) || start < 0) throw new RangeError('invalid read position');
      let descriptor;
      try { descriptor = fs.openSync(resolve(relative), 'r'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      let position = start;
      const token = {};
      const reader = {
        read(maxBytes) {
          if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 0xffffffff) {
            throw new RangeError('invalid read size');
          }
          const bytes = Buffer.allocUnsafe(maxBytes);
          const count = fs.readSync(descriptor, bytes, 0, maxBytes, position);
          position += count;
          return bytes.subarray(0, count);
        },
        close() {
          if (descriptor === undefined) return;
          const captured = descriptor;
          descriptor = undefined;
          readerFinalizer.unregister(token);
          fs.closeSync(captured);
        }
      };
      readerFinalizer.register(reader, descriptor, token);
      return reader;
    },
    writeBytes(relative, contents) {
      mutationGeneration++;
      const destination = resolve(relative);
      makeDirectory(path.dirname(destination));
      const temporary = `${destination}.tmp-${process.pid}-${++temporaryId}`;
      let descriptor;
      try {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, contents);
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, destination);
        syncDirectory(path.dirname(destination));
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
      return makeDirectory(resolve(relative));
    },
    remove(relative) {
      mutationGeneration++;
      const destination = resolve(relative);
      try { fs.unlinkSync(destination); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      syncDirectory(path.dirname(destination));
    },
    rename(from, to) {
      mutationGeneration++;
      const source = resolve(from);
      const destination = resolve(to);
      makeDirectory(path.dirname(destination));
      fs.renameSync(source, destination);
      syncDirectory(path.dirname(destination));
      if (path.dirname(source) !== path.dirname(destination)) syncDirectory(path.dirname(source));
    },
  };
}

function createGameFilesystem(host, root) {
  if (typeof host.updateWritableOverlay !== 'function') {
    throw new Error('writable filesystem requires native overlay updates');
  }
  const overlayRoot = path.resolve(root);
  const files = createStorage(path.join(overlayRoot, 'files'));
  const deleted = createStorage(path.join(overlayRoot, 'deleted'));
  const transactions = createStorage(overlayRoot);
  const changedPaths = new Set();
  const changedMarkers = new Set();

  function normalize(relative) {
    const value = String(relative).replace(/\\/g, '/');
    const normalized = path.posix.normalize(value);
    if (!value || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
      throw new Error(`invalid game write path: ${relative}`);
    }
    return normalized.replace(/\/$/, '');
  }
  const key = name => name.replace(/[A-Z]/g, value => value.toLowerCase());
  const marker = name => createHash('sha256').update(key(name)).digest('hex');
  function hide(name) {
    changedMarkers.add(marker(name));
    deleted.writeText(marker(name), key(name));
  }
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
    files.makeDirectory(path.relative(path.join(overlayRoot, 'files'), path.dirname(physical(name))) || '.');
  }
  function publish() {
    if (!changedPaths.size && !changedMarkers.size) return;
    host.updateWritableOverlay(Array.from(changedPaths, name =>
      path.relative(path.join(overlayRoot, 'files'), physical(name))), Array.from(changedMarkers));
    changedPaths.clear(); changedMarkers.clear();
  }
  function mutate(names, operation) {
    try {
      if (recoverRename()) publish();
      names.filter(name => name !== '.').forEach(name => changedPaths.add(name));
      return operation();
    }
    finally { publish(); }
  }
  function recoverRename(cleanOrphans = false) {
    const contents = transactions.readText('rename.json');
    const intent = contents === null ? null : JSON.parse(contents);
    let source, destination;
    if (contents !== null && (!intent || typeof intent.source !== 'string' ||
        typeof intent.destination !== 'string' || typeof intent.staging !== 'string' ||
        typeof intent.directory !== 'boolean')) {
      throw new Error('invalid game filesystem rename journal');
    }
    if (intent) {
      source = normalize(intent.source); destination = normalize(intent.destination);
      if (!/^rename-[a-zA-Z0-9]+$/.test(intent.staging) || source === '.' || destination === '.') {
        throw new Error('invalid game filesystem rename journal');
      }
    }
    if (cleanOrphans) {
      let removed = false;
      for (const entry of fs.readdirSync(overlayRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && /^rename-[a-zA-Z0-9]+$/.test(entry.name) &&
            (!intent || entry.name !== intent.staging)) {
          fs.rmSync(path.join(overlayRoot, entry.name), { recursive: true, force: true });
          removed = true;
        }
      }
      if (removed) syncDirectory(overlayRoot);
    }
    if (!intent) return;
    changedPaths.add(source); changedPaths.add(destination);
    const staging = path.join(overlayRoot, intent.staging);
    const value = path.join(staging, 'value');
    if (fs.existsSync(value)) {
      if (intent.directory && fs.existsSync(physical(destination))) fs.rmdirSync(physical(destination));
      transactions.rename(intent.staging + '/value', path.relative(overlayRoot, physical(destination)));
    }
    hide(source);
    if (intent.directory) hide(destination);
    const sourcePath = physical(source);
    if (fs.existsSync(sourcePath)) {
      fs.rmSync(sourcePath, { recursive: true, force: true });
      syncDirectory(path.dirname(sourcePath));
    }
    fs.rmSync(staging, { recursive: true, force: true });
    transactions.remove('rename.json');
    return true;
  }
  function copy(name, destination) {
    if (host.isDirectory(name)) {
      transactions.makeDirectory(path.relative(overlayRoot, destination));
      for (const child of host.readDirectory(name)) copy(name + '/' + child, path.join(destination, child));
    } else {
      const bytes = host.readBytes(name);
      if (bytes === null) throw error('ENOENT', name);
      transactions.writeBytes(path.relative(overlayRoot, destination), Buffer.from(bytes));
    }
  }
  recoverRename(true);
  host.mountWritableOverlay(overlayRoot);
  changedPaths.clear(); changedMarkers.clear();
  return Object.assign(host, {
    writeBytes(relative, contents) {
      const name = normalize(relative);
      return mutate([name], () => {
        if (host.isDirectory(name)) throw error('EISDIR', name);
        parents(name);
        const destination = path.relative(path.join(overlayRoot, 'files'), physical(name));
        files.writeBytes(destination, contents);
      });
    },
    makeDirectory(relative, options = {}) {
      const name = normalize(relative);
      return mutate([name], () => {
        if (host.exists(name)) {
          if (options && options.recursive && host.isDirectory(name)) return;
          throw error('EEXIST', name);
        }
        if (!(options && options.recursive)) parents(name);
        else {
          let parent = path.posix.dirname(name);
          while (parent !== '.') {
            if (host.exists(parent) && !host.isDirectory(parent)) throw error('ENOTDIR', parent);
            parent = path.posix.dirname(parent);
          }
        }
        files.makeDirectory(path.relative(path.join(overlayRoot, 'files'), physical(name)));
      });
    },
    remove(relative) {
      const name = normalize(relative);
      return mutate([name], () => {
        if (!host.exists(name)) throw error('ENOENT', name);
        if (host.isDirectory(name)) throw error('EISDIR', name);
        hide(name);
        const filename = physical(name);
        if (fs.existsSync(filename)) {
          fs.unlinkSync(filename);
          syncDirectory(path.dirname(filename));
        }
      });
    },
    rename(from, to) {
      const source = normalize(from), destination = normalize(to);
      return mutate([source, destination], () => {
        if (source === '.' || destination === '.') throw error('EBUSY', source);
        if (!host.exists(source)) throw error('ENOENT', source);
        if (key(source) === key(destination)) return;
        if (key(destination).startsWith(key(source) + '/')) throw error('EINVAL', destination);
        const directory = host.isDirectory(source);
        if (host.exists(destination)) {
          if (host.isDirectory(destination) && key(source).startsWith(key(destination) + '/')) {
            throw error('ENOTEMPTY', destination);
          }
          if (directory !== host.isDirectory(destination)) throw error(directory ? 'ENOTDIR' : 'EISDIR', destination);
          if (directory && host.readDirectory(destination).length) throw error('ENOTEMPTY', destination);
        }
        parents(destination);
        const staging = fs.mkdtempSync(path.join(overlayRoot, 'rename-'));
        try {
          copy(source, path.join(staging, 'value'));
          // Publish recovery intent before changing either visible path.
          transactions.writeText('rename.json', JSON.stringify({ source, destination, directory,
            staging: path.basename(staging) }));
          recoverRename();
        } finally {
          // A committed intent retains its staging tree until recovery completes.
          if (!transactions.exists('rename.json')) fs.rmSync(staging, { recursive: true, force: true });
        }
      });
    }
  });
}

module.exports = { createStorage, createGameFilesystem };
