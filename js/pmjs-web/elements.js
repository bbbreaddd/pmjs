function ImageData(data, width, height) {
  if (typeof data === 'number') {
    height = width;
    width = data;
    data = new Uint8ClampedArray(width * height * 4);
  }
  if (!(data instanceof Uint8ClampedArray) || width <= 0 || height <= 0 ||
      data.length !== width * height * 4) {
    throw new TypeError('invalid ImageData constructor arguments');
  }
  this.data = data;
  this.width = width;
  this.height = height;
}
globalThis.ImageData = ImageData;

function base64Bytes(bytes) {
  var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var encoded = '';
  for (var index = 0; index < bytes.length; index += 3) {
    var first = bytes[index];
    var second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    var third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    encoded += alphabet[first >> 2];
    encoded += alphabet[(first & 3) << 4 | second >> 4];
    encoded += index + 1 < bytes.length ?
      alphabet[(second & 15) << 2 | third >> 6] : '=';
    encoded += index + 2 < bytes.length ? alphabet[third & 63] : '=';
  }
  return encoded;
}

function CanvasElement() {
  EventTarget.call(this);
  this._width = 300;
  this._height = 150;
  this.style = {};
  this.screencanvas = false;
  this._context2d = null;
  this._nativeCanvas = null;
}

CanvasElement.prototype = Object.create(EventTarget.prototype);
CanvasElement.prototype.constructor = CanvasElement;
CanvasElement.prototype._releaseNativeCanvas = function() {
  releaseNativeResource(this._nativeCanvas, 'canvas');
  this._nativeCanvas = null;
};
CanvasElement.prototype._ensureNativeCanvas = function() {
  if (!this._nativeCanvas) {
    this._nativeCanvas = trackNativeResource(
      NativeHost.canvas.create(Math.max(1, this.width), Math.max(1, this.height)),
      'canvas');
  }
  return this._nativeCanvas;
};
Object.defineProperty(CanvasElement.prototype, 'width', {
  get: function() { return this._width; },
  set: function(value) { this._width = Math.max(0, Number(value) | 0); this._releaseNativeCanvas(); }
});
Object.defineProperty(CanvasElement.prototype, 'height', {
  get: function() { return this._height; },
  set: function(value) { this._height = Math.max(0, Number(value) | 0); this._releaseNativeCanvas(); }
});
CanvasElement.prototype.getContext = function(type) {
  if (type === '2d') {
    if (!this._context2d) this._context2d = new CanvasContext2D(this);
    return this._context2d;
  }
  return null;
};
CanvasElement.prototype.toDataURL = function() {
  return 'data:image/png;base64,' +
    base64Bytes(NativeHost.canvas.encodePng(this._ensureNativeCanvas().handle));
};
CanvasElement.prototype.getBoundingClientRect = function() {
  return { left: 0, top: 0, width: this.width, height: this.height };
};

function GenericElement(tagName) {
  EventTarget.call(this);
  this.tagName = String(tagName).toUpperCase();
  this.style = {};
  this.children = [];
  this.parentNode = null;
}

GenericElement.prototype = Object.create(EventTarget.prototype);
GenericElement.prototype.constructor = GenericElement;
GenericElement.prototype.appendChild = function(child) {
  child.parentNode = this;
  this.children.push(child);
  return child;
};
GenericElement.prototype.removeChild = function(child) {
  var index = this.children.indexOf(child);
  if (index >= 0) this.children.splice(index, 1);
  child.parentNode = null;
  return child;
};
GenericElement.prototype.setAttribute = function(name, value) { this[name] = String(value); };
GenericElement.prototype.getAttribute = function(name) { return this[name] || null; };
GenericElement.prototype.getElementsByTagName = function() { return []; };

function AudioElement() {
  GenericElement.call(this, 'audio');
}

AudioElement.prototype = Object.create(GenericElement.prototype);
AudioElement.prototype.constructor = AudioElement;
AudioElement.prototype.canPlayType = function(type) {
  return /^audio\//.test(String(type)) ? 'maybe' : '';
};

var nativeVideos = [];
var nativeVideoFinalizer = typeof FinalizationRegistry === 'function'
  ? new FinalizationRegistry(function(handles) {
      try { NativeHost.media.releaseVideo(handles.video); } catch (_) {}
      try { if (handles.audio) NativeHost.media.releaseAudio(handles.audio); } catch (_) {}
    }) : null;
