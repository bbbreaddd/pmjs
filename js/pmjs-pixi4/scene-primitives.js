// Scene-writer caches owned by pmjs-pixi4. Each ID is gated at its narrow
// cache-hit boundary below; the ordinary path re-derives the same records.
if (typeof PMJS !== 'undefined' && PMJS.optimizations &&
    typeof PMJS.optimizations.register === 'function') {
  PMJS.optimizations.register({ id: 'tilemap.persistent-layer-cache',
    owner: 'pmjs-pixi4',
    fallback: 'recompile the native tile layer every frame from live pointsBuf' });
  PMJS.optimizations.register({ id: 'scene.tiling-texture-cache',
    owner: 'pmjs-pixi4',
    fallback: 're-rasterize the tiling source canvas on every use' });
  PMJS.optimizations.register({ id: 'scene.graphics-cache', owner: 'pmjs-pixi4',
    fallback: 're-rasterize vector graphics on every use' });
  PMJS.optimizations.register({ id: 'scene.gpu-mesh-cache', owner: 'pmjs-pixi4',
    fallback: 're-upload the GPU mesh on every use' });
}

var nativeTransformParent = new PIXI.Container();
nativeTransformParent.worldAlpha = 1;
nativeTransformParent.transform.worldTransform.identity();
var nativeScreenOverlays = [];
var nativeTileRects = 0;
var nativeTileRebuilds = 0;
var nativeTransformMs = 0;
var nativeQueueMs = 0;
var nativeStageSamples = 0;
var nativeBlankTileHandle = 0;

function nativeBlankTile() {
  if (nativeBlankTileHandle) return nativeBlankTileHandle;
  var canvas = new CanvasElement();
  canvas.width = 1;
  canvas.height = 1;
  canvas.getContext('2d').clearRect(0, 0, 1, 1);
  var native = canvas._ensureNativeCanvas();
  if (!native) return 0;
  nativeBlankTileHandle = native.handle;
  return nativeBlankTileHandle;
}

function queueNativeSprite(sprite) {
  var texture = sprite.texture;
  var base = texture && texture.baseTexture;
  var source = base && base.source;
  var nativeImage = source && (source._nativeImage || source._nativeCanvas);
  var frame = texture && (texture._frame || texture.frame);
  if (!nativeImage || !frame || frame.width <= 0 || frame.height <= 0) return;

  var transform = sprite.worldTransform;
  var anchor = sprite.anchor || { x: 0, y: 0 };
  var original = texture.orig || frame;
  var trim = texture.trim;
  var localX = trim ? trim.x - anchor.x * original.width : -anchor.x * original.width;
  var localY = trim ? trim.y - anchor.y * original.height : -anchor.y * original.height;
  var tx = transform.tx + transform.a * localX + transform.c * localY;
  var ty = transform.ty + transform.b * localX + transform.d * localY;
  var resolution = Math.max(0.000001, Number(base.resolution) || 1);
  NativeHost.render.image(nativeImage.handle,
    transform.a, transform.b, transform.c, transform.d, tx, ty,
    frame.x * resolution, frame.y * resolution,
    frame.width * resolution, frame.height * resolution,
    sprite.worldAlpha, sprite.tint === undefined ? 0xffffff : sprite.tint,
    sprite.blendMode || 0);
}

function nativeRotatedTexturePoint(rotation, x, y) {
  if (rotation === 1) return [1 - y, x];
  if (rotation === 2) return [1 - x, 1 - y];
  if (rotation === 3) return [y, 1 - x];
  if (rotation === 4) return [x, 1 - y];
  if (rotation === 5) return [y, x];
  if (rotation === 6) return [1 - x, y];
  if (rotation === 7) return [1 - y, 1 - x];
  return [x, y];
}

