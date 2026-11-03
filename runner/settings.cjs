'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const file = 'runtime-settings/settings.json';
const { rebuildMarker } = require('./preparation-catalog.cjs');
let fallbackText;
const entries = [
  { id: 'scale', label: 'Scaling', values: ['default', 'fit', 'integer', 'crop', 'stretch'] },
  { id: 'frameRate', label: 'Frame-rate limit', values: [null, 30, 60, 120] },
  { id: 'reset', label: 'Restore defaults' },
  { id: 'rebuild', label: 'Rebuild assets next launch' }
];

function createSettings({ native, fonts, storage }) {
  let scale = 'default', frameRate = null, active = false, waitingForRelease = false;
  let selected = 0, error = false, dirty = true, confirming = false, confirmYes = false;
  let savedScale = scale, savedRate = frameRate, saving = null;
  let rebuildRequested = false;
  try {
    const saved = JSON.parse(storage.readText(file));
    if (saved && ['fit', 'stretch', 'integer', 'crop'].includes(saved.scale)) {
      scale = saved.scale;
      native.render.setPresentScaleMode(scale);
    }
    if (saved && [30, 60, 120].includes(saved.frameRate)) frameRate = saved.frameRate;
    savedScale = scale; savedRate = frameRate;
  } catch (error) {
    if (!(error instanceof SyntaxError)) console.warn('[pmjs] cannot read runtime settings:', error.message);
  }
  function update(snapshot) {
    const pads = snapshot.gamepads || [];
    if (!active && !waitingForRelease && pads.some(pad => pad.connected &&
        pad.buttonsDown.includes(16) && pad.buttonsDown.includes(0))) {
      active = true;
      selected = 0;
      confirming = false;
      dirty = true;
      return true;
    }
    if (waitingForRelease) {
      if (!pads.some(pad => pad.connected && pad.buttonsDown.includes(16) && pad.buttonsDown.includes(0)))
        waitingForRelease = false;
      return false;
    }
    if (!active) return false;
    if (saving) return true;
    const pressed = pads.flatMap(pad => pad.buttonsPressed || []);
    if (confirming) {
      if (pressed.includes(14) || pressed.includes(15)) { confirmYes = !confirmYes; dirty = true; }
      if (pressed.includes(1) || pressed.includes(9)) {
        confirming = false; dirty = true;
      } else if (pressed.includes(0)) {
        if (confirmYes && (scale !== savedScale || frameRate !== savedRate)) {
          saving = storage.writeTextAsync(file, JSON.stringify({ scale, frameRate }))
            .then(() => {
              savedScale = scale; savedRate = frameRate;
              active = false; waitingForRelease = true; confirming = false;
            }, failure => {
              error = true; confirming = false;
              console.warn('[pmjs] cannot save runtime settings:', failure.message);
            }).finally(() => { saving = null; dirty = true; });
        } else {
          if (confirmYes) { active = false; waitingForRelease = true; }
          confirming = false;
        }
        dirty = true;
      }
      return true;
    }
    if (pressed.includes(1) || pressed.includes(9)) {
      confirming = true; confirmYes = false; dirty = true;
      return true;
    }
    if (pressed.includes(12)) { selected = (selected + entries.length - 1) % entries.length; dirty = true; }
    if (pressed.includes(13)) { selected = (selected + 1) % entries.length; dirty = true; }
    const change = pressed.includes(14) || pressed.includes(15) || pressed.includes(0);
    if (change) {
      const direction = pressed.includes(14) ? -1 : 1;
      let nextScale = scale, nextRate = frameRate;
      if (entries[selected].id === 'scale') {
        const values = entries[selected].values;
        nextScale = values[(values.indexOf(scale) + direction + values.length) % values.length];
      } else if (entries[selected].id === 'frameRate') {
        const values = entries[selected].values;
        nextRate = values[(values.indexOf(frameRate) + direction + values.length) % values.length];
      } else if (entries[selected].id === 'rebuild' && pressed.includes(0)) {
        saving = storage.writeTextAsync(rebuildMarker, require('node:crypto').randomBytes(16).toString('hex')).then(() => {
          rebuildRequested = true; error = false;
        }, failure => {
          error = true;
          console.warn('[pmjs] cannot request asset rebuild:', failure.message);
        }).finally(() => { saving = null; dirty = true; });
        dirty = true;
        return true;
      } else if (entries[selected].id === 'reset' && pressed.includes(0)) { nextScale = 'default'; nextRate = null; }
      else return true;
      if (nextScale !== scale) native.render.setPresentScaleMode(nextScale);
      scale = nextScale; frameRate = nextRate; error = false;
      dirty = true;
    }
    return true;
  }
  function draw() {
    if (!dirty) return;
    const scaleLabel = { default: 'Default', fit: 'Keep aspect ratio', integer: 'Integer', crop: 'Crop to fill', stretch: 'Stretch' }[scale];
    const rows = entries.map(entry => ({ label: entry.label, value: entry.id === 'scale' ? scaleLabel :
      entry.id === 'frameRate' ? (frameRate ? frameRate + ' FPS' : 'Default') : '' }));
    const title = 'Settings', question = 'Exit Settings?', yes = 'Yes', no = 'No';
    const footer = confirming ? [saving ? 'Saving...' : 'Left / Right: Choose', saving ? '' : 'A: Select    B: Cancel'] :
      ['D-pad: Move    A: Select', error ? 'Save failed. Try again.' :
        rebuildRequested ? 'Assets will rebuild next launch.' : 'Start / B: Exit'];
    const overlay = native.runtime.settingsOverlay({ title, question, yes, no, rows, footer, selected, fonts, confirming, confirmYes });
    if (overlay.hasFont) { native.runtime.settingsPresent(true); dirty = false; return; }
    if (!fallbackText) {
      const scope = {};
      vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web/fallback-font.js'), 'utf8'), scope);
      fallbackText = scope.PMJS.web.fallbackText;
    }
    const rasterWidth = overlay.width, rasterHeight = overlay.height;
    const pixels = native.canvas.readPixels(overlay.canvas, 0, 0, rasterWidth, rasterHeight);
    let textColor = 0xFFFFFFFF;
    const context = { fillRect(x, y, w, h) {
      const left = Math.max(0, Math.round(x));
      const top = Math.max(0, Math.round(y));
      const right = Math.min(rasterWidth, left + Math.max(1, Math.ceil(w)));
      const bottom = Math.min(rasterHeight, top + Math.max(1, Math.ceil(h)));
      for (let row = top; row < bottom; row++) for (let col = left; col < right; col++) {
        const offset = (row * rasterWidth + col) * 4;
        pixels[offset] = textColor >>> 24;
        pixels[offset + 1] = (textColor >>> 16) & 255;
        pixels[offset + 2] = (textColor >>> 8) & 255;
        pixels[offset + 3] = textColor & 255;
      }
    } };
    overlay.lines.forEach(line => { textColor = line.color ?? 0xFFFFFFFF; fallbackText({ fillRect(x, y, w, h) {
      context.fillRect(line.x + x * line.pixel, line.y + y * line.pixel,
        w * line.pixel, h * line.pixel);
    } }, line.text, 0, 0); });
    native.canvas.writePixels(overlay.canvas, 0, 0, rasterWidth, rasterHeight, pixels);
    native.runtime.settingsPresent(true);
    dirty = false;
  }
  let visible = false;
  function show() { draw(); visible = true; }
  function hide() { native.runtime.settingsPresent(false); visible = false; }
  return { update, isOpen: () => active, isVisible: () => visible, frameRate: () => frameRate,
    draw: show, waitForSave: () => saving, hide };
}

