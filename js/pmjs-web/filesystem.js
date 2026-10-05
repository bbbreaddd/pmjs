var posixPath = globalThis.__pmjsBuiltinRequire('path').posix;
function normalizePath(path) {
  return posixPath.normalize(String(path).replace(/\\/g, '/'));
}
function dirname(path) { return posixPath.dirname(path); }

function gamePath(path) {
  var normalized = normalizePath(path);
  if (normalized === '/game') return '.';
  if (normalized.indexOf('/game/') === 0) return normalized.slice(6);
  return normalized.charAt(0) === '/' ? normalized.slice(1) : normalized;
}

function gameReadPath(path) {
  var resolved = gamePath(path);
  var aliases = PMJS.config.virtualFiles &&
    PMJS.config.virtualFiles.extensionAliases || {};
  var extension = pathModule.extname(resolved);
  var replacement = aliases[extension.toLowerCase()];
  return replacement === undefined
    ? resolved : resolved.slice(0, -extension.length) + replacement;
}

function gameDirectoryEntries(path, entries) {
  var aliases = PMJS.config.virtualFiles &&
    PMJS.config.virtualFiles.directoryEntryAliases || {};
  var directories = normalizePath(path).replace(/\/$/, '').toLowerCase().split('/');
  var extensions;
  for (var index = directories.length - 1; index >= 0; index--) {
    extensions = aliases[directories[index]];
    if (extensions) break;
  }
  if (!extensions) return entries;
  return entries.map(function(name) {
    var extension = pathModule.extname(name);
    var replacement = extensions[extension.toLowerCase()];
    return replacement === undefined
      ? name : name.slice(0, -extension.length) + replacement;
  });
}

function writablePath(path) {
  var normalized = normalizePath(path);
  if (normalized === '/save' || normalized === '/save/') return '';
  return normalized.indexOf('/save/') === 0 ? normalized.slice(6) : null;
}

var pathModule = Object.assign({}, posixPath, {
  resolve: function() {
    return posixPath.resolve.apply(posixPath, ['/game'].concat(Array.prototype.slice.call(arguments)));
  },
  relative: function(from, to) {
    return posixPath.relative(pathModule.resolve(from), pathModule.resolve(to));
  }
});
pathModule.posix = pathModule;

function fsReadContents(path, options) {
  var writable = writablePath(path);
  var encoding = typeof options === 'string' ? options : options && options.encoding;
  var host = writable !== null && NativeHost.storage ? NativeHost.storage : NativeHost.fs;
  var resolved = writable !== null && NativeHost.storage ? writable : gameReadPath(path);
  var result = host.readBytes(resolved);
  var missingFiles = PMJS.config.missingTextFiles || {};
  if (result === null && writable !== null &&
      Object.prototype.hasOwnProperty.call(missingFiles, writable)) {
    result = Buffer.from(String(missingFiles[writable]), 'utf8');
  }
  if (result === null) {
    var error = new Error('ENOENT: ' + path);
    error.code = 'ENOENT';
    throw error;
  }
  var buffer = ArrayBuffer.isView(result)
    ? Buffer.from(result.buffer, result.byteOffset, result.byteLength)
    : Buffer.from(result);
  return encoding ? buffer.toString(encoding) : Buffer.from(buffer);
}