function ensureNativeTilingTexture(texture) {
  var base = texture && texture.baseTexture;
  var source = base && base.source;
  var nativeImage = source && (source._nativeImage || source._nativeCanvas);
  var frame = texture && (texture._frame || texture.frame);
  if (!nativeImage || !frame || frame.width <= 0 || frame.height <= 0) return null;
  var rotation = ((Number(texture.rotate) || 0) % 16 + 16) % 16;
  if (rotation % 2) return null;
  var original = texture.orig || frame;
  var trim = texture.trim;
  var resolution = Math.max(0.000001, Number(base.resolution) || 1);
  var fullTexture = !rotation && !trim && frame.x === 0 && frame.y === 0 &&
    frame.width === base.width && frame.height === base.height;
  if (fullTexture) return { handle: nativeImage.handle, resolution: resolution };
  var signature = [nativeImage.handle, Number(texture._updateID) || 0,
    frame.x, frame.y, frame.width, frame.height, original.width, original.height,
    trim && trim.x, trim && trim.y, trim && trim.width, trim && trim.height,
    rotation, resolution].join(':');
  if (texture.__pmjsTilingCanvas &&
      texture.__pmjsTilingCanvasSignature === signature &&
      (typeof pmjsOptimizationEnabled !== 'function' ||
        pmjsOptimizationEnabled('scene.tiling-texture-cache'))) {
    return { handle: texture.__pmjsTilingCanvas._ensureNativeCanvas().handle,
      resolution: resolution };
  }
  var width = Math.max(1, Math.ceil(original.width * resolution));
  var height = Math.max(1, Math.ceil(original.height * resolution));
  var canvas = texture.__pmjsTilingCanvas || new CanvasElement();
  canvas.width = width;
  canvas.height = height;
  var crop = new CanvasElement();
  crop.width = Math.ceil(frame.width * resolution);
  crop.height = Math.ceil(frame.height * resolution);
  try {
    var cropContext = crop.getContext('2d');
    cropContext.drawImage(source, frame.x * resolution, frame.y * resolution,
      frame.width * resolution, frame.height * resolution,
      0, 0, crop.width, crop.height);
    var packed = cropContext.getImageData(0, 0, crop.width, crop.height).data;
    var output = new Uint8ClampedArray(width * height * 4);
    var target = trim ||
      { x: 0, y: 0, width: original.width, height: original.height };
    var targetWidth = Math.max(0, Math.ceil(target.width * resolution));
    var targetHeight = Math.max(0, Math.ceil(target.height * resolution));
    for (var y = 0; y < targetHeight; y++) for (var x = 0; x < targetWidth; x++) {
      var point = nativeRotatedTexturePoint(rotation / 2,
        (x + 0.5) / targetWidth, (y + 0.5) / targetHeight);
      var sourceX = Math.max(0, Math.min(crop.width - 1,
        Math.floor(point[0] * crop.width)));
      var sourceY = Math.max(0, Math.min(crop.height - 1,
        Math.floor(point[1] * crop.height)));
      var targetX = Math.floor((Number(target.x) || 0) * resolution) + x;
      var targetY = Math.floor((Number(target.y) || 0) * resolution) + y;
      if (targetX < 0 || targetY < 0 || targetX >= width || targetY >= height) continue;
      var sourceOffset = (sourceY * crop.width + sourceX) * 4;
      var targetOffset = (targetY * width + targetX) * 4;
      output[targetOffset] = packed[sourceOffset];
      output[targetOffset + 1] = packed[sourceOffset + 1];
      output[targetOffset + 2] = packed[sourceOffset + 2];
      output[targetOffset + 3] = packed[sourceOffset + 3];
    }
    canvas.getContext('2d').putImageData(new ImageData(output, width, height), 0, 0);
  } finally {
    crop._releaseNativeCanvas();
  }
  texture.__pmjsTilingCanvas = canvas;
  texture.__pmjsTilingCanvasSignature = signature;
  return { handle: canvas._ensureNativeCanvas().handle, resolution: resolution };
}

function queueNativeTilingSprite(sprite) {
  var texture = sprite.texture;
  var tilingTexture = ensureNativeTilingTexture(texture);
  if (!tilingTexture || sprite.width <= 0 || sprite.height <= 0) return;

  var transform = sprite.worldTransform;
  var anchor = sprite.anchor || { x: 0, y: 0 };
  var tx = transform.tx - transform.a * anchor.x * sprite.width -
    transform.c * anchor.y * sprite.height;
  var ty = transform.ty - transform.b * anchor.x * sprite.width -
    transform.d * anchor.y * sprite.height;
  var tileScale = sprite.tileScale || { x: 1, y: 1 };
  var scaleX = Math.abs(tileScale.x) > 0.000001 ? tileScale.x : 1;
  var scaleY = Math.abs(tileScale.y) > 0.000001 ? tileScale.y : 1;
  var tilingSource = nativeTilingSource(sprite, scaleX, scaleY);

  NativeHost.render.tiled(tilingTexture.handle,
    transform.a, transform.b, transform.c, transform.d, tx, ty,
    tilingSource.x * tilingTexture.resolution,
    tilingSource.y * tilingTexture.resolution,
    tilingSource.width * tilingTexture.resolution,
    tilingSource.height * tilingTexture.resolution,
    sprite.width, sprite.height, sprite.worldAlpha,
    sprite.tint === undefined ? 0xffffff : sprite.tint, sprite.blendMode || 0);
}

function nativeTilingSource(sprite, scaleX, scaleY) {
  if (sprite.origin && Number.isFinite(Number(sprite.origin.x)) &&
      Number.isFinite(Number(sprite.origin.y))) {
    return { x: Math.round(sprite.origin.x), y: Math.round(sprite.origin.y),
      width: sprite.width, height: sprite.height };
  }
  var tilePosition = sprite.tilePosition || { x: 0, y: 0 };
  return { x: -tilePosition.x / scaleX, y: -tilePosition.y / scaleY,
    width: sprite.width / scaleX, height: sprite.height / scaleY };
}

function tileAnimationOffset(layer) {
  var node = layer;
  while (node && typeof node.animationFrame !== 'number') node = node.parent;
  var frame = node ? node.animationFrame : 0;
  var tileWidth = node && node._tileWidth ? node._tileWidth : 48;
  var tileHeight = node && node._tileHeight ? node._tileHeight : 48;
  var horizontalFrame = frame % 4;
  if (horizontalFrame === 3) horizontalFrame = 1;
  return [horizontalFrame * tileWidth, (frame % 3) * tileHeight];
}

