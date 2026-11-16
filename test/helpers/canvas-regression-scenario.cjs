/* global document, ImageData */
'use strict';

function canvasRegressionFixtures() {
  var frames = {};
  function record(name, draw, samples, options, size) {
    var canvas = document.createElement('canvas'); canvas.width = canvas.height = size || 8;
    draw(canvas.getContext('2d', options));
    var pixels = Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data);
    for (var i = 0; i < pixels.length; i += 4) for (var c = 0; c < 3; c++)
      pixels[i + c] = Math.floor((pixels[i + c] * pixels[i + 3] + 127) / 255);
    frames[name] = samples ? samples.reduce(function(result, point) {
      var offset = (point[1] * canvas.width + point[0]) * 4;
      return result.concat(pixels.slice(offset, offset + 4));
    }, []) : pixels;
  }
  record('paint/translucent-solid', function(ctx) {
    ctx.fillStyle = 'rgba(39,83,171,0.43)'; ctx.fillRect(0, 0, 8, 8);
  });
  ['solid', 'radial', 'linear'].forEach(function(kind) {
    record('paint/fractional-' + kind, function(ctx) {
      var style = 'rgba(31,117,229,0.63)';
      if (kind !== 'solid') {
        style = kind === 'radial' ? ctx.createRadialGradient(2, 2, 0.2, 4, 4, 5) :
          ctx.createLinearGradient(0, 0, 7, 6);
        style.addColorStop(0, 'rgba(255,0,0,0.2)');
        style.addColorStop(0.4, 'rgba(0,255,0,0.7)'); style.addColorStop(1, 'blue');
      }
      ctx.fillStyle = style; ctx.fillRect(0.25, 0.6, 6.3, 5.9);
    });
  });
  record('paint/concentric-radial', function(ctx) {
    var gradient = ctx.createRadialGradient(4, 4, 0, 4, 4, 5);
    gradient.addColorStop(0, 'red'); gradient.addColorStop(1, 'blue');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 8, 8);
  });
  ['identical', 'shrinking', 'cone'].forEach(function(kind) {
    record('paint/radial-' + kind, function(ctx) {
      ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 8, 8);
      var g = kind === 'identical' ? ctx.createRadialGradient(4, 4, 2, 4, 4, 2) :
        kind === 'shrinking' ? ctx.createRadialGradient(4, 4, 5, 2, 2, 0.2) :
        ctx.createRadialGradient(1, 4, 1, 5, 4, 1);
      g.addColorStop(0, 'white'); g.addColorStop(1, 'blue');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 8, 8);
    });
  });
  record('path/open-rectangle-stroke', function(ctx) {
    ctx.strokeStyle = 'white'; ctx.lineWidth = 1.5;
    ctx.moveTo(1, 1); ctx.lineTo(6, 1); ctx.lineTo(6, 6); ctx.lineTo(1, 6); ctx.lineTo(1, 1);
    ctx.stroke();
  });
  record('clip/triangle-edges', function(ctx) {
    ctx.beginPath(); ctx.moveTo(0.3, 0.7); ctx.lineTo(7.2, 1.4); ctx.lineTo(2.6, 7.3);
    ctx.closePath(); ctx.clip(); ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 8, 8);
  });
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
  ['plain', 'circle', 'fractional', 'rotate', 'transform', 'reflect', 'clip', 'alpha',
    'gradient', 'clockwise-start', 'anticlockwise', 'backwards-turn'].forEach(function(setting) {
    record('ellipse/' + setting, function(ctx) {
      var start = 0, end = Math.PI * 2, anticlockwise = false;
      ctx.fillStyle = '#40a0e0';
      if (setting === 'fractional') ctx.translate(0.25, -0.125);
      if (setting === 'transform') ctx.setTransform(0.8, 0.2, -0.3, 0.9, 1, 0);
      if (setting === 'reflect') { ctx.translate(8, 0); ctx.scale(-1, 1); }
      if (setting === 'clip') { ctx.rect(1, 1, 4, 5); ctx.clip(); ctx.beginPath(); }
      if (setting === 'alpha') ctx.globalAlpha = 0.5;
      if (setting === 'gradient') {
        var gradient = ctx.createLinearGradient(1, 0, 7, 0);
        gradient.addColorStop(0, '#ff000080'); gradient.addColorStop(1, '#0000ff');
        ctx.fillStyle = gradient;
      }
      if (setting === 'clockwise-start') { start = Math.PI / 2; end += start; }
      if (setting === 'anticlockwise') { end = -Math.PI * 2; anticlockwise = true; }
      if (setting === 'backwards-turn') anticlockwise = true;
      ctx.ellipse(4, 4, 3, setting === 'circle' ? 3 : 1.75,
        setting === 'rotate' ? Math.PI / 3 : 0, start, end, anticlockwise);
      ctx.fill();
    });
  });
  ['destination-in', 'destination-out', 'copy', 'multiply'].forEach(function(operation) {
    record('ellipse/composite/' + operation, function(ctx) {
      ctx.fillStyle = '#2060a080'; ctx.fillRect(0, 0, 8, 8);
      ctx.globalCompositeOperation = operation;
      ctx.fillStyle = '#ff000080';
      ctx.ellipse(4, 4, 3, 2, 0, 0, Math.PI * 2); ctx.fill();
    });
  });
  // General paths use interior samples; their edge coverage is not antialiased.
  [false, true].forEach(function(anticlockwise) {
    record('ellipse/sector-interior/' + anticlockwise, function(ctx) {
      ctx.moveTo(4, 4); ctx.ellipse(4, 4, 3, 3, 0, 0, Math.PI / 2, anticlockwise);
      ctx.closePath(); ctx.fill();
    }, [[5, 5], [2, 2], [2, 5], [5, 2], [0, 0]]);
  });
  record('ellipse/stroke-interior', function(ctx) {
    ctx.lineWidth = 2;
    ctx.ellipse(4.5, 4.5, 3, 2, 0, 0, Math.PI * 2); ctx.stroke();
  }, [[4, 4], [0, 0], [1, 4], [7, 4]]);
  record('ellipse/clip-interior', function(ctx) {
    ctx.ellipse(4, 4, 3, 2, Math.PI / 6, 0, Math.PI * 2); ctx.clip();
    ctx.fillRect(0, 0, 8, 8);
  }, [[4, 4], [0, 0], [7, 7]]);
  ['fill', 'clear'].forEach(function(operation) {
    ['fractional', 'scale', 'reflect', 'rotate', 'clip'].forEach(function(setting) {
      record('rect/' + operation + '/' + setting, function(ctx) {
        ctx.fillStyle = '#2060a0'; ctx.fillRect(0, 0, 8, 8);
        ctx.fillStyle = '#ff000080';
        if (setting === 'scale') ctx.scale(1.5, 0.75);
        if (setting === 'reflect') ctx.setTransform(-1, 0, 0, 1, 8, 0);
        if (setting === 'rotate') ctx.setTransform(0.8, 0.6, -0.6, 0.8, 3, 0);
        if (setting === 'clip') { ctx.rect(2, 1, 3, 5); ctx.clip(); }
        ctx[operation + 'Rect'](0.25, 0.25, 3.5, 4.25);
      });
    });
    record('singular/' + operation, function(ctx) {
      ctx.fillStyle = '#2060a0'; ctx.fillRect(0, 0, 8, 8);
      ctx.setTransform(1, 1, 1, 1, 0, 0);
      ctx[operation + 'Rect'](0, 0, 5, 5);
    });
  });
  ['plain', 'clip', 'rotate'].forEach(function(setting) {
    record('gradient/interior-stops/' + setting, function(ctx) {
      var gradient = ctx.createLinearGradient(0, 0, 8, 0);
      gradient.addColorStop(0.25, '#ff0000'); gradient.addColorStop(0.75, '#0000ff');
      ctx.fillStyle = gradient;
      if (setting === 'clip') { ctx.rect(0, 0, 8, 8); ctx.clip(); }
      if (setting === 'rotate') ctx.setTransform(0, 1, -1, 0, 8, 0);
      ctx.fillRect(0, 0, 8, 8);
    });
  });
  ['butt', 'round', 'square'].forEach(function(cap) {
    ['scale', 'shear', 'reflect', 'late-transform'].forEach(function(setting) {
      record('stroke/' + cap + '/' + setting, function(ctx) {
        ctx.strokeStyle = '#40a0e0'; ctx.lineWidth = 1.5; ctx.lineCap = cap;
        if (setting === 'scale') ctx.setTransform(2, 0, 0, 3, 0, 0);
        if (setting === 'shear') ctx.setTransform(1, 0.3, 0.8, 1.5, 0, 0);
        if (setting === 'reflect') ctx.setTransform(-1, 0.3, 0, 2, 8, 0);
        ctx.moveTo(1, 1); ctx.lineTo(3, 1);
        if (setting === 'late-transform') ctx.scale(2, 3);
        ctx.stroke();
      });
    });
  });
  ['miter', 'round', 'bevel'].forEach(function(join) {
    [1, 10].forEach(function(limit) {
      record('stroke/join/' + join + '/' + limit, function(ctx) {
        ctx.strokeStyle = '#40a0e0'; ctx.lineWidth = 2; ctx.lineJoin = join; ctx.miterLimit = limit;
        ctx.moveTo(1, 6); ctx.lineTo(4, 2); ctx.lineTo(7, 6); ctx.stroke();
      });
    });
  });
  record('stroke/closed', function(ctx) {
    ctx.lineWidth = 1.5; ctx.lineJoin = 'bevel'; ctx.scale(1.5, 1);
    ctx.rect(1, 1, 3, 5); ctx.stroke();
  });
  record('stroke/closed-continuation', function(ctx) {
    ctx.lineWidth = 1.5; ctx.lineCap = 'round'; ctx.lineJoin = 'bevel';
    ctx.moveTo(2, 2); ctx.lineTo(5, 2); ctx.lineTo(5, 5); ctx.closePath();
    ctx.lineTo(1, 6); ctx.stroke();
  });
  ['source-over', 'copy', 'destination-in'].forEach(function(operation) {
    ['plain', 'clip', 'transform', 'circle', 'text'].forEach(function(setting) {
      record('gradient/degenerate/' + operation + '/' + setting, function(ctx) {
        ctx.fillStyle = '#2060a0'; ctx.fillRect(0, 0, 8, 8);
        var gradient = ctx.createLinearGradient(2, 2, 2, 2);
        gradient.addColorStop(0, 'red'); gradient.addColorStop(1, 'blue');
        ctx.fillStyle = gradient; ctx.globalCompositeOperation = operation;
        if (setting === 'clip') { ctx.rect(1, 1, 6, 6); ctx.clip(); ctx.beginPath(); }
        if (setting === 'transform') ctx.setTransform(1, 0.25, 0, 1, 0, 0);
        if (setting === 'circle') { ctx.arc(4, 4, 2, 0, Math.PI * 2); ctx.fill(); }
        else if (setting === 'text') { ctx.font = '7px GameFont'; ctx.fillText('X', 1, 6); }
        else ctx.fillRect(1, 1, 5, 5);
      });
    });
  });
  record('gradient/radial/65-stops', function(ctx) {
    var gradient = ctx.createRadialGradient(4, 4, 0, 4, 4, 5);
    for (var i = 0; i < 65; i++) gradient.addColorStop(i / 64, 'rgb(' + (i * 3) + ',80,160)');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 8, 8);
  });
  [65, 129].forEach(function(count) {
    ['integer', 'fractional', 'path'].forEach(function(setting) {
      record('gradient/linear/many-stops/' + count + '/' + setting, function(ctx) {
        var gradient = ctx.createLinearGradient(0, 0, 8, 0);
        for (var i = 0; i < count; i++) gradient.addColorStop(i / (count - 1),
          'rgb(' + Math.round(i * 255 / (count - 1)) + ',80,160)');
        ctx.fillStyle = gradient;
        if (setting === 'path') { ctx.rect(0, 0, 8, 8); ctx.fill(); }
        else if (setting === 'fractional') ctx.fillRect(0.25, 0.25, 7.5, 7.5);
        else ctx.fillRect(0, 0, 8, 8);
      });
    });
  });
  [false, true].forEach(function(smoothing) {
    ['fill', 'path', 'text'].forEach(function(setting) {
      record('pattern/filtering/' + smoothing + '/' + setting, function(ctx) {
        var source = document.createElement('canvas'); source.width = source.height = 2;
        var p = source.getContext('2d'); p.fillStyle = 'red'; p.fillRect(0, 0, 1, 2);
        p.fillStyle = '#0000ff80'; p.fillRect(1, 0, 1, 2);
        ctx.fillStyle = ctx.createPattern(source, 'repeat');
        ctx.imageSmoothingEnabled = smoothing; ctx.translate(0.25, 0); ctx.scale(2, 2);
        if (setting === 'text') { ctx.font = '4px GameFont'; ctx.fillText('X', 0, 3); }
        else if (setting === 'path') { ctx.rect(-1, -1, 5, 5); ctx.fill(); }
        else ctx.fillRect(-1, -1, 5, 5);
      });
    });
  });
  ['fill', 'stroke'].forEach(function(setting) {
    record('text/large/' + setting, function(ctx) {
      ctx.font = '300px GameFont'; ctx.lineWidth = 40; ctx.scale(0.025, 0.025);
      ctx[setting === 'fill' ? 'fillText' : 'strokeText']('W', 0, 280);
    });
    record('text/long-maxWidth/' + setting, function(ctx) {
      ctx.font = '24px GameFont'; ctx.lineWidth = 2;
      ctx[setting === 'fill' ? 'fillText' : 'strokeText']('W'.repeat(1000), 0, 6, 7);
    });
  });
  ['j', 'AV', 'é'].forEach(function(text) {
    ['reflect', 'clip', 'maxWidth'].forEach(function(setting) {
      record('text/overhang/' + text + '/' + setting, function(ctx) {
        ctx.font = 'italic 100px ' + (text === 'é' ? 'ShapingFont' : 'GameFont'); ctx.scale(0.07, 0.07);
        if (setting === 'reflect') ctx.transform(-1, 0, 0, 1, 110, 0);
        if (setting === 'clip') { ctx.rect(0, 0, 114, 114); ctx.clip(); }
        ctx.fillText(text, 12, 95, setting === 'maxWidth' ? 50 : 200);
      });
    });
  });
  ['left', 'center', 'right'].forEach(function(align) {
    [1, 0.5].forEach(function(alpha) {
      record('text/outlined-maxWidth/' + align + '/' + alpha, function(ctx) {
        ctx.font = '7px GameFont'; ctx.lineJoin = 'round'; ctx.lineWidth = 1;
        ctx.textAlign = align; ctx.strokeStyle = '#00000080'; ctx.fillStyle = '#ffffff';
        var x = align === 'center' ? 2.5 : align === 'right' ? 5 : 0;
        ctx.strokeText('AVATAR', x, 6, 5);
        ctx.globalAlpha = alpha; ctx.fillText('AVATAR', x, 6, 5);
      });
    });
  });
  ['plain', 'scale', 'translate', 'reflect', 'combined'].forEach(function(setting) {
    record('pattern/transform/' + setting, function(ctx) {
      var source = document.createElement('canvas'); source.width = source.height = 2;
      var paint = source.getContext('2d'); paint.fillStyle = 'red'; paint.fillRect(0, 0, 2, 2);
      paint.fillStyle = 'blue'; paint.fillRect(1, 0, 1, 2);
      var pattern = ctx.createPattern(source, 'repeat');
      ctx.imageSmoothingEnabled = false;
      if (setting === 'scale') ctx.scale(3, 2);
      if (setting === 'translate') ctx.translate(1, 2);
      if (setting === 'reflect') ctx.setTransform(-1, 0, 0, 1, 8, 0);
      if (setting === 'combined') {
        ctx.translate(1, 0); ctx.scale(2, 2);
        ctx.translate(1, 1);
      }
      ctx.fillStyle = pattern; ctx.fillRect(-4, -4, 16, 16);
    });
  });
  [false, true].forEach(function(stroke) {
    ['gradient', 'pattern'].forEach(function(paint) {
      ['plain', 'translate', 'reflect', 'clip', 'copy', 'maxWidth'].forEach(function(setting) {
        record('text/paint/' + stroke + '/' + paint + '/' + setting, function(ctx) {
          var style;
          if (paint === 'gradient') {
            style = ctx.createLinearGradient(0, 0, 8, 0);
            style.addColorStop(0, '#ff000080'); style.addColorStop(1, '#0000ff');
          } else {
            var source = document.createElement('canvas'); source.width = 2; source.height = 1;
            var p = source.getContext('2d'); p.fillStyle = 'red'; p.fillRect(0, 0, 1, 1);
            p.fillStyle = 'blue'; p.fillRect(1, 0, 1, 1); style = ctx.createPattern(source, 'repeat');
          }
          ctx.fillStyle = '#2060a0'; ctx.fillRect(0, 0, 8, 8);
          ctx.fillStyle = ctx.strokeStyle = style; ctx.font = '7px GameFont'; ctx.globalAlpha = 0.5;
          if (setting === 'translate') ctx.translate(1, 1);
          if (setting === 'reflect') ctx.setTransform(-1, 0, 0, 1, 8, 0);
          if (setting === 'clip') { ctx.rect(1, 1, 5, 5); ctx.clip(); }
          if (setting === 'copy') ctx.globalCompositeOperation = 'copy';
          ctx[stroke ? 'strokeText' : 'fillText']('X', 1, 6, setting === 'maxWidth' ? 3 : 8);
        });
      });
    });
  });
  ['alphabetic', 'top', 'hanging', 'middle', 'ideographic', 'bottom'].forEach(function(baseline) {
    [7, 9.5].forEach(function(size) {
      record('text/baseline/' + baseline + '/' + size, function(ctx) {
        ctx.font = size + 'px GameFont'; ctx.textBaseline = baseline; ctx.fillText('Hg', 0, 4);
      });
    });
  });
  ['direct', 'clip', 'reflect'].forEach(function(setting) {
    [[1, 1], [0.1, 0.2], [2.8, 0.2], [3.8, 0.2]].forEach(function(crop, index) {
      record('image/atlas/' + setting + '/' + index, function(ctx) {
        var source = document.createElement('canvas'); source.width = 4; source.height = 2;
        var paint = source.getContext('2d');
        ['red', '#00ff00', 'blue', 'white'].forEach(function(color, x) { paint.fillStyle = color; paint.fillRect(x, 0, 1, 2); });
        if (setting === 'clip') { ctx.rect(0, 0, 8, 8); ctx.clip(); }
        if (setting === 'reflect') ctx.setTransform(-1, 0, 0, 1, 8, 0);
        ctx.drawImage(source, crop[0], 0.1, crop[1], 0.2, 0, 0, 8, 8);
      });
    });
  });
  ['closed', 'transform'].forEach(function(setting) {
    record('path/arcTo/' + setting, function(ctx) {
      ctx.moveTo(1, 1);
      if (setting === 'closed') { ctx.lineTo(1, 6); ctx.lineTo(6, 6); ctx.closePath(); }
      else ctx.translate(1, 0);
      ctx.arcTo(5, 1, 5, 6, 1.5); ctx.lineTo(5, 6); ctx.lineTo(1, 6); ctx.fill();
    }, [[1, 2], [2, 2], [3, 2], [4, 2], [6, 2], [2, 4], [4, 4]]);
  });
  ['both', 'horizontal', 'vertical', 'transform', 'reflect', 'clip'].forEach(function(setting) {
    record('image/downscale/' + setting, function(ctx) {
      var source = document.createElement('canvas'); source.width = source.height = 8;
      var p = source.getContext('2d');
      for (var y = 0; y < 8; y++) for (var x = 0; x < 8; x++) {
        p.fillStyle = (x + y) % 2 ? 'red' : 'blue'; p.fillRect(x, y, 1, 1);
      }
      ctx.imageSmoothingEnabled = false;
      if (setting === 'transform') ctx.scale(0.5, 0.5);
      if (setting === 'reflect') ctx.setTransform(-0.5, 0, 0, 0.5, 4, 0);
      if (setting === 'clip') { ctx.rect(0, 0, 8, 8); ctx.clip(); }
      ctx.drawImage(source, 0, 0, setting === 'horizontal' ? 4 : setting === 'vertical' ? 8 : 4,
        setting === 'vertical' ? 4 : setting === 'horizontal' ? 8 : 4);
    });
  });
  record('path/invalid', function(ctx) {
    ctx.moveTo(1, 1); ctx.lineTo(6, 1); ctx.lineTo(NaN, 5);
    ctx.moveTo(Infinity, 0); ctx.rect(0, 0, Infinity, 3); ctx.lineTo(6, 6); ctx.closePath(); ctx.fill();
  }, [[4, 2], [1, 5], [6, 2]]);
  record('path/string-rect', function(ctx) { ctx.rect('1', '2', '3', '4'); ctx.fill(); });
  record('image-data/fractional-destination', function(ctx) {
    var data = new ImageData(new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]), 2, 1);
    ctx.putImageData(data, -0.5, -0.5); ctx.putImageData(data, 1.9, 2.9, -0.9, -0.9, 1.9, 1.9);
  });
  record('text/invalid-font', function(ctx) { ctx.font = 'italic 7px GameFont'; ctx.font = 'not-a-valid-font'; ctx.fillText('X', 1, 6); });
  ['retraced', 'collapsed', 'rectangle', 'reverse'].forEach(function(setting) {
    record('circle/clip-proof/' + setting, function(ctx) {
      if (setting === 'retraced') { ctx.moveTo(0, 0); ctx.lineTo(8, 0); ctx.lineTo(0, 0); ctx.lineTo(0, 8); }
      else if (setting === 'collapsed') { ctx.moveTo(2, 1); ctx.lineTo(2, 7); ctx.lineTo(2, 1); ctx.lineTo(2, 7); }
      else { ctx.moveTo(1, 1); ctx.lineTo(setting === 'reverse' ? 1 : 6, setting === 'reverse' ? 6 : 1); ctx.lineTo(6, 6); ctx.lineTo(setting === 'reverse' ? 6 : 1, setting === 'reverse' ? 1 : 6); }
      ctx.closePath(); ctx.clip(); ctx.beginPath(); ctx.arc(4, 4, 3, 0, Math.PI * 2); ctx.fill();
    });
  });
  ['butt', 'round', 'square'].forEach(function(cap) {
    ['horizontal', 'vertical', 'point', 'transform'].forEach(function(setting) {
      record('stroke/zero-rect/' + cap + '/' + setting, function(ctx) {
        ctx.lineWidth = 2; ctx.lineCap = cap; ctx.strokeStyle = 'red';
        if (setting === 'transform') ctx.setTransform(1, 0.25, 0.5, 1, 0, 0);
        ctx.strokeRect(2, 2, setting === 'horizontal' ? 4 : 0, setting === 'point' || setting === 'horizontal' ? 0 : 4);
      });
    });
  });
  ['quadratic', 'cubic'].forEach(function(kind) {
    ['fill', 'stroke', 'empty', 'close', 'transform', 'invalid', 'mixed'].forEach(function(setting) {
      record('curve/' + kind + '/' + setting, function(ctx) {
        ctx.lineWidth = 1.5; ctx.fillStyle = ctx.strokeStyle = '#3080c0';
        if (setting !== 'empty') ctx.moveTo(1, 6);
        if (setting === 'close') { ctx.lineTo(1, 1); ctx.closePath(); }
        if (setting === 'transform') ctx.setTransform(0.75, 0.25, -0.2, 1, 1, 0);
        if (kind === 'quadratic') ctx.quadraticCurveTo(4, -2, 7, 6);
        else ctx.bezierCurveTo(1, -1, 7, -1, 7, 6);
        if (setting === 'invalid') { ctx.quadraticCurveTo(NaN, 0, 2, 2); ctx.bezierCurveTo(0, 0, Infinity, 0, 2, 2); }
        if (setting === 'mixed') { ctx.lineTo(4, 7); ctx.arc(4, 4, 2, 0, Math.PI / 2); }
        if (setting === 'fill' || setting === 'mixed') ctx.fill(); else ctx.stroke();
      });
    });
  });
  ['line', 'rect', 'curve', 'circle', 'transform', 'odd', 'zero', 'offset'].forEach(function(setting) {
    record('stroke/dash/' + setting, function(ctx) {
      ctx.lineWidth = 1.5; ctx.lineCap = 'round'; ctx.setLineDash(setting === 'odd' ? [1, 2, 1] : setting === 'zero' ? [0, 0] : [1, 1.5]);
      if (setting === 'offset') ctx.lineDashOffset = -0.5;
      if (setting === 'transform') ctx.scale(0.75, 1.5);
      if (setting === 'rect') ctx.strokeRect(1, 1, 5, 5);
      else { ctx.moveTo(0, 4); if (setting === 'curve') ctx.quadraticCurveTo(4, -2, 8, 4); else if (setting === 'circle') ctx.arc(4, 4, 3, 0, Math.PI * 2); else ctx.lineTo(8, 4); ctx.stroke(); }
    });
  });
  ['rect', 'path', 'circle', 'text', 'stroke', 'image', 'gradient', 'clip', 'outside', 'transform', 'alpha', 'copy'].forEach(function(setting) {
    [0, 3].forEach(function(blur) {
      record('shadow/' + setting + '/' + blur, function(ctx) {
        ctx.shadowColor = 'rgba(255,0,0,0.75)'; ctx.shadowBlur = blur; ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 1;
        ctx.fillStyle = ctx.strokeStyle = '#2080c080';
        if (setting === 'clip') { ctx.rect(0, 0, 5, 5); ctx.clip(); ctx.beginPath(); }
        if (setting === 'alpha') ctx.globalAlpha = 0.5;
        if (setting === 'copy') { ctx.fillStyle = 'blue'; ctx.fillRect(0, 0, 8, 8); ctx.fillStyle = '#2080c080'; ctx.globalCompositeOperation = 'copy'; }
        if (setting === 'transform') ctx.setTransform(1, 0.2, -0.2, 1, 1, 0);
        if (setting === 'gradient') { var g = ctx.createLinearGradient(1, 1, 5, 1); g.addColorStop(0, 'transparent'); g.addColorStop(1, 'blue'); ctx.fillStyle = g; }
        if (setting === 'path') { ctx.moveTo(1, 1); ctx.lineTo(5, 2); ctx.lineTo(2, 5); ctx.fill(); }
        else if (setting === 'circle') { ctx.arc(3, 3, 2, 0, Math.PI * 2); ctx.fill(); }
        else if (setting === 'text') { ctx.font = '7px GameFont'; ctx.fillText('X', 0, 5); }
        else if (setting === 'stroke') { ctx.lineWidth = 1.5; ctx.strokeRect(1, 1, 3, 3); }
        else if (setting === 'image') { var source = document.createElement('canvas'); source.width = source.height = 2; source.getContext('2d').fillStyle = '#2080c080'; source.getContext('2d').fillRect(0, 0, 1, 2); ctx.drawImage(source, 1, 1, 4, 4); }
        else ctx.fillRect(setting === 'outside' ? -2 : 1, 1, 3, 3);
      });
    });
  });
  ['source-over', 'source-in', 'source-out', 'source-atop', 'destination-over',
    'destination-in', 'destination-out', 'destination-atop', 'copy', 'xor', 'lighter',
    'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
    'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'].forEach(function(operation) {
    ['rect', 'gradient', 'pattern', 'image', 'opaque-image'].forEach(function(kind) {
      [0, 3].forEach(function(blur) {
        record('shadow/composite/' + operation + '/' + kind + '/' + blur, function(ctx) {
          ctx.fillStyle = '#2060a080'; ctx.fillRect(0, 0, 5, 8);
          ctx.shadowColor = '#ff0000c0'; ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 1; ctx.shadowBlur = blur;
          ctx.globalAlpha = 0.5; ctx.globalCompositeOperation = operation;
          ctx.imageSmoothingEnabled = false; ctx.fillStyle = '#2080c080';
          var source;
          if (kind === 'gradient') {
            var gradient = ctx.createLinearGradient(1, 0, 4, 0);
            gradient.addColorStop(0, '#2080c000'); gradient.addColorStop(1, '#2080c0ff');
            ctx.fillStyle = gradient;
          }
          if (kind === 'pattern' || kind === 'image') {
            source = document.createElement('canvas'); source.width = source.height = 2;
            source.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray([
              32, 128, 192, 255, 32, 128, 192, 0, 32, 128, 192, 128, 32, 128, 192, 64
            ]), 2, 2), 0, 0);
            if (kind === 'pattern') ctx.fillStyle = ctx.createPattern(source, 'repeat');
          }
          if (kind === 'opaque-image') {
            source = document.createElement('canvas'); source.width = source.height = 2;
            source.getContext('2d', {alpha: false}).fillStyle = '#2080c0';
            source.getContext('2d').fillRect(0, 0, 2, 2);
          }
          if (kind === 'image' || kind === 'opaque-image') ctx.drawImage(source, 1, 1, 3, 3);
          else ctx.fillRect(1, 1, 3, 3);
        });
      });
    });
  });
  [['far-positive', 10000, 0], ['far-negative', -10000, 3], ['fractional', 3.25, 3],
    ['large-blur', 2, 10000]].forEach(function(setting) {
    ['rect', 'path', 'image', 'opaque-image'].forEach(function(kind) {
      if (setting[0] === 'fractional' && kind === 'image') return;
      record('shadow/bounds/' + setting[0] + '/' + kind, function(ctx) {
        var offset = setting[1];
        ctx.shadowColor = '#ff0000c0'; ctx.shadowOffsetX = offset; ctx.shadowOffsetY = -offset;
        ctx.shadowBlur = setting[2]; ctx.fillStyle = '#2080c080';
        if (kind === 'path') {
          ctx.moveTo(1 - offset, 1 + offset); ctx.quadraticCurveTo(6 - offset, 7 + offset, 6 - offset, 1 + offset);
          ctx.closePath(); ctx.fill();
        } else if (kind === 'rect') ctx.fillRect(1 - offset, 1 + offset, 3, 3);
        else {
          var source = document.createElement('canvas'); source.width = source.height = 2;
          var paint = source.getContext('2d', {alpha: kind !== 'opaque-image'});
          paint.fillStyle = '#2080c080'; paint.fillRect(0, 0, 2, 2);
          ctx.imageSmoothingEnabled = false; ctx.drawImage(source, 1 - offset, 1 + offset, 3, 3);
        }
      });
    });
  });
  ['source-in', 'source-out', 'destination-in', 'destination-atop'].forEach(function(operation) {
    record('shadow/bounds/empty/' + operation, function(ctx) {
      ctx.fillStyle = '#2060a080'; ctx.fillRect(0, 0, 8, 8);
      ctx.shadowColor = '#ff0000c0'; ctx.shadowOffsetX = ctx.shadowOffsetY = 10000;
      ctx.globalCompositeOperation = operation; ctx.fillStyle = '#2080c080'; ctx.fillRect(2, 2, 3, 3);
    });
  });
  ['empty', 'clear', 'copy', 'destination-in', 'write', 'resize'].forEach(function(setting) {
    record('opaque/' + setting, function(ctx) {
      if (setting === 'resize') ctx.canvas.width = ctx.canvas.width;
      if (setting === 'empty' || setting === 'resize') return;
      ctx.fillStyle = '#2080c080'; ctx.fillRect(0, 0, 8, 8);
      if (setting === 'clear') ctx.clearRect(1, 1, 4, 4);
      else if (setting === 'write') ctx.putImageData(new ImageData(new Uint8ClampedArray([255, 0, 0, 128, 0, 0, 0, 0]), 2), 1, 1);
      else { ctx.globalCompositeOperation = setting; ctx.fillRect(1, 1, 4, 4); }
    }, null, { alpha: false });
  });
  record('clip/singular', function(ctx) { ctx.rect(0, 0, 3, 3); ctx.scale(0, 1); ctx.clip(); ctx.resetTransform(); ctx.fillRect(0, 0, 8, 8); });
  record('path/float32', function(ctx) { ctx.translate(-16777216, 0); ctx.moveTo(16777217, 0); ctx.lineTo(16777217, 8); ctx.lineWidth = 2; ctx.stroke(); });
  record('color/numeric', function(ctx) { ctx.fillStyle = 'blue'; ctx.fillStyle = 0xff0000; ctx.fillRect(0, 0, 8, 8); });
  record('image/tiny-invertible', function(ctx) {
    var source = document.createElement('canvas'); source.width = source.height = 2;
    source.getContext('2d').fillStyle = 'red'; source.getContext('2d').fillRect(0, 0, 2, 2);
    ctx.setTransform(0.0001, 0.000001, 0, 0.0001, 0, 0); ctx.drawImage(source, 0, 0, 80000, 80000);
  });
  [false, true].forEach(function(stroke) {
    record('curve/control-hull/' + stroke, function(ctx) {
      ctx.moveTo(20, 20);
      for (var index = 0; index < 8; index++) ctx.bezierCurveTo(240, 20, 20, 240, 120, 120);
      ctx.arc(120, 120, 80, 0, Math.PI); ctx.closePath(); ctx[stroke ? 'stroke' : 'fill']();
    }, null, null, 256);
  });
  return frames;
}

module.exports = { canvasRegressionFixtures };
