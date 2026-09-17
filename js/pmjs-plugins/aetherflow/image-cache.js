if (typeof ImageCache !== 'undefined' && ImageCache.prototype.releaseItem &&
    !ImageCache.prototype._pmjsAetherflowImageRelease) {
  var aetherflowReleaseImage = ImageCache.prototype.releaseItem;
  ImageCache.prototype.releaseItem = function(key) {
    var item = this._items && this._items[key];
    if (item && item.bitmap && item.bitmap._image instanceof NativeImage) {
      item.bitmap._image.src = '';
    }
    return aetherflowReleaseImage.apply(this, arguments);
  };
  ImageCache.prototype._pmjsAetherflowImageRelease = true;
}
