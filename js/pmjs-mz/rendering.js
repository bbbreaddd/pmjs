'use strict';

(function() {
  pmjsPixi5RegisterFilterEncoder(function(filter) {
    if (typeof ColorFilter !== 'function' ||
        filter.constructor !== ColorFilter) return null;
    var uniforms = filter.uniforms;
    var tone = uniforms.colorTone;
    var blend = uniforms.blendColor;
    var parameters = [uniforms.hue, tone[0], tone[1], tone[2], tone[3],
      blend[0], blend[1], blend[2], blend[3], uniforms.brightness];
    return {
      kind: 30,
      parameters: parameters,
      neutral: uniforms.hue % 360 === 0 && tone.every(function(value) {
        return value === 0;
      }) && blend[3] === 0 && uniforms.brightness === 255
    };
  });
})();
