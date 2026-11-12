'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectEngine } = require('../runner/engine-selection.cjs');
const { parse } = require('../runner/cli.cjs');

test('engine selection preserves the default and rejects unknown implementations', () => {
  assert.equal(selectEngine({}), 'javascript');
  assert.equal(selectEngine(parse(['--engine','native-mv'])), 'native-mv');
  assert.equal(selectEngine({ engine: 'javascript', config: 'not-read-with-explicit-engine' }), 'javascript');
  assert.throws(() => selectEngine({ engine: 'anything-else' }), /unknown engine/);
});
