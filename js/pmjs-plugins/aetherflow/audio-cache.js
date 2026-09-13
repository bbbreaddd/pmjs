if (typeof AudioManager !== 'undefined' && typeof NativeAudioBuffer === 'function') {
  if (AudioManager._cache && typeof AudioManager._cache.clear === 'function') {
    AudioManager._cache.clear();
  }

  if (typeof AudioManager.loadAudio === 'function') {
    var aetherflowLoadAudio = AudioManager.loadAudio;
    AudioManager.loadAudio = function(path) {
      var buffer = aetherflowLoadAudio.call(this, path);
      if (buffer && !(buffer instanceof NativeAudioBuffer)) {
        var key = this._generateCacheKey(path);
        buffer = new NativeAudioBuffer(path);
        this._cache.add(key, buffer);
      }
      return buffer;
    };
  }

  if (typeof AudioManager.reserveAudio === 'function') {
    var aetherflowReserveAudio = AudioManager.reserveAudio;
    AudioManager.reserveAudio = function(folder, filename, reservationId) {
      var buffer = aetherflowReserveAudio.apply(this, arguments);
      if (buffer && !(buffer instanceof NativeAudioBuffer) && filename) {
        var path = this._path + folder + encodeURIComponent(filename) +
          this.audioFileExt();
        buffer = new NativeAudioBuffer(path);
        this._cache.reserve(this._generateCacheKey(path), buffer,
          reservationId || this._defaultReservationId);
      }
      return buffer;
    };
  }
}
