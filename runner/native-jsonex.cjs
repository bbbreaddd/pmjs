'use strict';
const { encodeGraph, decodeGraph } = require('./mv-save-codec.cjs');

function installJsonEx(runtime) {
  const scope = runtime.scope;
  const createArray = runtime.runScript('(function() { return []; })');
  const createObject = runtime.runScript('(function() { return {}; })');
  function JsonEx() { throw new Error('JsonEx is a static class'); }
  JsonEx.maxDepth = 100;
  JsonEx.stringify = function(value) {
    // MV counts the root as depth one and rejects the limit itself.
    return encodeGraph(value, { maxDepth: this.maxDepth - 2, rootArray: true, className(object) {
      const name = object.constructor?.name;
      return name && name !== 'Object' && name !== 'Array' ? name : undefined;
    } });
  };
  JsonEx.parse = function(json) {
    const value = decodeGraph(json, { allowCycles: true, createObject(source, array) {
      const object = array ? createArray() : createObject();
      const constructor = scope[source['@']];
      if (typeof constructor === 'function' && constructor.prototype) Object.setPrototypeOf(object, constructor.prototype);
      return object;
    } });
    const visited = new Set();
    function clean(object) {
      if (!object || typeof object !== 'object' || visited.has(object)) return;
      visited.add(object); delete object['@'];
      for (const value of Object.values(object)) clean(value);
    }
    clean(value);
    return value;
  };
  JsonEx.makeDeepCopy = function(value) { return this.parse(this.stringify(value)); };
  scope.JsonEx = JsonEx;
}

module.exports = { installJsonEx };
