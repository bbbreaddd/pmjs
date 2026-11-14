'use strict';

function installClassBindings(scope, bindings, session, options = {}) {
  const descriptions = bindings.describe();
  const points = new WeakMap(), returnValues = new WeakMap(), listeners = new WeakMap();
  let nextListener = 1;
  const schemas = new Map(descriptions.map(description => [description.name, description]));
  const prototypes = new Map(), models = new WeakMap(), instances = new Map(), active = new Map(), defaults = new Map(), installed = new Map();
  function descriptionFor(object) {
    for (let prototype = Object.getPrototypeOf(object); prototype; prototype = Object.getPrototypeOf(prototype))
      if (prototypes.has(prototype)) return prototypes.get(prototype);
    throw new TypeError('Object does not inherit a bound native class');
  }
  function install(description) {
    if (installed.has(description.name)) return installed.get(description.name);
    if (scope[description.name] !== undefined) throw new Error('Native class is already installed: ' + description.name);
    const parent = description.parent === 'Object' ? Object : schemas.has(description.parent) ? install(schemas.get(description.parent)) : scope[description.parent];
    if (typeof parent !== 'function') throw new Error('Native class parent is unavailable: ' + description.parent);
    const Type = function() { this.initialize.apply(this, arguments); };
    Object.defineProperty(Type, 'name', { value: description.name });
    Type.prototype = Object.create(parent.prototype); Type.prototype.constructor = Type;
    prototypes.set(Type.prototype, description);
    if (!schemas.has(description.parent)) Type.prototype.initialize = function(...args) {
      const nativeType = descriptionFor(this);
      if (!models.has(this)) {
        const handle = bindings.create(session, nativeType.name);
        models.set(this, handle); instances.set(handle.identity, new WeakRef(this));
        if (!options.initializeDisplay?.(this, handle)) parent.prototype.initialize?.apply(this, args);
      }
      if (nativeType.initializer) this[nativeType.initializer](...nativeType.constructorDefaults.map((value, index) => args[index] === undefined ? value : args[index]));
    };
    for (const field of description.fields) Object.defineProperty(Type.prototype, field.name, {
      configurable: true,
      get() {
        const handle = models.get(this);
        if (field.kind === 'display') return options.displayField(handle, field.name);
        if (field.kind !== 'point') return bindings.field(handle, field.name);
        let cache = points.get(this);
        if (!cache) { cache = new Map(); points.set(this, cache); }
        if (!cache.has(field.name)) {
          const point = {};
          for (const key of ['x', 'y']) Object.defineProperty(point, key, {
            enumerable: true,
            get() { return bindings.field(handle, field.name)[key]; },
            set(value) { const current = bindings.field(handle, field.name); current[key] = value; bindings.field(handle, field.name, current); }
          });
          point.set = function(x = 0, y = x) { bindings.field(handle, field.name, { x, y }); };
          cache.set(field.name, point);
        }
        return cache.get(field.name);
      },
      ...(field.writable ? { set(value) {
        if (field.kind === 'display') options.displayField(models.get(this), field.name, value);
        else if (field.kind === 'point') bindings.field(models.get(this), field.name, { x: value.x, y: value.y });
        else bindings.field(models.get(this), field.name, value);
      } } : {})
    });
    const methods = new Map(); defaults.set(description.name, methods);
    for (const method of description.methods) {
      const forward = function(...args) {
        if (method.defaults?.length) args = method.defaults.map((value, index) => args[index] === undefined ? value : args[index]);
        const nativeArgs = args.map((value, index) => {
          if (method.argumentKinds?.[index] !== 'object') return value;
          if (value === null) return null;
          const handle = models.get(value) || options.unwrap?.(value);
          if (!handle) throw new TypeError('Native object argument is not bound');
          return handle;
        });
        const value = bindings.invoke(models.get(this), method.name, nativeArgs);
        for (const alias of method.aliases || []) this[alias.property] = args[alias.index];
        return value;
      };
      Object.defineProperties(forward, { name: { value: method.name }, length: { value: method.arity } });
      Type.prototype[method.name] = forward; methods.set(method.name, forward);
      returnValues.set(forward, method.returnsValue !== false);
    }
    for (const event of description.events || []) Type.prototype[event] = function(listener) {
      if (typeof listener !== 'function') throw new TypeError('Listener must be a function');
      let callbacks = listeners.get(this);
      if (!callbacks) { callbacks = new Map(); listeners.set(this, callbacks); }
      const token = nextListener++; callbacks.set(token, listener);
      try { bindings.listen(models.get(this), event, token); }
      catch (error) { callbacks.delete(token); throw error; }
    };
    for (const method of description.statics || []) Type[method.name] = function(...args) {
      return bindings.invokeStatic(description.name, method.name, method.defaults.map((value, index) => args[index] === undefined ? value : args[index]));
    };
    if (!methods.has('initialize')) { methods.set('initialize', Type.prototype.initialize); returnValues.set(Type.prototype.initialize, false); }
    scope[description.name] = Type; installed.set(description.name, Type);
    return Type;
  }
  for (const description of descriptions) install(description);
  function original(type, method) {
    for (let description = schemas.get(type); description; description = schemas.get(description.parent))
      if (defaults.get(description.name)?.has(method)) return defaults.get(description.name).get(method);
    throw new Error('Native default is unavailable: ' + type + '.' + method);
  }
  function wrap(handle, type) {
    let object = active.get(handle.identity) || instances.get(handle.identity)?.deref();
    if (!object) {
      object = Object.create(scope[type].prototype);
      let root = schemas.get(type);
      while (schemas.has(root.parent)) root = schemas.get(root.parent);
      models.set(object, handle); instances.set(handle.identity, new WeakRef(object));
      if (!options.initializeDisplay?.(object, handle)) scope[root.parent]?.prototype.initialize?.call(object);
    }
    if (bindings.active(handle)) active.set(handle.identity, object);
    return object;
  }
  return {
    descriptions, wrap,
    handle(object) { const handle = models.get(object); if (!handle) throw new TypeError('Object is not bound'); return handle; },
    deliver(handle, token) {
      const object = active.get(handle.identity) || instances.get(handle.identity)?.deref();
      if (!object) return;
      const callbacks = listeners.get(object);
      if (!token) { callbacks?.clear(); return; }
      const callback = callbacks?.get(token); callbacks?.delete(token);
      if (callback) callback();
    },
    dispatch(handle, type, method, args) {
      const existing = active.get(handle.identity) || instances.get(handle.identity)?.deref();
      const native = original(type, method);
      if ((existing ? existing[method] : scope[type].prototype[method]) === native) return null;
      const object = wrap(handle, type);
      const value = object[method](...(typeof args === 'function' ? args() : args));
      return { value: returnValues.get(native) ? value : undefined };
    },
    sweep() {
      for (const [id, weak] of instances) if (!weak.deref()) instances.delete(id);
      for (const [id, object] of active) if (!bindings.active(models.get(object))) active.delete(id);
    }
  };
}
module.exports = { installClassBindings };
