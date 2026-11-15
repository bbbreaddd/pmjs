'use strict';
const index = key => typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 2147483647;

function createDataArrayView(invoke, createArray) {
  const target = createArray([]);
  const syncLength = () => { target.length = invoke('dataLength'); };
  return new Proxy(target, {
    get(target, key, receiver) {
      if (key === 'length') return invoke('dataLength');
      return index(key) ? invoke('rawValue', Number(key)) : Reflect.get(target, key, receiver);
    },
    set(target, key, value) {
      if (key === 'length') { invoke('dataLength', value); return true; }
      if (index(key)) { invoke('rawSet', Number(key), value); return true; }
      return Reflect.set(target, key, value);
    },
    has(target, key) { return index(key) ? invoke('rawHas', Number(key)) : Reflect.has(target, key); },
    deleteProperty(target, key) {
      if (index(key)) { invoke('rawDelete', Number(key)); return true; }
      return Reflect.deleteProperty(target, key);
    },
    ownKeys() { syncLength(); return [...new Set([...invoke('dataKeys'), ...Reflect.ownKeys(target)])]; },
    getOwnPropertyDescriptor(target, key) {
      if (key === 'length') { syncLength(); return Reflect.getOwnPropertyDescriptor(target, key); }
      if (!index(key)) return Reflect.getOwnPropertyDescriptor(target, key);
      return invoke('rawHas', Number(key)) ? { configurable: true, enumerable: true, writable: true, value: invoke('rawValue', Number(key)) } : undefined;
    },
    defineProperty() { throw new TypeError('Game data arrays do not support custom property descriptors'); },
    preventExtensions() { throw new TypeError('Game data arrays must remain extensible'); }
  });
}

function installDataArray(prototype, engine, session, kind, createArray) {
  const invoke = (method, ...args) => engine.gameDataInvoke(session, kind, method, args);
  const views = new WeakMap();
  Object.defineProperty(prototype, '_data', {
    configurable: true,
    get() {
      if (!views.has(this)) {
        views.set(this, createDataArrayView(invoke, createArray));
      }
      return views.get(this);
    },
    set(value) {
      if (!Array.isArray(value)) throw new TypeError('Game data requires an array');
      invoke('replaceData', value.length, Object.fromEntries(Object.keys(value).filter(index).map(key => [key, value[key]])));
    }
  });
}

module.exports = { installDataArray, createDataArrayView };
