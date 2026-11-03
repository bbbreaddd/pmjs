'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSettings, neutralizeGamepads, createInputFilter } = require('../runner/settings.cjs');

function fixture(initial) {
  let saved = initial, mode, overlay, writes = 0;
  const native = { render: { setPresentScaleMode(value) { mode = value; } },
    runtime: { settingsOverlay(value) { overlay = value; return { hasFont: true }; }, settingsPresent() {} } };
  const storage = { readText: () => saved, async writeTextAsync(_, value) { writes++; saved = value; } };
  const settings = createSettings({ native, storage, fonts: ['fonts/test.ttf'] });
  return { settings, mode: () => mode, saved: () => saved, overlay: () => overlay, writes: () => writes };
}
const input = (down = [], pressed = []) => ({ gamepads: [{ connected: true, instance: 1,
  buttonsDown: down, buttonsPressed: pressed }] });

test('shortcut requires Home and A on the same connected controller', () => {
  const s = fixture(null).settings;
  assert.equal(s.update(input([4, 5])), false);
  assert.equal(s.update({ gamepads: [
    { connected: true, buttonsDown: [16] }, { connected: true, buttonsDown: [0] }
  ] }), false);
  assert.equal(s.update({ gamepads: [{ connected: false, buttonsDown: [16, 0] }] }), false);
  assert.equal(s.update(input([16, 0], [0])), true);
});

test('either controller can navigate and unrelated held buttons do not delay release', () => {
  const s = fixture(null).settings;
  s.update(input([16, 0], [0]));
  s.update({ gamepads: [{ connected: true, buttonsDown: [], buttonsPressed: [] },
    { connected: true, buttonsDown: [9], buttonsPressed: [9] }] });
  s.update(input([15], [15]));
  s.update(input([0], [0]));
  assert.equal(s.isOpen(), false);
  assert.equal(s.update(input([14])), false);
  assert.equal(s.update(input([14])), false);
});

test('opens with Home and A, applies settings, and saves once on exit', async () => {
  const f = fixture(null), s = f.settings;
  assert.equal(s.update(input([16])), false);
  assert.equal(s.update(input([16, 0], [0])), true);
  assert.equal(s.isOpen(), true);
  s.update(input([15], [15]));
  assert.equal(f.mode(), 'fit');
  assert.equal(f.writes(), 0);
  s.draw();
  assert.equal(f.overlay().rows[0].value, 'Keep aspect ratio');
  s.update(input([13], [13]));
  s.draw();
  assert.equal(f.overlay().selected, 1);
  s.update(input([15], [15]));
  assert.equal(s.frameRate(), 30);
  assert.equal(s.update(input([9], [9])), true);
  s.draw();
  assert.equal(f.overlay().confirming, true);
  assert.equal(f.overlay().confirmYes, false);
  s.update(input([0], [0]));
  assert.equal(s.isOpen(), true);
  s.update(input([1], [1]));
  s.draw();
  assert.equal(f.overlay().confirming, true);
  assert.equal(f.overlay().confirmYes, false);
  s.update(input([1], [1]));
  assert.equal(s.isOpen(), true);
  s.update(input([1], [1]));
  s.update(input([14], [14]));
  s.update(input([0], [0]));
  await s.waitForSave();
  assert.deepEqual(JSON.parse(f.saved()), { scale: 'fit', frameRate: 30 });
  assert.equal(f.writes(), 1);
  assert.equal(s.isOpen(), false);
  assert.equal(s.update(input([0])), false);
  assert.equal(s.update(input()), false);
  assert.equal(s.update(input()), false);
  assert.equal(s.update(input([16, 0], [0])), true);
  assert.equal(s.isOpen(), true);
  s.draw();
  assert.equal(f.overlay().confirming, false);
  assert.equal(f.overlay().selected, 0);
});

test('integer scaling and frame limit persist and restore defaults', () => {
  const f = fixture(null), s = f.settings;
  s.update(input([16, 0], [0]));
  s.update(input([15], [15]));
  s.update(input([15], [15]));
  assert.equal(f.mode(), 'integer');
  s.update(input([15], [15]));
  assert.equal(f.mode(), 'crop');
  s.update(input([13], [13]));
  s.update(input([15], [15]));
  assert.equal(s.frameRate(), 30);
  assert.equal(f.writes(), 0);
  s.update(input([13], [13]));
  s.update(input([0], [0]));
  assert.equal(f.mode(), 'default');
  assert.equal(s.frameRate(), null);
  assert.equal(f.writes(), 0);
  s.update(input([9], [9])); s.update(input([15], [15])); s.update(input([0], [0]));
  assert.equal(s.isOpen(), false);
  assert.equal(f.writes(), 0);
  assert.equal(fixture(f.saved()).mode(), undefined);
});

