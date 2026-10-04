var pmjsAudio = PMJS.rpgmaker.audio;

function MzNativeWebAudio(url, intent) {
  this._url = String(url || '');
  this._voice = pmjsAudio.createVoice(intent, { equalPowerPan: true, absoluteGain: 1 });
  this._loadListeners = [];
  this._stopListeners = [];
  this._playGeneration = 0;
  this._isPlaying = false;
  this._loop = false;
  this.name = '';
  this.frameCount = 0;

  this._gainNode = this;
  this.gain = this;

  this._startSource();
}

MzNativeWebAudio.prototype._startSource = function() {
  var self = this;
  this._voice.onInstalled = function() {
    var listeners = self._loadListeners.splice(0);
    for (var index = 0; index < listeners.length; index++) listeners[index]();
  };

  this._voice.loadSource(this._url, function(path) {
    if (typeof Utils === 'undefined' || typeof Utils.hasEncryptedAudio !== 'function' ||
        !Utils.hasEncryptedAudio()) return null;
    return { path: path + '_', decrypt: function(bytes) {
      return Utils.decryptArrayBuffer(bytes);
    } };
  });
};

Object.defineProperties(MzNativeWebAudio.prototype, {
  url: {
    get: function() { return this._url; },
    configurable: true
  },
  volume: {
    get: function() { return this._voice.volume; },
    set: function(value) {
      this._voice.volume = Number(value);
      this._voice.setAbsoluteGain(this._voice.volume);
    },
    configurable: true
  },
  pitch: {
    get: function() { return this._voice.pitch; },
    set: function(value) {
      value = Number(value);
      if (this._voice.pitch !== value) {
        this._voice.pitch = value;
        this._voice.applyParameters();
        if (this.isPlaying()) this.play(this._loop, 0);
      }
    },
    configurable: true
  },
  pan: {
    get: function() { return this._voice.pan; },
    set: function(value) {
      this._voice.pan = Number(value);
      this._voice.applyParameters();
    },
    configurable: true
  }
});

MzNativeWebAudio.prototype.setValueAtTime = function(value) {
  this._voice.setAbsoluteGain(value);
};

MzNativeWebAudio.prototype.linearRampToValueAtTime = function(value, endTime) {
  var duration = Math.max(0, Number(endTime - pmjsAudio.now()) || 0);
  this._voice.setAbsoluteGain(value, duration);
};

MzNativeWebAudio.prototype.isReady = function() {
  return !!this._voice.handle;
};

MzNativeWebAudio.prototype.isError = function() {
  return this._voice.error;
};

MzNativeWebAudio.prototype.isPlaying = function() {
  return this._isPlaying;
};

MzNativeWebAudio.prototype.play = function(loop, offset) {
  ++this._playGeneration;
  this._loop = !!loop;
  this._isPlaying = true;
  this._voice.absoluteGain = this._voice.volume;
  this._voice.play(this._loop, Math.max(0, Number(offset) || 0));
  pmjsAudio.track(this);
};

MzNativeWebAudio.prototype.stop = function() {
  this._isPlaying = false;
  this._voice.stop();
  this._loadListeners.length = 0;
  this._drainStop();
};

MzNativeWebAudio.prototype.destroy = function() {
  this.clear();
};

MzNativeWebAudio.prototype.clear = function() {
  this.stop();
  this._voice.resetForClear({ absoluteGain: 1 });
  this._isPlaying = false;
  this._loop = false;
  this._loadListeners.length = 0;
  this._stopListeners.length = 0;
};

MzNativeWebAudio.prototype.retry = function() {
  this._voice.resetForReload();
  this._startSource();
};

MzNativeWebAudio.prototype.seek = function() {
  return this._voice.position();
};

MzNativeWebAudio.prototype.fadeIn = function(duration) {
  if (this.isReady()) {
    this._voice.fadeIn(duration);
  } else {
    var self = this;
    this.addLoadListener(function() { self.fadeIn(duration); });
  }
};

MzNativeWebAudio.prototype.fadeOut = function(duration) {
  this._isPlaying = false;
  this._loadListeners.length = 0;
  this._voice.cancelPending();
  this._voice.setAbsoluteGain(this._voice.volume);
  this._voice.setAbsoluteGain(0, duration);
};

MzNativeWebAudio.prototype.addLoadListener = function(listener) {
  if (typeof listener === 'function') this._loadListeners.push(listener);
};

MzNativeWebAudio.prototype.addStopListener = function(listener) {
  if (typeof listener === 'function') this._stopListeners.push(listener);
};

MzNativeWebAudio.prototype._drainStop = function() {
  var listeners = this._stopListeners.splice(0);
  for (var index = 0; index < listeners.length; index++) listeners[index]();
};

MzNativeWebAudio.prototype._poll = function() {
  if (this._voice.loading) return true;
  if (this._voice.error) return this._isPlaying;
  var status = this._voice.pollNative();
  if (status === 'stopped') {
    this._isPlaying = false;
    this._drainStop();
    return false;
  }
  if (status === 'playing' && !this._isPlaying && this._stopListeners.length === 0) {
    return false;
  }
  return status === 'playing' || this._isPlaying;
};

MzNativeWebAudio._currentTime = function() {
  return pmjsAudio.now();
};
Object.defineProperty(MzNativeWebAudio, '_masterVolume', {
  get: function() { return pmjsAudio.masterVolume; },
  set: function(value) { pmjsAudio.setMasterVolume(value); },
  configurable: true
});
MzNativeWebAudio.initialize = function() { return true; };
MzNativeWebAudio.setMasterVolume = function(value) {
  pmjsAudio.setMasterVolume(value);
};

if (NativeHost.media) {
  globalThis.WebAudio = MzNativeWebAudio;
  AudioManager.createBuffer = function(folder, name) {
    var url = this._path + folder + Utils.encodeURI(name) + this.audioFileExt();
    var buffer = new MzNativeWebAudio(url, pmjsAudio.intentForFolder(folder));
    buffer.name = name;
    buffer.frameCount = Graphics.frameCount;
    return buffer;
  };
  SceneManager.initAudio = function() {};
}
