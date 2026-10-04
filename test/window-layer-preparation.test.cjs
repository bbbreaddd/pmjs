'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

test('window layers prepare their current filter area before native rendering', () => {
  class WindowLayer {
    constructor() {
      this.x = 12; this.y = 20; this.width = 240; this.height = 180;
      this.filterArea = { x: 0, y: 0, width: 0, height: 0,
        copy(value) { for (const key of ['x', 'y', 'width', 'height']) this[key] = value[key]; } };
    }
  }
  const sandbox = vm.createContext({ WindowLayer });
  const filename = require.resolve('../js/pmjs-mv/render-prepare.js');
  vm.runInContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  const layer = new WindowLayer();
  sandbox.prepareNativeMvSceneNode(layer);
  assert.deepEqual(['x', 'y', 'width', 'height'].map(key => layer.filterArea[key]), [12, 20, 240, 180]);
  layer.x = 32; layer.width = 300;
  sandbox.prepareNativeMvSceneNode(layer);
  assert.deepEqual(['x', 'y', 'width', 'height'].map(key => layer.filterArea[key]), [32, 20, 300, 180]);
});

test('visible closed windows prepare their parts without advancing logic', () => {
  class Window {
    constructor(openness) {
      this.visible = true; this._openness = openness;
      this.children = []; this.calls = [];
      this._animationCount = 3;
    }
    _updateCursor() { this.calls.push('cursor'); }
    _updateArrows() { this.calls.push('arrows'); }
    _updatePauseSign() { this.calls.push('pause'); }
    _updateContents() { this.calls.push('contents'); }
  }
  const sandbox = vm.createContext({ Window });
  const filename = require.resolve('../js/pmjs-mv/render-prepare.js');
  vm.runInContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  const open = new Window(255), closed = new Window(0), hidden = new Window(255);
  hidden.visible = false;
  const hiddenParent = { visible: false, children: [new Window(255)] };
  sandbox.prepareNativeMvWindowTransforms({ visible: true, children: [open, closed, hidden, hiddenParent] });
  for (const window of [open, closed]) {
    assert.deepEqual(window.calls, ['cursor', 'arrows', 'pause', 'contents']);
    assert.equal(window._animationCount, 3);
  }
  assert.deepEqual(hidden.calls, []);
  assert.deepEqual(hiddenParent.children[0].calls, []);
});
