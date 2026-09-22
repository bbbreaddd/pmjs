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

function nativeNodeRenderType(node) {
  var type = node && node.pluginName;
  if (!type && node && typeof node._pmjsType === 'string') {
    type = node._pmjsType;
  }
  if (!type && typeof globalThis.__pmjsNodeRenderType === 'function') {
    type = globalThis.__pmjsNodeRenderType(node);
  }
  if (type === 'tilingSprite') type = 'tilingsprite';
  if (type) {
    return String(type).toLowerCase();
  }
  if (typeof ScreenSprite === 'function' && node instanceof ScreenSprite) {
    return 'screensprite';
  }
  if (PIXI.extras && PIXI.extras.TilingSprite &&
      node instanceof PIXI.extras.TilingSprite) return 'tilingsprite';
  if (PIXI.mesh && PIXI.mesh.Mesh && node instanceof PIXI.mesh.Mesh) return 'mesh';
  if (PIXI.Graphics && node instanceof PIXI.Graphics) return 'graphics';
  if (PIXI.Sprite && node instanceof PIXI.Sprite) return 'sprite';
  return 'container';
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
    typeof node._openness === 'number' && node._openness <= 0 ||
    !!(node.scale && (node.scale.x === 0 || node.scale.y === 0));
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
  var dirty = [];
  var dirtyFollowing = false;
  var batchCount = Math.ceil(Math.min(container.children.length,
    Math.max(0, Number(container._maxSize) || 0)) / batchSize);
  for (var index = 0; index < batchCount; index++) {
    var requested = container._bufferUpdateIDs[index] || 0;
    dirtyFollowing = dirtyFollowing || (revisions[index] || 0) < requested;
    dirty[index] = dirtyFollowing;
    if (dirtyFollowing) revisions[index] = container._updateID || requested;
  }
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

function nativePlainSpriteBinding(node) {
  if (nativeSceneNodeRejected(node, null) || node.children && node.children.length ||
      node.shader || node.mask || typeof node.updateChowRender === 'function' ||
      nativeNodeRenderType(node) !== 'sprite' || nativeScenePictureBlend(node) >= 0) {
    return null;
  }
  var filters = nativeSceneFilters(node);
  if (filters && filters.some(function(filter) {
    return filter && filter.enabled !== false;
  })) return null;
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
  nativeSceneSegmentStats.runs++;
  nativeSceneSegmentStats.sprites += bindings.length;
  for (var bindingIndex = 0; bindingIndex < bindings.length; bindingIndex++) {
    var binding = bindings[bindingIndex];
    var node = binding.node;
    var transform = node.transform;
    if (transform && typeof transform.updateLocalTransform === 'function') {
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
    var metadataOffset = nodeIndex * nativeSceneMetadataStride;
    var valueOffset = nodeIndex * nativeSceneValueStride;
    nativeSceneValues[valueOffset + 7] = localX;
    nativeSceneValues[valueOffset + 8] = localY;
    nativeSceneMetadata[metadataOffset + 5] |= binding.rotation / 2 << 5;
    if (PIXI.SCALE_MODES && binding.base.scaleMode === PIXI.SCALE_MODES.NEAREST) {
      nativeSceneMetadata[metadataOffset + 5] |= 8;
    }
    if (nativeSceneRoundPixels) nativeSceneMetadata[metadataOffset + 5] |= 256;
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
    writeNativeSceneRectTileLayer(node, parentIndex);
    return;
  }
  if (nativeSceneNodeRejected(node, particleContext)) return;
  if (!particleContext && node._cacheAsBitmap &&
      !node.__pmjsBuildingBitmapCache) {
    var cacheProducer = node.constructor && node.constructor.name || 'node';
    var cachedSprite = node._cacheData && node._cacheData.sprite;
    if (cachedSprite) {
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
  if (!particleContext && typeof globalThis.__pmjsBeforeRenderNode === 'function') {
    globalThis.__pmjsBeforeRenderNode(node);
  }
  if (!particleContext) prepareNativeSceneNode(node);
  if (!particleContext && node.shader) {
    PMJS.compat.hit('render.shader',
      (node.constructor && node.constructor.name || 'node') + ':' +
      (node.shader.constructor && node.shader.constructor.name || 'shader') +
      ':base=' + nativeNodeRenderType(node));
  }
  var blendMode = nativeSceneBlendMode(particleContext || node);
  if (blendMode < 0) {
    PMJS.compat.hit('render.blend-mode',
      (node.constructor && node.constructor.name || 'node') + ':blend=' + node.blendMode);
    blendMode = 0;
  }
  if (!particleContext && globalThis.__pmjsTrace && __pmjsTrace.active()) {
    __pmjsTrace.count('writer_filter_state_reads', 1);
  }
  var nodeFilters = null;
  if (!particleContext) {
    if (node._filters || node.__pmjsNativeDirectFilters === false) {
      nodeFilters = nativeSceneFilters(node);
    } else if (node.__pmjsNativeDirectFilters === undefined) {
      nodeFilters = nativeSceneFilters(node);
    }
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
  var pictureBlend = particleContext ? -1 : nativeScenePictureBlend(node);

  var nodeMask = node.mask || null;
  var filterPlan;
  var nativeClip;
  var nativeMask;
  if (nativeNodeNeedsAdvancedEffects(enabledFilterCount, nodeMask,
      forcedMask, pictureBlend)) {
    filterPlan = resolveNativeAdvancedEffects(node, particleContext,
      activeFilters, nodeMask, forcedMask, pictureBlend, forcedClip);
    if (!filterPlan) return;
    nativeClip = nativeEffectClip;
    nativeMask = nativeEffectAlphaMask;
  } else {

    filterPlan = nativeSceneNoFilterPlan;
    nativeClip = forcedClip;
    nativeMask = null;
  }
  var nativeBlur = filterPlan.blur;
  var transform = node.transform;
  if (!particleContext && transform &&
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

  resetNativeSceneEmission(tint);
  writeNativeSceneKind(pipeKind, node, pipeType, particleContext,
    particleValues);
  if (nativeSceneEmission.aborted) {
    var abortedChildren = node.children || [];
    for (var abortedIndex = 0; abortedIndex < abortedChildren.length;
        abortedIndex++) {
      writeNativeSceneNode(abortedChildren[abortedIndex], parentIndex,
        forcedClip, forcedMask, null);
    }
    return;
  }
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

  var filterGroups = filterPlan.groups || [];
  if (nativeSceneFilterDepth + filterGroups.length > 4) {
    var appliedGroups = Math.max(0, 4 - nativeSceneFilterDepth);
    PMJS.compat.hit('render.filter-depth',
      (node.constructor && node.constructor.name || 'node') + ':filter-depth' +
      ':original=' + filterGroups.length + ':applied=' + appliedGroups);
    filterGroups = filterGroups.slice(0, appliedGroups);
  }

  for (var filterIndex = filterGroups.length - 1; filterIndex >= 0; filterIndex--) {
    nativeSceneFilterMarker(6, filterGroups[filterIndex].kind,
      filterGroups[filterIndex].resource, filterGroups[filterIndex].parameters,
      parentIndex, nativeClip);
  }
  nativeSceneFilterDepth += filterGroups.length;

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
  var valueOffset = nodeIndex * nativeSceneValueStride;
  nativeSceneValues[valueOffset + 7] = localX;
  nativeSceneValues[valueOffset + 8] = localY;
  if (kind === 1) {
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
    if (globalThis.__pmjsTrace && __pmjsTrace.active()) {
      var selectedResource = __pmjsTrace.revision(nativeImage,
        source && source._nativeCanvas ? 'canvas' : 'image');
      var owner = node.parent;
      var owningWindow = null;
      while (owner) {
        var ownerName = owner.constructor && owner.constructor.name || '';
        if (ownerName.indexOf('Window') >= 0) {
          owningWindow = owner;
          break;
        }
        owner = owner.parent;
      }
      __pmjsTrace.describe(node, 'scene', 'scene.object', {
        objectId: __pmjsTrace.id(node, 'display-object'),
        className: node.constructor && node.constructor.name || 'Object',
        pluginName: node.pluginName || '',
        pmjsType: node._pmjsType === undefined ? null : node._pmjsType,
        parentId: __pmjsTrace.id(node.parent, 'display-object'),
        parentClass: node.parent && node.parent.constructor &&
          node.parent.constructor.name || '',
        owningWindowId: __pmjsTrace.id(owningWindow, 'display-object'),
        owningWindowClass: owningWindow && owningWindow.constructor &&
          owningWindow.constructor.name || ''
      });
      __pmjsTrace.event('scene', 'scene.sprite-source', {
        objectId: __pmjsTrace.id(node, 'display-object'),
        packetRecord: nodeIndex, resourceHandle: resource,
        resourceId: selectedResource.id,
        resourceRevision: selectedResource.revision,
        cpuTinted: !!cpuTinted,
        shaderTint: !!(nativeSceneMetadata[
          nodeIndex * nativeSceneMetadataStride + 5] & 16),
        alpha: particleValues ? particleValues.alpha :
          forcedAlpha === undefined ? node.alpha : forcedAlpha,
        blendMode: blendMode,
        transformA: local.a, transformB: local.b,
        transformC: local.c, transformD: local.d,
        transformX: local.tx, transformY: local.ty,
        mask: !!nativeMask, activeFilters: enabledFilterCount,
        frameX: frame.x, frameY: frame.y,
        frameWidth: frame.width, frameHeight: frame.height
      });
    }
  } else if (kind === 8) {
    if (texture && texture.baseTexture && PIXI.SCALE_MODES &&
        texture.baseTexture.scaleMode === PIXI.SCALE_MODES.NEAREST) {
      nativeSceneMetadata[nodeIndex * nativeSceneMetadataStride + 5] |= 8;
    }
  } else if (kind === 2) {
    if (texture && texture.baseTexture && PIXI.SCALE_MODES &&
        texture.baseTexture.scaleMode === PIXI.SCALE_MODES.NEAREST) {
      nativeSceneMetadata[nodeIndex * nativeSceneMetadataStride + 5] |= 8;
    }
    var tileScale = node.tileScale || { x: 1, y: 1 };
    var scaleX = Math.abs(tileScale.x) > 0.000001 ? tileScale.x : 1;
    var scaleY = Math.abs(tileScale.y) > 0.000001 ? tileScale.y : 1;
    var tilingSource = nativeTilingSource(node, scaleX, scaleY);
    nativeSceneValues[valueOffset + 9] = tilingSource.x * tilingResolution;
    nativeSceneValues[valueOffset + 10] = tilingSource.y * tilingResolution;
    nativeSceneValues[valueOffset + 11] = tilingSource.width * tilingResolution;
    nativeSceneValues[valueOffset + 12] = tilingSource.height * tilingResolution;
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
          windowChild._openness > 0) {

        writeNativeSceneNode(windowChild, nodeIndex);
      }
    }
    for (var otherIndex = 0; otherIndex < node.children.length; otherIndex++) {
      var otherChild = node.children[otherIndex];
      if (otherChild && !otherChild._isWindow) {
        writeNativeSceneNode(otherChild, nodeIndex);
      }
    }
    closeNativeSceneFilters(filterGroups.length, parentIndex, nativeClip);
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
      if (!particleFrame &&
          nativePlainSpriteSegmentsEnabled &&
          PMJS.optimizations.isEnabled('scene.plain-sprite-segment')) {
        var segment = [];
        var segmentIndex = index;
        while (segmentIndex < childLimit &&
            nativeSceneTraversesChild(kind, node, node.children[segmentIndex])) {
          var binding = nativePlainSpriteBinding(node.children[segmentIndex]);
          if (nativeSceneSegmentTracing) {
            nativeSceneSegmentStats.bindingProbes++;
            if (!binding) nativeSceneSegmentStats.rejectedProbes++;
          }
          if (!binding) break;
          segment.push(binding);
          segmentIndex++;
        }
        nativeSceneSegmentStats.candidates += segment.length;
        if (segment.length >= 4) {
          writeNativePlainSpriteSegment(segment, nodeIndex);
          index = segmentIndex - 1;
          continue;
        }
        if (nativeSceneSegmentTracing && segment.length) {
          nativeSceneSegmentStats.abandonedRuns++;
          nativeSceneSegmentStats.abandonedSprites += segment.length;
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

function prepareNativeBitmapCaches(node, renderer, root) {
  if (!node || nativeSceneNodeRejected(node, null)) return;
  root = root || node;
  if (node._cacheAsBitmap && node._cacheData && node._cacheData.sprite) return;
  var children = node.children;
  if (children) {
    for (var index = 0; index < children.length; index++) {
      prepareNativeBitmapCaches(children[index], renderer, root);
    }
  }
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

function encodeNativeScene(stage) {
  resetNativeSceneRecords();
  nativeSceneFilterDepth = 0;
  nativeSceneSegmentTracing = !!(globalThis.__pmjsTrace &&
    __pmjsTrace.active());
  if (nativeSceneBackgroundColor !== null) {
    nativeSceneRecord(0xffffffff, 3, 0, nativeSceneBackgroundColor,
      0, nativeIdentityTransform, 1, null, 0, null);
  }
  writeNativeSceneNode(stage, 0xffffffff);
  traceNativeScenePacket();
  return { version: nativeScenePacketVersion,
    metadata: nativeSceneMetadata, values: nativeSceneValues,
    count: nativeSceneCount };
}

function submitNativeScene(stage) {
  var packet = encodeNativeScene(stage);
  if (!NativeHost.scene) {
    throw new Error('native scene was not rendered: scene service unavailable');
  }
  var submitStarted = globalThis.__pmjsTrace && __pmjsTrace.active() ?
    performance.now() : 0;
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
    var videos = typeof nativeVideos === 'undefined' ? [] : nativeVideos.map(
      function(video) {
        var source = video._pmjsNativeTextureSource();
        return { media: video._media && video._media.handle,
          image: source && source.handle, readyState: video.readyState,
          paused: video.paused };
      });
    console.error('[pmjs-scene] submit failed resources=' +
      JSON.stringify(resources) + ' videos=' + JSON.stringify(videos));
    throw error;
  }
  if (submitStarted) {
    __pmjsTrace.duration('phase', 'scene.native-submit', submitStarted,
      performance.now(), { records: nativeSceneCount });
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
    skipUpdateTransform) {
  var profiling = typeof automationProfiling !== 'undefined' && automationProfiling;
  var stageStarted = profiling ? performance.now() : 0;
  nativeScreenOverlays.length = 0;
  nativeTileRects = 0;
  var parent = stage.parent;
  stage.parent = nativeTransformParent;
  nativeSceneRootTransform = rootTransform || nativeIdentityTransform;
  nativeSceneRootUsesWorldTransform = !!skipUpdateTransform;
  nativeSceneFilterResolution = Math.max(0.000001,
    Number(filterResolution) || 1);
  nativeSceneRoundPixels = !!roundPixels;
  var parentWorld = nativeTransformParent.transform.worldTransform;
  parentWorld.a = nativeSceneRootTransform.a;
  parentWorld.b = nativeSceneRootTransform.b;
  parentWorld.c = nativeSceneRootTransform.c;
  parentWorld.d = nativeSceneRootTransform.d;
  parentWorld.tx = nativeSceneRootTransform.tx;
  parentWorld.ty = nativeSceneRootTransform.ty;
  var map = globalThis.$gameMap;
  var cameraX = map && map._displayX;
  var cameraY = map && map._displayY;
  var newStage = renderNativeStage._stage !== stage;
  var renderHitsBefore = nativeRenderHitCount();
  try {
    if (NativeHost.scene) {
      if (newStage) renderNativeStage._tilemaps = collectNativeTilemaps(stage, []);
      submitNativeScene(stage);
    }
  } catch (error) {
    renderNativeStage._ready = false;
    throw error;
  } finally {
    if (profiling) {
      nativeQueueMs += performance.now() - stageStarted;
      nativeStageSamples++;
    }
    nativeSceneRootTransform = nativeIdentityTransform;
    nativeSceneRootUsesWorldTransform = false;
    nativeSceneFilterResolution = 1;
    nativeSceneRoundPixels = false;
    parentWorld.identity();
    stage.parent = parent;
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
