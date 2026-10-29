var nativeSceneEmission = null;
var nativeSceneEncodingDepth = 0;

function writeNativeSceneRectTileLayer(node, parentIndex) {
  var layerHandle = ensureNativeRectTileLayer(node);
  if (!layerHandle) {
    if (node.pointsBuf && node.pointsBuf.length === 0) return;
    PMJS.compat.hit('render.tilemap',
      (node.constructor && node.constructor.name || 'node') + ':layer-unrealized');
    return;
  }
  var layerParent = node.parent || node;
  var layerIndex = nativeSceneRecord(parentIndex, 4, layerHandle,
    layerParent.tint === undefined ? 0xffffff : layerParent.tint,
    layerParent.blendMode || 0, nativeIdentityTransform, 1, null, 0, null);
  var layerValues = layerIndex * nativeSceneValueStride;
  if (PIXI.tilemap.TileRenderer.SCALE_MODE === PIXI.SCALE_MODES.NEAREST)
    nativeSceneMetadata[layerIndex * nativeSceneMetadataStride + 5] |= 8;
  var animation = tileAnimationOffset(layerParent);
  nativeSceneValues[layerValues + 15] = animation[0];
  nativeSceneValues[layerValues + 16] = animation[1];
  nativeTileRects += node.pointsBuf.length / 9;
}

function nativeSceneTraversesChild(kind, node, child) {
  return kind !== 3 || child !== node._graphics;
}

function nativeSceneBlendMode(node) {
  var mode = Number(node && node.blendMode) || 0;
  if (mode >= 0 && mode <= 3) return mode;

  var pictureRenderer = node && (node.pluginName === 'picture' ||
    node.pluginName === 'sprite' && node._isPicture);
  if (pictureRenderer && (mode === 4 || mode === 9)) return 0;
  if (mode >= 4 && mode <= 17) return 0;
  if (mode === 18) return 1;
  if (mode === 19) return 3;
  return -1;
}

function nativeScenePictureBlend(node) {
  var mode = Number(node && node.blendMode) || 0;
  var pictureRenderer = node && (node.pluginName === 'picture' ||
    node.pluginName === 'sprite' && node._isPicture);
  if (!pictureRenderer) return -1;
  if (mode === 4) return 0;
  if (mode === 9) return 1;
  return -1;
}

function nativeIntersectClip(left, right) {
  if (!left) return right;
  if (!right) return left;
  var clipLeft = Math.max(left.left, right.left);
  var clipTop = Math.max(left.top, right.top);
  var clipRight = Math.min(left.right, right.right);
  var clipBottom = Math.min(left.bottom, right.bottom);
  if (clipRight < clipLeft) clipRight = clipLeft;
  if (clipBottom < clipTop) clipBottom = clipTop;
  return { left: clipLeft, top: clipTop, right: clipRight, bottom: clipBottom };
}

function nativeMultiplyTint(left, right) {
  left = left === undefined ? 0xffffff : left;
  right = right === undefined ? 0xffffff : right;
  return Math.round(((left >> 16) & 255) * ((right >> 16) & 255) / 255) << 16 |
    Math.round(((left >> 8) & 255) * ((right >> 8) & 255) / 255) << 8 |
    Math.round((left & 255) * (right & 255) / 255);
}

function nativeSceneNodeRejected(node, particleContext) {
  if (!node) return true;

  if (particleContext) return false;
  return (!node.visible || !node.renderable) ||
    node.alpha <= 0 ||
    typeof node._openness === 'number' && node._openness <= 0;
}

function nativeParticleFrameContext(container) {
  var batchSize = Math.max(1, Number(container._batchSize) || 16384);
  var properties = container.__pmjsParticleProperties;
  if (!properties) {
    properties = container.__pmjsParticleProperties =
      (container._properties || [false, true, false, false, false]).slice(0, 5);
  }
  var revisions = container.__pmjsParticleBufferRevisions;
  if (!revisions) {
    revisions = [];
    container.__pmjsParticleBufferRevisions = revisions;
  }
  // Drop only removed tail snapshots whose static batches were invalidated.
  // Direct children-array edits without Pixi invalidation keep their old cache
  // semantics; ordinary removeChild/removeChildren invalidate the tail.
  var values = container.__pmjsParticleValues;
  if (values && values.length > container.children.length) {
    var tailBatch = Math.floor(container.children.length / batchSize);
    var tailDirty = !container._bufferUpdateIDs &&
      tailBatch >= container._bufferToUpdate;
    if (container._bufferUpdateIDs) {
      for (var tailIndex = 0; tailIndex <= tailBatch; tailIndex++) {
        if ((revisions[tailIndex] || 0) < (container._bufferUpdateIDs[tailIndex] || 0)) {
          tailDirty = true;
          break;
        }
      }
    }
    if (tailDirty) values.length = container.children.length;
  }
  var dirty = [];
  var dirtyFollowing = false;
  var batchCount = Math.ceil(Math.min(container.children.length,
    Math.max(0, Number(container._maxSize) || 0)) / batchSize);
  var legacy = !container._bufferUpdateIDs;
  for (var index = 0; index < batchCount; index++) {
    var requested = legacy ? 0 : container._bufferUpdateIDs[index] || 0;
    dirtyFollowing = legacy ? index >= container._bufferToUpdate :
      dirtyFollowing || (revisions[index] || 0) < requested;
    dirty[index] = dirtyFollowing;
    if (dirtyFollowing) revisions[index] = container._updateID || requested;
  }
  if (legacy && batchCount) container._bufferToUpdate = batchCount;
  var first = container.children[0];
  var firstTexture = first && (first.texture || first._texture);
  return { container: container, properties: properties, dirty: dirty,
    batchSize: batchSize, baseTexture: firstTexture && firstTexture.baseTexture };
}

function nativeParticleValues(context, node, childIndex) {
  var cache = context.container.__pmjsParticleValues;
  if (!cache) {
    cache = [];
    context.container.__pmjsParticleValues = cache;
  }
  var value = cache[childIndex];
  if (!value || value.node !== node) {
    value = { node: node };
    cache[childIndex] = value;
  }
  var refreshStatic = !value.initialized ||
    context.dirty[Math.floor(childIndex / context.batchSize)];
  var dynamic = context.properties;
  if (refreshStatic || dynamic[0]) {
    value.scaleX = node.scale ? node.scale.x : 1;
    value.scaleY = node.scale ? node.scale.y : 1;
    value.anchorX = node.anchor ? node.anchor.x : 0;
    value.anchorY = node.anchor ? node.anchor.y : 0;
  }
  if (refreshStatic || dynamic[1]) {
    value.x = node.position ? node.position.x : 0;
    value.y = node.position ? node.position.y : 0;
  }
  if (refreshStatic || dynamic[2]) value.rotation = Number(node.rotation) || 0;
  if (refreshStatic || dynamic[3]) value.texture = node.texture || node._texture;
  if (refreshStatic || dynamic[4]) {
    value.tint = node.tint === undefined ? 0xffffff : node.tint;
    value.alpha = Number(node.alpha);
    if (!Number.isFinite(value.alpha)) value.alpha = 1;
  }
  value.initialized = true;
  return value;
}

