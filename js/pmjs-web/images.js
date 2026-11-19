'use strict';

(function() {
  var retentionRules = [];
  var completionListeners = [];
  var blobLoads = [], activeBlobLoads = 0, activeBlobBytes = 0;
  var blobByteBudget = 64 * 1024 * 1024;

  function drainBlobLoads() {
    while (blobLoads.length && activeBlobLoads < 2) {
      var next = blobLoads[0];
      if (activeBlobLoads && activeBlobBytes + next.blob.size > blobByteBudget) return;
      blobLoads.shift();
      startBlobLoad(next);
    }
  }

  function startBlobLoad(load) {
    var bytes = load.blob.size;
    activeBlobLoads++;
    activeBlobBytes += bytes;
    Promise.resolve().then(function() {
      if (!load.current() || PMJS.tasks.stopped) return null;
      return load.blob.arrayBuffer().then(function(buffer) {
        if (!load.current() || PMJS.tasks.stopped) return null;
        return NativeHost.images.loadBytesAsync(buffer, load.retainPixels);
      });
    }).then(load.resolve, load.reject).finally(function() {
      activeBlobLoads--;
      activeBlobBytes -= bytes;
      drainBlobLoads();
    });
  }

  globalThis.PMJS = globalThis.PMJS || {};
  PMJS.images = {
    loadBlob: function(blob, retainPixels, current) {
      return new Promise(function(resolve, reject) {
        if (blob.size > blobByteBudget) {
          reject(new Error('encoded image exceeds the 64 MiB limit'));
          return;
        }
        blobLoads.push({ blob: blob, retainPixels: retainPixels, current: current,
          resolve: resolve, reject: reject });
        drainBlobLoads();
      });
    },
    addRetentionRule: function(rule) {
      retentionRules.push(rule);
    },
    shouldRetainPixels: function(path) {
      return retentionRules.some(function(rule) { return rule(path); });
    },
    onLoadComplete: function(callback) {
      completionListeners.push(callback);
    },
    loadCompleted: function(image) {
      completionListeners.slice().forEach(function(callback) { callback(image); });
    }
  };
})();
