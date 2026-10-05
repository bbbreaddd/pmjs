'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { progressLines } = require('../runner/index.cjs');

test('warm cache validation is distinguished from new preparation with counts, time and rate', () => {
  const progress = { phase: 'validate', source: 'img/pictures/portrait.png',
    total: 100, completed: 20, elapsedMs: 10000, hits: 20, generated: 0, fallback: 5 };
  const lines = progressLines(progress);
  assert.equal(lines[0], 'Checking cached assets');
  assert.match(lines[1], /20 \/ 100 done \(20%\).*80 left/);
  assert.equal(lines[2], 'Current file: img/pictures/portrait.png');
  assert.equal(lines[3], 'Cache: 0 new, 20 reused  |  Originals: 5');
  assert.equal(lines[4], 'Elapsed: 0:10  |  Average: 2.0 files/s');
  assert.equal(lines[5], 'Estimated time left: 0:40');
  assert.equal(progressLines({ ...progress, phase: 'prepare' })[0], 'Preparing new assets');
});

test('long first files keep elapsed time truthful without inventing speed or an ETA', () => {
  const lines = progressLines({ phase: 'prepare', source: 'img/sv_actors/large.png',
    total: 50, completed: 0, elapsedMs: 70000 });
  assert.match(lines[1], /50 left/);
  assert.match(lines[4], /Elapsed: 1:10.*estimating/);
  assert.match(lines[5], /Large files can take longer/);
  assert.ok(!lines.some(line => line.includes('Estimated time left')));
});

test('discovery, locking and finishing do not claim another transform is running', () => {
  assert.equal(progressLines({ phase: 'discover' })[1], 'Counting files...');
  assert.match(progressLines({ phase: 'wait' })[5], /Another launch/);
  for (const phase of ['install', 'cleanup']) {
    const lines = progressLines({ phase, completed: 10, total: 10, elapsedMs: 1000 });
    assert.equal(lines[0], 'Finishing asset preparation');
    assert.match(lines[1], /0 left/);
    assert.match(lines[5], /finishing up/);
  }
});

test('empty completion and terminal failure/cancellation retain truthful final state', () => {
  assert.match(progressLines({ phase: 'complete', terminal: true })[1], /0 \/ 0.*0 left/);
  for (const phase of ['cancelled', 'error']) {
    const lines = progressLines({ phase, terminal: true, completed: 4, total: 10, elapsedMs: 2000 });
    assert.match(lines[1], /6 left/);
    assert.ok(!lines.some(line => line.includes('Estimated time left')));
    assert.notEqual(lines[0], 'Assets ready');
  }
});

test('file labels preserve Unicode and flatten line breaks into a single screen row', () => {
  assert.equal(progressLines({ phase: 'prepare', source: 'img/pictures/caf\u00e9\nface.png' })[2],
    'Current file: img/pictures/caf\u00e9 face.png');
});
