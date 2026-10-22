'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parsePluginManifest } = require('../runner/plugin-manifest.cjs');

test('static plugin parsing preserves comments, order, parameters, and raw status values', () => {
  const result = parsePluginManifest(`// Generated manifest
var $plugins = [
  /* comments inside the generated literal are data-free syntax */
  {"name":"First","status":true,"parameters":{"mode":"fast"},}, // trailing comment
  null,
  7,
  {"status":true},
  {"name":"Second","status":1,"parameters":{"n":2}},
  {"name":"Third","status":"true","parameters":{}}
];`);
  assert.deepEqual(result.plugins.map(plugin => plugin?.name), ['First', undefined, undefined, undefined, 'Second', 'Third']);
  assert.deepEqual(result.plugins[0].parameters, { mode: 'fast' });
  assert.equal(result.plugins[4].status, 1);
  assert.equal(result.plugins[5].status, 'true');
});

test('plugin manifest parser rejects expressions without executing trailing game code', () => {
  globalThis.pluginManifestSideEffect = false;
  const result = parsePluginManifest(`var $plugins = [{"name":"Safe","status":true,"parameters":{}}];
globalThis.pluginManifestSideEffect = true;`);
  assert.equal(globalThis.pluginManifestSideEffect, false);
  assert.equal(result.plugins[0].name, 'Safe');
  assert.throws(() => parsePluginManifest('var $plugins = [makePlugin()];'), /unsupported generated plugin manifest/);
  delete globalThis.pluginManifestSideEffect;
});

test('plugin assignment search ignores comment and string examples', () => {
  const source = [
    '// Example: $plugins = []',
    'var note = "$plugins = []";',
    'var template = `$plugins = []`;',
    'var object = { $plugins: [] };',
    'var $plugins = [{"name":"Actual","status":true}];'
  ].join('\n');
  assert.deepEqual(parsePluginManifest(source).plugins.map(plugin => plugin.name), ['Actual']);
});
