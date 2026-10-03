'use strict';
// Shared generated inputs; reference capture runs stock Pixi, replay uses PMJS.
function tilingScenario(host) {
  const rows = [];
  function capture(label, options = {}) {
    const width = options.atlas ? 8 : options.npot ? 3 : 4;
    const height = options.atlas ? 8 : options.npot ? 5 : 4;
    const rgba = Array.from({ length: width * height * 4 }, (_, index) => {
      const pixel = Math.floor(index / 4), x = pixel % width, y = Math.floor(pixel / width);
      return index % 4 === 3 ? (options.translucent ? 64 + (x + y) % 4 * 48 : 255) : (x * 47 + y * 29 + index % 4 * 61) % 256;
    });
    rows.push({ label, pixels: host.capture(rgba, width, height, options) });
  }
  capture('nearest');
  capture('anchor', { anchor: [0.25, 0.5] });
  capture('anchor-uv', { anchor: [0.25, 0.5], uvRespectAnchor: true });
  capture('scroll-scale', { tilePosition: [1.25, -2.5], tileScale: [2, 0.5] });
  capture('mirrored', { tilePosition: [-1.5, 2], tileScale: [-1, -2] });
  capture('pivot', { pivot: [1.5, 2], tileScale: [2, 0.5] });
  capture('atlas-nearest', { atlas: true, tilePosition: [1, -2] });
  capture('atlas-repaint', { atlas: true, repaint: true, tilePosition: [1, -2] });
  capture('atlas-reframe', { atlas: true, reframe: true });
  capture('npot-nearest', { npot: true, tilePosition: [-2, 1] });
  capture('pot-linear', { linear: true, tilePosition: [0.25, -0.125], tileScale: [1.5, 2] });
  capture('npot-linear', { npot: true, linear: true, tilePosition: [0.25, -0.125], tileScale: [1.5, 2] });
  capture('atlas-linear', { atlas: true, linear: true, tilePosition: [0.25, -0.125], tileScale: [1.5, 2] });
  capture('clipped-alpha', { anchor: [0.25, 0.5], uvRespectAnchor: true, alpha: 0.5, clip: true });
  capture('translucent', { translucent: true, tilePosition: [0.25, 0.125], tileScale: [1.5, 2], linear: true });
  capture('translucent-atlas', { translucent: true, atlas: true, tilePosition: [0.25, 0.125], tileScale: [1.5, 2], linear: true, alpha: 0.5 });
  capture('snapshot', { atlas: true, tileScale: [2, 0.5], tilePosition: [0.25, 0.125], snapshot: true });
  return rows;
}
module.exports = { tilingScenario };
