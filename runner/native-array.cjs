'use strict';

const readers = new WeakMap();

function nativeArray(createArray, read, write) {
  const target = createArray();
  const numeric = key => typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key);
  const mutations = new Set(['copyWithin', 'fill', 'pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift']);
  function copy(values) {
    const result = createArray(); result.length = values.length;
    for (const key of Object.keys(values)) result[key] = values[key];
    return result;
  }
  function sync() { const values = read(); Array.prototype.splice.call(target, 0, target.length, ...values); }
  function replace(values) { write(copy(values)); sync(); }
  const view = new Proxy(target, {
    get(target, key, receiver) {
      if (mutations.has(key) && !Object.hasOwn(target, key)) return (...args) => {
        const values = copy(read()), result = values[key](...args); replace(values);
        return result === values ? view : result;
      };
      sync(); return Reflect.get(target, key, receiver);
    },
    set(target, key, value) {
      if (key !== 'length' && !numeric(key)) return Reflect.set(target, key, value);
      const values = copy(read()); Reflect.set(values, key, value); replace(values); return true;
    },
    deleteProperty(target, key) {
      if (!numeric(key)) return Reflect.deleteProperty(target, key);
      const values = copy(read()); delete values[key]; replace(values); return true;
    },
    has(target, key) { sync(); return Reflect.has(target, key); },
    ownKeys() { sync(); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { sync(); return Reflect.getOwnPropertyDescriptor(target, key); },
    defineProperty() { throw new TypeError('Native arrays do not support custom descriptors'); },
    preventExtensions() { throw new TypeError('Native arrays must remain extensible'); }
  });
  readers.set(view, read);
  return { view, replace };
}

function readNativeArray(value) {
  const read = readers.get(value);
  return read ? read() : value;
}

module.exports = { nativeArray, readNativeArray };
