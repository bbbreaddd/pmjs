'use strict';
(function() {
  var id = 'omori.empty-picture-sprites';
  PMJS.optimizations.register({ id:id, owner:'pmjs-omori', fallback:'ordinary picture sprite updates' });
  PMJS.phases.on('afterGuestPlugins', id, function() {
    if (!PMJS.optimizations.isEnabled(id)) return;
    var original = Sprite_Picture.prototype.update, skipped = 0;
    Sprite_Picture.prototype.update = function() {
      if (this.constructor === Sprite_Picture && !this.visible && this.bitmap === null &&
          this._pictureName === '' && !this.picture() && !this.children.length &&
          !this._horrorFiltersSource && !Object.keys(this._horrorFilters || {}).length &&
          !(this.filters && this.filters.length)) {
        skipped++;
        return;
      }
      return original.apply(this, arguments);
    };
    PMJS.omoriEmptyPictureSprites = { diagnostics:function() { return { skipped:skipped }; } };
  });
})();