function FsReadStream(path, options) {
  options = typeof options === 'string' ? { encoding: options } : options || {};
  var start = options.start === undefined ? 0 : options.start;
  var end = options.end === undefined ? Infinity : options.end;
  function validateRange(value, name, infinity) {
    var error;
    if (typeof value !== 'number') {
      error = new TypeError(name + ' must be a number'); error.code = 'ERR_INVALID_ARG_TYPE';
    } else if (!(infinity && value === Infinity) && (!Number.isSafeInteger(value) || value < 0)) {
      error = new RangeError(name + ' must be a non-negative safe integer'); error.code = 'ERR_OUT_OF_RANGE';
    }
    if (error) throw error;
  }
  validateRange(start, 'start', false);
  validateRange(end, 'end', true);
  if (start > end) {
    var rangeError = new RangeError('start must not exceed end');
    rangeError.code = 'ERR_OUT_OF_RANGE'; throw rangeError;
  }
  var Readable = globalThis.__pmjsBuiltinRequire('stream').Readable;
  var reader, demand = 0, queued = false, position = start;
  function scheduleRead() {
    if (!reader || !demand || queued || stream.destroyed) return;
    queued = true;
    PMJS.tasks.enqueue(function() {
      queued = false;
      if (stream.destroyed) return;
      var size = Math.min(demand, end === Infinity ? Infinity : end - position + 1);
      demand = 0;
      var contents;
      try { contents = reader.read(size); }
      catch (error) { stream.destroy(error); return; }
      position += contents.byteLength;
      if (!contents.byteLength) { stream.push(null); return; }
      stream.push(contents);
      if (!stream.destroyed && position > end) stream.push(null);
    });
  }
  var stream = new Readable({
    encoding: options.encoding,
    highWaterMark: options.highWaterMark === undefined ? 64 * 1024 : options.highWaterMark,
    read: function(size) { demand = size || 1; scheduleRead(); },
    destroy: function(error, callback) {
      try { if (reader) reader.close(); }
      catch (closeError) { error = error || closeError; }
      reader = null;
      callback(error);
    }
  });
  stream.path = path;
  PMJS.tasks.enqueue(function() {
    if (stream.destroyed) return;
    try {
      var writable = writablePath(path);
      var host = writable !== null && NativeHost.storage ? NativeHost.storage : NativeHost.fs;
      var resolved = writable !== null && NativeHost.storage ? writable : gameReadPath(path);
      reader = host.openRead(resolved, start);
      var missingFiles = PMJS.config.missingTextFiles || {};
      if (!reader && writable !== null && Object.prototype.hasOwnProperty.call(missingFiles, writable)) {
        var bytes = Buffer.from(String(missingFiles[writable]), 'utf8'), offset = start;
        reader = { read: function(size) {
          var chunk = bytes.subarray(offset, offset + size); offset += chunk.length; return chunk;
        }, close: function() { bytes = null; } };
      }
      if (!reader) {
        var error = new Error('ENOENT: ' + path); error.code = 'ENOENT'; throw error;
      }
    } catch (error) { stream.destroy(error); return; }
    stream.emit('open', 0);
    stream.emit('ready');
    scheduleRead();
  });
  return stream;
}

