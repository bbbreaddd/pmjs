// Stock MV 1.6 JsonEx tags every live object it serializes ('@c', '@') and removes
// the tags with `delete`; parse deletes them from every decoded object too. V8
// keeps an object with deleted properties in dictionary mode for good, so after
// one save, load or makeDeepCopy every game object reads its fields through a
// hash lookup. The stock algorithm stays in charge of the bytes: stringify runs
// it on a clone of the graph, and parse rebuilds its result once into objects
// that were never deleted from.
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
    '57729a719060c2913b865615d3addf627573478f50f9e9fce168323ecad040c0']
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

  var MAX_SHAPE_KEYS = 128;
  var MAX_SHAPES = 2000;
  var shapes = new Map();
  var objectTag = Object.prototype.toString;

  // V8 keeps only about a dozen properties added through computed keys in fast
  // mode, but up to 128 added through literal names as constructors add them.
  function shapeFor(keys) {
    var signature = keys.join('\u0000');
    var shape = shapes.get(signature);
    if (shape || shapes.size >= MAX_SHAPES) return shape || null;
    var body = 'var o = Object.create(proto);\n';
    for (var index = 0; index < keys.length; index++) {
      body += 'o[' + JSON.stringify(keys[index]) + '] = undefined;\n';
    }
    shape = new Function('proto', body + 'return o;');
    shapes.set(signature, shape);
    return shape;
  }

  // Same prototypes, own enumerable keys in order, array lengths and holes,
  // accessors and sharing (one copy per object); other values are shared.
  function copyGraph(value, copies) {
    var tag = value && typeof value === 'object' ? objectTag.call(value) : '';
    if (tag !== '[object Object]' && tag !== '[object Array]') return value;
    var copy = copies.get(value);
    if (copy) return copy;
    var keys = Object.keys(value);
    var descriptors = new Array(keys.length);
    var dataOnly = true;
    for (var index = 0; index < keys.length; index++) {
      descriptors[index] = Object.getOwnPropertyDescriptor(value, keys[index]);
      if (!('value' in descriptors[index])) dataOnly = false;
    }
    if (tag === '[object Array]') {
      copy = new Array(value.length);
    } else {
      var proto = Object.getPrototypeOf(value);
      var shape = dataOnly && keys.length <= MAX_SHAPE_KEYS ? shapeFor(keys) : null;
      copy = shape ? shape(proto) : Object.create(proto);
    }
    copies.set(value, copy);
    for (var key = 0; key < keys.length; key++) {
      if ('value' in descriptors[key]) {
        copy[keys[key]] = copyGraph(descriptors[key].value, copies);
      } else {
        Object.defineProperty(copy, keys[key], descriptors[key]);
      }
    }
    return copy;
  }

  var stringify = JsonEx.stringify;
  var parse = JsonEx.parse;
  JsonEx.stringify = function(object) {
    return stringify.call(this, copyGraph(object, new Map()));
  };
  JsonEx.parse = function(json) {
    return copyGraph(parse.call(this, json), new Map());
  };
  JsonEx._pmjsFastObjects = true;
}
