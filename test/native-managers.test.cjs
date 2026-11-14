'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { installTextManager, installSoundManager } = require('../runner/native-managers.cjs');

test('text terms follow database edits, method overrides and configurable getters', () => {
  const scope = { $dataSystem: { currencyUnit: 'G', terms: { basic: ['Level'], params: ['HP'], commands: [], messages: { emerge: '%1 appears' } } } };
  installTextManager(scope);
  const text = scope.TextManager;
  assert.equal(text.level, 'Level'); assert.equal(text.param(0), 'HP');
  assert.equal(text.emerge, '%1 appears'); assert.equal(text.currencyUnit, 'G');
  scope.$dataSystem.terms.basic[0] = 'Rank'; assert.equal(text.level, 'Rank');
  const original = text.basic;
  text.basic = function(id) { return original.call(this, id).toUpperCase(); };
  assert.equal(text.level, 'RANK'); assert.equal(text.command(100), '');
  Object.defineProperty(text, 'level', { value: 'Custom', configurable: true });
  assert.equal(text.level, 'Custom');
  scope.$dataSystem = { currencyUnit: 'Coins', terms: { basic: ['Tier'] } };
  assert.equal(text.currencyUnit, 'Coins'); assert.equal(text.levelA, '');
});

test('system sound helpers honor aliases and delegate playback to the native session', () => {
  const scope = {}, calls = [];
  installSoundManager(scope, { managerInvoke(...args) { calls.push(args); } }, 'session');
  const sound = scope.SoundManager, original = sound.playSystemSound;
  sound.playSystemSound = function(index) { this.lastIndex = index; return original.call(this, index); };
  sound.playEnemyDamage(); sound.playUseSkill(); sound.preloadImportantSounds();
  assert.equal(sound.lastIndex, 23);
  assert.deepEqual(calls, [['session', 'playSystemSound', 10], ['session', 'playSystemSound', 23],
    ...[0, 1, 2, 3].map(index => ['session', 'loadSystemSound', index])]);
});
