'use strict';

(function() {
  var errorView = null;
  var lastInput = null;

  function retryButton() {
    var children = Graphics._errorPrinter && Graphics._errorPrinter.children || [];
    return children.find(function(child) { return child.id === 'retryButton'; });
  }

  function retry() {
    var button = errorView && retryButton();
    if (button) button.dispatchEvent({ type: 'click' });
  }

  function releaseError() {
    if (errorView && errorView.canvas) errorView.canvas._releaseNativeCanvas();
    errorView = null;
  }

  function paintError() {
    if (!errorView) return;
    var width = Graphics.width, height = Graphics.height;
    var canvas = errorView.canvas;
    if (!canvas) canvas = errorView.canvas = document.createElement('canvas');
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    var context = canvas.getContext('2d');
    context.clearRect(0, 0, width, height);
    context.fillStyle = 'rgba(0,0,0,0.9)';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#ffffff';
    context.font = '20px rmmz-mainfont, GameFont, sans-serif';
    context.textBaseline = 'top';
    var fallback = false;
    try { context.measureText('Retry'); } catch (_) { fallback = true; }
    function measure(text) { return fallback ? text.length * 12 : context.measureText(text).width; }
    function text(text, x, y) {
      if (fallback) PMJS.web.fallbackText(context, text, x, y);
      else context.fillText(text, x, y);
    }
    var margin = Math.min(24, width / 8), y = margin;
    var lines = (errorView.name + '\n' + errorView.message).split('\n');
    lines.forEach(function(line) {
      var rest = line;
      do {
        var count = rest.length;
        while (count > 1 && measure(rest.slice(0, count)) > width - margin * 2) count--;
        text(rest.slice(0, count), margin, y);
        rest = rest.slice(count);
        y += 25;
      } while (rest && y < height - 80);
    });
    errorView.button = null;
    if (retryButton()) {
      var buttonWidth = Math.min(180, width - margin * 2);
      var buttonY = Math.max(margin, height - 64);
      errorView.button = { x: (width - buttonWidth) / 2, y: buttonY,
        width: buttonWidth, height: 40 };
      context.fillStyle = '#404040';
      context.fillRect(errorView.button.x, buttonY, buttonWidth, 40);
      context.fillStyle = '#ffffff';
      context.textAlign = 'center';
      if (fallback) text('Retry', width / 2 - measure('Retry') / 2, buttonY + 8);
      else text('Retry', width / 2, buttonY + 8);
      context.textAlign = 'start';
    }
    errorView.width = width;
    errorView.height = height;
  }

  function updateLayers() {
    var canvas = Graphics._canvas;
    if (!canvas) return;
    if (errorView && (errorView.width !== Graphics.width || errorView.height !== Graphics.height)) paintError();
    PMJS.web.presentation.setLayers(canvas, typeof Video !== 'undefined' && Video._element,
      errorView && errorView.canvas);
    PMJS.web.presentation.setHitRegion(errorView && retryButton(), canvas,
      errorView && errorView.button);
  }

  function updatePresentation() {
    updateLayers();
    PMJS.web.presentation.sync();
  }

  PMJS.mz = PMJS.mz || {};
  PMJS.mz.graphics = PMJS.mz.graphics || {};
  PMJS.mz.graphics.updatePresentation = updatePresentation;

  PMJS.web.input.addEventListener('snapshot', function(event) {
    updateLayers();
    var input = event.snapshot;
    if (input === lastInput) return;
    lastInput = input;
    if (input.windowFocused !== false && errorView && (input.gamepads || []).some(function(pad) {
      return (pad.buttonsPressed || []).some(function(button) {
        return typeof Input !== 'undefined' && Input.gamepadMapper[button] === 'ok';
      });
    })) retry();
  });

  document.addEventListener('keydown', function(event) {
    if (errorView && !event.repeat && (event.keyCode === 13 || event.keyCode === 32)) {
      event.preventDefault();
      retry();
    }
  });

  ['printError', 'showRetryButton', 'eraseError'].forEach(function(method) {
    PMJS.methods.wrap({ key: 'mz.graphics.' + method, id: 'pmjs-mz.graphics.' + method, getTarget: function() { return Graphics; },
      method: method, wrap: function(original) { return function(name, message) {
        var result = original.apply(this, arguments);
        if (method === 'printError') {
          releaseError();
          errorView = { name: String(name || ''), message: String(message || '') };
        } else if (method === 'eraseError') releaseError();
        paintError();
        updatePresentation();
        return result;
      }; } });
  });
})();
