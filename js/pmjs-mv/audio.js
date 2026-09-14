var nativeAudioBuffers = [];
var nativeAudioFinalizer = typeof FinalizationRegistry === 'function'
  ? new FinalizationRegistry(function(handle) {
      try { NativeHost.media.releaseAudio(handle); } catch (_) {}
    }) : null;

function NativeAudioBuffer(url) {
  this._url = String(url || '');
  this._volume = 1;
  this._pitch = 1;
  this._pan = 0;
  this._loop = false;
  this._autoPlay = false;
  this._offset = 0;
  this._stopListeners = [];
  this._loadListeners = [];
  this._hasError = false;
  this._wasPlaying = false;
  this._handle = 0;
  this._duration = 0;
  this._loading = false;
  this._loadGeneration = 0;

  this._gainNode = this;
  this.gain = this;

  var encodedPath = this._url.split('?')[0].replace(/%(?![0-9a-f]{2})/gi, '%25');
  var decoded = decodeURIComponent(encodedPath);
  var clean = decoded.replace(/^file:\/\/\/game\//, '').replace(/^file:\/\//, '');
  var path = typeof gamePath === 'function'
    ? gamePath(clean)
    : clean.replace(/^\.\//, '').replace(/^\/+/, '');
  if (path === '.') path = '';

  if (NativeHost.media && typeof globalThis.pmjsIsObjectURL === 'function' &&
      globalThis.pmjsIsObjectURL(this._url)) {
    this._loadObjectUrl(this._url);
  } else if (NativeHost.media && path && typeof Decrypter !== 'undefined' &&
      Decrypter.hasEncryptedAudio) {
    this._loadEncrypted(path);
  } else if (NativeHost.media && path) {
    this._loadPath(path);
  }
}

NativeAudioBuffer.prototype._install = function(loaded, generation) {
  if (generation !== this._loadGeneration) {
    NativeHost.media.releaseAudio(loaded.handle);
    return;
  }
  this._handle = loaded.handle;
  this._duration = loaded.duration;
  this._loading = false;
  if (nativeAudioFinalizer) nativeAudioFinalizer.register(this, this._handle, this);
  var listeners = this._loadListeners.splice(0);
  for (var index = 0; index < listeners.length; index++) listeners[index]();
  if (this._autoPlay) {
    this._updateParameters();
    this._wasPlaying = NativeHost.media.playAudio(this._handle, this._loop, this._offset);
  }
};

NativeAudioBuffer.prototype._failLoad = function(source, error, generation) {
  if (generation !== undefined && generation !== this._loadGeneration) return;
  this._loading = false;
  this._hasError = true;
  console.error('[pmjs-media] audio load failed source=' + source +
    ' error=' + (error && error.message || error));
};

NativeAudioBuffer.prototype._loadPath = function(path) {
  var generation = ++this._loadGeneration;
  try { this._install(NativeHost.media.loadAudio(path), generation); }
  catch (error) { this._failLoad(path, error, generation); }
};

NativeAudioBuffer.prototype._loadBytes = function(buffer, generation) {
  if (generation === undefined) generation = ++this._loadGeneration;
  if (generation !== this._loadGeneration) return;
  try { this._install(NativeHost.media.loadAudioBytes(buffer), generation); }
  catch (error) { this._failLoad('audio bytes', error, generation); }
};

NativeAudioBuffer.prototype._loadObjectUrl = function(url) {
  var generation = ++this._loadGeneration;
  this._loading = true;
  var blob = typeof globalThis.pmjsResolveObjectURL === 'function'
    ? globalThis.pmjsResolveObjectURL(url) : null;
  if (!blob) { this._failLoad(url, new Error('object URL is unavailable'), generation); return; }
  blob.arrayBuffer().then(function(buffer) {
    if (generation !== this._loadGeneration) return;
    this._loadBytes(buffer, generation);
  }.bind(this)).catch(function(error) {
    this._failLoad(url, error, generation);
  }.bind(this));
};

NativeAudioBuffer.prototype._loadEncrypted = function(path) {
  var generation = ++this._loadGeneration;
  this._loading = true;
  var encryptedPath = Decrypter.extToEncryptExt(path);
  var request = new XMLHttpRequest();
  request.open('GET', encryptedPath);
  request.responseType = 'arraybuffer';
  request.onload = function() {
    try {
      if (request.status >= 400) throw new Error('HTTP status ' + request.status);
      var bytes = Decrypter.decryptArrayBuffer(request.response);
      if (generation !== this._loadGeneration) return;
      this._loadBytes(bytes, generation);
    } catch (error) {
      this._failLoad(encryptedPath, error, generation);
    }
  }.bind(this);
  request.onerror = function() {
    this._failLoad(encryptedPath, new Error('request failed'), generation);
  }.bind(this);
  request.send();
};

Object.defineProperties(NativeAudioBuffer.prototype, {
  url: {
    get: function() { return this._url; },
    configurable: true
  },
  volume: {
    get: function() { return this._volume; },
    set: function(value) {
      this._volume = Number(value);
      this._updateParameters();
    },
    configurable: true
  },
  pitch: {
    get: function() { return this._pitch; },
    set: function(value) {
      this._pitch = Number(value);
      this._updateParameters();
    },
    configurable: true
  },
  pan: {
    get: function() { return this._pan; },
    set: function(value) {
      this._pan = Number(value);
      this._updateParameters();
    },
    configurable: true
  },
  value: {
    get: function() { return this._volume; },
    set: function(value) {
      this._volume = Number(value);
      this._updateParameters();
    },
    configurable: true
  }
});

NativeAudioBuffer.prototype.setValueAtTime = function(value) {
  this.volume = value;
};

NativeAudioBuffer.prototype.linearRampToValueAtTime = function(value, endTime) {
  var currentTime = (WebAudio._context && WebAudio._context.currentTime) || 0;
  var duration = Math.max(0, Number(endTime - currentTime) || 0);
  this._fadeTo(value, duration);
};

NativeAudioBuffer.prototype._updateParameters = function() {
  if (this._handle && NativeHost.media) {
    NativeHost.media.setAudioParameters(
      this._handle, this._volume, this._pitch, this._pan);
  }
};

NativeAudioBuffer.prototype.isReady = function() {
  return !this._loading && !this._hasError && (!!this._handle || !NativeHost.media);
};

NativeAudioBuffer.prototype.isError = function() {
  return this._hasError;
};

NativeAudioBuffer.prototype.isPlaying = function() {
  return !!this._handle && !!NativeHost.media && NativeHost.media.audioIsPlaying(this._handle);
};

NativeAudioBuffer.prototype.bufferSize = function() {
  return this._handle ? NativeAudioBuffer._cacheSize : 0;
};

NativeAudioBuffer.prototype.play = function(loop, offset) {
  this._loop = !!loop;
  this._autoPlay = true;
  this._offset = Math.max(0, Number(offset) || 0);
  this._updateParameters();
  this._wasPlaying = !!this._handle && !!NativeHost.media &&
    NativeHost.media.playAudio(this._handle, this._loop, this._offset);
  if (nativeAudioBuffers.indexOf(this) < 0) nativeAudioBuffers.push(this);
};

NativeAudioBuffer.prototype.stop = function() {
  var wasPlaying = this._wasPlaying || this.isPlaying();
  if (this._handle && NativeHost.media) NativeHost.media.stopAudio(this._handle);
  this._wasPlaying = false;
  this._autoPlay = false;
  if (wasPlaying) this._notifyStop();
};

NativeAudioBuffer.prototype.clear = function() {
  this._loadGeneration++;
  this._loading = false;
  this.stop();
  this._loadListeners.length = 0;
  this._stopListeners.length = 0;
  this._autoPlay = false;
  this._wasPlaying = false;
  if (this._handle) {
    var handle = this._handle;
    this._handle = 0;
    if (nativeAudioFinalizer) {
      try { nativeAudioFinalizer.unregister(this); } catch (_) {}
    }
    if (NativeHost.media) {
      try { NativeHost.media.releaseAudio(handle); } catch (_) {}
    }
  }
};

NativeAudioBuffer.prototype.seek = function() {
  return (this._handle && NativeHost.media) ? NativeHost.media.audioPosition(this._handle) : 0;
};

NativeAudioBuffer.prototype.fadeIn = function(duration) {
  if (this._handle && NativeHost.media) {
    NativeHost.media.fadeAudio(this._handle, 0, 1,
      Math.max(0, Number(duration) || 0), false);
  }
};

NativeAudioBuffer.prototype.fadeOut = function(duration) {
  if (this._handle && NativeHost.media) {
    NativeHost.media.fadeAudio(this._handle, -1, 0,
      Math.max(0, Number(duration) || 0), true);
  }
};

NativeAudioBuffer.prototype._fadeTo = function(vol, duration) {
  var target = Math.max(0, Math.min(1, Number(vol) || 0));
  var time = Math.max(0, Number(duration) || 0);
  if (this._handle && NativeHost.media) {
    NativeHost.media.fadeAudio(this._handle, -1, target, time, false);
  }
};

NativeAudioBuffer.prototype.addLoadListener = function(listener) {
  if (typeof listener !== 'function') return;
  if (this.isReady()) listener();
  else if (!this._hasError) this._loadListeners.push(listener);
};

NativeAudioBuffer.prototype.addStopListener = function(listener) {
  if (typeof listener === 'function') this._stopListeners.push(listener);
};

NativeAudioBuffer.prototype._notifyStop = function() {
  var listeners = this._stopListeners.splice(0);
  for (var index = 0; index < listeners.length; index++) listeners[index]();
};

NativeAudioBuffer.prototype._poll = function() {
  if (this._loading) return true;
  var playing = this.isPlaying();
  if (this._wasPlaying && !playing) this._notifyStop();
  this._wasPlaying = playing;
  return playing;
};

var audioContextStartTime = Date.now();
NativeAudioBuffer._context = {
  state: 'running',
  get currentTime() {
    return (Date.now() - audioContextStartTime) / 1000;
  },
  resume: function() { return Promise.resolve(); },
  suspend: function() { return Promise.resolve(); },
  destination: {}
};
NativeAudioBuffer._masterGainNode = {
  gain: {
    setValueAtTime: function() {},
    linearRampToValueAtTime: function() {}
  }
};
NativeAudioBuffer._masterVolume = 1;
NativeAudioBuffer._cacheSize = 48000 * 2 * 4;
NativeAudioBuffer._initialized = true;
NativeAudioBuffer._unlocked = true;
NativeAudioBuffer.initialize = function() { return true; };
NativeAudioBuffer.canPlayOgg = function() { return true; };
NativeAudioBuffer.canPlayM4a = function() { return true; };
NativeAudioBuffer.setMasterVolume = function(value) {
  var vol = Math.max(0, Math.min(1, Number(value) || 0));
  NativeAudioBuffer._masterVolume = vol;
  if (NativeHost.media && typeof NativeHost.media.setMasterVolume === 'function') {
    NativeHost.media.setMasterVolume(vol);
  }
};
Object.defineProperty(NativeAudioBuffer, 'masterVolume', {
  get: function() { return NativeAudioBuffer._masterVolume; },
  set: function(value) { NativeAudioBuffer.setMasterVolume(value); },
  configurable: true
});
NativeAudioBuffer._onTouchStart = function() {};
NativeAudioBuffer._onVisibilityChange = function() {};
NativeAudioBuffer._fadeIn = function() {};
NativeAudioBuffer._fadeOut = function() {};

if (NativeHost.media) {
  globalThis.WebAudio = NativeAudioBuffer;
  AudioManager.createBuffer = function(folder, name) {
    var url = this._path + folder + '/' + encodeURIComponent(name) + this.audioFileExt();
    return new NativeAudioBuffer(url);
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
  globalThis.WebAudio = NativeAudioBuffer;
  SceneManager.initAudio = function() {};
  WebAudio.initialize = function() { return true; };
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
