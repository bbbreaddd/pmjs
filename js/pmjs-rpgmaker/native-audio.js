'use strict';

(function() {
function pmjsResolveAudioPath(url) {
  var encodedPath = String(url || '').split('?')[0].replace(/%(?![0-9a-f]{2})/gi, '%25');
  var decoded = decodeURIComponent(encodedPath);
  var clean = decoded.replace(/^file:\/\/\/game\//, '').replace(/^file:\/\//, '');
  var path = typeof gamePath === 'function'
    ? gamePath(clean)
    : clean.replace(/^\.\//, '').replace(/^\/+/, '');
  return path === '.' ? '' : path;
}

function pmjsIsAudioObjectUrl(url) {
  return typeof globalThis.pmjsIsObjectURL === 'function' &&
    globalThis.pmjsIsObjectURL(url);
}

var trackedAudioBuffers = [];
// Handles do not retain guest buffers; finalization removes their registrations.
var contextAudioHandles = new Set();
var nativeAudioFinalizer = typeof FinalizationRegistry === 'function'
  ? new FinalizationRegistry(function(handle) {
      contextAudioHandles.delete(handle);
      try { NativeHost.media.releaseAudio(handle); } catch (_) {}
    }) : null;

if (globalThis.PMJS && PMJS.optimizations) {
  PMJS.optimizations.register({ id: 'audio.prepared-effects', owner: 'pmjs-rpgmaker',
    fallback: 'independent streaming decoder per audio voice' });
}

function NativeAudioVoice(intent, settings) {
  settings = settings || {};
  this.intent = intent || 'unknown';
  this.handle = 0;
  this.duration = 0;
  this.volume = 1;
  this.pitch = 1;
  this.pan = 0;
  this.equalPowerPan = settings.equalPowerPan === true;
  this.absoluteGain = settings.absoluteGain === undefined ? null : settings.absoluteGain;
  this.loop = false;
  this.offset = 0;
  this.autoPlay = false;
  this.pendingFadeIn = null;
  this.wasPlaying = false;
  this.loading = false;
  this.error = false;
  this.loadGeneration = 0;
  this.onInstalled = null;
  this.onLoadError = null;
  this._loadRetryToken = null;
}

NativeAudioVoice.prototype.install = function(loaded, generation) {
  if (generation !== this.loadGeneration) {
    NativeHost.media.releaseAudio(loaded.handle);
    return false;
  }
  if (this.handle) {
    if (nativeAudioFinalizer) nativeAudioFinalizer.unregister(this);
    contextAudioHandles.delete(this.handle);
    NativeHost.media.releaseAudio(this.handle);
  }
  this.handle = loaded.handle;
  contextAudioHandles.add(this.handle);
  if (NativeAudioVoice.clock.state === 'suspended') {
    NativeHost.media.setAudioSuspended(this.handle, true);
  }
  this.duration = loaded.duration;
  this.loading = false;
  this.error = false;
  if (nativeAudioFinalizer) nativeAudioFinalizer.register(this, this.handle, this);
  if (this.autoPlay) {
    this.applyParameters();
    this.wasPlaying = NativeHost.media.playAudio(this.handle, this.loop, this.offset);
    if (this.absoluteGain !== null) this.setAbsoluteGain(this.absoluteGain);
    if (this.pendingFadeIn !== null) {
      NativeHost.media.fadeAudio(this.handle, 0, this.absoluteGain === null ? 1 : this.volume,
        this.pendingFadeIn, false, this.absoluteGain !== null);
    }
  }
  this.pendingFadeIn = null;
  if (typeof this.onInstalled === 'function') this.onInstalled();
  return true;
};

NativeAudioVoice.prototype.failLoad = function(source, error, generation) {
  if (generation !== undefined && generation !== this.loadGeneration) return;
  this.loading = false;
  this.error = true;
  console.error('[pmjs-media] audio load failed source=' + source +
    ' error=' + (error && error.message || error));
  if (typeof this.onLoadError === 'function') this.onLoadError(error);
};

NativeAudioVoice.prototype.configureLoadRetry = function(retry) {
  var voice = this;
  var token = {};
  this._loadRetryToken = token;
  this.onLoadError = function() {
    if (voice._loadRetryToken !== token) return;
    voice.error = false;
    voice.loading = true;
    retry();
  };
  return function() {
    if (voice._loadRetryToken !== token) return;
    voice.loading = false;
    voice.error = true;
  };
};

NativeAudioVoice.prototype.cancelLoadRetry = function() {
  this._loadRetryToken = null;
  this.onLoadError = null;
};

NativeAudioVoice.prototype.loadOptions = function(identity) {
  var options = { intent: this.intent };
  if (globalThis.PMJS && PMJS.optimizations &&
      !PMJS.optimizations.isEnabled('audio.prepared-effects')) options.intent = 'unknown';
  if (identity) {
    if (identity.resourcePath) options.resourcePath = identity.resourcePath;
    if (identity.resourceIdentity) options.resourceIdentity = identity.resourceIdentity;
  }
  return options;
};

NativeAudioVoice.prototype.loadSource = function(url, encryptedSource) {
  var path = pmjsResolveAudioPath(url);
  if (!NativeHost.media) return false;
  if (pmjsIsAudioObjectUrl(url)) {
    this.loadObjectUrl(url);
  } else if (path) {
    var encrypted = typeof encryptedSource === 'function' ? encryptedSource(path) : null;
    if (encrypted) this.fetchEncrypted(encrypted.path, encrypted.decrypt);
    else this.loadPath(path);
  } else {
    return false;
  }
  return true;
};

NativeAudioVoice.prototype.reloadSource = function(url, encryptedSource) {
  this.error = false;
  this.loading = !!NativeHost.media;
  if (!this.loadSource(url, encryptedSource)) this.loading = false;
};

NativeAudioVoice.prototype.loadPath = function(path) {
  var generation = ++this.loadGeneration;
  try { this.install(NativeHost.media.loadAudio(path, this.loadOptions()), generation); }
  catch (error) { this.failLoad(path, error, generation); }
};

NativeAudioVoice.prototype.loadBytes = function(buffer, generation, identity) {
  if (generation === undefined) generation = ++this.loadGeneration;
  if (generation !== this.loadGeneration) return;
  try { this.install(NativeHost.media.loadAudioBytes(buffer, this.loadOptions(identity)), generation); }
  catch (error) { this.failLoad('audio bytes', error, generation); }
};

NativeAudioVoice.prototype.loadObjectUrl = function(url) {
  var generation = ++this.loadGeneration;
  this.loading = true;
  var blob = typeof globalThis.pmjsResolveObjectURL === 'function'
    ? globalThis.pmjsResolveObjectURL(url) : null;
  if (!blob) {
    this.failLoad(url, new Error('object URL is unavailable'), generation);
    return;
  }
  blob.arrayBuffer().then(function(buffer) {
    if (generation !== this.loadGeneration) return;
    this.loadBytes(buffer, generation, { resourceIdentity: url });
  }.bind(this)).catch(function(error) {
    this.failLoad(url, error, generation);
  }.bind(this));
};

NativeAudioVoice.prototype.fetchEncrypted = function(encryptedPath, decryptFn) {
  var generation = ++this.loadGeneration;
  this.loading = true;
  var request = new XMLHttpRequest();
  request.open('GET', encryptedPath);
  request.responseType = 'arraybuffer';
  request.onload = function() {
    try {
      if (request.status >= 400) throw new Error('HTTP status ' + request.status);
      var bytes = decryptFn(request.response);
      if (generation !== this.loadGeneration) return;
      this.loadBytes(bytes, generation, { resourcePath: encryptedPath });
    } catch (error) {
      this.failLoad(encryptedPath, error, generation);
    }
  }.bind(this);
  request.onerror = function() {
    this.failLoad(encryptedPath, new Error('request failed'), generation);
  }.bind(this);
  request.send();
};

NativeAudioVoice.prototype.applyParameters = function() {
  if (this.handle && NativeHost.media) {
    NativeHost.media.setAudioParameters(
      this.handle, this.absoluteGain === null ? this.volume : 1, this.pitch,
      this.equalPowerPan ? 0 : this.pan);
    if (this.equalPowerPan) NativeHost.media.setAudioEqualPowerPan(this.handle, this.pan);
  }
};

function submitAbsoluteEnvelope(voice, from, to, duration) {
  if (voice.handle && NativeHost.media) {
    NativeHost.media.fadeAudio(voice.handle, from, to, duration, false, true);
  }
}

NativeAudioVoice.prototype.rampAbsoluteGain = function(from, to, duration) {
  var time = Math.max(0, Number(duration) || 0);
  from = Math.max(0, Number(from) || 0);
  to = Math.max(0, Number(to) || 0);
  // Explicit gain ramps use voice volume as a scale for their normalized envelope.
  var scale = Math.max(1, from, to);
  this.volume = scale;
  this.applyParameters();
  submitAbsoluteEnvelope(this, from / scale, to / scale, time);
};

NativeAudioVoice.prototype.setAbsoluteGain = function(value, duration) {
  var target = Math.max(0, Number(value) || 0);
  var time = Math.max(0, Number(duration) || 0);
  this.absoluteGain = target;
  this.applyParameters();
  submitAbsoluteEnvelope(this, time > 0 ? -1 : target, target, time);
};

NativeAudioVoice.prototype.play = function(loop, offset) {
  this.loop = !!loop;
  this.autoPlay = true;
  this.offset = Math.max(0, Number(offset) || 0);
  this.applyParameters();
  this.wasPlaying = !!this.handle && !!NativeHost.media &&
    NativeHost.media.playAudio(this.handle, this.loop, this.offset);
  if (this.absoluteGain !== null && this.handle) this.setAbsoluteGain(this.absoluteGain);
  return this.wasPlaying;
};

NativeAudioVoice.prototype.stop = function() {
  if (this.handle && NativeHost.media) NativeHost.media.stopAudio(this.handle);
  this.wasPlaying = false;
  this.autoPlay = false;
  this.pendingFadeIn = null;
};

NativeAudioVoice.prototype.release = function() {
  this.loadGeneration++;
  this.loading = false;
  if (this.handle) {
    var handle = this.handle;
    this.handle = 0;
    contextAudioHandles.delete(handle);
    if (nativeAudioFinalizer) {
      try { nativeAudioFinalizer.unregister(this); } catch (_) {}
    }
    if (NativeHost.media) {
      try { NativeHost.media.releaseAudio(handle); } catch (_) {}
    }
  }
};

NativeAudioVoice.prototype.cancelPending = function() {
  this.autoPlay = false;
  this.pendingFadeIn = null;
};

NativeAudioVoice.prototype.resetForReload = function() {
  this.release();
  this.error = false;
};

NativeAudioVoice.prototype.resetForClear = function(defaults) {
  if (this._loadRetryToken) this.cancelLoadRetry();
  this.resetForReload();
  this.volume = 1;
  this.pitch = 1;
  this.pan = 0;
  if (defaults.duration !== undefined) this.duration = defaults.duration;
  if (defaults.offset !== undefined) this.offset = defaults.offset;
  if (defaults.absoluteGain !== undefined) this.absoluteGain = defaults.absoluteGain;
};

NativeAudioVoice.prototype.position = function() {
  return (this.handle && NativeHost.media) ? NativeHost.media.audioPosition(this.handle) : 0;
};

NativeAudioVoice.prototype.nativePlaying = function() {
  return !!this.handle && !!NativeHost.media && NativeHost.media.audioIsPlaying(this.handle);
};

NativeAudioVoice.prototype.fadeIn = function(duration) {
  var time = Math.max(0, Number(duration) || 0);
  if (this.handle && NativeHost.media) {
    NativeHost.media.fadeAudio(this.handle, 0, this.absoluteGain === null ? 1 : this.volume, time, false, this.absoluteGain !== null);
  } else if (this.autoPlay) {
    this.pendingFadeIn = time;
  }
};

NativeAudioVoice.prototype.fadeTo = function(vol, duration, stop) {
  var target = Math.max(0, Math.min(1, Number(vol) || 0));
  var time = Math.max(0, Number(duration) || 0);
  if (this.handle && NativeHost.media) {
    NativeHost.media.fadeAudio(this.handle, -1, target, time, stop === true);
  }
};

NativeAudioVoice.prototype.pollNative = function() {
  if (this.loading) return 'loading';
  var playing = this.nativePlaying();
  if (this.wasPlaying && !playing) {
    this.wasPlaying = false;
    return 'stopped';
  }
  this.wasPlaying = playing;
  return playing ? 'playing' : 'idle';
};

var nativeAudioContextStartTime = Date.now();
var suspendedAt = null;
NativeAudioVoice.clock = {
  state: 'running',
  get currentTime() {
    return ((suspendedAt === null ? Date.now() : suspendedAt) -
      nativeAudioContextStartTime) / 1000;
  },
  resume: function() {
    if (suspendedAt !== null) {
      contextAudioHandles.forEach(function(handle) {
        NativeHost.media.setAudioSuspended(handle, false);
      });
      nativeAudioContextStartTime += Date.now() - suspendedAt;
      suspendedAt = null;
      this.state = 'running';
    }
    return Promise.resolve();
  },
  suspend: function() {
    if (suspendedAt === null) {
      contextAudioHandles.forEach(function(handle) {
        NativeHost.media.setAudioSuspended(handle, true);
      });
      suspendedAt = Date.now();
      this.state = 'suspended';
    }
    return Promise.resolve();
  },
  destination: {}
};
NativeAudioVoice.now = function() {
  return NativeAudioVoice.clock.currentTime;
};
NativeAudioVoice.masterVolume = 1;
NativeAudioVoice.setMasterVolume = function(value) {
  var vol = Math.max(0, Math.min(1, Number(value) || 0));
  NativeAudioVoice.masterVolume = vol;
  if (NativeHost.media && typeof NativeHost.media.setMasterVolume === 'function') {
    NativeHost.media.setMasterVolume(vol);
  }
};

globalThis.PMJS = globalThis.PMJS || {};
PMJS.rpgmaker = PMJS.rpgmaker || {};
PMJS.rpgmaker.audio = {
  intentForFolder: function(folder) {
    var kind = folder.replace(/\/$/, '');
    return kind === 'se' ? 'effect' : kind === 'bgm' ? 'music' :
      kind === 'bgs' ? 'ambient' : kind === 'me' ? 'jingle' : 'unknown';
  },
  createVoice: function(intent, settings) {
    return new NativeAudioVoice(intent, settings);
  },
  track: function(buffer) {
    if (trackedAudioBuffers.indexOf(buffer) < 0) trackedAudioBuffers.push(buffer);
  },
  update: function() {
    for (var index = trackedAudioBuffers.length - 1; index >= 0; index--) {
      var buffer = trackedAudioBuffers[index];
      if (!buffer) continue;
      var generation = buffer._playGeneration;
      if (!buffer._poll() && buffer._playGeneration === generation) {
        trackedAudioBuffers.splice(index, 1);
      }
    }
    return trackedAudioBuffers.length;
  },
  now: function() {
    return NativeAudioVoice.now();
  },
  clock: NativeAudioVoice.clock,
  setMasterVolume: function(value) {
    NativeAudioVoice.setMasterVolume(value);
  },
  resolvePath: pmjsResolveAudioPath,
  isObjectUrl: pmjsIsAudioObjectUrl
};
Object.defineProperty(PMJS.rpgmaker.audio, 'masterVolume', {
  get: function() { return NativeAudioVoice.masterVolume; },
  configurable: true
});
})();
