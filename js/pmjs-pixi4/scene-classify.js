// Representation classification.
// Performs no PMJS semantic mutation and writes no packet state.
// Property access and integration hooks remain observable and must execute
// in reference order.
//
// Unknown labels keep container behavior. That is the safe default for
// custom plugin objects.

// Native translation representations, not Pixi classes: several labels can
// map to one representation (sprite, picture, and weather all encode as
// sprites).
var PMJS_SCENE_KIND = {
  CONTAINER: 0,
  SPRITE: 1,
  SCREEN_SPRITE: 2,
  TILING_SPRITE: 3,
  GRAPHICS: 4,
  MESH: 5,
  RECT_TILE_LAYER: 6,
  GENERIC: 7
};

function nativeSceneKindName(kind) {
  switch (kind) {
    case PMJS_SCENE_KIND.SPRITE: return 'sprite';
    case PMJS_SCENE_KIND.SCREEN_SPRITE: return 'screensprite';
    case PMJS_SCENE_KIND.TILING_SPRITE: return 'tilingsprite';
    case PMJS_SCENE_KIND.GRAPHICS: return 'graphics';
    case PMJS_SCENE_KIND.MESH: return 'mesh';
    case PMJS_SCENE_KIND.RECT_TILE_LAYER: return 'recttilelayer';
    case PMJS_SCENE_KIND.GENERIC: return 'generic';
    default: return 'container';
  }
}

// String-to-kind map. The caller resolves the canonical string once, so
// this adds no observable reads. GENERIC is reserved, never produced:
// unknown and explicit-container labels take the container lane today.
function nativeSceneKindForType(type) {
  switch (type) {
    case 'sprite':
    case 'picture':
    case 'weathersprite':
      return PMJS_SCENE_KIND.SPRITE;
    case 'screensprite':
      return PMJS_SCENE_KIND.SCREEN_SPRITE;
    case 'tilingsprite':
      return PMJS_SCENE_KIND.TILING_SPRITE;
    case 'graphics':
      return PMJS_SCENE_KIND.GRAPHICS;
    case 'mesh':
      return PMJS_SCENE_KIND.MESH;
    case 'tilemap':
    case 'container':
      return PMJS_SCENE_KIND.CONTAINER;
    default:
      return PMJS_SCENE_KIND.CONTAINER;
  }
}

function nativeSceneKind(node) {
  // RECT_TILE_LAYER is a classification answer, not a dispatch target: the
  // traversal pre-dispatches layers ahead of rejection, so the encoder
  // switch never receives kind 6.
  if (typeof nativeIsRectTileLayer === 'function' && nativeIsRectTileLayer(node)) {
    return PMJS_SCENE_KIND.RECT_TILE_LAYER;
  }
  return nativeSceneKindForType(nativeNodeRenderType(node));
}
