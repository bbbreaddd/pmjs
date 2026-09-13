function NativePrepareTimeLimiter(maxMilliseconds) {
  this.maxMilliseconds = maxMilliseconds;
  this.frameStart = 0;
}
NativePrepareTimeLimiter.prototype.beginFrame = function() {
  this.frameStart = performance.now();
};
NativePrepareTimeLimiter.prototype.allowedToUpload = function() {
  return performance.now() - this.frameStart < this.maxMilliseconds;
};

function NativePrepareCountLimiter(maxItemsPerFrame) {
  this.maxItemsPerFrame = maxItemsPerFrame;
  this.itemsLeft = 0;
}
NativePrepareCountLimiter.prototype.beginFrame = function() {
  this.itemsLeft = this.maxItemsPerFrame;
};
NativePrepareCountLimiter.prototype.allowedToUpload = function() {
  return this.itemsLeft-- > 0;
};

function nativePrepareSources(item, sources, seen) {
  if (!item || seen.indexOf(item) >= 0) return;
  seen.push(item);
  if (typeof item.updateText === 'function') item.updateText(true);
  var base = item.baseTexture || item._baseTexture || item.__baseTexture ||
    item.texture && item.texture.baseTexture;
  var source = base && base.source;
  if (source && sources.indexOf(source) < 0) sources.push(source);
  var children = item.children;
  if (children) {
    for (var index = 0; index < children.length; index++) {
      nativePrepareSources(children[index], sources, seen);
    }
  }
}

function NativePreparePlugin() {
  this.queue = [];
  this.completes = [];
  this.ticking = false;
  this.limiter = new NativePrepareCountLimiter(4);
  this._activeUploads = 0;
}
NativePreparePlugin.prototype.add = function(item) {
  if (item) this.queue.push(item);
  return this;
};
NativePreparePlugin.prototype.upload = function(item, done) {
  if (typeof item === 'function') {
    done = item;
    item = null;
  }
  if (item) this.queue.push(item);
  var queued = this.queue.splice(0);
  var sources = [];
  for (var index = 0; index < queued.length; index++) {
    nativePrepareSources(queued[index], sources, []);
  }
  var plugin = this;
  var remaining = 0;
  var complete = typeof done === 'function' ? done : function() {};
  plugin.completes.push(complete);
  plugin._activeUploads++;
  plugin.ticking = true;
  function finishOne() {
    if (--remaining > 0) return;
    var completeIndex = plugin.completes.indexOf(complete);
    if (completeIndex >= 0) plugin.completes.splice(completeIndex, 1);
    plugin._activeUploads--;
    plugin.ticking = plugin._activeUploads > 0;
    pendingTasks.push(complete);
  }
  for (index = 0; index < sources.length; index++) {
    var source = sources[index];
    if (source.complete !== false) continue;
    remaining++;
    (function(pendingSource) {
      function loaded() {
        pendingSource.removeEventListener('load', loaded);
        pendingSource.removeEventListener('error', loaded);
        finishOne();
      }
      pendingSource.addEventListener('load', loaded);
      pendingSource.addEventListener('error', loaded);
    })(source);
  }
  if (!remaining) {
    remaining = 1;
    finishOne();
  }
  return this;
};
NativePreparePlugin.prototype.destroy = function() {
  this.queue.length = 0;
  this.completes.length = 0;
  this.ticking = false;
};

PIXI.prepare = PIXI.prepare || {};
PIXI.prepare.TimeLimiter = PIXI.prepare.TimeLimiter || NativePrepareTimeLimiter;
PIXI.prepare.CountLimiter = PIXI.prepare.CountLimiter || NativePrepareCountLimiter;
var nativeRendererContextUid = 0;

