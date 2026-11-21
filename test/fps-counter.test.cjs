'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createFpsCounter } = require('../runner/fps-counter.cjs');

function fixture() {
  const overlays = [], fills = [];
  let created = 0, released = 0;
  const original = function(value) { return this.value + value; };
  const globals = { SceneManager: { value: 3, updateScene: original } };
  const native = { canvas: {
    create() { ++created; return { handle: 7 }; }, release(handle) { assert.equal(handle, 7); ++released; },
    clearRect() { fills.length = 0; }, fillRect(...args) { fills.push(args); }
  }, render: { setPresentationOverlay(...args) { overlays.push(args); } } };
  const counter = createFpsCounter(native, globals);
  function expectLabels(labels) {
    const expected = [[7, 0, 0, 136, 56, 0x000000cc]], scope = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web/fallback-font.js'), 'utf8'), scope);
    labels.forEach((label, row) => scope.PMJS.web.fallbackText({ fillRect(x, y, w, h) {
      expected.push([7, 8 + x, 8 + row * 24 + y, w, h, 0xffffffff]);
    } }, label, 0, 0));
    assert.deepEqual(fills, expected);
  }
  return { counter, globals, original, overlays, expectLabels, created: () => created, released: () => released };
}

test('counter is idle while disabled and measures presentation and logic cadence separately', () => {
  const f = fixture();
  f.counter.frame(false, 0);
  assert.equal(f.created(), 0);
  assert.equal(f.globals.SceneManager.updateScene, f.original);
  f.counter.frame(true, 0);
  f.expectLabels(['FPS ...', 'LOGIC ...']);
  for (let i = 1; i <= 10; ++i) {
    for (let step = 0; step < 3; ++step) assert.equal(f.globals.SceneManager.updateScene(4), 7);
    f.counter.frame(true, i * 50);
  }
  f.expectLabels(['FPS 20.0', 'LOGIC 60.0']);
  assert.equal(f.overlays.length, 2);
  for (let i = 1; i <= 5; ++i) f.counter.frame(true, 500 + i * 100);
  f.expectLabels(['FPS 10.0', 'LOGIC 0.0']);
  f.counter.dispose();
  assert.equal(f.released(), 1);
  assert.equal(f.globals.SceneManager.updateScene, f.original);
});

test('hiding clears the overlay once and re-enabling starts a fresh sample', () => {
  const f = fixture();
  f.counter.frame(true, 0);
  f.counter.frame(false, 100);
  assert.deepEqual(f.overlays.at(-1), [0, 8, 8, 136, 56, 0]);
  f.counter.frame(false, 200);
  assert.equal(f.overlays.length, 2);
  f.counter.frame(true, 5000);
  f.expectLabels(['FPS ...', 'LOGIC ...']);
  assert.equal(f.created(), 1);
  f.counter.dispose();
});

test('engines without a scene update hook show unavailable logic and preserve later hooks', () => {
  const f = fixture();
  delete f.globals.SceneManager;
  f.counter.frame(true, 0); f.counter.frame(true, 500);
  f.expectLabels(['FPS 2.0', 'LOGIC --']);
  f.counter.dispose();
  const g = fixture();
  g.counter.frame(true, 0);
  const replacement = () => {};
  g.globals.SceneManager.updateScene = replacement;
  g.counter.dispose();
  assert.equal(g.globals.SceneManager.updateScene, replacement);
});
