function nativeSceneTraversesChild(kind, node, child) {
  return kind !== 3 || child !== node._graphics;
}

function nativeSceneBlendMode(node) {
  var mode = Number(node && node.blendMode) || 0;
  if (mode >= 0 && mode <= 3) return mode;
  // Pixi 4 maps these advanced modes to normal blending unless pixi-picture
  // takes over. RPG Maker marks screen pictures with _isPicture, while the
  // plugin's direct sprite classes use pluginName="picture".
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
    type = String(type).toLowerCase();
    if (type === 'sprite' || type === 'picture' || type === 'tilingsprite' ||
        type === 'screensprite' || type === 'weathersprite' || type === 'mesh' ||
        type === 'graphics' || type === 'tilemap') return type;
    // Unknown renderer labels retain container semantics.
    return 'container';
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
  return { left: Math.max(left.left, right.left),
    top: Math.max(left.top, right.top),
    right: Math.min(left.right, right.right),
    bottom: Math.min(left.bottom, right.bottom) };
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
  // Pixi's WebGL ParticleRenderer submits every slot in the batch. Child
  // visibility/renderability, zero scale, and zero alpha do not affect which
  // slots are uploaded (static alpha may intentionally remain visible).
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
  var nativeImage = source && (source._nativeImage || source._nativeCanvas);
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
  return { node: node, texture: texture, base: base, nativeImage: nativeImage,
    frame: frame, rotation: rotation, blendMode: blendMode };
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
    var texture = binding.texture;
    var frame = binding.frame;
    var anchor = node.anchor || { x: 0, y: 0 };
    var original = texture.orig || frame;
    var trim = texture.trim;
    var localX = trim ? trim.x - anchor.x * original.width : -anchor.x * original.width;
    var localY = trim ? trim.y - anchor.y * original.height : -anchor.y * original.height;
    var width = trim ? trim.width : original.width;
    var height = trim ? trim.height : original.height;
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
    particleContext) {
  if (!node || nativeSceneUnsupported) return;
  if (nativeIsRectTileLayer(node)) {
    writeNativeSceneRectTileLayer(node, parentIndex);
    return;
  }
  if (nativeSceneNodeRejected(node, particleContext)) return;
  var particleValues = particleContext ?
    nativeParticleValues(particleContext, node, particleContext.childIndex) : null;
  if (!particleContext && typeof globalThis.__pmjsBeforeRenderNode === 'function') {
    globalThis.__pmjsBeforeRenderNode(node);
  }
  if (!particleContext) prepareNativeSceneNode(node);
  if (!particleContext && node.shader) {
    nativeCompatibilityHit('render.shader',
      node.constructor && node.constructor.name || 'node');
    nativeSceneUnsupported = true;
    nativeSceneUnsupportedReason =
      (node.constructor && node.constructor.name || 'node') + ':shader';
    return;
  }
  var blendMode = nativeSceneBlendMode(particleContext || node);
  if (blendMode < 0) {
    nativeCompatibilityHit('render.blend-mode', String(node.blendMode));
    nativeSceneUnsupported = true;
    nativeSceneUnsupportedReason =
      (node.constructor && node.constructor.name || 'node') + ':blend=' + node.blendMode;
    return;
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
  // The mask is read once and shared by the boundary test and the resolver.
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
    // Simple lane: no enabled filters, masks, or picture-blend work means no
    // filter planning, no mask planning, no bounds work, and no effect
    // arrays or temporary objects. The shared frozen no-op plan is never
    // mutated: masks and picture groups only exist on the advanced lane,
    // which always plans fresh.
    filterPlan = nativeSceneNoFilterPlan;
    nativeClip = forcedClip;
    nativeMask = null;
  }
  var nativeBlur = filterPlan.blur;
  var transform = node.transform;
  if (!particleContext && transform && typeof transform.updateLocalTransform === 'function') {
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
    local = transform && transform.localTransform || nativeIdentityTransform;
  }
  if (parentIndex === 0xffffffff && nativeSceneRootTransform !== nativeIdentityTransform) {
    local = nativeComposeTransform(nativeSceneRootTransform, local);
  }
  var tint = particleValues ? particleValues.tint :
    (node.tint === undefined ? 0xffffff : node.tint);
  if (particleContext) {
    tint = nativeMultiplyTint(tint, particleContext.container.tint);
  }
  // Classification runs after preparation, the render hook, effect discovery,
  // and the transform refresh, in reference order: __pmjsNodeRenderType is
  // arbitrary integration JavaScript and may inspect state derived by
  // updateLocalTransform(). Particle children never dispatch a renderer
  // plugin: they are sprite-shaped by contract.
  var pipeType = particleValues ? 'sprite' : nativeNodeRenderType(node);
  var pipeKind = particleValues ? PMJS_SCENE_KIND.SPRITE :
    nativeSceneKindForType(pipeType);
  // Fixed dispatch: one kind from the classifier, one encoder from the
  // table. The resolved type string travels along so encoders never re-read
  // node state.
  resetNativeSceneEmission(tint);
  writeNativeSceneKind(pipeKind, node, pipeType, particleContext,
    particleValues);
  if (nativeSceneEmission.aborted) return;
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
    nativeCompatibilityHit('render.filter-depth',
      node.constructor && node.constructor.name || 'node');
    nativeSceneUnsupported = true;
    nativeSceneUnsupportedReason =
      (node.constructor && node.constructor.name || 'node') + ':filter-depth';
    return;
  }
  // Nest in reverse so popping the stack applies Pixi's filters left-to-right.
  for (var filterIndex = filterGroups.length - 1; filterIndex >= 0; filterIndex--) {
    nativeSceneFilterMarker(6, filterGroups[filterIndex].kind,
      filterGroups[filterIndex].resource, filterGroups[filterIndex].parameters,
      parentIndex, nativeClip);
  }
  nativeSceneFilterDepth += filterGroups.length;

  var nodeIndex = nativeSceneRecord(parentIndex, kind, resource, tint,
    blendMode, local, particleValues ? particleValues.alpha : node.alpha,
    nativeClip, nativeBlur, nativeMask);
  var valueOffset = nodeIndex * nativeSceneValueStride;
  nativeSceneValues[valueOffset + 7] = localX;
  nativeSceneValues[valueOffset + 8] = localY;
  if (kind === 1) {
    var textureRotation = ((Number(texture && texture.rotate) || 0) % 16 + 16) % 16;
    if (textureRotation % 2) {
      nativeCompatibilityHit('render.texture-rotation', String(textureRotation));
      nativeSceneUnsupported = true;
      nativeSceneUnsupportedReason = 'sprite:texture-rotation';
      return;
    }
    nativeSceneMetadata[nodeIndex * nativeSceneMetadataStride + 5] |=
      textureRotation / 2 << 5;
    if (texture && texture.baseTexture && PIXI.SCALE_MODES &&
        texture.baseTexture.scaleMode === PIXI.SCALE_MODES.NEAREST) {
      nativeSceneMetadata[nodeIndex * nativeSceneMetadataStride + 5] |= 8;
    }
    // Pixi's particle renderer ignores roundPixels, and weather sprites
    // never take the flag.
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
    // RPG Maker MV's Sprite._refresh replaces the base texture with
    // _tintTexture after applying these values to a CPU canvas. Do not apply
    // the same operation again in the native shader.
    var cpuTinted = !particleContext && node._tintTexture && texture &&
      texture.baseTexture === node._tintTexture;
    if (cpuTinted && typeof nativeMaterializationStats !== 'undefined') {
      nativeMaterializationStats.cpuTintedSprites++;
    }
    var colorTone = particleContext || cpuTinted ? null : node._colorTone;
    var blendColor = particleContext || cpuTinted ? null : node._blendColor;
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
        alpha: particleValues ? particleValues.alpha : node.alpha,
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
  // ScreenSprite's Graphics child is its implementation detail. Kind 3 already
  // represents the full-screen color, and traversing the child would allocate
  // RPG Maker's intentionally oversized 6400x4800 zoom-safe rectangle.
  if (!node.children) {
    closeNativeSceneFilters(filterGroups.length, parentIndex, nativeClip);
    return;
  }
  if (typeof WindowLayer === 'function' && node instanceof WindowLayer) {
    for (var windowIndex = 0; windowIndex < node.children.length; windowIndex++) {
      var windowChild = node.children[windowIndex];
      if (windowChild && windowChild._isWindow && windowChild.visible &&
          windowChild._openness > 0) {
        // Stock clips only the clear, never window children; openness is
        // already encoded via container scale and contents visibility.
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
          (typeof pmjsOptimizationEnabled !== 'function' ||
            pmjsOptimizationEnabled('scene.plain-sprite-segment'))) {
        var segment = [];
        var segmentIndex = index;
        while (segmentIndex < childLimit &&
            nativeSceneTraversesChild(kind, node, node.children[segmentIndex])) {
          var binding = nativePlainSpriteBinding(node.children[segmentIndex]);
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

function submitNativeScene(stage) {
  resetNativeSceneRecords();
  nativeSceneFilterDepth = 0;
  nativeSceneUnsupported = false;
  nativeSceneUnsupportedReason = '';
  if (nativeSceneBackgroundColor !== null) {
    nativeSceneRecord(0xffffffff, 3, 0, nativeSceneBackgroundColor,
      0, nativeIdentityTransform, 1, null, 0, null);
  }
  writeNativeSceneNode(stage, 0xffffffff);
  if (nativeSceneUnsupported) {
    if (nativeSceneUnsupportedReason !== nativeSceneReportedReason) {
      nativeSceneReportedReason = nativeSceneUnsupportedReason;
      nativeCompatibilityHit('render.sceneFallback', nativeSceneUnsupportedReason);
    }
    return false;
  }
  traceNativeScenePacket();
  var submitStarted = globalThis.__pmjsTrace && __pmjsTrace.active() ?
    performance.now() : 0;
  NativeHost.scene.submit(nativeScenePacketVersion, nativeSceneMetadata,
    nativeSceneValues, nativeSceneCount);
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

function renderNativeStage(stage, rootTransform, filterResolution, roundPixels) {
  var profiling = typeof automationProfiling !== 'undefined' && automationProfiling;
  var stageStarted = profiling ? performance.now() : 0;
  nativeScreenOverlays.length = 0;
  nativeTileRects = 0;
  var parent = stage.parent;
  stage.parent = nativeTransformParent;
  nativeSceneRootTransform = rootTransform || nativeIdentityTransform;
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
  var submitted = false;
  try {
    if (NativeHost.scene) {
      if (newStage) renderNativeStage._tilemaps = collectNativeTilemaps(stage, []);
      submitted = submitNativeScene(stage);
    }
  } finally {
    if (profiling) {
      nativeQueueMs += performance.now() - stageStarted;
      nativeStageSamples++;
    }
    nativeSceneRootTransform = nativeIdentityTransform;
    nativeSceneFilterResolution = 1;
    nativeSceneRoundPixels = false;
    parentWorld.identity();
    stage.parent = parent;
  }
  if (submitted) {
    renderNativeStage._ready = true;
    renderNativeStage._stage = stage;
    renderNativeStage._cameraX = cameraX;
    renderNativeStage._cameraY = cameraY;
    return;
  }
  // A rejected packet cannot fall back to a traversal with different transform,
  // culling, and leaf-dispatch semantics.
  renderNativeStage._ready = true;
  renderNativeStage._stage = stage;
  renderNativeStage._cameraX = cameraX;
  renderNativeStage._cameraY = cameraY;
}
