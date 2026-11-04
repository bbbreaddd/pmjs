'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { loadPmjsRuntime } = require('../../helpers/runtime-context.cjs');
const source = fs.readFileSync(require.resolve('../../../patches/isat/blank-characters.js'), 'utf8');

function fixture({ unknown = false } = {}) {
  const ctx = loadPmjsRuntime({ __pmjsBuiltinRequire: require });
  vm.runInContext(`
    function Sprite() {} function Sprite_Base() {} function Sprite_Character() {}
    Sprite_Base.prototype = Object.create(Sprite.prototype);
    Sprite_Character.prototype = Object.create(Sprite_Base.prototype);
    function Game_CharacterBase() {} function Spriteset_Map() {}
    Spriteset_Map.prototype.update = function() { this.sprite.update(); if (this.fail) throw this.fail; };
    var Olivia = { HorrorEffects: { ___Sprite_update___: function() {} } };
    var $gameMap = { mapId: function() { return this.id; }, id: 30 };
    var ImageManager = { _imageCache: { get: function() { return empty; } } };
    var empty = { width: 1, height: 1 };
  `, ctx);
  const hashes = JSON.parse(source.match(/var hashes = ([\s\S]*?);/)[1]);
  for (const [owner, methods] of Object.entries(hashes)) {
    for (const name of Object.keys(methods)) ctx[owner].prototype[name] = vm.runInContext('(function() {})', ctx);
  }
  const ordinary = ctx.Sprite_Character.prototype.update = function() { this.ordinary = (this.ordinary || 0) + 1; };
  const digest = fn => ctx.PMJS.methods.fingerprint(ctx.PMJS.methods.sourceOf(fn));
  for (const [owner, methods] of Object.entries(hashes)) {
    for (const name of Object.keys(methods)) methods[name] = [digest(ctx[owner].prototype[name])];
  }
  let fixtureSource = source.replace(/var hashes = [\s\S]*?;/, 'var hashes = ' + JSON.stringify(hashes) + ';');
  for (const [hash, fn] of [
    ['0fd3a3e3f5fa2f6d60b4b6c805f4fe3533b02bcb1e154b7716503b626d32cfa9', ctx.Olivia.HorrorEffects.___Sprite_update___],
    ['10d9ca931693e47717a7eee8a178016285c462a9492a2c2cf93a29ffa91d95b1', ctx.Sprite_Base.prototype.startAnimation],
    ['e1ef16368f75f8f947b537e1ba65ef5a325f7c441c5f3bcb9ba1990dbebc9308', ctx.Spriteset_Map.prototype.update]
  ]) fixtureSource = fixtureSource.replaceAll(hash, digest(fn));
  ctx.PMJS.pixi4 = {};
  ctx.PMJS.isatSourceQualification = { verified: true };
  if (unknown) ctx.Sprite.prototype.updateHorrorTV = function() { return 'changed'; };
  vm.runInContext(fixtureSource, ctx);
  ctx.PMJS.phases.emit('beforeBoot');
  const character = Object.assign(new ctx.Game_CharacterBase(), { _characterName: '', _tileId: 0,
    _animationId: 0, _balloonId: 0, _animationPlaying: false, _balloonPlaying: false, _bushDepth: 0 });
  const sprite = Object.assign(new ctx.Sprite_Character(), { _character: character, _characterName: '', _tileId: 0,
    _bushDepth: 0, _animationSprites: [], children: [], _horrorFiltersSource: character,
    _bitmap: ctx.empty, _frame: { width: 0.1, height: 0.1 }, _realFrame: { width: 0, height: 0 }, visible: true });
  const map = new ctx.Spriteset_Map(); map.sprite = sprite;
  return { ctx, sprite, map, ordinary };
}

test('qualified blank characters skip presentation only within the reviewed map update', () => {
  const h = fixture();
  assert.notEqual(h.ctx.Sprite_Character.prototype.update, h.ordinary);
  h.map.update();
  assert.equal(h.sprite.visible, false);
  assert.equal(h.sprite.ordinary, undefined);
  h.sprite.update();
  h.ctx.$gameMap.id = 29; h.map.update();
  assert.equal(h.sprite.ordinary, 2);
  h.ctx.$gameMap.id = 30; h.sprite._character._animationId = 1; h.map.update();
  assert.equal(h.sprite.ordinary, 3);
});

test('unfamiliar and later changed helpers retain ordinary presentation', () => {
  const unknown = fixture({ unknown: true });
  assert.equal(unknown.ctx.Sprite_Character.prototype.update, unknown.ordinary);
  unknown.map.update(); assert.equal(unknown.sprite.ordinary, 1);
  const h = fixture();
  h.ctx.Game_CharacterBase.prototype.screenX = function() { return 123; };
  h.map.update(); assert.equal(h.sprite.ordinary, 1);
});

test('throwing map updates restore ordinary presentation scope', () => {
  const h = fixture(); h.map.fail = Error('map failure');
  assert.throws(() => h.map.update(), /map failure/);
  h.sprite.update(); assert.equal(h.sprite.ordinary, 1);
});
