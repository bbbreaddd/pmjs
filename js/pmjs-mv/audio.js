var pmjsAudio = PMJS.rpgmaker.audio;

function MvNativeWebAudio(url) {
  this._url = String(url || '');
  this._voice = pmjsAudio.createVoice();
  this._loadListeners = [];
  this._stopListeners = [];
  this._playGeneration = 0;

  this._gainNode = this;
  this.gain = this;

  var path = pmjsAudio.resolvePath(this._url);
  var self = this;
  this._voice.onInstalled = function() {
    var listeners = self._loadListeners.splice(0);
    for (var index = 0; index < listeners.length; index++) listeners[index]();
  };

  if (NativeHost.media && pmjsAudio.isObjectUrl(this._url)) {
    this._voice.loadObjectUrl(this._url);
  } else if (NativeHost.media && path && typeof Decrypter !== 'undefined' &&
      Decrypter.hasEncryptedAudio) {
    this._voice.fetchEncrypted(Decrypter.extToEncryptExt(path), function(bytes) {
      return Decrypter.decryptArrayBuffer(bytes);
    });
  } else if (NativeHost.media && path) {
    this._voice.loadPath(path);
  }
}

Object.defineProperties(MvNativeWebAudio.prototype, {
  url: {
    get: function() { return this._url; },
    configurable: true
  },
  volume: {
    get: function() { return this._voice.volume; },
    set: function(value) {
      this._voice.volume = Number(value);
      this._voice.applyParameters();
    },
    configurable: true
  },
  pitch: {
    get: function() { return this._voice.pitch; },
    set: function(value) {
      this._voice.pitch = Number(value);
      this._voice.applyParameters();
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
  },
  value: {
    get: function() { return this._voice.volume; },
    set: function(value) {
      this._voice.volume = Number(value);
      this._voice.applyParameters();
    },
    configurable: true
  },
  _autoPlay: {
    get: function() { return this._voice.autoPlay; },
    set: function(value) { this._voice.autoPlay = value; },
    configurable: true
  }
});

MvNativeWebAudio.prototype.setValueAtTime = function(value) {
  this.volume = value;
};

MvNativeWebAudio.prototype.linearRampToValueAtTime = function(value, endTime) {
  var duration = Math.max(0, Number(endTime - pmjsAudio.now()) || 0);
  this._voice.fadeTo(value, duration);
};

MvNativeWebAudio.prototype.isReady = function() {
  return !this._voice.loading && !this._voice.error &&
    (!!this._voice.handle || !NativeHost.media);
};

MvNativeWebAudio.prototype.isError = function() {
  return this._voice.error;
};

MvNativeWebAudio.prototype.isPlaying = function() {
  return this._voice.nativePlaying();
};

MvNativeWebAudio.prototype.bufferSize = function() {
  return this._voice.handle ? MvNativeWebAudio._cacheSize : 0;
};

MvNativeWebAudio.prototype.play = function(loop, offset) {
  ++this._playGeneration;
  this._voice.play(loop, offset);
  pmjsAudio.track(this);
};

MvNativeWebAudio.prototype.stop = function() {
  this._voice.stop();
  this._drainStop();
};

MvNativeWebAudio.prototype.clear = function() {
  this.stop();
  this._voice.release();
  this._loadListeners.length = 0;
  this._stopListeners.length = 0;
};

MvNativeWebAudio.prototype._fadeTo = function(volume, duration) {
  this._voice.fadeTo(volume, duration);
};

MvNativeWebAudio.prototype.seek = function() {
  return this._voice.position();
};

MvNativeWebAudio.prototype.fadeIn = function(duration) {
  this._voice.fadeIn(duration);
};

MvNativeWebAudio.prototype.fadeOut = function(duration) {
  this._voice.cancelPending();
  this._voice.fadeTo(0, duration, true);
};

MvNativeWebAudio.prototype.addLoadListener = function(listener) {
  if (typeof listener !== 'function') return;
  if (this.isReady()) listener();
  else if (!this._voice.error) this._loadListeners.push(listener);
};

MvNativeWebAudio.prototype.addStopListener = function(listener) {
  if (typeof listener === 'function') this._stopListeners.push(listener);
};

MvNativeWebAudio.prototype._drainStop = function() {
  var listeners = this._stopListeners.splice(0);
  for (var index = 0; index < listeners.length; index++) listeners[index]();
};

MvNativeWebAudio.prototype._poll = function() {
  var status = this._voice.pollNative();
  if (status === 'loading') return true;
  if (status === 'stopped') {
    this._drainStop();
    return this._voice.nativePlaying();
  }
  return status === 'playing';
};

MvNativeWebAudio._context = pmjsAudio.clock;
MvNativeWebAudio._masterGainNode = {
  gain: {
    setValueAtTime: function() {},
    linearRampToValueAtTime: function() {}
  }
};
MvNativeWebAudio._cacheSize = 48000 * 2 * 4;
Object.defineProperty(MvNativeWebAudio, 'masterVolume', {
  get: function() { return pmjsAudio.masterVolume; },
  set: function(value) { pmjsAudio.setMasterVolume(value); },
  configurable: true
});
Object.defineProperty(MvNativeWebAudio, '_masterVolume', {
  get: function() { return pmjsAudio.masterVolume; },
  set: function(value) { pmjsAudio.setMasterVolume(value); },
  configurable: true
});
MvNativeWebAudio._initialized = true;
MvNativeWebAudio._unlocked = true;
MvNativeWebAudio.initialize = function() { return true; };
MvNativeWebAudio.canPlayOgg = function() { return true; };
MvNativeWebAudio.canPlayM4a = function() { return true; };
MvNativeWebAudio.setMasterVolume = function(value) {
  pmjsAudio.setMasterVolume(value);
};
MvNativeWebAudio._onTouchStart = function() {};
MvNativeWebAudio._onVisibilityChange = function() {};
MvNativeWebAudio._fadeIn = function() {};
MvNativeWebAudio._fadeOut = function() {};

if (NativeHost.media) {
  globalThis.WebAudio = MvNativeWebAudio;
  AudioManager.createBuffer = function(folder, name) {
    var url = this._path + folder + '/' + encodeURIComponent(name) + this.audioFileExt();
    return new MvNativeWebAudio(url);
  };
  AudioManager.shouldUseHtml5Audio = function() { return false; };
  AudioManager.checkWebAudioError = function(buffer) {
    if (buffer && buffer.isError()) {
      throw new Error('Failed to load: ' + (buffer.url || buffer._url));
    }
  };
  SceneManager.initAudio = function() {};
  AudioManager.isReady = function() { return true; };
} else if (!globalThis.AudioContext) {
  globalThis.WebAudio = MvNativeWebAudio;
  SceneManager.initAudio = function() {};
  MvNativeWebAudio.initialize = function() { return true; };
  AudioManager.isReady = function() { return true; };
} else {
  WebAudio._onTouchStart = function() {
    if (this._context && this._context.resume) this._context.resume();
    this._unlocked = true;
  };
  WebAudio.prototype._createNodes = function() {
    var context = WebAudio._context;
    this._sourceNode = context.createBufferSource();
    this._sourceNode.buffer = this._buffer;
    this._sourceNode.loopStart = this._loopStart;
    this._sourceNode.loopEnd = this._loopStart + this._loopLength;
    this._sourceNode.playbackRate.setValueAtTime(this._pitch, context.currentTime);
    this._gainNode = context.createGain();
    this._gainNode.gain.setValueAtTime(this._volume, context.currentTime);
    this._pannerNode = context.createStereoPanner();
    this._updatePanner();
  };
  WebAudio.prototype._updatePanner = function() {
    if (this._pannerNode) {
      this._pannerNode.pan.setValueAtTime(this._pan, WebAudio._context.currentTime);
    }
  };
}
