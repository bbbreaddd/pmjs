function normalizePath(path) {
  var text = String(path).replace(/\\/g, '/');
  var absolute = text.charAt(0) === '/';
  var trailingSeparator = text.length > 1 && text.charAt(text.length - 1) === '/';
  var parts = text.split('/');
  var result = [];
  for (var index = 0; index < parts.length; index++) {
    var part = parts[index];
    if (!part || part === '.') continue;
    if (part === '..') {
      if (result.length) result.pop();
    } else {
      result.push(part);
    }
  }
  var normalized = (absolute ? '/' : '') + result.join('/');
  return trailingSeparator && normalized !== '/' ? normalized + '/' : normalized;
}

function dirname(path) {
  var normalized = normalizePath(path);
  var index = normalized.lastIndexOf('/');
  if (index < 0) return '.';
  return index === 0 ? '/' : normalized.slice(0, index);
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

var pathModule = {
  sep: '/',
  normalize: normalizePath,
  dirname: dirname,
  join: function() { return normalizePath(Array.prototype.join.call(arguments, '/')); },
  resolve: function() { return normalizePath('/game/' + Array.prototype.join.call(arguments, '/')); },
  basename: function(path, extension) {
    var name = normalizePath(path).split('/').pop() || '';
    return extension && name.slice(-extension.length) === extension
      ? name.slice(0, -extension.length)
      : name;
  },
  extname: function(path) {
    var name = this.basename(path);
    var index = name.lastIndexOf('.');
    return index > 0 ? name.slice(index) : '';
  }
};

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
  this.path = path; this.options = options || {}; this.readable = true;
  this.destroyed = false; this._listeners = Object.create(null);
  var stream = this;
  PMJS.tasks.enqueue(function() {
    if (stream.destroyed) return;
    try {
      var contents = fsReadContents(path, stream.options);
      stream.emit('open', 0); stream.emit('ready'); stream.emit('data', contents);
      stream.readable = false; stream.emit('end'); stream.emit('close');
    } catch (error) {
      stream.readable = false; stream.emit('error', error); stream.emit('close');
    }
  });
}
FsReadStream.prototype.on = function(name, listener) {
  var listeners = this._listeners[name];
  if (!listeners) {
    listeners = [];
    this._listeners[name] = listeners;
  }
  listeners.push(listener);
  return this;
};
FsReadStream.prototype.once = function(name, listener) {
  var stream = this;
  function once() { stream.removeListener(name, once); return listener.apply(this, arguments); }
  return this.on(name, once);
};
FsReadStream.prototype.removeListener = function(name, listener) {
  var listeners = this._listeners[name] || [];
  var index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1);
  return this;
};
FsReadStream.prototype.emit = function(name) {
  var args = Array.prototype.slice.call(arguments, 1);
  (this._listeners[name] || []).slice().forEach(function(listener) {
    listener.apply(null, args);
  });
  return this;
};
FsReadStream.prototype.setEncoding = function(encoding) {
  this.options.encoding = encoding; return this;
};
FsReadStream.prototype.destroy = function(error) {
  if (this.destroyed) return this;
  this.destroyed = true; this.readable = false;
  if (error) this.emit('error', error);
  this.emit('close'); return this;
};
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
    return { isDirectory: function() { return directory; } };
  },
  stat: function(path, options, callback) {
    if (typeof options === 'function') { callback = options; options = null; }
    if (typeof callback !== 'function') throw new TypeError('stat requires a callback');
    var result, error = null;
    try { result = fsModule.statSync(path, options); } catch (caught) { error = caught; }
    PMJS.tasks.enqueue(function() { callback(error, result); });
  }
};
