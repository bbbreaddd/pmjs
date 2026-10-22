var posixPath = globalThis.__pmjsBuiltinRequire('path').posix;
function normalizePath(path) {
  return posixPath.normalize(String(path).replace(/\\/g, '/'));
}
function dirname(path) { return posixPath.dirname(path); }

function decodeResourceUrlPath(url) {
  return decodeURIComponent(url.split('?')[0].replace(/%(?![0-9a-f]{2})/gi, '%25'));
}

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
  var host = writable !== null && NativeHost.storage ? NativeHost.storage : NativeHost.fs;
  var resolved = writable !== null && NativeHost.storage ? writable : gameReadPath(path);
  var result = host.readBytes(resolved);
  return fsDecodeContents(path, options, result);
}

function fsReadContentsAsync(path, options) {
  var writable = writablePath(path);
  var host = writable !== null && NativeHost.storage ? NativeHost.storage : NativeHost.fs;
  var resolved = writable !== null && NativeHost.storage ? writable : gameReadPath(path);
  return host.readBytesAsync(resolved).then(function(result) {
    return fsDecodeContents(path, options, result);
  });
}

function fsDecodeContents(path, options, result) {
  var writable = writablePath(path);
  var encoding = typeof options === 'string' ? options : options && options.encoding;
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

function fsCloseDiscardedReader(reader) {
  Promise.resolve().then(function() { return reader.close(); }).catch(function(error) {
    console.error('[pmjs] file close failed:', error);
  });
}

function fsReaderStopListener(reader) {
  // A shutdown listener must not retain an abandoned reader.
  var weak = new WeakRef(reader);
  return PMJS.tasks.onStop(function() {
    var opened = weak.deref();
    if (opened) fsCloseDiscardedReader(opened);
  });
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
  function discardReader() {
    var closing = reader; reader = null;
    if (closing) fsCloseDiscardedReader(closing);
  }
  function scheduleRead() {
    if (!reader || !demand || queued || stream.destroyed) return;
    queued = true;
    PMJS.tasks.enqueue(function() {
      if (stream.destroyed) { queued = false; return; }
      var size = Math.min(demand, end === Infinity ? Infinity : end - position + 1);
      var reading = reader;
      demand = 0;
      Promise.resolve().then(function() { return reading.readAsync(size); }).then(function(contents) {
        PMJS.tasks.enqueue(function() {
          queued = false;
          if (stream.destroyed) return;
          position += contents.byteLength;
          if (!contents.byteLength) { stream.push(null); return; }
          stream.push(contents);
          if (!stream.destroyed && position > end) stream.push(null);
          scheduleRead();
        }, { discard: discardReader });
      }, function(error) {
        PMJS.tasks.enqueue(function() { queued = false; stream.destroy(error); }, { discard: discardReader });
      });
    }, { discard: discardReader });
  }

  var stream = new Readable({
    encoding: options.encoding,
    highWaterMark: options.highWaterMark === undefined ? 64 * 1024 : options.highWaterMark,
    read: function(size) { demand = size || 1; scheduleRead(); },
    destroy: function(error, callback) {
      if (removeStopListener) removeStopListener();
      var closing = reader; reader = null;
      Promise.resolve().then(function() { if (closing) return closing.close(); }).then(
        function() { callback(error); }, function(closeError) { callback(error || closeError); });
    }
  });
  var guestStream = typeof PMJS.tasks.wrapNodeEmitter === 'function'
    ? PMJS.tasks.wrapNodeEmitter(stream, ['emit', 'push', 'read']) : stream;
  var removeStopListener;
  stream.path = path;
  PMJS.tasks.enqueue(function() {
    if (stream.destroyed) return;
    Promise.resolve().then(function() {
      var writable = writablePath(path);
      var host = writable !== null && NativeHost.storage ? NativeHost.storage : NativeHost.fs;
      var resolved = writable !== null && NativeHost.storage ? writable : gameReadPath(path);
      return host.openReadAsync(resolved, start).then(function(opened) {
        var missingFiles = PMJS.config.missingTextFiles || {};
        if (!opened && writable !== null && Object.prototype.hasOwnProperty.call(missingFiles, writable)) {
          var bytes = Buffer.from(String(missingFiles[writable]), 'utf8'), offset = start;
          opened = { readAsync: function(size) {
            var chunk = bytes.subarray(offset, offset + size); offset += chunk.length;
            return Promise.resolve(chunk);
          }, close: function() { bytes = null; } };
        }
        if (!opened) {
          var error = new Error('ENOENT: ' + path); error.code = 'ENOENT'; throw error;
        }
        PMJS.tasks.enqueue(function() {
          if (stream.destroyed) { fsCloseDiscardedReader(opened); return; }
          reader = opened;
          if (PMJS.tasks.onStop) removeStopListener = fsReaderStopListener(opened);
          stream.emit('open', 0);
          stream.emit('ready');
          scheduleRead();
        }, { discard: function() {
          fsCloseDiscardedReader(opened);
        } });
      });
    }).catch(function(error) { PMJS.tasks.enqueue(function() { stream.destroy(error); }); });
  });
  return guestStream;
}

// Callbacks given to game code follow NW.js uncaught-exception semantics (see scheduler.js).
function deliverNodeCallback(callback) {
  PMJS.tasks.enqueue(callback, { errorMode: 'uncaught' });
}
var readFileCallbackWarningEmitted = false;
function warnMissingReadFileCallback() {
  if (readFileCallbackWarningEmitted) return;
  readFileCallbackWarningEmitted = true;
  var warning = new Error('Calling an asynchronous function without callback is deprecated.');
  warning.name = 'DeprecationWarning';
  warning.code = 'DEP0013';
  if (!globalThis.process || !globalThis.process.emit || !globalThis.process.emit('warning', warning)) {
    console.warn(warning.stack || warning);
  }
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
    if (typeof options === 'function') { callback = options; options = undefined; }
    if (typeof callback !== 'function') {
      warnMissingReadFileCallback();
      callback = function(error) { if (error) throw error; };
    }
    PMJS.tasks.enqueue(function() {
      Promise.resolve().then(function() { return fsReadContentsAsync(path, options); }).then(
        function(result) { deliverNodeCallback(function() { return callback(null, result); }); },
        function(error) { deliverNodeCallback(function() { return callback(error, null); }); });
    });
  },
  createReadStream: function(path, options) { return new FsReadStream(path, options); },
  writeFileSync: function(path, contents, options) {
    var writable = writablePath(path);
    var host = writable !== null ? NativeHost.storage : NativeHost.fs;
    if (!host) throw new Error('EACCES: ' + path);
    var encoding = typeof options === 'string' ? options : options && options.encoding;
    var flag = typeof options === 'object' && options ? options.flag : 'w';
    if (flag !== undefined && ['w', 'wx', 'a', 'ax'].indexOf(flag) < 0) {
      throw Object.assign(new Error('unsupported filesystem write flag: ' + flag), { code: 'EINVAL' });
    }
    var bytes = ArrayBuffer.isView(contents)
      ? Buffer.from(contents.buffer, contents.byteOffset, contents.byteLength)
      : Buffer.from(String(contents), encoding || 'utf8');
    var resolved = writable !== null ? writable : gameReadPath(path);
    if (typeof host.writeBytes === 'function') host.writeBytes(resolved, bytes, { flag: flag || 'w' });
    else if (writable !== null && (flag || 'w') === 'w' && typeof contents === 'string' && (!encoding || encoding === 'utf8')) {
      host.writeText(resolved, contents);
    } else throw new Error('filesystem byte writes are unavailable');
  },
  writeFile: function(path, contents, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined; }
    var error = null;
    try { fsModule.writeFileSync(path, contents, options); } catch (caught) { error = caught; }
    deliverNodeCallback(function() { if (callback) return callback(error); });
  },
  appendFileSync: function(path, contents, options) {
    var encoding = typeof options === 'string' ? options : options && options.encoding;
    var bytes = ArrayBuffer.isView(contents)
      ? Buffer.from(contents.buffer, contents.byteOffset, contents.byteLength)
      : Buffer.from(String(contents), encoding || 'utf8');
    var writable = writablePath(path);
    if (writable !== null && NativeHost.storage && typeof NativeHost.storage.writeBytes === 'function') {
      if (fsModule.existsSync(path)) {
        NativeHost.storage.writeBytes(writable, bytes, { flag: 'a' });
        return;
      }
      var initial = Buffer.alloc(0);
      try { initial = fsReadContents(path); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      fsModule.writeFileSync(path, Buffer.concat([initial, bytes]));
      return;
    }
    fsModule.writeFileSync(path, bytes, { flag: 'a' });
  },
  mkdirSync: function(path, options) {
    var writable = writablePath(path);
    var host = writable !== null ? NativeHost.storage : NativeHost.fs;
    if (!host) throw new Error('EACCES: ' + path);
    if (writable === '' && !(options && options.recursive)) throw Object.assign(new Error('EEXIST: ' + path), { code: 'EEXIST' });
    if (writable !== '') (host.mkdir || host.makeDirectory).call(host, writable !== null ? writable : gamePath(path), options);
  },
  mkdir: function(path, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined; }
    var error = null;
    try { fsModule.mkdirSync(path, options); } catch (caught) { error = caught; }
    deliverNodeCallback(function() { if (callback) return callback(error); });
  },
  unlinkSync: function(path) {
    var writable = writablePath(path);
    var host = writable !== null ? NativeHost.storage : NativeHost.fs;
    if (!host) throw new Error('EACCES: ' + path);
    if (!fsModule.existsSync(path)) throw Object.assign(new Error('ENOENT: ' + path), { code: 'ENOENT' });
    if (fsModule.statSync(path).isDirectory()) throw Object.assign(new Error('EISDIR: ' + path), { code: 'EISDIR' });
    host.remove(writable !== null ? writable : gameReadPath(path));
  },
  unlink: function(path, callback) {
    var error = null;
    try { fsModule.unlinkSync(path); } catch (caught) { error = caught; }
    deliverNodeCallback(function() { if (callback) return callback(error); });
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
    try { fsModule.renameSync(from, to); } catch (caught) { error = caught; }
    deliverNodeCallback(function() { if (callback) return callback(error); });
  },
  readdirSync: function(path, options) {
    if (!fsModule.statSync(path).isDirectory()) throw Object.assign(new Error('ENOTDIR: ' + path),
      { code: 'ENOTDIR', path: String(path), syscall: 'scandir' });
    var writable = writablePath(path);
    var entries = writable !== null && NativeHost.storage
      ? NativeHost.storage.readDirectory(writable)
      : NativeHost.fs.readDirectory(gamePath(path));
    if (entries === null) throw Object.assign(new Error('ENOENT: ' + path), { code: 'ENOENT' });
    var names = gameDirectoryEntries(path, entries);
    if (options && options.withFileTypes) return names.map(function(name) {
      var stats = fsModule.lstatSync(pathModule.join(String(path), name));
      return { name: name, isFile: stats.isFile.bind(stats), isDirectory: stats.isDirectory.bind(stats),
        isSymbolicLink: stats.isSymbolicLink.bind(stats) };
    });
    var encoding = typeof options === 'string' ? options : options && options.encoding;
    return encoding === 'buffer' ? names.map(function(name) { return Buffer.from(name); }) : names;
  },
  statSync: function(path, options) { return fsMetadata('stat', path, options); },
  lstatSync: function(path, options) { return fsMetadata('lstat', path, options); },
  accessSync: function(path, mode) { return fsMetadata('access', path, mode || 0); },
  rmdirSync: function(path, options) { return fsMetadata('removeDirectory', path, options); },
  rmSync: function(path, options) {
    if (options && options.force && !fsModule.existsSync(path)) return;
    if (fsModule.statSync(path).isDirectory()) {
      if (!options || !options.recursive) throw Object.assign(new Error('EISDIR: ' + path), { code: 'EISDIR' });
      return fsMetadata('removeDirectory', path, options);
    }
    return fsModule.unlinkSync(path);
  },
  realpathSync: function(path) { fsModule.statSync(path); return pathModule.resolve(path); },
  copyFileSync: function(source, destination, flags) {
    if (flags && (flags & 1) && fsModule.existsSync(destination)) {
      throw Object.assign(new Error('EEXIST: ' + destination), { code: 'EEXIST' });
    }
    fsModule.writeFileSync(destination, fsModule.readFileSync(source));
  },
  stat: function(path, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined; }
    if (typeof callback !== 'function') throw new TypeError('stat requires a callback');
    var result, error = null;
    try { result = fsModule.statSync(path, options); } catch (caught) { error = caught; }
    deliverNodeCallback(function() { return callback(error, result); });
  }
};