function nativeSpriteVertices(node, nodeIndex, presentation) {
  if (!nativeSceneUsePixiWorldState || node.children && node.children.length ||
      typeof node.calculateVertices !== 'function') return;
  var vertices;
  if (presentation) {
    var world = node.worldTransform;
    var offset = nodeIndex * nativeSceneValueStride;
    var left = nativeSceneValues[offset + 7], top = nativeSceneValues[offset + 8];
    var right = left + nativeSceneEmission.destWidth, bottom = top + nativeSceneEmission.destHeight;
    vertices = new Float32Array([
      world.a * left + world.c * top + world.tx, world.b * left + world.d * top + world.ty,
      world.a * right + world.c * top + world.tx, world.b * right + world.d * top + world.ty,
      world.a * right + world.c * bottom + world.tx, world.b * right + world.d * bottom + world.ty,
      world.a * left + world.c * bottom + world.tx, world.b * left + world.d * bottom + world.ty]);
  } else {
    node.calculateVertices();
    vertices = node.vertexData;
  }
  if (!vertices || vertices.length !== 8) return;
  var offset = nodeIndex * nativeSceneValueStride;
  var drawable = true;
  for (var corner = 0; corner < 4; corner++) {
    var x = vertices[corner * 2], y = vertices[corner * 2 + 1];
    var destination = offset + (corner < 3 ? corner * 2 : 15);
    // Target projection is separate from observable guest world state.
    if (nativeSceneRootTransform !== nativeIdentityTransform) {
      var root = nativeSceneRootTransform;
      nativeSceneValues[destination] = root.a * x + root.c * y + root.tx;
      nativeSceneValues[destination + 1] = root.b * x + root.d * y + root.ty;
    } else {
      nativeSceneValues[destination] = x;
      nativeSceneValues[destination + 1] = y;
    }
    drawable = drawable && Number.isFinite(nativeSceneValues[destination]) &&
      Number.isFinite(nativeSceneValues[destination + 1]);
  }
  if (!drawable) {
    // Nonfinite leaf quads draw no pixels; keep packet values finite without
    // repairing observable guest transforms or disturbing effect scopes.
    for (var corner = 0; corner < 4; corner++) {
      var destination = offset + (corner < 3 ? corner * 2 : 15);
      nativeSceneValues[destination] = 0;
      nativeSceneValues[destination + 1] = 0;
    }
  }
  nativeSceneMetadata[nodeIndex * nativeSceneMetadataStride + 5] |= 4096;
}

function nativePackSpriteColor(node, nodeIndex, tint) {
  if (!nativeSceneUsePixiWorldState) return;
  var alpha = Math.min(1, node.worldAlpha);
  // Pixi packs NaN alpha as zero while preserving unpremultiplied tint RGB.
  var red = alpha < 1 ? Math.floor(((tint >>> 16) & 255) * alpha + 0.5) : ((tint >>> 16) & 255);
  var green = alpha < 1 ? Math.floor(((tint >>> 8) & 255) * alpha + 0.5) : ((tint >>> 8) & 255);
  var blue = alpha < 1 ? Math.floor((tint & 255) * alpha + 0.5) : (tint & 255);
  var offset = nodeIndex * nativeSceneMetadataStride;
  nativeSceneMetadata[offset + 3] = ((alpha * 255) << 24) | (red << 16) | (green << 8) | blue;
  nativeSceneMetadata[offset + 5] |= 2048;
}

function nativePreparedWorldRecord(node, nodeIndex, forcedAlpha) {
  if (!nativeSceneUsePixiWorldState ||
      !node.worldTransform) return;
  var world = node.worldTransform;
  if (nativeSceneRootTransform !== nativeIdentityTransform) world = nativeComposeTransform(nativeSceneRootTransform, world);
  var offset = nodeIndex * nativeSceneValueStride;
  nativeSceneValues[offset] = world.a; nativeSceneValues[offset + 1] = world.b;
  nativeSceneValues[offset + 2] = world.c; nativeSceneValues[offset + 3] = world.d;
  nativeSceneValues[offset + 4] = world.tx; nativeSceneValues[offset + 5] = world.ty;
  for (var component = 0; component < 6; component++) {
    if (!Number.isFinite(nativeSceneValues[offset + component])) {
      // Keep the record and descendant scopes without submitting invalid geometry.
      for (var coordinate = 0; coordinate < 6; coordinate++) nativeSceneValues[offset + coordinate] = 0;
      break;
    }
  }
  var alpha = forcedAlpha === undefined ? node.worldAlpha : forcedAlpha;
  nativeSceneValues[offset + 6] = Number.isFinite(Math.fround(alpha)) ? alpha : 1;
  nativeSceneMetadata[nodeIndex * nativeSceneMetadataStride + 5] |= 524288;
}

function nativePlainSpriteBinding(node) {
  if (nativeSceneNodeRejected(node, null) || node.children && node.children.length ||
      node._cacheAsBitmap || PMJS.pixi4.bitmapPresentation && PMJS.pixi4.bitmapPresentation.has(node) ||
      node.shader || node.mask ||
      nativeNodeRenderType(node) !== 'sprite' || nativeScenePictureBlend(node) >= 0 ||
      PMJS.pixi4.scenePreparation.forNode(node)) {
    return null;
  }
  var producer = pmjsPixiRenderPreflight.producer(node);
  if (producer.filterAccess !== 'backing' ||
      pmjsPixiRenderPreflight.unsupportedMethod(node, producer)) return null;
  var filters = node._filters;
  // Leave every advanced dispatch to its render turn, including empty arrays.
  if (filters) return null;
  var blendMode = nativeSceneBlendMode(node);
  if (blendMode < 0) return null;
  var texture = node.texture;
  var base = texture && texture.baseTexture;
  var source = base && base.source;
  var nativeImage = nativeTextureSource(source);
  var frame = texture && (texture._frame || texture.frame);
  var rotation = ((Number(texture && texture.rotate) || 0) % 16 + 16) % 16;
  var cpuTinted = node._tintTexture && texture &&
    texture.baseTexture === node._tintTexture;
  var tone = node._colorTone;
  var blend = node._blendColor;
  if (!nativeImage || !frame || frame.width <= 0 || frame.height <= 0 ||
      rotation % 2 || cpuTinted ||
      tone && (tone[0] || tone[1] || tone[2] || tone[3]) ||
      blend && blend[3] > 0) return null;
  var anchor = node.anchor || { x: 0, y: 0 };
  var original = texture.orig || frame;
  var trim = texture.trim;
  return { node: node, texture: texture, base: base, nativeImage: nativeImage,
    frame: frame, rotation: rotation, blendMode: blendMode,
    localX: trim ? trim.x - anchor.x * original.width :
      -anchor.x * original.width,
    localY: trim ? trim.y - anchor.y * original.height :
      -anchor.y * original.height,
    width: trim ? trim.width : original.width,
    height: trim ? trim.height : original.height };
}

