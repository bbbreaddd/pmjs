var nativeCustomFilterPlans = [];
var nativeCustomFilterDefaultVertex = 'attribute vec2 aVertexPosition;\n' +
  'attribute vec2 aTextureCoord;\nuniform mat3 projectionMatrix;\n' +
  'varying vec2 vTextureCoord;\nvoid main(){\n' +
  'gl_Position=vec4((projectionMatrix*vec3(aVertexPosition,1.0)).xy,0.0,1.0);\n' +
  'vTextureCoord=aTextureCoord;\n}';

var nativeCustomFilterShaderCache = Object.create(null);
function nativeResolveFilterProgram(filter) {
  var renderer = globalThis.Graphics && Graphics._renderer;
  var context = renderer && renderer.CONTEXT_UID || 0;
  var cache = renderer && renderer.filterManager && renderer.filterManager.shaderCache ||
    nativeCustomFilterShaderCache;
  var shaders = filter.glShaders || (filter.glShaders = {});
  var shader = shaders[context];
  if (!shader && filter.glShaderKey) shader = cache[filter.glShaderKey];
  if (!shader) {
    var fragment = Array.isArray(filter.fragmentSrc) ? filter.fragmentSrc.join('\n') : String(filter.fragmentSrc);
    var vertex = filter.vertexSrc || nativeCustomFilterDefaultVertex;
    if (Array.isArray(vertex)) vertex = vertex.join('\n');
    var key = vertex + '\u0000' + fragment;
    var program = nativeCustomFilterPrograms.get(key);
    if (!program) {
      program = NativeHost.render.createFilterProgram(fragment, vertex);
      nativeCustomFilterPrograms.set(key, program);
    }
    shader = { _pmjsFilterProgram: program,
      uniforms: Object.create(null),
      bind: function() { PMJS.compat.hit('renderer.shader-bind', 'direct filter shader'); },
      destroy: function() { this._pmjsFilterProgram = null; } };
    if (filter.glShaderKey) cache[filter.glShaderKey] = shader;
  }
  shaders[context] = shader;
  if (!shader._pmjsFilterProgram) throw new Error('filter shader is destroyed or has no native program');
  return shader._pmjsFilterProgram;
}

