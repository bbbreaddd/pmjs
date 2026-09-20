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

  if (typeof nativeIsRectTileLayer === 'function' && nativeIsRectTileLayer(node)) {
    return PMJS_SCENE_KIND.RECT_TILE_LAYER;
  }
  return nativeSceneKindForType(nativeNodeRenderType(node));
}

