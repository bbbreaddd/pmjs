'use strict';

function installEquipArray(scope, read, write, createArray) {
  const arrays = new WeakMap();
  const mutations = new Set(['copyWithin', 'fill', 'pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift']);
  const numeric = key => typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key);
  function state(actor) {
    if (arrays.has(actor)) return arrays.get(actor);
    const target = createArray([]), slots = new Map();
    const record = { target, slots };
    const values = () => [read(actor, 'equips'), read(actor, 'equipKinds')];
    function item(index, ids, kinds) {
      if (!slots.has(index)) {
        const data = { index, id: ids[index], kind: kinds[index], attached: true };
        const object = Object.create(scope.Game_Item.prototype);
        for (const [field, key] of [['_itemId', 'id'], ['_dataClass', 'kind']]) Object.defineProperty(object, field, {
          configurable: true, enumerable: true,
          get() {
            const index = data.index;
            if (data.attached) {
              const [current, types] = values();
              if (index < current.length) { data.id = current[index]; data.kind = types[index]; }
              else data.attached = false;
            }
            return key === 'id' ? data.id : data.kind === 1 ? 'weapon' : data.kind === 2 ? 'armor' : '';
          },
          set(value) {
            const index = data.index;
            if (data.attached) {
              const [current, types] = values();
              if (index < current.length) { data.id = current[index]; data.kind = types[index]; }
              else data.attached = false;
            }
            if (key === 'id') data.id = value;
            else data.kind = value === 'weapon' ? 1 : value === 'armor' ? 2 : 0;
            if (data.attached) {
              const [current, types] = values();
              if (index >= current.length) { data.attached = false; return; }
              current[index] = data.id; types[index] = data.kind;
              write(actor, 'equips', current); write(actor, 'equipKinds', types);
            }
          }
        });
        slots.set(index, { data, object });
      }
      return slots.get(index).object;
    }
    function sync() {
      const [ids, kinds] = values();
      for (const [index, slot] of slots) if (index >= ids.length) { slot.data.attached = false; slots.delete(index); }
      target.length = ids.length;
      for (let index = 0; index < ids.length; ++index) target[index] = item(index, ids, kinds);
    }
    record.replace = function(items) {
      const ids = [], kinds = [];
      for (let index = 0; index < items.length; ++index) {
        const value = items[index]; ids.push(value ? value._itemId : 0);
        kinds.push(value?._dataClass === 'weapon' ? 1 : value?._dataClass === 'armor' ? 2 : 0);
      }
      const prior = new Map(Array.from(slots.values(), slot => [slot.object, slot]));
      const retained = new Set(), next = new Map();
      for (let index = 0; index < items.length; ++index) {
        const slot = prior.get(items[index]);
        if (slot && !retained.has(slot)) { next.set(index, slot); retained.add(slot); }
      }
      for (const slot of slots.values()) if (!retained.has(slot)) {
        slot.data.id = slot.object._itemId;
        const type = slot.object._dataClass; slot.data.kind = type === 'weapon' ? 1 : type === 'armor' ? 2 : 0;
        slot.data.attached = false;
      }
      slots.clear();
      for (const [index, slot] of next) { slot.data.index = index; slots.set(index, slot); }
      write(actor, 'equips', ids); write(actor, 'equipKinds', kinds); sync();
    };
    record.view = new Proxy(target, {
      get(target, key, receiver) {
        if (mutations.has(key) && !Object.hasOwn(target, key)) return (...args) => {
          sync(); const values = Array.from(target), result = values[key](...args); record.replace(values);
          return result === values ? record.view : result;
        };
        sync(); return Reflect.get(target, key, receiver);
      },
      set(target, key, value) {
        if (key !== 'length' && !numeric(key)) return Reflect.set(target, key, value);
        sync(); const replacement = Array.from(target); Reflect.set(replacement, key, value); record.replace(replacement); return true;
      },
      deleteProperty(target, key) {
        if (!numeric(key)) return Reflect.deleteProperty(target, key);
        sync(); const replacement = Array.from(target); delete replacement[key]; record.replace(replacement); return true;
      },
      has(target, key) { sync(); return Reflect.has(target, key); },
      ownKeys() { sync(); return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, key) { sync(); return Reflect.getOwnPropertyDescriptor(target, key); },
      defineProperty() { throw new TypeError('Equipment arrays do not support custom descriptors'); },
      preventExtensions() { throw new TypeError('Equipment arrays must remain extensible'); }
    });
    arrays.set(actor, record); return record;
  }
  Object.defineProperty(scope.Game_Actor.prototype, '_equips', { configurable: true, enumerable: true,
    get() { return state(this).view; }, set(items) { state(this).replace(items); }
  });
}

module.exports = { installEquipArray };
