'use strict';

// Pixel-level presentation test: synthetic scene checked at three layers
// (geometry struct, scene intactness, drawable pixels).
const path = require('node:path');
const assert = require('node:assert/strict');

const parseSize = (text) => {
  const match = /^(\d+)x(\d+)$/.exec(String(text || ''));
  assert(match, `bad size: ${text}`);
  return [Number(match[1]), Number(match[2])];
};

const [gameWidth, gameHeight] = parseSize(process.env.PMJS_TEST_GAME || '816x624');
const native = require(path.resolve(process.argv[2]));
native.initialize({
  gameRoot: path.resolve(process.argv[3]),
  assetRoot: '',
  width: gameWidth,
  height: gameHeight,
  windowTitle: 'pmjs presentation pixels test',
});

const quad = (x, y, w, h, r, g, b) => native.render.quad(x, y, w, h, r, g, b, 1);
const cx = Math.floor(gameWidth / 2), cy = Math.floor(gameHeight / 2);

native.beginFrame();
quad(0, 0, gameWidth, gameHeight, 0.1, 0.1, 0.1);
quad(0, 0, gameWidth, 2, 1, 0, 0);
quad(0, gameHeight - 2, gameWidth, 2, 1, 0, 0);
quad(0, 0, 2, gameHeight, 1, 0, 0);
quad(gameWidth - 2, 0, 2, gameHeight, 1, 0, 0);
quad(4, 4, 8, 8, 0, 1, 0);
quad(gameWidth - 12, 4, 8, 8, 0, 0, 1);
quad(4, gameHeight - 12, 8, 8, 1, 1, 0);
quad(gameWidth - 12, gameHeight - 12, 8, 8, 1, 0, 1);
quad(cx - 1, cy - 60, 2, 120, 1, 1, 1);
quad(cx - 60, cy - 1, 120, 2, 1, 1, 1);
native.renderFrame();

const channels = (handle, canvases, x, y) => {
  const pixel = canvases.pixel(handle, Math.round(x), Math.round(y));
  return [(pixel >>> 24) & 0xff, (pixel >>> 16) & 0xff, (pixel >>> 8) & 0xff];
};

// Layer 2: the scene framebuffer still holds the authored image.
{
  const frame = native.canvas.captureScene();
  try {
    let [r, g, b] = channels(frame.handle, native.canvas, 1, 100);
    assert(r > 200 && g < 80 && b < 80, `scene left border: ${r},${g},${b}`);
    [r, g, b] = channels(frame.handle, native.canvas, 8, 8);
    assert(g > 200 && r < 80 && b < 80, `scene top-left: ${r},${g},${b}`);
    [r, g, b] = channels(frame.handle, native.canvas, cx, cy);
    assert(r > 200 && g > 200 && b > 200, `scene center: ${r},${g},${b}`);
    [r, g, b] = channels(frame.handle, native.canvas, 200, 200);
    assert(r > 10 && r < 60 && g > 10 && g < 60 && b > 10 && b < 60,
      `scene background: ${r},${g},${b}`);
  } finally {
    native.canvas.release(frame.handle);
  }
}

// Layer 1+3: geometry maps authored pixels to the drawable; the drawable
// shows bars, all four edges, correctly oriented corners, center.
{
  const p = native.render.presentation();
  assert(p.letterboxed, 'expected bars for this geometry');
  assert.equal(p.filter, 'linear');
  const sx = p.viewportWidth / gameWidth, sy = p.viewportHeight / gameHeight;
  const dx = (ax, ay) => [p.viewportX + ax * sx, p.viewportY + ay * sy];
  const shot = native.canvas.captureDrawable();
  try {
    const at = (ax, ay) => {
      const [x, y] = dx(ax, ay);
      return channels(shot.handle, native.canvas, x, y);
    };
    let [r, g, b] = channels(shot.handle, native.canvas, 2, 100);
    assert(r < 32 && g < 32 && b < 32, `left bar: ${r},${g},${b}`);
    [r, g, b] = channels(shot.handle, native.canvas,
      p.drawableWidth - 2, 400);
    assert(r < 32 && g < 32 && b < 32, `right bar: ${r},${g},${b}`);
    [r, g, b] = at(1, 200);
    assert(r > 150 && r - g > 80 && r - b > 80, `left edge: ${r},${g},${b}`);
    [r, g, b] = at(gameWidth - 1, 200);
    assert(r > 150 && r - g > 80 && r - b > 80, `right edge: ${r},${g},${b}`);
    [r, g, b] = at(400, 1);
    assert(r > 150 && r - g > 80 && r - b > 80, `top edge: ${r},${g},${b}`);
    [r, g, b] = at(8, 8);
    assert(g > 150 && g - r > 80 && g - b > 80, `top-left: ${r},${g},${b}`);
    [r, g, b] = at(gameWidth - 8, 8);
    assert(b > 150 && b - r > 80 && b - g > 80, `top-right: ${r},${g},${b}`);
    [r, g, b] = at(8, gameHeight - 8);
    assert(r > 150 && g > 150 && b < 120, `bottom-left: ${r},${g},${b}`);
    [r, g, b] = at(gameWidth - 8, gameHeight - 8);
    assert(r > 150 && b > 150 && g < 120, `bottom-right: ${r},${g},${b}`);
    [r, g, b] = at(cx, cy);
    assert(r > 100 && g > 100 && b > 100, `center: ${r},${g},${b}`);
    [r, g, b] = at(200, 200);
    assert(r > 8 && r < 80 && g > 8 && g < 80 && b > 8 && b < 80,
      `background: ${r},${g},${b}`);
  } finally {
    native.canvas.release(shot.handle);
  }
}
