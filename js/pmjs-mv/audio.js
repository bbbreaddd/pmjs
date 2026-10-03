var pmjsAudio = PMJS.rpgmaker.audio;

function MvNativeWebAudio(url, intent) {
  this._url = String(url || '');
  this._voice = pmjsAudio.createVoice(intent);
  this._loadListeners = [];
  this._stopListeners = [];
  this._playGeneration = 0;
  this._volume = 1;
  this._gainValue = 1;
  this._gainRamp = null;
  this._pendingFadeIn = null;

  this._gainNode = this;
  this.gain = this;

  var path = pmjsAudio.resolvePath(this._url);
  var self = this;
  this._voice.onInstalled = function() {
    if (self._voice.autoPlay) {
      if (self._pendingFadeIn !== null) self.fadeIn(self._pendingFadeIn);
      else self.setValueAtTime(self._volume);
    }
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
    get: function() { return this._volume; },
    set: function(value) {
      this._volume = Number(value);
      this.setValueAtTime(this._volume);
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
    get: function() {
      var ramp = this._gainRamp;
      if (!ramp) return this._gainValue;
      var progress = Math.max(0, Math.min(1, (pmjsAudio.now() - ramp.start) / ramp.duration));
      return ramp.from + (ramp.to - ramp.from) * progress;
    },
    set: function(value) { this.setValueAtTime(value); },
    configurable: true
  },
  _autoPlay: {
    get: function() { return this._voice.autoPlay; },
    set: function(value) { this._voice.autoPlay = value; },
    configurable: true
  }
});

// Native fades are envelopes multiplied by voice volume; MV gain targets are absolute.
MvNativeWebAudio.prototype._rampGain = function(from, to, duration) {
  var time = Math.max(0, Number(duration) || 0);
  from = Math.max(0, Number(from) || 0);
  to = Math.max(0, Number(to) || 0);
  this._gainValue = to;
  this._gainRamp = time > 0
    ? { from: from, to: to, start: pmjsAudio.now(), duration: time } : null;
  var scale = Math.max(1, from, to);
  this._voice.volume = scale;
  this._voice.applyParameters();
  if (this._voice.handle && NativeHost.media) {
    NativeHost.media.fadeAudio(this._voice.handle, from / scale, to / scale, time, false);
  }
};

MvNativeWebAudio.prototype.setValueAtTime = function(value) {
  this._rampGain(value, value, 0);
};

MvNativeWebAudio.prototype.linearRampToValueAtTime = function(value, endTime) {
  var duration = Math.max(0, Number(endTime - pmjsAudio.now()) || 0);
  this._rampGain(this.value, value, duration);
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
  this.setValueAtTime(this._volume);
  pmjsAudio.track(this);
};

MvNativeWebAudio.prototype.stop = function() {
  this._voice.stop();
  this._pendingFadeIn = null;
  this._drainStop();
};

MvNativeWebAudio.prototype.clear = function() {
  this.stop();
  this._voice.resetForReload();
  this._voice.volume = 1;
  this._voice.pitch = 1;
  this._voice.pan = 0;
  this._voice.duration = 0;
  this._voice.offset = 0;
  this._volume = 1;
  this._gainValue = 1;
  this._gainRamp = null;
  this._loadListeners.length = 0;
  this._stopListeners.length = 0;
};

MvNativeWebAudio.prototype._fadeTo = function(volume, duration) {
  this._rampGain(this.value, volume, duration);
};

MvNativeWebAudio.prototype.seek = function() {
  return this._voice.position();
};

MvNativeWebAudio.prototype.fadeIn = function(duration) {
  if (this.isReady()) {
    this._pendingFadeIn = null;
    this._rampGain(0, this._volume, duration);
  } else if (this._voice.autoPlay) {
    this._pendingFadeIn = duration;
  }
};

MvNativeWebAudio.prototype.fadeOut = function(duration) {
  this._voice.cancelPending();
  this._pendingFadeIn = null;
  this._rampGain(this._volume, 0, duration);
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
    return new MvNativeWebAudio(url, pmjsAudio.intentForFolder(folder));
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
