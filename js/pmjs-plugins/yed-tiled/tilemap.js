function compareYedTiledChildren(left, right) {
  var order = comparePmjsTilemapChildren(left, right);
  if ((left.z || 0) !== (right.z || 0) || (left.y || 0) !== (right.y || 0)) {
    return order;
  }
  var priority = (left.priority || 0) - (right.priority || 0);
  return priority || order;
}

if (typeof TiledTilemap === 'function') {
  TiledTilemap.prototype._compareChildOrder = compareYedTiledChildren;
}
