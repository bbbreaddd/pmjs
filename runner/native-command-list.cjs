'use strict';

function commandList(read, replace, update, createArray) {
  const target = createArray([]), records = new Map();
  const numeric = key => typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key);
  function sync() {
    const values = read();
    target.length = values.length;
    for (const [index, record] of records) {
      if (index >= values.length) { record.attached = false; records.delete(index); }
      else record.value = values[index];
    }
    for (let index = 0; index < values.length; ++index) {
      if (!records.has(index)) {
        const record = { index, attached: true, value: values[index] }, object = {};
        for (const field of ['name', 'symbol', 'enabled', 'ext']) Object.defineProperty(object, field, {
          enumerable: true, configurable: true,
          get() {
            if (record.attached) {
              const current = read()[record.index];
              if (current) record.value = current; else record.attached = false;
            }
            return record.value[field];
          },
          set(value) {
            if (record.attached) {
              const current = read()[record.index];
              if (current) record.value = current; else record.attached = false;
            }
            record.value = { ...record.value, [field]: value };
            if (record.attached) update(record.index, record.value);
          }
        });
        records.set(index, Object.assign(record, { object }));
      }
      target[index] = records.get(index).object;
    }
  }
  function detach() {
    sync();
    for (const record of records.values()) record.attached = false;
    records.clear();
  }
  const mutations = new Set(['copyWithin', 'fill', 'pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift']);
  function assign(items) {
    const snapshot = Array.from(items, item => ({ name: item.name, symbol: item.symbol, enabled: item.enabled, ext: item.ext }));
    sync();
    const prior = new Map(Array.from(records.values(), record => [record.object, record]));
    const retained = new Set(), next = new Map();
    for (let index = 0; index < items.length; ++index) {
      const record = prior.get(items[index]);
      if (record && !retained.has(record)) { next.set(index, record); retained.add(record); }
    }
    for (const record of records.values()) if (!retained.has(record)) record.attached = false;
    records.clear();
    for (const [index, record] of next) { record.index = index; records.set(index, record); }
    replace(snapshot); sync();
  }
  const view = new Proxy(target, {
    get(target, key, receiver) {
      if (mutations.has(key) && !Object.hasOwn(target, key)) return (...args) => {
        sync(); const values = Array.from(target), result = values[key](...args); assign(values);
        return result === values ? view : result;
      };
      sync(); return Reflect.get(target, key, receiver);
    },
    set(target, key, value) {
      if (key !== 'length' && !numeric(key)) return Reflect.set(target, key, value);
      sync(); const values = Array.from(target); Reflect.set(values, key, value); assign(values); return true;
    },
    has(target, key) { sync(); return Reflect.has(target, key); },
    ownKeys() { sync(); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { sync(); return Reflect.getOwnPropertyDescriptor(target, key); },
    deleteProperty(target, key) {
      if (numeric(key)) throw new TypeError('Command lists require populated entries');
      return Reflect.deleteProperty(target, key);
    },
    defineProperty() { throw new TypeError('Command lists do not support custom descriptors'); },
    preventExtensions() { throw new TypeError('Command lists must remain extensible'); }
  });
  return { view, assign, detach };
}

module.exports = { commandList };
