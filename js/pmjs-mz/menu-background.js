'use strict';

(function() {
  var id = 'mz.menu-background-cache';
  PMJS.optimizations.register({ id: id, owner: 'pmjs-mz',
    fallback: 'render the original menu snapshot and filters each frame' });
  var records = new WeakMap();
  var stock = new PIXI.filters.BlurFilter();
  var spriteMethods = ['render', '_render', 'renderAdvanced', 'calculateVertices']
    .map(function(key) { return [key, Sprite.prototype[key]]; });

  function identity(node, alpha) {
    return node.alpha === alpha && node.x === 0 && node.y === 0 &&
      node.scale.x === 1 && node.scale.y === 1 && node.rotation === 0 &&
      node.pivot.x === 0 && node.pivot.y === 0 &&
      node.skew.x === 0 && node.skew.y === 0 && !node.mask && !node.filterArea;
  }

  function signature(renderer, stage, sprite) {
    var width = renderer.screen.width, height = renderer.screen.height;
    if (renderer.resolution !== 1 || width <= 0 || height <= 0 ||
        width > 2048 || height > 2048 || !sprite || sprite.constructor !== Sprite ||
        !sprite.visible || !sprite.renderable ||
        !(sprite.alpha > 0 && sprite.alpha <= 1) || !identity(sprite, sprite.alpha) ||
        sprite.anchor.x !== 0 || sprite.anchor.y !== 0 || sprite.children.length ||
        sprite.cacheAsBitmap || sprite.blendMode !== PIXI.BLEND_MODES.NORMAL ||
        sprite.tint !== 0xffffff || sprite._colorFilter ||
        spriteMethods.some(function(entry) { return sprite[entry[0]] !== entry[1]; })) return null;
    for (var ancestor = sprite; ancestor !== stage;) {
      ancestor = ancestor.parent;
      if (!ancestor || !identity(ancestor, 1) || ancestor.cacheAsBitmap) return null;
    }
    var bitmap = sprite.bitmap;
    var texture = sprite.texture, base = texture && texture.baseTexture;
    var frame = texture && texture.frame, orig = texture && texture.orig;
    var source = base && base.resource && base.resource.source;
    var filters = sprite.filters, filter = filters && filters[0];
    if (!bitmap || !bitmap.isReady() || bitmap.width !== width || bitmap.height !== height ||
        !source || !Number.isFinite(source.__pmjsContentRevision) ||
        !frame || frame.x !== 0 || frame.y !== 0 || frame.width !== width || frame.height !== height ||
        !orig || orig.width !== width || orig.height !== height || texture.trim || texture.rotate ||
        base.resolution !== 1 || base.wrapMode !== PIXI.WRAP_MODES.CLAMP ||
        !filters || filters.length !== 1 || !filter || filter.constructor !== PIXI.filters.BlurFilter ||
        filter.enabled !== true || filter.blurX !== filter.blurY || filter.resolution !== 1 ||
        filter.repeatEdgePixels || filter.padding !== Math.abs(filter.blur) * 2 ||
        !Number.isInteger(filter.quality) || filter.quality < 1 || filter.quality > 15 ||
        filter.blendMode !== PIXI.BLEND_MODES.NORMAL || filter.apply !== stock.apply ||
        filter.blurXFilter.apply !== stock.blurXFilter.apply ||
        filter.blurYFilter.apply !== stock.blurYFilter.apply ||
        filter.blurXFilter.program !== stock.blurXFilter.program ||
        filter.blurYFilter.program !== stock.blurYFilter.program) return null;
    return [sprite, bitmap, texture, base, source, source.__pmjsContentRevision,
      base._updateID, texture._updateID, base.scaleMode, width, height, sprite.alpha,
      filter, filter.blur, filter.quality, filter.blurYFilter.quality, renderer.roundPixels];
  }

  function release(renderer) {
    var record = records.get(renderer);
    if (!record) return;
    releaseNativeResource(record.image, 'image');
    records.delete(renderer);
  }

  PMJS.pixi5.registerRenderPreparation(function(renderer, stage, offscreen, prepared) {
    if (!PMJS.optimizations.isEnabled(id) || offscreen) return;
    var sprite = stage instanceof Scene_MenuBase && stage._backgroundSprite;
    var state = sprite && signature(renderer, stage, sprite);
    var record = records.get(renderer);
    if (!state) { release(renderer); return; }
    if (!record || state.some(function(value, index) { return value !== record.signature[index]; })) {
      release(renderer);
      try {
        NativeHost.render.setRenderTargetSize(renderer.width, renderer.height);
        pmjsPixi5RenderScene(sprite, null, 1, renderer.screen, renderer);
        // Preserve packed premultiplied texels and bake the sprite's alpha once.
        var image = trackNativeResource(NativeHost.render.renderToImage(renderer.width,
          renderer.height, { alphaMode: 'premultiplied' }), 'image');
        record = { image: image, signature: state };
        records.set(renderer, record);
      } catch (error) {
        if (error.code !== 'PMJS_RENDER_IMAGE_ALLOCATION') throw error;
        return;
      } finally {
        NativeHost.render.setScreenRenderSize(renderer.width, renderer.height);
      }
    }
    prepared.set(sprite, { resource: record.image.handle,
      width: renderer.screen.width, height: renderer.screen.height });
  }, release);
})();
