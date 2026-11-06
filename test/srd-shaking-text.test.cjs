'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { pinSourceFingerprint } = require('./helpers/reviewed-function-fixture.cjs');
const source = fs.readFileSync(require.resolve('../js/pmjs-core/methods.js'), 'utf8') + '\n' + fs.readFileSync(require.resolve('../js/pmjs-plugins/srd/shaking-text.js'), 'utf8');

function fixture({ disabled = false, unknownCreate = false, unknownRemove = false, canvasContext } = {}) {
  const loaded = new Map(), phases = new Map(), refusals = [], retained = [];
  const counts = { canvases: 0, bases: 0, textures: 0, sprites: 0 };
  class Bitmap {
    constructor(width, height) {
      this.width = width; this.height = height;
      if (canvasContext) {
        this.__canvas = canvasContext.document.createElement('canvas');
        this.__canvas.width = width; this.__canvas.height = height;
      } else {
        counts.canvases++;
        this.__canvas = { live: true, _releaseNativeCanvas() {
          if (this.live) { counts.canvases--; this.live = false; }
        } };
      }
      this.__baseTexture = { source: this.__canvas, destroy() {
        assert.ok(this.source, 'base texture destroyed twice');
        counts.bases--; this.source = null;
      } };
      counts.bases++;
    }
    drawText(text) {
      this.text = text;
      if (canvasContext) {
        const drawing = this.__canvas.getContext('2d');
        drawing.fillStyle = '#ff0000'; drawing.fillRect(0, 0, this.width, this.height);
      }
    }
  }
  class Sprite {
    constructor(bitmap) {
      this.bitmap = bitmap; this.children = [];
      this.texture = { baseTexture: bitmap.__baseTexture, destroy(base) {
        if (base) this.baseTexture.destroy();
        counts.textures--; this.baseTexture = null;
      } };
      this.opacity = 255; counts.textures++; counts.sprites++;
    }
    update() { this.x++; }
    destroy(options) {
      assert.equal(options.texture, true); assert.equal(options.baseTexture, true);
      this.texture.destroy(options.baseTexture); this.texture = null;
      this.destroyed = true; counts.sprites--;
    }
  }
  class Message {
    constructor() {
      this._shakingSprites = []; this.children = [];
      this.contents = { fontFace: 'font-a', fontSize: 24, textColor: 'white' };
      this.visible = true;
    }
    addChild(sprite) { this.children.push(sprite); sprite.parent = this; }
    removeChild(sprite) {
      const index = this.children.indexOf(sprite);
      if (index >= 0) { this.children.splice(index, 1); sprite.parent = null; }
    }
    createShakingCharacter(text, width = 8, height = 24) {
      const glyph = new Sprite(new Bitmap(width, height));
      Object.assign(glyph.bitmap, this.contents); glyph.bitmap.drawText(text);
      glyph.x = 10; glyph.y = 20;
      this.addChild(glyph); this._shakingSprites.push(glyph);
      return 'created';
    }
    removeShakingSprites() {
      this._shakingSprites.forEach(glyph => this.removeChild(glyph));
      this._shakingSprites = [];
      return 'removed';
    }
    close() { this.visible = false; this._shakingSprites.forEach(glyph => { glyph.opacity = 0; }); }
    open() { this.visible = true; this._shakingSprites.forEach(glyph => { glyph.opacity = 255; }); }
  }
  const originalCreate = Message.prototype.createShakingCharacter;
  const originalRemove = Message.prototype.removeShakingSprites;
  let patched = pinSourceFingerprint(source, 'expectedCreate', originalCreate);
  patched = pinSourceFingerprint(patched, 'expectedRemove', originalRemove);
  if (unknownCreate) Message.prototype.createShakingCharacter = function() {};
  if (unknownRemove) Message.prototype.removeShakingSprites = function() {};
  const context = { __pmjsBuiltinRequire: require, Window_Message: Message,
    PMJS: { plugins: {
      registerOptimization(plugin, definition) { assert.equal(plugin, 'SRD_ShakingText'); this.definition = definition; },
      onLoaded(name, owner, callback) { loaded.set(name, callback); }
    }, phases: { on(name, owner, callback) { phases.set(name, callback); } },
    optimizations: { isEnabled() { return !disabled; }, refuse(id, reason) { refusals.push(reason); } },
    compat: { observed(id, reason) { retained.push([id, reason]); } } } };
  vm.createContext(context);
  const pluginHooks = { ...context.PMJS.plugins };
  require('./helpers/runtime-context.cjs').runModule(context, 'js/pmjs-rpgmaker/plugins.js');
  Object.assign(context.PMJS.plugins, pluginHooks);
  vm.runInContext(patched, context);
  return { counts, Message, Sprite, Bitmap, loaded, phases, refusals, retained, originalCreate, originalRemove,
    install() { loaded.get('SRD_ShakingText')(); phases.get('afterGuestPlugins')(); },
    glyph(message, text = 'A') { message.createShakingCharacter(text); return message._shakingSprites.at(-1); } };
}

