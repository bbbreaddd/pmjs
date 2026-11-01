// Stock MV JsonEx deletes temporary metadata, leaving V8 objects in dictionary
// mode. Serialize data-only copies and rebuild parsed objects to keep them fast;
// graphs with serialization hooks use stock behavior on the original objects.
var PMJS_JSONEX_STOCK = {
  stringify: ['f828473f50eb89841799e5931d5afb03a48be61ecce223823b432ed4ddf8d8a0',
    '676cc734383dfcfd9f888bd6f9333a51a616fd5d923cc82d02b83a3d44a17e6c'],
  parse: ['73b2d0010667280feea4478bee3525547e336af3be36433872315e100c95204f',
    '2db7c10add1f3d23f6a2a5875998fc555a68cea248e9c1fb548210b108a174f3'],
  _encode: ['250424483d8681b975cd188c4f6636664db6101c532d9058b240ce623c151255',
    'd376d63eca747a22f6dfca40f010c05dea595b46ee800766fb8b396d4f9e6542'],
  _decode: ['a72730ac0df340c3bc74223ab1ac52461dc14bb04fb67d038a13c88b2161cdc5',
    '45cffbf6be498b80c40d41fad6f1c04e7138ceecc8dd03b3624360d3f120f6b6'],
  _cleanMetadata: ['8f5fa23992a701049c8f7309049c70e12480df3e616b452c4da89f51cb6266d2',
    '57729a719060c2913b865615d3addf627573478f50f9e9fce168323ecad040c0'],
  _generateId: ['4c9a57207fe56570b60f49dac5c8f88abd883596e18a4fa5b1c778d8fdb44ea2',
    '6da6d3cc080b9777c45a24cc01f63b3c22f3baaa5f192aa2f44e7ef7212cc28e'],
  _restoreCircularReference: ['ed4778a641450f2ea7cfa4a163019ff7c3ef43bec7caa8311b93760dcef24063',
    '7304f7df5809da8c465fc2f5a2bef57d65be6cfc9148193365409b7f72721aec'],
  _linkCircularReference: ['c38de3cdcdeab65a3df36b7b71a6a62c1759471c29677582fe691bbab8dd55be',
    '92b713f2b1d0ca4fc04dee74575d351d36afe06baf9b334f810f658b063d40f5'],
  _getConstructorName: ['99e080a5df92817913e65bcfc037249b66c80a6dade7fe52058966ae3b5be888',
    '923d1aec5ae3259b69b649f24b6bdeaef1ed2a99dcdd7299da5bcc9a6119e2bf'],
  _resetPrototype: ['21188628e16c1de249324501336e80828670528e7c72944020ea81919321dcd3',
    '57508b7f76ad66758448b83656dd677cfbbc111b3c457e797d13afacf1a75e46']
};

// Capture these before game scripts can replace serialization hooks.
var PMJS_JSONEX_INTRINSICS = {
  parse: JSON.parse, stringify: JSON.stringify,
  dateJSON: Date.prototype.toJSON, dateValue: Date.prototype.valueOf,
  dateISO: Date.prototype.toISOString, datePrimitive: Date.prototype[Symbol.toPrimitive],
  hasOwn: Object.prototype.hasOwnProperty, setPrototypeOf: Object.setPrototypeOf
};

