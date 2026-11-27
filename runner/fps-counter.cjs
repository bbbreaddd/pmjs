'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createFpsCounter(native, globals = globalThis) {
  let canvas, fallbackText, start, frames = 0, steps = 0, firstSteps = 0;
  let presented = false, sceneManager, updateScene, countedUpdate;
  function hide() {
    if (presented) native.render.setPresentationOverlay(0, 8, 8, 136, 56, 0);
    presented = false;
    start = undefined;
    if (sceneManager && sceneManager.updateScene === countedUpdate) sceneManager.updateScene = updateScene;
    sceneManager = null;
  }
  function frame(enabled, now) {
    if (!enabled) { hide(); return; }
    if (!sceneManager && typeof globals.SceneManager?.updateScene === 'function') {
      sceneManager = globals.SceneManager;
      updateScene = sceneManager.updateScene;
      const original = updateScene;
      countedUpdate = function() { ++steps; return original.apply(this, arguments); };
      sceneManager.updateScene = countedUpdate;
    }
    if (start === undefined) { start = now; frames = 0; firstSteps = steps; }
    else ++frames;
    const elapsed = now - start;
    if (presented && elapsed < 500) return;
    const labels = elapsed >= 500 ? [
      'FPS ' + (frames * 1000 / elapsed).toFixed(1),
      'LOGIC ' + (sceneManager ? ((steps - firstSteps) * 1000 / elapsed).toFixed(1) : '--')
    ] : ['FPS ...', 'LOGIC ...'];
    start = now; frames = 0; firstSteps = steps;
    if (!canvas) {
      canvas = native.canvas.create(136, 56);
      const scope = {};
      const root = fs.existsSync(path.join(__dirname, 'js')) ? __dirname : path.resolve(__dirname, '..');
      vm.runInNewContext(fs.readFileSync(path.join(root, 'js/pmjs-web/fallback-font.js'), 'utf8'), scope);
      fallbackText = scope.PMJS.web.fallbackText;
    }
    native.canvas.clearRect(canvas.handle, 0, 0, 136, 56);
    native.canvas.fillRect(canvas.handle, 0, 0, 136, 56, 0x000000cc);
    labels.forEach((text, row) => fallbackText({ fillRect(x, y, width, height) {
      native.canvas.fillRect(canvas.handle, 8 + x, 8 + row * 24 + y,
        width, height, 0xffffffff);
    } }, text, 0, 0));
    native.render.setPresentationOverlay(canvas.handle, 8, 8, 136, 56, 1);
    presented = true;
  }
  function dispose() {
    hide();
    if (canvas) native.canvas.release(canvas.handle);
    canvas = null;
  }
  return { frame, dispose };
}
module.exports = { createFpsCounter };
