'use strict';

(function() {
  var BlurFilter = PIXI.filters && PIXI.filters.BlurFilter;
  var AlphaFilter = PIXI.filters && PIXI.filters.AlphaFilter;
  var stockBlur = BlurFilter && new BlurFilter();
  var stockAlpha = AlphaFilter && new AlphaFilter();
  var blurApply = stockBlur && stockBlur.apply;
  var blurPassApply = stockBlur && stockBlur.blurXFilter.apply;
  var alphaApply = stockAlpha && stockAlpha.apply;
  pmjsPixi5RegisterFilterEncoder(function(filter) {
    if (!BlurFilter || filter.constructor !== BlurFilter) return null;
    var passes = filter.quality;
    if (!Number.isInteger(passes) || passes < 1 || passes > 15 || filter.blurX !== filter.blurY ||
        filter.resolution !== 1 || filter.repeatEdgePixels ||
        filter.padding !== Math.abs(filter.blur) * 2 || filter.apply !== blurApply ||
        filter.blurXFilter.apply !== blurPassApply ||
        filter.blurYFilter.apply !== blurPassApply ||
        filter.blurXFilter.program !== stockBlur.blurXFilter.program ||
        filter.blurYFilter.program !== stockBlur.blurYFilter.program) return null;
    return { kind: 0, parameters: [Math.abs(filter.blur) / passes, passes, 5],
      neutral: filter.blur === 0 };
  });
  pmjsPixi5RegisterFilterEncoder(function(filter) {
    if (!AlphaFilter || filter.constructor !== AlphaFilter ||
        filter.apply !== alphaApply || filter.program !== stockAlpha.program) return null;
    return { kind: 20, parameters: [filter.alpha], neutral: filter.alpha === 1 };
  });
})();