function writeNativePlainSpriteSegment(bindings, parentIndex) {
  var boundBases = new Set();
  for (var bindingIndex = 0; bindingIndex < bindings.length; bindingIndex++) {
    var binding = bindings[bindingIndex];
    if (nativeSceneRenderer && !boundBases.has(binding.base)) {
      nativeSceneRenderer.bindTexture(binding.base);
      boundBases.add(binding.base);
    }
    var node = binding.node;
    var transform = node.transform;
    if (!nativeSceneTransformsPrepared && transform && typeof transform.updateLocalTransform === 'function') {
      transform.updateLocalTransform();
    }
    var local = transform && transform.localTransform || nativeIdentityTransform;
    var frame = binding.frame;
    var localX = binding.localX;
    var localY = binding.localY;
    var width = binding.width;
    var height = binding.height;
    var nodeIndex = nativeSceneRecord(parentIndex, 1, binding.nativeImage.handle,
      node.tint === undefined ? 0xffffff : node.tint, binding.blendMode,
      local, node.alpha, null, 0, null);
    nativePreparedWorldRecord(node, nodeIndex);
    nativePackSpriteColor(node, nodeIndex, node.tint === undefined ? 0xffffff : node.tint);
    nativeSpriteVertices(node, nodeIndex);
    var metadataOffset = nodeIndex * nativeSceneMetadataStride;
    var valueOffset = nodeIndex * nativeSceneValueStride;
    nativeSceneValues[valueOffset + 7] = localX;
    nativeSceneValues[valueOffset + 8] = localY;
    nativeSceneMetadata[metadataOffset + 5] |= binding.rotation / 2 << 5;
    if (PIXI.SCALE_MODES && binding.base.scaleMode === PIXI.SCALE_MODES.NEAREST) {
      nativeSceneMetadata[metadataOffset + 5] |= 8;
    }
    if (binding.base.mipmap &&
        !(PIXI.BaseRenderTexture && binding.base instanceof PIXI.BaseRenderTexture)) {
      nativeSceneMetadata[metadataOffset + 5] |= 65536;
    }
    if (nativeSceneRoundPixels) nativeSceneMetadata[metadataOffset + 5] |= 256;
    if (binding.base.__pmjsPremultiplied) nativeSceneMetadata[metadataOffset + 5] |= 1024;
    if (binding.texture.__pmjsStandaloneBitmapRegion) nativeSceneMetadata[metadataOffset + 5] |= 8192;
    var resolution = Math.max(0.000001, Number(binding.base.resolution) || 1);
    nativeSceneValues[valueOffset + 9] = frame.x * resolution;
    nativeSceneValues[valueOffset + 10] = frame.y * resolution;
    nativeSceneValues[valueOffset + 11] = frame.width * resolution;
    nativeSceneValues[valueOffset + 12] = frame.height * resolution;
    nativeSceneValues[valueOffset + 13] = width;
    nativeSceneValues[valueOffset + 14] = height;
  }
}