// RectTileLayer is intentionally `visible = false`: Pixi's parent
// CompositeRectTileLayer invokes its renderer directly. Read the retained
// nine-number tile records here so the native traversal preserves that
// specialized rendering contract instead of discarding the map floor.
function queueNativeRectTileLayer(layer) {
  var points = layer.pointsBuf;
  if (!points || !points.length) {
    ensureNativeRectTileLayer(layer);
    return;
  }
  var parent = layer.parent || layer;
  var transform = parent.worldTransform || layer.worldTransform;
  var animation = tileAnimationOffset(parent);
  var alpha = parent.worldAlpha === undefined ? 1 : parent.worldAlpha;
  var tint = parent.tint === undefined ? 0xffffff : parent.tint;
  var blendMode = parent.blendMode || 0;

  var layerHandle = ensureNativeRectTileLayer(layer);
  if (!layerHandle) return;

  NativeHost.render.drawTileLayer(layerHandle,
    transform.a, transform.b, transform.c, transform.d,
    transform.tx, transform.ty, animation[0], animation[1],
    alpha, tint, blendMode);
  nativeTileRects += points.length / 9;
}

function ensureNativeRectTileLayer(layer) {
  var points = layer.pointsBuf;
  var textures = layer.textures;
  if (!points || !points.length || !textures || !textures.length) {
    if (layer._pmjsNativeLayer) {
      NativeHost.render.releaseTileLayer(layer._pmjsNativeLayer);
      layer._pmjsNativeLayer = 0;
    }
    layer._pmjsNativeTextureSignature = '';
    return 0;
  }
  var generation = layer._pmjsNativeGeneration || 0;
  var handles = [];
  for (var textureIndex = 0; textureIndex < textures.length; textureIndex++) {
    var texture = textures[textureIndex];
    var textureSource = texture && texture.baseTexture && texture.baseTexture.source;
    var textureImage = textureSource &&
      (textureSource._nativeImage || textureSource._nativeCanvas);
    var textureHandle = textureImage && textureImage.handle;
    if (!textureHandle) {
      if (texture && texture.width > 1 && texture.height > 1) return 0;
      textureHandle = nativeBlankTile();
      if (!textureHandle) return 0;
    }
    handles.push(textureHandle);
  }
  var textureSignature = handles.join(':');
  // Disabled means recompile every frame from the live records: no compiled
  // generation is ever reused, while validation and texture eligibility above
  // still apply. The previously retained handle is released before replacing
  // it, so bypassing the cache cannot leak native layers.
  var usePersistentCache = typeof pmjsOptimizationEnabled !== 'function' ||
    pmjsOptimizationEnabled('tilemap.persistent-layer-cache');
  if (!usePersistentCache || !layer._pmjsNativeLayer ||
      layer._pmjsNativeCompiledGeneration !== generation ||
      layer._pmjsNativeTextureSignature !== textureSignature) {
    if (layer._pmjsNativeLayer) {
      NativeHost.render.releaseTileLayer(layer._pmjsNativeLayer);
    }
    layer._pmjsNativeLayer = NativeHost.render.createTileLayer(points, handles);
    layer._pmjsNativeCompiledGeneration = generation;
    layer._pmjsNativeTextureSignature = textureSignature;
  }
  return layer._pmjsNativeLayer;
}

function nativeIsRectTileLayer(node) {
  if (!node) return false;
  if (PIXI.tilemap && PIXI.tilemap.RectTileLayer &&
      node instanceof PIXI.tilemap.RectTileLayer) return true;
  // Tilemap plugins can replace the exported constructor after creating
  // their layers. Dispatch those retained layer records by behavior,
  // not by a stale JS prototype identity. Composite layers do not expose both
  // arrays and therefore remain containers whose children are traversed.
  return Array.isArray(node.pointsBuf) && Array.isArray(node.textures);
}

function queueNativeObject(node) {
  if (nativeIsRectTileLayer(node)) {
    queueNativeRectTileLayer(node);
    return false;
  }
  if (!node || !node.visible || !node.renderable || node.worldAlpha <= 0) return false;
  if (typeof node._openness === 'number' && node._openness <= 0) return false;
  var renderType = nativeNodeRenderType(node);
  if (renderType === 'screensprite') {
    var red = Math.max(0, Math.min(1, (node._red || 0) / 255));
    var green = Math.max(0, Math.min(1, (node._green || 0) / 255));
    var blue = Math.max(0, Math.min(1, (node._blue || 0) / 255));
    NativeHost.render.quad(
      0, 0, Graphics.width, Graphics.height, red, green, blue, node.worldAlpha);
    nativeScreenOverlays.push([
      Math.round(red * 255), Math.round(green * 255), Math.round(blue * 255),
      Math.round(node.worldAlpha * 255)
    ]);
    return false;
  }
  if (renderType === 'tilingsprite') {
    queueNativeTilingSprite(node);
  } else if (renderType === 'sprite' || renderType === 'picture' ||
      renderType === 'weathersprite') {
    queueNativeSprite(node);
  }
  return true;
}

