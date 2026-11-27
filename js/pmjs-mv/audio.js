var pmjsAudio = PMJS.rpgmaker.audio;

function MvNativeWebAudio(url, intent) {
  this._url = String(url || '');
  if (intent === undefined) {
    var directory = typeof AudioManager !== 'undefined' && AudioManager._path || 'audio/';
    var root = pmjsAudio.resolvePath(directory).replace(/\/$/, '') + '/';
    var source = pmjsAudio.resolvePath(this._url);
    intent = source.indexOf(root) === 0
      ? pmjsAudio.intentForFolder(source.slice(root.length).split('/')[0]) : 'unknown';
  }
  this._gainAutomation = pmjsAudio.createGain(1);
  this._voice = pmjsAudio.createVoice(intent, {
    equalPowerPan: true, gainAutomation: this._gainAutomation
  });
  this._loadListeners = [];
  this._stopListeners = [];
  this._playGeneration = 0;
  this._volume = 1;
  this._pendingFadeIn = null;
  this._loadEpoch = 0;

  this._gainNode = this;
  this.gain = this;

  var self = this;
  this._voice.onInstalled = function() {
    if (self._voice.autoPlay) {
      if (self._pendingFadeIn !== null) self.fadeIn(self._pendingFadeIn);
      else self.setValueAtTime(self._volume);
    }
    self._onLoad();
  };

  if (typeof ResourceHandler !== 'undefined' && typeof ResourceHandler.createLoader === 'function') {
    var epoch = this._loadEpoch;
    var resign = this._voice.configureLoadRetry(function() { self._loader(); });
    this._loader = ResourceHandler.createLoader(this._url, function() {
      if (epoch === self._loadEpoch) self._load(self._url);
    }, resign);
  }
  this._load(this._url);
}

MvNativeWebAudio.prototype._load = function() {
  this._voice.reloadSource(this._url, function(path) {
    if (NativeHost.assets && typeof NativeHost.assets.hasDecrypted === 'function' &&
        NativeHost.assets.hasDecrypted(path)) return null;
    if (typeof Decrypter === 'undefined' || !Decrypter.hasEncryptedAudio) return null;
    return { path: Decrypter.extToEncryptExt(path), decrypt: function(bytes) {
      return Decrypter.decryptArrayBuffer(bytes);
    } };
  });
};

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
      var pitch = Number(value);
      if (this._voice.pitch === pitch) return;
      this._voice.pitch = pitch;
      if (this.isPlaying()) this.play(this._voice.loop, 0);
      else this._voice.applyParameters();
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
    get: function() { return this._gainAutomation.value; },
    set: function(value) { this._gainAutomation.value = value; },
    configurable: true
  },
  _autoPlay: {
    get: function() { return this._voice.autoPlay; },
    set: function(value) { this._voice.autoPlay = value; },
    configurable: true
  }
});

MvNativeWebAudio.prototype._rampGain = function(from, to, duration) {
  var time = Math.max(0, Number(duration) || 0);
  from = Math.max(0, Number(from) || 0);
  to = Math.max(0, Number(to) || 0);
  var now = pmjsAudio.now();
  this.setValueAtTime(from, now);
  this.linearRampToValueAtTime(to, now + time);
};

MvNativeWebAudio.prototype.setValueAtTime = function(value, time) {
  this._gainAutomation.schedule(false, value, time);
  return this;
};

MvNativeWebAudio.prototype.linearRampToValueAtTime = function(value, endTime) {
  this._gainAutomation.schedule(true, value, Number(endTime));
  return this;
};

MvNativeWebAudio.prototype.cancelScheduledValues = function(time) {
  this._gainAutomation.cancel(time);
  return this;
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
  this._loadEpoch++;
  this._voice.cancelLoadRetry();
  this.stop();
  this._voice.resetForClear({ duration: 0, offset: 0 });
  this._volume = 1;
  this.cancelScheduledValues(0);
  this.setValueAtTime(1);
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
  if (this.isReady() && !this._dispatchingLoad) listener();
  else if (!this._voice.error) this._loadListeners.push(listener);
};

MvNativeWebAudio.prototype.addStopListener = function(listener) {
  if (typeof listener === 'function') this._stopListeners.push(listener);
};

MvNativeWebAudio.prototype._onLoad = function() {
  var dispatching = this._dispatchingLoad;
  this._dispatchingLoad = true;
  try {
    while (this._loadListeners.length) {
      var listener = this._loadListeners.shift();
      try { listener(); }
      catch (error) { pmjsReportEventError(error); }
    }
  } finally {
    this._dispatchingLoad = dispatching;
  }
};

MvNativeWebAudio.prototype._drainStop = function() {
  while (this._stopListeners.length) {
    var listener = this._stopListeners.shift();
    listener();
  }
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