function writeNativeSceneNode(node, parentIndex, forcedClip, forcedMask,
    particleContext, forcedAlpha) {
  if (!node) return;
  if (nativeIsRectTileLayer(node)) {
    pmjsPixiRenderPreflight.check(node);
    writeNativeSceneRectTileLayer(node, parentIndex);
    return;
  }
  if (nativeSceneNodeRejected(node, particleContext)) return;
  if (!particleContext && node._cacheAsBitmap && PMJS.mv && PMJS.mv.pictureLayerCache) {
    PMJS.mv.pictureLayerCache.validate(node, nativeSceneRenderer);
  }
  if (!particleContext && node._cacheAsBitmap &&
      !node.__pmjsBuildingBitmapCache) {
    var cacheProducer = node.constructor && node.constructor.name || 'node';
    var cachedSprite = node._cacheData && node._cacheData.sprite;
    if (cachedSprite) {
      pmjsPixiRenderPreflight.check(node);
      PMJS.compat.observed('render.cacheAsBitmap', cacheProducer);
      var cachedTransform = node.transform;
      if (cachedTransform && !nativeSceneRootUsesWorldTransform &&
          typeof cachedTransform.updateLocalTransform === 'function') {
        cachedTransform.updateLocalTransform();
      }
      var cachedLocal = cachedTransform &&
        (parentIndex === 0xffffffff && nativeSceneRootUsesWorldTransform ?
          cachedTransform.worldTransform : cachedTransform.localTransform) ||
          nativeIdentityTransform;
      if (parentIndex === 0xffffffff &&
          nativeSceneRootTransform !== nativeIdentityTransform) {
        cachedLocal = nativeComposeTransform(nativeSceneRootTransform,
          cachedLocal);
      }
      var cacheParent = nativeSceneRecord(parentIndex, 0, 0, 0xffffff, 0,
        cachedLocal, parentIndex === 0xffffffff &&
          nativeSceneRootUsesWorldTransform ? node.worldAlpha : node.alpha,
        null, 0, null);
      writeNativeSceneNode(cachedSprite, cacheParent, null, null, null, 1);
      if (PMJS.mv && PMJS.mv.pictureLayerCache) {
        var livePictures = PMJS.mv.pictureLayerCache.tail(node);
        for (var pictureIndex = 0; pictureIndex < livePictures.length; pictureIndex++) {
          writeNativeSceneNode(livePictures[pictureIndex], cacheParent);
        }
      }
      return;
    }
    PMJS.compat.hit('render.cacheAsBitmap',
      cacheProducer + ': uninitialized cache, drawing live children');
  }
  var particleValues = particleContext ?
    nativeParticleValues(particleContext, node, particleContext.childIndex) : null;
  if (parentIndex === 0xffffffff && nativeSceneRootUsesWorldTransform &&
      !particleContext && forcedAlpha === undefined) {
    forcedAlpha = node.worldAlpha;
  }
  var producer = !particleContext && pmjsPixiRenderPreflight.check(node, true);
  if (producer && producer.filterAccess === 'public' && !node.children.length) return;
  if (producer && producer.prepareBeforeFilters) {
    PMJS.pixi4.scenePreparation.prepare(node, nativeSceneFilterResolution, nativeSceneTransformsPrepared);
  }
  if (!particleContext && node.shader) {
    PMJS.compat.hit('render.shader',
      (node.constructor && node.constructor.name || 'node') + ':' +
      (node.shader.constructor && node.shader.constructor.name || 'shader') +
      ':base=' + nativeNodeRenderType(node));
  }
  var blendMode = nativeSceneBlendMode(particleContext ? particleContext.container : node);
  if (blendMode < 0) {
    PMJS.compat.hit('render.blend-mode',
      (node.constructor && node.constructor.name || 'node') + ':blend=' + node.blendMode);
    blendMode = 0;
  }
  var nodeFilters = null;
  if (!particleContext) {
    nodeFilters = pmjsPixiRenderPreflight.filters(node, producer);
  }
  var activeFilters = Array.isArray(nodeFilters) ? nodeFilters : nativeSceneNoFilters;
  var enabledFilterCount = 0;
  if (Array.isArray(nodeFilters) && nodeFilters.length) {
    for (var filterScanIndex = 0;
        filterScanIndex < nodeFilters.length; filterScanIndex++) {
      if (nodeFilters[filterScanIndex] &&
          nodeFilters[filterScanIndex].enabled !== false) enabledFilterCount++;
    }
  }
  if (producer) {
    pmjsPixiRenderPreflight.checkLeaf(node, producer);
    if (!producer.prepareBeforeFilters) {
      PMJS.pixi4.scenePreparation.prepare(node, nativeSceneFilterResolution, nativeSceneTransformsPrepared);
    }
  }
  var pictureBlend = particleContext ? -1 : nativeScenePictureBlend(node);

  var nodeMask = node.mask || null;
  var filterPlan;
  var nativeClip;
  var nativeMask;
  if (nativeNodeNeedsAdvancedEffects(enabledFilterCount, nodeMask,
      forcedMask, pictureBlend)) {
    filterPlan = resolveNativeAdvancedEffects(node, particleContext,
      activeFilters, nodeMask, forcedMask, pictureBlend, forcedClip, parentIndex);
    if (!filterPlan) return;
    nativeClip = filterPlan.clip;
    nativeMask = null;
  } else {

    filterPlan = nativeSceneNoFilterPlan;
    nativeClip = forcedClip;
    nativeMask = null;
  }
  var nativeBlur = filterPlan.blur;
  var transform = node.transform;
  if (!particleContext && !nativeSceneTransformsPrepared && transform &&
      !(parentIndex === 0xffffffff && nativeSceneRootUsesWorldTransform) &&
      typeof transform.updateLocalTransform === 'function') {
    transform.updateLocalTransform();
  }
  var local;
  if (particleValues) {
    var particleCos = Math.cos(particleValues.rotation);
    var particleSin = Math.sin(particleValues.rotation);
    local = { a: particleCos * particleValues.scaleX,
      b: particleSin * particleValues.scaleX,
      c: -particleSin * particleValues.scaleY,
      d: particleCos * particleValues.scaleY,
      tx: particleValues.x, ty: particleValues.y };
  } else {
    local = transform && (parentIndex === 0xffffffff &&
      nativeSceneRootUsesWorldTransform ? transform.worldTransform :
      transform.localTransform) || nativeIdentityTransform;
  }
  if (parentIndex === 0xffffffff && nativeSceneRootTransform !== nativeIdentityTransform) {
    local = nativeComposeTransform(nativeSceneRootTransform, local);
  }
  var tint = particleValues ? particleValues.tint :
    (node.tint === undefined ? 0xffffff : node.tint);
  if (particleContext) {
    tint = nativeMultiplyTint(tint, particleContext.container.tint);
  }

  var pipeType = particleValues ? 'sprite' : nativeNodeRenderType(node);
  var pipeKind = particleValues ? PMJS_SCENE_KIND.SPRITE :
    nativeSceneKindForType(pipeType);
  if (pipeKind === PMJS_SCENE_KIND.CONTAINER &&
      pipeType !== 'container' && pipeType !== 'tilemap') {
    var pluginChildren = node.children && node.children.length || 0;
    PMJS.compat.hit('render.renderer-plugin',
      (node.constructor && node.constructor.name || 'node') + ':renderer=' + pipeType +
      (pluginChildren ? ':children=' + pluginChildren : ':visual-leaf'));
  }

  if (!nativeSceneEmission) nativeSceneEmission = PMJS.pixi4.sceneEncoding.createEmission();
  PMJS.pixi4.sceneEncoding.encode(pipeKind, node, pipeType, particleContext,
    particleValues, nativeSceneEmission, tint);
  var kind = nativeSceneEmission.kind;
  var resource = nativeSceneEmission.resource;
  tint = nativeSceneEmission.tint;
  var texture = nativeSceneEmission.texture;
  var frame = nativeSceneEmission.frame;
  var nativeImage = nativeSceneEmission.nativeImage;
  var source = nativeSceneEmission.source;
  var localX = nativeSceneEmission.localX;
  var localY = nativeSceneEmission.localY;
  var destinationWidth = nativeSceneEmission.destWidth;
  var destinationHeight = nativeSceneEmission.destHeight;
  var tilingResolution = nativeSceneEmission.tilingResolution;
  var sampledBaseTexture = nativeSceneEmission.sampledBaseTexture;

  if (kind === 3) {
    nativeScreenOverlays.push([node._red || 0, node._green || 0, node._blue || 0,
      Math.round(node.alpha * 255)]);
  }
  var filterGroups = filterPlan.groups || [];
  var windowLayer = typeof WindowLayer === 'function' && node instanceof WindowLayer &&
    typeof node._maskWindow === 'function';
  if (windowLayer && !filterGroups.length && nativeWindowLayerHasContent(node)) {
    filterGroups = [{ kind: 20, resource: 0, parameters: [1] }];
  }
  var windowTargetFrame = windowLayer && filterGroups.length && filterGroups[0].frame ||
    windowLayer && node.filterArea || null;
  if (nativeSceneFilterDepth + filterGroups.length > 4) {
    var detail = (node.constructor && node.constructor.name || 'node') + ':filter-depth=' +
      (nativeSceneFilterDepth + filterGroups.length) + ':maximum=4';
    PMJS.compat.hit('render.filter-depth', detail);
    throw new Error('unsupported native capability: render.filter-depth: ' + detail);
  }

  for (var filterIndex = filterGroups.length - 1; filterIndex >= 0; filterIndex--) {
    nativeSceneFilterMarker(6, filterGroups[filterIndex].kind,
      filterGroups[filterIndex].resource, filterGroups[filterIndex].parameters,
      parentIndex, nativeClip);
  }
  nativeSceneFilterDepth += filterGroups.length;

  if (nativeSceneEmission.aborted) {
    var abortedParent = nativeSceneRecord(parentIndex, 0, 0, tint,
      blendMode, local, particleValues ? particleValues.alpha :
        forcedAlpha === undefined ? node.alpha : forcedAlpha,
      nativeClip, nativeBlur, nativeMask);
    var abortedChildren = node.children || [];
    for (var abortedIndex = 0; abortedIndex < abortedChildren.length;
        abortedIndex++) {
      writeNativeSceneNode(abortedChildren[abortedIndex], abortedParent);
    }
    closeNativeSceneFilters(filterGroups.length, parentIndex, nativeClip);
    return;
  }

  if (kind === 1) {
    var textureRotation = ((Number(texture && texture.rotate) || 0) % 16 + 16) % 16;
    if (textureRotation % 2) {
      PMJS.compat.hit('render.texture-rotation', String(textureRotation));
    }
  }
  var nodeIndex = nativeSceneRecord(parentIndex, kind, resource, tint,
    blendMode, local, particleValues ? particleValues.alpha :
      forcedAlpha === undefined ? node.alpha : forcedAlpha,
    nativeClip, nativeBlur, nativeMask);
  if (!particleContext && kind !== 9 && !(forcedAlpha !== undefined && parentIndex !== 0xffffffff)) {
    nativePreparedWorldRecord(node, nodeIndex, forcedAlpha);
  }
  var valueOffset = nodeIndex * nativeSceneValueStride;
  nativeSceneValues[valueOffset + 7] = localX;
  nativeSceneValues[valueOffset + 8] = localY;
  if (kind === 1) {
    if (!particleContext && forcedAlpha === undefined) nativePackSpriteColor(node, nodeIndex, tint);
    if (!particleContext) nativeSpriteVertices(node, nodeIndex, nativeSceneEmission.presentation);
    if (texture && texture.__pmjsStandaloneBitmapRegion) nativeSceneMetadata[nodeIndex * nativeSceneMetadataStride + 5] |= 8192;
    textureRotation = ((Number(texture && texture.rotate) || 0) % 16 + 16) % 16;
    nativeSceneMetadata[nodeIndex * nativeSceneMetadataStride + 5] |=
      textureRotation / 2 << 5;
    if (texture && texture.baseTexture && PIXI.SCALE_MODES &&
        texture.baseTexture.scaleMode === PIXI.SCALE_MODES.NEAREST) {
      nativeSceneMetadata[nodeIndex * nativeSceneMetadataStride + 5] |= 8;
    }

    if (nativeSceneRoundPixels && !particleContext &&
        nativeSceneEmission.roundPixelsEligible) {
      nativeSceneMetadata[nodeIndex * nativeSceneMetadataStride + 5] |= 256;
    }
    nativeSceneValues[valueOffset + 9] = frame.x;
    nativeSceneValues[valueOffset + 10] = frame.y;
    var textureBase = texture && texture.baseTexture;
    if (textureBase && textureBase.mipmap &&
        !(PIXI.BaseRenderTexture && textureBase instanceof PIXI.BaseRenderTexture)) {
      nativeSceneMetadata[nodeIndex * nativeSceneMetadataStride + 5] |= 65536;
    }
    if (textureBase && textureBase.__pmjsPremultiplied) {
      nativeSceneMetadata[nodeIndex * nativeSceneMetadataStride + 5] |= 1024;
    }
    var spriteResolution = Math.max(0.000001,
      Number(textureBase && textureBase.resolution) || 1);
    var particleSampleX = 1;
    var particleSampleY = 1;
    if (particleContext && sampledBaseTexture && textureBase &&
        sampledBaseTexture !== textureBase) {
      particleSampleX = (Number(sampledBaseTexture.width) || 1) /
        (Number(textureBase.width) || 1);
      particleSampleY = (Number(sampledBaseTexture.height) || 1) /
        (Number(textureBase.height) || 1);
    }
    nativeSceneValues[valueOffset + 9] *= spriteResolution * particleSampleX;
    nativeSceneValues[valueOffset + 10] *= spriteResolution * particleSampleY;
    nativeSceneValues[valueOffset + 11] = frame.width * spriteResolution * particleSampleX;
    nativeSceneValues[valueOffset + 12] = frame.height * spriteResolution * particleSampleY;

    var cpuTinted = node._tintTexture && texture &&
      texture.baseTexture === node._tintTexture;
    if (cpuTinted && typeof nativeMaterializationStats !== 'undefined') {
      nativeMaterializationStats.cpuTintedSprites++;
    }
    var colorTone = cpuTinted ? null : node._colorTone;
    var blendColor = cpuTinted ? null : node._blendColor;
    if ((colorTone && (colorTone[0] || colorTone[1] || colorTone[2] ||
         colorTone[3])) || (blendColor && blendColor[3] > 0)) {
      if (typeof nativeMaterializationStats !== 'undefined') {
        nativeMaterializationStats.shaderToneSprites++;
      }
      nativeSceneMetadata[nodeIndex * nativeSceneMetadataStride + 5] |= 16;
      for (var colorIndex = 0; colorIndex < 4; colorIndex++) {
        nativeSceneValues[valueOffset + 33 + colorIndex] =
          colorTone ? Math.max(-255, Math.min(255,
            Number(colorTone[colorIndex]) || 0)) / 255 : 0;
        nativeSceneValues[valueOffset + 37 + colorIndex] =
          blendColor ? Math.max(0, Math.min(255,
            Number(blendColor[colorIndex]) || 0)) / 255 : 0;
      }
      nativeSceneValues[valueOffset + 36] =
        Math.max(0, nativeSceneValues[valueOffset + 36]);
    }
  } else if (kind === 8) {
    if (texture && texture.baseTexture && PIXI.SCALE_MODES &&
        texture.baseTexture.scaleMode === PIXI.SCALE_MODES.NEAREST) {
      nativeSceneMetadata[nodeIndex * nativeSceneMetadataStride + 5] |= 8;
    }
    var mvBitmapColor = PMJS.mv && PMJS.mv.bitmapMeshColor && PMJS.mv.bitmapMeshColor(node);
    var meshPostTintOverlayColor = mvBitmapColor || node._pmjsMeshPostTintOverlay;
    if (meshPostTintOverlayColor && meshPostTintOverlayColor[3] > 0) {
      nativeSceneMetadata[nodeIndex * nativeSceneMetadataStride + 5] |= mvBitmapColor ? 16384 : 512;
      for (var meshColorIndex = 0; meshColorIndex < 4; meshColorIndex++) {
        nativeSceneValues[valueOffset + 37 + meshColorIndex] =
          Math.max(0, Math.min(255,
            Number(meshPostTintOverlayColor[meshColorIndex]) || 0)) / 255;
      }
    }
  } else if (kind === 2) {
    if (texture && texture.baseTexture && PIXI.SCALE_MODES &&
        texture.baseTexture.scaleMode === PIXI.SCALE_MODES.NEAREST) {
      nativeSceneMetadata[nodeIndex * nativeSceneMetadataStride + 5] |= 8;
    }
    if (!nativeSceneEmission.tilingSimple) {
      nativeSceneMetadata[nodeIndex * nativeSceneMetadataStride + 5] |= 32768;
    }
    var scaleX = node.tileTransform.localTransform.a;
    var scaleY = node.tileTransform.localTransform.d;
    var tilingSource = nativeTilingSource(node, scaleX, scaleY);
    nativeSceneValues[valueOffset + 9] = tilingSource.x * tilingResolution;
    nativeSceneValues[valueOffset + 10] = tilingSource.y * tilingResolution;
    nativeSceneValues[valueOffset + 11] = tilingSource.width * tilingResolution;
    nativeSceneValues[valueOffset + 12] = tilingSource.height * tilingResolution;
    if (nativeSceneEmission.tilingAtlas) {
      // Keep the normalized quad and inverse tile matrix separate until vertex shading.
      nativeSceneMetadata[nodeIndex * nativeSceneMetadataStride + 5] |= 1048576;
      var PictureType = PIXI.extras && PIXI.extras.PictureTilingSprite;
      var anchorUvs = node.uvRespectAnchor ||
        typeof PictureType === 'function' && node instanceof PictureType;
      nativeSceneValues[valueOffset + 9] = anchorUvs ? -node.anchor.x : 0;
      nativeSceneValues[valueOffset + 10] = anchorUvs ? -node.anchor.y : 0;
      nativeSceneValues[valueOffset + 11] = anchorUvs ? 1 - node.anchor.x : 1;
      nativeSceneValues[valueOffset + 12] = anchorUvs ? 1 - node.anchor.y : 1;
      var tileMatrix = node.tileTransform.localTransform;
      var tileWidth = texture.width, tileHeight = texture.height;
      var a = tileMatrix.a * tileWidth / node.width;
      var d = tileMatrix.d * tileHeight / node.height;
      var determinant = a * d;
      var tilingUvTransform = determinant === 0 ||
        !['a', 'b', 'c', 'd', 'tx', 'ty'].every(function(key) { return Number.isFinite(tileMatrix[key]); }) ? [0, 0, 0, 0] :
        [d / determinant, a / determinant,
          -d * (tileMatrix.tx / node.width) / determinant,
          -a * (tileMatrix.ty / node.height) / determinant];
      var atlasBase = texture.baseTexture;
      var atlasFrame = texture._frame || texture.frame;
      var mapping = [atlasFrame.width / atlasBase.width, atlasFrame.height / atlasBase.height,
        atlasFrame.x / atlasBase.width, atlasFrame.y / atlasBase.height];
      var margin = 0.5 / tilingResolution;
      var bounds = [(atlasFrame.x + margin) / atlasBase.width,
        (atlasFrame.y + margin) / atlasBase.height,
        (atlasFrame.x + atlasFrame.width - margin) / atlasBase.width,
        (atlasFrame.y + atlasFrame.height - margin) / atlasBase.height];
      for (var component = 0; component < 4; component++) {
        nativeSceneValues[valueOffset + 28 + component] = tilingUvTransform[component];
        nativeSceneValues[valueOffset + 32 + component] = mapping[component];
        nativeSceneValues[valueOffset + 36 + component] = bounds[component];
      }
    }
  }
  nativeSceneValues[valueOffset + 13] = destinationWidth;
  nativeSceneValues[valueOffset + 14] = destinationHeight;
  if (particleContext) {
    closeNativeSceneFilters(filterGroups.length, parentIndex, nativeClip);
    return;
  }

  if (!node.children) {
    closeNativeSceneFilters(filterGroups.length, parentIndex, nativeClip);
    return;
  }
  if (typeof WindowLayer === 'function' && node instanceof WindowLayer) {
    for (var windowIndex = 0; windowIndex < node.children.length; windowIndex++) {
      var windowChild = node.children[windowIndex];
      if (windowChild && windowChild._isWindow && windowChild.visible &&
          windowChild.openness > 0) {

        if (windowLayer) {
          if (!filterGroups.length) {
            PMJS.compat.hit('render.window-layer', 'isolated rectangle clear is unavailable');
          } else {
            node._maskWindow(windowChild, {
              x: Math.round(-windowTargetFrame.x), y: Math.round(-windowTargetFrame.y) });
            var rectangle = node._windowRect;
            if (!rectangle) throw new Error('WindowLayer mask did not provide a rectangle');
            var clearIndex = nativeSceneRecord(0xffffffff, 10, 0, 0, 0,
              nativeIdentityTransform, 1, nativeClip, 0, null);
            var clearOffset = clearIndex * nativeSceneValueStride;
            var clearProjection = nativeSceneRootTransform;
            var clearScale = clearProjection.b === 0 && clearProjection.c === 0 &&
              clearProjection.a > 0 && clearProjection.a === clearProjection.d ? clearProjection.a : 1;
            nativeSceneValues[clearOffset + 7] = (rectangle.x + windowTargetFrame.x) * clearScale + clearProjection.tx;
            nativeSceneValues[clearOffset + 8] = (rectangle.y + windowTargetFrame.y) * clearScale + clearProjection.ty;
            nativeSceneValues[clearOffset + 13] = rectangle.width * clearScale;
            nativeSceneValues[clearOffset + 14] = rectangle.height * clearScale;
            var clearRenderer = globalThis.Graphics && Graphics._renderer;
            nativeSceneValues[clearOffset + 33] = (clearRenderer && clearRenderer.resolution || 1) / clearScale;
          }
        }
        writeNativeSceneNode(windowChild, nodeIndex);
      }
    }
    closeNativeSceneFilters(filterGroups.length, parentIndex, nativeClip);
    for (var otherIndex = 0; otherIndex < node.children.length; otherIndex++) {
      var otherChild = node.children[otherIndex];
      if (otherChild && !otherChild._isWindow) {
        writeNativeSceneNode(otherChild, nodeIndex);
      }
    }
    return;
  }
  var particleContainer = PIXI.particles && PIXI.particles.ParticleContainer &&
    node instanceof PIXI.particles.ParticleContainer;
  var childLimit = particleContainer ?
    Math.min(node.children.length, Math.max(0, Number(node._maxSize) || 0)) :
    node.children.length;
  var particleFrame = particleContainer ? nativeParticleFrameContext(node) : null;
  for (var index = 0; index < childLimit; index++) {
    if (nativeSceneTraversesChild(kind, node, node.children[index])) {
      if (nativeScenePlainSpriteSegments && !particleFrame && childLimit - index >= 4 &&
          PMJS.optimizations.isEnabled('scene.plain-sprite-segment')) {
        var segment = [];
        var segmentIndex = index;
        while (segmentIndex < childLimit &&
            nativeSceneTraversesChild(kind, node, node.children[segmentIndex])) {
          var binding = nativePlainSpriteBinding(node.children[segmentIndex]);
          if (!binding) break;
          segment.push(binding);
          segmentIndex++;
        }
        if (segment.length >= 4) {
          writeNativePlainSpriteSegment(segment, nodeIndex);
          index = segmentIndex - 1;
          continue;
        }
      }
      if (particleFrame) particleFrame.childIndex = index;
      writeNativeSceneNode(node.children[index], nodeIndex, null, null,
        particleFrame);
    }
  }
  if (filterPlan.colorMatrix) {
    var toneIndex = nativeSceneRecord(0xffffffff, 5, 0, 0xffffff, 0,
      nativeIdentityTransform, filterPlan.toneAlpha, null, 0, null);
    var toneValues = toneIndex * nativeSceneValueStride;
    nativeSceneValues.set(filterPlan.colorMatrix, toneValues + 7);
  }
  closeNativeSceneFilters(filterGroups.length, parentIndex, nativeClip);
}