function queueNativeTree(node) {
  if (!queueNativeObject(node) || !node.children) return;
  for (var index = 0; index < node.children.length; index++) {
    queueNativeTree(node.children[index]);
  }
}

var nativeSceneSchema = NativeHost.scene && NativeHost.scene.schema;
var nativeSceneMetadataStride = nativeSceneSchema ? nativeSceneSchema.metadataStride : 7;
var nativeSceneValueStride = nativeSceneSchema ? nativeSceneSchema.valueStride : 41;
var nativeScenePacketVersion = NativeHost.scene ? NativeHost.scene.packetVersion : 0;
if (NativeHost.scene && nativeSceneSchema &&
    (nativeSceneSchema.version !== nativeScenePacketVersion ||
     nativeSceneSchema.metadataStride !== 7 ||
     nativeSceneSchema.valueStride !== 41 ||
     !nativeSceneSchema.transactionalSubmit)) {
  throw new Error('native scene schema does not provide transactional submission');
}
var nativeSceneCapacity = 512;
var nativeSceneMetadata = new Uint32Array(
  nativeSceneCapacity * nativeSceneMetadataStride);
var nativeSceneValues = new Float32Array(
  nativeSceneCapacity * nativeSceneValueStride);
var nativeSceneCount = 0;
var nativeSceneFilterDepth = 0;
var nativeSceneUnsupported = false;
var nativeSceneUnsupportedReason = '';
var nativeSceneReportedReason = '';
var nativeSceneBackgroundColor = null;
var nativeSceneFilterAccessCache = new WeakMap();
var nativeScenePreviousMetadata = new Uint32Array(0);
var nativeScenePreviousValues = new Uint32Array(0);
var nativeScenePreviousCount = 0;
var nativeSceneNoFilters = Object.freeze([]);
var nativeSceneNoFilterPlan = Object.freeze({ blur: 0,
  groups: nativeSceneNoFilters, unsupported: false });
var nativeSceneColorIdentity = Object.freeze([
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0
]);

function growNativeScene() {
  nativeSceneCapacity *= 2;
  var metadata = new Uint32Array(nativeSceneCapacity * nativeSceneMetadataStride);
  metadata.set(nativeSceneMetadata);
  nativeSceneMetadata = metadata;
  var values = new Float32Array(nativeSceneCapacity * nativeSceneValueStride);
  values.set(nativeSceneValues);
  nativeSceneValues = values;
}

// Pixi 4's public getter slices _filters, so using it while
// visiting every node creates a defensive array that this adapter only reads.
// Preserve custom accessors, but use the pinned backing field for the standard
// Pixi prototype chain.
function nativeSceneFilters(node) {
  if (node.__pmjsNativeDirectFilters === true) return node._filters;
  if (node.__pmjsNativeDirectFilters === false) return node.filters;
  var prototype = Object.getPrototypeOf(node);
  var direct = nativeSceneFilterAccessCache.get(prototype);
  if (direct === undefined) {
    direct = true;
    var cursor = prototype;
    var pixiDescriptor = PIXI.DisplayObject &&
      Object.getOwnPropertyDescriptor(PIXI.DisplayObject.prototype, 'filters');
    while (cursor) {
      var descriptor = Object.getOwnPropertyDescriptor(cursor, 'filters');
      if (descriptor) {
        direct = !!pixiDescriptor && descriptor.get === pixiDescriptor.get &&
          descriptor.set === pixiDescriptor.set;
        break;
      }
      cursor = Object.getPrototypeOf(cursor);
    }
    nativeSceneFilterAccessCache.set(prototype, direct);
  }
  try {
    Object.defineProperty(node, '__pmjsNativeDirectFilters', {
      value: direct,
      configurable: true
    });
  } catch (_) {}
  return direct ? node._filters : node.filters;
}

function nativeScenePacketHash(metadataWords, valueWords) {
  // Two independent 32-bit streams provide a stable 64-bit diagnostic
  // identity without BigInt arithmetic in the render hot path.
  var left = 0x811c9dc5;
  var right = 0x9e3779b9;
  var index;
  for (index = 0; index < metadataWords.length; index++) {
    left = Math.imul(left ^ metadataWords[index], 0x01000193) >>> 0;
    right = Math.imul(right ^ metadataWords[index], 0x85ebca6b) >>> 0;
  }
  for (index = 0; index < valueWords.length; index++) {
    left = Math.imul(left ^ valueWords[index], 0x01000193) >>> 0;
    right = Math.imul(right ^ valueWords[index], 0xc2b2ae35) >>> 0;
  }
  return left.toString(16).padStart(8, '0') +
    right.toString(16).padStart(8, '0');
}

