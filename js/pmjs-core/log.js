(function() {
  var lastKey = null;
  var lastLine = '';
  var lastRepeat = 0;
  var todoCounts = Object.create(null);

  function emitConsole(line) {
    try {
      if (typeof console !== 'undefined' &&
          typeof console.error === 'function') {
        console.error(line);
      }
    } catch (_) {}
  }

  function emitCallback(record) {
    try {
      if (typeof globalThis.pmjsLogCallback === 'function') {
        globalThis.pmjsLogCallback(record);
      }
    } catch (_) {}
  }

  function flushRepeat() {
    if (lastKey !== null && lastRepeat > 0) {
      emitConsole(lastLine + ' [' + (lastRepeat + 1) + 'x]');
      lastRepeat = 0;
    }
  }

  function pmjsLogTodo(record) {
    try {
      if (!record) return;
      var key = record.capability + '|' + record.reason + '|' +
        record.nodeClass;
      todoCounts[key] = (todoCounts[key] || 0) + 1;
      if (key === lastKey) {
        lastRepeat++;
        return;
      }
      flushRepeat();
      lastKey = key;
      lastLine = '[pmjs] unsupported render ' + JSON.stringify(record);
      lastRepeat = 0;
      emitConsole(lastLine);
      emitCallback(record);
    } catch (_) {}
  }

  function pmjsSkipCensus() {
    try {
      flushRepeat();
    } catch (_) {}
    var census = {};
    Object.keys(todoCounts).forEach(function(key) {
      census[key] = todoCounts[key];
    });
    return { counts: census };
  }

  globalThis.pmjsLogTodo = pmjsLogTodo;
  globalThis.pmjsSkipCensus = pmjsSkipCensus;
})();