function prepareNativeBitmapCache(node, renderer, root) {
  if (!node._cacheAsBitmap) return;
  if (typeof node._initCachedDisplayObject !== 'function') {
    throw new Error('Pixi bitmap cache initializer is unavailable');
  }

  var alpha = 1;
  var ancestor = node;
  while (ancestor) {
    alpha *= ancestor.alpha === undefined ? 1 : ancestor.alpha;
    if (ancestor === root) break;
    ancestor = ancestor.parent;
  }
  node.worldAlpha = alpha;
  node.__pmjsBuildingBitmapCache = true;
  try {
    node._initCachedDisplayObject(renderer);
  } finally {
    node.__pmjsBuildingBitmapCache = false;
  }
}

function prepareNativeDeclaredBitmapCaches(stage, renderer, policy, state) {
  if (policy.valid(stage) !== true) {
    nativeStageBitmapCacheAdmissions.delete(stage);
    state.bitmapCacheAdmission = 'invalid';
    return false;
  }
  var admission = nativeStageBitmapCacheAdmissions.get(stage);
  if (!admission || admission.policy !== policy) {
    function declared(node) {
      if (!node) return true;
      if (node._cacheAsBitmap && policy.nodes.indexOf(node) < 0) return false;
      var children = node.children || [];
      for (var i = 0; i < children.length; i++) if (!declared(children[i])) return false;
      return true;
    }
    admission = { policy: policy, accepted: declared(stage) };
    nativeStageBitmapCacheAdmissions.set(stage, admission);
  }
  state.bitmapCacheAdmission = admission.accepted ? 'accepted' : 'rejected';
  if (!admission.accepted || policy.nodes.length > 1) return false;
  state.bitmapCacheMode = 'declared';
  var node = policy.nodes[0];
  if (!node) return true;
  var ancestor = node;
  while (ancestor) {
    if (nativeSceneNodeRejected(ancestor, null) || ancestor !== node &&
        ancestor._cacheAsBitmap && ancestor._cacheData && ancestor._cacheData.sprite) return true;
    if (ancestor === stage) {
      if (!node._cacheData || !node._cacheData.sprite) prepareNativeBitmapCache(node, renderer, stage);
      return true;
    }
    var parent = ancestor.parent;
    if (!parent || !parent.children || parent.children.indexOf(ancestor) < 0) return true;
    ancestor = parent;
  }
  return true;
}