function nativeRecordCustomFilter(filter, node, filters) {
  filters = filters || [filter];
  var resolution = filter.resolution === undefined ? 1 : Number(filter.resolution);
  var padding = filter.padding === undefined ? 4 : Number(filter.padding) | 0;
  if (!Number.isFinite(resolution) || resolution <= 0 || resolution > 16 || padding < 0) return null;
  var bounds = node.filterArea || (node.getBounds && node.getBounds(true));
  if (!bounds) return null;
  var frame = { x: (bounds.x * resolution | 0) / resolution,
    y: (bounds.y * resolution | 0) / resolution,
    width: (bounds.width * resolution | 0) / resolution,
    height: (bounds.height * resolution | 0) / resolution };
  var screenWidth = Number(globalThis.Graphics && (Graphics.width || Graphics._width)) || 816;
  var screenHeight = Number(globalThis.Graphics && (Graphics.height || Graphics._height)) || 624;
  if (filter.autoFit !== false) {
    var right = Math.min(screenWidth, frame.x + frame.width);
    var bottom = Math.min(screenHeight, frame.y + frame.height);
    frame.x = Math.max(0, frame.x); frame.y = Math.max(0, frame.y);
    frame.width = Math.max(0, right - frame.x); frame.height = Math.max(0, bottom - frame.y);
  }
  frame.x -= padding; frame.y -= padding;
  frame.width += padding * 2; frame.height += padding * 2;
  var plan = { frame: [frame.x, frame.y, frame.width, frame.height],
    resolutions: [resolution, 1], passes: [] };
  var targets = [], pool = [];
  function target(index, targetResolution) {
    function pot(value) { var size = 1; while (size < value) size *= 2; return size; }
    var result = { _nativeFilterTarget: index, resolution: targetResolution,
      size: { width: pot(frame.width * targetResolution) / targetResolution,
        height: pot(frame.height * targetResolution) / targetResolution },
      sourceFrame: frame, destinationFrame: { x: 0, y: 0, width: frame.width, height: frame.height },
      transform: null };
    targets.push(result);
    return result;
  }
  var input = target(0, resolution), output = target(1, 1);
  var state = { sourceFrame: frame, destinationFrame: input.destinationFrame,
    renderTarget: input, resolution: resolution, target: node, filters: [filter] };
  var manager = {
    filterData: { index: 1, stack: [null, state] },
    renderer: { resolution: 1, width: screenWidth, height: screenHeight, screen: { x: 0, y: 0, width: screenWidth, height: screenHeight } },
    currentState: function() { return state; },
    getRenderTarget: function(clear, requestedResolution) {
      var requested = Number(requestedResolution) || resolution;
      for (var i = 0; i < pool.length; i++) {
        if (pool[i].resolution === requested) return pool.splice(i, 1)[0];
      }
      var index = plan.resolutions.length;
      plan.resolutions.push(requested);
      return target(index, requested);
    },
    returnRenderTarget: function(value) {
      if (targets.indexOf(value) < 0 || value === output || pool.indexOf(value) >= 0)
        throw new Error('invalid returned filter target');
      pool.push(value);
    },
    getPotRenderTarget: function(gl, width, height, requestedResolution) {
      if (width !== frame.width || height !== frame.height)
        throw new Error('filter target dimensions differ from source frame');
      return this.getRenderTarget(false, requestedResolution);
    },
    applyFilter: function(passFilter, passInput, passOutput, clear) {
      if (targets.indexOf(passInput) < 0 || targets.indexOf(passOutput) < 0 ||
          passInput === passOutput)
        throw new Error('invalid filter pass target or transform');
      var program = nativeResolveFilterProgram(passFilter);
      var pass = { program: program.handle, input: passInput._nativeFilterTarget,
        output: passOutput._nativeFilterTarget, clear: !!clear,
        blend: Number(passFilter.blendMode) || 0, uniforms: [], samplers: [] };
      var transform = passOutput.transform;
      if (transform) pass.transform = [transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty];
      for (var index = 0; index < program.uniforms.length; index++) {
        var uniform = program.uniforms[index];
        var value = passFilter.uniforms && passFilter.uniforms[uniform.name];
        if (uniform.sampler) {
          var values = uniform.size === 1 ? [value] : value;
          if (!values || values.length !== uniform.size) throw new Error('invalid filter sampler array');
          for (var samplerIndex = 0; samplerIndex < values.length; samplerIndex++) {
            var texture = values[samplerIndex];
            if (targets.indexOf(texture) >= 0) {
              pass.samplers.push({ image: 0, target: texture._nativeFilterTarget });
            } else if (texture === 0) {
              pass.samplers.push({ image: 0, target: pass.input });
            } else {
              var base = texture && texture.baseTexture;
              var image = base && nativeTextureSource(base.source);
              if (!image || !image.handle) throw new Error('filter sampler has no native image');
              pass.samplers.push({ image: image.handle, target: 0, nearest: base.scaleMode === PIXI.SCALE_MODES.NEAREST });
            }
          }
          continue;
        }
        if (typeof value === 'number' || typeof value === 'boolean') value = [Number(value)];
        else if (value && uniform.size === 2 && value.x !== undefined) value = [value.x, value.y];
        else if (value && uniform.size === 9 && value.a !== undefined) value = value.toArray(true);
        if (!value || value.length !== uniform.size) throw new Error('invalid filter uniform: ' + uniform.name);
        for (var component = 0; component < uniform.size; component++) {
          var number = Number(value[component]);
          if (!Number.isFinite(number)) throw new Error('invalid filter uniform: ' + uniform.name);
          pass.uniforms.push(number);
        }
      }
      plan.passes.push(pass);
    }
  };
  manager.freePotRenderTarget = manager.returnRenderTarget;
  if (typeof NativeFilterManager === 'function') {
    ['calculateScreenSpaceMatrix', 'calculateNormalizedScreenSpaceMatrix', 'calculateSpriteMatrix'].forEach(function(name) {
      manager[name] = NativeFilterManager.prototype[name];
    });
  }
  var flip = input;
  var flop = filters.length > 1 ? manager.getRenderTarget(true) : output;
  state.filters = filters;
  for (var filterIndex = 0; filterIndex < filters.length; filterIndex++) {
    var currentFilter = filters[filterIndex];
    var last = filterIndex === filters.length - 1;
    var destination = last ? output : flop;
    if (currentFilter.apply) currentFilter.apply(manager, flip, destination, !last, state);
    else manager.applyFilter(currentFilter, flip, destination, !last);
    if (!last) { flop = flip; flip = destination; }
  }
  var resource = NativeHost.render.createFilterPlan(plan);
  nativeCustomFilterPlans.push(resource);
  return { kind: 31, resource: resource.handle, parameters: [padding] };
}

var nativeCoreFilterContracts = [];
['ColorMatrixFilter', 'AlphaFilter', 'BlurFilter', 'BlurXFilter', 'BlurYFilter',
  'NoiseFilter', 'FXAAFilter'].forEach(function(name) {
  var Constructor = PIXI.filters && PIXI.filters[name];
  if (typeof Constructor !== 'function') return;
  var instance = new Constructor();
  if (instance.fragmentSrc) nativeCoreFilterContracts.push({ Constructor: Constructor,
    vertex: instance.vertexSrc, fragment: instance.fragmentSrc, apply: instance.apply });
});

