'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const runtimeRoot = path.resolve(__dirname, '..');
const optimizationsSource = fs.readFileSync(
  path.join(runtimeRoot, 'js/pmjs-core/optimizations.js'), 'utf8');
const moduleSource = fs.readFileSync(
  path.join(runtimeRoot, 'js/pmjs-plugins/yanfly/event-mini-label.js'), 'utf8');
const lifecycleSource = fs.readFileSync(
  path.join(runtimeRoot, 'js/pmjs-rpgmaker/lifecycle.js'), 'utf8');
const methodsSource = fs.readFileSync(
  path.join(runtimeRoot, 'js/pmjs-core/methods.js'), 'utf8');
const pluginsSource = fs.readFileSync(
  path.join(runtimeRoot, 'js/pmjs-rpgmaker/plugins.js'), 'utf8');

// YEP-shaped setupMiniLabel with deliberately different formatting: the
// installer must recognize it anyway (whitespace-insensitive fingerprint).
const YEP_SHAPE = `function() {
    if (this._miniLabel) {
      if(this._miniLabel._text !== "") {
        if(!this._miniLabel.parent) {
          SceneManager._scene._spriteset.addChild(this._miniLabel);
        }
      }
      else if(this._miniLabel._text === "") {
        if(!!this._miniLabel.parent) {
          this._miniLabel.parent.removeChild(this._miniLabel);
        }
      }
      return;
    }
    if (!SceneManager._scene._spriteset) return;
    this._miniLabel = new Window_EventMiniLabel();
    this._miniLabel.setCharacter(this._character);
    if(this._miniLabel._text === "") {return;}
    SceneManager._scene._spriteset.addChild(this._miniLabel);
  }`;

function makeHost({
  shape = YEP_SHAPE,
  taggedPages = [],
  env = {},
  disableOptimizations = [],
  useAutonomousFallback = false,
  classifyCounter = null
} = {}) {
  const calls = { constructed: 0, original: 0 };
  const hooks = {};
  const context = {
    calls,
    hooks,
    PMJS_GAME_CONFIG: { disableOptimizations },
    SceneManager: { _scene: { _spriteset: {} } },
    NativeHost: {
      runtime: {
        env(name) {
          if (name === 'PMJS_NATIVE_FASTPATHS' && !useAutonomousFallback) {
            return 'sidecar';
          }
          return env[name];
        }
      }
    },
    console: { log() {} },
    pmjsRegisterHook(name, callback) { hooks[name] = callback; }
  };

  context.Window_EventMiniLabel = function Window_EventMiniLabel() {
    context.calls.constructed++;
    this._text = '';
  };
  context.Window_EventMiniLabel.prototype.setCharacter = function() {};
  context.Sprite_Character = function Sprite_Character() {};

  vm.createContext(context);
  vm.runInContext(lifecycleSource, context, { filename: 'lifecycle.js' });
  vm.runInContext(methodsSource, context, { filename: 'methods.js' });
  vm.runInContext(pluginsSource, context, { filename: 'plugins.js' });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-core/config.js'), 'utf8'), context);
  vm.runInContext(optimizationsSource, context, { filename: 'optimizations.js' });
  vm.runInContext(
    `Sprite_Character.prototype.setupMiniLabel = (${shape});`,
    context, { filename: 'minilabel-shape.js' });

  if (!useAutonomousFallback) {
    context.__pmjsBuiltinRequire = () => ({
      pageHasMiniLabel(character) {
        if (classifyCounter) classifyCounter.count++;
        const page = character.event().pages[character._pageIndex];
        return taggedPages.includes(page);
      }
    });
  }

  vm.runInContext(moduleSource, context, { filename: 'event-mini-label.js' });
  context.PMJS.plugins.execute('YEP_EventMiniLabel', function() {});
  return context;
}

function eventSprite(context, page, list) {
  const sprite = new context.Sprite_Character();
  const model = {
    _eventId: 7,
    _pageIndex: 0,
    _page: page,
    event() { return { pages: [page] }; },
    page() { return page; },
    list() { return list || []; }
  };
  sprite._character = model;
  return { sprite, model };
}

test('registers plugins.yanfly.event-mini-label optimization', () => {
  const context = makeHost();
  assert.equal(context.PMJS.optimizations.isEnabled('plugins.yanfly.event-mini-label'), true);
  assert.ok(context.PMJS.optimizations.ids().includes('plugins.yanfly.event-mini-label'));
});