function traceNativeScenePacket() {
  if (!globalThis.__pmjsTrace || !__pmjsTrace.active()) return;
  var metadataLength = nativeSceneCount * nativeSceneMetadataStride;
  var valuesLength = nativeSceneCount * nativeSceneValueStride;
  var metadataWords = nativeSceneMetadata.subarray(0, metadataLength);
  var valueWords = new Uint32Array(nativeSceneValues.buffer,
    nativeSceneValues.byteOffset, valuesLength);
  var initial = nativeScenePreviousCount === 0;
  var changedMetadataRecords = 0;
  var changedValueRecords = 0;
  var changedRecords = 0;
  var firstChangedRecords = [];
  for (var record = 0; record < nativeSceneCount; record++) {
    var metadataChanged = initial || record >= nativeScenePreviousCount;
    var valuesChanged = initial || record >= nativeScenePreviousCount;
    var offset;
    if (!metadataChanged) {
      for (offset = 0; offset < nativeSceneMetadataStride; offset++) {
        var metadataIndex = record * nativeSceneMetadataStride + offset;
        if (metadataWords[metadataIndex] !==
            nativeScenePreviousMetadata[metadataIndex]) {
          metadataChanged = true;
          break;
        }
      }
      for (offset = 0; offset < nativeSceneValueStride; offset++) {
        var valueIndex = record * nativeSceneValueStride + offset;
        if (valueWords[valueIndex] !== nativeScenePreviousValues[valueIndex]) {
          valuesChanged = true;
          break;
        }
      }
    }
    if (metadataChanged) changedMetadataRecords++;
    if (valuesChanged) changedValueRecords++;
    if (metadataChanged || valuesChanged) {
      changedRecords++;
      if (firstChangedRecords.length < 8) firstChangedRecords.push(record);
    }
  }
  if (nativeScenePreviousCount > nativeSceneCount) {
    changedRecords += nativeScenePreviousCount - nativeSceneCount;
  }
  __pmjsTrace.event('scene', 'scene.packet-summary', {
    records: nativeSceneCount,
    hash: nativeScenePacketHash(metadataWords, valueWords),
    changedRecords: changedRecords,
    changedMetadataRecords: changedMetadataRecords,
    changedValueRecords: changedValueRecords,
    firstChangedRecords: firstChangedRecords
  });
  if (nativeScenePreviousMetadata.length < metadataLength) {
    nativeScenePreviousMetadata = new Uint32Array(metadataLength);
  }
  if (nativeScenePreviousValues.length < valuesLength) {
    nativeScenePreviousValues = new Uint32Array(valuesLength);
  }
  nativeScenePreviousMetadata.set(metadataWords);
  nativeScenePreviousValues.set(valueWords);
  nativeScenePreviousCount = nativeSceneCount;
}

function nativeSceneRecord(parentIndex, kind, resource, tint, blendMode,
    local, alpha, clip, blur, mask) {
  if (nativeSceneCount >= nativeSceneCapacity) growNativeScene();
  var index = nativeSceneCount++;
  var metadataOffset = index * nativeSceneMetadataStride;
  var valueOffset = index * nativeSceneValueStride;
  nativeSceneMetadata[metadataOffset] = kind;
  nativeSceneMetadata[metadataOffset + 1] = parentIndex;
  nativeSceneMetadata[metadataOffset + 2] = resource;
  nativeSceneMetadata[metadataOffset + 3] = tint;
  nativeSceneMetadata[metadataOffset + 4] = blendMode;
  nativeSceneMetadata[metadataOffset + 5] = (clip ? 1 : 0) | (blur ? 2 : 0) |
    (mask ? 4 : 0);
  nativeSceneMetadata[metadataOffset + 6] = mask ? mask.handle : 0;
  nativeSceneValues[valueOffset] = local.a;
  nativeSceneValues[valueOffset + 1] = local.b;
  nativeSceneValues[valueOffset + 2] = local.c;
  nativeSceneValues[valueOffset + 3] = local.d;
  nativeSceneValues[valueOffset + 4] = local.tx;
  nativeSceneValues[valueOffset + 5] = local.ty;
  nativeSceneValues[valueOffset + 6] = alpha;
  for (var offset = 7; offset < nativeSceneValueStride; offset++) {
    nativeSceneValues[valueOffset + offset] = 0;
  }
  if (clip) {
    nativeSceneValues[valueOffset + 17] = clip.left;
    nativeSceneValues[valueOffset + 18] = clip.top;
    nativeSceneValues[valueOffset + 19] = clip.right;
    nativeSceneValues[valueOffset + 20] = clip.bottom;
  }
  nativeSceneValues[valueOffset + 21] = blur || 0;
  if (mask) {
    nativeSceneValues.set(mask.transform, valueOffset + 22);
  }
  return index;
}

