'use strict';

function titleCanvasFixtures(readCanvas) {
  const frames = {};
  function record(name, draw) {
    const canvas = document.createElement('canvas');
    canvas.width = 24; canvas.height = 20;
    draw(canvas.getContext('2d'));
    function read() {
      if (readCanvas) return Array.from(readCanvas(canvas));
      const pixels = Array.from(canvas.getContext('2d').getImageData(0, 0, 24, 20).data);
      for (let i = 0; i < pixels.length; i += 4) for (let c = 0; c < 3; c++)
        pixels[i + c] = Math.floor((pixels[i + c] * pixels[i + 3] + 127) / 255);
      return pixels;
    }
    const pixels = read(), repeated = read();
    if (pixels.some((value, index) => value !== repeated[index])) throw new Error('Canvas readback changed: ' + name);
    frames[name] = { width: 24, height: 20, pixels };
  }
  for (const width of [1, 2, 2.5]) for (const background of [false, true]) {
    record('stroke/' + width + '/' + background, drawing => {
      if (background) { drawing.fillStyle = '#20304080'; drawing.fillRect(0, 0, 24, 20); }
      drawing.strokeStyle = '#20202080'; drawing.lineWidth = width;
      drawing.strokeRect(3.5, 2.5, 17, 14);
    });
  }
  for (const alpha of [1, 0.5, 0.63, 160 / 255]) record('gradient/' + alpha, drawing => {
    const gradient = drawing.createLinearGradient(0, 0, 0, 18);
    gradient.addColorStop(0, '#20202080'); gradient.addColorStop(1, '#00000080');
    drawing.fillStyle = gradient; drawing.globalAlpha = alpha;
    drawing.fillRect(2, 1, 20, 18);
  });
  record('gradient/fractional-alpha', drawing => {
    for (const [left, first, second] of [[0, '#00000000', '#00000099'], [10.75, '#00000099', '#00000000']]) {
      const gradient = drawing.createLinearGradient(left, 0, left + 10.75, 0);
      gradient.addColorStop(0, first); gradient.addColorStop(1, second);
      drawing.fillStyle = gradient; drawing.fillRect(left, 0, 10.75, 20);
    }
  });
  const source = document.createElement('canvas'); source.width = 4; source.height = 4;
  const drawing = source.getContext('2d');
  const image = drawing.getImageData(0, 0, 4, 4);
  for (let i = 0; i < 16; i++) image.data.set([32 + i * 13, 247 - i * 9, 206 - i * 7, 161 + i * 6], i * 4);
  drawing.putImageData(image, 0, 0);
  for (const smooth of [false, true]) for (const alpha of [1, 0.63, 160 / 255]) for (const fraction of [0, 0.25]) {
    record('image/' + smooth + '/' + alpha + '/' + fraction, target => {
      target.imageSmoothingEnabled = smooth; target.globalAlpha = alpha;
      target.drawImage(source, 0, 0, 4, 4, 2 + fraction, 1 + fraction, 19, 17);
    });
  }
  const atlas = document.createElement('canvas'); atlas.width = 8; atlas.height = 8;
  const atlasDrawing = atlas.getContext('2d');
  const atlasPixels = atlasDrawing.getImageData(0, 0, 8, 8);
  for (let i = 0; i < 64; i++) atlasPixels.data.set([i * 3, 255 - i * 3, 97, 128 + i * 2], i * 4);
  atlasDrawing.putImageData(atlasPixels, 0, 0);
  for (const smooth of [false, true]) record('image/cropped/' + smooth, target => {
    target.imageSmoothingEnabled = smooth;
    target.drawImage(atlas, 2, 2, 3, 3, 2.25, 1.25, 19, 17);
  });
  return frames;
}

module.exports = { titleCanvasFixtures };