function NativeMaskManager(renderer) {
  this.renderer = renderer;
  this.maskStack = [];
  this.scissor = false;
  this.scissorData = null;
  this.scissorRenderTarget = null;
  this.enableScissor = true;
  this.alphaMaskPool = [];
  this.alphaMaskIndex = 0;
}
NativeMaskManager.prototype.pushMask = function(target, maskData) {
  if (maskData && maskData.texture) return this.pushSpriteMask(target, maskData);
  if (this.enableScissor && !this.scissor && maskData &&
      typeof maskData.isFastRect === 'function' && maskData.isFastRect()) {
    return this.pushScissorMask(target, maskData);
  }
  return this.pushStencilMask(maskData);
};
NativeMaskManager.prototype.popMask = function(target, maskData) {
  var entry = this.maskStack[this.maskStack.length - 1];
  if (entry && entry.sprite) return this.popSpriteMask(target, maskData);
  if (entry && entry.scissor) return this.popScissorMask(target, maskData);
  return this.popStencilMask(target, maskData);
};
NativeMaskManager.prototype.pushScissorMask = function(target, maskData) {
  this.maskStack.push({ target: target, mask: maskData, scissor: true });
  this.scissor = true;
  this.scissorData = maskData;
  this.scissorRenderTarget = this.renderer._activeRenderTarget;
};
NativeMaskManager.prototype.popScissorMask = function() {
  var entry = this.maskStack.pop();
  this.scissor = false;
  this.scissorData = null;
  this.scissorRenderTarget = null;
  for (var index = this.maskStack.length - 1; index >= 0; index--) {
    if (this.maskStack[index].scissor) {
      this.scissor = true;
      this.scissorData = this.maskStack[index].mask;
      this.scissorRenderTarget = this.renderer._activeRenderTarget;
      break;
    }
  }
  return entry;
};
NativeMaskManager.prototype.pushSpriteMask = function(target, maskData) {
  this.maskStack.push({ target: target, mask: maskData, sprite: true });
  this.alphaMaskIndex++;
};
NativeMaskManager.prototype.popSpriteMask = function() {
  this.alphaMaskIndex = Math.max(0, this.alphaMaskIndex - 1);
  return this.maskStack.pop();
};
NativeMaskManager.prototype.pushStencilMask = function(maskData) {
  this.maskStack.push({ mask: maskData, stencil: true });
  this.renderer.stencilManager.pushStencil(maskData);
};
NativeMaskManager.prototype.popStencilMask = function() {
  this.renderer.stencilManager.popStencil();
  return this.maskStack.pop();
};
NativeMaskManager.prototype.destroy = function() {
  this.maskStack.length = 0;
  this.renderer = null;
};
NativeMaskManager.prototype.onContextChange = function() {};