test('restores valid settings and preserves the runtime default for invalid data', () => {
  assert.equal(fixture('{"scale":"stretch"}').mode(), 'stretch');
  assert.equal(fixture('{"scale":"integer","frameRate":120}').settings.frameRate(), 120);
  assert.equal(fixture('{"scale":"crop"}').mode(), 'crop');
  assert.equal(fixture('{"scale":"other"}').mode(), undefined);
  assert.equal(fixture('not json').mode(), undefined);
});

test('crop selection persists when settings is closed', async () => {
  const f = fixture(null), s = f.settings;
  s.update(input([16, 0], [0]));
  s.update(input([15], [15]));
  s.update(input([15], [15]));
  s.update(input([15], [15]));
  s.update(input([9], [9]));
  s.update(input([15], [15]));
  s.update(input([0], [0]));
  await s.waitForSave();
  assert.equal(fixture(f.saved()).mode(), 'crop');
});

test('menu remains readable when the game supplies no usable font', () => {
  let writes = 0, raster;
  const native = { canvas: { readPixels() { return new Uint8Array(320 * 240 * 4); },
    writePixels(handle, x, y, width, height, pixels) { writes++; raster = pixels; } }, runtime: {
    settingsOverlay: () => ({ hasFont: false, canvas: 1, width: 320, height: 240,
      lines: [{ text: 'Settings', x: 10, y: 10, pixel: 1 }] }), settingsPresent() {} } };
  const settings = createSettings({ native, storage: { readText: () => null },
    fonts: [], width: 320, height: 240 });
  settings.draw();
  assert.equal(writes, 1);
  assert(raster.some(value => value === 255));
});

test('failed save keeps changes and permits retry in the menu', async () => {
  let applied, overlay;
  const native = { render: { setPresentScaleMode(value) { applied = value; } }, runtime: {
    settingsOverlay(value) { overlay = value; return { hasFont: true }; }, settingsPresent() {} } };
  let attempts = 0;
  const storage = { readText: () => '{"scale":"fit"}', async writeTextAsync() {
    if (++attempts === 1) throw new Error('disk full');
  } };
  const settings = createSettings({ native, storage, fonts: [] });
  settings.update(input([16, 0], [0]));
  settings.update(input([15], [15]));
  settings.update(input([9], [9]));
  settings.update(input([15], [15]));
  settings.update(input([0], [0]));
  await settings.waitForSave();
  settings.draw();
  assert.equal(applied, 'integer');
  assert.equal(overlay.rows[0].value, 'Integer');
  assert.equal(overlay.footer[1], 'Save failed. Try again.');
  assert.equal(settings.isOpen(), true);
  settings.update(input([9], [9]));
  settings.update(input([15], [15]));
  settings.update(input([0], [0]));
  await settings.waitForSave();
  assert.equal(attempts, 2);
  assert.equal(settings.isOpen(), false);
});

test('captured controller state is neutral without modifying the original input', () => {
  const original = { keysDown: [65], gamepads: [{ connected: true, instance: 2,
    buttonsDown: [0, 4], buttonsPressed: [0], axes: [0.5, -1] }] };
  const filtered = neutralizeGamepads(original);
  assert.deepEqual(filtered.keysDown, [65]);
  assert.deepEqual(filtered.gamepads[0], { connected: true, instance: 2,
    buttonsDown: [], buttonsPressed: [], axes: [0, 0] });
  assert.deepEqual(original.gamepads[0].buttonsDown, [0, 4]);
});

test('keyboard and pointer input are released on capture and held controls stay suppressed', () => {
  const filter = createInputFilter();
  const key = { keyCode: 65, code: 'KeyA', key: 'a', down: true };
  const pointer = { type: 'mousedown', button: 0, buttons: 1, x: 5, y: 8 };
  filter({ keysDown: [65], keysPressed: [65], keyEvents: [key], pointerEvents: [pointer], gamepads: [] }, false);
  const captured = filter({ keysDown: [65, 66], keyEvents: [{ keyCode: 66, down: true }], pointerEvents: [], gamepads: [] }, true);
  assert.deepEqual(captured.keysDown, []);
  assert.deepEqual(captured.keyEvents, [{ ...key, down: false, repeat: false }]);
  assert.deepEqual(captured.pointerEvents, [{ ...pointer, type: 'mouseup', buttons: 0, cancelled: true }]);
  const blocked = filter({ keysDown: [65], keysPressed: [65], keyEvents: [], pointerEvents: [
    { type: 'mouseup', button: 0, buttons: 0 }
  ], gamepads: [] }, false);
  assert.deepEqual(blocked.keysDown, []);
  assert.deepEqual(blocked.keysPressed, []);
  assert.deepEqual(blocked.pointerEvents, []);
  filter({ keysDown: [], keyEvents: [{ ...key, down: false }], gamepads: [] }, false);
  assert.deepEqual(filter({ keysDown: [65], keysPressed: [65], keyEvents: [key], gamepads: [] }, false).keyEvents, [key]);
});