function fsMetadata(method, path, options) {
  var writable = writablePath(path);
  var host = writable !== null ? NativeHost.storage : NativeHost.fs;
  try { return host[method](writable !== null ? writable : gameReadPath(path), options); }
  catch (error) {
    if ((method === 'stat' || method === 'lstat') && options && options.throwIfNoEntry === false && error.code === 'ENOENT') return;
    if (error.code) {
      error.path = String(path);
      if (!error.syscall) error.syscall = method;
    }
    throw error;
  }
}
fsModule.constants = globalThis.__pmjsBuiltinRequire('fs').constants;
['appendFile', 'readdir', 'lstat', 'access', 'rmdir', 'rm', 'realpath', 'copyFile'].forEach(function(name) {
  fsModule[name] = function() {
    var args = Array.prototype.slice.call(arguments), callback = args.pop();
    if (typeof callback !== 'function') throw new TypeError(name + ' requires a callback');
    var result, error = null;
    try { result = fsModule[name + 'Sync'].apply(fsModule, args); } catch (caught) { error = caught; }
    deliverNodeCallback(function() {
      if (['access', 'rmdir', 'rm', 'appendFile', 'copyFile'].indexOf(name) >= 0) return callback(error);
      return callback(error, result);
    });
  };
});
fsModule.promises = {};
['readFile', 'writeFile', 'appendFile', 'mkdir', 'unlink', 'rename', 'readdir', 'stat',
  'lstat', 'access', 'rmdir', 'rm', 'realpath', 'copyFile'].forEach(function(name) {
  fsModule.promises[name] = function() {
    var args = Array.prototype.slice.call(arguments);
    return new Promise(function(resolve, reject) {
      args.push(function(error, result) { if (error) reject(error); else resolve(result); });
      fsModule[name].apply(fsModule, args);
    });
  };
});