function NativeFilterManager(renderer) {
  this.renderer = renderer;
  this.filterData = { index: 0, stack: [] };
  this.pool = {};
  this.managedFilters = [];
  this.shaderCache = {};
  this.gl = renderer.gl;
  this._onPrerender = this.onPrerender.bind(this);
  if (typeof renderer.on === 'function') renderer.on('prerender', this._onPrerender);
}
NativeFilterManager.prototype.pushFilter = function(target, filters) {
  filters = filters || [];
  var sourceFrame = target && target.filterArea;
  if (!sourceFrame && target && typeof target.getBounds === 'function') {
    sourceFrame = target.getBounds(true);
  }
  sourceFrame = sourceFrame || this.renderer.screen;
  sourceFrame = new PIXI.Rectangle(sourceFrame.x || 0, sourceFrame.y || 0,
    sourceFrame.width || 0, sourceFrame.height || 0);
  var resolution = this.renderer.resolution;
  for (var index = 0; index < filters.length; index++) {
    if (filters[index] && Number(filters[index].resolution) > 0) {
      resolution = Math.min(resolution, Number(filters[index].resolution));
    }
  }
  this.filterData.stack.push({ target: target, filters: filters,
    sourceFrame: sourceFrame,
    destinationFrame: new PIXI.Rectangle(sourceFrame.x, sourceFrame.y,
      sourceFrame.width, sourceFrame.height),
    resolution: resolution,
    renderTarget: this.renderer._activeRenderTarget });
  this.filterData.index = this.filterData.stack.length;
};
NativeFilterManager.prototype.popFilter = function() {
  var entry = this.filterData.stack.pop();
  this.filterData.index = this.filterData.stack.length;
  return entry;
};
NativeFilterManager.prototype.getRenderTarget = function(clear, resolution) {
  resolution = Math.max(0.000001, Number(resolution) || this.renderer.resolution);
  var state = this.currentState();
  var frame = state && state.sourceFrame || this.renderer.screen;
  var width = Math.max(1, Number(frame.width) || 1);
  var height = Math.max(1, Number(frame.height) || 1);
  var key = width + 'x' + height + '@' + resolution;
  var targets = this.pool[key];
  var target = targets && targets.length ? targets.pop() :
    PIXI.RenderTexture.create(width, height, PIXI.SCALE_MODES.LINEAR, resolution);
  if (clear) this.renderer.clearRenderTexture(target);
  return target;
};
NativeFilterManager.prototype.returnRenderTarget = function(target) {
  if (!target || !target.baseTexture) return;
  var resolution = Number(target.baseTexture.resolution) || 1;
  var key = target.width + 'x' + target.height + '@' + resolution;
  var pool = this.pool[key];
  if (!pool) {
    pool = [];
    this.pool[key] = pool;
  }
  pool.push(target);
};
NativeFilterManager.prototype.applyFilter = function(filter) {
  nativeCompatibilityHit('renderer.filter-manager',
    filter && filter.constructor && filter.constructor.name || 'Filter');
};
NativeFilterManager.prototype.syncUniforms = function(shader, filter) {
  nativeCompatibilityHit('renderer.filter-uniforms',
    filter && filter.constructor && filter.constructor.name || 'Filter');
};
NativeFilterManager.prototype.getPotRenderTarget = function(gl, width, height,
    resolution) {
  resolution = Math.max(0.000001, Number(resolution) || this.renderer.resolution);
  width = Math.max(1, Number(width) || 1);
  height = Math.max(1, Number(height) || 1);
  var key = width + 'x' + height + '@' + resolution;
  var targets = this.pool[key];
  if (targets && targets.length) return targets.pop();
  return PIXI.RenderTexture.create(width, height,
    PIXI.SCALE_MODES.LINEAR, resolution);
};
NativeFilterManager.prototype.freePotRenderTarget = function(target) {
  this.returnRenderTarget(target);
};
NativeFilterManager.prototype.onPrerender = function() {
  var width = this.renderer.view.width;
  var height = this.renderer.view.height;
  if (this._screenWidth === width && this._screenHeight === height) return;
  this._screenWidth = width;
  this._screenHeight = height;
  this.emptyPool();
};
NativeFilterManager.prototype.currentState = function() {
  return this.filterData.stack[this.filterData.index - 1] || null;
};
NativeFilterManager.prototype.calculateScreenSpaceMatrix = function(outputMatrix) {
  var state = this.currentState();
  if (!state) return outputMatrix.identity();
  var size = state.renderTarget.size || state.renderTarget;
  return outputMatrix.identity()
    .translate(state.sourceFrame.x / size.width,
      state.sourceFrame.y / size.height)
    .scale(size.width, size.height);
};
NativeFilterManager.prototype.calculateNormalizedScreenSpaceMatrix =
    function(outputMatrix) {
  var state = this.currentState();
  if (!state) return outputMatrix.identity();
  var size = state.renderTarget.size || state.renderTarget;
  return outputMatrix.identity()
    .translate(state.sourceFrame.x / size.width,
      state.sourceFrame.y / size.height)
    .scale(size.width / state.sourceFrame.width,
      size.height / state.sourceFrame.height);
};
NativeFilterManager.prototype.calculateSpriteMatrix = function(outputMatrix, sprite) {
  var state = this.currentState();
  if (!state || !sprite || !sprite._texture) return outputMatrix.identity();
  var size = state.renderTarget.size || state.renderTarget;
  var frame = state.sourceFrame;
  outputMatrix.set(size.width, 0, 0, size.height, frame.x, frame.y);
  var world = sprite.worldTransform.clone ? sprite.worldTransform.clone() :
    sprite.worldTransform.copy(new PIXI.Matrix());
  outputMatrix.prepend(world.invert());
  outputMatrix.scale(1 / sprite._texture.orig.width,
    1 / sprite._texture.orig.height);
  outputMatrix.translate(sprite.anchor.x, sprite.anchor.y);
  return outputMatrix;
};
NativeFilterManager.prototype.emptyPool = function() {
  Object.keys(this.pool).forEach(function(key) {
    var targets = this.pool[key];
    for (var index = 0; index < targets.length; index++) targets[index].destroy(true);
  }, this);
  this.pool = {};
};
NativeFilterManager.prototype.destroy = function() {
  if (this.renderer && typeof this.renderer.off === 'function') {
    this.renderer.off('prerender', this._onPrerender);
  }
  this.emptyPool();
  this.filterData.stack.length = 0;
  this.managedFilters.length = 0;
  this.shaderCache = {};
  this.gl = null;
  this._onPrerender = null;
  this.renderer = null;
};
NativeFilterManager.prototype.onContextChange = function() {};

