'use strict';

(function() {
  PMJS.mv = PMJS.mv || {};
  PMJS.mv.createUpdateSchedule = function(options) {
    var records = new WeakMap(), owners = new Map(), pending = [], mutations = [], aborted = [];
    var tick = 0, cursor = -1, running = false, diagnosticAt = 0, diagnostics = options.diagnostics ? new Map() : null;
    var stats = { registered: 0, updates: 0, notifications: 0, ticks: 0 };
    function position(id) {
      var low = 0, high = pending.length;
      while (low < high) {
        var middle = (low + high) >>> 1;
        if (pending[middle].id < id) low = middle + 1;
        else high = middle;
      }
      return low;
    }
    function completed(record) { return tick - (running && record.id >= cursor ? 1 : 0); }
    function synchronize(record, until) {
      if (!record || record.processing || until <= record.at) return;
      var elapsed = until - record.at;
      for (var failure of aborted) {
        if (failure.tick > record.at && failure.tick <= until && failure.cursor < record.id) elapsed--;
      }
      for (var counter of options.counters || []) {
        var rate = typeof counter.rate === 'function' ? counter.rate(record.object) : counter.rate;
        record.object[counter.name] += elapsed * rate;
      }
      record.at = until;
    }
    function activate(record) {
      if (!record || record.queued) return;
      record.queued = true;
      pending.splice(position(record.id), 0, record);
    }
    function retire(object) {
      var record = records.get(object);
      if (!record) return;
      synchronize(record, completed(record));
      record.retired = true;
      var index = position(record.id);
      if (pending[index] === record) pending.splice(index, 1);
      owners.delete(record.id);
      records.delete(object);
      if (diagnostics) diagnostics.delete(record);
      if (options.retired) options.retired(object);
    }
    function register(object, id) {
      var existing = records.get(object);
      if (existing) {
        if (existing.id !== id) throw new Error('An event object cannot occupy two scheduled slots');
        return;
      }
      for (var counter of options.counters || []) {
        var descriptor = Object.getOwnPropertyDescriptor(object, counter.name);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.writable || typeof descriptor.value !== 'number') {
          throw new TypeError('Unsupported scheduled counter: ' + counter.name);
        }
      }
      var previous = owners.get(id);
      if (previous) retire(previous.object);
      var record = { object: object, id: id, at: tick, queued: false, processing: false };
      owners.set(id, record);
      records.set(object, record);
      stats.registered++;
      record.synchronize = function() { if (!record.retired) synchronize(record, completed(record)); };
      record.wake = function() {
        if (record.retired) return false;
        if (record.processing) { record.nextTick = true; return true; }
        stats.notifications++;
        activate(record);
        return true;
      };
      if (options.registered) options.registered(record);
      activate(record);
    }
    // MV captures collection membership before visiting events.
    function mutate(callback) { if (running) mutations.push(callback); else callback(); }
    return {
      register: function(object, id) { mutate(function() { register(object, id); }); },
      unregister: function(object) { mutate(function() { retire(object); }); },
      dispose: function() { mutate(function() { for (var record of owners.values()) retire(record.object); }); },
      synchronize: function(object) { var record = records.get(object); if (record) record.synchronize(); },
      materialize: function() { for (var record of owners.values()) synchronize(record, completed(record)); },
      wake: function(object) {
        var record = records.get(object);
        if (!record) return false;
        return record.wake();
      },
      stats: stats,
      setDiagnostics: function(enabled) { diagnostics = enabled ? new Map() : null; diagnosticAt = tick; },
      diagnostics: function() {
        if (!diagnostics) return { enabled: false };
        var events = [], reasons = {}, queued = 0;
        for (var record of owners.values()) {
          var why = options.reasons ? options.reasons(record.object) : [];
          for (var reason of why) reasons[reason] = (reasons[reason] || 0) + 1;
          if (record.queued) queued++;
          events.push({ id: record.id, queued: record.queued, reasons: why, updates: diagnostics.get(record) || 0 });
        }
        events.sort(function(a, b) { return a.id - b.id; });
        return { enabled: true, ticks: tick - diagnosticAt, registered: events.length, queued: queued,
          sleeping: events.length - queued, reasons: reasons, events: events };
      },
      run: function() {
        if (running) throw new Error('Reentrant event update schedule');
        running = true; cursor = -1; tick++; stats.ticks++;
        try {
          for (;;) {
            var index = position(cursor + 1), record = pending[index];
            if (!record) break;
            cursor = record.id;
            synchronize(record, tick - 1);
            record.at = tick;
            record.nextTick = false;
            record.processing = true;
            try { record.object.update(); }
            finally { record.processing = false; }
            stats.updates++;
            if (diagnostics) diagnostics.set(record, (diagnostics.get(record) || 0) + 1);
            if (!record.nextTick && !options.active(record.object)) {
              pending.splice(position(record.id), 1);
              record.queued = false;
            }
          }
        } catch (error) {
          aborted.push({ tick: tick, cursor: cursor });
          throw error;
        } finally {
          running = false;
          var changes = mutations;
          mutations = [];
          for (var change of changes) change();
          cursor = -1;
        }
      }
    };
  };
})();
