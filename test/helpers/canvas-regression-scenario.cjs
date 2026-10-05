/* global document, ImageData */
'use strict';

function canvasRegressionFixtures() {
  var frames = {};
  function record(name, draw) {
    var canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
    draw(canvas.getContext('2d'));
    var pixels = Array.from(canvas.getContext('2d').getImageData(0, 0, 8, 8).data);
    for (var i = 0; i < pixels.length; i += 4) for (var c = 0; c < 3; c++)
      pixels[i + c] = Math.floor((pixels[i + c] * pixels[i + 3] + 127) / 255);
    frames[name] = pixels;
  }
  [['left', -4, 0, 8, 8], ['top', 0, -4, 8, 8], ['negative', 4, 8, -8, -8],
    ['full', -4, -4, 12, 12]].forEach(function(rect) {
    record('clear/' + rect[0], function(ctx) {
      ctx.fillStyle = '#2060a0'; ctx.fillRect(0, 0, 8, 8);
      ctx.clearRect.apply(ctx, rect.slice(1));
    });
  });
  [[-1, 0, 2, 1], [0, -1, 2, 2], [2, 2, -2, -2], [-4, 0, 2, 1], [3, 0, 1, 1]].forEach(function(rect, index) {
    record('dirty/' + index, function(ctx) {
      ctx.fillStyle = '#2060a0'; ctx.fillRect(0, 0, 8, 8);
      var source = new ImageData(new Uint8ClampedArray(3 * 2 * 4), 3, 2);
      for (var i = 0; i < source.data.length; i += 4) source.data.set([240, 80, 40, 255], i);
      ctx.putImageData.apply(ctx, [source, 1, 1].concat(rect));
    });
  });
  ['source-over', 'destination-out', 'destination-in', 'copy', 'multiply'].forEach(function(operation) {
    [false, true].forEach(function(vertical) {
      record('gradient/' + operation + '/' + vertical, function(ctx) {
        ctx.fillStyle = '#2060a080'; ctx.fillRect(0, 0, 8, 8);
        var gradient = ctx.createLinearGradient(1, 1, vertical ? 1 : 5, vertical ? 5 : 1);
        gradient.addColorStop(0, '#ffffff80'); gradient.addColorStop(1, '#00000000');
        ctx.globalCompositeOperation = operation; ctx.fillStyle = gradient;
        ctx.fillRect(1, 1, 4, 4);
      });
    });
    [false, true].forEach(function(stroke) {
      record('text/' + operation + '/' + stroke, function(ctx) {
        ctx.fillStyle = '#2060a0'; ctx.fillRect(0, 0, 8, 8);
        ctx.font = '7px GameFont'; ctx.globalCompositeOperation = operation;
        ctx.fillStyle = ctx.strokeStyle = '#ffffff';
        ctx[stroke ? 'strokeText' : 'fillText']('X', 1, 6);
      });
    });
  });
  [false, true].forEach(function(smoothing) {
    ['direct', 'clip', 'reflect', 'rotate', 'composite', 'fractional-crop'].forEach(function(setting) {
      record('image/' + smoothing + '/' + setting, function(ctx) {
        var source = document.createElement('canvas'); source.width = 4; source.height = 2;
        var paint = source.getContext('2d'), data = new ImageData(new Uint8ClampedArray(4 * 2 * 4), 4, 2);
        for (var y = 0; y < 2; y++) for (var x = 0; x < 4; x++)
          data.data.set(x % 2 ? [0, 0, 255, 128] : [255, 0, 0, 255], (y * 4 + x) * 4);
        paint.putImageData(data, 0, 0); ctx.imageSmoothingEnabled = smoothing;
        if (setting === 'clip') { ctx.beginPath(); ctx.rect(0, 0, 8, 8); ctx.clip(); }
        if (setting === 'reflect') { ctx.translate(8, 0); ctx.scale(-1, 1); }
        if (setting === 'rotate') { ctx.translate(8, 0); ctx.rotate(Math.PI / 2); }
        if (setting === 'composite') ctx.globalCompositeOperation = 'copy';
        if (setting === 'fractional-crop') ctx.drawImage(source, 0.75, 0, 2.5, 2, 0, 0, 8, 4);
        else ctx.drawImage(source, 0, 0, 8, 4);
      });
    });
  });
  return frames;
}

module.exports = { canvasRegressionFixtures };
