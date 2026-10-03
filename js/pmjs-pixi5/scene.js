'use strict';

(function() {
  var contracts = new WeakMap();
  var rendererReleases = [];
  function registerRenderContract(prototype, contract) {
    if (!prototype) return;
    var registered = Object.assign({
      render: prototype.render, leaf: prototype._render,
      advanced: prototype.renderAdvanced, callsLeaf: true
    }, contract || {});
    contracts.set(prototype, registered);
    if (registered.releaseRenderer) rendererReleases.push(registered.releaseRenderer);
  }
  [PIXI.Container, PIXI.Sprite, PIXI.TilingSprite].forEach(function(type) {
    if (type) registerRenderContract(type.prototype);
  });
  function findRenderContract(node) {
    var prototype = Object.getPrototypeOf(node);
    var contract;
    while (prototype && !(contract = contracts.get(prototype))) {
      prototype = Object.getPrototypeOf(prototype);
    }
    return contract;
  }
  function renderContract(node) {
    var contract = findRenderContract(node);
    if (!contract || node.render !== contract.render ||
        (contract.callsLeaf && node._render !== contract.leaf) ||
        ((node.mask || activeFilters(node)) && node.renderAdvanced !== contract.advanced)) {
      if (!contract || !contract.accept || !contract.accept(node)) {
        reject('render.render-method', node);
      }
    }
    return contract;
  }
  globalThis.PMJS = globalThis.PMJS || {};
  PMJS.pixi5 = {
    registerRenderContract: registerRenderContract,
    nativeSource: nativeSource,
    rejectRender: reject,
    releaseRenderer: function(renderer) {
      rendererReleases.forEach(function(release) { release(renderer); });
    }
  };
  var schema = NativeHost.scene && NativeHost.scene.schema;
  var requiredPacketVersion = 28;
  var filterEncoders = [];
  globalThis.pmjsPixi5RegisterFilterEncoder = function(encoder) {
    filterEncoders.push(encoder);
  };
  var packetVersion = NativeHost.scene && NativeHost.scene.packetVersion;
  if (!schema || packetVersion !== requiredPacketVersion ||
      schema.version !== packetVersion ||
      schema.metadataStride !== 7 || schema.valueStride !== 41 ||
      !schema.transactionalSubmit) {
    throw new Error('native scene schema does not provide transactional submission');
  }

  var metadataStride = schema.metadataStride;
  var valueStride = schema.valueStride;
  var capacity = 512;
  var metadata = new Uint32Array(capacity * metadataStride);
  var values = new Float32Array(capacity * valueStride);
  var count = 0;
  var identity = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

  function grow() {
    capacity *= 2;
    var nextMetadata = new Uint32Array(capacity * metadataStride);
    var nextValues = new Float32Array(capacity * valueStride);
    nextMetadata.set(metadata);
    nextValues.set(values);
    metadata = nextMetadata;
    values = nextValues;
  }

  function textureSource(baseTexture) {
    if (!baseTexture) return null;
    if (baseTexture.__pmjsPixi5RenderCanvas) return baseTexture.__pmjsPixi5RenderCanvas;
    if ('resource' in baseTexture) {
      return baseTexture.resource && baseTexture.resource.source || null;
    }
    return baseTexture.source || null;
  }

  function nativeSource(source) {
    if (!source) return null;
    if (typeof source._pmjsNativeTextureSource === 'function') {
      return source._pmjsNativeTextureSource();
    }
    if (source._nativeImage) return source._nativeImage;
    if (source._nativeCanvas) return source._nativeCanvas;
    if (typeof source._ensureNativeCanvas === 'function') {
      return source._ensureNativeCanvas();
    }
    return null;
  }

  function releaseTilingTexture(texture) {
    var canvas = texture.__pmjsPixi5TilingCanvas;
    if (canvas && typeof canvas._releaseNativeCanvas === 'function') {
      canvas._releaseNativeCanvas();
    }
    delete texture.__pmjsPixi5TilingCanvas;
    delete texture.__pmjsPixi5TilingSignature;
  }
  if (PMJS.methods) {
    PMJS.methods.wrap({
      key: 'PIXI.Texture.destroy.pixi5-tiling', id: 'pixi5-tiling-texture-release',
      getTarget: function() { return PIXI.Texture && PIXI.Texture.prototype; },
      method: 'destroy',
      wrap: function(original) {
        return function() {
          var result = original.apply(this, arguments);
          releaseTilingTexture(this);
          return result;
        };
      }
    });
  }

  function simpleTilingTexture(texture) {
    var base = texture.baseTexture;
    var frame = texture._frame || texture.frame;
    function powerOfTwo(value) {
      return value > 0 && Number.isInteger(value) && (value & (value - 1)) === 0;
    }
    return frame.width === base.width && frame.height === base.height &&
      powerOfTwo(base.width * (Number(base.resolution) || 1)) &&
      powerOfTwo(base.height * (Number(base.resolution) || 1));
  }

  function nativeTilingTexture(texture) {
    if (!texture || texture.valid === false) return null;
    var base = texture && texture.baseTexture;
    var source = textureSource(base);
    var native = nativeSource(source);
    var frame = texture && (texture._frame || texture.frame);
    if (!native || !frame || frame.width <= 0 || frame.height <= 0) return null;
    var resolution = Math.max(0.000001, Number(base.resolution) || 1);
    var rotation = ((Number(texture.rotate) || 0) % 16 + 16) % 16;
    if (rotation || texture.trim) return null;
    var baseWidth = Number(base.width) || frame.width;
    var baseHeight = Number(base.height) || frame.height;
    if (frame.x === 0 && frame.y === 0 && frame.width === baseWidth &&
        frame.height === baseHeight) {
      releaseTilingTexture(texture);
      return { handle: native.handle, resolution: resolution };
    }
    var sourceRevision = source && source.__pmjsContentRevision;
    var cacheable = !(source && typeof source._ensureNativeCanvas === 'function') ||
      typeof sourceRevision === 'number';
    var signature = [native.handle, sourceRevision, Number(texture._updateID) || 0,
      frame.x, frame.y, frame.width, frame.height, resolution].join(':');
    if (texture.__pmjsPixi5TilingCanvas &&
        texture.__pmjsPixi5TilingSignature === signature && cacheable) {
      return { handle: texture.__pmjsPixi5TilingCanvas
        ._ensureNativeCanvas().handle, resolution: resolution };
    }
    var canvas = texture.__pmjsPixi5TilingCanvas || new CanvasElement();
    canvas.width = Math.max(1, Math.ceil(frame.width * resolution));
    canvas.height = Math.max(1, Math.ceil(frame.height * resolution));
    canvas.getContext('2d').drawImage(source,
      frame.x * resolution, frame.y * resolution,
      frame.width * resolution, frame.height * resolution,
      0, 0, canvas.width, canvas.height);
    texture.__pmjsPixi5TilingCanvas = canvas;
    texture.__pmjsPixi5TilingSignature = signature;
    return { handle: canvas._ensureNativeCanvas().handle,
      resolution: resolution };
  }

  function RenderingGap(message) { this.message = message; }
  RenderingGap.prototype = Object.create(Error.prototype);
  function reject(capability, node, detail) {
    var producer = node && node.constructor && node.constructor.name || 'DisplayObject';
    PMJS.compat.hit(capability, producer);
    throw new RenderingGap('unsupported Pixi 5 native capability: ' +
      capability + ': ' + producer + (detail ? ': ' + detail : ''));
  }

  function addRecord(parent, kind, resource, tint, blendMode, transform, alpha) {
    if (count >= capacity) grow();
    var index = count++;
    var metadataOffset = index * metadataStride;
    var valueOffset = index * valueStride;
    metadata[metadataOffset] = kind;
    metadata[metadataOffset + 1] = parent;
    metadata[metadataOffset + 2] = resource;
    metadata[metadataOffset + 3] = tint;
    metadata[metadataOffset + 4] = blendMode;
    metadata[metadataOffset + 5] = 0;
    metadata[metadataOffset + 6] = 0;
    values.fill(0, valueOffset, valueOffset + valueStride);
    values[valueOffset] = transform.a;
    values[valueOffset + 1] = transform.b;
    values[valueOffset + 2] = transform.c;
    values[valueOffset + 3] = transform.d;
    values[valueOffset + 4] = transform.tx;
    values[valueOffset + 5] = transform.ty;
    values[valueOffset + 6] = alpha;
    return index;
  }

  function localTransform(node) {
    var transform = node && node.transform;
    if (transform && typeof transform.updateLocalTransform === 'function') {
      transform.updateLocalTransform();
    }
    return transform && transform.localTransform || identity;
  }

  function drawableTransform(transform) {
    if (!Number.isFinite(transform.a) || !Number.isFinite(transform.b) ||
        !Number.isFinite(transform.c) || !Number.isFinite(transform.d) ||
        !Number.isFinite(transform.tx) || !Number.isFinite(transform.ty)) {
      return false;
    }
    return Math.abs(transform.a * transform.d - transform.b * transform.c) >
      0.0000001;
  }

  function blendMode(node) {
    var mode = Number(node && node.blendMode) || 0;
    if (!Number.isInteger(mode) || mode < 0 || mode > 3) reject('render.blend-mode', node);
    return mode;
  }

  function activeFilters(node) {
    var filters = node && node.filters;
    if (!Array.isArray(filters)) return false;
    return filters.some(function(filter) {
      return filter && filter.enabled !== false;
    });
  }

  var renderResolution = 1;
  var renderOwner;
  var viewport;
  var filterTargets;
  function needsFilterTarget(node) {
    if (!node || !node.visible || !node.renderable || node.alpha <= 0) return false;
    if (!drawableTransform(localTransform(node))) return false;
    if (filterTargets.has(node)) return filterTargets.get(node);
    var contract = findRenderContract(node) || {};
    var children = contract.children ? contract.children(node, viewport).map(function(entry) {
      return entry.node;
    }) : node.children || [];
    var isScreenSprite = typeof ScreenSprite === 'function' && node instanceof ScreenSprite;
    // ScreenSprite's Graphics is already represented by the native screen fill.
    var result = !!contract.filterTarget || children.some(function(child) {
      return !(isScreenSprite && child === node._graphics) && needsFilterTarget(child);
    });
    filterTargets.set(node, result);
    return result;
  }
  function clipRecord(parent, clip) {
    var index = addRecord(parent, 0, 0, 0xffffff, 0, identity, 1);
    metadata[index * metadataStride + 5] |= 1;
    values.set([clip.x, clip.y, clip.x + clip.width, clip.y + clip.height]
      .map(function(value) { return value * renderResolution; }),
    index * valueStride + 17);
    return index;
  }

  function writeNode(node, parent, clip) {
    if (!node || !node.visible || !node.renderable || node.alpha <= 0) return;
    var transform = localTransform(node);
    if (!drawableTransform(transform)) return;
    var checkpoint = count;
    try {
      writePreparedNode(node, parent, clip, transform);
    } catch (error) {
      if (!(error instanceof RenderingGap)) throw error;
      // Only a reported compatibility gap degrades drawing. Native failures and
      // authored exceptions remain visible; discard any partial leaf/filter records.
      count = checkpoint;
      if (clip) parent = clipRecord(parent, clip);
      var index = addRecord(parent, 0, 0, 0xffffff, 0, transform,
        Number.isFinite(node.alpha) ? node.alpha : 1);
      (node.children || []).forEach(function(child) { writeNode(child, index); });
    }
  }
  function writePreparedNode(node, parent, clip, transform) {
    var contract = renderContract(node);
    if (clip) parent = clipRecord(parent, clip);
    if (node.mask) reject('render.mask', node);
    var encodedFilters = [];
    var supportedFilters = false;
    var filterTarget = activeFilters(node) && needsFilterTarget(node);
    if (activeFilters(node)) {
      node.filters.forEach(function(filter) {
        if (!filter || filter.enabled === false) return;
        try {
          var encoded = null;
          for (var i = 0; i < filterEncoders.length && !encoded; i++) {
            encoded = filterEncoders[i](filter, node, viewport, renderResolution, renderOwner);
          }
          if (!encoded) reject('render.filter', node);
          encoded = Object.assign({}, encoded, { blendMode: blendMode(filter) });
          if (encoded.blendMode && !schema.filterCompositeBlend) {
            reject('render.filter-blend', node);
          }
          supportedFilters = true;
          if (!encoded.neutral || encoded.blendMode || filterTarget) encodedFilters.push(encoded);
        } catch (error) {
          if (!(error instanceof RenderingGap)) throw error;
        }
      });
    }
    if (supportedFilters && node.filterArea) {
      parent = clipRecord(parent, node.filterArea);
    } else if (encodedFilters.length && filterTarget && typeof node.getBounds === 'function') {
      parent = clipRecord(parent, node.getBounds(true));
    }
    encodedFilters.reverse().forEach(function(filter) {
      var begin = addRecord(parent, 6, 0, 0xffffff, filter.kind, identity, 1);
      var offset = begin * valueStride;
      values.set(filter.parameters, offset + 7);
      values[offset + 33] = 1;
      values[offset + 34] = filter.blendMode;
    });

    var type = node.pluginName && String(node.pluginName).toLowerCase();
    var isSprite = node instanceof PIXI.Sprite;
    var isScreenSprite = typeof ScreenSprite === 'function' &&
      node instanceof ScreenSprite;
    var isTilingSprite = PIXI.TilingSprite && node instanceof PIXI.TilingSprite;
    if (isTilingSprite ? node.pluginName !== 'tilingSprite' :
        isSprite ? node.pluginName !== 'batch' :
        type && type !== 'batch' && type !== 'sprite') {
      reject('render.renderer-plugin', node);
    }
    if (PIXI.Graphics && node instanceof PIXI.Graphics && !isSprite &&
        !isScreenSprite) {
      reject('render.graphics', node);
    }

    var kind = 0;
    var resource = 0;
    var tint = node.tint === undefined ? 0xffffff : node.tint;
    var frame = null;
    var texture = null;
    var localX = 0;
    var localY = 0;
    var destinationWidth = 0;
    var destinationHeight = 0;
    var tilingTextureInfo = null;

    if (isScreenSprite) {
      kind = 3;
      tint = ((node._red || 0) << 16) | ((node._green || 0) << 8) |
        (node._blue || 0);
    } else if (isTilingSprite) {
      texture = node.texture || node._texture;
      frame = texture && (texture._frame || texture.frame);
      var tilingRotation = ((Number(texture && texture.rotate) || 0) % 16 +
        16) % 16;
      if (texture && (texture.trim || tilingRotation !== 0)) {
        reject('render.tiling-texture-frame', node,
          'frame=' + [frame && frame.x, frame && frame.y,
            frame && frame.width, frame && frame.height].join(',') +
          ' trim=' + !!texture.trim + ' rotate=' + tilingRotation);
      }
      if ((node.clampMargin !== undefined && node.clampMargin !== 0.5) ||
          (node.uvMatrix && node.uvMatrix.clampOffset !== 0)) {
        reject('render.tiling-clamp', node);
      }
      var tileTransform = node.tileTransform;
      if (!tileTransform || typeof tileTransform.updateLocalTransform !== 'function') {
        reject('render.tiling-transform', node);
      }
      tileTransform.updateLocalTransform();
      var tilingMatrix = tileTransform.localTransform;
      var finiteSampling = tilingMatrix && ['a', 'b', 'c', 'd', 'tx', 'ty']
        .every(function(key) { return Number.isFinite(tilingMatrix[key]); });
      if (finiteSampling && (tilingMatrix.b !== 0 || tilingMatrix.c !== 0)) {
        reject('render.tiling-transform', node, 'rotated or skewed sampling');
      }
      // MZ can leave the origin nonfinite between image readiness and the next
      // scene update. Omit undefined sampling; retain children and authored state.
      tilingTextureInfo = finiteSampling && tilingMatrix.a !== 0 &&
        tilingMatrix.d !== 0 ? nativeTilingTexture(texture) : null;
      if (tilingTextureInfo && frame && frame.width > 0 && frame.height > 0 &&
          node.width > 0 && node.height > 0) {
        kind = 2;
        resource = tilingTextureInfo.handle;
        var tilingAnchor = node.anchor || { x: 0, y: 0 };
        localX = -tilingAnchor.x * node.width;
        localY = -tilingAnchor.y * node.height;
        destinationWidth = node.width;
        destinationHeight = node.height;
      }
    } else if (isSprite) {
      texture = node.texture || node._texture;
      var base = texture && texture.baseTexture;
      var source = textureSource(base);
      var native = nativeSource(source);
      frame = texture && (texture._frame || texture.frame);
      if (native && frame && frame.width > 0 && frame.height > 0) {
        kind = 1;
        resource = native.handle;
        var anchor = node.anchor || { x: 0, y: 0 };
        var original = texture.orig || frame;
        var trim = texture.trim;
        localX = trim ? trim.x - anchor.x * original.width :
          -anchor.x * original.width;
        localY = trim ? trim.y - anchor.y * original.height :
          -anchor.y * original.height;
        destinationWidth = trim ? trim.width : original.width;
        destinationHeight = trim ? trim.height : original.height;
      }
    }

    var encodedNode = contract.encode && contract.encode(node, renderOwner);
    if (encodedNode) {
      kind = encodedNode.kind;
      resource = encodedNode.resource;
    }

    var index = addRecord(parent, kind, resource, tint, blendMode(node),
      transform, Number.isFinite(node.alpha) ? node.alpha : 1);
    if (encodedNode && encodedNode.nearest) {
      metadata[index * metadataStride + 5] |= 8;
    }
    if (kind === 9) {
      if (!schema.effects) reject('render.effekseer', node);
      var effectOffset = index * valueStride;
      values.set(encodedNode.effect.viewport, effectOffset);
      values.set(encodedNode.effect.projection, effectOffset + 7);
      values.set(encodedNode.effect.camera, effectOffset + 23);
      values.set(encodedNode.effect.resetViewport, effectOffset + 39);
    } else if (kind === 1) {
      var baseTexture = texture.baseTexture;
      var resolution = Math.max(0.000001, Number(baseTexture.resolution) || 1);
      var valueOffset = index * valueStride;
      var metadataOffset = index * metadataStride;
      var rotation = ((Number(texture.rotate) || 0) % 16 + 16) % 16;
      if (rotation % 2) reject('render.texture-rotation', node);
      metadata[metadataOffset + 5] |= rotation / 2 << 5;
      if (PIXI.SCALE_MODES && baseTexture.scaleMode === PIXI.SCALE_MODES.NEAREST) {
        metadata[metadataOffset + 5] |= 8;
      }
      values[valueOffset + 7] = localX;
      values[valueOffset + 8] = localY;
      values[valueOffset + 9] = frame.x * resolution;
      values[valueOffset + 10] = frame.y * resolution;
      values[valueOffset + 11] = frame.width * resolution;
      values[valueOffset + 12] = frame.height * resolution;
      values[valueOffset + 13] = destinationWidth;
      values[valueOffset + 14] = destinationHeight;
    } else if (kind === 2) {
      var tilingValueOffset = index * valueStride;
      var tilingMetadataOffset = index * metadataStride;
      var tilingResolution = tilingTextureInfo.resolution;
      if (!simpleTilingTexture(texture)) {
        if (!schema.clampedTilingSampling) reject('render.tiling-clamp', node);
        metadata[tilingMetadataOffset + 5] |= 32768;
      }
      var scaleX = tilingMatrix.a;
      var scaleY = tilingMatrix.d;
      if (PIXI.SCALE_MODES &&
          texture.baseTexture.scaleMode === PIXI.SCALE_MODES.NEAREST) {
        metadata[tilingMetadataOffset + 5] |= 8;
      }
      values[tilingValueOffset + 7] = localX;
      values[tilingValueOffset + 8] = localY;
      values[tilingValueOffset + 9] = (-tilingMatrix.tx +
        (node.uvRespectAnchor ? localX : 0)) / scaleX * tilingResolution;
      values[tilingValueOffset + 10] = (-tilingMatrix.ty +
        (node.uvRespectAnchor ? localY : 0)) / scaleY * tilingResolution;
      values[tilingValueOffset + 11] = node.width / scaleX *
        tilingResolution;
      values[tilingValueOffset + 12] = node.height / scaleY *
        tilingResolution;
      values[tilingValueOffset + 13] = destinationWidth;
      values[tilingValueOffset + 14] = destinationHeight;
    }

    if (contract.children) {
      contract.children(node, viewport).forEach(function(entry) {
        writeNode(entry.node, index, entry.clip);
      });
    } else {
      var children = node.children || [];
      for (var childIndex = 0; childIndex < children.length; childIndex++) {
        if (kind === 3 && children[childIndex] === node._graphics) continue;
        writeNode(children[childIndex], index);
      }
    }
    encodedFilters.forEach(function() {
      addRecord(parent, 7, 0, 0xffffff, 0, identity, 1);
    });
  }

  function render(stage, backgroundColor, resolution, size, renderer) {
    if (typeof stage.updateTransform === 'function') {
      var previousParent = stage.parent;
      stage.parent = stage._tempDisplayObjectParent;
      try { stage.updateTransform(); } finally { stage.parent = previousParent; }
    }
    count = 0;
    filterTargets = new WeakMap();
    if (backgroundColor !== null) {
      addRecord(0xffffffff, 3, 0, backgroundColor, 0, identity, 1);
    }
    var rootParent = 0xffffffff;
    resolution = Math.max(0.000001, Number(resolution) || 1);
    renderResolution = resolution;
    renderOwner = renderer;
    viewport = size;
    if (resolution !== 1) {
      rootParent = addRecord(0xffffffff, 0, 0, 0xffffff, 0,
        { a: resolution, b: 0, c: 0, d: resolution, tx: 0, ty: 0 }, 1);
    }
    writeNode(stage, rootParent);
    if (NativeHost.scene.submit(packetVersion, metadata, values, count) === false) {
      throw new Error('native Pixi 5 scene submission rejected');
    }
  }

  globalThis.pmjsPixi5RenderScene = render;
})();