function nativeSceneFilterMarker(kind, filterKind, resource, parameters,
    parentIndex, clip) {
  var index = nativeSceneRecord(parentIndex, kind, resource || 0, 0xffffff,
    filterKind || 0, nativeIdentityTransform, 1, clip, 0, null);
  if (kind === 6 && parameters) {
    nativeSceneValues.set(parameters.slice(0, 10),
      index * nativeSceneValueStride + 7);
    nativeSceneValues.set(parameters.slice(10, 21),
      index * nativeSceneValueStride + 22);
    // Pixi's FilterManager reports logical filterArea dimensions even when
    // the backing framebuffer is resolution-scaled. Preserve that distinction
    // for native shaders instead of rewriting each filter's pixel uniforms.
    nativeSceneValues[index * nativeSceneValueStride + 33] =
      nativeSceneFilterResolution;
  }
}

function closeNativeSceneFilters(count, parentIndex, clip) {
  for (var index = count - 1; index >= 0; index--) {
    nativeSceneFilterMarker(7, 0, 0, null, parentIndex, clip);
  }
  nativeSceneFilterDepth -= count;
}

var nativeIdentityTransform = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
var nativeSceneRootTransform = nativeIdentityTransform;
var nativeSceneFilterResolution = 1;
var nativeSceneRoundPixels = false;

function nativeComposeTransform(parent, local) {
  return {
    a: parent.a * local.a + parent.c * local.b,
    b: parent.b * local.a + parent.d * local.b,
    c: parent.a * local.c + parent.c * local.d,
    d: parent.b * local.c + parent.d * local.d,
    tx: parent.a * local.tx + parent.c * local.ty + parent.tx,
    ty: parent.b * local.tx + parent.d * local.ty + parent.ty
  };
}

function nativeMaskWorldTransform(mask) {
  var chain = [];
  var current = mask;
  while (current && current !== nativeTransformParent) {
    chain.push(current);
    current = current.parent;
  }
  var world = nativeSceneRootTransform;
  for (var index = chain.length - 1; index >= 0; index--) {
    var transform = chain[index].transform;
    if (!transform) continue;
    if (typeof transform.updateLocalTransform === 'function') {
      transform.updateLocalTransform();
    }
    world = nativeComposeTransform(world,
      transform.localTransform || nativeIdentityTransform);
  }
  return world;
}

function nativeMaskWorldAlpha(mask) {
  var alpha = 1;
  var current = mask;
  while (current && current !== nativeTransformParent) {
    alpha *= current.alpha === undefined ? 1 : current.alpha;
    current = current.parent;
  }
  return alpha;
}

function nativeRectangleMask(mask) {
  if (!mask || !PIXI.Graphics || !(mask instanceof PIXI.Graphics) ||
      typeof mask.getBounds !== 'function') return null;
  var graphics = mask.graphicsData;
  var item = graphics && graphics.length === 1 ? graphics[0] : null;
  if (!item || !item.fill || item.lineWidth > 0 || item.holes && item.holes.length ||
      !item.shape || !(item.shape instanceof PIXI.Rectangle)) return null;
  var world = nativeMaskWorldTransform(mask);
  if (world && (Math.abs(world.b) > 0.000001 || Math.abs(world.c) > 0.000001)) {
    return null;
  }
  var shape = item.shape;
  var left = world.a * shape.x + world.tx;
  var right = world.a * (shape.x + shape.width) + world.tx;
  var top = world.d * shape.y + world.ty;
  var bottom = world.d * (shape.y + shape.height) + world.ty;
  if (![left, right, top, bottom].every(Number.isFinite)) return null;
  return { left: Math.min(left, right), top: Math.min(top, bottom),
    right: Math.max(left, right), bottom: Math.max(top, bottom) };
}

function appendNativeGraphicsShape(context, shape) {
  if (!shape) return false;
  if (shape.type === 0 && shape.points) {
    if (shape.points.length >= 2) context.moveTo(shape.points[0], shape.points[1]);
    for (var point = 2; point < shape.points.length; point += 2) {
      context.lineTo(shape.points[point], shape.points[point + 1]);
    }
    if (shape.closed !== false) context.closePath();
    return true;
  }
  if (shape.type === 1) {
    context.rect(shape.x, shape.y, shape.width, shape.height);
    return true;
  }
  if (shape.type === 2) {
    context.arc(shape.x, shape.y, shape.radius, 0, Math.PI * 2);
    context.closePath();
    return true;
  }
  if (shape.type === 3) {
    var segments = 32;
    for (var step = 0; step <= segments; step++) {
      var angle = step / segments * Math.PI * 2;
      var px = shape.x + Math.cos(angle) * shape.width;
      var py = shape.y + Math.sin(angle) * shape.height;
      if (!step) context.moveTo(px, py); else context.lineTo(px, py);
    }
    context.closePath();
    return true;
  }
  if (shape.type === 4) {
    var radius = Math.max(0, Math.min(shape.radius,
      Math.min(shape.width, shape.height) / 2));
    context.moveTo(shape.x + radius, shape.y);
    context.lineTo(shape.x + shape.width - radius, shape.y);
    context.arc(shape.x + shape.width - radius, shape.y + radius,
      radius, -Math.PI / 2, 0);
    context.lineTo(shape.x + shape.width, shape.y + shape.height - radius);
    context.arc(shape.x + shape.width - radius, shape.y + shape.height - radius,
      radius, 0, Math.PI / 2);
    context.lineTo(shape.x + radius, shape.y + shape.height);
    context.arc(shape.x + radius, shape.y + shape.height - radius,
      radius, Math.PI / 2, Math.PI);
    context.lineTo(shape.x, shape.y + radius);
    context.arc(shape.x + radius, shape.y + radius, radius, Math.PI, Math.PI * 1.5);
    context.closePath();
    return true;
  }
  return false;
}

