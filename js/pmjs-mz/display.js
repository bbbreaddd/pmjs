'use strict';

(function() {
  var pixi = PMJS.pixi5;
  var layers = new WeakMap();
  var atlases = new WeakMap();
  var defaultRenderer = {};
  var finalizer = new FinalizationRegistry(function(resource) {
    NativeHost.render.releaseTileLayer(resource.handle);
  });
  var shadowCanvas;

  function releaseAtlas(renderer) {
    var atlas = atlases.get(renderer || defaultRenderer);
    if (!atlas) return;
    atlas.forEach(function(slot) { slot._releaseNativeCanvas(); });
    atlases.delete(renderer || defaultRenderer);
  }

  function tileAtlas(layer, renderer) {
    renderer = renderer || defaultRenderer;
    var atlas = atlases.get(renderer);
    if (!atlas) {
      atlas = [];
      atlases.set(renderer, atlas);
    }
    if (layer._needsTexturesUpdate) {
      // MZ uploads only the supplied slots; other slots retain their contents.
      // Immutable snapshots keep earlier encoded draws intact during later uploads.
      layer._images.forEach(function(source, index) {
        if (source.width > 1024 || source.height > 1024 || index >= 12) {
          pixi.rejectRender('render.tile-atlas-size', layer, 'unsupported atlas upload dimensions');
        }
        var native = pixi.nativeSource(source);
        var cacheable = source._nativeImage || typeof source.__pmjsContentRevision === 'number';
        var signature = native && [native.handle, source.__pmjsContentRevision,
          source.width, source.height].join(':');
        var previous = atlas[index];
        if (cacheable && previous && previous.__pmjsTileUploadSignature === signature) return;
        var slot = new CanvasElement();
        slot.width = slot.height = 1024;
        slot.getContext('2d').drawImage(source, 0, 0);
        slot.__pmjsTileUploadSignature = signature;
        atlas[index] = slot;
        if (previous) previous._releaseNativeCanvas();
      });
      layer._needsTexturesUpdate = false;
    }
    return atlas;
  }

  function releaseLayer(layer) {
    var resource = layers.get(layer);
    if (!resource) return;
    finalizer.unregister(resource);
    NativeHost.render.releaseTileLayer(resource.handle);
    layers.delete(layer);
  }

  function tileLayer(layer, renderer) {
    var atlas = tileAtlas(layer, renderer);
    if (!layer._elements.length) {
      releaseLayer(layer);
      return { kind: 0, resource: 0 };
    }
    var handles = [];
    var textureIndices = new Map();
    var points = [];
    var revisions = [];
    for (var element of layer._elements) {
      var source;
      if (element[0] < 0) {
        if (!shadowCanvas) {
          shadowCanvas = new CanvasElement();
          shadowCanvas.width = shadowCanvas.height = 1;
          shadowCanvas.getContext('2d').fillStyle = 'rgba(0,0,0,0.5)';
          shadowCanvas.getContext('2d').fillRect(0, 0, 1, 1);
        }
        source = shadowCanvas;
      } else {
        source = atlas[element[0]];
        if (!source) {
          // A fresh renderer's uninitialized atlas slots contain transparent pixels.
          source = atlas[element[0]] = new CanvasElement();
          source.width = source.height = 1024;
        }
      }
      var native = pixi.nativeSource(source);
      if (!native) return { kind: 0, resource: 0 };
      if (!textureIndices.has(native.handle)) {
        textureIndices.set(native.handle, handles.length);
        handles.push(native.handle);
        revisions.push(source.__pmjsContentRevision || 0);
      }
      points.push(element[1], element[2], element[3], element[4],
        element[5], element[6], 0, 0, textureIndices.get(native.handle));
    }
    var signature = handles.join(':') + '/' + revisions.join(':');
    var previous = layers.get(layer);
    if (!previous || previous.signature !== signature ||
        previous.points.length !== points.length ||
        points.some(function(value, index) { return value !== previous.points[index]; })) {
      var handle = NativeHost.render.createTileLayer(new Float32Array(points), handles);
      if (!handle) throw new Error('native MZ tile layer creation failed');
      releaseLayer(layer);
      previous = { handle: handle, signature: signature, points: points };
      layers.set(layer, previous);
      finalizer.register(layer, previous, previous);
    }
    return { kind: 4, resource: previous.handle, nearest: true };
  }

  var stockTileRender = Tilemap.Layer.prototype.render;
  var stockContainerRender = PIXI.Container.prototype.render;
  var stockContainerAdvanced = PIXI.Container.prototype.renderAdvanced;
  pixi.registerRenderContract(Tilemap.Layer.prototype, { encode: tileLayer, callsLeaf: false,
    releaseRenderer: releaseAtlas,
    accept: function(node) {
      return node.render === stockContainerRender && node._render === stockTileRender &&
        node.renderAdvanced === stockContainerAdvanced;
    }
  });
  PMJS.methods.wrap({ key: 'mz.tile-layer.destroy', id: 'pmjs-mz.display',
    getTarget: function() { return Tilemap.Layer.prototype; }, method: 'destroy',
    wrap: function(original) {
      return function() {
        releaseLayer(this);
        return original.apply(this, arguments);
      };
    }
  });

  function subtract(rectangle, cut) {
    var left = Math.max(rectangle.x, cut.x);
    var top = Math.max(rectangle.y, cut.y);
    var right = Math.min(rectangle.x + rectangle.width, cut.x + cut.width);
    var bottom = Math.min(rectangle.y + rectangle.height, cut.y + cut.height);
    if (left >= right || top >= bottom) return [rectangle];
    return [
      { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: top - rectangle.y },
      { x: rectangle.x, y: bottom, width: rectangle.width,
        height: rectangle.y + rectangle.height - bottom },
      { x: rectangle.x, y: top, width: left - rectangle.x, height: bottom - top },
      { x: right, y: top, width: rectangle.x + rectangle.width - right, height: bottom - top }
    ].filter(function(part) { return part.width > 0 && part.height > 0; });
  }

  var stockDrawShape = Window.prototype.drawShape;
  pixi.registerRenderContract(WindowLayer.prototype, {
    callsLeaf: false,
    children: function(layer, viewport) {
      var matrix = layer.worldTransform;
      if (!viewport || matrix.b !== 0 || matrix.c !== 0) {
        pixi.rejectRender('render.window-layer-transform', layer, 'requires an axis-aligned viewport');
      }
      var uncovered = [{ x: 0, y: 0, width: viewport.width, height: viewport.height }];
      var entries = [];
      layer.children.slice().reverse().forEach(function(win) {
        if (!win._isWindow || !win.visible || win.openness <= 0) return;
        if (win.drawShape !== stockDrawShape) {
          pixi.rejectRender('render.window-shape', win);
        }
        uncovered.forEach(function(rectangle) { entries.push({ node: win, clip: rectangle }); });
        var height = win.height * win.openness / 255;
        var x1 = matrix.a * win.x + matrix.tx;
        var y1 = matrix.d * (win.y + (win.height - height) / 2) + matrix.ty;
        var x2 = x1 + matrix.a * win.width;
        var y2 = y1 + matrix.d * height;
        var shape = { x: Math.min(x1, x2), y: Math.min(y1, y2),
          width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
        uncovered = uncovered.flatMap(function(rectangle) { return subtract(rectangle, shape); });
      });
      layer.children.forEach(function(child) {
        if (!child._isWindow) entries.push({ node: child });
      });
      return entries;
    }
  });
})();
