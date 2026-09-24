'use strict';

function matrix(offsets = [0, 0, 0], alphaScale = 1, alphaOffset = 0) {
  return [1, 0, 0, offsets[0], 0,
    0, 1, 0, offsets[1], 0,
    0, 0, 1, offsets[2], 0,
    0, 0, 0, alphaScale, alphaOffset];
}

const colors = {
  white: [255, 255, 255, 255],
  red: [255, 0, 0, 255],
};

const cases = [
  { name: 'full black', source: [102, 153, 204, 255],
    tone: matrix([-1, -1, -1]), pictures: [['white', 0.5]],
    expected: [128, 128, 128, 255] },
  { name: 'partial negative tone', source: [102, 153, 204, 255],
    tone: matrix([-128 / 255, -128 / 255, -128 / 255]),
    pictures: [['white', 0.5]] },
  { name: 'positive tone overflow', source: [102, 153, 204, 255],
    tone: matrix([0.7, 0.7, 0.7]), pictures: [['white', 0.5]] },
  { name: 'matrix offset overflow', source: [230, 100, 60, 255],
    tone: matrix([0, 0, 0]).map((value, index) =>
      index === 4 ? 0.5 : value), pictures: [['white', 0.5]] },
  { name: 'alpha below zero', source: [102, 153, 204, 255],
    tone: matrix([0, 0, 0], 1, -1.5), pictures: [['white', 0.5]],
    expectedDrawable: [128, 128, 128] },
  { name: 'alpha above one', source: [102, 153, 204, 255],
    tone: matrix([-0.2, -0.2, -0.2], 1, 1), pictures: [['white', 0.5]],
    expected: [179, 230, 255, 255] },
  { name: 'partial matrix alpha', source: [102, 153, 204, 255],
    tone: matrix([-1, -1, -1]), toneAlpha: 0.5,
    pictures: [['white', 0.5]] },
  { name: 'translucent source', source: [102, 153, 204, 128],
    tone: matrix([-1, -1, -1]), pictures: [['white', 0.5]] },
  { name: 'two translucent pictures', source: [102, 153, 204, 255],
    tone: matrix([-1, -1, -1]), pictures: [['white', 0.5], ['red', 0.5]],
    expected: [192, 64, 64, 255] },
];

module.exports = { matrix, colors, cases };
