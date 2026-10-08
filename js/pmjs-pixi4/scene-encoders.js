PMJS.pixi4.sceneEncoding = (function() {
function createEmission() {
  return { kind: 0, resource: 0, tint: 0xffffff, texture: null,
  frame: null, nativeImage: null, source: null, localX: 0, localY: 0,
  destWidth: 0, destHeight: 0, tilingResolution: 1, sampledBaseTexture: null,
  roundPixelsEligible: false, aborted: false };
}

function resetEmission(scratch, tint) {
  scratch.kind = 0;
  scratch.resource = 0;
  scratch.tint = tint;
  scratch.texture = null;
  scratch.frame = null;
  scratch.nativeImage = null;
  scratch.source = null;
  scratch.localX = 0;
  scratch.localY = 0;
  scratch.destWidth = 0;
  scratch.destHeight = 0;
  scratch.tilingResolution = 1;
  scratch.sampledBaseTexture = null;
  scratch.roundPixelsEligible = false;
  scratch.aborted = false;
}

function writeNativeSceneContainer(node, type, particleContext, particleValues,
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

  var nativeImage = nativeTextureSource(source);
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

}

function writeNativeSceneTilingSprite(node, type, particleContext,
    particleValues, scratch, schema) {
  var texture = node.texture;
  var matrix = node.tileTransform && node.tileTransform.localTransform;
  var finiteSampling = matrix && ['a', 'b', 'c', 'd', 'tx', 'ty'].every(function(key) {
    return Number.isFinite(matrix[key]);
  });
  if (!finiteSampling || matrix.a === 0 || matrix.d === 0) return;
  var resolution = Math.max(0.000001,
    Number(texture && texture.baseTexture && texture.baseTexture.resolution) || 1);
  var sampling = nativeTilingSource(node, matrix.a, matrix.d);
  if (!['x', 'y', 'width', 'height'].every(function(key) {
    return Number.isFinite(Math.fround(sampling[key] * resolution));
  })) return;
  if (matrix.b !== 0 || matrix.c !== 0) {
    PMJS.compat.hit('render.tiling-transform', 'rotated or skewed sampling');
    scratch.aborted = true;
    return;
  }
  var uv = node.uvTransform;
  if (uv && (uv.clampMargin !== 0.5 || uv.clampOffset !== 0)) {
    PMJS.compat.hit('render.tiling-clamp', 'custom clamp parameters');
    scratch.aborted = true;
    return;
  }
  if (texture && !nativeSimpleTilingTexture(texture) && !schema.clampedTilingSampling) {
    PMJS.compat.hit('render.tiling-clamp', 'host lacks clamped tiling sampling');
    scratch.aborted = true;
    return;
  }
  var tilingRotation = ((Number(texture && texture.rotate) || 0) % 16 + 16) % 16;
  if (tilingRotation % 2) {
    PMJS.compat.hit('render.texture-rotation', String(tilingRotation));
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
    PMJS.compat.hit('render.graphics',
      (node.constructor && node.constructor.name || 'Graphics') + ':graphics');
    scratch.aborted = true;
  }
}

function writeNativeSceneMesh(node, type, particleContext, particleValues,
    scratch) {
  var meshHandle = ensureNativeGpuMesh(node);
  if (!meshHandle) {
    PMJS.compat.hit('render.mesh',
      (node.constructor && node.constructor.name || 'node') + ':mesh');
    scratch.aborted = true;
    return;
  }
  scratch.kind = 8;
  scratch.resource = meshHandle;
  scratch.texture = node.texture;
}

var nativeSceneEncoders = [];
nativeSceneEncoders[PMJS_SCENE_KIND.CONTAINER] = writeNativeSceneContainer;
nativeSceneEncoders[PMJS_SCENE_KIND.SPRITE] = writeNativeSceneSprite;
nativeSceneEncoders[PMJS_SCENE_KIND.SCREEN_SPRITE] = writeNativeSceneScreenSprite;
nativeSceneEncoders[PMJS_SCENE_KIND.TILING_SPRITE] = writeNativeSceneTilingSprite;
nativeSceneEncoders[PMJS_SCENE_KIND.GRAPHICS] = writeNativeSceneGraphics;
nativeSceneEncoders[PMJS_SCENE_KIND.MESH] = writeNativeSceneMesh;

function encode(kind, node, type, particleContext, particleValues, scratch, tint, schema) {
  resetEmission(scratch, tint);
  nativeSceneEncoders[kind](node, type, particleContext, particleValues, scratch, schema);
}
return { createEmission: createEmission, encode: encode };
})();