function prepareNativeBitmapCaches(node, renderer, root, policy) {
  if (!root && node) {
    var state = nativeStageRenderState(node);
    state.bitmapCacheMode = 'full';
    state.bitmapCacheAdmission = policy === false ? 'offscreen' : 'unconfigured';
    if (policy && prepareNativeDeclaredBitmapCaches(node, renderer, policy, state)) return;
  }
  if (!node || nativeSceneNodeRejected(node, null)) return;
  root = root || node;
  if (node._cacheAsBitmap && node._cacheData && node._cacheData.sprite) return;
  var children = node.children;
  if (children) {
    for (var index = 0; index < children.length; index++) {
      prepareNativeBitmapCaches(children[index], renderer, root);
    }
  }
  prepareNativeBitmapCache(node, renderer, root);
}

function encodeNativeScene(stage, backgroundColor = null) {
  var previous = nativeSceneEncodingDepth ? {
    metadata: nativeSceneMetadata, values: nativeSceneValues, capacity: nativeSceneCapacity,
    count: nativeSceneCount, bulkClear: nativeSceneBulkClear, filterDepth: nativeSceneFilterDepth,
    emission: nativeSceneEmission, plans: nativeCustomFilterPlans
  } : null;
  if (previous) {
    nativeSceneMetadata = new Uint32Array(nativeSceneCapacity * nativeSceneMetadataStride);
    nativeSceneValues = new Float32Array(nativeSceneCapacity * nativeSceneValueStride);
    nativeSceneCount = 0;
    nativeSceneEmission = null;
  }
  nativeSceneEncodingDepth++;
  var encoded = false;
  try {
    nativeCustomFilterPlans = [];
    resetNativeSceneRecords();
    nativeSceneFilterDepth = 0;
    if (backgroundColor !== null) {
      nativeSceneRecord(0xffffffff, 3, 0, backgroundColor,
        0, nativeIdentityTransform, 1, null, 0, null);
    }
    writeNativeSceneNode(stage, 0xffffffff);
    var packet = { version: nativeScenePacketVersion,
      metadata: nativeSceneMetadata, values: nativeSceneValues,
      count: nativeSceneCount, customFilterPlans: nativeCustomFilterPlans };
    encoded = true;
    return packet;
  } finally {
    if (!encoded) disposeNativeCustomFilterPlans(nativeCustomFilterPlans);
    nativeSceneEncodingDepth--;
    if (previous) {
      nativeSceneMetadata = previous.metadata;
      nativeSceneValues = previous.values;
      nativeSceneCapacity = previous.capacity;
      nativeSceneCount = previous.count;
      nativeSceneBulkClear = previous.bulkClear;
      nativeSceneFilterDepth = previous.filterDepth;
      nativeSceneEmission = previous.emission;
      nativeCustomFilterPlans = previous.plans;
    }
  }
}

