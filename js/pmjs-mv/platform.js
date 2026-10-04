Utils.canReadGameFiles = function() { return true; };

PMJS.methods.wrap({
  key: 'Graphics._onTouchEnd',
  id: 'pmjs.mv.video-input-unlock',
  getTarget: function() { return typeof Graphics !== 'undefined' ? Graphics : null; },
  method: '_onTouchEnd',
  wrap: function(guestTouchEnd) {
    return function() {
      // Native playback has no browser autoplay lock to release on first input.
      this._videoUnlocked = true;
      return guestTouchEnd.apply(this, arguments);
    };
  }
});
