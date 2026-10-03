'use strict';
function zoomBlurScenario(fixture) {
  const width = 32, height = 24;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const alpha = (x < 4 || y > 20) ? 96 : 255;
    rgba.set([x * 7, y * 9, (x + y) * 4, alpha], (y * width + x) * 4);
  }
  const rows = [];
  const options = [{ center: [16, 12], strength: 0 },
    { center: [16, 12], strength: 0.12 },
    { center: [5, 18], strength: 0.4 },
    { center: [16, 12], strength: 0.3, innerRadius: 6, radius: 11 },
    { center: [40, -5], strength: 0.7 },
    { center: [16, 12], strength: -0.15 }];
  for (const [index, values] of options.entries()) {
    rows.push({ label: 'fullscreen-' + index, pixels: fixture.capture(rgba, values, false) });
  }
  rows.push({ label: 'snapshot', pixels: fixture.capture(rgba, options[2], true) });
  rows.push({ label: 'after-snapshot', pixels: fixture.capture(rgba, options[1], false) });
  rows.push({ label: 'alpha-chain', pixels: fixture.capture(rgba, { ...options[2], alpha: 0.5 }, false) });
  return rows;
}
module.exports = { zoomBlurScenario };
