'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { runModule } = require('./helpers/runtime-context.cjs');

function setup({ character = false } = {}) {
  let releases = 0;
  function Bitmap(url, ready = false) {
    this._url = url;
    this.ready = ready;
    this.width = ready ? 576 : 0;
    this.height = ready ? 768 : 0;
    this.listeners = [];
    this._image = { _nativeImage: ready ? { handle: 7, width: 576, height: 768 } : null };
  }
  Bitmap.prototype.isReady = function() { return this.ready; };
  Bitmap.prototype.addLoadListener = function(fn) {
    if (this.ready) fn(this); else this.listeners.push(fn);
  };
  Bitmap.prototype.finish = function() {
    this.ready = true;
    this.width = 576;
    this.height = 768;
    this.listeners.splice(0).forEach(fn => fn(this));
  };
  function Sprite() {
    this._bitmap = null;
    this._frame = { x: 0, y: 0, width: 0, height: 0,
      clone() { return { ...this }; } };
    this.texture = { frame: { width: 0, height: 0 } };
  }
  Sprite.prototype.setFrame = function(x, y, width, height) {
    this._refreshFrame = false;
    Object.assign(this._frame, { x, y, width, height });
    this._refresh();
  };
  Sprite.prototype._refresh = function() {
    this.texture.frame = { ...this._frame,
      width: Math.min(this._frame.width, this._bitmap?.width || 0),
      height: Math.min(this._frame.height, this._bitmap?.height || 0) };
  };
  Sprite.prototype._onBitmapLoad = function(bitmap) {
    if (bitmap === this._bitmap && this._refreshFrame) {
      this._refreshFrame = false;
      this._frame.width = bitmap.width;
      this._frame.height = bitmap.height;
    }
    this._refresh();
  };
  Object.defineProperty(Sprite.prototype, 'bitmap', {
    configurable: true,
    get() { return this._bitmap; },
    set(value) {
      if (this._bitmap !== value) {
        this._bitmap = value;
        if (value) {
          this._refreshFrame = true;
          value.addLoadListener(this._onBitmapLoad.bind(this));
        } else {
          this._refreshFrame = false;
          this.texture.frame = { width: 0, height: 0 };
        }
      }
    }
  });
  function Game_CharacterBase() {
    this._pattern = 1; this._direction = 2; this._characterIndex = 0;
  }
  Game_CharacterBase.prototype.pattern = function() { return this._pattern < 3 ? this._pattern : 1; };
  Game_CharacterBase.prototype.direction = function() { return this._direction; };
  Game_CharacterBase.prototype.characterIndex = function() { return this._characterIndex; };
  function Sprite_Character() {
    Sprite.call(this);
    this._character = new Game_CharacterBase();
    this._tileId = 0; this._bushDepth = 0; this._isBigCharacter = false; this.halfBodyUpdates = 0;
  }
  Sprite_Character.prototype = Object.create(Sprite.prototype);
  Sprite_Character.prototype.patternWidth = function() { return this.bitmap.width / (this._isBigCharacter ? 3 : 12); };
  Sprite_Character.prototype.patternHeight = function() { return this.bitmap.height / (this._isBigCharacter ? 4 : 8); };
  Sprite_Character.prototype.characterBlockX = function() { return this._isBigCharacter ? 0 : this._character.characterIndex() % 4 * 3; };
  Sprite_Character.prototype.characterBlockY = function() { return this._isBigCharacter ? 0 : Math.floor(this._character.characterIndex() / 4) * 4; };
  Sprite_Character.prototype.characterPatternX = function() { return this._character.pattern(); };
  Sprite_Character.prototype.characterPatternY = function() { return (this._character.direction() - 2) / 2; };
  Sprite_Character.prototype.updateHalfBodySprites = function() { this.halfBodyUpdates++; };
  Sprite_Character.prototype.updateCharacterFrame = function() {
    const width = this.patternWidth(), height = this.patternHeight();
    const x = (this.characterBlockX() + this.characterPatternX()) * width;
    const y = (this.characterBlockY() + this.characterPatternY()) * height;
    this.updateHalfBodySprites();
    this.setFrame(x, y, width, height);
  };
  const observations = [];
  const context = vm.createContext({ __pmjsBuiltinRequire: require, Bitmap, Sprite, Sprite_Character, Game_CharacterBase, PMJS: { config: {},
    compat: { observed: (...args) => observations.push(args) },
    optimizations: { register() {}, isEnabled() { return false; } } },
    NativeHost: { runtime: { loadScript() {} }, images: {
      acquireCached() { return { handle: 7, width: 576, height: 768 }; },
      release() { releases++; }
    } }, nativeBootPhase() {},
    trackNativeResource: value => value,
    releaseNativeResource() { releases++; },
    Graphics: function() {}, Input: function() {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web/filesystem.js'), 'utf8'), context);
  const optimizationHooks = { ...context.PMJS.optimizations };
  context.PMJS.config ||= {};
  require('./helpers/runtime-context.cjs').runModule(context, 'js/pmjs-core/optimizations.js');
  Object.assign(context.PMJS.optimizations, optimizationHooks);
  runModule(context, 'js/pmjs-core/methods.js');
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-mv/bitmap.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-pixi4/bitmap-presentation.js'), 'utf8'), context);
  if (character) {
    const matchesSource = context.PMJS.methods.matchesSource;
    const fixtureMethods = new Set([...Object.values(Sprite_Character.prototype), ...Object.values(Game_CharacterBase.prototype)]);
    context.PMJS.methods.matchesSource = method => fixtureMethods.has(method);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-mv/character-presentation.js'), 'utf8'), context);
    context.PMJS.methods.matchesSource = matchesSource;
  }
  const old = new Bitmap('sheet.png', true);
  const sprite = character ? new Sprite_Character() : new Sprite();
  sprite.bitmap = old;
  sprite.setFrame(0, 0, 48, 96);
  return { Bitmap, sprite, old, context, presentation: context.PMJS.pixi4.bitmapPresentation,
    releases: () => releases, observations };
}

test('same-sheet reload keeps pixels visible and swaps with the live animation frame', () => {
  const { Bitmap, sprite, old, presentation, releases } = setup();
  const incoming = new Bitmap('sheet.png');
  sprite.bitmap = incoming;
  sprite.setFrame(192, 96, 48, 96);
  assert.equal(sprite.bitmap, incoming);
  assert.equal(sprite.bitmap.isReady(), false);
  sprite.bitmap.marker = 42;
  assert.equal(old.marker, undefined);
  assert.equal(incoming.marker, 42);
  assert.equal(sprite.texture.frame.width, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(presentation.get(sprite).texture.frame)),
    { x: 192, y: 96, width: 48, height: 96 });
  incoming.finish();
  assert.equal(sprite.bitmap, incoming);
  assert.deepEqual([sprite.texture.frame.x, sprite.texture.frame.y,
    sprite.texture.frame.width, sprite.texture.frame.height], [192, 96, 48, 96]);
  assert.equal(presentation.get(sprite), null);
  assert.equal(releases(), 1);
});

test('character reload animates retained pixels without changing guest readiness or frame', () => {
  const { Bitmap, sprite, presentation, releases } = setup({ character: true });
  sprite.bitmap = new Bitmap('sheet.png');
  sprite._character._pattern = 2;
  sprite._character._direction = 6;
  sprite.updateCharacterFrame();
  assert.equal(sprite.halfBodyUpdates, 1);
  assert.equal(sprite.bitmap.isReady(), false);
  assert.deepEqual([sprite._frame.x, sprite._frame.y, sprite._frame.width, sprite._frame.height], [0, 0, 0, 0]);
  assert.deepEqual(JSON.parse(JSON.stringify(presentation.get(sprite).texture.frame)),
    { x: 96, y: 192, width: 48, height: 96 });
  sprite.setFrame(0, 0, 0, 0);
  assert.equal(presentation.get(sprite).texture.frame.width, 0, 'an authored empty frame hides retained pixels');
  sprite.updateCharacterFrame();
  sprite.bitmap.finish();
  sprite.updateCharacterFrame();
  assert.equal(sprite.halfBodyUpdates, 3);
  assert.deepEqual([sprite._frame.x, sprite._frame.y, sprite._frame.width, sprite._frame.height], [96, 192, 48, 96]);
  assert.equal(presentation.get(sprite), null);
  assert.equal(releases(), 1);
});

test('character presentation leaves custom geometry and first loads to the original update', () => {
  for (const mode of ['custom', 'first']) {
    const { Bitmap, sprite, presentation } = setup({ character: true });
    if (mode === 'first') sprite.bitmap = null;
    sprite.bitmap = new Bitmap('sheet.png');
    if (mode === 'custom') sprite.characterPatternX = () => 7;
    sprite.updateCharacterFrame();
    assert.equal(sprite.halfBodyUpdates, 1);
    assert.equal(presentation.get(sprite)?.texture.frame.width || 0, 0);
    assert.equal(sprite.bitmap.isReady(), false);
  }
});

test('superseding assignments and clears prevent stale reloads from taking over', () => {
  for (const replacement of ['other.png', 'sheet.png', null]) {
    const { Bitmap, sprite } = setup();
    const pending = new Bitmap('sheet.png');
    sprite.bitmap = pending;
    const next = replacement && new Bitmap(replacement, true);
    sprite.bitmap = next;
    pending.finish();
    assert.equal(sprite.bitmap, next);
    if (!next) assert.equal(sprite.texture.frame.width, 0);
  }
});

test('new files and first loads retain stock readiness behavior', () => {
  const { Bitmap, sprite } = setup();
  for (const clear of [false, true]) {
    if (clear) sprite.bitmap = null;
    const next = new Bitmap('other.png');
    sprite.bitmap = next;
    sprite.setFrame(0, 0, 48, 96);
    assert.equal(sprite.bitmap, next);
    assert.equal(sprite.texture.frame.width, 0);
    next.finish();
    assert.equal(sprite.texture.frame.width, 48);
  }
});

test('canvas-modified and unready predecessors are not held as identical pixels', () => {
  for (const mode of ['canvas', 'unready']) {
    const { Bitmap, sprite, old } = setup();
    if (mode === 'canvas') old.__canvas = {}; else old.ready = false;
    const next = new Bitmap('sheet.png');
    sprite.bitmap = next;
    assert.equal(sprite.bitmap, next);
    assert.equal(sprite.bitmap.isReady(), false);
  }
});

test('load without a later setFrame preserves original frame expansion', () => {
  const { Bitmap, sprite, presentation } = setup();
  const next = new Bitmap('sheet.png');
  sprite.bitmap = next;
  assert.equal(presentation.get(sprite).texture.frame.width, 48);
  next.finish();
  assert.equal(sprite.texture.frame.width, 576);
  assert.equal(sprite.texture.frame.height, 768);
});

test('changed native identity and disabled presentation do not retain pixels', () => {
  for (const mode of ['changed', 'disabled']) {
    const { Bitmap, sprite, context, presentation, releases } = setup();
    if (mode === 'changed') context.NativeHost.images.acquireCached = () => ({ handle: 99 });
    else context.PMJS.config.preserveBitmapReloadPixels = false;
    sprite.bitmap = new Bitmap('sheet.png');
    assert.equal(presentation.get(sprite), null);
    assert.equal(releases(), mode === 'changed' ? 1 : 0);
  }
});

test('mutation, failure and destruction release presentation ownership once', () => {
  for (const mode of ['canvas', 'error', 'destroy']) {
    const { Bitmap, sprite, presentation, releases } = setup();
    const next = new Bitmap('sheet.png');
    sprite.bitmap = next;
    if (mode === 'canvas') next.__canvas = {};
    if (mode === 'error') next.isError = () => true;
    if (mode === 'destroy') sprite.destroy();
    assert.equal(presentation.get(sprite), null);
    next.finish();
    sprite.destroy();
    assert.equal(releases(), 1);
  }
});

test('unverifiable image URLs follow the original assignment without cache acquisition', () => {
  for (const url of ['blob:123', 'data:image/png;base64,AA', 'https://example.test/image.png',
    '/absolute.png', '../image.png', '%2Fabsolute.png', '%2e%2e/image.png', 'bad-%FF.png']) {
    const { Bitmap, sprite, old, context, presentation } = setup();
    old._url = url;
    let acquisitions = 0;
    context.NativeHost.images.acquireCached = () => { acquisitions++; throw new Error('must not resolve'); };
    const incoming = new Bitmap(url);
    assert.doesNotThrow(() => { sprite.bitmap = incoming; });
    assert.equal(sprite.bitmap, incoming);
    assert.equal(presentation.get(sprite), null);
    assert.equal(acquisitions, 0);
  }
});

test('a cache lookup failure cannot delay or prevent the original Bitmap assignment', () => {
  const { Bitmap, sprite, context, presentation, observations } = setup();
  const incoming = new Bitmap('sheet.png');
  context.NativeHost.images.acquireCached = () => {
    assert.equal(sprite.bitmap, incoming, 'the engine setter runs before optional acquisition');
    throw new Error('cache source unavailable');
  };
  assert.doesNotThrow(() => { sprite.bitmap = incoming; });
  assert.equal(sprite.bitmap, incoming);
  assert.equal(presentation.get(sprite), null);
  assert.deepEqual(observations, [['render.bitmap-presentation-miss', 'cache source unavailable']]);
});

test('presentation decodes before applying its file prefix and traversal policies', () => {
  const { Bitmap, sprite, old, context, presentation } = setup(), paths = [];
  const url = 'file%3A%2F%2F%2Fgame%2Fimg%2Fsheet%2520.png?v=1';
  old._url = url;
  context.NativeHost.images.acquireCached = path => {
    paths.push(path);
    return { handle: 7, width: 576, height: 768 };
  };
  sprite.bitmap = new Bitmap(url);
  assert.ok(presentation.get(sprite));
  assert.deepEqual(paths, ['img/sheet%20.png']);
});