test('installs after guest plugins and retires 150 synchronous pages without retaining backing', () => {
  const h = fixture();
  assert.equal(h.phases.size, 0);
  h.loaded.get('SRD_ShakingText')();
  assert.equal(h.Message.prototype.createShakingCharacter, h.originalCreate);
  h.phases.get('afterGuestPlugins')();
  const message = new h.Message();
  for (let page = 0; page < 150; page++) {
    message.contents.fontFace = page % 2 ? 'font-a' : 'font-b';
    message.contents.fontSize = 20 + page % 5;
    for (const char of 'page') {
      assert.equal(message.createShakingCharacter(char, 8 + page % 3), 'created');
      const glyph = message._shakingSprites.at(-1);
      assert.equal(glyph.bitmap.text, char);
      assert.equal(glyph.bitmap.fontFace, message.contents.fontFace);
      assert.equal(glyph.bitmap.fontSize, message.contents.fontSize);
      glyph.update(); assert.equal(glyph.x, 11);
    }
    assert.equal(message.removeShakingSprites(), 'removed');
    assert.equal(message.children.length, 0);
    assert.equal(message._shakingSprites.length, 0);
    assert.deepEqual(h.counts, { canvases: 0, bases: 0, textures: 0, sprites: 0 });
  }
  message.removeShakingSprites();
  assert.deepEqual(h.retained, []);
});

test('close/open and retained detached windows preserve glyph identity, pixels and animation', () => {
  const h = fixture(); h.install();
  const message = new h.Message(), glyph = h.glyph(message), bitmap = glyph.bitmap;
  message.close(); assert.equal(glyph.opacity, 0);
  message.open(); assert.equal(glyph.opacity, 255);
  const scene = new h.Message(); scene.addChild(message); scene.removeChild(message);
  assert.equal(glyph.parent, message);
  assert.equal(glyph.bitmap, bitmap); assert.equal(bitmap.text, 'A');
  glyph.update(); assert.equal(glyph.x, 11);
  assert.equal(bitmap.__canvas.live, true);
  scene.addChild(message);
  assert.equal(glyph.bitmap, bitmap);
  message.removeShakingSprites(); assert.equal(bitmap.__canvas.live, false);
});

for (const kind of ['reparented', 'detached', 'bitmap', 'texture', 'canvas', 'child', 'destroy', 'unknown entry',
  'shared bitmap', 'shared texture', 'duplicate entry', 'removal transfer', 'removal replacement']) {
  test(`${kind} preserves resources outside the private glyph disposal contract`, () => {
    const h = fixture(); h.install();
    const message = new h.Message(), glyph = h.glyph(message), original = glyph.bitmap;
    const base = glyph.texture.baseTexture, texture = glyph.texture, canvas = original.__canvas;
    if (kind === 'reparented' || kind === 'detached') {
      message.removeChild(glyph);
      if (kind === 'reparented') new h.Message().addChild(glyph);
    }
    if (kind === 'bitmap') glyph.bitmap = new h.Bitmap(8, 24);
    if (kind === 'texture') glyph.texture = new h.Sprite(new h.Bitmap(8, 24)).texture;
    if (kind === 'canvas') original.__canvas = new h.Bitmap(8, 24).__canvas;
    if (kind === 'child') glyph.children.push({});
    if (kind === 'destroy') glyph.destroy = function() { throw new Error('unrecognized destroy'); };
    if (kind === 'unknown entry') {
      message.removeShakingSprites();
      const foreign = new h.Sprite(new h.Bitmap(8, 24));
      message.addChild(foreign); message._shakingSprites.push(foreign);
      const before = { ...h.counts }; message.removeShakingSprites();
      assert.deepEqual(h.counts, before); return;
    }
    if (kind === 'shared bitmap') {
      const other = h.glyph(message); other.bitmap = original;
    }
    if (kind === 'shared texture') {
      const foreign = new h.Sprite(new h.Bitmap(8, 24)); foreign.texture = texture;
      message.addChild(foreign); message._shakingSprites.push(foreign);
    }
    if (kind === 'duplicate entry') message._shakingSprites.push(glyph);
    if (kind === 'removal transfer' || kind === 'removal replacement') {
      const remove = message.removeChild;
      message.removeChild = function(sprite) {
        remove.call(this, sprite);
        if (kind === 'removal transfer') new h.Message().addChild(sprite);
        else sprite.bitmap = new h.Bitmap(8, 24);
      };
    }
    message.removeShakingSprites();
    assert.equal(glyph.destroyed, undefined);
    assert.equal(base.source, canvas); assert.equal(canvas.live, true);
    assert.ok(h.retained.length);
  });
}

