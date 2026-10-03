'use strict';

(function() {
  var native = NativeHost.effects;
  var effects = new WeakMap();
  var handles = new WeakMap();
  var contexts = new WeakMap();

  function unsupported(detail) {
    PMJS.compat.hit('render.effekseer', detail);
    throw new Error('unsupported native Effekseer operation: ' + detail);
  }
  function dispose(resource) {
    var state = resource.state;
    if (!state.id) return;
    if (resource.kind === 'context') {
      native.releaseContext(state.id);
      state.id = 0;
      state.effects.clear();
      state.handles.clear();
    } else if (state[resource.kind].delete(resource.id)) {
      if (resource.kind === 'effects') native.release(state.id, resource.id);
      else native.control(resource.id, 'release', 0, 0, 0, 0);
    }
  }
  var finalizer = new FinalizationRegistry(dispose);
  function requireContext(state) {
    if (!state.id) throw new Error('native Effekseer context is not initialized');
  }
  function matrix(input) {
    if (!input || input.length !== 16 || Array.from(input).some(value => !Number.isFinite(value))) {
      throw new Error('invalid Effekseer matrix');
    }
    return Array.from(input);
  }
  function createContext() {
    var state = { id: 0, effects: new Set(), handles: new Set(),
      projection: null, camera: null, capture: null };
    var context = {
      init: function() {
        if (state.id) throw new Error('Effekseer context already initialized');
        if (!native || !NativeHost.scene.schema.effects) unsupported('native effects capability');
        state.id = native.createContext();
        finalizer.register(context, { state: state, kind: 'context' }, state);
        return true;
      },
      // Native drawing must restore state even when stock MZ requests manual resets.
      setRestorationOfStatesFlag: function() {},
      loadEffect: function(url, scale, onLoad, onError) {
        requireContext(state);
        var effect = { isLoaded: false };
        var resource = { state: state, context: context, id: 0 };
        effects.set(effect, resource);
        try {
          resource.id = native.load(state.id, decodeURIComponent(url), scale === undefined ? 1 : scale);
          state.effects.add(resource.id);
          finalizer.register(effect, { state: state, kind: 'effects', id: resource.id }, resource);
          queueMicrotask(function() {
            if (!state.id || !state.effects.has(resource.id)) return;
            effect.isLoaded = true;
            if (onLoad) onLoad();
          });
        } catch (error) {
          if (!onError) throw error;
          queueMicrotask(function() { onError(error.message, url); });
        }
        return effect;
      },
      releaseEffect: function(effect) {
        var resource = effects.get(effect);
        if (!resource || resource.state !== state) throw new Error('effect belongs to another context');
        dispose({ state: state, kind: 'effects', id: resource.id });
        finalizer.unregister(resource);
        effect.isLoaded = false;
        resource.id = 0;
      },
      play: function(effect, x, y, z) {
        requireContext(state);
        var resource = effects.get(effect);
        if (!resource || resource.state !== state || !state.effects.has(resource.id) || !effect.isLoaded) {
          throw new Error('Effekseer effect is not loaded in this context');
        }
        var id = native.play(state.id, resource.id, x === undefined ? 0 : x,
          y === undefined ? 0 : y, z === undefined ? 0 : z);
        state.handles.add(id);
        var handle = {};
        var control = function(operation, a, b, c, d) {
          requireContext(state);
          if (!state.handles.has(id)) throw new Error('stale Effekseer handle');
          native.control(id, operation, a === undefined ? 0 : a, b === undefined ? 0 : b,
            c === undefined ? 0 : c, d === undefined ? 0 : d);
        };
        Object.defineProperty(handle, 'exists', { get: function() {
          return !!state.id && state.handles.has(id) && native.exists(id);
        } });
        handle.stop = function() { control('stop'); };
        handle.stopRoot = function() { control('stopRoot'); };
        handle.setLocation = function(a, b, c) { control('location', a, b, c); };
        handle.setRotation = function(a, b, c) { control('rotation', a, b, c); };
        handle.setScale = function(a, b, c) { control('scale', a, b, c); };
        handle.setSpeed = function(a) { control('speed', a); };
        handle.setTargetLocation = function(a, b, c) { control('target', a, b, c); };
        handle.setRandomSeed = function(a) { control('seed', a); };
        handle.setPaused = function(a) { control('paused', Number(!!a)); };
        handle.setShown = function(a) { control('shown', Number(!!a)); };
        handles.set(handle, { state: state, context: context, id: id });
        finalizer.register(handle, { state: state, kind: 'handles', id: id });
        return handle;
      },
      update: function(frames) {
        requireContext(state);
        native.update(state.id, frames === undefined ? 1 : frames);
      },
      stopAll: function() { requireContext(state); native.stopAll(state.id); },
      setProjectionMatrix: function(input) { state.projection = matrix(input); },
      setCameraMatrix: function(input) { state.camera = matrix(input); },
      beginDraw: function() {
        if (!state.capture || state.capture.begun) unsupported('beginDraw outside scene encoding');
        state.capture.begun = true;
      },
      drawHandle: function(handle) {
        var resource = handles.get(handle);
        if (!resource || resource.state !== state) unsupported('foreign animation handle');
        if (!state.capture || !state.capture.begun || state.capture.draw) unsupported('drawHandle outside registered animation');
        if (!state.projection || !state.camera || !state.capture.viewport) throw new Error('incomplete Effekseer draw state');
        state.capture.draw = { kind: 9, resource: resource.id, effect: {
          viewport: state.capture.viewport.slice(), projection: state.projection.slice(), camera: state.camera.slice()
        } };
      },
      endDraw: function() {
        if (!state.capture || !state.capture.begun) unsupported('endDraw outside scene encoding');
        state.capture.begun = false;
      }
    };
    contexts.set(context, state);
    return context;
  }

  globalThis.effekseer = {
    createContext: createContext,
    releaseContext: function(context) {
      var state = contexts.get(context);
      if (!state) throw new Error('foreign Effekseer context');
      dispose({ state: state, kind: 'context' });
      finalizer.unregister(state);
    }
  };
  PMJS.mz = PMJS.mz || {};
  PMJS.mz.encodeEffect = function(animation, renderer) {
    var state = contexts.get(Graphics.effekseer);
    if (!state || !state.id) unsupported('missing animation context');
    var capture = { begun: false, draw: null, viewport: null };
    var facade = { view: renderer.view, gl: {
      viewport: function(x, y, width, height) { capture.viewport = [x, y, width, height]; }
    } };
    var reset = function() {};
    ['batch', 'geometry', 'texture', 'state', 'shader', 'framebuffer'].forEach(function(name) {
      facade[name] = { reset: reset, flush: reset };
    });
    if (state.capture) unsupported('nested animation drawing');
    state.capture = capture;
    try {
      animation._render(facade);
      if (capture.draw) {
        if (capture.begun || capture.viewport[0] !== 0 || capture.viewport[1] !== 0) {
          unsupported('incomplete animation viewport reset');
        }
        capture.draw.effect.resetViewport = capture.viewport.slice(2);
      }
      return capture.draw || { kind: 0, resource: 0 };
    } finally { state.capture = null; }
  };
})();
