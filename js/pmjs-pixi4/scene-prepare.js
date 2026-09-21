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
function prepareNativeSceneNode(node) {
  var resolution = typeof nativeSceneFilterResolution === 'number' ?
    nativeSceneFilterResolution : 1;
  var proto = Object.getPrototypeOf(node);
  var preparation = proto && nativeScenePreparationCache.get(proto);
  if (preparation === undefined) {
    preparation = nativeScenePreparationFor(node);
    if (proto) nativeScenePreparationCache.set(proto, preparation);
  }
  if (preparation) preparation(node, resolution);
  if (typeof prepareNativeMvSceneNode === 'function') {
    prepareNativeMvSceneNode(node);
  }
  if (node.origin && node.tilePosition) {
    node.tilePosition.x = Math.round(-node.origin.x);
    node.tilePosition.y = Math.round(-node.origin.y);
  }
}