function VideoElement() {
  GenericElement.call(this, 'video');
  this._src = ''; this._media = null; this._nativeCanvas = null;
  this._currentTime = 0; this._startedAt = 0; this._startOffset = 0;
  this.duration = 0; this.videoWidth = 0; this.videoHeight = 0;
  this.width = 0; this.height = 0; this._volume = 1; this._playbackRate = 1;
  this.loop = false; this._muted = false; this.paused = true; this.ended = false;
  this.readyState = 0; this.HAVE_ENOUGH_DATA = 4;
}
VideoElement.prototype = Object.create(GenericElement.prototype);
VideoElement.prototype.constructor = VideoElement;
Object.defineProperty(VideoElement.prototype, 'src', {
  get: function() { return this._src; },
  set: function(value) { this._src = String(value); }
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
VideoElement.prototype.load = function() {
  if (nativeVideoFinalizer) nativeVideoFinalizer.unregister(this);
  if (this._media) NativeHost.media.releaseVideo(this._media.handle);
  if (this._audio) NativeHost.media.releaseAudio(this._audio.handle);
  var source = this._src;
  if (!source && this.children.length) source = this.children[0].src || '';
  var encoded = source.split('?')[0].replace(/%(?![0-9a-f]{2})/gi, '%25');
  var path = decodeURIComponent(encoded).replace(/^file:\/\/\/game\//, '').replace(/^\.\//, '');
  try {
    this._media = NativeHost.media.loadVideo(path);
    try { this._audio = NativeHost.media.loadAudio(path); } catch (_) { this._audio = null; }
    if (nativeVideoFinalizer) nativeVideoFinalizer.register(this, {
      video: this._media.handle, audio: this._audio && this._audio.handle
    }, this);
    this._nativeCanvas = { handle: this._media.canvas,
      width: this._media.width, height: this._media.height };
    this.videoWidth = this._media.width; this.videoHeight = this._media.height;
    if (!this.width) this.width = this.videoWidth;
    if (!this.height) this.height = this.videoHeight;
    this.duration = this._media.duration; this.readyState = this.HAVE_ENOUGH_DATA;
    this.ended = false;
    if (typeof this.onloadeddata === 'function') this.onloadeddata({ type: 'loadeddata', target: this });
    this.dispatchEvent({ type: 'loadeddata', target: this });
    this.dispatchEvent({ type: 'canplay', target: this });
    this.dispatchEvent({ type: 'canplaythrough', target: this });
  } catch (error) {
    if (typeof this.onerror === 'function') this.onerror({ type: 'error', target: this, error: error });
    this.dispatchEvent({ type: 'error', target: this, error: error });
  }
};
VideoElement.prototype.play = function() {
  if (!this._media) this.load();
  this.paused = false; this.ended = false; this._startOffset = this._currentTime;
  this._startedAt = performance.now();
  if (this._audio) {
    NativeHost.media.setAudioParameters(this._audio.handle,
      this._muted ? 0 : this._volume, this._playbackRate, 0);
    NativeHost.media.playAudio(this._audio.handle, this.loop, this._currentTime);
  }
  if (nativeVideos.indexOf(this) < 0) nativeVideos.push(this);
  this.dispatchEvent({ type: 'play', target: this });
  return Promise.resolve();
};
VideoElement.prototype.pause = function() {
  this._currentTime = this.currentTime; this.paused = true;
  if (this._audio) NativeHost.media.stopAudio(this._audio.handle);
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
      if (typeof this.onended === 'function') this.onended({ type: 'ended', target: this });
      this.dispatchEvent({ type: 'ended', target: this }); return false;
    }
  }
  var frameTime = Math.floor(time * 30) / 30;
  if (frameTime !== this._decodedTime) {
    this._decodedTime = NativeHost.media.updateVideo(this._media.handle, frameTime);
  }
  return true;
};

function NativeImage() {
  EventTarget.call(this);
  this.width = 0;
  this.height = 0;
  this.naturalWidth = 0;
  this.naturalHeight = 0;
  this.complete = false;
  this._src = '';
  this._nativeImage = null;
  this._loadGeneration = 0;
  this._pmjsLoadFailed = false;
  this._pmjsLoadError = null;
}

var pendingNativeImageLoads = 0;
// EasyRPG-style: once a path fails, cache the failure so every subsequent
// request for that path is immediately stable (no repeated decode attempts,
// no first-request/second-request inconsistency).
var failedAssetCache = new Map();

NativeImage.prototype = Object.create(EventTarget.prototype);
NativeImage.prototype.constructor = NativeImage;
function nativeImageFromResource(resource) {
  if (!resource) return null;
  var image = new NativeImage();
  image._nativeImage = trackNativeResource(resource, 'image');
  image._pmjsOwnedTextureSource = true;
  image.width = image.naturalWidth = Number(resource.width) || 0;
  image.height = image.naturalHeight = Number(resource.height) || 0;
  image.complete = true;
  return image;
}
Object.defineProperty(NativeImage.prototype, 'src', {
  get: function() { return this._src; },
  set: function(url) {
    this._src = String(url);
    var source = this._src;
    var generation = ++this._loadGeneration;
    if (!this._src) {
      releaseNativeResource(this._nativeImage, 'image');
      this._nativeImage = null;
      this.width = this.height = this.naturalWidth = this.naturalHeight = 0;
      this.complete = false;
      return;
    }
    var objectUrl = source.indexOf('blob:pmjs/') === 0;
    var encodedPath = source.split('?')[0].replace(/%(?![0-9a-f]{2})/gi, '%25');
    var path = decodeURIComponent(encodedPath)
      .replace(/^file:\/\/\/game\//, '')
      .replace(/^\.\//, '');
    var image = this;
    image.complete = false;
    image._pmjsLoadFailed = false;
    image._pmjsLoadError = null;
    pendingTasks.push(function() {
      if (objectUrl) {
        pendingNativeImageLoads++;
        var objectBlob = typeof globalThis.__pmjsResolveObjectURL === 'function'
          ? globalThis.__pmjsResolveObjectURL(source) : null;
        var objectLoad = objectBlob
          ? objectBlob.arrayBuffer().then(function(buffer) {
              var retain = typeof globalThis.__pmjsShouldRetainImagePixels === 'function' &&
                globalThis.__pmjsShouldRetainImagePixels(source);
              return NativeHost.images.loadBytesAsync(buffer, retain);
            })
          : Promise.reject(new Error('object URL is unavailable'));
        objectLoad.then(function(result) {
          var loaded = trackNativeResource(result, 'image');
          if (generation !== image._loadGeneration) {
            releaseNativeResource(loaded, 'image');
            return;
          }
          releaseNativeResource(image._nativeImage, 'image');
          image._nativeImage = loaded;
          image.width = image.naturalWidth = loaded.width;
          image.height = image.naturalHeight = loaded.height;
          image.complete = true;
          if (typeof image.onload === 'function') image.onload({ type: 'load', target: image });
          image.dispatchEvent({ type: 'load', target: image });
          if (typeof globalThis.__pmjsImageLoadCompleted === 'function') {
            globalThis.__pmjsImageLoadCompleted(image);
          }
        }, function(error) {
          if (generation !== image._loadGeneration) return;
          releaseNativeResource(image._nativeImage, 'image');
          image._nativeImage = null;
          image.width = image.naturalWidth = 0;
          image.height = image.naturalHeight = 0;
          image.complete = true;
          image._pmjsLoadFailed = true;
          image._pmjsLoadError = error;
          if (typeof image.onerror === 'function') image.onerror({ type: 'error', target: image });
          image.dispatchEvent({ type: 'error', target: image });
        }).then(function() { pendingNativeImageLoads--; }, function(error) {
          pendingNativeImageLoads--;
          console.error(error && error.stack || error);
        });
        return;
      }
      var generatedPrefix = 'generated-assets:/';
      var generated = path.indexOf(generatedPrefix) === 0;
      var relativePath = generated ? path.slice(generatedPrefix.length) : path;
      var loader = generated ? NativeHost.assets : NativeHost.images;
      var load = generated ? loader.loadImage : loader.load;
      var loadAsync = generated ? loader.loadImageAsync : loader.loadAsync;
      var retainCpuPixels = typeof globalThis.__pmjsShouldRetainImagePixels ===
        'function' && globalThis.__pmjsShouldRetainImagePixels(path);

      // EasyRPG pattern: stable failure cache. If this path already failed,
      // install the fallback immediately without re-hitting disk or the decoder.
      var cachedFailure = failedAssetCache.get(path);
      if (cachedFailure !== undefined) {
        if (generation !== image._loadGeneration) return;
        releaseNativeResource(image._nativeImage, 'image');
        image._nativeImage = null;
        try {
          if (typeof NativeHost !== 'undefined' && NativeHost.images &&
              typeof NativeHost.images.fallbackImage === 'function') {
            image._nativeImage = trackNativeResource(NativeHost.images.fallbackImage(), 'image');
          }
        } catch (_) {}
        // Keep dimensions at 0: preserve genuine browser failure semantics so
        // RPG Maker sprite frame math (naturalWidth / columns) is not corrupted.
        image.width = image.naturalWidth = 0;
        image.height = image.naturalHeight = 0;
        image.complete = true;
        image._pmjsLoadFailed = true;
        image._pmjsLoadError = cachedFailure;
        if (typeof image.onerror === 'function') image.onerror({ type: 'error', target: image });
        image.dispatchEvent({ type: 'error', target: image });
        return;
      }

      pendingNativeImageLoads++;
      new Promise(function(resolve) {
        resolve(typeof loadAsync === 'function'
          ? loadAsync.call(loader, relativePath, retainCpuPixels)
          : load.call(loader, relativePath, retainCpuPixels));
      }).then(function(result) {
        var loaded = trackNativeResource(result, 'image');
        if (generation !== image._loadGeneration) {
          releaseNativeResource(loaded, 'image');
          return;
        }
        releaseNativeResource(image._nativeImage, 'image');
        image._nativeImage = loaded;
        image.width = image.naturalWidth = image._nativeImage.width;
        image.height = image.naturalHeight = image._nativeImage.height;
        image.complete = true;
        image._pmjsLoadFailed = false;
        image._pmjsLoadError = null;
        if (typeof image.onload === 'function') image.onload({ type: 'load', target: image });
        image.dispatchEvent({ type: 'load', target: image });
        if (typeof globalThis.__pmjsImageLoadCompleted === 'function') {
          globalThis.__pmjsImageLoadCompleted(image);
        }
      }, function(error) {
        if (generation !== image._loadGeneration) return;
        // On first failure: record in the stable failure cache (EasyRPG model)
        // so subsequent requests for the same path are immediately consistent.
        if (!failedAssetCache.has(path)) {
          failedAssetCache.set(path, error);
          console.warn('[pmjs] image load failed, rendering fallback checkerboard: ' + path +
            (error ? ' (' + (error.message || error) + ')' : ''));
        }
        releaseNativeResource(image._nativeImage, 'image');
        image._nativeImage = null;
        try {
          if (typeof NativeHost !== 'undefined' && NativeHost.images &&
              typeof NativeHost.images.fallbackImage === 'function') {
            image._nativeImage = trackNativeResource(NativeHost.images.fallbackImage(), 'image');
          }
        } catch (_) {}
        // Keep dimensions at 0: preserve genuine browser failure semantics so
        // RPG Maker sprite frame math (naturalWidth / columns) is not corrupted.
        image.width = image.naturalWidth = 0;
        image.height = image.naturalHeight = 0;
        image.complete = true;
        image._pmjsLoadFailed = true;
        image._pmjsLoadError = error;
        if (typeof image.onerror === 'function') image.onerror({ type: 'error', target: image });
        image.dispatchEvent({ type: 'error', target: image });
      }).then(function() { pendingNativeImageLoads--; },
        function(err) {
          pendingNativeImageLoads--;
          console.error(err && err.stack || err);
        });
    });
  }
});

var documentTarget = new EventTarget();
globalThis.document = documentTarget;
documentTarget.readyState = 'complete';
documentTarget.title = pmjsGameConfig.title || 'pmjs';
documentTarget.hasFocus = function() { return nativeWindowState.focused; };
Object.defineProperty(documentTarget, 'hidden', {
  configurable: true,
  enumerable: true,
  get: function() { return !nativeWindowState.visible; }
});
Object.defineProperty(documentTarget, 'visibilityState', {
  configurable: true,
  enumerable: true,
  get: function() { return nativeWindowState.visible ? 'visible' : 'hidden'; }
});
documentTarget.documentElement = new GenericElement('html');
documentTarget.body = new GenericElement('body');
documentTarget.head = new GenericElement('head');
documentTarget.createElement = function(tagName) {
  var name = String(tagName).toLowerCase();
  if (name === 'canvas') return new CanvasElement();
  if (name === 'audio') return new AudioElement();
  if (name === 'video') return new VideoElement();
  var element = new GenericElement(tagName);
  if (name === 'style') element.sheet = { insertRule: function() {} };
  return element;
};
documentTarget.createTextNode = function(text) {
  var node = new GenericElement('#text');
  node.textContent = String(text);
  return node;
};
documentTarget.getElementById = function() { return null; };
documentTarget.getElementsByTagName = function(tagName) {
  var elements = String(tagName).toLowerCase() === 'head' ? [this.head] : [];
  elements.item = function(index) { return this[index] || null; };
  return elements;
};

globalThis.EventTarget = EventTarget;
globalThis.HTMLCanvasElement = CanvasElement;
globalThis.HTMLImageElement = NativeImage;
globalThis.HTMLVideoElement = VideoElement;
globalThis.Image = NativeImage;
globalThis.CanvasRenderingContext2D = CanvasContext2D;
globalThis.addEventListener = EventTarget.prototype.addEventListener.bind(documentTarget);
globalThis.removeEventListener = EventTarget.prototype.removeEventListener.bind(documentTarget);
globalThis.dispatchEvent = EventTarget.prototype.dispatchEvent.bind(documentTarget);
