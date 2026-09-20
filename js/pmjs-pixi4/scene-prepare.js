function prepareNativeSceneNode(node) {
  if (typeof PMJS !== 'undefined' && PMJS.rendererContracts) {
    var resolution = typeof nativeSceneFilterResolution === 'number' ?
      nativeSceneFilterResolution : 1;
    PMJS.rendererContracts.prepare(node, resolution);
  }
  if (typeof prepareNativeMvSceneNode === 'function') {
    prepareNativeMvSceneNode(node);
  }
  if (node.origin && node.tilePosition) {
    node.tilePosition.x = Math.round(-node.origin.x);
    node.tilePosition.y = Math.round(-node.origin.y);
  }
}