for (const options of [{ disabled: true }, { unknownCreate: true }, { unknownRemove: true }]) {
  test(`disabled or unrecognized methods preserve authored behavior: ${JSON.stringify(options)}`, () => {
    const h = fixture(options), create = h.Message.prototype.createShakingCharacter;
    const remove = h.Message.prototype.removeShakingSprites;
    h.install();
    assert.equal(h.Message.prototype.createShakingCharacter, create);
    assert.equal(h.Message.prototype.removeShakingSprites, remove);
    assert.equal(h.refusals.length, options.disabled ? 0 : 1);
  });
}

for (const shared of ['bitmap', 'texture', 'base', 'canvas']) {
  test(`sharing ${shared} during page removal preserves both glyphs before any disposal`, () => {
    const h = fixture(); h.install();
    const message = new h.Message(), first = h.glyph(message), second = h.glyph(message);
    const firstCanvas = first.bitmap.__canvas, firstBase = first.texture.baseTexture;
    const before = { ...h.counts }, remove = message.removeChild;
    message.removeChild = function(sprite) {
      remove.call(this, sprite);
      if (sprite !== second) return;
      if (shared === 'bitmap') second.bitmap = first.bitmap;
      if (shared === 'texture') second.texture = first.texture;
      if (shared === 'base') second.texture.baseTexture = first.texture.baseTexture;
      if (shared === 'canvas') second.bitmap.__canvas = first.bitmap.__canvas;
    };
    message.removeShakingSprites();
    assert.equal(first.destroyed, undefined); assert.equal(second.destroyed, undefined);
    assert.equal(firstBase.source, firstCanvas); assert.equal(firstCanvas.live, true);
    assert.deepEqual(h.counts, before);
    assert.ok(h.retained.length >= 2);
  });
}

test('late producer/remover instance overrides keep previously created glyph backing', () => {
  for (const method of ['createShakingCharacter', 'removeShakingSprites']) {
    const h = fixture(); h.install();
    const message = new h.Message(), glyph = h.glyph(message), original = message[method];
    message[method] = function(...args) { return original.apply(this, args); };
    message.removeShakingSprites();
    assert.equal(glyph.bitmap.__canvas.live, true);
    assert.equal(glyph.destroyed, undefined);
  }
});

test('native deferred canvas snapshots survive private glyph disposal and backing settles',
  { skip: !process.env.PMJS_NATIVE_ADDON }, () => {
    const native = require(path.resolve(process.env.PMJS_NATIVE_ADDON));
    const { createHostContext } = require('./helpers/mz-host-context.cjs');
    native.initialize({ gameRoot: path.resolve(__dirname, 'assets'), width: 32, height: 32,
      windowTitle: 'Glyph canvas ownership' });
    const context = createHostContext(native, { graphics: false });
    const h = fixture({ canvasContext: context }); h.install();
    const message = new h.Message();
    const initial = native.canvas.memory().liveCount;
    for (let page = 0; page < 150; page++) {
      const glyph = h.glyph(message), canvas = glyph.bitmap.__canvas;
      const retained = context.document.createElement('canvas'); retained.width = 8; retained.height = 24;
      retained.getContext('2d').drawImage(canvas, 0, 0);
      message.removeShakingSprites();
      assert.equal(canvas._nativeCanvas, null);
      assert.deepEqual(Array.from(retained.getContext('2d').getImageData(3, 3, 1, 1).data), [255, 0, 0, 255]);
      retained._releaseNativeCanvas();
      assert.equal(native.canvas.memory().liveCount, initial);
    }
  });
