'use strict';

function installClassBindings(scope, bindings, session) {
  const descriptions = bindings.describe();
  const schemas = new Map(descriptions.map(description => [description.name, description]));
  const prototypes = new Map(), models = new WeakMap(), active = new Map(), defaults = new Map(), installed = new Map();
  function descriptionFor(object) {
    for (let prototype = Object.getPrototypeOf(object); prototype; prototype = Object.getPrototypeOf(prototype))
      if (prototypes.has(prototype)) return prototypes.get(prototype);
    throw new TypeError('Object does not inherit a bound native class');
  }
  function install(description) {
    if (installed.has(description.name)) return installed.get(description.name);
    if (scope[description.name] !== undefined) throw new Error('Native class is already installed: ' + description.name);
    const parent = schemas.has(description.parent) ? install(schemas.get(description.parent)) : scope[description.parent];
    if (typeof parent !== 'function') throw new Error('Native class parent is unavailable: ' + description.parent);
    const Type = function() { this.initialize.apply(this, arguments); };
    Object.defineProperty(Type, 'name', { value: description.name });
    Type.prototype = Object.create(parent.prototype); Type.prototype.constructor = Type;
    prototypes.set(Type.prototype, description);
    if (!schemas.has(description.parent)) Type.prototype.initialize = function(...args) {
      parent.prototype.initialize.apply(this, args);
      models.set(this, bindings.create(session, descriptionFor(this).name));
    };
    for (const field of description.fields) Object.defineProperty(Type.prototype, field.name, {
      configurable: true,
      get() { return bindings.field(models.get(this), field.name); },
      ...(field.writable ? { set(value) { bindings.field(models.get(this), field.name, value); } } : {})
    });
    const methods = new Map(); defaults.set(description.name, methods);
    for (const method of description.methods) {
      const forward = function(...args) { return bindings.invoke(models.get(this), method.name, args); };
      Object.defineProperties(forward, { name: { value: method.name }, length: { value: method.arity } });
      Type.prototype[method.name] = forward; methods.set(method.name, forward);
    }
    scope[description.name] = Type; installed.set(description.name, Type);
    return Type;
  }
  for (const description of descriptions) install(description);
  function original(type, method) {
    for (let description = schemas.get(type); description; description = schemas.get(description.parent))
      if (defaults.get(description.name)?.has(method)) return defaults.get(description.name).get(method);
    throw new Error('Native default is unavailable: ' + type + '.' + method);
  }
  return {
    descriptions,
    dispatch(handle, type, method, args) {
      if (scope[type].prototype[method] === original(type, method)) return null;
      let object = active.get(handle.identity);
      if (!object) {
        object = Object.create(scope[type].prototype);
        let root = schemas.get(type);
        while (schemas.has(root.parent)) root = schemas.get(root.parent);
        scope[root.parent].prototype.initialize.call(object);
        models.set(object, handle); active.set(handle.identity, object);
      }
      return { value: object[method](...args) };
    },
    sweep() {
      for (const [id, object] of active) if (!bindings.active(models.get(object))) active.delete(id);
    }
  };
}
module.exports = { installClassBindings };