function neutralizeGamepads(input) {
  return { ...input, gamepads: (input.gamepads || []).map(pad => ({ ...pad,
    buttonsDown: [], buttonsPressed: [], axes: (pad.axes || []).map(() => 0) })) };
}

function createInputFilter() {
  const heldKeys = new Map(), heldPointers = new Map(), suppressedKeys = new Set(), suppressedPointers = new Set();
  let capturedPads = new Map(), suppressedPads = new Map();
  let capturedBefore = false;
  const pointerBit = button => button === 1 ? 4 : button === 2 ? 2 : 1;
  return (input, captured) => {
    const down = input.keysDown || [];
    if (captured) {
      capturedPads = new Map((input.gamepads || []).filter(pad => pad && pad.connected).map(pad => [
        `${pad.index}:${pad.instance}`, { buttons: new Set(pad.buttonsDown || []),
          axes: new Set((pad.axes || []).flatMap((value, index) => value !== 0 ? [index] : [])) }
      ]));
      suppressedKeys.clear();
      down.forEach(key => suppressedKeys.add(key));
      const keyEvents = capturedBefore ? [] : [...heldKeys.values()].map(event => ({ ...event, down: false, repeat: false }));
      const pointerEvents = capturedBefore ? [] : [...heldPointers.values()].map(event => ({
        ...event, type: 'mouseup', buttons: 0, cancelled: true
      }));
      for (const button of heldPointers.keys()) suppressedPointers.add(button);
      heldKeys.clear(); heldPointers.clear();
      for (const event of input.pointerEvents || []) {
        if (event.type === 'mousedown') suppressedPointers.add(event.button);
        else if (event.type === 'mouseup') suppressedPointers.delete(event.button);
      }
      capturedBefore = true;
      return { ...neutralizeGamepads(input), keysDown: [], keysPressed: [], keyEvents, pointerEvents };
    }
    if (capturedBefore) suppressedPads = capturedPads;
    capturedBefore = false;
    const connected = new Set();
    const gamepads = (input.gamepads || []).map(pad => {
      if (!pad || !pad.connected) return pad;
      const key = `${pad.index}:${pad.instance}`;
      connected.add(key);
      const blocked = suppressedPads.get(key);
      const buttonsDown = (pad.buttonsDown || []).filter(button => button !== 16 && !blocked?.buttons.has(button));
      const buttonsPressed = (pad.buttonsPressed || []).filter(button => button !== 16 && !blocked?.buttons.has(button));
      const axes = (pad.axes || []).map((value, index) => blocked?.axes.has(index) ? 0 : value);
      if (blocked) {
        for (const button of blocked.buttons) if (!(pad.buttonsDown || []).includes(button)) blocked.buttons.delete(button);
        for (const axis of blocked.axes) if (!(pad.axes || [])[axis]) blocked.axes.delete(axis);
        if (!blocked.buttons.size && !blocked.axes.size) suppressedPads.delete(key);
      }
      return { ...pad, buttonsDown, buttonsPressed, axes };
    });
    for (const key of suppressedPads.keys()) if (!connected.has(key)) suppressedPads.delete(key);
    const keyEvents = (input.keyEvents || []).filter(event => !suppressedKeys.has(event.keyCode));
    const keysDown = down.filter(key => !suppressedKeys.has(key));
    const keysPressed = (input.keysPressed || []).filter(key => !suppressedKeys.has(key));
    for (const key of suppressedKeys) if (!down.includes(key)) suppressedKeys.delete(key);
    for (const event of keyEvents) {
      if (event.text !== undefined) continue;
      if (event.down) heldKeys.set(event.keyCode, event);
      else heldKeys.delete(event.keyCode);
    }
    const pointerEvents = [];
    for (const event of input.pointerEvents || []) {
      if ((event.type === 'mousedown' || event.type === 'mouseup') && suppressedPointers.has(event.button)) {
        if (event.type === 'mouseup') suppressedPointers.delete(event.button);
        continue;
      }
      let buttons = event.buttons || 0;
      for (const button of suppressedPointers) buttons &= ~pointerBit(button);
      pointerEvents.push({ ...event, buttons });
      if (event.type === 'mousedown') heldPointers.set(event.button, event);
      else if (event.type === 'mouseup') heldPointers.delete(event.button);
    }
    return { ...input, gamepads, keysDown, keysPressed, keyEvents, pointerEvents };
  };
}

module.exports = { createSettings, neutralizeGamepads, createInputFilter };