function submitNativeScene(stage, backgroundColor = null) {
  var packet = encodeNativeScene(stage, backgroundColor);
  if (!NativeHost.scene) {
    disposeNativeCustomFilterPlans(packet.customFilterPlans);
    throw new Error('native scene was not rendered: scene service unavailable');
  }
  try {
    NativeHost.scene.submit(packet.version, packet.metadata,
      packet.values, packet.count);
  } catch (error) {
    var resources = [];
    for (var recordIndex = 0; recordIndex < packet.count; recordIndex++) {
      var metadataOffset = recordIndex * nativeSceneMetadataStride;
      var kind = packet.metadata[metadataOffset];
      var resource = packet.metadata[metadataOffset + 2];
      var mask = packet.metadata[metadataOffset + 6];
      if (resource || mask) resources.push({ index: recordIndex, kind: kind,
        resource: resource, mask: mask,
        flags: packet.metadata[metadataOffset + 5] });
    }
    var videos = PMJS.web && PMJS.web.video
      ? PMJS.web.video.diagnostics() : [];
    console.error('[pmjs-scene] submit failed resources=' +
      JSON.stringify(resources) + ' videos=' + JSON.stringify(videos));
    throw error;
  } finally {
    disposeNativeCustomFilterPlans(packet.customFilterPlans);
  }
  return true;
}