function ensureNativeGraphics(graphics, maskOnly) {
  graphics.__pmjsGraphicsUnsupported = false;
  var revision = Number(graphics.dirty) || 0;
  var canvasProperty = maskOnly ? '__pmjsGraphicsMaskCanvas' : '__pmjsGraphicsCanvas';
  var revisionProperty = maskOnly ? '__pmjsGraphicsMaskRevision' :
    '__pmjsGraphicsRevision';
  if (graphics[canvasProperty] && graphics[revisionProperty] === revision &&
      (typeof pmjsOptimizationEnabled !== 'function' ||
        pmjsOptimizationEnabled('scene.graphics-cache'))) {
    return graphics[canvasProperty];
  }
  var bounds = graphics.getLocalBounds();
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
  var padding = Math.max(2, Math.ceil(graphics.boundsPadding || 0));
  var canvas = graphics[canvasProperty] || new CanvasElement();
  canvas.width = Math.max(1, Math.ceil(bounds.width) + padding * 2);
  canvas.height = Math.max(1, Math.ceil(bounds.height) + padding * 2);
  var context = canvas.getContext('2d');
  context.resetTransform();
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.globalAlpha = 1;
  context.translate(-bounds.x + padding, -bounds.y + padding);
  var data = graphics.graphicsData || [];
  for (var index = 0; index < data.length; index++) {
    var item = data[index], shape = item.shape;
    if (!shape) continue;
    context.beginPath();
    if (!appendNativeGraphicsShape(context, shape)) {
      nativeCompatibilityHit('render.graphics', 'shape=' + shape.type);
      graphics.__pmjsGraphicsUnsupported = true;
      return null;
    }
    var holes = item.holes || [];
    for (var holeIndex = 0; holeIndex < holes.length; holeIndex++) {
      var holeShape = holes[holeIndex] && (holes[holeIndex].shape || holes[holeIndex]);
      if (!appendNativeGraphicsShape(context, holeShape)) {
        nativeCompatibilityHit('render.graphics-hole',
          'shape=' + (holeShape && holeShape.type));
        graphics.__pmjsGraphicsUnsupported = true;
        return null;
      }
    }
    if (item.fill) {
      context.fillStyle = maskOnly ? '#ffffff' :
        '#' + ('000000' + (item.fillColor >>> 0).toString(16)).slice(-6);
      context.globalAlpha = maskOnly ? 1 :
        (item.fillAlpha === undefined ? 1 : item.fillAlpha);
      context.fill(holes.length ? 'evenodd' : 'nonzero');
    }
    if (item.lineWidth > 0) {
      context.strokeStyle = maskOnly ? '#ffffff' :
        '#' + ('000000' + (item.lineColor >>> 0).toString(16)).slice(-6);
      context.globalAlpha = maskOnly ? 1 :
        (item.lineAlpha === undefined ? 1 : item.lineAlpha);
      context.lineWidth = item.lineWidth;
      context.stroke();
    }
  }
  graphics[canvasProperty] = canvas;
  graphics[revisionProperty] = revision;
  canvas.__pmjsGraphicsOffsetX = bounds.x - padding;
  canvas.__pmjsGraphicsOffsetY = bounds.y - padding;
  return canvas;
}

