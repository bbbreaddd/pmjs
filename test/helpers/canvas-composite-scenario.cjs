/* global document */
'use strict';

function canvasCompositeFixtures() {
  var operations = ['source-over', 'source-in', 'source-out', 'source-atop', 'destination-over',
    'destination-in', 'destination-out', 'destination-atop', 'lighter', 'copy', 'xor',
    'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
    'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];
  var frames = {};
  function record(label, draw) {
    var canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
    draw(canvas.getContext('2d'));
    var pixels = canvas.getContext('2d').getImageData(0, 0, 8, 8).data;
    var premultiplied = [];
    for (var i = 0; i < pixels.length; i += 4) {
      for (var c = 0; c < 3; c++) premultiplied.push(Math.floor((pixels[i + c] * pixels[i + 3] + 127) / 255));
      premultiplied.push(pixels[i + 3]);
    }
    frames[label] = premultiplied;
  }
  operations.forEach(function(operation) {
    ['opaque', 'translucent', 'clipped', 'reflected'].forEach(function(setting) {
      ['rectangle', 'path', 'image', 'circle', 'stroke', 'strokeRect'].forEach(function(shape) {
        record(operation + '/' + setting + '/' + shape, function(context) {
          context.fillStyle = setting === 'opaque' ? '#20d040' : '#2060a080';
          context.fillRect(0, 0, 8, 8);
          if (setting === 'clipped') { context.beginPath(); context.rect(2, 2, 3, 3); context.clip(); }
          if (setting === 'reflected') { context.translate(6, 1); context.scale(-1, 1); }
          context.globalCompositeOperation = operation;
          context.globalAlpha = setting === 'opaque' ? 1 : 0.63;
          context.fillStyle = context.strokeStyle = setting === 'opaque' ? '#e04080' : '#e0408080';
          if (shape === 'rectangle') context.fillRect(1, 1, 4, 4);
          else if (shape === 'path') { context.beginPath(); context.rect(1, 1, 4, 4); context.fill(); }
          else if (shape === 'circle') { context.beginPath(); context.arc(3, 3, 2, 0, Math.PI * 2); context.fill(); }
          else if (shape === 'strokeRect') { context.lineWidth = 2; context.strokeRect(2, 2, 3, 3); }
          else if (shape === 'stroke') {
            context.beginPath(); context.rect(2, 2, 3, 3); context.lineWidth = 2; context.stroke();
          } else {
            var source = document.createElement('canvas'); source.width = source.height = 4;
            var paint = source.getContext('2d'); paint.fillStyle = context.fillStyle; paint.fillRect(0, 0, 4, 4);
            context.imageSmoothingEnabled = false; context.drawImage(source, 1, 1);
          }
        });
      });
    });
  });
  ['linear', 'radial', 'pattern', 'fractional-clip', 'evenodd'].forEach(function(style) {
    record('circle/' + style, function(context) {
      context.fillStyle = '#20304080'; context.fillRect(0, 0, 8, 8);
      if (style === 'linear' || style === 'radial') {
        var paint = style === 'linear' ? context.createLinearGradient(0, 0, 8, 8) : context.createRadialGradient(3, 3, 0, 3, 3, 4);
        paint.addColorStop(0, '#f0408080'); paint.addColorStop(1, '#20c040'); context.fillStyle = paint;
      } else if (style === 'pattern') {
        var tile = document.createElement('canvas'); tile.width = tile.height = 2;
        var drawing = tile.getContext('2d'); drawing.fillStyle = '#f0408080'; drawing.fillRect(0, 0, 1, 2);
        drawing.fillStyle = '#20c040'; drawing.fillRect(1, 0, 1, 2);
        context.fillStyle = context.createPattern(tile, 'repeat');
      } else {
        context.fillStyle = '#f0408080'; context.beginPath();
        if (style === 'fractional-clip') { context.rect(1.25, 1.25, 4.5, 4.5); context.clip(); }
        else { context.rect(0, 0, 8, 8); context.rect(2, 2, 2, 2); context.clip('evenodd'); }
      }
      context.globalAlpha = 0.63; context.beginPath(); context.arc(3.5, 3.5, 2.5, 0, Math.PI * 2); context.fill();
    });
  });
  return frames;
}

module.exports = { canvasCompositeFixtures };