function installNativeJsonEx() {
  var JsonEx = globalThis.JsonEx;
  if (!JsonEx || typeof JsonEx.stringify !== 'function' || JsonEx._pmjsFastObjects) return;
  var id = 'storage.jsonex-fast-objects';
  PMJS.optimizations.register({ id: id, owner: 'pmjs-mv',
    fallback: 'Stock JsonEx serializes and decodes game objects in place' });
  for (var name in PMJS_JSONEX_STOCK) {
    if (!PMJS.methods.matchesSource(JsonEx[name], PMJS_JSONEX_STOCK[name])) {
      PMJS.optimizations.refuse(id, 'JsonEx.' + name + ' is not the stock MV 1.6 source');
      return;
    }
  }
  if (!PMJS.optimizations.isEnabled(id)) return;

  var methods = {};
  for (var name in PMJS_JSONEX_STOCK) methods[name] = JsonEx[name];
  var native = PMJS_JSONEX_INTRINSICS;
  var objectTag = Object.prototype.toString;
  var isProxy = __pmjsBuiltinRequire('util').types.isProxy;
  var unsupported = {};
  var hookNames = ['toJSON', 'constructor', 'hasOwnProperty', '@', '@c', 'valueOf', 'toISOString', Symbol.toPrimitive, Symbol.toStringTag];

  function copyGraph(value, copies, checkedPrototypes, depth) {
    if (depth >= JsonEx.maxDepth) return unsupported;
    if (typeof value === 'function') return unsupported;
    if (!value || typeof value !== 'object') return value;
    if (copies.has(value)) return copies.get(value);
    if (isProxy(value) || !Object.isExtensible(value)) return unsupported;
    for (var proto = Object.getPrototypeOf(value); proto; proto = Object.getPrototypeOf(proto)) {
      if (checkedPrototypes.has(proto)) break;
      if (isProxy(proto)) return unsupported;
      for (var index = 0; index < hookNames.length; index++) {
        var descriptor = Object.getOwnPropertyDescriptor(proto, hookNames[index]);
        if (descriptor && !('value' in descriptor)) return unsupported;
        if (descriptor && hookNames[index] === 'constructor') {
          var constructor = descriptor.value;
          var nameDescriptor = typeof constructor === 'function' && !isProxy(constructor) &&
            Object.getOwnPropertyDescriptor(constructor, 'name');
          if (!nameDescriptor || !('value' in nameDescriptor) ||
              typeof nameDescriptor.value !== 'string') return unsupported;
        }
      }
      checkedPrototypes.add(proto);
    }
    if (native.hasOwn.call(value, '@') || native.hasOwn.call(value, '@c')) return unsupported;
    var keys = Reflect.ownKeys(value);
    var fields = new Array(keys.length);
    for (var index = 0; index < keys.length; index++) {
      var field = Object.getOwnPropertyDescriptor(value, keys[index]);
      if (!('value' in field)) return unsupported;
      fields[index] = field;
    }
    var tag = objectTag.call(value);
    if (typeof value.toJSON === 'function' && !(tag === '[object Date]' &&
        value.toJSON === native.dateJSON && value.valueOf === native.dateValue &&
        value.toISOString === native.dateISO &&
        value[Symbol.toPrimitive] === native.datePrimitive)) return unsupported;
    if (tag !== '[object Object]' && tag !== '[object Array]') {
      return keys.length ? unsupported : value;
    }
    if (Symbol.toStringTag in value) return unsupported;
    if (value.hasOwnProperty !== Object.prototype.hasOwnProperty) return unsupported;
    var copy = tag === '[object Array]' ?
      Object.setPrototypeOf(new Array(value.length), null) : { ...value };
    copies.set(value, copy);
    for (var index = 0; index < keys.length; index++) {
      var field = fields[index];
      // Stock traversal ignores nonenumerable and symbol properties. Keep their
      // descriptors without walking arbitrary caches or other unsaved state.
      if (field.enumerable && typeof keys[index] === 'string') {
        field.value = copyGraph(field.value, copies, checkedPrototypes, depth + 2);
      }
      if (field.value === unsupported) return unsupported;
      if (field.enumerable && field.writable && field.configurable) {
        copy[keys[index]] = field.value;
      } else {
        Object.defineProperty(copy, keys[index], field);
      }
    }
    Object.setPrototypeOf(copy, Object.getPrototypeOf(value));
    return copy;
  }

  function copyParsedGraph(value, copies) {
    if (!value || typeof value !== 'object') return value;
    if (copies.has(value)) return copies.get(value);
    var copy = Array.isArray(value) ?
      Object.setPrototypeOf(new Array(value.length), null) :
      { ...value };
    copies.set(value, copy);
    var keys = Object.keys(value);
    for (var key of keys) copy[key] = copyParsedGraph(value[key], copies);
    Object.setPrototypeOf(copy, Object.getPrototypeOf(value));
    return copy;
  }

  function unchanged(receiver) {
    var hasOwn = Object.getOwnPropertyDescriptor(Object.prototype, 'hasOwnProperty');
    if (receiver !== JsonEx || JSON.parse !== native.parse || JSON.stringify !== native.stringify ||
        !hasOwn || !('value' in hasOwn) || hasOwn.value !== native.hasOwn ||
        Object.setPrototypeOf !== native.setPrototypeOf) return false;
    for (var name in methods) {
      if (name === 'parse' || name === 'stringify') continue;
      var descriptor = Object.getOwnPropertyDescriptor(JsonEx, name);
      if (!descriptor || descriptor.value !== methods[name]) return false;
    }
    return true;
  }

  function canDecodePrototype(proto, checked) {
    for (; proto; proto = Object.getPrototypeOf(proto)) {
      if (checked.has(proto)) break;
      if (isProxy(proto)) return false;
      for (var key of ['hasOwnProperty', '@', '@c', '@a', '@r', Symbol.toStringTag]) {
        var descriptor = Object.getOwnPropertyDescriptor(proto, key);
        if (!descriptor) continue;
        if (!('value' in descriptor) ||
            (key === 'hasOwnProperty' && descriptor.value !== native.hasOwn) ||
            key === '@a' || key === '@r') return false;
      }
      checked.add(proto);
    }
    return true;
  }

  // Inspect undecoded JSON before any restored prototype can run game code.
  // If a hook could retain a decoded object, return stock's original identities.
  function canRebuild(raw) {
    var pending = Object.setPrototypeOf([raw], null);
    var checked = new Set();
    while (pending.length) {
      var value = pending[pending.length - 1];
      pending.length--;
      if (!value || typeof value !== 'object') continue;
      // Check the original chain before reading inherited metadata.
      if (!canDecodePrototype(Object.getPrototypeOf(value), checked)) return false;
      for (var metadata of ['@c', '@r']) {
        if (Object.prototype.hasOwnProperty.call(value, metadata) &&
            (!Number.isSafeInteger(value[metadata]) || value[metadata] < 1)) return false;
      }
      var proto = Array.isArray(value) ? Array.prototype : Object.prototype;
      if (value['@']) {
        if (typeof value['@'] !== 'string') return false;
        var ctor = Object.getOwnPropertyDescriptor(globalThis, value['@']);
        if (!ctor || !('value' in ctor) || isProxy(ctor.value)) return false;
        var prototype = ctor.value && Object.getOwnPropertyDescriptor(ctor.value, 'prototype');
        if (!prototype || !('value' in prototype)) return false;
        proto = prototype.value;
      }
      if (!canDecodePrototype(proto, checked)) return false;
      if (Object.prototype.hasOwnProperty.call(value, 'hasOwnProperty')) return false;
      for (var key of Object.keys(value)) pending[pending.length] = value[key];
    }
    return true;
  }

  function fallback(operation, receiver, input, reason) {
    PMJS.optimizations.reportFallback(id, operation + ': ' + reason);
    return methods[operation].call(receiver, input);
  }

  JsonEx.stringify = function(object) {
    var depth = Object.getOwnPropertyDescriptor(JsonEx, 'maxDepth');
    var counter = Object.getOwnPropertyDescriptor(JsonEx, '_id');
    if (!unchanged(this) || !depth || typeof depth.value !== 'number' ||
        !counter || typeof counter.value !== 'number') {
      return fallback('stringify', this, object, 'modified serializer');
    }
    var copy = copyGraph(object, new Map(), new Set(), 1);
    if (copy === unsupported) return fallback('stringify', this, object, 'unsupported save graph');
    return methods.stringify.call(this, copy);
  };
  JsonEx.parse = function(json) {
    if (!unchanged(this) || typeof json !== 'string') {
      return fallback('parse', this, json, 'modified serializer or non-string input');
    }
    var raw = native.parse(json);
    if (!canRebuild(raw)) return fallback('parse', this, json, 'unsupported decoded graph');
    // The qualified stock parse sequence, reusing the graph inspected above.
    var circular = [], registry = {};
    var decoded = this._decode(raw, circular, registry);
    this._cleanMetadata(decoded);
    this._linkCircularReference(decoded, circular, registry);
    return copyParsedGraph(decoded, new Map());
  };
  JsonEx._pmjsFastObjects = true;
}