function NativeRenderTextureManager(renderer) {
  this.renderer = renderer;
  this.current = null;
}
NativeRenderTextureManager.prototype.bind = function(renderTexture) {
  this.current = renderTexture || null;
  this.renderer._activeRenderTarget = renderTexture ?
    nativeRenderTargetFor(this.renderer, renderTexture) :
    this.renderer.rootRenderTarget;
};
NativeRenderTextureManager.prototype.clear = function(clearColor) {
  if (this.current) this.renderer.clearRenderTexture(this.current, clearColor);
  else this.renderer.clear(clearColor);
};
NativeRenderTextureManager.prototype.destroy = function() {
  this.current = null;
  this.renderer = null;
};

function createNativeRenderTarget(renderer, width, height, resolution, root) {
  var target = {
    renderer: renderer, root: !!root,
    resolution: Math.max(0.000001, Number(resolution) || 1),
    width: width, height: height,
    size: new PIXI.Rectangle(0, 0, width, height),
    defaultFrame: new PIXI.Rectangle(0, 0, width, height),
    destinationFrame: null, sourceFrame: null, frame: null,
    projectionMatrix: new PIXI.Matrix(), transform: null,
    clearColor: [0, 0, 0, 0], stencilMaskStack: [],
    filterData: null, filterPoolKey: '',
    attachStencilBuffer: function() { return this; },
    setFrame: function(destinationFrame, sourceFrame) {
      this.destinationFrame = destinationFrame || this.destinationFrame ||
        this.defaultFrame;
      this.sourceFrame = sourceFrame || this.sourceFrame || this.destinationFrame;
      return this;
    },
    calculateProjection: function(destinationFrame, sourceFrame) {
      destinationFrame = destinationFrame || this.destinationFrame || this.defaultFrame;
      sourceFrame = sourceFrame || destinationFrame;
      var matrix = this.projectionMatrix.identity();
      matrix.a = 2 / destinationFrame.width;
      matrix.d = (this.root ? -2 : 2) / destinationFrame.height;
      matrix.tx = -1 - sourceFrame.x * matrix.a;
      matrix.ty = (this.root ? 1 : -1) - sourceFrame.y * matrix.d;
      return matrix;
    },
    activate: function() {
      this.calculateProjection(this.destinationFrame, this.sourceFrame);
      if (this.transform) this.projectionMatrix.append(this.transform);
      this.renderer.bindRenderTarget(this);
      return this;
    },
    clear: function(clearColor) {
      this.renderer.clear(clearColor || this.clearColor);
      return this;
    },
    resize: function(nextWidth, nextHeight) {
      this.width = nextWidth | 0;
      this.height = nextHeight | 0;
      this.size.width = this.defaultFrame.width = this.width;
      this.size.height = this.defaultFrame.height = this.height;
      this.calculateProjection(this.destinationFrame || this.defaultFrame,
        this.sourceFrame || this.defaultFrame);
      return this;
    },
    destroy: function() {
      this.renderer = null;
      this.stencilMaskStack.length = 0;
    }
  };
  target.setFrame();
  target.calculateProjection(target.destinationFrame, target.sourceFrame);
  return target;
}

