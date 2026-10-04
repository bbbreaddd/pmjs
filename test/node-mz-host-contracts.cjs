'use strict';
process.env.PMJS_WINDOW_SIZE = '64x64';

const assert = require('node:assert/strict'), path = require('node:path');
const { createHostContext } = require('./helpers/mz-host-context.cjs');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 64, height: 64,
  windowTitle: 'MZ presentation and recovery' });
try {
  const c = createHostContext(native), g = c.Graphics;
  const pointer = (type, x, y, button = 0) => ({ type, x, y, button, buttons: type === 'mousedown' ? 1 : 0 });
  const send = events => c.__pmjsReceiveInput({ gamepads: [], pointerEvents: events });
  const presented = () => {
    native.beginFrame(); native.renderFrame();
    const capture = native.canvas.captureDrawable();
    try { return Array.from(native.canvas.readPixels(capture.handle, 0, 0, capture.width, capture.height)); }
    finally { native.canvas.release(capture.handle); }
  };
  g._realScale = 0.5;
  g._canvas.style.width = '32px'; g._canvas.style.height = '32px';
  g._canvas.style.imageRendering = 'pixelated'; c.PMJS.mz.graphics.updatePresentation();
  let rect = g._canvas.getBoundingClientRect();
  assert.equal(rect.width, 32); assert.equal(rect.left, 16); assert.equal(rect.top, 16);
  assert.equal(native.render.presentation().filter, 'nearest');
  assert.equal(g.pageToCanvasX(24), 16); assert.equal(g.pageToCanvasY(32), 32);
  assert.equal(g._canvas.offsetLeft, 16); assert.equal(g._canvas.offsetTop, 16);
  const events = [];
  for (const type of ['mousedown', 'mouseup', 'click', 'mousemove', 'wheel']) {
    c.document.addEventListener(type, event => events.push([event.type, event.pageX, event.pageY, event.deltaY]));
  }
  send([pointer('mousedown', 24, 32), pointer('mouseup', 24, 32), pointer('mousemove', 28, 30),
    { type: 'wheel', x: 28, y: 30, deltaY: 100 }]);
  assert.deepEqual(events.map(event => event[0]), ['mousedown', 'mouseup', 'click', 'mousemove', 'wheel']);
  assert.equal(events.at(-1)[3], 100);
  events.length = 0;
  send([pointer('mousedown', 24, 32), { ...pointer('mouseup', 24, 32), cancelled: true }]);
  assert.deepEqual(events.map(event => event[0]), ['mousedown', 'mouseup']);
  g._realScale = 1;
  g._canvas.style.width = '64px'; g._canvas.style.height = '64px';
  g._canvas.style.imageRendering = 'auto'; c.PMJS.mz.graphics.updatePresentation();
  rect = g._canvas.getBoundingClientRect();
  assert.equal(rect.left, 0); assert.equal(rect.width, 64);
  assert.equal(native.render.presentation().filter, 'linear');
  native.render.setClearColor(0.2, 0.7, 0.4, 1);
  const source = native.canvas.create(64, 64);
  native.canvas.fillRect(source.handle, 0, 0, 64, 64, 0xff00ffff);
  const schema = native.scene.schema, values = new Float32Array(schema.valueStride);
  values.set([1, 0, 0, 1, 0, 0, 1]); values.set([0, 0, 64, 64], 9); values.set([64, 64], 13);
  native.beginFrame(); native.scene.submit(schema.version, Uint32Array.of(1, 0xffffffff, source.handle, 0xffffff, 0, 8, 0), values, 1);
  native.renderFrame(); native.canvas.release(source.handle);
  const before = presented();
  assert.deepEqual(before.slice(0, 4), [255, 0, 255, 255], 'stopped ticker keeps its last submitted scene');
  let retries = 0;
  const show = () => {
    g.printError('LoadingError', 'img/missing.png');
    g.showRetryButton(() => { retries++; });
  };
  const baseline = native.canvas.memory().liveCount;
  for (const input of ['keyboard', 'pointer', 'controller']) {
    show();
    const overlay = presented();
    assert.notDeepEqual(overlay, before, 'error must be visible while the game ticker is stopped');
    assert.match(g._errorPrinter.innerHTML, /LoadingError/);
    assert.equal(g._errorPrinter.children.length, 1);
    if (input === 'keyboard') c.document.dispatchEvent({ type: 'keydown', keyCode: 13, preventDefault() {} });
    if (input === 'pointer') send([pointer('mousedown', 32, 16), pointer('mouseup', 32, 16)]);
    if (input === 'controller') c.__pmjsReceiveInput({ gamepads: [{ buttonsPressed: [0], buttonsDown: [0], buttonsReleased: [], axes: [0, 0, 0, 0] }] });
    assert.equal(retries, ['keyboard', 'pointer', 'controller'].indexOf(input) + 1);
    assert.equal(g._errorPrinter.children.length, 0);
    assert.equal(g._canvas.style.opacity, 1);
    assert.deepEqual(presented(), before);
    assert.equal(native.canvas.memory().liveCount, baseline);
  }
  show();
  const retryCount = retries;
  const controllerPress = { windowFocused: false,
    gamepads: [{ buttonsPressed: [0], buttonsDown: [0] }] };
  c.__pmjsReceiveInput(controllerPress);
  assert.equal(retries, retryCount, 'unfocused controller input does not retry');
  c.PMJS.mz.graphics.updatePresentation();
  c.PMJS.mz.graphics.updatePresentation();
  assert.equal(retries, retryCount, 'presentation refreshes do not perform retry input');
  c.__pmjsReceiveInput({ ...controllerPress, windowFocused: true });
  assert.equal(retries, retryCount + 1);
  assert.equal(native.canvas.memory().liveCount, baseline);
  c.PMJS.config.fonts.GameFont = 'missing-font.ttf';
  show();
  const fallback = presented();
  assert.ok(fallback.some((value, i) => i % 4 === 0 && value === 255 && fallback[i + 1] === 255 && fallback[i + 2] === 255),
    'font-load failure keeps a visible diagnostic');
  g.eraseError();
  show(); show();
  assert.equal(native.canvas.memory().liveCount, baseline + 1, 'replacement releases the owned overlay');
  g.eraseError();
  assert.equal(native.canvas.memory().liveCount, baseline);
  console.log('MZ presentation, native pointer events and repeated resource recovery passed');
} finally { native.runtime.quit(); }
