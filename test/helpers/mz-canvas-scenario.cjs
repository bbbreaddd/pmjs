'use strict';
/* global document */

function canvasFixtures(extraColors = []) {
  const frames = {};
  const colors = ['deepskyblue', 'steelblue', 'rebeccapurple', 'lightgoldenrodyellow',
    '#abc', '#abcd', '#10203040', 'rgb(100%, 50%, 0%)', 'rgb(255 128 0 / 50%)',
    'rgba(255, 0, 128, 0.5)', 'hsl(200, 100%, 50%)', 'hsl(.5turn 100% 50% / .75)',
    'hwb(120 20% 30%)', 'rgb(300, -50, 128)', 'transparent'];
  for (const color of colors.concat(extraColors, ['invalid', 'rgb(10%,20,30)', '#12', 'rgb(1,2,3,4,5)'])) {
    const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
    const drawing = canvas.getContext('2d'); drawing.fillStyle = '#a04020';
    drawing.fillStyle = color; drawing.fillRect(0, 0, 2, 2);
    frames['color/' + color] = { width: 2, height: 2, pixels: Array.from(drawing.getImageData(0, 0, 2, 2).data) };
  }
  const circles = [[9, 9, 4, 4, 4, 'white', 1, [1, 0, 0, 1, 0, 0]],
    [9, 9, 4.5, 4.5, 4, 'white', 1, [1, 0, 0, 1, 0, 0]],
    [20, 16, 7.25, 6.75, 5.5, 'deepskyblue', 0.5, [1, 0, 0, 1, 0, 0]],
    [24, 24, 8, 8, 5, '#f804', 1, [1.1, 0.3, -0.2, 1.2, 1, 2]],
    [20, 20, 10, 10, 6, 'white', 1, [1, 0, 0, 1, 0, 0]]];
  circles.forEach(([width, height, x, y, radius, color, alpha, transform], index) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const drawing = canvas.getContext('2d');
    if (index === 4) { drawing.fillStyle = '#306090'; drawing.fillRect(0, 0, width, height);
      drawing.beginPath(); drawing.rect(0, 0, 11, height); drawing.clip(); }
    drawing.setTransform(...transform); drawing.fillStyle = color; drawing.globalAlpha = alpha;
    drawing.beginPath(); drawing.arc(x, y, radius, 0, Math.PI * 2); drawing.fill();
    frames['circle/' + index] = { width, height, pixels: Array.from(drawing.getImageData(0, 0, width, height).data) };
  });
  for (const name of ['rain', 'storm', 'snow']) {
    const canvas = document.createElement('canvas'); canvas.width = name === 'snow' ? 9 : name === 'storm' ? 2 : 1;
    canvas.height = name === 'snow' ? 9 : 60;
    const drawing = canvas.getContext('2d'); drawing.fillStyle = name === 'storm' ? 'deepskyblue' : 'white';
    if (name === 'snow') { drawing.beginPath(); drawing.arc(4, 4, 4, 0, Math.PI * 2); drawing.fill(); }
    else drawing.fillRect(0, 0, canvas.width, canvas.height);
    frames['weather/' + name] = { width: canvas.width, height: canvas.height, pixels: Array.from(drawing.getImageData(0, 0, canvas.width, canvas.height).data) };
  }
  return frames;
}

module.exports = { canvasFixtures };
