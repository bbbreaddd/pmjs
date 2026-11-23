'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { GameFileLayer } = require('../runner/game-preparation.cjs');

test('unchanged game layers avoid staging payloads and changed layers retain reused members', t => {
  const root = temporaryDirectory('game-layer-reuse-');
  const write = fs.writeFileSync;
  let payloadWrites = 0;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (path.basename(file) === 'one') payloadWrites++;
    return write(file, ...args);
  });
  const publish = (second, added) => {
    const layer = new GameFileLayer(root, 'fixture');
    try {
      layer.write('data/one', Buffer.alloc(1024 * 1024, 7));
      layer.write('data/two', second);
      if (added) layer.write('data/three', added);
      return { ...layer.finish(), staged: fs.existsSync(path.join(layer.staging, 'data/one')) };
    } finally { layer.dispose(); }
  };
  const cold = publish('two');
  assert.equal(payloadWrites, 1);
  const warm = publish('two');
  assert.equal(payloadWrites, 1, 'warm publication must not rewrite the large payload');
  assert.equal(warm.root, cold.root);
  assert.equal(warm.changed, false);
  assert.equal(warm.staged, false);
  const changed = publish('changed', 'added');
  assert.equal(changed.changed, true);
  assert.equal(fs.readFileSync(path.join(changed.root, 'data/one')).length, 1024 * 1024);
  assert.equal(fs.readFileSync(path.join(changed.root, 'data/two'), 'utf8'), 'changed');
  assert.equal(fs.readFileSync(path.join(changed.root, 'data/three'), 'utf8'), 'added');
  const reduced = new GameFileLayer(root, 'fixture');
  try {
    reduced.write('data/one', Buffer.alloc(1024 * 1024, 7));
    const result = reduced.finish();
    assert.deepEqual(fs.readdirSync(path.join(result.root, 'data')), ['one']);
  } finally { reduced.dispose(); }
  fs.writeFileSync(path.join(changed.root, 'data/one'), 'corrupt');
  assert.equal(publish('changed', 'added').changed, true);
});
