'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createObjectRenderer } = require('../runner/native-object-renderer.cjs');

test('renderer checks observe method replacements, draw modes and added plugins immediately', () => {
  const { renderer, changed } = createObjectRenderer({});
  assert.equal(changed(), false);
  const original = renderer.plugins.sprite.render;
  renderer.plugins.sprite.render = () => {}; assert.equal(changed(), true);
  renderer.plugins.sprite.render = original; assert.equal(changed(), false);
  renderer.plugins.picture.drawModes[3] = true; assert.equal(changed(), true);
  renderer.plugins.picture.drawModes.length = 0; assert.equal(changed(), false);
  renderer.plugins.custom = {}; assert.equal(changed(), false);
  renderer.plugins.custom.render = () => {}; assert.equal(changed(), true);
  delete renderer.plugins.custom; assert.equal(changed(), false);
  const sprite = renderer.plugins.sprite;
  renderer.plugins.sprite = { render: original }; assert.equal(changed(), true);
  renderer.plugins.sprite = sprite; assert.equal(changed(), false);
  renderer.plugins = { ...renderer.plugins }; assert.equal(changed(), true);
});

test('renderer checks observe replacement of setObjectRenderer', () => {
  const { renderer, changed } = createObjectRenderer({});
  const original = renderer.setObjectRenderer;
  renderer.setObjectRenderer = () => {}; assert.equal(changed(), true);
  renderer.setObjectRenderer = original; assert.equal(changed(), false);
});
