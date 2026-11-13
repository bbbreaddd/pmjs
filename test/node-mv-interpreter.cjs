'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const api = require(require('node:path').resolve(process.argv[2])).mvEngine;
const { fixture, command, variable } = require('./helpers/mv-session-fixture.cjs');

function session(t, data) {
  const handle = api.create(data);
  t.after(() => api.dispose(handle));
  api.newGame(handle);
  return handle;
}

function branch(condition, id) {
  return [command(111, condition), command(122, [id, id, 0, 0, 1], 1), command(411),
    command(122, [id, id, 0, 0, 0], 1), command(412)];
}

test('nested loops, breaks, comments and common-event exits preserve control flow', t => {
  const handle = session(t, fixture([
    command(108, ['comment']), command(408, ['continued']), variable(1, 0), variable(2, 0),
    command(112), command(122, [1, 1, 1, 0, 1], 1), command(112, [], 1),
    command(122, [2, 2, 1, 0, 1], 2), command(113, [], 2), command(413, [], 1),
    command(111, [1, 1, 0, 3, 1], 1), command(113, [], 2), command(412, [], 1), command(413),
    command(117, [1]), command(117, [99]), command(125, [0, 0, 17]),
  ]));
  api.step(handle, {});
  const result = api.snapshot(handle);
  assert.equal(result.variables[1], 3);
  assert.equal(result.variables[2], 3);
  assert.equal(result.variables[20], 1, 'exit ends the child without ending its caller');
  assert.equal(api.save(handle).party._gold, 17);
});

test('label jumps yield until the next update and missing labels continue normally', t => {
  const handle = session(t, fixture([variable(1, 0), command(119, ['target']), variable(1, 99),
    command(118, ['target']), variable(1, 7), command(119, ['missing']), variable(2, 3)]));
  api.step(handle, {});
  assert.equal(api.snapshot(handle).variables[1], 0);
  assert.equal(api.snapshot(handle).interpreter.index, 3);
  api.step(handle, {});
  assert.equal(api.snapshot(handle).variables[1], 7);
  assert.equal(api.snapshot(handle).variables[2], 3);
});

test('waits consume their first frame when the command executes', t => {
  const handle = session(t, fixture([variable(1, 1), command(230, [2]), variable(1, 2)]));
  api.step(handle, {});
  assert.equal(api.snapshot(handle).interpreter.wait, 1);
  api.step(handle, {});
  assert.equal(api.snapshot(handle).variables[1], 1);
  api.step(handle, {});
  assert.equal(api.snapshot(handle).variables[1], 2);
});

test('variable branches distinguish types and compare strings as UTF-16', t => {
  const handle = session(t, fixture([
    variable(1, '2'), variable(2, 2), variable(3, '10'), variable(4, '\u{10000}'), variable(5, '\ue000'),
    ...branch([1, 1, 1, 2, 0], 10), ...branch([1, 1, 1, 2, 5], 11),
    ...branch([1, 1, 1, 2, 1], 12), ...branch([1, 3, 1, 1, 4], 13),
    ...branch([1, 4, 1, 5, 4], 14), ...branch([1, 9, 0, 0, 0], 15),
    variable(6, false), variable(7, ''), ...branch([1, 6, 0, 0, 0], 16), ...branch([1, 7, 0, 0, 0], 17),
  ]));
  api.step(handle, {});
  const values = api.snapshot(handle).variables;
  assert.equal(values[10], 0);
  for (const id of [11, 12, 13, 14, 15, 16, 17]) assert.equal(values[id], 1, `branch ${id}`);
});

test('random operands draw independently for each destination, including fixed ranges', t => {
  const handle = session(t, fixture([command(122, [1, 3, 0, 2, -2, 2]), command(122, [4, 4, 0, 2, 7, 7])]));
  api.setRandomStream(handle, [0, 0.5, 0.999, 0.25]);
  api.step(handle, {});
  const result = api.snapshot(handle);
  assert.deepEqual([1, 2, 3, 4].map(id => result.variables[id]), [-2, 0, 2, 7]);
  assert.equal(result.randomCalls, 4);
});

test('game-data operands read inventory, actors, characters, party and system state', t => {
  const operands = [[0, 1, 0], [1, 1, 0], [2, 1, 0], [3, 1, 0], [3, 1, 2], [3, 1, 3],
    [3, 1, 6], [5, -1, 0], [5, 0, 0], [5, 0, 2], [6, 0, 0], [6, 99, 0],
    [7, 0, 0], [7, 1, 0], [7, 2, 0], [7, 3, 0], [7, 4, 0], [7, 7, 0], [3, 99, 2]];
  const handle = session(t, fixture([command(126, [1, 0, 0, 5]), command(127, [1, 0, 0, 2]),
    command(128, [1, 0, 0, 3]), command(125, [0, 0, 750]),
    ...operands.map((args, i) => command(122, [i + 1, i + 1, 0, 3, ...args])),
  ]));
  api.step(handle, {});
  const result = api.snapshot(handle).variables;
  assert.deepEqual(operands.map((_, i) => result[i + 1]), [5, 2, 3, 1, 10, 10, 10, 1, 3, 2, 1, 0, 1, 1, 750, 0, 0, 0, 0]);
});

