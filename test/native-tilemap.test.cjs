'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installTilemap } = require('../runner/native-tilemap.cjs');

test('tile shadows preserve saved original drawing and invalidate changed producers', () => {
  const scope = {}, invalidations = [];
  const bridge = installTilemap({ scope }, { gameDataInvoke(...args) { invalidations.push(args); } }, {});
  assert.equal(bridge.draw(15, 0, 0, 48, 48), undefined);
  const base = scope.ShaderTilemap.prototype._drawShadow;
  scope.ShaderTilemap.prototype._drawShadow = function(layer, bits, x, y) { base.call(this, layer, bits, x + 2, y + 3); };
  bridge.update(); bridge.update();
  assert.equal(invalidations.length, 1);
  assert.deepEqual(bridge.draw(5, 10, 20, 48, 32), [[12, 23, 24, 16], [12, 39, 24, 16]]);
  scope.ShaderTilemap.prototype._drawShadow = function(layer) { layer.addRect(0, 0, 0, 0, 0, 1, 1); };
  assert.throws(() => bridge.draw(1, 0, 0, 48, 48), /only supports shadow rectangles/);
  scope.ShaderTilemap.prototype._drawShadow = base; bridge.update();
  assert.equal(invalidations.length, 2);
});
