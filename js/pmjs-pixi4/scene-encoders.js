var nativeSceneEmission = { kind: 0, resource: 0, tint: 0xffffff, texture: null,
  frame: null, nativeImage: null, source: null, localX: 0, localY: 0,
  destWidth: 0, destHeight: 0, tilingResolution: 1, sampledBaseTexture: null,
  roundPixelsEligible: false, aborted: false };

function resetNativeSceneEmission(tint) {
  nativeSceneEmission.kind = 0;
  nativeSceneEmission.resource = 0;
  nativeSceneEmission.tint = tint;
  nativeSceneEmission.texture = null;
  nativeSceneEmission.frame = null;
  nativeSceneEmission.nativeImage = null;
  nativeSceneEmission.source = null;
  nativeSceneEmission.localX = 0;
  nativeSceneEmission.localY = 0;
  nativeSceneEmission.destWidth = 0;
  nativeSceneEmission.destHeight = 0;
  nativeSceneEmission.tilingResolution = 1;
  nativeSceneEmission.sampledBaseTexture = null;
  nativeSceneEmission.roundPixelsEligible = false;
  nativeSceneEmission.aborted = false;
}

function writeNativeSceneContainer(node, type, particleContext, particleValues,
    scratch) {

}

function writeNativeSceneGeneric(node, type, particleContext, particleValues,
    scratch) {

}

function writeNativeSceneSprite(node, type, particleContext, particleValues,
    scratch) {

  scratch.roundPixelsEligible = type === 'sprite' || type === 'picture';
  var texture = particleValues ? particleValues.texture : node.texture;
  var sampledBaseTexture = particleContext && particleContext.baseTexture ||
    texture && texture.baseTexture;
  scratch.sampledBaseTexture = sampledBaseTexture;
  var source = sampledBaseTexture && sampledBaseTexture.source;
  scratch.source = source;

  var nativeImage = source && (source._nativeImage || source._nativeCanvas ||
    typeof source._ensureNativeCanvas === 'function' &&
      source._ensureNativeCanvas());
  var frame = texture && (texture._frame || texture.frame);
  if (nativeImage && frame && frame.width > 0 && frame.height > 0) {
    scratch.kind = 1;
    scratch.resource = nativeImage.handle;
    var anchor = particleValues ?
      { x: particleValues.anchorX, y: particleValues.anchorY } :
      (node.anchor || { x: 0, y: 0 });
    var original = texture.orig || frame;
    var trim = texture.trim;
    scratch.localX = trim ? trim.x - anchor.x * original.width :
      -anchor.x * original.width;
    scratch.localY = trim ? trim.y - anchor.y * original.height :
      -anchor.y * original.height;
    scratch.destWidth = trim ? trim.width : original.width;
    scratch.destHeight = trim ? trim.height : original.height;
  }
  scratch.texture = texture;
  scratch.frame = frame;
  scratch.nativeImage = nativeImage;
}

function writeNativeSceneScreenSprite(node, type, particleContext,
    particleValues, scratch) {
  scratch.kind = 3;
  scratch.tint = ((node._red || 0) << 16) | ((node._green || 0) << 8) |
    (node._blue || 0);
  nativeScreenOverlays.push([
    node._red || 0, node._green || 0, node._blue || 0,
    Math.round(node.alpha * 255)
  ]);
}

function writeNativeSceneTilingSprite(node, type, particleContext,
    particleValues, scratch) {
  var texture = node.texture;
  var tilingRotation = ((Number(texture && texture.rotate) || 0) % 16 + 16) % 16;
  if (tilingRotation % 2) {
    rejectNativeScene(node, 'render.texture-rotation', tilingRotation,
      'tiling-sprite:texture-rotation');
    scratch.aborted = true;
    return;
  }
  var tilingTexture = ensureNativeTilingTexture(texture);
  if (tilingTexture && node.width > 0 && node.height > 0) {
    scratch.nativeImage = tilingTexture;
    scratch.tilingResolution = tilingTexture.resolution;
    scratch.kind = 2;
    scratch.resource = tilingTexture.handle;
    var tilingAnchor = node.anchor || { x: 0, y: 0 };
    scratch.localX = -tilingAnchor.x * node.width;
    scratch.localY = -tilingAnchor.y * node.height;
    scratch.destWidth = node.width;
    scratch.destHeight = node.height;
  }
  scratch.texture = texture;
}

function writeNativeSceneGraphics(node, type, particleContext, particleValues,
    scratch) {
  var graphicsCanvas = ensureNativeGraphics(node);
  if (graphicsCanvas) {
    var nativeImage = graphicsCanvas._ensureNativeCanvas();
    scratch.kind = 1;
    scratch.resource = nativeImage.handle;
    scratch.nativeImage = nativeImage;
    scratch.localX = graphicsCanvas.__pmjsGraphicsOffsetX;
    scratch.localY = graphicsCanvas.__pmjsGraphicsOffsetY;
    var frame = { x: 0, y: 0, width: graphicsCanvas.width,
      height: graphicsCanvas.height };
    scratch.frame = frame;
    scratch.destWidth = frame.width;
    scratch.destHeight = frame.height;
  } else if (node.__pmjsGraphicsUnsupported) {
    rejectNativeScene(node, 'render.graphics', type,
      (node.constructor && node.constructor.name || 'Graphics') + ':graphics');
    scratch.aborted = true;
  }
}

function writeNativeSceneMesh(node, type, particleContext, particleValues,
    scratch) {
  var meshHandle = ensureNativeGpuMesh(node);
  if (!meshHandle) {
    rejectNativeScene(node, 'render.mesh', type,
      (node.constructor && node.constructor.name || 'node') + ':mesh');
    scratch.aborted = true;
    return;
  }
  scratch.kind = 8;
  scratch.resource = meshHandle;
  scratch.texture = node.texture;
}

function writeNativeSceneRectTileLayer(node, parentIndex) {
  var layerHandle = ensureNativeRectTileLayer(node);
  if (!layerHandle) return;
  var layerParent = node.parent || node;
  var layerIndex = nativeSceneRecord(parentIndex, 4, layerHandle,
    layerParent.tint === undefined ? 0xffffff : layerParent.tint,
    layerParent.blendMode || 0, nativeIdentityTransform, 1, null, 0, null);
  var layerValues = layerIndex * nativeSceneValueStride;
  var animation = tileAnimationOffset(layerParent);
  nativeSceneValues[layerValues + 15] = animation[0];
  nativeSceneValues[layerValues + 16] = animation[1];
  nativeTileRects += node.pointsBuf.length / 9;
}

var nativeSceneEncoders = [];
nativeSceneEncoders[PMJS_SCENE_KIND.CONTAINER] = writeNativeSceneContainer;
nativeSceneEncoders[PMJS_SCENE_KIND.SPRITE] = writeNativeSceneSprite;
nativeSceneEncoders[PMJS_SCENE_KIND.SCREEN_SPRITE] = writeNativeSceneScreenSprite;
nativeSceneEncoders[PMJS_SCENE_KIND.TILING_SPRITE] = writeNativeSceneTilingSprite;
nativeSceneEncoders[PMJS_SCENE_KIND.GRAPHICS] = writeNativeSceneGraphics;
nativeSceneEncoders[PMJS_SCENE_KIND.MESH] = writeNativeSceneMesh;
nativeSceneEncoders[PMJS_SCENE_KIND.GENERIC] = writeNativeSceneGeneric;

function writeNativeSceneKind(kind, node, type, particleContext,
    particleValues) {
  return nativeSceneEncoders[kind](node, type, particleContext,
    particleValues, nativeSceneEmission);
}