test('inventory conditions include equipped items only when requested and losses discard equipment', t => {
  const handle = session(t, fixture([
    ...branch([9, 1, false], 1), ...branch([9, 1, true], 2), ...branch([10, 1, true], 3),
    ...branch([4, 1, 4, 1], 4), ...branch([4, 1, 5, 1], 5), ...branch([4, 2, 3, 2], 6),
    ...branch([4, 2, 0, 0], 7), command(126, [1, 0, 0, 200]), ...branch([8, 1], 8),
    command(127, [1, 1, 0, 1, true]), command(128, [1, 1, 0, 1, true]),
    ...branch([9, 1, true], 9), ...branch([10, 1, true], 10),
    command(125, [0, 0, 100000000]), ...branch([7, 99999999, 0], 11),
  ]));
  api.step(handle, {});
  const result = api.snapshot(handle);
  assert.deepEqual(Array.from({ length: 11 }, (_, i) => result.variables[i + 1]), [0, 1, 1, 1, 1, 1, 0, 1, 0, 0, 1]);
  const saved = api.save(handle);
  assert.equal(saved.party._items[1], 99);
  assert.equal(saved.actors._data[1]._equips[0]._itemId, 0);
  assert.equal(saved.actors._data[1]._equips[2]._itemId, 0);
  assert.equal(saved.party._weapons[1], undefined);
});

test('common events keep their caller self-switch and character context', t => {
  const data = fixture([command(123, ['B', 0]), command(117, [1])]);
  data.commonEvents[1].list = [...branch([2, 'B', 0], 1), ...branch([6, 0, 2], 2), command(0)];
  const handle = session(t, data);
  api.step(handle, {});
  assert.equal(api.snapshot(handle).variables[1], 1);
  assert.equal(api.snapshot(handle).variables[2], 1);
});

test('discarding equipped inventory does not add an actor refresh', t => {
  const data = fixture([command(127, [1, 1, 0, 1, true])]);
  data.weapons[1].params[0] = 20;
  const handle = session(t, data);
  assert.equal(api.snapshot(handle).actors[1].hp, 30);
  api.step(handle, {});
  assert.equal(api.snapshot(handle).actors[1].parameters[0], 10);
  assert.equal(api.snapshot(handle).actors[1].hp, 30);
});

test('parallel interpreters resolve their own character without a foreground event', t => {
  const data = fixture([command(122, [1, 1, 0, 3, 5, 0, 0]), ...branch([6, 0, 2], 2)]);
  data.maps[1].events[1].pages[0].trigger = 4;
  const handle = session(t, data);
  api.step(handle, {});
  assert.equal(api.snapshot(handle).variables[1], 3);
  assert.equal(api.snapshot(handle).variables[2], 1);
});

test('cleared branch state remains cleared across save/load and recursive common events fail safely', t => {
  const handle = session(t, fixture([]));
  const saved = api.save(handle);
  saved.map._interpreter = { _mapId: 1, _eventId: 0, _index: 0, _waitCount: 0, _branch: { 0: null },
    _list: [command(411), command(122, [1, 1, 0, 0, 99], 1), command(412), command(0)] };
  saved.map._events[1]._erased = true;
  api.load(handle, saved);
  api.step(handle, {});
  assert.equal(api.snapshot(handle).variables[1], undefined);
  const recursive = fixture([command(117, [1])]);
  recursive.commonEvents[1].list = [command(117, [1]), command(0)];
  const nested = session(t, recursive);
  assert.throws(() => api.step(nested, {}), /nesting limit/);
});

test('variable transfers resolve coordinates once and preserve the requested direction', t => {
  const data = fixture([variable(1, 2), variable(2, 4), variable(3, 3), command(201, [1, 1, 2, 3, 8, 2])]);
  data.maps[2] = { ...data.maps[1], events: [] };
  const handle = session(t, data);
  api.step(handle, {});
  assert.equal(api.snapshot(handle).mapId, 2);
  assert.equal(api.snapshot(handle).player.x, 4);
  assert.equal(api.snapshot(handle).player.y, 3);
  assert.equal(api.snapshot(handle).player.direction, 8);
});
