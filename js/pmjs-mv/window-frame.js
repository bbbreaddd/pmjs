'use strict';

(function() {
  var id = 'mv.native-window-frame';

  PMJS.optimizations.install({
    id: id, owner: 'pmjs-mv', fallback: 'ordinary window frame drawing',
    phaseKey: id, install: function() {
      if (!PMJS.optimizations.isEnabled(id) || typeof Window !== 'function' || typeof Bitmap !== 'function') return;
      var original = Window.prototype._refreshFrame, blt = Bitmap.prototype.blt, dirty = Bitmap.prototype._setDirty;
      var stockBlt = ['d62410a33f685b34df420269c3bc88f7f3efba7a91a7252f1d3e684a29d5c50e'];
      var rounded = PMJS.methods.matchesSource(blt, ['8b54c7f93abf4c9d7667a00106c17de1b28e0f0f0ca8cd1df1f136b09fe1f348']);
      var predecessor = rounded && globalThis.Yanfly && Yanfly.Core && Yanfly.Core.Bitmap_blt;
      var baseBlt = rounded ? predecessor : blt;
      var engineBlt = typeof _Bitmap_blt === 'function' ? _Bitmap_blt : null;
      var nativeBlt = PMJS.methods.matchesSource(baseBlt,
        '68ab7f2fcb76a7f80eb348b7e5694dcc25e986fab28e373a05710b1c27a74f58') &&
        PMJS.methods.matchesSource(engineBlt, stockBlt);
      if (!PMJS.methods.matchesSource(original, ['304170bef387f46d3bdf26c7955162f6ef3270d5fed52ad5b0011d02ca1f9026']) || !(PMJS.methods.matchesSource(blt, stockBlt) ||
        rounded && PMJS.methods.matchesSource(predecessor, stockBlt) || nativeBlt) ||
        !PMJS.methods.matchesSource(dirty, ['4e5d20a25fdb0a359460013d9ad7850ff223be1b59bb14ebc04f710902b82344'])) {
        PMJS.optimizations.refuse(id, 'unrecognized window frame drawing'); return;
      }
      var counters = { batches: 0, rectangles: 0, fallbacks: 0 };
      PMJS.mv = PMJS.mv || {};
      PMJS.mv.windowFrame = { diagnostics: function() { return Object.assign({}, counters); } };
      Window.prototype._refreshFrame = function() {
        var w = this._width, h = this._height, skin = this._windowskin;
        if (!Number.isFinite(w) || !Number.isFinite(h) || w < 48 || h < 48 ||
            !skin || skin.width < 192 || skin.height < 96 || Bitmap.prototype.blt !== blt || nativeBlt && _Bitmap_blt !== engineBlt ||
            rounded && (!globalThis.Yanfly || !Yanfly.Core || Yanfly.Core.Bitmap_blt !== predecessor)) {
          counters.fallbacks++; return original.apply(this, arguments);
        }
        var bitmap = new Bitmap(w, h);
        this._windowFrameSprite.bitmap = bitmap;
        this._windowFrameSprite.setFrame(0, 0, w, h);
        var rectangles = [
          120,0,48,24,24,0,w-48,24,
          120,72,48,24,24,h-24,w-48,24,
          96,24,24,48,0,24,24,h-48,
          168,24,24,48,w-24,24,24,h-48,
          96,0,24,24,0,0,24,24,
          168,0,24,24,w-24,0,24,24,
          96,72,24,24,0,h-24,24,24,
          168,72,24,24,w-24,h-24,24,24
        ];
        if (rounded) rectangles = rectangles.map(Math.floor);
        bitmap._context.globalCompositeOperation = 'source-over';
        if (bitmap.blt === blt && bitmap._setDirty === dirty && PMJS.web.canvas.drawImageBatch(bitmap._context, skin._canvas, rectangles)) {
          bitmap._setDirty(); counters.batches++; counters.rectangles += 8; return;
        }
        counters.fallbacks++;
        for (var i = 0; i < rectangles.length; i += 8)
          bitmap.blt.apply(bitmap, [skin].concat(rectangles.slice(i, i + 8)));
      };
    }
  });
})();
