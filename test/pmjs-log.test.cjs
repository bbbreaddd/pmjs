'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname,
  '../js/pmjs-core/log.js'), 'utf8');

function makeSink(overrides) {
  const lines = [];
  const sandbox = {
    console: { error(line) { lines.push(String(line)); } },
    ...overrides
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'pmjs-log.js' });
  return { sandbox, lines };
}

function todoRecord(extra) {
  return {
    capability: 'render.filter', producer: 'Sprite', reason: 'Object',
    nodeClass: 'Sprite', frame: 12, scene: 'Scene_Map', map: 87,
    ...extra
  };
}

test('first occurrence logs full detail, repeats collapse with counts', () => {
  const { sandbox, lines } = makeSink();
  const record = todoRecord();
  sandbox.pmjsLogTodo(record);
  sandbox.pmjsLogTodo(record);
  sandbox.pmjsLogTodo(record);
  assert.equal(lines.length, 1);
  const logged = JSON.parse(lines[0].replace('[pmjs] unsupported render ', ''));
  assert.deepEqual(logged, record);

  sandbox.pmjsLogTodo(todoRecord({ reason: 'BlurFilter' }));
  assert.equal(lines.length, 3);
  assert.match(lines[1], /\[3x\]$/);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.pmjsSkipCensus())), { counts: {
    'render.filter|Object|Sprite': 3,
    'render.filter|BlurFilter|Sprite': 1
  } });
});

test('todo tier needs no verbosity flags and never throws', () => {
  const { sandbox, lines } = makeSink();

  sandbox.pmjsLogTodo(todoRecord());
  assert.equal(lines.length, 1);

  sandbox.pmjsLogCallback = () => { throw new Error('collector down'); };
  sandbox.pmjsLogTodo(todoRecord({ reason: 'Other' }));
  sandbox.console = undefined;
  sandbox.pmjsLogTodo(todoRecord({ reason: 'Third' }));
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.pmjsSkipCensus())), { counts: {
    'render.filter|Object|Sprite': 1,
    'render.filter|Other|Sprite': 1,
    'render.filter|Third|Sprite': 1
  } });
});

test('collector receives first occurrences, census flushes trailing repeats', () => {
  const collected = [];
  const { sandbox, lines } = makeSink({
    pmjsLogCallback: undefined
  });
  sandbox.pmjsLogCallback = record => { collected.push(record); };
  const record = todoRecord();
  sandbox.pmjsLogTodo(record);
  sandbox.pmjsLogTodo(record);
  assert.deepEqual(collected, [record]);
  assert.equal(lines.length, 1);

  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.pmjsSkipCensus())), { counts: {
    'render.filter|Object|Sprite': 2
  } });
  assert.equal(lines.length, 2);
  assert.match(lines[1], /\[2x\]$/);
});

