'use strict';

const childProcess = require('node:child_process');
const hostProcess = require('node:process');
const hostTimers = require('node:timers');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

function createStdinBoundary(input, tasks) {
  let stopping = false, inputClosed = false, inputError = null;
  let removeStopListener = () => {};
  const pendingWrites = new Set();
  function enqueueCallback(callback, args) {
    if (typeof callback !== 'function') return;
    tasks().enqueue(() => callback.apply(undefined, args), { errorMode: 'uncaught' });
  }
  const stream = new Writable({
    highWaterMark: input.writableHighWaterMark,
    write(chunk, encoding, callback) {
      if (stopping || inputClosed || inputError) {
        callback(inputError || Object.assign(new Error('child process stdin is closed'), { code: 'ERR_STREAM_DESTROYED' }));
        return;
      }
      let writeComplete = false, drainComplete = false, finished = false, drainListener;
      const finish = error => {
        if (finished) return;
        finished = true;
        pendingWrites.delete(finish);
        if (drainListener) input.removeListener('drain', drainListener);
        if (!stopping) callback(error);
      };
      finish.cancel = () => {
        if (finished) return;
        finished = true;
        pendingWrites.delete(finish);
        if (drainListener) input.removeListener('drain', drainListener);
      };
      function maybeFinish() { if (writeComplete && drainComplete) finish(); }
      pendingWrites.add(finish);
      let accepted;
      try {
        accepted = input.write(chunk, error => {
          if (error) { finish(error); return; }
          writeComplete = true;
          maybeFinish();
        });
      } catch (error) { finish(error); return; }
      if (accepted) drainComplete = true;
      else {
        drainListener = () => { drainComplete = true; maybeFinish(); };
        input.once('drain', drainListener);
      }
      maybeFinish();
    },
    final(callback) {
      if (stopping || inputClosed || inputError) {
        callback(inputError || Object.assign(new Error('child process stdin is closed'), { code: 'ERR_STREAM_DESTROYED' }));
        return;
      }
      try { input.end(callback); }
      catch (error) { callback(error); }
    },
    destroy(error, callback) {
      if (!stopping) {
        const destroyedError = error || Object.assign(new Error('child process stdin was destroyed'), { code: 'ERR_STREAM_DESTROYED' });
        Array.from(pendingWrites).forEach(finish => finish(destroyedError));
      }
      if (!input.destroyed) input.destroy();
      callback(error);
    }
  });

  function onError(error) {
    if (stopping) return;
    inputError = error;
    Array.from(pendingWrites).forEach(finish => finish(error));
    if (!stream.destroyed) stream.destroy(error);
  }
  function onClose() {
    inputClosed = true;
    if (!stopping && !stream.destroyed) stream.destroy();
    input.removeListener('error', onError);
    input.removeListener('close', onClose);
    removeStopListener();
  }
  input.on('error', onError);
  input.on('close', onClose);

  const write = stream.write;
  stream.write = function(chunk, encoding, callback) {
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    const delivered = typeof callback === 'function' ? function() {
      enqueueCallback(callback, Array.prototype.slice.call(arguments));
    } : callback;
    return write.call(this, chunk, encoding, delivered);
  };
  const end = stream.end;
  stream.end = function() {
    const args = Array.prototype.slice.call(arguments);
    const index = args.length - 1;
    if (index >= 0 && typeof args[index] === 'function') {
      const callback = args[index];
      args[index] = function() { enqueueCallback(callback, Array.prototype.slice.call(arguments)); };
    }
    return end.apply(this, args);
  };

  const guestStream = typeof tasks().wrapNodeEmitter === 'function'
    ? tasks().wrapNodeEmitter(stream, ['emit', 'write', 'end']) : stream;
  if (typeof tasks().onStop === 'function') removeStopListener = tasks().onStop(() => {
    stopping = true;
    Array.from(pendingWrites).forEach(finish => finish.cancel());
    stream.removeAllListeners();
    if (!stream.destroyed) stream.destroy();
  });
  return guestStream;
}

