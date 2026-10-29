PMJS.mv = PMJS.mv || {};
PMJS.mv.pictureLayerCache = (function() {
  var current = null;
  var capturing = false;
  var counters = { captures: 0, hits: 0, invalidations: 0, fallbacks: 0, failures: 0 };
  function release(state) {
    if (state && state.owned) {
      var transform = Object.getOwnPropertyDescriptor(state.node, 'updateTransform');
      var render = Object.getOwnPropertyDescriptor(state.node, 'renderWebGL');
      var bounds = state.boundsMethods.map(function(method) {
        return Object.getOwnPropertyDescriptor(state.node, method.name);
      });
      state.node.cacheAsBitmap = false;
      if (transform && transform.value !== state.transform) {
        Object.defineProperty(state.node, 'updateTransform', transform);
      } else if (!state.transformOwn || !transform) delete state.node.updateTransform;
      if (render && render.value !== state.node._renderCachedWebGL) {
        Object.defineProperty(state.node, 'renderWebGL', render);
      } else if (!state.renderOwn || !render) delete state.node.renderWebGL;
      state.boundsMethods.forEach(function(method, index) {
        var descriptor = bounds[index];
        if (descriptor && descriptor.value !== method.original) {
          Object.defineProperty(state.node, method.name, descriptor);
        } else if (!method.own || !descriptor) delete state.node[method.name];
      });
      state.owned = false;
      counters.invalidations++;
    }
  }
  function equal(left, right) {
    return left && right && left.length === right.length &&
      left.every(function(value, index) { return value === right[index]; });
  }
  function equalPrefix(left, right, count) {
    var length = left && left.ends[count - 1];
    if (length === undefined || !right || length !== right.ends[count - 1]) return false;
    for (var index = 0; index < length; index++) if (left[index] !== right[index]) return false;
    return true;
  }
  function rectangle(values, rect) {
    values.push(rect && rect.x, rect && rect.y, rect && rect.width, rect && rect.height);
  }
  function ordinaryWorldState(node) {
    var local = node.transform.localTransform, world = node.worldTransform;
    var parent = node.parent && node.parent.worldTransform;
    if (!world || !local) return false;
    if (node.worldAlpha !== node.alpha * (node.parent ? node.parent.worldAlpha : 1)) return false;
    if (!parent) return world.a === local.a && world.b === local.b &&
      world.c === local.c && world.d === local.d && world.tx === local.tx && world.ty === local.ty;
    return world.a === local.a * parent.a + local.b * parent.c &&
      world.b === local.a * parent.b + local.b * parent.d &&
      world.c === local.c * parent.a + local.d * parent.c &&
      world.d === local.c * parent.b + local.d * parent.d &&
      world.tx === local.tx * parent.a + local.ty * parent.c + parent.tx &&
      world.ty === local.tx * parent.b + local.ty * parent.d + parent.ty;
  }
  function signature(node, renderer, state) {
    if (node.constructor !== Sprite || node.bitmap || node.alpha !== 1 ||
        node.worldAlpha !== 1 || !ordinaryWorldState(node) ||
        node.texture && node.texture.baseTexture && node.texture.baseTexture.source ||
        node.mask || node._filters || node.shader || node.blendMode ||
        node._cacheAsBitmap && !state.owned) return null;
    for (var ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
      if (ancestor.alpha !== 1) return null;
    }
    var layerProducer = pmjsPixiRenderPreflight.producer(node);
    if (state.owned && node.renderWebGL !== node._renderCachedWebGL ||
        (state.owned ? node._cacheData.originalRenderWebGL : node.renderWebGL) !==
        layerProducer.renderWebGL || Sprite.prototype.renderWebGL !== layerProducer.renderWebGL ||
        node._renderWebGL !== layerProducer._renderWebGL) return null;
    var values = [renderer.resolution, renderer.roundPixels, node._openness];
    values.ends = []; values.areas = []; values.images = [];
    var area = 0, images = 0;
    for (var index = 0; index < node.children.length; index++) {
      var child = node.children[index];
      values.push(child, child.visible, child.renderable, child.alpha);
      if (!child.visible || !child.renderable || child.alpha <= 0) {
        values.ends.push(values.length); values.areas.push(area); values.images.push(images);
        continue;
      }
      if (!ordinaryWorldState(child) || child.children.length || child.mask || child._filters || child.shader ||
          child.blendMode || child._cacheAsBitmap ||
          child.pluginName !== 'sprite' && child.pluginName !== 'picture') break;
      var producer = pmjsPixiRenderPreflight.producer(child);
      if (producer.filterAccess !== 'backing' ||
          pmjsPixiRenderPreflight.unsupportedMethod(child, producer)) break;
      var tone = child._colorTone, blend = child._blendColor;
      if (tone && tone.some(function(value) { return value !== 0; }) ||
          blend && blend[3]) break;
      var texture = child.texture, base = texture && texture.baseTexture;
      var frame = texture && texture._frame, source = base && base.source;
      if (!source && frame && !frame.width && !frame.height) {
        values.ends.push(values.length); values.areas.push(area); values.images.push(images);
        continue;
      }
      // Canvas and video contents need a different invalidation contract.
      if (!(source instanceof NativeImage) || !source._nativeImage || source._nativeCanvas ||
          typeof source.getContext === 'function' || !frame ||
          frame.width <= 0 || frame.height <= 0 || texture.rotate) break;
      var image = nativeTextureSource(source);
      if (!image) break;
      if (child.bitmap) child.bitmap.touch();
      renderer.bindTexture(base);
      var transform = child.transform.localTransform;
      values.push(child, child.alpha, child.tint, child._openness, texture, texture._updateID,
        base, base._updateID, base.scaleMode, base.resolution, source, image.handle,
        transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty,
        child.anchor.x, child.anchor.y);
      rectangle(values, frame); rectangle(values, texture.orig); rectangle(values, texture.trim);
      area += frame.width * frame.height; images++;
      values.ends.push(values.length); values.areas.push(area); values.images.push(images);
    }
    return values;
  }
  function prepare(stage, renderer) {
    if (capturing || !renderer || !renderer.renderingToScreen) return;
    var node = stage && stage._spriteset && stage._spriteset._pictureContainer;
    if (current && current.node !== node) { release(current); current = null; }
    if (!node || !node.visible || !node.renderable || renderer.resolution !== 1) return;
    var state = current || (current = { node: node, owned: false, signature: null, stable: [] });
    if (state.owned && !node._cacheAsBitmap) state.owned = false;
    var next = signature(node, renderer, state);
    var previous = state.signature;
    state.signature = next;
    if (state.owned && equalPrefix(state.captured, next, state.count)) {
      counters.hits++; return;
    }
    release(state);
    if (!next) { state.stable = []; state.failed = false; counters.fallbacks++; return; }
    if (!equal(previous, next)) state.failed = false;
    state.stable = next.ends.map(function(_, index) {
      return equalPrefix(previous, next, index + 1) ? (state.stable[index] || 0) + 1 : 0;
    });
    if (state.failed) return;
    var count = 0;
    for (var index = 0; index < state.stable.length; index++) {
      if (state.stable[index] >= 8 && next.images[index] >= 2 &&
          next.areas[index] >= renderer.screen.width * renderer.screen.height) count = index + 1;
    }
    if (!count) return;
    var children = node.children;
    node.children = children.slice(0, count);
    var bounds;
    try { bounds = node.getLocalBounds(); }
    finally { node.children = children; }
    if (bounds.width <= 0 || bounds.height <= 0 || bounds.width > 2048 ||
        bounds.height > 2048 || bounds.width * bounds.height * 4 > 8 * 1024 * 1024) return;
    state.transformOwn = Object.prototype.hasOwnProperty.call(node, 'updateTransform');
    state.renderOwn = Object.prototype.hasOwnProperty.call(node, 'renderWebGL');
    state.transform = node.updateTransform;
    state.boundsMethods = ['_calculateBounds', 'getLocalBounds'].map(function(name) {
      return { name: name, original: node[name], own: Object.prototype.hasOwnProperty.call(node, name) };
    });
    state.count = count; state.captured = next;
    node.cacheAsBitmap = true;
    state.owned = true;
    capturing = true;
    node.__pmjsBuildingBitmapCache = true;
    try {
      node.children = children.slice(0, count);
      node._initCachedDisplayObject(renderer);
      // Keep guest transform callbacks running even while the pixels are reused.
      node.updateTransform = node._cacheData.originalUpdateTransform;
      if (!state.transformOwn) delete node.updateTransform;
      state.boundsMethods.forEach(function(method) {
        node[method.name] = method.original;
        if (!method.own) delete node[method.name];
      });
      counters.captures++;
    } catch (error) {
      var id = node._cacheData && node._cacheData.textureCacheId;
      var texture = id && PIXI.utils.TextureCache[id];
      var partial = !node._cacheData.sprite;
      release(state);
      if (partial && texture) texture.destroy(true);
      state.failed = true; counters.failures++;
    } finally {
      node.children = children;
      // Snapshot bounds preparation temporarily normalizes descendant world state.
      if (node.parent) node.updateTransform();
      capturing = false;
      node.__pmjsBuildingBitmapCache = false;
    }
  }
  function validate(node, renderer) {
    // Earlier render producers can change a later layer after transform preparation.
    if (!capturing && current && current.node === node && current.owned &&
        !equalPrefix(current.captured, signature(node, renderer, current), current.count)) {
      release(current); current.signature = null; current.stable = [];
    }
  }
  return { prepare: prepare, validate: validate, release: function() { release(current); current = null; },
    tail: function(node) {
      return current && current.node === node && current.owned ? node.children.slice(current.count) : [];
    },
    diagnostics: function() { return Object.assign({ active: !!(current && current.owned),
      cachedChildren: current && current.owned ? current.count : 0 }, counters); } };
})();
