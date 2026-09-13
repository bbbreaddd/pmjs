function comparePmjsTilemapChildren(left, right) {
  var leftZ = left.z || 0, rightZ = right.z || 0;
  if (leftZ !== rightZ) return leftZ - rightZ;
  var leftY = left.y || 0, rightY = right.y || 0;
  if (leftY !== rightY) return leftY - rightY;
  return (left.spriteId || 0) - (right.spriteId || 0);
}

// Sort the live child array in place without allocating on already-sorted frames.
Tilemap.prototype._compareChildOrder = comparePmjsTilemapChildren;
Tilemap.prototype._sortChildren = function() {
  var children = this.children;
  var compare = this._compareChildOrder || comparePmjsTilemapChildren;
  var needsSort = false;
  for (var check = 1; check < children.length; check++) {
    if (compare.call(this, children[check - 1], children[check]) > 0) {
      needsSort = true;
      break;
    }
  }
  if (!needsSort) return;
  for (var index = 1; index < children.length; index++) {
    var child = children[index];
    var position = index;
    while (position > 0 &&
        compare.call(this, child, children[position - 1]) < 0) {
      children[position] = children[position - 1];
      position--;
    }
    children[position] = child;
  }
};

if (typeof Sprite_Base !== 'undefined' && Sprite_Base.prototype.update) {
  var originalSpriteBaseUpdate = Sprite_Base.prototype.update;
  Sprite_Base.prototype.update = function() {
    // Avoid updating Sprite_Base/Sprite_Picture without an assigned picture.
    if (this instanceof Sprite_Picture) {
      var picture = this.picture ? this.picture() : null;
      if (!picture) {
        this.visible = false;
        return;
      }
      this.visible = true;
    }
    return originalSpriteBaseUpdate.apply(this, arguments);
  };
}
