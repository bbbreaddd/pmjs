'use strict';

(function() {
  var schema = NativeHost.scene && NativeHost.scene.schema;
  var packetVersion = NativeHost.scene && NativeHost.scene.packetVersion;
  if (!schema || schema.version !== packetVersion ||
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

  function nativeTilingTexture(texture) {
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
      return { handle: native.handle, resolution: resolution };
    }
    var signature = [native.handle, Number(texture._updateID) || 0,
      frame.x, frame.y, frame.width, frame.height, resolution].join(':');
    if (texture.__pmjsPixi5TilingCanvas &&
        texture.__pmjsPixi5TilingSignature === signature) {
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

  function reject(capability, node, detail) {
    var producer = node && node.constructor && node.constructor.name || 'DisplayObject';
    PMJS.compat.hit(capability, producer);
    throw new Error('unsupported Pixi 5 native capability: ' +
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
    if (mode < 0 || mode > 3) reject('render.blend-mode', node);
    return mode;
  }

  function activeFilters(node) {
    var filters = node && node._filters;
    if (!Array.isArray(filters)) return false;
    return filters.some(function(filter) {
      return filter && filter.enabled !== false;
    });
  }

  function writeNode(node, parent) {
    if (!node || !node.visible || !node.renderable || node.alpha <= 0) return;
    var transform = localTransform(node);
    if (!drawableTransform(transform)) return;
    if (node.mask) reject('render.mask', node);
    if (activeFilters(node)) reject('render.filter', node);

    var type = node.pluginName && String(node.pluginName).toLowerCase();
    var isSprite = node instanceof PIXI.Sprite;
    var isScreenSprite = typeof ScreenSprite === 'function' &&
      node instanceof ScreenSprite;
    var isTilingSprite = PIXI.TilingSprite && node instanceof PIXI.TilingSprite;
    if (type && type !== 'batch' && type !== 'sprite' && !isTilingSprite) {
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
      tilingTextureInfo = nativeTilingTexture(texture);
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

    var index = addRecord(parent, kind, resource, tint, blendMode(node),
      transform, Number.isFinite(node.alpha) ? node.alpha : 1);
    if (kind === 1) {
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
      var tileScale = node.tileScale || { x: 1, y: 1 };
      var scaleX = Math.abs(Number(tileScale.x)) > 0.000001 ?
        Number(tileScale.x) : 1;
      var scaleY = Math.abs(Number(tileScale.y)) > 0.000001 ?
        Number(tileScale.y) : 1;
      var tilePosition = node.tilePosition || { x: 0, y: 0 };
      if (PIXI.SCALE_MODES &&
          texture.baseTexture.scaleMode === PIXI.SCALE_MODES.NEAREST) {
        metadata[tilingMetadataOffset + 5] |= 8;
      }
      values[tilingValueOffset + 7] = localX;
      values[tilingValueOffset + 8] = localY;
      values[tilingValueOffset + 9] = -tilePosition.x / scaleX *
        tilingResolution;
      values[tilingValueOffset + 10] = -tilePosition.y / scaleY *
        tilingResolution;
      values[tilingValueOffset + 11] = node.width / scaleX *
        tilingResolution;
      values[tilingValueOffset + 12] = node.height / scaleY *
        tilingResolution;
      values[tilingValueOffset + 13] = destinationWidth;
      values[tilingValueOffset + 14] = destinationHeight;
    }

    var children = node.children || [];
    for (var childIndex = 0; childIndex < children.length; childIndex++) {
      if (kind === 3 && children[childIndex] === node._graphics) continue;
      writeNode(children[childIndex], index);
    }
  }

  function render(stage, backgroundColor, resolution) {
    count = 0;
    if (backgroundColor !== null) {
      addRecord(0xffffffff, 3, 0, backgroundColor, 0, identity, 1);
    }
    var rootParent = 0xffffffff;
    resolution = Math.max(0.000001, Number(resolution) || 1);
    if (resolution !== 1) {
      rootParent = addRecord(0xffffffff, 0, 0, 0xffffff, 0,
        { a: resolution, b: 0, c: 0, d: resolution, tx: 0, ty: 0 }, 1);
    }
    writeNode(stage, rootParent);
    NativeHost.scene.submit(packetVersion, metadata, values, count);
  }

  globalThis.pmjsPixi5RenderScene = render;
})();
