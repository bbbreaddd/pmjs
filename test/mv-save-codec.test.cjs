'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encodeGraph, decodeGraph } = require('../runner/mv-save-codec.cjs');

test('save codec preserves classes, array wrappers and repeated references', () => {
  const actor = { '@': 'Game_Actor', _hp: 12 };
  const source = { actors: [null, actor], selected: actor };
  assert.deepEqual(decodeGraph(encodeGraph(source)), source);
  assert.equal(source.actors[1], source.selected);
});

test('save codec rejects broken references and cyclic state explicitly', () => {
  assert.throws(() => decodeGraph('{"x":{"@r":9}}'), /missing save reference/);
  assert.throws(() => decodeGraph('{"@c":1,"x":{"@r":1}}'), /cyclic save state/);
  assert.throws(() => decodeGraph('{"__proto__":{}}'), /invalid save field/);
});

test('native save references target the same player object in a stock graph', () => {
  const graph = { map: { _interpreter: { _character: { '@r': '/player' } } }, player: { '@': 'Game_Player', _x: 2 } };
  const encoded = JSON.parse(encodeGraph(graph));
  assert.equal(encoded.map._interpreter._character['@r'], encoded.player['@c']);
  assert.deepEqual(decodeGraph(JSON.stringify(encoded)).map._interpreter._character, graph.player);
});

test('save codec decodes DAG shared @r references and keeps outer keys on @a wrappers', () => {
  const dag = decodeGraph('{"@c":1,"left":{"@c":2,"name":"shared"},"right":{"@r":2}}');
  assert.equal(dag.left, dag.right);
  assert.equal(dag.left.name, 'shared');
  const wrapped = decodeGraph('{"list":{"@a":[10,20],"meta":"kept"}}');
  assert.deepEqual([...wrapped.list], [10, 20]);
  assert.equal(wrapped.list.meta, 'kept');
});
