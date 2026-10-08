PMJS.mv = PMJS.mv || {};
PMJS.mv.bitmap = PMJS.mv.bitmap || {};
PMJS.mv.bitmap.createPrimitiveRecorder = function(bitmap) {
  if (!bitmap || !PMJS.web || !PMJS.web.canvas) return null;
  var recorder = PMJS.web.canvas.createPrimitiveRecorder(bitmap._canvas);
  if (!recorder) return null;
  var originalDestroy = bitmap.destroy;
  bitmap.destroy = function() {
    recorder.destroy();
    if (typeof originalDestroy === 'function') {
      return originalDestroy.apply(this, arguments);
    }
  };
  return recorder;
};