function nativeAlphaMask(mask) {
  if (!mask || !mask.transform) return null;
  var world = nativeMaskWorldTransform(mask);
  var determinant = world.a * world.d - world.b * world.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 0.000001) return null;
  var inverse = [world.d / determinant, -world.b / determinant,
    -world.c / determinant, world.a / determinant, 0, 0];
  inverse[4] = -(inverse[0] * world.tx + inverse[2] * world.ty);
  inverse[5] = -(inverse[1] * world.tx + inverse[3] * world.ty);
  var source = null, frame = null;
  var localX = 0, localY = 0, localWidth = 0, localHeight = 0;
  if (PIXI.Graphics && mask instanceof PIXI.Graphics) {
    var canvas = ensureNativeGraphics(mask, true);
    if (canvas) {
      source = canvas._ensureNativeCanvas();
      localX = canvas.__pmjsGraphicsOffsetX;
      localY = canvas.__pmjsGraphicsOffsetY;
      localWidth = canvas.width;
      localHeight = canvas.height;
      frame = { x: 0, y: 0, width: canvas.width, height: canvas.height };
    }
  } else if (mask instanceof PIXI.Sprite) {
    var texture = mask.texture;
    var baseSource = texture && texture.baseTexture && texture.baseTexture.source;
    source = baseSource && (baseSource._nativeImage || baseSource._nativeCanvas);
    frame = texture && (texture._frame || texture.frame);
    var sourceWidth = baseSource && (baseSource.width || texture.baseTexture.width);
    var sourceHeight = baseSource && (baseSource.height || texture.baseTexture.height);
    if (!frame || !sourceWidth || !sourceHeight) return null;
    var anchor = mask.anchor || { x: 0, y: 0 };
    var original = texture.orig || frame;
    var trim = texture.trim;
    localX = trim ? trim.x - anchor.x * original.width : -anchor.x * original.width;
    localY = trim ? trim.y - anchor.y * original.height : -anchor.y * original.height;
    localWidth = trim ? trim.width : original.width;
    localHeight = trim ? trim.height : original.height;
    var maskResolution = Math.max(0.000001,
      Number(texture.baseTexture.resolution) || 1);
    frame = { x: frame.x * maskResolution, y: frame.y * maskResolution,
      width: frame.width * maskResolution,
      height: frame.height * maskResolution };
  }
  if (!source || localWidth <= 0 || localHeight <= 0) return null;
  return { handle: source.handle, transform: [
    inverse[0], inverse[1], inverse[2], inverse[3],
    inverse[4] - localX, inverse[5] - localY
  ], frame: [frame.x, frame.y, frame.width, frame.height],
    alpha: mask instanceof PIXI.Sprite ? Math.max(0, Math.min(1,
      Number(nativeMaskWorldAlpha(mask)) || 0)) : 1,
    usesRed: mask instanceof PIXI.Sprite,
    rotation: mask instanceof PIXI.Sprite ? (Number(mask.texture.rotate) || 0) : 0,
    size: [localWidth, localHeight] };
}

function ensureNativeGpuMesh(mesh) {
  var texture = mesh.texture;
  var baseTexture = texture && texture.baseTexture;
  var source = baseTexture && baseTexture.source;
  var nativeSource = source && (source._nativeImage || source._nativeCanvas);
  var vertices = mesh.vertices, uvs = mesh.uvs, indices = mesh.indices;
  if (!nativeSource || !vertices || !uvs || !indices) return 0;
  var uvTransform = mesh.uploadUvTransform && mesh._uvTransform &&
    mesh._uvTransform.mapCoord;
  var revision = [Number(mesh.dirty) || 0, Number(mesh.indexDirty) || 0,
    Number(mesh.vertexDirty) || 0, nativeSource.handle, mesh.drawMode || 0,
    texture && texture._updateID || 0, uvTransform ? 1 : 0,
    uvTransform && [uvTransform.a, uvTransform.b, uvTransform.c,
      uvTransform.d, uvTransform.tx, uvTransform.ty].join(',') || '',
    vertices.length, indices.length].join(':');
  if (mesh.__pmjsNativeMesh && mesh.__pmjsNativeMeshRevision === revision &&
      (typeof pmjsOptimizationEnabled !== 'function' ||
        pmjsOptimizationEnabled('scene.gpu-mesh-cache'))) {
    return mesh.__pmjsNativeMesh;
  }
  if (mesh.__pmjsNativeMesh) NativeHost.render.releaseMesh(mesh.__pmjsNativeMesh);
  var nativeUvs = Array.prototype.slice.call(uvs);
  if (uvTransform) {
    for (var uvIndex = 0; uvIndex < nativeUvs.length; uvIndex += 2) {
      var uvX = nativeUvs[uvIndex], uvY = nativeUvs[uvIndex + 1];
      nativeUvs[uvIndex] = uvTransform.a * uvX + uvTransform.c * uvY + uvTransform.tx;
      nativeUvs[uvIndex + 1] =
        uvTransform.b * uvX + uvTransform.d * uvY + uvTransform.ty;
    }
  }
  mesh.__pmjsNativeMesh = NativeHost.render.createMesh(nativeSource.handle,
    Array.prototype.slice.call(vertices), nativeUvs,
    Array.prototype.slice.call(indices),
    mesh.drawMode === PIXI.mesh.Mesh.DRAW_MODES.TRIANGLE_MESH);
  mesh.__pmjsNativeMeshRevision = revision;
  return mesh.__pmjsNativeMesh;
}

// Dispatch the retained filter subset by constructor name. Keep
// this escape hatch confined to that subset; optional Pixi extensions below
// still require the constructor exported by the loaded plugin bundle.
function nativeFilterMatches(filter, ctor, name) {
  if (!filter) return false;
  if (typeof ctor === 'function' && filter instanceof ctor) return true;
  if (name !== 'ToneFilter' && name !== 'ColorMatrixFilter' &&
      name !== 'DisplacementFilter' && name !== 'BlurFilter' &&
      name !== 'NoiseFilter' && name !== 'GlitchFilter') return false;
  return !!(filter.constructor && filter.constructor.name === name);
}

function nativeColorMatrixIsIdentity(values) {
  if (!values || values.length !== nativeSceneColorIdentity.length) return false;
  for (var index = 0; index < nativeSceneColorIdentity.length; index++) {
    if (Math.abs(values[index] - nativeSceneColorIdentity[index]) > 0.000001) {
      return false;
    }
  }
  return true;
}
