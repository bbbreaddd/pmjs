'use strict';

function nativeDictionary(createObject, invoke) {
  const target = createObject();
  const keyId = key => typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) <= 2147483647 ? Number(key) : null;
  const view = new Proxy(target, {
    get(target, key, receiver) { const id = keyId(key); return id === null ? Reflect.get(target, key, receiver) : invoke('value', id); },
    set(target, key, value) { const id = keyId(key); if (id === null) throw new TypeError('Native dictionary keys must be nonnegative integers'); invoke('set', id, value); return true; },
    deleteProperty(target, key) { const id = keyId(key); if (id === null) return false; invoke('delete', id); return true; },
    has(target, key) { const id = keyId(key); return id === null ? Reflect.has(target, key) : invoke('value', id) !== undefined; },
    ownKeys() { return Object.keys(invoke('read')); },
    getOwnPropertyDescriptor(target, key) {
      const id = keyId(key), value = id === null ? undefined : invoke('value', id);
      return value === undefined ? undefined : { configurable: true, enumerable: true, writable: true, value };
    },
    defineProperty() { throw new TypeError('Native dictionaries do not support custom descriptors'); },
    preventExtensions() { throw new TypeError('Native dictionaries must remain extensible'); }
  });
  return { view, replace(value) {
    if (!value || typeof value !== 'object') throw new TypeError('Native dictionary replacement requires an object');
    const snapshot = Object.create(null);
    for (const key of Object.keys(value)) {
      if (keyId(key) === null) throw new TypeError('Native dictionary keys must be nonnegative integers');
      snapshot[key] = value[key];
    }
    invoke('replace', snapshot);
  } };
}

module.exports = { nativeDictionary };
