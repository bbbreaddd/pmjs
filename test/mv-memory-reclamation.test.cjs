'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadPmjsRuntime } = require('./helpers/runtime-context.cjs');

function fixture() {
  class ScreenSprite {}
  const fade = Object.assign(new ScreenSprite(), { alpha: 1, visible: true, renderable: true,
    _red: 0, _green: 0, _blue: 0, worldTransform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 } });
  const scene = { _fadeSprite: fade, children: [fade], alpha: 1, visible: true, renderable: true,
    _fadeSign: -1, _fadeDuration: 0 };
  const renderer = { _pmjsScreenRenderId: 0, _pmjsScreenStage: scene };
  const f = { fade, scene, renderer, changing: true, video: false, renders: true };
  f.context = loadPmjsRuntime({ ScreenSprite,
    Graphics: { _renderer: renderer, _isVideoVisible: () => f.video },
    SceneManager: { _scene: scene, isSceneChanging: () => f.changing },
    pmjsRunRpgMakerTick() {
      if (f.renders) { renderer._pmjsScreenRenderId++; renderer._pmjsScreenStage = scene; }
    }
  }, ['js/pmjs-mv/main-loop.js']);
  f.tick = () => f.context.__pmjsTick(0);
  f.boundary = () => f.context.__pmjsMemoryReclamationBoundary();
  return f;
}

test('only a newly rendered opaque black outgoing scene qualifies', () => {
  const f = fixture(); f.tick(); assert.equal(f.boundary(), 'scene-fade');
  f.renders = false; f.tick(); assert.equal(f.boundary(), null);
  f.renders = true; f.tick(); f.renderer._pmjsScreenStage = {};
  assert.equal(f.boundary(), null);
});

test('dialogue pauses, white/partial fades and rendered overlays remain on the ordinary path', () => {
  for (const change of [
    f => { f.changing = false; f.scene.pause = true; },
    f => { f.fade.alpha = 0.99; }, f => { f.fade._red = 255; },
    f => { f.scene.children.push({ visible: true }); },
    f => { f.scene._fadeSign = 1; }, f => { f.scene._fadeDuration = 1; },
    f => { f.video = true; }, f => { f.scene.alpha = 0.5; }
  ]) {
    const f = fixture(); f.tick(); change(f); assert.equal(f.boundary(), null);
  }
});

test('masks, filters, cached or transformed fade producers cannot establish a boundary', () => {
  for (const change of [
    f => { f.fade._mask = {}; }, f => { f.scene._filters = [{}]; },
    f => { f.fade.cacheAsBitmap = true; }, f => { f.fade.visible = false; },
    f => { f.fade.worldTransform.tx = 10; }, f => { f.fade.worldTransform.a = 0.5; },
    f => { Object.setPrototypeOf(f.fade, {}); }
  ]) {
    const f = fixture(); f.tick(); change(f); assert.equal(f.boundary(), null);
  }
});
