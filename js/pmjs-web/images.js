'use strict';

(function() {
  var retentionRules = [];
  var completionListeners = [];

  globalThis.PMJS = globalThis.PMJS || {};
  PMJS.images = {
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