var fsModule = {
  existsSync: function(path) {
    var writable = writablePath(path);
    return writable !== null && NativeHost.storage
      ? (writable === '' || NativeHost.storage.exists(writable))
      : NativeHost.fs.exists(gameReadPath(path));
  },
  readFileSync: function(path, options) {
    return fsReadContents(path, options);
  },
  readFile: function(path, options, callback) {
    if (typeof options === 'function') { callback = options; options = null; }
    var result = null, error = null;
    try { result = fsReadContents(path, options); } catch (caught) { error = caught; }
    PMJS.tasks.enqueue(function() {
      callback(error, result);
    });
  },
  createReadStream: function(path, options) { return new FsReadStream(path, options); },
  writeFileSync: function(path, contents, options) {
    var writable = writablePath(path);
    var host = writable !== null ? NativeHost.storage : NativeHost.fs;
    if (!host) throw new Error('EACCES: ' + path);
    var encoding = typeof options === 'string' ? options : options && options.encoding;
    var bytes = ArrayBuffer.isView(contents)
      ? Buffer.from(contents.buffer, contents.byteOffset, contents.byteLength)
      : Buffer.from(String(contents), encoding || 'utf8');
    var resolved = writable !== null ? writable : gameReadPath(path);
    if (typeof host.writeBytes === 'function') host.writeBytes(resolved, bytes);
    else if (writable !== null && typeof contents === 'string' && (!encoding || encoding === 'utf8')) {
      host.writeText(resolved, contents);
    } else throw new Error('filesystem byte writes are unavailable');
  },
  writeFile: function(path, contents, options, callback) {
    if (typeof options === 'function') { callback = options; options = null; }
    var error = null;
    try { this.writeFileSync(path, contents, options); } catch (caught) { error = caught; }
    PMJS.tasks.enqueue(function() { if (callback) callback(error); });
  },
  appendFileSync: function(path, contents, options) {
    var previous;
    try { previous = fsReadContents(path); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      previous = Buffer.alloc(0);
    }
    var encoding = typeof options === 'string' ? options : options && options.encoding;
    var bytes = ArrayBuffer.isView(contents)
      ? Buffer.from(contents.buffer, contents.byteOffset, contents.byteLength)
      : Buffer.from(String(contents), encoding || 'utf8');
    fsModule.writeFileSync(path, Buffer.concat([previous, bytes]));
  },
  mkdirSync: function(path, options) {
    var writable = writablePath(path);
    var host = writable !== null ? NativeHost.storage : NativeHost.fs;
    if (!host) throw new Error('EACCES: ' + path);
    if (writable !== '') host.makeDirectory(writable !== null ? writable : gamePath(path), options);
  },
  mkdir: function(path, options, callback) {
    if (typeof options === 'function') { callback = options; options = null; }
    var error = null;
    try { this.mkdirSync(path, options); } catch (caught) { error = caught; }
    PMJS.tasks.enqueue(function() { if (callback) callback(error); });
  },
  unlinkSync: function(path) {
    var writable = writablePath(path);
    var host = writable !== null ? NativeHost.storage : NativeHost.fs;
    if (!host) throw new Error('EACCES: ' + path);
    host.remove(writable !== null ? writable : gameReadPath(path));
  },
  unlink: function(path, callback) {
    var error = null;
    try { this.unlinkSync(path); } catch (caught) { error = caught; }
    PMJS.tasks.enqueue(function() { if (callback) callback(error); });
  },
  renameSync: function(from, to) {
    var source = writablePath(from);
    var destination = writablePath(to);
    if ((source === null) !== (destination === null)) {
      var error = new Error('EXDEV: ' + from);
      error.code = 'EXDEV';
      throw error;
    }
    var host = source !== null ? NativeHost.storage : NativeHost.fs;
    host.rename(source !== null ? source : gameReadPath(from),
      destination !== null ? destination : gameReadPath(to));
  },
  rename: function(from, to, callback) {
    var error = null;
    try { this.renameSync(from, to); } catch (caught) { error = caught; }
    PMJS.tasks.enqueue(function() { if (callback) callback(error); });
  },
  readdirSync: function(path) {
    var writable = writablePath(path);
    var entries = writable !== null && NativeHost.storage
      ? NativeHost.storage.readDirectory(writable)
      : NativeHost.fs.readDirectory(gamePath(path));
    if (entries === null) throw new Error('ENOENT: ' + path);
    return gameDirectoryEntries(path, entries);
  },
  statSync: function(path) {
    var writable = writablePath(path);
    var exists, directory;
    if (writable !== null && NativeHost.storage) {
      exists = writable === '' || NativeHost.storage.exists(writable);
      directory = exists && (writable === '' || NativeHost.storage.isDirectory(writable));
    } else {
      var resolved = gameReadPath(path);
      exists = NativeHost.fs.exists(resolved);
      directory = exists && NativeHost.fs.isDirectory(resolved);
    }
    if (!exists) {
      var error = new Error('ENOENT: ' + path);
      error.code = 'ENOENT';
      throw error;
    }
    return { isDirectory: function() { return directory; },
      isFile: function() { return !directory; } };
  },
  stat: function(path, options, callback) {
    if (typeof options === 'function') { callback = options; options = null; }
    if (typeof callback !== 'function') throw new TypeError('stat requires a callback');
    var result, error = null;
    try { result = fsModule.statSync(path, options); } catch (caught) { error = caught; }
    PMJS.tasks.enqueue(function() { callback(error, result); });
  }
};