function collectNativeTilemaps(node, output) {
  if (!node) return output;
  if (node instanceof Tilemap) output.push(node);
  var children = node.children || [];
  for (var index = 0; index < children.length; index++) {
    collectNativeTilemaps(children[index], output);
  }
  return output;
}

function renderNativeStage(stage, rootTransform, filterResolution, roundPixels,
    skipUpdateTransform, backgroundColor = null, options = {}, bindTarget) {
  var previousContext = {
    worldState: nativeSceneUsePixiWorldState, prepared: nativeSceneTransformsPrepared,
    root: nativeSceneRootTransform, usesWorld: nativeSceneRootUsesWorldTransform,
    resolution: nativeSceneFilterResolution, roundPixels: nativeSceneRoundPixels,
    renderer: nativeSceneRenderer, plainSpriteSegments: nativeScenePlainSpriteSegments
  };
  var parentWorld = nativeTransformParent.transform.worldTransform;
  var previousParentWorld = { a: parentWorld.a, b: parentWorld.b, c: parentWorld.c,
    d: parentWorld.d, tx: parentWorld.tx, ty: parentWorld.ty };
  var enclosingOverlays = nativeSceneEncodingDepth ? nativeScreenOverlays : null;
  var enclosingTileRects = nativeTileRects;
  if (enclosingOverlays) nativeScreenOverlays = [];
  nativeScreenOverlays.length = 0;
  nativeTileRects = 0;
  var localTransforms = !skipUpdateTransform && options.worldState === 'local';
  var parent = stage.parent;
  var parentReplaced = !skipUpdateTransform;
  if (parentReplaced) stage.parent = nativeTransformParent;
  nativeSceneRootTransform = rootTransform &&
    (rootTransform.a !== 1 || rootTransform.b !== 0 || rootTransform.c !== 0 ||
      rootTransform.d !== 1 || rootTransform.tx !== 0 || rootTransform.ty !== 0) ?
    rootTransform : nativeIdentityTransform;
  nativeSceneRootUsesWorldTransform = !!skipUpdateTransform ||
    (!localTransforms && nativeSceneRootTransform !== nativeIdentityTransform);
  nativeSceneFilterResolution = Math.max(0.000001,
    Number(filterResolution) || 1);
  nativeSceneRoundPixels = !!roundPixels;
  nativeScenePlainSpriteSegments = options.plainSpriteSegments !== false;
  nativeSceneRenderer = options.renderer || null;
  if (parentWorld.a !== 1 || parentWorld.b !== 0 || parentWorld.c !== 0 ||
      parentWorld.d !== 1 || parentWorld.tx !== 0 || parentWorld.ty !== 0) {
    // Pixi caches descendants against the parent's world-transform generation.
    nativeTransformParent.transform._worldID++;
  }
  parentWorld.identity();
  var map = globalThis.$gameMap;
  var cameraX = map && map._displayX;
  var cameraY = map && map._displayY;
  var newStage = renderNativeStage._stage !== stage;
  var renderHitsBefore = nativeRenderHitCount();
  try {
    if (NativeHost.scene) {
      if (newStage) renderNativeStage._tilemaps = collectNativeTilemaps(stage, []);
      var plan = !skipUpdateTransform && !localTransforms && options.worldState !== 'pixi' &&
        pmjsPixiRenderPreflight.transformPlan(stage);
      nativeSceneUsePixiWorldState = !!skipUpdateTransform || !localTransforms &&
        (!!plan || options.worldState === 'pixi' || typeof stage.updateTransform === 'function');
      nativeSceneTransformsPrepared = nativeSceneUsePixiWorldState;
      if (!skipUpdateTransform && !localTransforms) {
        if (plan) PMJS.pixi4.scenePreparation.transforms(plan, stage);
        else if (typeof stage.updateTransform === 'function') stage.updateTransform();
      }
      if (!nativeSceneTransformsPrepared && typeof prepareNativeMvWindowTransforms === 'function') {
        prepareNativeMvWindowTransforms(stage);
      }
      if (parentReplaced) {
        stage.parent = parent;
        parentReplaced = false;
      }
      if (PMJS.mv && PMJS.mv.pictureLayerCache) {
        PMJS.mv.pictureLayerCache.prepare(stage, nativeSceneRenderer);
      }
      if (bindTarget) bindTarget();
      submitNativeScene(stage, backgroundColor);
      var state = nativeStageRenderState(stage);
      state.renders++;
      state.worldState = localTransforms ? 'local' : nativeSceneUsePixiWorldState ? 'pixi' : 'native';
      state.skipUpdateTransform = !!skipUpdateTransform;
    }
  } catch (error) {
    renderNativeStage._ready = false;
    throw error;
  } finally {
    nativeSceneUsePixiWorldState = previousContext.worldState;
    nativeSceneTransformsPrepared = previousContext.prepared;
    nativeSceneRootTransform = previousContext.root;
    nativeSceneRootUsesWorldTransform = previousContext.usesWorld;
    nativeSceneFilterResolution = previousContext.resolution;
    nativeSceneRoundPixels = previousContext.roundPixels;
    nativeScenePlainSpriteSegments = previousContext.plainSpriteSegments;
    nativeSceneRenderer = previousContext.renderer;
    if (enclosingOverlays) {
      nativeScreenOverlays = enclosingOverlays;
      nativeTileRects = enclosingTileRects;
    }
    if (parentWorld.a !== previousParentWorld.a || parentWorld.b !== previousParentWorld.b ||
        parentWorld.c !== previousParentWorld.c || parentWorld.d !== previousParentWorld.d ||
        parentWorld.tx !== previousParentWorld.tx || parentWorld.ty !== previousParentWorld.ty) {
      nativeTransformParent.transform._worldID++;
    }
    Object.assign(parentWorld, previousParentWorld);
    if (parentReplaced) stage.parent = parent;
  }
  renderNativeStage._ready = true;
  renderNativeStage._framesTotal = (renderNativeStage._framesTotal || 0) + 1;
  if (nativeRenderHitCount() > renderHitsBefore) {
    renderNativeStage._framesDegraded = (renderNativeStage._framesDegraded || 0) + 1;
  }
  renderNativeStage._stage = stage;
  renderNativeStage._cameraX = cameraX;
  renderNativeStage._cameraY = cameraY;
}