test('Home is reserved and controller controls held at dismissal release independently', () => {
  const filter = createInputFilter();
  const pad = (index, instance, buttonsDown, buttonsPressed, axes) => ({
    index, instance, connected: true, buttonsDown, buttonsPressed, axes
  });
  const home = filter({ gamepads: [pad(0, 10, [16], [16], [0, 0])] }, false);
  assert.deepEqual(home.gamepads[0].buttonsDown, []);
  assert.deepEqual(home.gamepads[0].buttonsPressed, []);
  filter({ gamepads: [pad(0, 10, [0, 14], [0], [0.8, 0]), pad(1, 20, [1], [], [0, 0])] }, true);
  const after = filter({ gamepads: [pad(0, 10, [0, 14, 13], [0, 13], [0.8, 0.5]),
    pad(1, 20, [1, 15], [15], [0, 0])] }, false);
  assert.deepEqual(after.gamepads[0].buttonsDown, [13]);
  assert.deepEqual(after.gamepads[0].buttonsPressed, [13]);
  assert.deepEqual(after.gamepads[0].axes, [0, 0.5]);
  assert.deepEqual(after.gamepads[1].buttonsDown, [15]);
  const released = filter({ gamepads: [pad(0, 10, [13], [0], [0, 0.5]), pad(1, 20, [], [], [0, 0])] }, false);
  assert.deepEqual(released.gamepads[0].buttonsPressed, []);
  const fresh = filter({ gamepads: [pad(0, 10, [0, 13], [0], [0.7, 0.5])] }, false);
  assert.deepEqual(fresh.gamepads[0].buttonsDown, [0, 13]);
  assert.deepEqual(fresh.gamepads[0].buttonsPressed, [0]);
  assert.deepEqual(fresh.gamepads[0].axes, [0.7, 0.5]);
});

test('Home then A opens settings without forwarding either shortcut button', () => {
  const settings = fixture(null).settings, filter = createInputFilter();
  const home = input([16], [16]);
  assert.equal(settings.update(home), false);
  assert.deepEqual(filter(home, false).gamepads[0].buttonsDown, []);
  const chord = input([16, 0], [0]);
  assert.equal(settings.update(chord), true);
  const delivered = filter(chord, true);
  assert.deepEqual(delivered.gamepads[0].buttonsDown, []);
  assert.deepEqual(delivered.gamepads[0].buttonsPressed, []);
});

test('a held pointer button does not block movement or a different button after dismissal', () => {
  const filter = createInputFilter();
  const leftDown = { type: 'mousedown', button: 0, buttons: 1, x: 2, y: 3 };
  filter({ pointerEvents: [leftDown], gamepads: [] }, false);
  filter({ pointerEvents: [], gamepads: [] }, true);
  const after = filter({ pointerEvents: [
    { type: 'mousemove', button: 0, buttons: 1, x: 4, y: 5 },
    { type: 'mousedown', button: 2, buttons: 3, x: 4, y: 5 },
    { type: 'mouseup', button: 0, buttons: 2, x: 4, y: 5 }
  ], gamepads: [] }, false);
  assert.deepEqual(after.pointerEvents, [
    { type: 'mousemove', button: 0, buttons: 0, x: 4, y: 5 },
    { type: 'mousedown', button: 2, buttons: 2, x: 4, y: 5 }
  ]);
});

test('a key released while the menu is open can be pressed immediately after closing', () => {
  const filter = createInputFilter();
  const key = { keyCode: 65, code: 'KeyA', key: 'a', down: true };
  filter({ keysDown: [65], keyEvents: [key], gamepads: [] }, true);
  filter({ keysDown: [], keyEvents: [{ ...key, down: false }], gamepads: [] }, true);
  const after = filter({ keysDown: [65], keysPressed: [65], keyEvents: [key], gamepads: [] }, false);
  assert.deepEqual(after.keysDown, [65]);
  assert.deepEqual(after.keyEvents, [key]);
});
