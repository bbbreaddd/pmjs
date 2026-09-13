'use strict';

// Bounded semantic tracing for short diagnostic windows. The hot path is one
// Boolean branch while disarmed; strings and JSON are produced only after the
// capture ends.
var pmjsTraceFrameLimit = Math.max(0,
  Number(NativeHost.runtime.env('PMJS_OPERATION_TRACE_FRAMES')) || 0);
var pmjsTraceEventLimit = Math.max(256,
  Number(NativeHost.runtime.env('PMJS_OPERATION_TRACE_EVENTS')) || 8192);
var pmjsTraceEvents = [];
var pmjsTraceDropped = 0;
var pmjsTraceFrame = 0;
var pmjsTraceTick = 0;
var pmjsTraceFramesCaptured = 0;
var pmjsTracePending = false;
var pmjsTraceActive = false;
var pmjsTraceNextId = 1;
var pmjsTraceObjectIds = new WeakMap();
var pmjsTraceResourceRevisions = Object.create(null);
var pmjsTraceCounters = Object.create(null);
var pmjsTraceDescribedObjects = new WeakSet();
var pmjsTraceCoverage = {
  framePhaseSpans: true,
  canvasRequestHook: true,
  canvasCompletionHook: true,
  nativePixelReadHook: false,
  nativeUploadHook: false,
  sceneSourceHook: true,
  scenePacketSummary: true,
  objectOwnershipLabels: true,
  executedDrawHook: false,
  resourceRevisionTracking: 'partial'
};

function pmjsTraceId(object, kind) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) return 0;
  var existing = pmjsTraceObjectIds.get(object);
  if (existing) return existing;
  var id = pmjsTraceNextId++;
  pmjsTraceObjectIds.set(object, id);
  pmjsTraceResourceRevisions[id] = { kind: kind || 'object', revision: 0 };
  return id;
}

function pmjsTraceRevision(object, kind, bump) {
  var id = pmjsTraceId(object, kind);
  if (!id) return { id: 0, revision: 0 };
  var resource = pmjsTraceResourceRevisions[id];
  if (bump) resource.revision++;
  return { id: id, revision: resource.revision };
}

function pmjsTraceEvent(category, name, arguments_) {
  if (!pmjsTraceActive) return 0;
  var operationId = pmjsTraceNextId++;
  if (pmjsTraceEvents.length >= pmjsTraceEventLimit) {
    pmjsTraceDropped++;
    return operationId;
  }
  pmjsTraceEvents.push({
    name: name, cat: category, ph: 'i', s: 't',
    ts: Math.round(performance.now() * 1000), pid: 1, tid: 1,
    args: Object.assign({ operationId: operationId, frame: pmjsTraceFrame,
      tick: pmjsTraceTick }, arguments_ || {})
  });
  return operationId;
}

function pmjsTraceCount(name, amount) {
  if (!pmjsTraceActive) return;
  pmjsTraceCounters[name] = (pmjsTraceCounters[name] || 0) + (amount || 1);
}

function pmjsTraceDuration(category, name, startedMs, finishedMs, arguments_) {
  if (!pmjsTraceActive) return;
  if (pmjsTraceEvents.length >= pmjsTraceEventLimit) {
    pmjsTraceDropped++;
    return;
  }
  pmjsTraceEvents.push({
    name: name, cat: category, ph: 'X',
    ts: Math.round(startedMs * 1000),
    dur: Math.max(0, Math.round((finishedMs - startedMs) * 1000)),
    pid: 1, tid: 1,
    args: Object.assign({ frame: pmjsTraceFrame, tick: pmjsTraceTick },
      arguments_ || {})
  });
}

function pmjsTraceDescribe(object, category, name, arguments_) {
  if (!pmjsTraceActive || !object || pmjsTraceDescribedObjects.has(object)) return;
  pmjsTraceDescribedObjects.add(object);
  pmjsTraceEvent(category, name, arguments_);
}

globalThis.__pmjsTrace = {
  enabled: pmjsTraceFrameLimit > 0,
  active: function() { return pmjsTraceActive; },
  arm: function(frames, eventLimit) {
    if (pmjsTracePending || pmjsTraceActive) return false;
    pmjsTraceFrameLimit = Math.max(1, Number(frames) || 1);
    pmjsTraceEventLimit = Math.max(256,
      Number(eventLimit) || pmjsTraceEventLimit);
    pmjsTraceEvents = [];
    pmjsTraceDropped = 0;
    pmjsTraceFramesCaptured = 0;
    pmjsTraceNextId = 1;
    pmjsTraceObjectIds = new WeakMap();
    pmjsTraceResourceRevisions = Object.create(null);
    pmjsTraceCounters = Object.create(null);
    pmjsTraceDescribedObjects = new WeakSet();
    this.enabled = true;
    pmjsTracePending = true;
    return true;
  },
  beginFrame: function(tick, frame) {
    if (pmjsTracePending) {
      pmjsTracePending = false;
      pmjsTraceActive = true;
    }
    if (!pmjsTraceActive) return;
    pmjsTraceTick = tick;
    pmjsTraceFrame = frame;
    pmjsTraceEvent('frame', 'frame.begin', {});
  },
  endFrame: function() {
    if (!pmjsTraceActive) return;
    pmjsTraceEvent('frame', 'frame.end', {});
    pmjsTraceFramesCaptured++;
    if (pmjsTraceFramesCaptured >= pmjsTraceFrameLimit) pmjsTraceActive = false;
  },
  event: pmjsTraceEvent,
  duration: pmjsTraceDuration,
  describe: pmjsTraceDescribe,
  count: pmjsTraceCount,
  id: pmjsTraceId,
  revision: pmjsTraceRevision,
  result: function() {
    return {
      traceEvents: pmjsTraceEvents,
      metadata: {
        schemaVersion: 1,
        requestedFrames: pmjsTraceFrameLimit,
        capturedFrames: pmjsTraceFramesCaptured,
        eventCapacity: pmjsTraceEventLimit,
        recordedEvents: pmjsTraceEvents.length,
        droppedEvents: pmjsTraceDropped,
        complete: pmjsTraceFramesCaptured >= pmjsTraceFrameLimit &&
          pmjsTraceDropped === 0,
        counters: pmjsTraceCounters,
        coverage: pmjsTraceCoverage,
        resources: pmjsTraceResourceRevisions
      }
    };
  }
};
