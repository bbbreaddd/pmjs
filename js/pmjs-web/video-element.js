var VideoElement = (function() {
var nativeVideos = [];
var nativeVideoFinalizer = typeof FinalizationRegistry === 'function'
  ? new FinalizationRegistry(function(handles) {
      try { NativeHost.media.releaseVideo(handles.video); } catch (_) {}
      try { if (handles.audio) NativeHost.media.releaseAudio(handles.audio); } catch (_) {}
    }) : null;
function videoTelemetry(event, details) {
  try {
    if (typeof NativeHost === 'undefined' || !NativeHost.runtime ||
        NativeHost.runtime.env('PMJS_VIDEO_TELEMETRY') !== '1') return;
    console.log('[pmjs-video-lifecycle] ' + JSON.stringify(
      Object.assign({ event: event, timeMs: performance.now() }, details || {})));
  } catch (_) {}
}
function VideoElement() {
  GenericElement.call(this, 'video');
  this._src = ''; this._media = null;
  this._nativeImage = null; this._nativeCanvas = null; this._presentationImage = null;
  this._currentTime = 0; this._startedAt = 0; this._startOffset = 0;
  this.duration = 0; this.videoWidth = 0; this.videoHeight = 0;
  this.width = 0; this.height = 0; this._volume = 1; this._playbackRate = 1;
  this.loop = false; this._muted = false; this.paused = true; this.ended = false;
  this.preload = 'auto'; this._loadGeneration = 0; this._playGeneration = 0;
  this._loading = false; this._playRequested = false;
  this._pendingPlayPromises = [];
  this.readyState = 0; this.HAVE_NOTHING = 0; this.HAVE_METADATA = 1;
  this.HAVE_CURRENT_DATA = 2; this.HAVE_FUTURE_DATA = 3; this.HAVE_ENOUGH_DATA = 4;
}
VideoElement.prototype = Object.create(GenericElement.prototype);
VideoElement.prototype.constructor = VideoElement;
['loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'error',
  'play', 'pause', 'ended'].forEach(function(type) {
  EventTarget.defineEventHandlerProperty(VideoElement.prototype, type);
});
Object.defineProperty(VideoElement.prototype, 'src', {
  get: function() { return this._src; },
  set: function(value) {
    this._src = String(value);
    var generation = ++this._loadGeneration;
    this._releaseMedia();
    this._loading = false;
    this._playRequested = false;
    if (!this._src) {
      return;
    }
    if (this.preload === 'none') return;
    this._queueLoad(generation);
  }
});
Object.defineProperty(VideoElement.prototype, 'currentTime', {
  get: function() {
    if (!this.paused && this._audio && NativeHost.media.audioIsPlaying(this._audio.handle))
      return NativeHost.media.audioPosition(this._audio.handle);
    if (!this.paused) return this._startOffset +
      (performance.now() - this._startedAt) / 1000 * this._playbackRate;
    return this._currentTime;
  },
  set: function(value) {
    this._currentTime = Math.max(0, Number(value) || 0);
    this._startOffset = this._currentTime; this._startedAt = performance.now();
    if (!this.paused && this._audio) NativeHost.media.playAudio(
      this._audio.handle, this.loop, this._currentTime);
  }
});
Object.defineProperty(VideoElement.prototype, 'playbackRate', {
  get: function() { return this._playbackRate; },
  set: function(value) {
    var time = this.currentTime;
    this._playbackRate = Math.max(0.05, Math.min(8, Number(value) || 1));
    this._currentTime = this._startOffset = time; this._startedAt = performance.now();
    if (this._audio) NativeHost.media.setAudioParameters(this._audio.handle,
      this._muted ? 0 : this._volume, this._playbackRate, 0);
  }
});
Object.defineProperty(VideoElement.prototype, 'muted', {
  get: function() { return this._muted; },
  set: function(value) {
    this._muted = !!value;
    if (this._audio) NativeHost.media.setAudioParameters(this._audio.handle,
      this._muted ? 0 : this._volume, this._playbackRate, 0);
  }
});
Object.defineProperty(VideoElement.prototype, 'volume', {
  get: function() { return this._volume; },
  set: function(value) {
    this._volume = Math.max(0, Math.min(1, Number(value) || 0));
    if (this._audio) NativeHost.media.setAudioParameters(
      this._audio.handle, this._muted ? 0 : this._volume, this._playbackRate, 0);
  }
});
VideoElement.prototype.canPlayType = function(type) {
  return /^video\//.test(String(type)) ? 'maybe' : '';
};
VideoElement.prototype._releaseMedia = function() {
  this._settlePlayPromises(videoAbortError('The media resource was replaced'));
  if (nativeVideoFinalizer) nativeVideoFinalizer.unregister(this);
  if (this._media) NativeHost.media.releaseVideo(this._media.handle);
  if (this._audio) NativeHost.media.releaseAudio(this._audio.handle);
  this._media = null; this._audio = null;
  this._nativeImage = null; this._nativeCanvas = null; this._presentationImage = null;
  this.readyState = this.HAVE_NOTHING;
  this.duration = 0; this.videoWidth = 0; this.videoHeight = 0;
  this._currentTime = 0; this._startOffset = 0; this._decodedTime = undefined;
  this.paused = true; this.ended = false;
  var index = nativeVideos.indexOf(this);
  if (index >= 0) nativeVideos.splice(index, 1);
};
VideoElement.prototype._pmjsNativeTextureSource = function() {
  if (this._media && typeof NativeHost.media.videoCanvasImage === 'function') {
    var handle = NativeHost.media.videoCanvasImage(this._media.handle);
    if (!this._nativeImage || this._nativeImage.handle !== handle) {
      this._nativeImage = { handle: handle, width: this.videoWidth, height: this.videoHeight };
    }
  }
  return this._nativeImage || this._nativeCanvas;
};
VideoElement.prototype._pmjsNativePresentationSource = function() {
  return this._presentationImage || this._nativeImage || this._nativeCanvas;
};
function videoAbortError(message) {
  var error = new Error(message);
  error.name = 'AbortError';
  return error;
}
VideoElement.prototype._settlePlayPromises = function(error) {
  var pending = this._pendingPlayPromises.splice(0);
  pending.forEach(function(entry) {
    if (error) entry.reject(error);
    else entry.resolve();
  });
};
VideoElement.prototype._failLoad = function(generation, error) {
  if (generation !== this._loadGeneration) return;
  this._loading = false;
  this._playRequested = false;
  this._settlePlayPromises(error || new Error('Video load failed'));
  videoTelemetry('load-failed', {
    generation: generation,
    queueMs: this._loadRequestedAt === undefined ? null :
      performance.now() - this._loadRequestedAt,
    error: error && error.message || String(error || 'Video load failed')
  });
  var event = { type: 'error', target: this, error: error };
  this.dispatchEvent(event);
};
VideoElement.prototype._loadNow = function(generation) {
  var video = this;
  var source = this._src;
  if (!source && this.children.length) source = this.children[0].src || '';
  if (!source) return;
  var loadPromise;
  try {
    var encoded = source.split('?')[0].replace(/%(?![0-9a-f]{2})/gi, '%25');
    var path = decodeURIComponent(encoded).replace(/^file:\/\/\/game\//, '').replace(/^\.\//, '');
    this._loading = true;
    this._nativeLoadStartedAt = performance.now();
    videoTelemetry('native-load-start', {
      generation: generation,
      queueMs: this._loadRequestedAt === undefined ? null :
        this._nativeLoadStartedAt - this._loadRequestedAt
    });
    loadPromise = NativeHost.media.loadVideoAsync(path,
      PMJS.config && PMJS.config.videoColorProfile || 'chromium65');
  } catch (error) {
    this._failLoad(generation, error);
    return;
  }
  loadPromise.then(function(media) {
    if (generation !== video._loadGeneration) {
      NativeHost.media.releaseVideo(media.handle);
      if (media.audio) NativeHost.media.releaseAudio(media.audio);
      return;
    }
    video._loading = false;
    video._media = { handle: media.handle };
    video._audio = media.audio ? { handle: media.audio } : null;
    var nativeTexture = { handle: media.image, width: media.width, height: media.height };
    video._nativeImage = nativeTexture;
    video._presentationImage = nativeTexture;
    video.videoWidth = media.width; video.videoHeight = media.height;
    if (!video.width) video.width = video.videoWidth;
    if (!video.height) video.height = video.videoHeight;
    video.duration = media.duration; video.readyState = video.HAVE_ENOUGH_DATA;
    video.ended = false;
    if (nativeVideoFinalizer) nativeVideoFinalizer.register(video, {
      video: media.handle, audio: media.audio || 0
    }, video);
    videoTelemetry('first-frame-ready', {
      generation: generation,
      queueMs: video._loadRequestedAt === undefined ? null :
        performance.now() - video._loadRequestedAt,
      nativeMs: video._nativeLoadStartedAt === undefined ? null :
        performance.now() - video._nativeLoadStartedAt,
      width: media.width,
      height: media.height
    });
    video.dispatchEvent({ type: 'loadedmetadata', target: video });
    if (generation !== video._loadGeneration) return;
    video.dispatchEvent({ type: 'loadeddata', target: video });
    if (generation !== video._loadGeneration) return;
    var graphics = typeof Graphics !== 'undefined' ? Graphics : null;
    videoTelemetry('loadeddata-dispatched', {
      generation: generation,
      videoLoading: !!(graphics && graphics._videoLoading),
      canvasOpacity: graphics && graphics._canvas && graphics._canvas.style
        ? graphics._canvas.style.opacity : null,
      videoOpacity: video.style ? video.style.opacity : null
    });
    video.dispatchEvent({ type: 'canplay', target: video });
    if (generation !== video._loadGeneration) return;
    video.dispatchEvent({ type: 'canplaythrough', target: video });
    if (generation !== video._loadGeneration) return;
    if (video._playRequested) video._startPlayback();
  }, function(error) {
    video._failLoad(generation, error);
  });
};
VideoElement.prototype.load = function() {
  var generation = ++this._loadGeneration;
  this._releaseMedia();
  this._loading = false;
  this._playRequested = false;
  if (!this._src && !this.children.length) return;
  this._queueLoad(generation);
};
VideoElement.prototype._queueLoad = function(generation) {
  var video = this;
  this._loading = true;
  this._loadRequestedAt = performance.now();
  this._nativeLoadStartedAt = undefined;
  videoTelemetry('load-queued', { generation: generation });
  PMJS.tasks.enqueue(function() {
    if (generation === video._loadGeneration && video._loading) {
      video._loadNow(generation);
    }
  });
};
VideoElement.prototype.play = function() {
  ++this._playGeneration;
  if (!this._media && !this._loading) this.load();
  var video = this;
  var promise = new Promise(function(resolve, reject) {
    video._pendingPlayPromises.push({ resolve: resolve, reject: reject });
  });
  if (!this._media && !this._loading) {
    this._playRequested = false;
    this._settlePlayPromises(new Error('No video source is available'));
  } else {
    this._playRequested = true;
    this._startPlayback();
  }
  return promise;
};
VideoElement.prototype._startPlayback = function() {
  if (!this._media || !this._playRequested) return;
  this._playRequested = false;
  if (!this.paused) {
    this._settlePlayPromises();
    return;
  }
  if (this.ended) this._currentTime = 0;
  this.paused = false; this.ended = false; this._startOffset = this._currentTime;
  this._startedAt = performance.now();
  if (this._audio) {
    NativeHost.media.setAudioParameters(this._audio.handle,
      this._muted ? 0 : this._volume, this._playbackRate, 0);
    NativeHost.media.playAudio(this._audio.handle, this.loop, this._currentTime);
  }
  if (nativeVideos.indexOf(this) < 0) nativeVideos.push(this);
  this.dispatchEvent({ type: 'play', target: this });
  this._settlePlayPromises();
};
VideoElement.prototype.pause = function() {
  ++this._playGeneration;
  this._playRequested = false;
  this._settlePlayPromises(videoAbortError('Playback was interrupted by pause'));
  this._currentTime = this.currentTime; this.paused = true;
  if (this._audio) NativeHost.media.stopAudio(this._audio.handle);
  var index = nativeVideos.indexOf(this);
  if (index >= 0) nativeVideos.splice(index, 1);
  this.dispatchEvent({ type: 'pause', target: this });
};
VideoElement.prototype._update = function() {
  if (this.paused || !this._media) return false;
  var time = this.currentTime;
  if (this.duration > 0 && time >= this.duration) {
    if (this.loop) { this.currentTime = time % this.duration; time = this.currentTime; }
    else {
      this._currentTime = this.duration; this.paused = true; this.ended = true;
      if (this._audio) NativeHost.media.stopAudio(this._audio.handle);
      this.dispatchEvent({ type: 'ended', target: this });
      return !this.paused && !!this._media;
    }
  }
  var frameTime = time;
  if (frameTime !== this._decodedTime) {
    this._decodedTime = NativeHost.media.updateVideo(this._media.handle, frameTime);
  }
  return true;
};

globalThis.PMJS = globalThis.PMJS || {};
PMJS.web = PMJS.web || {};
PMJS.web.video = {
  update: function() {
    for (var index = nativeVideos.length - 1; index >= 0; index--) {
      var video = nativeVideos[index];
      if (!video) continue;
      var playGeneration = video._playGeneration;
      var loadGeneration = video._loadGeneration;
      if (!video._update() && video._playGeneration === playGeneration &&
          video._loadGeneration === loadGeneration) {
        var currentIndex = nativeVideos.indexOf(video);
        if (currentIndex >= 0) nativeVideos.splice(currentIndex, 1);
      }
    }
    return nativeVideos.length;
  },
  diagnostics: function() {
    return nativeVideos.map(function(video) {
      var source = video._pmjsNativePresentationSource();
      return { media: video._media && video._media.handle,
        image: source && source.handle, readyState: video.readyState,
        paused: video.paused };
    });
  }
};

return VideoElement;
})();