function nativeRenderTargetFor(renderer, renderTexture) {
  var base = renderTexture.baseTexture;
  base._glRenderTargets = base._glRenderTargets || {};
  var target = base._glRenderTargets[renderer.CONTEXT_UID];
  var resolution = Number(base.resolution) || 1;
  if (!target) {
    target = base._glRenderTargets[renderer.CONTEXT_UID] = createNativeRenderTarget(
      renderer, renderTexture.width, renderTexture.height, resolution, false);
  } else if (target.width !== renderTexture.width ||
      target.height !== renderTexture.height || target.resolution !== resolution) {
    target.resolution = resolution;
    target.resize(renderTexture.width, renderTexture.height);
  }
  return target;
}

function NativeObjectRenderer(renderer, name) {
  this.renderer = renderer;
  this.name = name;
  this.CONTEXT_UID = renderer.CONTEXT_UID;
  this.tileAnim = [0, 0];
  this.dontUseTransform = false;
}
NativeObjectRenderer.prototype.start = function() {};
NativeObjectRenderer.prototype.onContextChange = function() {};
NativeObjectRenderer.prototype.stop = function() {};
NativeObjectRenderer.prototype.flush = function() {};
NativeObjectRenderer.prototype.render = function(displayObject) {
  nativeCompatibilityHit('renderer.object-plugin', this.name);
  if (displayObject) queueNativeTree(displayObject);
};
NativeObjectRenderer.prototype.updateGraphics = function(graphics) {
  return ensureNativeGraphics(graphics, false);
};
NativeObjectRenderer.prototype.destroy = function() {
  this.renderer = null;
};

function installNativeRendererPlugins(renderer) {
  var plugins = {
    extract: renderer.extract,
    prepare: new NativePreparePlugin()
  };
  var registered = OriginalPixiWebGLRenderer.__plugins || {};
  Object.keys(registered).forEach(function(name) {
    // Native input owns DOM interaction and accessibility manager behavior.
    if (name === 'extract' || name === 'prepare' ||
        name === 'interaction' || name === 'accessibility') return;
    plugins[name] = new NativeObjectRenderer(renderer, name);
  });
  // pixi-tilemap registers before the native facade and expects this state slot.
  if (!plugins.tilemap) plugins.tilemap = new NativeObjectRenderer(renderer,
    'tilemap');
  return plugins;
}

function NativeTextureGarbageCollector(renderer) {
  this.renderer = renderer;
  this.count = 0;
  this.checkCount = 0;
  this.maxIdle = Number(PIXI.settings && PIXI.settings.GC_MAX_IDLE) || 3600;
  this.checkCountMax = Number(PIXI.settings && PIXI.settings.GC_MAX_CHECK_COUNT) || 600;
  this.mode = PIXI.settings && PIXI.settings.GC_MODE;
}
NativeTextureGarbageCollector.prototype.update = function() {
  this.count++;
  if (PIXI.GC_MODES && this.mode === PIXI.GC_MODES.MANUAL) return;
  if (++this.checkCount > this.checkCountMax) {
    this.checkCount = 0;
    this.run();
  }
};
NativeTextureGarbageCollector.prototype.run = function() {
  var manager = this.renderer.textureManager;
  var textures = manager._managedTextures.slice();
  for (var index = 0; index < textures.length; index++) {
    var texture = textures[index];
    if (texture && !texture._glRenderTargets &&
        this.count - (Number(texture.touched) || 0) > this.maxIdle) {
      manager.destroyTexture(texture, true);
    }
  }
};
NativeTextureGarbageCollector.prototype.unload = function(displayObject) {
  if (!displayObject) return;
  if (displayObject._texture && displayObject._texture._glRenderTargets) {
    this.renderer.textureManager.destroyTexture(displayObject._texture, true);
  }
  var children = displayObject.children || [];
  for (var index = children.length - 1; index >= 0; index--) {
    this.unload(children[index]);
  }
};
