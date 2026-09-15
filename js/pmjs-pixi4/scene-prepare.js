// Semantic preparation: brings node state up to date before the scene
// writer reads it. Never writes packet records.
//
// Encoders observe; they don't advance semantics. Preparation runs here,
// once per node, ahead of translation in scene-encoders.js.
//
// Follow-up: Window and Tilemap preparation is MV-owned, not Pixi-owned.
// Once this split is stable it should move to pmjs-mv, leaving pmjs-pixi4
// as Pixi behavior plus native adaptation. Not moved now: ownership repair
// stays separate from restructuring.

function prepareNativeSceneNode(node) {
  if (PIXI.Text && node instanceof PIXI.Text &&
      typeof node.updateText === 'function') {
    node.updateText(true);
  }
  if (PIXI.extras && PIXI.extras.BitmapText &&
      node instanceof PIXI.extras.BitmapText &&
      typeof node.validate === 'function') {
    node.validate();
  }
  if (PIXI.mesh && PIXI.mesh.Mesh && node instanceof PIXI.mesh.Mesh &&
      typeof node.refresh === 'function') {
    node.refresh();
  }
  if (typeof Window === 'function' && node instanceof Window) {
    node._updateCursor();
    node._updateArrows();
    node._updatePauseSign();
    node._updateContents();
  }
  if (node instanceof Tilemap) {
    var ox = node.roundPixels ? Math.floor(node.origin.x) : node.origin.x;
    var oy = node.roundPixels ? Math.floor(node.origin.y) : node.origin.y;
    var startX = Math.floor((ox - node._margin) / node._tileWidth);
    var startY = Math.floor((oy - node._margin) / node._tileHeight);
    node._updateLayerPositions(startX, startY);
    var animationChanged = node._lastAnimationFrame !== undefined &&
      node._lastAnimationFrame !== node.animationFrame;
    if (node._needsRepaint || animationChanged ||
        node._lastStartX !== startX || node._lastStartY !== startY) {
      if (node._lastAnimationFrame !== undefined) {
        node._frameUpdated = animationChanged;
        node._lastAnimationFrame = node.animationFrame;
      }
      node._lastStartX = startX;
      node._lastStartY = startY;
      node._paintAllTiles(startX, startY);
      node._needsRepaint = false;
      nativeTileRebuilds++;
    }
    if (node._pmjsSortDirty) node._sortChildren();
  }
  if (node.origin && node.tilePosition) {
    node.tilePosition.x = Math.round(-node.origin.x);
    node.tilePosition.y = Math.round(-node.origin.y);
  }
}
