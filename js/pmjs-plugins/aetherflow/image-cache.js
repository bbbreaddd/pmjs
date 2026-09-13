if (typeof ImageCache !== 'undefined' && ImageCache.prototype.releaseItem) {
  var aetherflowReleaseImage = ImageCache.prototype.releaseItem;
  ImageCache.prototype.releaseItem = function(key) {
    var item = this._items && this._items[key];
    if (item && item.bitmap && item.bitmap._image instanceof NativeImage) {
      item.bitmap._image.src = '';
    }
    return aetherflowReleaseImage.apply(this, arguments);
  };
}
