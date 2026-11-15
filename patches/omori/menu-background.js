(function() {
  var optimization = 'port.omori.menu-background-cache';

  PMJS.plugins.installOptimization('GTP_OmoriFixes', {
    id: optimization, owner: 'pmjs-omori',
    fallback: 'render the original menu background and blur every frame',
    phaseKey: optimization, order: 'module',
    install: function() {
      if (!PMJS.optimizations.isEnabled(optimization)) return;
      var backgrounds = new Map();
      var renderers = new WeakSet();
      var scenes = new WeakSet();

      function ownsCache(record) {
        var sprite = record.sprite;
        return record.cacheData && sprite.cacheAsBitmap &&
          sprite._cacheData === record.cacheData &&
          sprite._cacheData.sprite === record.cachedSprite;
      }

      function reset(record) {
        if (ownsCache(record)) {
          // Pixi registers the target before rendering; failed captures have no sprite yet.
          var unfinished = !record.cacheData.sprite &&
            PIXI.utils.TextureCache[record.cacheData.textureCacheId];
          var renderWebGL = record.sprite.renderWebGL;
          record.sprite.cacheAsBitmap = false;
          if (renderWebGL !== record.renderWebGL) record.sprite.renderWebGL = renderWebGL;
          if (unfinished) {
            unfinished.destroy(true);
            record.cacheData.textureCacheId = null;
          }
        }
        record.cacheData = null;
        record.cachedSprite = null;
        record.signature = null;
      }

      function identityTransform(node) {
        return node.alpha === 1 && node.position.x === 0 && node.position.y === 0 &&
          node.scale.x === 1 && node.scale.y === 1 && node.rotation === 0 &&
          node.pivot.x === 0 && node.pivot.y === 0 &&
          node.skew.x === 0 && node.skew.y === 0 && !node.mask && !node.filterArea;
      }

      function signature(sprite, stage, renderer) {
        if (!renderer || renderer.width !== 640 || renderer.height !== 480 ||
            renderer.resolution !== 1 || Graphics.width !== 640 || Graphics.height !== 480 ||
            sprite.constructor !== Sprite || !identityTransform(sprite) ||
            sprite.anchor.x !== 0 || sprite.anchor.y !== 0 || sprite.children.length ||
            sprite.blendMode !== PIXI.BLEND_MODES.NORMAL || sprite.tint !== 0xffffff ||
            sprite._isPicture || sprite.pluginName !== 'sprite' ||
            sprite._colorTone.some(function(value) { return value !== 0; }) ||
            sprite._blendColor.some(function(value) { return value !== 0; })) return null;
        for (var ancestor = sprite; ancestor !== stage;) {
          ancestor = ancestor.parent;
          if (!ancestor || !identityTransform(ancestor) || ancestor.cacheAsBitmap) return null;
          var ancestorFilters = ancestor.filters;
          if (ancestorFilters && ancestorFilters.length) return null;
        }
        var bitmap = sprite.bitmap;
        var canvas = bitmap && bitmap.__canvas;
        var texture = sprite.texture;
        var base = texture && texture.baseTexture;
        var frame = texture && texture.frame;
        var original = texture && texture.orig;
        var filters = sprite.filters;
        var filter = filters && filters[0];
        if (!bitmap || !bitmap.isReady() || bitmap.width !== 640 || bitmap.height !== 480 ||
            !canvas || canvas.width !== 640 || canvas.height !== 480 ||
            !Number.isFinite(canvas.__pmjsContentRevision) || !base || base.source !== canvas ||
            !frame || frame.x !== 0 || frame.y !== 0 || frame.width !== 640 || frame.height !== 480 ||
            !original || original.width !== 640 || original.height !== 480 ||
            texture.trim || texture.rotate || !filters || filters.length !== 1 ||
            filter !== sprite.blur || filter.constructor !== PIXI.filters.BlurFilter ||
            filter.enabled !== true || filter.blurX !== 1 || filter.blurY !== 1 ||
            filter.quality !== 4 || filter.blurYFilter.quality !== 4 || filter.padding !== 0 ||
            filter.resolution !== 1 || filter.blendMode !== PIXI.BLEND_MODES.NORMAL ||
            filter.autoFit !== true) return null;
        return [bitmap, canvas, canvas.__pmjsContentRevision, texture, base,
          base._updateID, texture._updateID, base.scaleMode, base.wrapMode, base.resolution,
          filter, filter.blurXFilter, filter.blurYFilter, sprite._renderWebGL];
      }

      function prepare(stage, renderer, screen, build) {
        backgrounds.forEach(function(record, sprite) {
          if (sprite.__pmjsBuildingBitmapCache) return;
          if (record.cacheData && !ownsCache(record)) {
            // A replaced or explicitly disabled cache belongs to the guest again.
            backgrounds.delete(sprite);
            return;
          }
          var overridden = record.cacheData && sprite.renderWebGL !== record.renderWebGL;
          var state = screen && !overridden ? signature(sprite, stage, renderer) : null;
          if (!state) { reset(record); return; }
          if (record.signature && state.every(function(value, index) {
            return value === record.signature[index];
          })) return;
          reset(record);
          if (build === false) return;
          if (sprite.cacheAsBitmap || pmjsPixiRenderPreflight.unsupportedMethod(sprite)) return;
          record.signature = state;
          sprite.cacheAsBitmap = true;
          record.cacheData = sprite._cacheData;
          record.renderWebGL = sprite.renderWebGL;
        });
      }

      function installRenderer(renderer) {
        if (renderers.has(renderer)) return;
        renderers.add(renderer);
        var emit = renderer.emit;
        if (typeof emit === 'function') renderer.emit = function(event) {
          if (event === 'prerender' && !this._pmjsPreparingBitmapCache) {
            backgrounds.forEach(function(record) {
              if (record.cacheData && !record.cachedSprite) {
                record.cachedSprite = record.cacheData.sprite;
              }
            });
          }
          var result = emit.apply(this, arguments);
          if (event === 'prerender' && !this._pmjsPreparingBitmapCache) {
            // Guest listeners run after Pixi builds caches and can change their inputs.
            prepare(this.stage, this, this.renderingToScreen, false);
          }
          return result;
        };
        var render = renderer.render;
        renderer.render = function(stage, target, clear, transform, skipUpdateTransform) {
          if (this._pmjsPreparingBitmapCache) return render.apply(this, arguments);
          prepare(stage, this, !target && !transform && !skipUpdateTransform);
          try { return render.apply(this, arguments); }
          catch (error) {
            backgrounds.forEach(reset);
            throw error;
          }
          finally {
            backgrounds.forEach(function(record) {
              if (record.cacheData && !record.cachedSprite) {
                record.cachedSprite = record.cacheData.sprite;
              }
            });
          }
        };
        var generateTexture = renderer.generateTextureGpu;
        renderer.generateTextureGpu = function(stage) {
          prepare(stage, this, false);
          return generateTexture.apply(this, arguments);
        };
      }

      [Scene_Menu.prototype, Scene_OmoMenuBase.prototype].forEach(function(prototype) {
        var createBackground = prototype.createBackground;
        prototype.createBackground = function() {
          var previous = backgrounds.get(this._backgroundSprite);
          if (previous) { reset(previous); backgrounds.delete(previous.sprite); }
          var result = createBackground.apply(this, arguments);
          var sprite = this._backgroundSprite;
          if (sprite && !sprite.cacheAsBitmap) {
            backgrounds.set(sprite, { sprite: sprite, scene: this,
              signature: null, cacheData: null, cachedSprite: null });
            installRenderer(Graphics._renderer);
            if (!scenes.has(this)) {
              scenes.add(this);
              var terminate = this.terminate;
              this.terminate = function() {
                var scene = this;
                try { return terminate.apply(this, arguments); }
                finally {
                  backgrounds.forEach(function(record, background) {
                    if (record.scene === scene) { reset(record); backgrounds.delete(background); }
                  });
                }
              };
            }
          }
          return result;
        };
      });

      var renderStageToCanvas = PMJS.pixi4.renderStageToCanvas;
      PMJS.pixi4.renderStageToCanvas = function(stage) {
        prepare(stage, Graphics._renderer, false);
        return renderStageToCanvas.apply(this, arguments);
      };
    }
  });
})();
