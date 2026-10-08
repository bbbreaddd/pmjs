PMJS.pixi4.scenePreparation = (function() {
var nativeScenePreparationCache = new WeakMap();
function nativeScenePreparationFor(node) {
  if (PIXI.extras && PIXI.extras.BitmapText &&
      node instanceof PIXI.extras.BitmapText) {
    return function(target) {
      if (typeof target.validate === 'function') target.validate();
    };
  }
  if (PIXI.Text && node instanceof PIXI.Text) {
    return function(target, resolution) {
      if (target.resolution !== resolution) {
        target.resolution = resolution;
        target.dirty = true;
      }
      if (typeof target.updateText === 'function') target.updateText(true);
    };
  }
  if (PIXI.mesh && PIXI.mesh.Mesh && node instanceof PIXI.mesh.Mesh) {
    return function(target) {
      if (typeof target.refresh === 'function') target.refresh();
    };
  }
  return null;
}
function nativeScenePreparation(node) {
  var proto = Object.getPrototypeOf(node);
  var preparation = proto && nativeScenePreparationCache.get(proto);
  if (preparation === undefined) {
    preparation = nativeScenePreparationFor(node);
    if (proto) nativeScenePreparationCache.set(proto, preparation);
  }
  return preparation;
}
function prepareNativeSceneNode(node, resolution) {
  resolution = typeof resolution === 'number' ? resolution : 1;
  var preparation = nativeScenePreparation(node);
  if (preparation) preparation(node, resolution);
  if (typeof prepareNativeMvSceneNode === 'function') {
    prepareNativeMvSceneNode(node);
  }
  if (node.origin && node.tilePosition) {
    node.tilePosition.x = Math.round(-node.origin.x);
    node.tilePosition.y = Math.round(-node.origin.y);
  }
  if (PIXI.extras && node instanceof PIXI.extras.TilingSprite && node.tileTransform &&
      typeof node.tileTransform.updateLocalTransform === 'function') {
    node.tileTransform.updateLocalTransform();
  }
}

return { forNode: nativeScenePreparation, prepare: prepareNativeSceneNode };
})();