function nativeFilterNeedsAuthoredProgram(filter) {
  if (!filter || !filter.fragmentSrc) return false;
  for (var index = 0; index < nativeCoreFilterContracts.length; index++) {
    var contract = nativeCoreFilterContracts[index];
    if (filter.constructor === contract.Constructor) {
      return filter.vertexSrc !== contract.vertex || filter.fragmentSrc !== contract.fragment ||
        filter.apply !== contract.apply;
    }
  }
  return true;
}

var nativeCustomFilterPrograms = new Map();
function nativeCustomFilterGroup(filter, node) {
  if (!filter || !filter.fragmentSrc ||
      typeof NativeHost.render.createFilterProgram !== 'function' ||
      typeof NativeHost.render.createFilterPlan !== 'function') return null;
  try { return nativeRecordCustomFilter(filter, node); }
  catch (error) {
    PMJS.compat.hit('render.filter-program', String(error.message || error));
    return null;
  }
}

function nativeSceneFilter(node, activeFilters) {
  if (!activeFilters.length) {
    return { blur: 0, groups: [], unsupported: false };
  }
  if (typeof NativeHost.render.createFilterPlan === 'function' &&
      activeFilters.some(function(filter) {
        return filter && filter.enabled !== false && nativeFilterNeedsAuthoredProgram(filter);
      })) {
    var actualFilters = activeFilters.filter(function(filter) { return filter && filter.enabled !== false; });
    if (actualFilters.length) {
      try {
        var actualGroup = nativeRecordCustomFilter(actualFilters[0], node, actualFilters);
        if (actualGroup) return { blur: 0, groups: [actualGroup], unsupported: false };
      } catch (error) {
        PMJS.compat.hit('render.filter-program', String(error.message || error));
        return { blur: 0, groups: [], unsupported: true, filters: actualFilters };
      }
    }
  }
  if (typeof NativeHost.render.createFilterPlan === 'function') {
    try {
      activeFilters.forEach(function(filter) {
        if (filter && filter.enabled !== false && filter.fragmentSrc) nativeResolveFilterProgram(filter);
      });
    } catch (error) {
      PMJS.compat.hit('render.filter-program', String(error.message || error));
      return { blur: 0, groups: [], unsupported: true, filters: activeFilters };
    }
  }
  var MvToneFilter = typeof ToneFilter === 'function' ? ToneFilter : null;
  var DisplacementFilter = PIXI.filters && PIXI.filters.DisplacementFilter;
  var NoiseFilter = PIXI.filters && PIXI.filters.NoiseFilter;
  var GlitchFilter = PIXI.filters && PIXI.filters.GlitchFilter;
  var ZoomBlurFilter = PIXI.filters && PIXI.filters.ZoomBlurFilter;
  var ShockwaveFilter = PIXI.filters && PIXI.filters.ShockwaveFilter;
  var AdvancedBloomFilter = PIXI.filters && PIXI.filters.AdvancedBloomFilter;
  var CRTFilter = PIXI.filters && PIXI.filters.CRTFilter;
  var AdjustmentFilter = PIXI.filters && PIXI.filters.AdjustmentFilter;
  var PixelateFilter = PIXI.filters && PIXI.filters.PixelateFilter;
  var RGBSplitFilter = PIXI.filters && PIXI.filters.RGBSplitFilter;
  var BulgePinchFilter = PIXI.filters && PIXI.filters.BulgePinchFilter;
  var TwistFilter = PIXI.filters && PIXI.filters.TwistFilter;
  var AsciiFilter = PIXI.filters && PIXI.filters.AsciiFilter;
  var DotFilter = PIXI.filters && PIXI.filters.DotFilter;
  var EmbossFilter = PIXI.filters && PIXI.filters.EmbossFilter;
  var CrossHatchFilter = PIXI.filters && PIXI.filters.CrossHatchFilter;
  var RadialBlurFilter = PIXI.filters && PIXI.filters.RadialBlurFilter;
  var ReflectionFilter = PIXI.filters && PIXI.filters.ReflectionFilter;
  var MotionBlurFilter = PIXI.filters && PIXI.filters.MotionBlurFilter;
  var AlphaFilter = PIXI.filters && PIXI.filters.AlphaFilter;
  var OldFilmFilter = PIXI.filters && PIXI.filters.OldFilmFilter;
  var GlowFilter = PIXI.filters && PIXI.filters.GlowFilter;
  var GodrayFilter = PIXI.filters && PIXI.filters.GodrayFilter;
  var KawaseBlurFilter = PIXI.filters && PIXI.filters.KawaseBlurFilter;
  var ColorMatrixFilter = PIXI.filters && PIXI.filters.ColorMatrixFilter;
  var BlurXFilter = PIXI.filters && PIXI.filters.BlurXFilter;
  var BlurYFilter = PIXI.filters && PIXI.filters.BlurYFilter;
  var FXAAFilter = PIXI.filters && PIXI.filters.FXAAFilter;
  var effectiveFilters = activeFilters.filter(function(filter) {
    if (!filter || filter.enabled === false) return false;
    if (AlphaFilter && filter instanceof AlphaFilter) {
      var filterAlpha = filter.alpha === undefined && filter.uniforms ?
        filter.uniforms.uAlpha : filter.alpha;
      if (filterAlpha === undefined) filterAlpha = 1;
      return Number(filterAlpha) !== 1;
    }
    if (nativeFilterMatches(filter, ColorMatrixFilter, 'ColorMatrixFilter') ||
        nativeFilterMatches(filter, MvToneFilter, 'ToneFilter')) {
      var colorAlpha = filter.alpha === undefined && filter.uniforms ?
        filter.uniforms.uAlpha : filter.alpha;
      if (Number(colorAlpha) === 0) return false;
      var colorValues = filter.matrix || filter.uniforms && filter.uniforms.m;
      return !nativeColorMatrixIsIdentity(colorValues);
    }
    // A zero-slice glitch filter is an identity pass.
    if (nativeFilterMatches(filter, GlitchFilter, 'GlitchFilter')) {
      return Number(filter.slices) > 0;
    }
    if (nativeFilterMatches(filter, NoiseFilter, 'NoiseFilter')) {
      return Number(filter.noise) > 0;
    }
    if (nativeFilterMatches(filter, DisplacementFilter, 'DisplacementFilter')) {
      return !filter.scale || Number(filter.scale.x) !== 0 ||
        Number(filter.scale.y) !== 0;
    }
    if ((BlurXFilter && filter instanceof BlurXFilter) ||
        (BlurYFilter && filter instanceof BlurYFilter)) {
      return Number(filter.blur) !== 0;
    }
    return true;
  });
  if (!effectiveFilters.length) return { blur: 0, groups: [], unsupported: false };
  var filter = effectiveFilters.length === 1 && effectiveFilters[0];
  var neutralWindowFilter = typeof WindowLayer === 'function' &&
    node instanceof WindowLayer && filter === WindowLayer.voidFilter;
  var neutralStageFilter = typeof Sprite === 'function' &&
    filter === Sprite.voidFilter;
  if (neutralWindowFilter || neutralStageFilter) {
    return { blur: 0, groups: [], unsupported: false };
  }
  if (nativeFilterMatches(filter, MvToneFilter, 'ToneFilter') &&
      node.parent && node.parent._baseSprite === node) {
    var toneMatrix = filter.matrix || filter.uniforms && filter.uniforms.m;
    if (toneMatrix && toneMatrix.length === 20) {
      return { blur: 0, groups: [], unsupported: false,
        colorMatrix: toneMatrix,
        toneAlpha: filter.alpha === undefined ? 1 : Number(filter.alpha) };
    }
  }
  var BlurFilter = PIXI.filters && PIXI.filters.BlurFilter;
  if (effectiveFilters.length <= 4) {
    var groups = [];
    for (var groupIndex = 0; groupIndex < effectiveFilters.length; groupIndex++) {
      var groupFilter = effectiveFilters[groupIndex];
      if (nativeFilterMatches(groupFilter, BlurFilter, 'BlurFilter')) {
        var blurPasses = Math.max(1, Math.ceil(Number(groupFilter.quality) || 1));
        if (blurPasses > 15) {
          groups = null;
          break;
        }
        groups.push({ kind: 0, resource: 0,
          parameters: [Math.max(0, Number(groupFilter.blur) || 0) /
            blurPasses, blurPasses] });
        continue;
      }
      var directionalBlurKind =
        BlurXFilter && groupFilter instanceof BlurXFilter ? 27 :
        BlurYFilter && groupFilter instanceof BlurYFilter ? 28 : -1;
      if (directionalBlurKind >= 0) {
        var directionalPasses = Math.max(1, Math.ceil(Number(groupFilter.passes) || 1));
        if (directionalPasses > 15) {
          groups = null;
          break;
        }
        groups.push({ kind: directionalBlurKind, resource: 0,
          parameters: [Math.abs(Number(groupFilter.blur) || 0) /
            directionalPasses, directionalPasses] });
        continue;
      }
      if (FXAAFilter && groupFilter instanceof FXAAFilter) {
        groups.push({ kind: 29, resource: 0, parameters: [] });
        continue;
      }
      if (KawaseBlurFilter && groupFilter instanceof KawaseBlurFilter) {
        var kawaseKernels = groupFilter.kernels;
        var kawaseBlur = Math.max(0, Number(groupFilter.blur) || 0);
        if (!kawaseKernels || !kawaseKernels.length) kawaseKernels = [kawaseBlur];
        if (kawaseKernels.length > 15) {
          PMJS.compat.hit('render.kawase-kernels',
            String(kawaseKernels.length));
          groups = null;
          break;
        }
        var kawasePixel = groupFilter.pixelSize || { x: 1, y: 1 };
        groups.push({ kind: 24, resource: 0, parameters: [
          kawaseKernels.length,
          Number(kawasePixel.x !== undefined ? kawasePixel.x : kawasePixel[0]) || 1,
          Number(kawasePixel.y !== undefined ? kawasePixel.y : kawasePixel[1]) || 1
        ].concat(Array.prototype.slice.call(kawaseKernels, 0, 15)) });
        continue;
      }
      if (nativeFilterMatches(groupFilter, ColorMatrixFilter,
          'ColorMatrixFilter') ||
          nativeFilterMatches(groupFilter, MvToneFilter, 'ToneFilter')) {
        var groupMatrix = groupFilter.matrix ||
          groupFilter.uniforms && groupFilter.uniforms.m;
        if (!groupMatrix || groupMatrix.length !== 20) {
          groups = null;
          break;
        }
        var groupMatrixAlpha = groupFilter.alpha === undefined &&
          groupFilter.uniforms ? groupFilter.uniforms.uAlpha : groupFilter.alpha;
        if (groupMatrixAlpha === undefined) groupMatrixAlpha = 1;
        groups.push({ kind: 25, resource: 0,
          parameters: Array.prototype.slice.call(groupMatrix).concat(
            Number(groupMatrixAlpha)),
          preservesTransparentBlack: Number(groupMatrix[19]) === 0 });
        continue;
      }
      if (nativeFilterMatches(groupFilter, DisplacementFilter,
          'DisplacementFilter')) {
        var maskSprite = groupFilter.maskSprite;
        var mapTexture = maskSprite && maskSprite.texture;
        var mapSource = mapTexture && mapTexture.baseTexture &&
          mapTexture.baseTexture.source;
        var mapImage = nativeTextureSource(mapSource);
        var mapFrame = mapTexture && (mapTexture._frame || mapTexture.frame);
        var mapWorld = maskSprite && maskSprite.transform ?
          nativeMaskWorldTransform(maskSprite) : nativeIdentityTransform;
        if (!mapImage || !mapFrame || mapFrame.width <= 0 || mapFrame.height <= 0) {
          return { blur: 0, unsupported: true, filters: effectiveFilters };
        }
        groups.push({ kind: 1, resource: mapImage.handle, parameters: [
          Number(mapWorld.tx) || 0, Number(mapWorld.ty) || 0,
          Number(mapFrame.width), Number(mapFrame.height),
          groupFilter.scale ? Number(groupFilter.scale.x) || 0 : 20,
          groupFilter.scale ? Number(groupFilter.scale.y) || 0 : 20
        ] });
        continue;
      }
      if (nativeFilterMatches(groupFilter, NoiseFilter, 'NoiseFilter')) {
        groups.push({ kind: 2, resource: 0, parameters: [
          Math.max(0, Number(groupFilter.noise) || 0),
          Number(groupFilter.seed) || 0, 0, 0
        ] });
        continue;
      }
      if (nativeFilterMatches(groupFilter, GlitchFilter, 'GlitchFilter')) {
        groups.push({ kind: 2, resource: 0, parameters: [
          0, Number(groupFilter.seed) || 0,
          Math.max(0, Number(groupFilter.slices) || 0),
          Number(groupFilter.offset) || 0
        ] });
        continue;
      }
      if (ZoomBlurFilter && groupFilter instanceof ZoomBlurFilter) {
        var zoomCenter = groupFilter.center || { x: 0, y: 0 };
        groups.push({ kind: 4, resource: 0, parameters: [
          Number(zoomCenter.x !== undefined ? zoomCenter.x : zoomCenter[0]) || 0,
          Number(zoomCenter.y !== undefined ? zoomCenter.y : zoomCenter[1]) || 0,
          Number(groupFilter.strength) || 0,
          Math.max(0, Number(groupFilter.innerRadius) || 0),
          groupFilter.radius === undefined ? -1 : Number(groupFilter.radius)
        ] });
        continue;
      }
      if (ShockwaveFilter && groupFilter instanceof ShockwaveFilter) {
        var waveCenter = groupFilter.center || { x: 0, y: 0 };
        groups.push({ kind: 5, resource: 0, parameters: [
          Number(waveCenter.x !== undefined ? waveCenter.x : waveCenter[0]) || 0,
          Number(waveCenter.y !== undefined ? waveCenter.y : waveCenter[1]) || 0,
          Number(groupFilter.amplitude) || 0,
          Math.max(0, Number(groupFilter.wavelength) || 0),
          groupFilter.brightness === undefined ? 1 : Number(groupFilter.brightness),
          Number(groupFilter.time) || 0,
          groupFilter.speed === undefined ? 500 : Number(groupFilter.speed),
          groupFilter.radius === undefined ? -1 : Number(groupFilter.radius)
        ] });
        continue;
      }
      if (AdvancedBloomFilter && groupFilter instanceof AdvancedBloomFilter) {
        var bloomKernels = groupFilter.kernels;
        var bloomBlur = Math.max(0, Number(groupFilter.blur) || 0);
        var bloomQuality = Math.max(1, Math.round(Number(groupFilter.quality) || 4));
        if (!bloomKernels || !bloomKernels.length) {
          bloomKernels = [];
          var bloomStep = bloomBlur / bloomQuality;
          for (var bloomIndex = 0; bloomIndex < bloomQuality; bloomIndex++) {
            bloomKernels.push(bloomBlur - bloomStep * bloomIndex);
          }
        }
        if (bloomKernels.length > 12) {
          PMJS.compat.hit('render.advanced-bloom-kernels',
            String(bloomKernels.length));
          groups = null;
          break;
        }
        var bloomPixel = groupFilter.pixelSize || { x: 1, y: 1 };
        groups.push({ kind: 6, resource: 0, parameters: [
          groupFilter.brightness === undefined ? 1 : Number(groupFilter.brightness),
          Number(groupFilter.bloomScale) || 0,
          groupFilter.threshold === undefined ? 0.5 : Number(groupFilter.threshold),
          bloomKernels.length,
          Number(bloomPixel.x !== undefined ? bloomPixel.x : bloomPixel[0]) || 1,
          Number(bloomPixel.y !== undefined ? bloomPixel.y : bloomPixel[1]) || 1
        ].concat(Array.prototype.slice.call(bloomKernels, 0, 12)) });
        continue;
      }
      if (CRTFilter && groupFilter instanceof CRTFilter) {
        groups.push({ kind: 7, resource: 0, parameters: [
          Number(groupFilter.curvature) || 0,
          Math.max(0, Number(groupFilter.lineWidth) || 0),
          Number(groupFilter.lineContrast) || 0,
          groupFilter.verticalLine ? 1 : 0,
          Math.max(0, Number(groupFilter.noise) || 0),
          Math.max(0, Number(groupFilter.noiseSize) || 0),
          Math.max(0, Number(groupFilter.vignetting) || 0),
          Number(groupFilter.vignettingAlpha) || 0,
          Math.max(0, Number(groupFilter.vignettingBlur) || 0),
          Number(groupFilter.time) || 0
        ] });
        continue;
      }
      if (AdjustmentFilter && groupFilter instanceof AdjustmentFilter) {
        groups.push({ kind: 8, resource: 0, parameters: [
          Number(groupFilter.gamma) || 0.0001,
          Number(groupFilter.contrast) || 0,
          Number(groupFilter.saturation) || 0,
          Number(groupFilter.brightness) || 0,
          Number(groupFilter.red) || 0,
          Number(groupFilter.green) || 0,
          Number(groupFilter.blue) || 0,
          groupFilter.alpha === undefined ? 1 : Number(groupFilter.alpha)
        ] });
        continue;
      }
      if (PixelateFilter && groupFilter instanceof PixelateFilter) {
        var pixelSize = groupFilter.size || groupFilter.pixelSize || 1;
        groups.push({ kind: 9, resource: 0, parameters: [
          Math.max(1, Number(pixelSize.x !== undefined ? pixelSize.x :
            pixelSize[0] !== undefined ? pixelSize[0] : pixelSize) || 1),
          Math.max(1, Number(pixelSize.y !== undefined ? pixelSize.y :
            pixelSize[1] !== undefined ? pixelSize[1] : pixelSize) || 1)
        ] });
        continue;
      }
      if (RGBSplitFilter && groupFilter instanceof RGBSplitFilter) {
        var splitRed = groupFilter.red || [0, 0];
        var splitGreen = groupFilter.green || [0, 0];
        var splitBlue = groupFilter.blue || [0, 0];
        groups.push({ kind: 10, resource: 0, parameters: [
          Number(splitRed.x !== undefined ? splitRed.x : splitRed[0]) || 0,
          Number(splitRed.y !== undefined ? splitRed.y : splitRed[1]) || 0,
          Number(splitGreen.x !== undefined ? splitGreen.x : splitGreen[0]) || 0,
          Number(splitGreen.y !== undefined ? splitGreen.y : splitGreen[1]) || 0,
          Number(splitBlue.x !== undefined ? splitBlue.x : splitBlue[0]) || 0,
          Number(splitBlue.y !== undefined ? splitBlue.y : splitBlue[1]) || 0
        ] });
        continue;
      }
      if (BulgePinchFilter && groupFilter instanceof BulgePinchFilter) {
        var bulgeCenter = groupFilter.center || [0.5, 0.5];
        groups.push({ kind: 11, resource: 0, parameters: [
          Number(bulgeCenter.x !== undefined ? bulgeCenter.x : bulgeCenter[0]) || 0,
          Number(bulgeCenter.y !== undefined ? bulgeCenter.y : bulgeCenter[1]) || 0,
          Math.max(0, Number(groupFilter.radius) || 0),
          Number(groupFilter.strength) || 0
        ] });
        continue;
      }
      if (TwistFilter && groupFilter instanceof TwistFilter) {
        var twistOffset = groupFilter.offset || [0, 0];
        groups.push({ kind: 12, resource: 0, parameters: [
          Number(twistOffset.x !== undefined ? twistOffset.x : twistOffset[0]) || 0,
          Number(twistOffset.y !== undefined ? twistOffset.y : twistOffset[1]) || 0,
          Math.max(0, Number(groupFilter.radius) || 0),
          Number(groupFilter.angle) || 0
        ] });
        continue;
      }
      if (AsciiFilter && groupFilter instanceof AsciiFilter) {
        groups.push({ kind: 13, resource: 0, parameters: [
          Math.max(1, Number(groupFilter.size) || 1)
        ] });
        continue;
      }
      if (DotFilter && groupFilter instanceof DotFilter) {
        groups.push({ kind: 14, resource: 0, parameters: [
          Number(groupFilter.angle) || 0, Number(groupFilter.scale) || 0
        ] });
        continue;
      }
      if (EmbossFilter && groupFilter instanceof EmbossFilter) {
        groups.push({ kind: 15, resource: 0, parameters: [
          Number(groupFilter.strength) || 0
        ] });
        continue;
      }
      if (CrossHatchFilter && groupFilter instanceof CrossHatchFilter) {
        groups.push({ kind: 16, resource: 0, parameters: [] });
        continue;
      }
      if (RadialBlurFilter && groupFilter instanceof RadialBlurFilter) {
        var radialCenter = groupFilter.center || [0, 0];
        var radialKernel = Math.max(1, Math.round(Number(groupFilter.kernelSize) || 5));
        if (radialKernel > 64) {
          PMJS.compat.hit('render.radial-blur-kernel', String(radialKernel));
          groups = null;
          break;
        }
        groups.push({ kind: 17, resource: 0, parameters: [
          Number(groupFilter.angle) || 0,
          Number(radialCenter.x !== undefined ? radialCenter.x : radialCenter[0]) || 0,
          Number(radialCenter.y !== undefined ? radialCenter.y : radialCenter[1]) || 0,
          radialKernel,
          groupFilter.radius === undefined ? -1 : Number(groupFilter.radius)
        ] });
        continue;
      }
      if (ReflectionFilter && groupFilter instanceof ReflectionFilter) {
        var reflectionAmplitude = groupFilter.amplitude || [0, 20];
        var reflectionWave = groupFilter.waveLength || [30, 100];
        var reflectionAlpha = groupFilter.alpha || [1, 1];
        groups.push({ kind: 18, resource: 0, parameters: [
          Number(groupFilter.boundary) || 0,
          groupFilter.mirror ? 1 : 0,
          Number(reflectionAmplitude[0]) || 0, Number(reflectionAmplitude[1]) || 0,
          Number(reflectionWave[0]) || 0, Number(reflectionWave[1]) || 0,
          Number(reflectionAlpha[0]) || 0, Number(reflectionAlpha[1]) || 0,
          Number(groupFilter.time) || 0
        ] });
        continue;
      }
      if (MotionBlurFilter && groupFilter instanceof MotionBlurFilter) {
        var motionVelocity = groupFilter.velocity || [0, 0];
        var motionKernel = Math.max(1, Math.round(Number(groupFilter.kernelSize) || 5));
        if (motionKernel > 64) {
          PMJS.compat.hit('render.motion-blur-kernel', String(motionKernel));
          groups = null;
          break;
        }
        groups.push({ kind: 19, resource: 0, parameters: [
          Number(motionVelocity.x !== undefined ? motionVelocity.x : motionVelocity[0]) || 0,
          Number(motionVelocity.y !== undefined ? motionVelocity.y : motionVelocity[1]) || 0,
          motionKernel, Number(groupFilter.offset) || 0
        ] });
        continue;
      }
      if (AlphaFilter && groupFilter instanceof AlphaFilter) {
        var alphaValue = groupFilter.alpha === undefined && groupFilter.uniforms ?
          groupFilter.uniforms.uAlpha : groupFilter.alpha;
        if (alphaValue === undefined) alphaValue = 1;
        groups.push({ kind: 20, resource: 0, parameters: [
          Math.max(0, Number(alphaValue) || 0)
        ], preservesTransparentBlack: true });
        continue;
      }
      if (OldFilmFilter && groupFilter instanceof OldFilmFilter) {
        groups.push({ kind: 21, resource: 0, parameters: [
          Math.max(0, Number(groupFilter.sepia) || 0),
          Math.max(0, Number(groupFilter.noise) || 0),
          Math.max(0, Number(groupFilter.noiseSize) || 0),
          Number(groupFilter.scratch) || 0,
          Math.max(0, Number(groupFilter.scratchDensity) || 0),
          Math.max(0, Number(groupFilter.scratchWidth) || 0),
          Math.max(0, Number(groupFilter.vignetting) || 0),
          Number(groupFilter.vignettingAlpha) || 0,
          Math.max(0, Number(groupFilter.vignettingBlur) || 0),
          Number(groupFilter.seed) || 0
        ] });
        continue;
      }
      if (GlowFilter && groupFilter instanceof GlowFilter) {
        var glowColor = Number(groupFilter.color) || 0;
        var glowDistance = Math.max(0, Number(groupFilter.distance) || 0);
        // pixi-filters 2.7 bakes 1 / quality / distance into its fragment
        // source; the constructor default quality is 0.1.
        var glowStep = 10 / Math.max(1, glowDistance);
        var glowSource = groupFilter.fragmentSrc || groupFilter.fragmentShader || '';
        var glowStepMatch = String(glowSource).match(/angle\s*\+=\s*([0-9.eE+-]+)/);
        if (glowStepMatch) glowStep = Number(glowStepMatch[1]) || glowStep;
        var glowAngles = glowStep > 0 ? Math.ceil(Math.PI * 2 / glowStep) + 1 : 65;
        if (glowDistance > 32 || glowAngles > 64) {
          PMJS.compat.hit('render.glow-samples',
            glowDistance + 'x' + glowAngles);
          groups = null;
          break;
        }
        groups.push({ kind: 22, resource: 0, parameters: [
          glowDistance, Number(groupFilter.outerStrength) || 0,
          Number(groupFilter.innerStrength) || 0,
          ((glowColor >> 16) & 255) / 255,
          ((glowColor >> 8) & 255) / 255,
          (glowColor & 255) / 255, glowStep
        ] });
        continue;
      }
      if (GodrayFilter && groupFilter instanceof GodrayFilter) {
        var godrayParallel = groupFilter.parallel !== false;
        var godrayLight;
        if (godrayParallel) {
          var godrayAngle = (Number(groupFilter.angle) || 0) * Math.PI / 180;
          godrayLight = [Math.cos(godrayAngle), Math.sin(godrayAngle)];
        } else {
          var godrayCenter = groupFilter.center || [0, 0];
          godrayLight = [
            Number(godrayCenter.x !== undefined ? godrayCenter.x : godrayCenter[0]) || 0,
            Number(godrayCenter.y !== undefined ? godrayCenter.y : godrayCenter[1]) || 0
          ];
        }
        groups.push({ kind: 23, resource: 0, parameters: [
          godrayParallel ? 1 : 0, godrayLight[0], godrayLight[1],
          Number(groupFilter.gain) || 0,
          Number(groupFilter.lacunarity) || 0,
          Number(groupFilter.time) || 0,
          Number(groupFilter.strength) || 0
        ] });
        continue;
      }
      var customGroup = nativeCustomFilterGroup(groupFilter, node);
      if (customGroup) {
        groups.push(customGroup);
        continue;
      }
      groups = null;
      break;
    }
    if (groups) return { blur: 0, unsupported: false, groups: groups };
  }
  return { blur: 0, unsupported: true, filters: effectiveFilters };
}