function createSubprocesses({ tasks, resolveDirectory, openExternal }) {
  const children = new Set();
  let stopping = false;
  function enqueue(callback, errorMode = 'event') { return tasks().enqueue(callback, { errorMode }); }
  function optionsFor(options) {
    if (stopping) throw Object.assign(new Error('session has terminated'), { code: 'ERR_RUNTIME_STOPPED' });
    return { ...options, detached: true, cwd: resolveDirectory(options && options.cwd || '/game') };
  }
  function wrap(child, callbackHandlesErrors = false, bufferedOutput = false) {
    children.add(child);
    const emitter = new EventEmitter();
    const result = typeof tasks().wrapNodeEmitter === 'function'
      ? tasks().wrapNodeEmitter(emitter, ['emit']) : emitter;
    result.pid = child.pid;
    result.stdin = child.stdin ? createStdinBoundary(child.stdin, tasks) : null;
    result.kill = child.kill.bind(child);
    result.ref = () => { child.ref(); return result; };
    result.unref = () => { child.unref(); return result; };
    for (const name of ['stdout', 'stderr']) {
      if (!child[name]) { result[name] = null; continue; }
      const outputTarget = new PassThrough();
      result[name] = typeof tasks().wrapNodeEmitter === 'function'
        ? tasks().wrapNodeEmitter(outputTarget, ['emit', 'write', 'read']) : outputTarget;
      const source = child[name];
      if (!bufferedOutput) {
        outputTarget.on('drain', () => source.resume());
        outputTarget.on('close', () => source.destroy());
      }
      source.on('data', data => {
        // Bound both the guest stream and the queue of pending scheduler deliveries.
        if (!bufferedOutput) source.pause();
        if (enqueue(() => {
          if (outputTarget.destroyed) return;
          let accepted;
          try { accepted = outputTarget.write(data); }
          finally { if (!bufferedOutput && accepted !== false && !outputTarget.destroyed) source.resume(); }
        }) === false && !bufferedOutput) source.destroy();
      });
      source.on('end', () => enqueue(() => outputTarget.end()));
      source.on('error', error => enqueue(() => outputTarget.destroy(error)));
    }
    for (const name of ['spawn', 'error', 'exit', 'close']) child.on(name, (...args) => {
      if (name === 'close') children.delete(child);
      enqueue(() => {
        if (name === 'exit') { result.exitCode = args[0]; result.signalCode = args[1]; }
        if (name !== 'error' || !callbackHandlesErrors || result.listenerCount('error')) result.emit(name, ...args);
      }, 'uncaught');
    });
    return result;
  }
  function exec(command, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const resolvedOptions = optionsFor(options);
    // These desktop URL commands have no shell composition or file operands.
    const match = /^(?:open|xdg-open|rundll32(?:\.exe)? url\.dll,FileProtocolHandler)\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|(\S+))\s*$/.exec(command);
    const url = match && (match[1] || match[2] || match[3]);
    if (url && /^(https?:\/\/|mailto:)/i.test(url) && !/[\x00-\x20]/.test(url)) {
      const result = new EventEmitter();
      result.kill = () => false;
      enqueue(() => {
        let error = null;
        try { if (!openExternal(url)) throw Object.assign(new Error('system browser could not open URL'), { code: 1, cmd: command }); }
        catch (caught) { error = caught; }
        result.exitCode = error ? 1 : 0;
        result.signalCode = null;
        enqueue(() => result.emit('exit', result.exitCode, null), 'uncaught');
        if (callback) enqueue(() => callback(error, '', ''), 'uncaught');
        enqueue(() => result.emit('close', result.exitCode, null), 'uncaught');
      });
      return result;
    }
    return wrap(childProcess.exec(command, resolvedOptions, typeof callback === 'function'
      ? (error, stdout, stderr) => enqueue(() => callback(error, stdout, stderr), 'uncaught') : undefined), typeof callback === 'function', true);
  }
  return {
    api: {
      exec,
      execFile(file, args, options, callback) {
        if (!Array.isArray(args)) { callback = options; options = args; args = []; }
        if (typeof options === 'function') { callback = options; options = {}; }
        return wrap(childProcess.execFile(file, args, optionsFor(options), typeof callback === 'function'
          ? (error, stdout, stderr) => enqueue(() => callback(error, stdout, stderr), 'uncaught') : undefined), typeof callback === 'function', true);
      },
      spawn(file, args, options) {
        if (!Array.isArray(args)) { options = args; args = []; }
        return wrap(childProcess.spawn(file, args, optionsFor(options)));
      }
    },
    async stop() {
      stopping = true;
      await Promise.all(Array.from(children, child => new Promise(resolve => {
        function signal(name) {
          if (!Number.isInteger(child.pid)) return;
          try { hostProcess.kill(-child.pid, name); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        const force = hostTimers.setTimeout(() => signal('SIGKILL'), 500);
        child.once('close', () => { hostTimers.clearTimeout(force); resolve(); });
        signal('SIGTERM');
        child.stdout?.destroy();
        child.stderr?.destroy();
      })));
    }
  };
}

module.exports = { createSubprocesses };
