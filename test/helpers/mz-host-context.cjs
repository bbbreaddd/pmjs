'use strict';

const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

function createHostContext(native, { graphics = true } = {}) {
  native.runtime.now = () => performance.now();
  const context = vm.createContext({ console, performance, Uint8Array, Uint8ClampedArray,
    PMJS: { config: { fonts: { GameFont: 'testfont.ttf' } } },
    NativeHost: native,
    trackNativeResource: resource => resource,
    releaseNativeResource: (resource, kind) => { if (resource) native[kind === 'canvas' ? 'canvas' : 'images'].release(resource.handle); },
    Input: { gamepadMapper: { 0: 'ok', 1: 'cancel' } }
  });
  for (const module of ['pmjs-core/methods', 'pmjs-web/runtime', 'pmjs-web/events',
    'pmjs-web/canvas', 'pmjs-web/elements', 'pmjs-web/presentation', 'pmjs-web/fallback-font']) {
    const file = path.resolve(__dirname, '../../js', module + '.js');
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  if (graphics) {
    // A contained engine-contract fixture. Differential validation uses stock classes.
    const canvas = context.document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    canvas.style.width = '64px'; canvas.style.height = '64px';
    context.document.body.appendChild(canvas);
    context.Graphics = {
      width: 64, height: 64, _canvas: canvas, _realScale: 1,
      printError(name, message) {
        if (!this._errorPrinter) {
          this._errorPrinter = context.document.createElement('div');
          context.document.body.appendChild(this._errorPrinter);
        }
        const nameDiv = context.document.createElement('div');
        nameDiv.textContent = name;
        this._errorPrinter.innerHTML = nameDiv.outerHTML + message;
        canvas.style.opacity = 0.5;
      },
      showRetryButton(callback) {
        const button = context.document.createElement('button');
        button.id = 'retryButton'; button.innerHTML = 'Retry';
        button.onclick = () => { this.eraseError(); callback(); };
        this._errorPrinter.appendChild(button);
        button.focus();
      },
      eraseError() { this._errorPrinter.innerHTML = ''; canvas.style.opacity = 1; },
      pageToCanvasX(x) { return Math.round((x - canvas.offsetLeft) / this._realScale); },
      pageToCanvasY(y) { return Math.round((y - canvas.offsetTop) / this._realScale); }
    };
    const file = path.resolve(__dirname, '../../js/pmjs-mz/graphics.js');
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    context.PMJS.methods.install();
  }
  return context;
}

module.exports = { createHostContext };