test('untagged page skips construction with fastpaths sidecar', () => {
  const context = makeHost();
  const { sprite } = eventSprite(context, { id: 'plain' });
  sprite.setupMiniLabel();
  sprite.setupMiniLabel();
  assert.equal(sprite._miniLabel, undefined);
  assert.equal(context.calls.constructed, 0);
  assert.equal(context.Sprite_Character.prototype.__pmjsMiniLabelCache, true);
});

test('tagged page constructs through the original path with fastpaths sidecar', () => {
  const page = { id: 'labeled' };
  const context = makeHost({ taggedPages: [page] });
  const { sprite } = eventSprite(context, page);
  sprite.setupMiniLabel();
  assert.ok(sprite._miniLabel);
  assert.equal(context.calls.constructed, 1);
});

test('autonomous JS fallback detects tagged comments in event command list', () => {
  const context = makeHost({ useAutonomousFallback: true });
  const taggedPage = { id: 'labeled' };
  const commandList = [
    { code: 108, parameters: ['<Mini Label: Shopkeeper>'] }
  ];
  const { sprite } = eventSprite(context, taggedPage, commandList);

  sprite.setupMiniLabel();
  assert.ok(sprite._miniLabel);
  assert.equal(context.calls.constructed, 1);
});

test('autonomous JS fallback skips untagged events', () => {
  const context = makeHost({ useAutonomousFallback: true });
  const untaggedPage = { id: 'plain' };
  const commandList = [
    { code: 108, parameters: ['Random note'] },
    { code: 408, parameters: ['More comments'] }
  ];
  const { sprite } = eventSprite(context, untaggedPage, commandList);

  sprite.setupMiniLabel();
  assert.equal(sprite._miniLabel, undefined);
  assert.equal(context.calls.constructed, 0);
});

test('page change from untagged to tagged constructs', () => {
  const plain = { id: 'plain' };
  const labeled = { id: 'labeled' };
  const context = makeHost({ taggedPages: [labeled] });
  const { sprite, model } = eventSprite(context, plain);
  sprite.setupMiniLabel();
  assert.equal(sprite._miniLabel, undefined);
  model._page = labeled;
  model.event = () => ({ pages: [labeled] });
  model.page = () => labeled;
  sprite.setupMiniLabel();
  assert.ok(sprite._miniLabel);
  assert.equal(context.calls.constructed, 1);
});

test('interleaved sprites on different pages classify once each', () => {
  // A shared closure cache is defeated by interleaved multi-sprite updates:
  // every sprite on a different page replaces the key and forces a
  // re-classify on every frame. Per-sprite state classifies once per page.
  const classifyCounter = { count: 0 };
  const pageA = { id: 'a' };
  const pageB = { id: 'b' };
  const context = makeHost({ taggedPages: [], classifyCounter });
  const spriteA = eventSprite(context, pageA).sprite;
  const spriteB = eventSprite(context, pageB).sprite;
  for (let i = 0; i < 3; i++) {
    spriteA.setupMiniLabel();
    spriteB.setupMiniLabel();
  }
  assert.equal(classifyCounter.count, 2);
  assert.equal(spriteA._miniLabel, undefined);
  assert.equal(spriteB._miniLabel, undefined);
  assert.equal(context.calls.constructed, 0);
});

test('non-event characters keep the reference path', () => {
  const context = makeHost();
  const sprite = new context.Sprite_Character();
  sprite._character = {};
  sprite.setupMiniLabel();
  assert.equal(context.calls.constructed, 1);
});

test('rewritten shape declines the cache', () => {
  const context = makeHost({
    shape: `function() { this.customLabelPass(); return; }`
  });
  assert.equal(context.Sprite_Character.prototype.__pmjsMiniLabelCache, undefined);
});

test('disabled via disableOptimizations leaves reference method alone', () => {
  const context = makeHost({
    disableOptimizations: ['plugins.yanfly.event-mini-label']
  });
  assert.equal(context.Sprite_Character.prototype.__pmjsMiniLabelCache, undefined);
});

test('disabled via PMJS_DISABLE_OPT leaves reference method alone', () => {
  const context = makeHost({
    env: { PMJS_DISABLE_OPT: 'plugins.yanfly.event-mini-label' }
  });
  assert.equal(context.Sprite_Character.prototype.__pmjsMiniLabelCache, undefined);
});

test('disabled via PMJS_YEP_MINI_LABEL=0 leaves reference method alone', () => {
  const context = makeHost({
    env: { PMJS_YEP_MINI_LABEL: '0' }
  });
  assert.equal(context.Sprite_Character.prototype.__pmjsMiniLabelCache, undefined);
});
