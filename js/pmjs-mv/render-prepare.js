function prepareNativeMvSceneNode(node) {
  if (typeof Window === 'function' && node instanceof Window) {
    node._updateCursor();
    node._updateArrows();
    node._updatePauseSign();
    node._updateContents();
  }
  if (typeof Tilemap === 'function' && node instanceof Tilemap) {
    var ox = node.roundPixels ? Math.floor(node.origin.x) : node.origin.x;
    var oy = node.roundPixels ? Math.floor(node.origin.y) : node.origin.y;
    var startX = Math.floor((ox - node._margin) / node._tileWidth);
    var startY = Math.floor((oy - node._margin) / node._tileHeight);
    node._updateLayerPositions(startX, startY);
    var animationChanged = node._lastAnimationFrame !== undefined &&
      node._lastAnimationFrame !== node.animationFrame;
    var indexedAnimation = node._pmjsIndexedAnimation === true &&
      typeof node._paintAnimTiles === 'function';
    var fullRepaint = node._needsRepaint ||
      node._lastStartX !== startX || node._lastStartY !== startY;
    if (fullRepaint || (!indexedAnimation && animationChanged)) {
      if (node._lastAnimationFrame !== undefined) {
        node._frameUpdated = animationChanged;
        node._lastAnimationFrame = node.animationFrame;
      }
      node._lastStartX = startX;
      node._lastStartY = startY;
      node._paintAllTiles(startX, startY);
      node._needsRepaint = false;
      nativeTileRebuilds++;
    } else if (indexedAnimation) {
      if (node._lastAnimationFrame !== undefined) {
        node._frameUpdated = animationChanged;
        node._lastAnimationFrame = node.animationFrame;
      }
      if (node._needsAnimRepaint && node._pmjsChangedAnimKeys) {
        var pending = node._pmjsChangedAnimKeys;
        node._pmjsChangedAnimKeys = null;
        node._needsAnimRepaint = false;
        node._paintAnimTiles(pending);
      }
    }
    node._sortChildren();
  }
}
