// Semantic preparation: brings node state up to date before the scene
// writer reads it. Never writes packet records.
//
// Encoders observe; they don't advance semantics. Preparation runs here,
// once per node, ahead of translation in scene-encoders.js.
//
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
  if (typeof prepareNativeMvSceneNode === 'function') {
    prepareNativeMvSceneNode(node);
  }
  if (node.origin && node.tilePosition) {
    node.tilePosition.x = Math.round(-node.origin.x);
    node.tilePosition.y = Math.round(-node.origin.y);
  }
}
